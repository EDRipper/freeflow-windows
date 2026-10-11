// Single entry point for the main process: transcribe -> cleanup, timed.
// Composes transcription.ts and postprocess.ts; there is no direct Swift
// equivalent since AppState.swift drove this inline across several methods.

import type { AppConfig, AppContext, PipelineResult } from "../shared/types.js";
import {
  buildCommandSystemPrompt,
  buildCommandUserMessage,
  buildSystemPrompt,
  buildUserMessage,
  cleanup,
  commandTransform,
  contextSummary,
} from "./postprocess.js";
import { transcribe } from "./transcription.js";

// A human-readable preview of what was sent to the cleanup model, for the debug
// view. Rebuilt from the same exported helpers the request uses, so it mirrors
// the real prompt without threading it back through the network layer.
function cleanupPromptPreview(
  rawTranscript: string,
  config: AppConfig,
  context?: AppContext,
): string {
  const system = buildSystemPrompt(config.customSystemPrompt, config.vocabulary);
  const user = buildUserMessage(rawTranscript, contextSummary(context));
  return `[system]\n${system}\n\n[user]\n${user}`;
}

function commandPromptPreview(
  selectedText: string,
  voiceCommand: string,
  config: AppConfig,
  context?: AppContext,
): string {
  const system = buildCommandSystemPrompt(config.vocabulary);
  const user = buildCommandUserMessage(selectedText, voiceCommand, contextSummary(context));
  return `[system]\n${system}\n\n[user]\n${user}`;
}

/**
 * Run the full dictation pipeline on a recorded audio buffer and return the raw
 * transcript, the cleaned text, and the wall-clock duration in milliseconds.
 */
export async function runPipeline(
  audio: ArrayBuffer,
  mimeType: string,
  apiKey: string,
  config: AppConfig,
  context?: AppContext,
): Promise<PipelineResult> {
  const start = Date.now();

  const rawTranscript = await transcribe(
    { audio, mimeType, apiKey },
    config.provider,
    config.timeouts,
  );
  const transcribeMs = Date.now() - start;

  // Nothing (or only a hallucination that was filtered to "") came back — skip
  // the doomed cleanup round-trip, same net result as the EMPTY sentinel.
  if (!rawTranscript.trim()) {
    return { rawTranscript, cleanedText: "", durationMs: transcribeMs, transcribeMs, cleanupMs: 0 };
  }

  const cleanupStart = Date.now();
  const cleanedText = await cleanup(rawTranscript, {
    provider: config.provider,
    timeouts: config.timeouts,
    apiKey,
    vocabulary: config.vocabulary,
    customSystemPrompt: config.customSystemPrompt,
    context,
  });
  const cleanupMs = Date.now() - cleanupStart;

  return {
    rawTranscript,
    cleanedText,
    durationMs: Date.now() - start,
    transcribeMs,
    cleanupMs,
    prompt: cleanupPromptPreview(rawTranscript, config, context),
  };
}

/**
 * Edit Mode: transcribe the spoken instruction, then transform `selectedText`
 * by it instead of cleaning the transcript. The transcript becomes the voice
 * command; `cleanedText` holds the replacement to paste over the selection.
 */
export async function runEditMode(
  audio: ArrayBuffer,
  mimeType: string,
  apiKey: string,
  config: AppConfig,
  selectedText: string,
  context?: AppContext,
): Promise<PipelineResult> {
  const start = Date.now();

  const voiceCommand = await transcribe(
    { audio, mimeType, apiKey },
    config.provider,
    config.timeouts,
  );
  const transcribeMs = Date.now() - start;

  if (!voiceCommand.trim()) {
    return {
      rawTranscript: voiceCommand,
      cleanedText: selectedText,
      durationMs: transcribeMs,
      transcribeMs,
      cleanupMs: 0,
    };
  }

  const cleanupStart = Date.now();
  const cleanedText = await commandTransform(selectedText, voiceCommand, {
    provider: config.provider,
    timeouts: config.timeouts,
    apiKey,
    vocabulary: config.vocabulary,
    context,
  });
  const cleanupMs = Date.now() - cleanupStart;

  return {
    rawTranscript: voiceCommand,
    cleanedText,
    durationMs: Date.now() - start,
    transcribeMs,
    cleanupMs,
    prompt: commandPromptPreview(selectedText, voiceCommand, config, context),
  };
}
