import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { modelConfig, stripThinkTags, transcriptionResponseFormat } from "./models.js";
import {
  appearsToHaveExecutedInstruction,
  buildCommandSystemPrompt,
  buildCommandUserMessage,
  buildSystemPrompt,
  buildUserMessage,
  cleanup,
  COMMAND_MODE_SYSTEM_PROMPT,
  commandTransform,
  contextSummary,
  DEFAULT_SYSTEM_PROMPT,
  postProcessedTranscript,
} from "./postprocess.js";
import { parseTranscript } from "./transcription.js";
import {
  CooldownManager,
  fetchWithTimeout,
  normalizeBaseUrl,
  parseGroqDuration,
  rateLimitCooldown,
  RequestTimeoutError,
} from "./transport.js";
import type { AppConfig } from "../shared/types.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- system prompt / user message construction -------------------------------

test("buildSystemPrompt uses the default prompt when no custom prompt is set", () => {
  const prompt = buildSystemPrompt("", []);
  assert.equal(prompt, DEFAULT_SYSTEM_PROMPT);
});

test("buildSystemPrompt prefers a custom prompt over the default", () => {
  const prompt = buildSystemPrompt("Just fix typos.", []);
  assert.equal(prompt, "Just fix typos.");
});

test("buildSystemPrompt appends a deduped, comma-joined vocabulary block", () => {
  const prompt = buildSystemPrompt("base", ["Kubernetes", "kubernetes", "Grafana, Loki"]);
  assert.match(prompt, /high-priority terms/);
  // Case-insensitive dedupe keeps first spelling; comma entries are split.
  assert.ok(prompt.endsWith("Kubernetes, Grafana, Loki"));
});

test("buildUserMessage matches the swift template with context and sentinel instructions", () => {
  const msg = buildUserMessage("hello world", "App: Mail");
  assert.match(msg, /Return EMPTY if there should be no result/);
  assert.match(msg, /CONTEXT: "App: Mail"/);
  assert.match(msg, /<<<RAW_TRANSCRIPTION\nhello world\nRAW_TRANSCRIPTION$/);
});

test("contextSummary flattens app/window/selection and skips a duplicate window title", () => {
  assert.equal(contextSummary(undefined), "");
  assert.equal(
    contextSummary({ appName: "Slack", windowTitle: "Slack", selectedText: "hi" }),
    "App: Slack. Selected text: hi",
  );
  assert.equal(
    contextSummary({ appName: "Mail", windowTitle: "Re: lunch" }),
    "App: Mail. Window: Re: lunch",
  );
});

// --- EMPTY sentinel + output sanitizing --------------------------------------

test("postProcessedTranscript honors the EMPTY sentinel", () => {
  assert.equal(postProcessedTranscript("EMPTY"), "");
  assert.equal(postProcessedTranscript("  EMPTY  "), "");
  assert.equal(postProcessedTranscript('"EMPTY"'), "");
});

test("postProcessedTranscript strips one layer of wrapping quotes and trims", () => {
  assert.equal(postProcessedTranscript('  "hello there"  '), "hello there");
  assert.equal(postProcessedTranscript("no quotes"), "no quotes");
  assert.equal(postProcessedTranscript(""), "");
});

test("stripThinkTags removes leading closed and unclosed think blocks", () => {
  assert.equal(stripThinkTags("<think>reasoning</think>answer"), "answer");
  assert.equal(stripThinkTags("<think>cut off mid thought"), "");
  assert.equal(stripThinkTags("plain"), "plain");
});

test("instruction-execution guard flags an assistant preamble the raw lacked", () => {
  assert.equal(
    appearsToHaveExecutedInstruction(
      "write a poem about the moon",
      "Sure, here is a poem about the moon shining bright.",
    ),
    true,
  );
  assert.equal(
    appearsToHaveExecutedInstruction(
      "write a message to John saying I'm running late",
      "Write a message to John saying I'm running late.",
    ),
    false,
  );
});

// --- model config ------------------------------------------------------------

test("modelConfig applies gpt-oss-20b tuning and normalizes aliases", () => {
  const direct = modelConfig("openai/gpt-oss-20b");
  assert.equal(direct.maxCompletionTokens, 4096);
  assert.equal(direct.reasoningEffort, "low");
  assert.equal(direct.includeReasoning, false);

  const alias = modelConfig("gpt-oss-20b");
  assert.deepEqual(alias, direct);

  const qwen = modelConfig("qwen/qwen3.6-27b");
  assert.equal(qwen.shouldStripThinkTags, true);
  assert.equal(qwen.reasoningEffort, "none");
});

test("transcriptionResponseFormat gates verbose_json to whisper models", () => {
  assert.equal(transcriptionResponseFormat("whisper-large-v3"), "verbose_json");
  assert.equal(transcriptionResponseFormat("WHISPER-LARGE-V3-TURBO"), "verbose_json");
  assert.equal(transcriptionResponseFormat("gpt-4o-transcribe"), "json");
});

// --- transcription parsing ---------------------------------------------------

test("parseTranscript returns text and suppresses flagged hallucinations", () => {
  assert.equal(parseTranscript(JSON.stringify({ text: "real dictation" })), "real dictation");
  // Stock phrase + high no_speech_prob -> suppressed.
  const noisy = JSON.stringify({ text: "Thank you.", segments: [{ no_speech_prob: 0.9 }] });
  assert.equal(parseTranscript(noisy), "");
  // Same phrase without segment metadata is kept (protects genuine short speech).
  assert.equal(parseTranscript(JSON.stringify({ text: "Thank you" })), "Thank you");
});

test("parseTranscript flattens plain-text responses", () => {
  assert.equal(parseTranscript("line one\nline two"), "line one line two");
});

// --- cooldown state machine --------------------------------------------------

test("parseGroqDuration handles bare, suffixed, and compound durations", () => {
  assert.equal(parseGroqDuration("2"), 2);
  assert.equal(parseGroqDuration("7.66s"), 7.66);
  assert.equal(parseGroqDuration("120ms"), 0.12);
  assert.equal(parseGroqDuration("2m59.5s"), 179.5);
  assert.equal(parseGroqDuration("1h0m0s"), 3600);
  assert.equal(parseGroqDuration("1h30"), null);
  assert.equal(parseGroqDuration("-3"), null);
  assert.equal(parseGroqDuration(""), null);
  assert.equal(parseGroqDuration("nonsense"), null);
});

test("rateLimitCooldown prioritizes an exhausted daily request quota", () => {
  const daily = rateLimitCooldown(
    new Headers({
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "2h",
      "retry-after": "5",
    }),
  );
  assert.deepEqual(daily, { seconds: 7200, isDaily: true });

  const retry = rateLimitCooldown(new Headers({ "retry-after": "5" }));
  assert.deepEqual(retry, { seconds: 5, isDaily: false });

  const fallback = rateLimitCooldown(new Headers({}));
  assert.deepEqual(fallback, { seconds: 60, isDaily: false });
});

test("CooldownManager expires minute-level entries and routes around them", () => {
  let now = 1_000_000;
  const breaker = new CooldownManager(() => now);
  breaker.setCooldown("primary", 30);

  assert.equal(breaker.isInCooldown("primary"), true);
  assert.equal(breaker.effectivePrimary("primary", "fallback"), "fallback");
  assert.equal(breaker.effectivePrimary("primary", null), null);

  now += 31_000;
  assert.equal(breaker.isInCooldown("primary"), false);
  assert.equal(breaker.effectivePrimary("primary", "fallback"), "primary");
});

test("CooldownManager persists daily-threshold cooldowns separately", () => {
  const breaker = new CooldownManager(() => 0);
  breaker.setCooldown("m", 7200, true);
  assert.equal(breaker.isInCooldown("m"), true);
});

// --- transport with mocked fetch (no real network) ---------------------------

test("normalizeBaseUrl trims trailing slashes and validates scheme", () => {
  assert.equal(normalizeBaseUrl("https://api.groq.com/openai/v1/"), "https://api.groq.com/openai/v1");
  assert.equal(normalizeBaseUrl("https://host.tld/"), "https://host.tld");
  assert.throws(() => normalizeBaseUrl("ftp://host"), /http or https/);
  assert.throws(() => normalizeBaseUrl("   "), /empty/);
});

test("fetchWithTimeout throws RequestTimeoutError when the request is aborted", async () => {
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as typeof fetch;

  await assert.rejects(
    () => fetchWithTimeout("https://example.com", { method: "GET" }, 0.01),
    RequestTimeoutError,
  );
});

// --- edit mode / command transform ------------------------------------------

test("buildCommandSystemPrompt keeps the preserve-language line by default", () => {
  const prompt = buildCommandSystemPrompt([], "");
  assert.ok(prompt.includes("Preserve the original language"));
  assert.equal(prompt, COMMAND_MODE_SYSTEM_PROMPT);
});

test("buildCommandSystemPrompt swaps in an output language and appends vocab", () => {
  const prompt = buildCommandSystemPrompt(["Groq, Groq"], "French");
  assert.ok(!prompt.includes("Preserve the original language"));
  assert.ok(prompt.includes("- Output the result in French."));
  assert.ok(prompt.includes("Use these spellings exactly"));
  assert.ok(prompt.trimEnd().endsWith("Groq"));
});

test("buildCommandUserMessage lays out context, command, and selection", () => {
  const msg = buildCommandUserMessage("the quick brown fox", "make it shorter", "App: Notes");
  assert.ok(msg.includes('VOICE_COMMAND: "make it shorter"'));
  assert.ok(msg.includes('SELECTED_TEXT: "the quick brown fox"'));
  assert.ok(msg.includes('CONTEXT: "App: Notes"'));
});

test("commandTransform returns the selection unchanged when the command is empty", async () => {
  const cfg = baseConfig("llama-3.3-70b-versatile");
  const result = await commandTransform("keep me", "   ", {
    provider: cfg.provider,
    timeouts: cfg.timeouts,
    apiKey: "key",
    vocabulary: [],
    cooldownManager: new CooldownManager(),
  });
  assert.equal(result, "keep me");
});

test("commandTransform returns the model replacement and strips wrapping quotes", async () => {
  globalThis.fetch = (async () => chatResponse('"Shortened."')) as typeof fetch;
  const cfg = baseConfig("llama-3.3-70b-versatile");
  const result = await commandTransform("a very long sentence", "make it shorter", {
    provider: cfg.provider,
    timeouts: cfg.timeouts,
    apiKey: "key",
    vocabulary: [],
    cooldownManager: new CooldownManager(),
  });
  assert.equal(result, "Shortened.");
});

function baseConfig(postProcessingModel: string): AppConfig {
  return {
    provider: {
      baseUrl: "https://api.groq.com/openai/v1",
      transcriptionModel: "whisper-large-v3",
      postProcessingModel,
    },
    timeouts: { transcriptionSeconds: 5, postProcessingSeconds: 5, contextRequestSeconds: 5 },
    holdShortcut: { keys: [], mode: "hold" },
    toggleShortcut: { keys: [], mode: "toggle" },
    vocabulary: [],
    customSystemPrompt: "",
    editModeEnabled: false,
    launchAtLogin: false,
  };
}

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

test("cleanup happy path returns the model's cleaned content", async () => {
  globalThis.fetch = (async () => chatResponse("Cleaned text.")) as typeof fetch;
  const cfg = baseConfig("llama-3.3-70b-versatile");
  const result = await cleanup("um cleaned text", {
    provider: cfg.provider,
    timeouts: cfg.timeouts,
    apiKey: "key",
    vocabulary: [],
    customSystemPrompt: "",
    cooldownManager: new CooldownManager(),
  });
  assert.equal(result, "Cleaned text.");
});

test("cleanup returns empty string for the EMPTY sentinel", async () => {
  globalThis.fetch = (async () => chatResponse("EMPTY")) as typeof fetch;
  const cfg = baseConfig("llama-3.3-70b-versatile");
  const result = await cleanup("uh um", {
    provider: cfg.provider,
    timeouts: cfg.timeouts,
    apiKey: "key",
    vocabulary: [],
    customSystemPrompt: "",
    cooldownManager: new CooldownManager(),
  });
  assert.equal(result, "");
});

test("cleanup registers a cooldown on 429 and retries the fallback model", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "2" },
      });
    }
    return chatResponse("Recovered on fallback.");
  }) as typeof fetch;

  const breaker = new CooldownManager();
  const cfg = baseConfig("openai/gpt-oss-20b"); // default primary -> has a built-in fallback
  const result = await cleanup("needs cleanup", {
    provider: cfg.provider,
    timeouts: cfg.timeouts,
    apiKey: "key",
    vocabulary: [],
    customSystemPrompt: "",
    cooldownManager: breaker,
  });

  assert.equal(result, "Recovered on fallback.");
  assert.equal(calls, 2);
  assert.equal(breaker.isInCooldown("openai/gpt-oss-20b"), true);
});
