// fetch-based OpenAI-compatible HTTP transport.
// Ported from Sources/LLMAPITransport.swift (per-request timeout, fresh
// connection per call), Sources/LLMCooldownManager.swift (rate-limit circuit
// breaker + Groq header parsing), Sources/TranscriptionService.swift
// (friendlyHTTPMessage) and Sources/TranscriptionErrorPresentationCore.swift
// (network-error wording).

/** HTTP status failure with the provider's raw body attached. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly friendlyMessage: string;

  constructor(status: number, body: string, friendlyMessage: string) {
    super(friendlyMessage);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.friendlyMessage = friendlyMessage;
  }
}

/** A request that exceeded its per-request timeout. */
export class RequestTimeoutError extends Error {
  readonly seconds: number;

  constructor(seconds: number) {
    super(`Request timed out after ${Math.round(seconds)}s`);
    this.name = "RequestTimeoutError";
    this.seconds = seconds;
  }
}

/** A model was rate-limited (HTTP 429); carries when it should be retried. */
export class RateLimitedError extends Error {
  readonly model: string;
  readonly retryAfterSeconds: number;

  constructor(model: string, retryAfterSeconds: number) {
    super(`Model ${model} rate-limited — retry in ${Math.round(retryAfterSeconds)}s`);
    this.name = "RateLimitedError";
    this.model = model;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** TranscriptionService.normalizedBaseURL — trim, require http(s) + host, strip trailing slashes. */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error("Provider URL is empty.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Provider URL is malformed.");
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    throw new Error("Provider URL must use http or https.");
  }
  if (!url.host) {
    throw new Error("Provider URL must include a host.");
  }
  // Drop trailing slashes from the path so appending "/audio/transcriptions" is clean.
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the provider";
  }
}

/** TranscriptionService.friendlyHTTPMessage — one-line, user-readable status mapping. */
export function friendlyHTTPMessage(status: number, host: string): string {
  const provider = host || "the provider";
  switch (status) {
    case 401:
      return `Invalid API key for ${provider}. Open Settings to fix it.`;
    case 403:
      return `Key lacks permission for this endpoint at ${provider} (HTTP 403). Check the key's scopes.`;
    case 404:
      return `Endpoint not found at ${provider} (HTTP 404). Base URL is likely wrong for this provider.`;
    case 413:
      return `Audio file too large for ${provider} (HTTP 413). Try a shorter recording.`;
    case 400:
      return `Provider rejected the request (HTTP 400). Check your model name and Base URL in Settings.`;
    case 429:
      return `Rate limit reached at ${provider} (HTTP 429). Wait a moment and try again.`;
    default:
      if (status >= 500 && status < 600) {
        return `Provider error at ${provider} (HTTP ${status}). Try again in a moment.`;
      }
      return `Request failed at ${provider} (HTTP ${status}).`;
  }
}

/**
 * fetch with a per-request timeout via AbortController.
 * LLMAPITransport used an ephemeral session per call; the browser/Node fetch
 * pool plus `cache: "no-store"` is the closest portable equivalent. On timeout
 * we throw RequestTimeoutError rather than the opaque AbortError.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutSeconds: number,
): Promise<Response> {
  const controller = new AbortController();
  const ms = (timeoutSeconds > 0 && Number.isFinite(timeoutSeconds) ? timeoutSeconds : 60) * 1000;
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new RequestTimeoutError(timeoutSeconds);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** TranscriptionErrorPresentationCore.message — locale-independent network wording. */
export function networkErrorMessage(error: unknown, isOnline: boolean): string {
  if (error instanceof RequestTimeoutError) {
    return isOnline ? "Request timed out — try again" : "No internet — check connection";
  }
  if (error instanceof HttpError) {
    return error.friendlyMessage;
  }
  const lower = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return isOnline ? "Request timed out — try again" : "No internet — check connection";
  }
  if (
    lower.includes("offline") ||
    lower.includes("internet connection") ||
    lower.includes("not connected") ||
    lower.includes("network") ||
    lower.includes("failed to fetch") ||
    lower.includes("enotfound") ||
    lower.includes("econnrefused") ||
    lower.includes("cannot find host")
  ) {
    return "No internet — check connection";
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Rate-limit cooldown — LLMCooldownManager.swift
// ---------------------------------------------------------------------------

/**
 * Parse a Groq duration string into seconds. Accepts bare seconds ("2",
 * "7.66"), a single suffixed unit ("7.66s", "120ms"), and compound forms
 * ("2m59.56s", "1h0m0s"). Returns null for empty, unknown-unit, negative, or
 * non-finite input. Port of LLMCooldownManager.parseGroqDuration.
 */
export function parseGroqDuration(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  // A bare number is plain seconds. Reject NaN/Infinity/negative. Guard against
  // JS Number() accepting "" / "0x10" / whitespace by requiring a numeric shape.
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  let total = 0;
  let numberBuffer = "";
  let matchedAnyUnit = false;
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if ((ch >= "0" && ch <= "9") || ch === ".") {
      numberBuffer += ch;
      i += 1;
      continue;
    }
    const number = Number(numberBuffer);
    if (numberBuffer === "" || !Number.isFinite(number)) {
      return null;
    }
    numberBuffer = "";
    if (trimmed.startsWith("ms", i)) {
      total += number / 1000;
      i += 2;
    } else if (ch === "h") {
      total += number * 3600;
      i += 1;
    } else if (ch === "m") {
      total += number * 60;
      i += 1;
    } else if (ch === "s") {
      total += number;
      i += 1;
    } else {
      return null;
    }
    matchedAnyUnit = true;
  }
  // Reject a trailing number with no unit ("1h30") and unit-less input.
  if (numberBuffer !== "" || !matchedAnyUnit) {
    return null;
  }
  return Number.isFinite(total) && total >= 0 ? total : null;
}

export interface CooldownInfo {
  seconds: number;
  isDaily: boolean;
}

/**
 * Read a 429's headers to decide how long a model must cool down and whether
 * the limit is a daily one. Priority mirrors LLMCooldownManager.rateLimitCooldown:
 * exhausted daily request quota first, then retry-after, then the per-minute
 * token reset, then a short re-probe fallback.
 */
export function rateLimitCooldown(headers: Headers): CooldownInfo {
  const remainingRaw = headers.get("x-ratelimit-remaining-requests");
  const remaining = remainingRaw != null ? Number(remainingRaw.trim()) : NaN;
  if (Number.isFinite(remaining) && remaining <= 0) {
    const dailyReset = parseHeaderDuration(headers, "x-ratelimit-reset-requests");
    if (dailyReset != null) {
      return { seconds: dailyReset, isDaily: true };
    }
  }
  const retryAfter = parseHeaderDuration(headers, "retry-after");
  if (retryAfter != null) {
    return { seconds: retryAfter, isDaily: false };
  }
  const tokenReset = parseHeaderDuration(headers, "x-ratelimit-reset-tokens");
  if (tokenReset != null) {
    return { seconds: tokenReset, isDaily: false };
  }
  return { seconds: DEFAULT_REPROBE_COOLDOWN_SECONDS, isDaily: false };
}

function parseHeaderDuration(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  return raw != null ? parseGroqDuration(raw) : null;
}

const DAILY_LIMIT_THRESHOLD_SECONDS = 3600;
const DEFAULT_REPROBE_COOLDOWN_SECONDS = 60;

/**
 * Per-model rate-limit cooldown state machine (LLMCooldownManager). The Swift
 * actor persisted daily limits in UserDefaults; this port keeps both tiers in
 * memory and tracks the daily flag for callers that want to surface it. A
 * `now` injector keeps the state machine unit-testable without wall-clock waits.
 */
export class CooldownManager {
  private readonly cooldowns = new Map<string, number>();
  private readonly persisted = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  isInCooldown(model: string): boolean {
    const t = this.now();
    const until = this.cooldowns.get(model);
    if (until !== undefined) {
      if (t < until) {
        return true;
      }
      this.cooldowns.delete(model);
    }
    const persistedUntil = this.persisted.get(model);
    if (persistedUntil !== undefined) {
      if (t < persistedUntil) {
        return true;
      }
      this.persisted.delete(model);
    }
    return false;
  }

  setCooldown(model: string, retryAfterSeconds: number, persist = false): void {
    const expiry = this.now() + retryAfterSeconds * 1000;
    if (persist || retryAfterSeconds >= DAILY_LIMIT_THRESHOLD_SECONDS) {
      this.persisted.set(model, expiry);
    } else {
      this.cooldowns.set(model, expiry);
    }
  }

  /**
   * Pick a usable model up front: primary if not cooling, else the fallback if
   * it exists and isn't cooling, else null so the caller can skip a doomed call.
   */
  effectivePrimary(primary: string, fallback: string | null): string | null {
    if (!this.isInCooldown(primary)) {
      return primary;
    }
    if (fallback == null || this.isInCooldown(fallback)) {
      return null;
    }
    return fallback;
  }
}

/** Shared breaker — Groq rate limits apply org-wide, so one instance is correct. */
export const sharedCooldownManager = new CooldownManager();

export { hostOf };
