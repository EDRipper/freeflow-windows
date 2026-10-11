import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { HistoryEntry } from "../shared/types.js";

const DEFAULT_MAX_ENTRIES = 100;

/** The caller-supplied part of an entry; id and timestamp are assigned by the store. */
export type NewHistoryEntry = Omit<HistoryEntry, "id" | "timestamp">;

/**
 * Persists completed dictations to a JSON array on disk, newest first, capped at
 * the most recent N entries. Mirrors ConfigStore's plain-JSON style but keeps the
 * file path injectable (no electron import) so it runs under node --test.
 */
export class HistoryStore {
  private entries: HistoryEntry[] = [];
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {}

  async add(entry: NewHistoryEntry): Promise<HistoryEntry> {
    await this.ensureLoaded();
    const stored: HistoryEntry = { id: randomUUID(), timestamp: Date.now(), ...entry };
    this.entries.unshift(stored);
    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }
    await this.persist();
    return stored;
  }

  async list(): Promise<HistoryEntry[]> {
    await this.ensureLoaded();
    // Hand back copies so a caller can't mutate the in-memory cache.
    return this.entries.map((entry) => ({ ...entry }));
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.loaded = true;
    await this.persist();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      // Drop anything that isn't a well-formed entry rather than trusting the file
      // wholesale; a partially corrupt array still yields the usable rows.
      this.entries = Array.isArray(parsed) ? parsed.filter(isHistoryEntry) : [];
    } catch {
      // Missing or corrupt file: start empty and leave disk untouched until the
      // first add()/clear() writes a clean array.
      this.entries = [];
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(this.entries, null, 2), "utf8");
  }
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.timestamp === "number" &&
    typeof entry.rawTranscript === "string" &&
    typeof entry.cleanedText === "string" &&
    typeof entry.model === "string" &&
    typeof entry.durationMs === "number" &&
    typeof entry.editMode === "boolean"
  );
}
