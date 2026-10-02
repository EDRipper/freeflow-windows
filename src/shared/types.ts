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
    postProcessingModel: "llama-3.3-70b-versatile",
  },
  timeouts: {
    transcriptionSeconds: 20,
    postProcessingSeconds: 20,
    contextRequestSeconds: 20,
  },
  holdShortcut: { keys: ["RIGHT ALT"], mode: "hold" },
  toggleShortcut: { keys: ["LEFT CTRL", "RIGHT ALT"], mode: "toggle" },
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
}

export type RecordingState = "idle" | "recording" | "transcribing" | "error";
