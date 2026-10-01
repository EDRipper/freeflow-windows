import { DEFAULT_CONFIG } from "../shared/types";
import type { AppConfig, ShortcutBinding } from "../shared/types";

// Settings controller. Loads the config into the form on open and writes it back
// via setConfig on Save. The API key is write-only: we never read it back, only
// report presence via isApiKeySet and push new values via setApiKey.

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const fields = {
  apiKey: el<HTMLInputElement>("apiKey"),
  apiKeyStatus: el<HTMLSpanElement>("apiKeyStatus"),
  saveKey: el<HTMLButtonElement>("saveKey"),
  baseUrl: el<HTMLInputElement>("baseUrl"),
  transcriptionModel: el<HTMLInputElement>("transcriptionModel"),
  postProcessingModel: el<HTMLInputElement>("postProcessingModel"),
  holdDisplay: el<HTMLElement>("holdDisplay"),
  holdRecord: el<HTMLButtonElement>("holdRecord"),
  toggleDisplay: el<HTMLElement>("toggleDisplay"),
  toggleRecord: el<HTMLButtonElement>("toggleRecord"),
  vocabInput: el<HTMLInputElement>("vocabInput"),
  vocabAdd: el<HTMLButtonElement>("vocabAdd"),
  vocabList: el<HTMLUListElement>("vocabList"),
  systemPrompt: el<HTMLTextAreaElement>("systemPrompt"),
  editMode: el<HTMLInputElement>("editMode"),
  launchAtLogin: el<HTMLInputElement>("launchAtLogin"),
  save: el<HTMLButtonElement>("save"),
  saveStatus: el<HTMLSpanElement>("saveStatus"),
  captureOverlay: el<HTMLDivElement>("captureOverlay"),
  captureDisplay: el<HTMLElement>("captureDisplay"),
};

// Working copy of config. The two shortcut bindings live here because they are
// edited through the capture modal rather than plain inputs; everything else is
// read straight off the inputs at save time.
let holdShortcut: ShortcutBinding = structuredClone(DEFAULT_CONFIG.holdShortcut);
let toggleShortcut: ShortcutBinding = structuredClone(DEFAULT_CONFIG.toggleShortcut);
let vocabulary: string[] = [];
// Preserved verbatim across edits since the UI does not expose them.
let timeouts = structuredClone(DEFAULT_CONFIG.timeouts);
let transcriptionBaseUrl: string | undefined;

// --- Key event -> node-global-key-listener identifier -----------------------

const MODIFIER_NAMES: Record<string, string> = {
  ControlLeft: "LEFT CTRL",
  ControlRight: "RIGHT CTRL",
  AltLeft: "LEFT ALT",
  AltRight: "RIGHT ALT",
  ShiftLeft: "LEFT SHIFT",
  ShiftRight: "RIGHT SHIFT",
  MetaLeft: "LEFT META",
  MetaRight: "RIGHT META",
};

const NAMED_KEYS: Record<string, string> = {
  Space: "SPACE",
  Enter: "RETURN",
  Tab: "TAB",
  Backspace: "BACKSPACE",
  Escape: "ESCAPE",
  CapsLock: "CAPS LOCK",
  ArrowUp: "UP ARROW",
  ArrowDown: "DOWN ARROW",
  ArrowLeft: "LEFT ARROW",
  ArrowRight: "RIGHT ARROW",
  Minus: "MINUS",
  Equal: "EQUALS",
  BracketLeft: "SQUARE BRACKET OPEN",
  BracketRight: "SQUARE BRACKET CLOSE",
  Semicolon: "SEMICOLON",
  Quote: "QUOTE",
  Backquote: "BACKTICK",
  Comma: "COMMA",
  Period: "DOT",
  Slash: "FORWARD SLASH",
  Backslash: "BACKSLASH",
};

function mapCode(code: string): string | null {
  if (code in MODIFIER_NAMES) return MODIFIER_NAMES[code];
  if (code in NAMED_KEYS) return NAMED_KEYS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F[0-9]{1,2}$/.test(code)) return code;
  return null;
}

function isModifierCode(code: string): boolean {
  return code in MODIFIER_NAMES;
}

function formatCombo(binding: ShortcutBinding): string {
  return binding.keys.length ? binding.keys.join(" + ") : "Not set";
}

function renderShortcuts(): void {
  fields.holdDisplay.textContent = formatCombo(holdShortcut);
  fields.toggleDisplay.textContent = formatCombo(toggleShortcut);
}

// --- Shortcut capture modal --------------------------------------------------

interface CaptureSession {
  target: "hold" | "toggle";
  pressed: Set<string>;
  peak: string[];
}

let capture: CaptureSession | null = null;

function orderKeys(keys: string[]): string[] {
  // Modifiers first (in a stable order), then the primary key, so a combo reads
  // naturally regardless of the order keys were physically pressed.
  const modifierOrder = Object.values(MODIFIER_NAMES);
  return [...keys].sort((a, b) => {
    const ia = modifierOrder.indexOf(a);
    const ib = modifierOrder.indexOf(b);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function startCapture(target: "hold" | "toggle"): void {
  capture = { target, pressed: new Set(), peak: [] };
  fields.captureDisplay.textContent = "…";
  fields.captureDisplay.classList.add("recording");
  fields.captureOverlay.hidden = false;
}

function endCapture(commit: boolean): void {
  if (!capture) return;
  const session = capture;
  capture = null;
  fields.captureOverlay.hidden = true;
  fields.captureDisplay.classList.remove("recording");

  if (commit && session.peak.length > 0) {
    const keys = orderKeys(session.peak);
    if (session.target === "hold") {
      holdShortcut = { keys, mode: "hold" };
    } else {
      toggleShortcut = { keys, mode: "toggle" };
    }
    renderShortcuts();
  }
}

function onCaptureKeyDown(event: KeyboardEvent): void {
  if (!capture) return;
  event.preventDefault();
  event.stopPropagation();

  if (event.code === "Escape" && capture.pressed.size === 0) {
    endCapture(false);
    return;
  }

  const name = mapCode(event.code);
  if (!name) return;

  capture.pressed.add(name);
  const current = orderKeys([...capture.pressed]);
  // Keep the largest combo seen this session as the peak.
  if (current.length >= capture.peak.length) {
    capture.peak = current;
  }
  fields.captureDisplay.textContent = current.join(" + ");

  // A non-modifier key finalizes immediately — most combos end on a real key.
  if (!isModifierCode(event.code)) {
    endCapture(true);
  }
}

function onCaptureKeyUp(event: KeyboardEvent): void {
  if (!capture) return;
  event.preventDefault();
  const name = mapCode(event.code);
  if (name) capture.pressed.delete(name);
  // Releasing everything commits the peak — this is how modifier-only combos
  // (e.g. a lone RIGHT ALT) get recorded.
  if (capture.pressed.size === 0) {
    endCapture(true);
  }
}

// --- Vocabulary --------------------------------------------------------------

function renderVocabulary(): void {
  fields.vocabList.replaceChildren();
  vocabulary.forEach((word, index) => {
    const li = document.createElement("li");
    li.className = "chip";
    const span = document.createElement("span");
    span.textContent = word;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${word}`);
    remove.addEventListener("click", () => {
      vocabulary.splice(index, 1);
      renderVocabulary();
    });
    li.append(span, remove);
    fields.vocabList.append(li);
  });
}

function addVocabularyEntry(): void {
  const value = fields.vocabInput.value.trim();
  if (!value) return;
  if (!vocabulary.includes(value)) {
    vocabulary.push(value);
    renderVocabulary();
  }
  fields.vocabInput.value = "";
  fields.vocabInput.focus();
}

// --- API key -----------------------------------------------------------------

function setKeyStatus(present: boolean): void {
  fields.apiKeyStatus.textContent = present ? "set" : "not set";
  fields.apiKeyStatus.classList.toggle("set", present);
  fields.apiKeyStatus.classList.toggle("unset", !present);
}

async function refreshKeyStatus(): Promise<void> {
  try {
    setKeyStatus(await window.freeflow.isApiKeySet());
  } catch {
    fields.apiKeyStatus.textContent = "unknown";
  }
}

async function saveApiKey(): Promise<void> {
  const key = fields.apiKey.value.trim();
  if (!key) return;
  fields.saveKey.disabled = true;
  try {
    await window.freeflow.setApiKey(key);
    fields.apiKey.value = "";
    await refreshKeyStatus();
    flash("API key saved.", "ok");
  } catch (error) {
    flash(error instanceof Error ? error.message : "Could not save API key.", "err");
  } finally {
    fields.saveKey.disabled = false;
  }
}

// --- Load / save -------------------------------------------------------------

function applyConfig(config: AppConfig): void {
  fields.baseUrl.value = config.provider.baseUrl;
  fields.transcriptionModel.value = config.provider.transcriptionModel;
  fields.postProcessingModel.value = config.provider.postProcessingModel;
  transcriptionBaseUrl = config.provider.transcriptionBaseUrl;
  timeouts = config.timeouts;
  holdShortcut = config.holdShortcut;
  toggleShortcut = config.toggleShortcut;
  vocabulary = [...config.vocabulary];
  fields.systemPrompt.value = config.customSystemPrompt;
  fields.editMode.checked = config.editModeEnabled;
  fields.launchAtLogin.checked = config.launchAtLogin;
  renderShortcuts();
  renderVocabulary();
}

function collectConfig(): AppConfig {
  // Fold in a last-second vocab entry the user typed but did not click Add on.
  const pending = fields.vocabInput.value.trim();
  if (pending && !vocabulary.includes(pending)) {
    vocabulary.push(pending);
    fields.vocabInput.value = "";
    renderVocabulary();
  }

  const provider: AppConfig["provider"] = {
    baseUrl: fields.baseUrl.value.trim() || DEFAULT_CONFIG.provider.baseUrl,
    transcriptionModel: fields.transcriptionModel.value.trim(),
    postProcessingModel: fields.postProcessingModel.value.trim(),
  };
  if (transcriptionBaseUrl) provider.transcriptionBaseUrl = transcriptionBaseUrl;

  return {
    provider,
    timeouts,
    holdShortcut,
    toggleShortcut,
    vocabulary,
    customSystemPrompt: fields.systemPrompt.value.trim(),
    editModeEnabled: fields.editMode.checked,
    launchAtLogin: fields.launchAtLogin.checked,
  };
}

let flashTimer = 0;
function flash(message: string, kind: "ok" | "err"): void {
  fields.saveStatus.textContent = message;
  fields.saveStatus.classList.toggle("ok", kind === "ok");
  fields.saveStatus.classList.toggle("err", kind === "err");
  if (flashTimer) window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    fields.saveStatus.textContent = "";
    fields.saveStatus.classList.remove("ok", "err");
  }, 2500);
}

async function saveConfig(): Promise<void> {
  fields.save.disabled = true;
  try {
    await window.freeflow.setConfig(collectConfig());
    flash("Settings saved.", "ok");
  } catch (error) {
    flash(error instanceof Error ? error.message : "Could not save settings.", "err");
  } finally {
    fields.save.disabled = false;
  }
}

// --- Wiring ------------------------------------------------------------------

function wire(): void {
  fields.saveKey.addEventListener("click", () => void saveApiKey());
  fields.apiKey.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void saveApiKey();
  });

  fields.holdRecord.addEventListener("click", () => startCapture("hold"));
  fields.toggleRecord.addEventListener("click", () => startCapture("toggle"));
  window.addEventListener("keydown", onCaptureKeyDown, true);
  window.addEventListener("keyup", onCaptureKeyUp, true);
  fields.captureOverlay.addEventListener("click", () => endCapture(false));

  fields.vocabAdd.addEventListener("click", addVocabularyEntry);
  fields.vocabInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addVocabularyEntry();
    }
  });

  fields.save.addEventListener("click", () => void saveConfig());
}

async function init(): Promise<void> {
  if (!window.freeflow) {
    flash("Bridge unavailable — settings cannot load.", "err");
    return;
  }
  wire();
  try {
    applyConfig(await window.freeflow.getConfig());
  } catch {
    applyConfig(DEFAULT_CONFIG);
    flash("Could not load settings; showing defaults.", "err");
  }
  await refreshKeyStatus();
}

void init();
