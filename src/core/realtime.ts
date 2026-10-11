// Realtime (streaming) transcription core, ported from
// Sources/RealtimeTranscriptionService.swift.
//
// Speaks the OpenAI-realtime-style transcription protocol over a WebSocket:
// derive a wss URL from the base URL, send a session.update, stream audio as
// input_audio_buffer.append (base64 PCM16) frames, surface partial transcripts
// from delta/completed server events, then commit and await the final text.
//
// The WebSocket is injected as a transport interface so the protocol state
// machine is fully unit-testable with a mock socket — this module never imports
// electron or `ws`. The real app supplies a factory backed by the global
// WebSocket. Base64 is done with node's Buffer since this is main-process core.

/** Minimal transport the service drives. The caller supplies a real socket. */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
}

/** Builds a connected socket for a derived URL + API key. */
export type SocketFactory = (url: string, apiKey: string) => RealtimeSocket;

export interface RealtimeConfiguration {
  baseUrl: string;
  apiKey: string;
  model: string;
  language?: string;
}

// --- typed errors, mirroring RealtimeTranscriptionError ----------------------

/** The configured base URL could not be turned into a WebSocket URL. */
export class RealtimeInvalidBaseURLError extends Error {
  readonly baseUrl: string;
  constructor(baseUrl: string) {
    super(`Cannot derive a WebSocket URL from ${baseUrl}`);
    this.name = "RealtimeInvalidBaseURLError";
    this.baseUrl = baseUrl;
  }
}

/** A producer/commit call was made before the socket existed. */
export class RealtimeNotConnectedError extends Error {
  constructor() {
    super("Realtime transcription socket is not connected");
    this.name = "RealtimeNotConnectedError";
  }
}

/** The server emitted an `error` event. Carries its code + message. */
export class RealtimeServerError extends Error {
  readonly code: string;
  readonly serverMessage: string;
  constructor(code: string, message: string) {
    super(`Realtime server error [${code}]: ${message}`);
    this.name = "RealtimeServerError";
    this.code = code;
    this.serverMessage = message;
  }
}

/** The socket closed before a final transcript was available. */
export class RealtimeClosedBeforeFinalError extends Error {
  constructor() {
    super("Realtime socket closed before emitting the final transcript");
    this.name = "RealtimeClosedBeforeFinalError";
  }
}

/** cancel() was called while a commit was in flight. */
export class RealtimeCancellationError extends Error {
  constructor() {
    super("Realtime transcription was cancelled");
    this.name = "RealtimeCancellationError";
  }
}

// --- URL derivation ----------------------------------------------------------

/**
 * Turn `https://host[/prefix]` or `http://host[/prefix]` into
 * `wss://host[/prefix]/realtime`, reusing a trailing `/v1` prefix when the base
 * URL already includes it (otherwise inserting `/v1`). Adds an
 * `intent=transcription` query item if absent. `http`->`ws`, `https`->`wss`,
 * and `ws`/`wss` are passed through; anything else is underivable.
 *
 * `model`/`language` mirror the Swift signature for API parity; the derivation
 * itself does not depend on them (they ride in session.update instead).
 */
export function deriveWebSocketURL(
  baseUrl: string,
  _model: string,
  _language?: string,
): string {
  const trimmed = baseUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new RealtimeInvalidBaseURLError(baseUrl);
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  let wsScheme: string;
  switch (scheme) {
    case "http":
      wsScheme = "ws";
      break;
    case "https":
      wsScheme = "wss";
      break;
    case "ws":
    case "wss":
      wsScheme = scheme;
      break;
    default:
      throw new RealtimeInvalidBaseURLError(baseUrl);
  }

  // WHATWG URL always reports at least "/" for a special scheme, so stripping a
  // trailing slash reproduces the Swift URLComponents behaviour (empty path).
  let path = url.pathname;
  if (path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  path += path.endsWith("/v1") ? "/realtime" : "/v1/realtime";

  const params = url.searchParams;
  if (!params.has("intent")) {
    params.set("intent", "transcription");
  }
  const query = params.toString();

  return `${wsScheme}://${url.host}${path}${query ? `?${query}` : ""}`;
}

// --- service -----------------------------------------------------------------

type Pending = {
  resolve: (text: string) => void;
  reject: (reason: unknown) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!obj) {
    return undefined;
  }
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

export class RealtimeTranscriptionService {
  private readonly config: RealtimeConfiguration;
  private readonly factory: SocketFactory;

  private socket: RealtimeSocket | null = null;

  // Transcript state. `finalText` accumulates committed segments (space-joined);
  // `partialText` holds the currently-streaming delta run for the live readout.
  private finalText = "";
  private partialText = "";

  // Commit/finalization bookkeeping. `commitEventCount` snapshots the server
  // event count at commit time so we can tell a post-commit `completed` apart
  // from the stream of in-utterance completions that preceded it.
  private commitSent = false;
  private closed = false;
  private terminalError: Error | null = null;
  private serverEventCount = 0;
  private commitEventCount: number | null = null;
  private postCommitCompleted = false;

  private pending: Pending | null = null;

  /**
   * Fires as partial transcript updates arrive — the concatenation of all
   * committed segments plus the currently-streaming delta. Useful for a live
   * overlay readout.
   */
  onPartialUpdate?: (text: string) => void;

  constructor(config: RealtimeConfiguration, factory: SocketFactory) {
    this.config = config;
    this.factory = factory;
  }

  // MARK: Lifecycle

  /** Open the socket and send the initial session.update. Throws on a bad URL. */
  start(): void {
    const url = deriveWebSocketURL(this.config.baseUrl, this.config.model, this.config.language);
    const socket = this.factory(url, this.config.apiKey);
    this.socket = socket;
    socket.onMessage((data) => this.handleServerEvent(data));
    socket.onClose(() => this.finishWithClose());
    socket.onError(() => this.finishWithClose());
    this.sendSessionUpdate();
  }

  /** Cancel the socket and reject any in-flight commit. Safe to call twice. */
  cancel(): void {
    const socket = this.socket;
    this.socket = null;
    if (!this.closed) {
      this.closed = true;
      const pending = this.pending;
      if (pending) {
        this.pending = null;
        pending.reject(new RealtimeCancellationError());
      }
    }
    socket?.close();
  }

  // MARK: Producer

  /**
   * Append 16-bit little-endian PCM samples. The caller owns rate matching (the
   * service declares 24 kHz mono in session.update, matching the OpenAI Realtime
   * default). No-ops before start() or for an empty chunk.
   */
  appendPcm16(bytes: Uint8Array): void {
    if (!this.socket || bytes.length === 0) {
      return;
    }
    const audioB64 = Buffer.from(bytes).toString("base64");
    this.send({ type: "input_audio_buffer.append", audio: audioB64 });
  }

  /** Signal end-of-input, wait for the final transcript, return it. */
  commitAndAwaitFinal(): Promise<string> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new RealtimeNotConnectedError());
    }
    if (!this.commitSent) {
      this.commitSent = true;
      this.commitEventCount = this.serverEventCount;
      this.postCommitCompleted = false;
      this.send({ type: "input_audio_buffer.commit" });
    }

    return new Promise<string>((resolve, reject) => {
      // A terminal condition may already have landed before we got here.
      if (this.terminalError) {
        socket.close();
        reject(this.terminalError);
        return;
      }
      if (this.closed) {
        socket.close();
        reject(new RealtimeClosedBeforeFinalError());
        return;
      }
      const ready = this.readyCommittedTranscript();
      if (ready !== null) {
        this.closed = true;
        socket.close();
        resolve(ready);
        return;
      }
      this.pending = { resolve, reject };
    });
  }

  // MARK: Receive handling

  private handleServerEvent(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }
    const eventType = readString(parsed, "type");
    if (eventType === undefined) {
      return;
    }

    this.serverEventCount += 1;

    switch (eventType) {
      case "conversation.item.input_audio_transcription.delta": {
        const delta = readString(parsed, "delta");
        if (delta) {
          this.appendDelta(delta);
        }
        this.resumeIfReadyAfterCommit();
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        if (this.commitEventCount !== null && this.serverEventCount > this.commitEventCount) {
          this.postCommitCompleted = true;
        }
        const transcript = readString(parsed, "transcript");
        if (transcript !== undefined) {
          this.commitSegment(transcript);
        } else {
          this.resumeIfReadyAfterCommit();
        }
        break;
      }
      case "input_audio_buffer.committed": {
        // The server acknowledged the commit; re-check readiness in case the
        // completion already arrived. (The server-assigned item_id is ignored.)
        this.resumeIfReadyAfterCommit();
        break;
      }
      case "error": {
        const errValue = parsed["error"];
        const errObj = isRecord(errValue) ? errValue : undefined;
        const code = readString(errObj, "code") ?? "unknown";
        const message = readString(errObj, "message") ?? "unknown realtime error";
        const error = new RealtimeServerError(code, message);
        this.terminalError = error;
        this.closed = true;
        const pending = this.pending;
        if (pending) {
          this.pending = null;
          pending.reject(error);
        }
        break;
      }
      // session.updated and any other event we do not special-case still get a
      // readiness re-check in case they were the thing we were waiting on.
      default:
        this.resumeIfReadyAfterCommit();
        break;
    }
  }

  private appendDelta(delta: string): void {
    this.partialText += delta;
    this.reportPartial(this.finalText + this.partialText);
  }

  private commitSegment(transcript: string): void {
    const trimmed = transcript.trim();
    if (trimmed) {
      if (this.finalText) {
        this.finalText += " ";
      }
      this.finalText += trimmed;
    }
    this.partialText = "";
    this.reportPartial(this.finalText);
    this.resumeIfReadyAfterCommit();
  }

  private reportPartial(text: string): void {
    this.onPartialUpdate?.(text);
  }

  // Called when the socket closes (or errors). Resolve with the final text if a
  // post-commit completion already landed, otherwise reject.
  private finishWithClose(): void {
    this.closed = true;
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = null;
    if (this.postCommitCompleted) {
      pending.resolve(this.finalText);
    } else {
      pending.reject(new RealtimeClosedBeforeFinalError());
    }
  }

  private resumeIfReadyAfterCommit(): void {
    if (!this.pending) {
      return;
    }
    const text = this.readyCommittedTranscript();
    if (text === null) {
      return;
    }
    const pending = this.pending;
    this.pending = null;
    this.closed = true;
    this.socket?.close();
    pending.resolve(text);
  }

  // The final transcript is only "ready" once we've committed, the live delta
  // run has drained, and a completion arrived after the commit.
  private readyCommittedTranscript(): string | null {
    if (this.commitSent && this.partialText === "" && this.postCommitCompleted) {
      return this.finalText;
    }
    return null;
  }

  // MARK: Send helpers

  private send(payload: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(payload));
  }

  private sendSessionUpdate(): void {
    const transcription: Record<string, unknown> = {};
    const model = this.config.model.trim();
    if (model) {
      transcription["model"] = model;
    }
    if (this.config.language) {
      transcription["language"] = this.config.language;
    }
    const session = {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          transcription,
          turn_detection: null,
        },
      },
    };
    this.send({ type: "session.update", session });
  }
}
