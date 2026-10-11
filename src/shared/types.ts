// Shared types used across main, preload, renderer, and core.
// Ported from FreeFlow's ModelConfiguration.swift and AppState.swift settings.

export interface ProviderConfig {
  /** OpenAI-compatible base URL, e.g. https://api.groq.com/openai/v1 */
  baseUrl: string;
  /** Transcription (speech-to-text) model id, e.g. whisper-large-v3 */
  transcriptionModel: string;
  /** Post-processing (cleanup) chat model id, e.g. llama-3.3-70b-versatile */
  postProcessingModel: string;
  /** Optional separate base URL for transcription if it differs from the LLM endpoint. */
  transcriptionBaseUrl?: string;
  /**
   * ISO-639-1 language code (e.g. "en") pinned for transcription. Pinning the
   * language stops Whisper from drifting into other languages and emitting
   * foreign stock-phrase hallucinations on silence. Empty/undefined = auto-detect.
   */
  transcriptionLanguage?: string;
}

export interface Timeouts {
  transcriptionSeconds: number;
  postProcessingSeconds: number;
  contextRequestSeconds: number;
}

export type ShortcutMode = "hold" | "toggle";

export interface ShortcutBinding {
  /** Key identifier strings, e.g. ["LEFT CTRL", "SPACE"]. Written by the settings UI and mapped from uiohook-napi keycodes in src/main/keynames.ts. */
  keys: string[];
  mode: ShortcutMode;
}

export interface AppConfig {
  provider: ProviderConfig;
  timeouts: Timeouts;
  holdShortcut: ShortcutBinding;
  toggleShortcut: ShortcutBinding;
  /** Extra words/names/jargon to preserve during cleanup. */
  vocabulary: string[];
  /** Custom system prompt override for post-processing. Empty = use default. */
  customSystemPrompt: string;
  editModeEnabled: boolean;
  launchAtLogin: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  provider: {
    baseUrl: "https://api.groq.com/openai/v1",
    transcriptionModel: "whisper-large-v3",
    postProcessingModel: "openai/gpt-oss-20b",
    transcriptionLanguage: "en",
  },
  timeouts: {
    transcriptionSeconds: 20,
    postProcessingSeconds: 20,
    contextRequestSeconds: 20,
  },
  holdShortcut: { keys: ["RIGHT SHIFT"], mode: "hold" },
  toggleShortcut: { keys: ["LEFT CTRL", "RIGHT SHIFT"], mode: "toggle" },
  vocabulary: [],
  customSystemPrompt: "",
  editModeEnabled: false,
  launchAtLogin: false,
};

/** Nearby-app context captured to improve cleanup spelling. */
export interface AppContext {
  appName?: string;
  windowTitle?: string;
  selectedText?: string;
}

export interface TranscriptionRequest {
  audio: ArrayBuffer;
  mimeType: string; // e.g. "audio/webm"
  apiKey: string;
}

export interface PipelineResult {
  rawTranscript: string;
  cleanedText: string;
  durationMs: number;
  /** Debug detail: the exact prompt sent to the cleanup/command model. */
  prompt?: string;
  /** Debug detail: time spent in transcription vs cleanup, in milliseconds. */
  transcribeMs?: number;
  cleanupMs?: number;
}

export type RecordingState = "idle" | "recording" | "transcribing" | "error";

/**
 * One persisted dictation, kept in userData/history.json. Ported from the macOS
 * app's PipelineHistoryItem, trimmed to the fields the Windows UI surfaces.
 * `timestamp` is epoch milliseconds so it serializes cleanly and the renderer can
 * format it relative to now. `editMode` marks entries produced by Edit Mode (a
 * spoken command transforming a selection) rather than plain dictation.
 */
export interface HistoryEntry {
  id: string;
  timestamp: number;
  rawTranscript: string;
  cleanedText: string;
  model: string;
  durationMs: number;
  editMode: boolean;
  /** Debug detail (optional for older entries): prompt sent and per-stage timings. */
  prompt?: string;
  transcribeMs?: number;
  cleanupMs?: number;
}
