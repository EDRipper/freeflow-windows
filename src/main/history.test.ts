import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { HistoryStore, type NewHistoryEntry } from "./history.js";

// Each test gets a throwaway file in the OS temp dir; we clean them up after.
const createdPaths: string[] = [];

function tmpPath(): string {
  const file = path.join(os.tmpdir(), `freeflow-history-${randomUUID()}.json`);
  createdPaths.push(file);
  return file;
}

function sampleEntry(overrides: Partial<NewHistoryEntry> = {}): NewHistoryEntry {
  return {
    rawTranscript: "um hello world",
    cleanedText: "Hello, world.",
    model: "openai/gpt-oss-20b",
    durationMs: 1234,
    editMode: false,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((file) => fs.rm(file, { force: true })));
});

test("add assigns id + timestamp and list returns newest first", async () => {
  const store = new HistoryStore(tmpPath());
  const first = await store.add(sampleEntry({ cleanedText: "First." }));
  const second = await store.add(sampleEntry({ cleanedText: "Second." }));

  assert.ok(first.id);
  assert.equal(typeof first.timestamp, "number");

  const list = await store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0]?.cleanedText, "Second.");
  assert.equal(list[1]?.cleanedText, "First.");
  assert.equal(list[0]?.id, second.id);
});

test("add caps the history at the most recent N entries", async () => {
  const store = new HistoryStore(tmpPath(), 3);
  for (let i = 0; i < 10; i += 1) {
    await store.add(sampleEntry({ cleanedText: `entry ${i}` }));
  }

  const list = await store.list();
  assert.equal(list.length, 3);
  // Newest three, most recent first.
  assert.deepEqual(
    list.map((entry) => entry.cleanedText),
    ["entry 9", "entry 8", "entry 7"],
  );
});

test("the cap survives reloading from disk", async () => {
  const file = tmpPath();
  const writer = new HistoryStore(file, 2);
  await writer.add(sampleEntry({ cleanedText: "a" }));
  await writer.add(sampleEntry({ cleanedText: "b" }));
  await writer.add(sampleEntry({ cleanedText: "c" }));

  const reader = new HistoryStore(file, 2);
  const list = await reader.list();
  assert.deepEqual(
    list.map((entry) => entry.cleanedText),
    ["c", "b"],
  );
});

test("clear empties the store and the persisted file", async () => {
  const file = tmpPath();
  const store = new HistoryStore(file);
  await store.add(sampleEntry());
  await store.clear();

  assert.deepEqual(await store.list(), []);
  // A fresh store reading the same file also sees it empty.
  assert.deepEqual(await new HistoryStore(file).list(), []);
});

test("a missing file lists as empty", async () => {
  const store = new HistoryStore(tmpPath());
  assert.deepEqual(await store.list(), []);
});

test("a corrupt file lists as empty and is recoverable by add", async () => {
  const file = tmpPath();
  await fs.writeFile(file, "{ not valid json ]", "utf8");

  const store = new HistoryStore(file);
  assert.deepEqual(await store.list(), []);

  await store.add(sampleEntry({ cleanedText: "recovered" }));
  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.cleanedText, "recovered");
});

test("malformed rows inside a valid array are dropped", async () => {
  const file = tmpPath();
  const good = {
    id: "keep",
    timestamp: 1,
    rawTranscript: "r",
    cleanedText: "good",
    model: "m",
    durationMs: 1,
    editMode: false,
  };
  await fs.writeFile(file, JSON.stringify([good, { id: 42 }, "nope", null]), "utf8");

  const list = await new HistoryStore(file).list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.cleanedText, "good");
});
