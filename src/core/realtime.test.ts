import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveWebSocketURL,
  RealtimeClosedBeforeFinalError,
  RealtimeInvalidBaseURLError,
  RealtimeNotConnectedError,
  RealtimeServerError,
  RealtimeTranscriptionService,
  type RealtimeConfiguration,
  type RealtimeSocket,
} from "./realtime.js";

// A controllable in-memory socket: the test pushes server events and inspects
// what the service sent. One instance per start().
class FakeSocket implements RealtimeSocket {
  readonly url: string;
  readonly apiKey: string;
  readonly sent: string[] = [];
  closed = false;

  private messageCb?: (data: string) => void;
  private closeCb?: () => void;
  private errorCb?: (err: unknown) => void;

  constructor(url: string, apiKey: string) {
    this.url = url;
    this.apiKey = apiKey;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  onError(cb: (err: unknown) => void): void {
    this.errorCb = cb;
  }

  // --- test drivers ---
  emit(event: Record<string, unknown>): void {
    this.messageCb?.(JSON.stringify(event));
  }

  emitRaw(data: string): void {
    this.messageCb?.(data);
  }

  triggerClose(): void {
    this.closeCb?.();
  }

  triggerError(err: unknown): void {
    this.errorCb?.(err);
  }

  sentEvents(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  firstOfType(type: string): Record<string, unknown> | undefined {
    return this.sentEvents().find((e) => e["type"] === type);
  }
}

function makeService(
  overrides: Partial<RealtimeConfiguration> = {},
): { service: RealtimeTranscriptionService; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const config: RealtimeConfiguration = {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    model: "gpt-4o-transcribe",
    ...overrides,
  };
  const service = new RealtimeTranscriptionService(config, (url, apiKey) => {
    const socket = new FakeSocket(url, apiKey);
    sockets.push(socket);
    return socket;
  });
  return { service, sockets };
}

// --- URL derivation ----------------------------------------------------------

test("deriveWebSocketURL maps http to ws and inserts /v1/realtime", () => {
  assert.equal(
    deriveWebSocketURL("http://localhost:8080", "m"),
    "ws://localhost:8080/v1/realtime?intent=transcription",
  );
});

test("deriveWebSocketURL maps https to wss and inserts /v1/realtime", () => {
  assert.equal(
    deriveWebSocketURL("https://api.openai.com", "m"),
    "wss://api.openai.com/v1/realtime?intent=transcription",
  );
});

test("deriveWebSocketURL reuses a trailing /v1 (with or without a slash)", () => {
  assert.equal(
    deriveWebSocketURL("https://api.openai.com/v1", "m"),
    "wss://api.openai.com/v1/realtime?intent=transcription",
  );
  assert.equal(
    deriveWebSocketURL("https://api.openai.com/v1/", "m"),
    "wss://api.openai.com/v1/realtime?intent=transcription",
  );
});

test("deriveWebSocketURL passes ws/wss through and preserves an existing intent", () => {
  assert.equal(
    deriveWebSocketURL("wss://host/v1?intent=custom", "m"),
    "wss://host/v1/realtime?intent=custom",
  );
});

test("deriveWebSocketURL throws RealtimeInvalidBaseURLError on an underivable URL", () => {
  assert.throws(() => deriveWebSocketURL("not a url", "m"), RealtimeInvalidBaseURLError);
  assert.throws(() => deriveWebSocketURL("ftp://host/v1", "m"), RealtimeInvalidBaseURLError);
});

// --- lifecycle / happy path --------------------------------------------------

test("start sends session.update with model, language, and 24kHz pcm format", () => {
  const { service, sockets } = makeService({ language: "en" });
  service.start();

  assert.equal(sockets.length, 1);
  const update = sockets[0]!.firstOfType("session.update");
  assert.ok(update, "a session.update frame should be sent");
  const session = update["session"] as Record<string, unknown>;
  const input = (session["audio"] as Record<string, unknown>)["input"] as Record<string, unknown>;
  const transcription = input["transcription"] as Record<string, unknown>;
  assert.equal(transcription["model"], "gpt-4o-transcribe");
  assert.equal(transcription["language"], "en");
  const format = input["format"] as Record<string, unknown>;
  assert.equal(format["type"], "audio/pcm");
  assert.equal(format["rate"], 24_000);
  assert.equal(input["turn_detection"], null);
});

test("appendPcm16 sends a base64-encoded input_audio_buffer.append frame", () => {
  const { service, sockets } = makeService();
  service.start();
  service.appendPcm16(new Uint8Array([1, 2, 3]));

  const append = sockets[0]!.firstOfType("input_audio_buffer.append");
  assert.ok(append);
  assert.equal(append["audio"], Buffer.from([1, 2, 3]).toString("base64")); // "AQID"
});

test("appendPcm16 no-ops before start and for empty chunks", () => {
  const { service, sockets } = makeService();
  service.appendPcm16(new Uint8Array([9])); // not started yet
  assert.equal(sockets.length, 0);

  service.start();
  service.appendPcm16(new Uint8Array([])); // empty
  assert.equal(sockets[0]!.firstOfType("input_audio_buffer.append"), undefined);
});

test("happy path: deltas stream, segments accumulate, commit resolves the final transcript", async () => {
  const { service, sockets } = makeService();
  const partials: string[] = [];
  service.onPartialUpdate = (text) => partials.push(text);

  service.start();
  const socket = sockets[0]!;

  // First utterance streams as deltas, then completes (pre-commit).
  socket.emit({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "i1",
    delta: "Hello",
  });
  socket.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "i1",
    transcript: "Hello",
  });

  // Commit end-of-input; the commit frame goes out and we await the final text.
  const finalPromise = service.commitAndAwaitFinal();
  assert.ok(socket.firstOfType("input_audio_buffer.commit"), "commit frame should be sent");

  // A second utterance arrives after the commit and finalizes the transcript.
  socket.emit({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "i2",
    delta: "world",
  });
  socket.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "i2",
    transcript: "world",
  });

  const finalText = await finalPromise;
  assert.equal(finalText, "Hello world");

  // The live readout saw the accumulated text along the way.
  assert.ok(partials.includes("Hello"));
  assert.equal(partials[partials.length - 1], "Hello world");
  // Resolving the final transcript closes the socket.
  assert.equal(socket.closed, true);
});

test("an empty post-commit completed event finalizes using the pre-commit segment", async () => {
  const { service, sockets } = makeService();
  service.start();
  const socket = sockets[0]!;

  // The segment lands before the commit, so finalText is already "done".
  socket.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "i1",
    transcript: "done",
  });

  // Readiness still requires a completion *after* the commit; an empty one
  // (no transcript change) is enough to mark postCommitCompleted and resolve.
  const promise = service.commitAndAwaitFinal();
  socket.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "i2",
    transcript: "",
  });

  assert.equal(await promise, "done");
});

// --- error paths -------------------------------------------------------------

test("a server error event rejects with RealtimeServerError carrying code + message", async () => {
  const { service, sockets } = makeService();
  service.start();
  const socket = sockets[0]!;

  const promise = service.commitAndAwaitFinal();
  socket.emit({ type: "error", error: { code: "invalid_request", message: "boom" } });

  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof RealtimeServerError);
    assert.equal(err.code, "invalid_request");
    assert.equal(err.serverMessage, "boom");
    return true;
  });
});

test("close before a final transcript rejects with RealtimeClosedBeforeFinalError", async () => {
  const { service, sockets } = makeService();
  service.start();
  const socket = sockets[0]!;

  const promise = service.commitAndAwaitFinal();
  socket.triggerClose();

  await assert.rejects(promise, RealtimeClosedBeforeFinalError);
});

test("a socket error before the final transcript also rejects with closedBeforeFinal", async () => {
  const { service, sockets } = makeService();
  service.start();
  const socket = sockets[0]!;

  const promise = service.commitAndAwaitFinal();
  socket.triggerError(new Error("socket blew up"));

  await assert.rejects(promise, RealtimeClosedBeforeFinalError);
});

test("commitAndAwaitFinal rejects with notConnected when start was never called", async () => {
  const { service } = makeService();
  await assert.rejects(service.commitAndAwaitFinal(), RealtimeNotConnectedError);
});

test("cancel rejects an in-flight commit and closes the socket", async () => {
  const { service, sockets } = makeService();
  service.start();
  const socket = sockets[0]!;

  const promise = service.commitAndAwaitFinal();
  service.cancel();

  await assert.rejects(promise);
  assert.equal(socket.closed, true);
});
