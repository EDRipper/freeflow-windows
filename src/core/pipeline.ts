// Single entry point for the main process: transcribe -> cleanup, timed.
// Composes transcription.ts and postprocess.ts; there is no direct Swift
// equivalent since AppState.swift drove this inline across several methods.

import type { AppConfig, AppContext, PipelineResult } from "../shared/types.js";
import { cleanup, commandTransform } from "./postprocess.js";
import { transcribe } from "./transcription.js";

/**
 * Run the full dictation pipeline on a recorded audio buffer and return the raw
 * transcript, the cleaned text, and the wall-clock duration in milliseconds.
 */
export async function runPipeline(
  audio: ArrayBuffer,
  mimeType: string,
  apiKey: string,
  config: AppConfig,
): Promise<PipelineResult> {
  const start = Date.now();

  const rawTranscript = await transcribe(
    { audio, mimeType, apiKey },
    config.provider,
    config.timeouts,
  );

  // Nothing (or only a hallucination that was filtered to "") came back — skip
  // the doomed cleanup round-trip, same net result as the EMPTY sentinel.
  if (!rawTranscript.trim()) {
    return { rawTranscript, cleanedText: "", durationMs: Date.now() - start };
  }

  const cleanedText = await cleanup(rawTranscript, {
    provider: config.provider,
    timeouts: config.timeouts,
    apiKey,
    vocabulary: config.vocabulary,
    customSystemPrompt: config.customSystemPrompt,
  });

  return { rawTranscript, cleanedText, durationMs: Date.now() - start };
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

  if (!voiceCommand.trim()) {
    return { rawTranscript: voiceCommand, cleanedText: selectedText, durationMs: Date.now() - start };
  }

  const cleanedText = await commandTransform(selectedText, voiceCommand, {
    provider: config.provider,
    timeouts: config.timeouts,
    apiKey,
    vocabulary: config.vocabulary,
    context,
  });

  return { rawTranscript: voiceCommand, cleanedText, durationMs: Date.now() - start };
}
