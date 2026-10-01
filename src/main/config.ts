import { app, safeStorage } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AppConfig, DEFAULT_CONFIG } from "../shared/types";

const CONFIG_FILENAME = "config.json";
const API_KEY_FILENAME = "apikey.bin";

function mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
  return {
    provider: { ...base.provider, ...(override.provider ?? {}) },
    timeouts: { ...base.timeouts, ...(override.timeouts ?? {}) },
    holdShortcut: override.holdShortcut ?? base.holdShortcut,
    toggleShortcut: override.toggleShortcut ?? base.toggleShortcut,
    vocabulary: override.vocabulary ?? base.vocabulary,
    customSystemPrompt: override.customSystemPrompt ?? base.customSystemPrompt,
    editModeEnabled: override.editModeEnabled ?? base.editModeEnabled,
    launchAtLogin: override.launchAtLogin ?? base.launchAtLogin,
  };
}

/**
 * Persists AppConfig to userData/config.json and the Groq API key — separately
 * and encrypted with the OS keystore (DPAPI on Windows) — to userData/apikey.bin.
 * The key is never written to config.json.
 */
export class ConfigStore {
  private cache: AppConfig = DEFAULT_CONFIG;
  private loaded = false;

  private get configPath(): string {
    return path.join(app.getPath("userData"), CONFIG_FILENAME);
  }

  private get apiKeyPath(): string {
    return path.join(app.getPath("userData"), API_KEY_FILENAME);
  }

  async load(): Promise<AppConfig> {
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      this.cache = mergeConfig(DEFAULT_CONFIG, parsed);
    } catch {
      // Missing or corrupt config: fall back to defaults and leave disk untouched
      // until the first explicit set().
      this.cache = DEFAULT_CONFIG;
    }
    this.loaded = true;
    return this.cache;
  }

  get(): AppConfig {
    if (!this.loaded) {
      throw new Error("ConfigStore.get() called before load()");
    }
    return this.cache;
  }

  async set(config: AppConfig): Promise<void> {
    this.cache = mergeConfig(DEFAULT_CONFIG, config);
    this.loaded = true;
    await fs.writeFile(this.configPath, JSON.stringify(this.cache, null, 2), "utf8");
  }

  async isApiKeySet(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.apiKeyPath);
      return stat.size > 0;
    } catch {
      return false;
    }
  }

  async setApiKey(key: string): Promise<void> {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      await fs.rm(this.apiKeyPath, { force: true });
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS encryption (DPAPI) is unavailable; refusing to store the API key unencrypted.");
    }
    const encrypted = safeStorage.encryptString(trimmed);
    await fs.writeFile(this.apiKeyPath, encrypted);
  }

  async getApiKey(): Promise<string | null> {
    try {
      const encrypted = await fs.readFile(this.apiKeyPath);
      if (encrypted.length === 0) {
        return null;
      }
      if (!safeStorage.isEncryptionAvailable()) {
        return null;
      }
      return safeStorage.decryptString(encrypted);
    } catch {
      return null;
    }
  }
}
