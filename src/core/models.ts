// Model/provider configuration. Ported from Sources/ModelConfiguration.swift
// (per-model payload knobs, think-tag stripping, known model lists) and the
// verbose_json gating in Sources/TranscriptionService.swift.

export interface ModelConfig {
  maxCompletionTokens: number | null;
  reasoningEffort: string | null;
  includeReasoning: boolean | null;
  shouldStripThinkTags: boolean;
}

// Default post-processing models used when the user hasn't picked one.
// ModelConfiguration.swift / PostProcessingService.swift.
export const DEFAULT_POST_PROCESSING_MODEL = "openai/gpt-oss-20b";
export const DEFAULT_POST_PROCESSING_FALLBACK_MODEL = "qwen/qwen3.6-27b";

// ModelConfiguration.llmModels
export const LLM_MODELS = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-safeguard-20b",
  "qwen/qwen3.6-27b",
  "groq/compound",
  "groq/compound-mini",
];

// ModelConfiguration.visionModels
export const VISION_MODELS = ["qwen/qwen3.6-27b"];

// ModelConfiguration.transcriptionModels
export const TRANSCRIPTION_MODELS = ["whisper-large-v3", "whisper-large-v3-turbo"];

// TranscriptionService.modelsSupportingVerboseJSON — only these expose the
// segment metadata the hallucination filter depends on.
const MODELS_SUPPORTING_VERBOSE_JSON = new Set([
  "whisper-1",
  "whisper-large-v3",
  "whisper-large-v3-turbo",
]);

const GENERIC_CONFIG: ModelConfig = {
  maxCompletionTokens: null,
  reasoningEffort: null,
  includeReasoning: null,
  shouldStripThinkTags: false,
};

/** TranscriptionService.responseFormat(forModel:). */
export function transcriptionResponseFormat(model: string): string {
  const normalized = model.trim().toLowerCase();
  return MODELS_SUPPORTING_VERBOSE_JSON.has(normalized) ? "verbose_json" : "json";
}

/** ModelConfiguration.config(for:) — per-model request tuning. */
export function modelConfig(model: string): ModelConfig {
  let clean = model.trim().toLowerCase();

  // Normalize providerless aliases.
  const aliases: Record<string, string> = {
    "qwen3-32b": "qwen/qwen3-32b",
    "qwen3.6-27b": "qwen/qwen3.6-27b",
    "gpt-oss-20b": "openai/gpt-oss-20b",
    "gpt-oss-120b": "openai/gpt-oss-120b",
    "gpt-oss-safeguard-20b": "openai/gpt-oss-safeguard-20b",
  };
  if (clean in aliases) {
    clean = aliases[clean];
  }

  switch (clean) {
    case "openai/gpt-oss-20b":
      return {
        maxCompletionTokens: 4096,
        reasoningEffort: "low",
        includeReasoning: false,
        shouldStripThinkTags: false,
      };
    case "qwen/qwen3-32b":
      return { ...GENERIC_CONFIG, shouldStripThinkTags: true };
    case "qwen/qwen3.6-27b":
      return {
        maxCompletionTokens: null,
        reasoningEffort: "none",
        includeReasoning: false,
        shouldStripThinkTags: true,
      };
    // Every other known model (gpt-oss-120b, llama-*, groq/compound, whisper-*, …)
    // uses the generic config in the Swift source.
    default:
      return { ...GENERIC_CONFIG };
  }
}

/**
 * ModelConfiguration.stripThinkTags — remove a leading <think>...</think> block
 * (or an unclosed, truncated one) and trim. Anchored at string start, same as
 * the Swift regexes.
 */
export function stripThinkTags(text: string): string {
  let cleaned = text;
  // Fully closed blocks, one or more in a row.
  cleaned = cleaned.replace(/^(?:\s*<think>[\s\S]*?<\/think>)+/, "");
  // An unclosed <think> that ran to the end (model truncated mid-thought).
  cleaned = cleaned.replace(/^\s*<think>[\s\S]*$/, "");
  return cleaned.trim();
}
