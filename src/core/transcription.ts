// Speech-to-text via the OpenAI-compatible /audio/transcriptions endpoint.
// Ported from Sources/TranscriptionService.swift (multipart upload, response
// format gating) and Sources/TranscriptTextCore.swift (hallucination filter).

import type { ProviderConfig, Timeouts, TranscriptionRequest } from "../shared/types.js";
import { transcriptionResponseFormat } from "./models.js";
import { fetchWithTimeout, friendlyHTTPMessage, hostOf, HttpError, normalizeBaseUrl } from "./transport.js";

// Whisper emits these stock phrases for silence/background noise. Only suppress
// them when the segment metadata independently reports a high no-speech
// probability, so genuine short dictations survive. TranscriptTextCore.swift.
const HALLUCINATION_PHRASES = new Set([
  "thank you",
  "thank you for watching",
  "thank you very much",
  "thank you so much",
  "thanks for watching",
  "please subscribe",
  "like and subscribe",
  "subtitles by",
  "subtitles by the amara.org community",
  "you",
]);

const HALLUCINATION_NO_SPEECH_THRESHOLD = 0.1;

/**
 * POST the recorded audio to {baseUrl}/audio/transcriptions and return the raw
 * transcript text. Mirrors TranscriptionService.transcribeAudioWithURLSession:
 * multipart body with model + response_format + file, Bearer auth, per-request
 * timeout, and the same non-200 → friendly-message mapping.
 */
export async function transcribe(
  req: TranscriptionRequest,
  provider: ProviderConfig,
  timeouts: Timeouts,
): Promise<string> {
  const rawModel = provider.transcriptionModel.trim();
  const model = rawModel || "whisper-large-v3";
  const base = normalizeBaseUrl(provider.transcriptionBaseUrl ?? provider.baseUrl);
  const url = `${base}/audio/transcriptions`;

  const form = new FormData();
  form.append("model", model);
  form.append("response_format", transcriptionResponseFormat(model));
  form.append("file", new Blob([req.audio], { type: req.mimeType }), fileNameFor(req.mimeType));

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${req.apiKey}` },
      body: form,
    },
    timeouts.transcriptionSeconds,
  );

  const bodyText = await response.text();
  if (response.status !== 200) {
    throw new HttpError(
      response.status,
      bodyText,
      friendlyHTTPMessage(response.status, hostOf(url)),
    );
  }

  return parseTranscript(bodyText);
}

/** Choose a filename extension so the provider infers the right content type. */
function fileNameFor(mimeType: string): string {
  const mt = mimeType.toLowerCase();
  if (mt.includes("wav")) return "audio.wav";
  if (mt.includes("mpeg") || mt.includes("mp3")) return "audio.mp3";
  if (mt.includes("ogg")) return "audio.ogg";
  if (mt.includes("webm")) return "audio.webm";
  if (mt.includes("mp4") || mt.includes("m4a")) return "audio.m4a";
  return "audio.webm";
}

/** TranscriptionResponseParser.parse — JSON {text,...} first, else plain text. */
export function parseTranscript(body: string): string {
  let object: unknown;
  try {
    object = JSON.parse(body);
  } catch {
    const text = body
      .split(/\r?\n/)
      .join(" ")
      .trim();
    if (!text) {
      throw new Error("Invalid response");
    }
    return text;
  }

  if (isRecord(object) && typeof object.text === "string") {
    if (isHallucination(object.text, object)) {
      return "";
    }
    return object.text;
  }

  // Parsed to JSON but without a usable text field — fall back to flattening.
  const text = body
    .split(/\r?\n/)
    .join(" ")
    .trim();
  if (!text) {
    throw new Error("Invalid response");
  }
  return text;
}

function isHallucination(text: string, json: Record<string, unknown>): boolean {
  const normalized = text
    .toLowerCase()
    // Trim surrounding punctuation/whitespace, matching the Swift CharacterSet trim.
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
  if (!HALLUCINATION_PHRASES.has(normalized)) {
    return false;
  }

  const segments = json.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    return false;
  }
  const first = segments[0];
  if (!isRecord(first) || typeof first.no_speech_prob !== "number") {
    return false;
  }
  return first.no_speech_prob >= HALLUCINATION_NO_SPEECH_THRESHOLD;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
