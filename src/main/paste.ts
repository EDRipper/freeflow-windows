import { clipboard } from "electron";
import { keyboard, Key } from "@nut-tree-fork/nut-js";

// Give the synthetic Ctrl+V time to be delivered before we consider restoring
// the clipboard, and let apps that consume paste asynchronously settle first.
const PASTE_SETTLE_MS = 40;
const CLIPBOARD_RESTORE_DELAY_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Writes `text` to the clipboard, pastes it into the focused field with a
 * synthetic Ctrl+V, then restores the previous clipboard contents after a
 * short delay. Mirrors AppState.writeTranscriptToPasteboard /
 * restoreClipboardIfNeeded: a trailing space is appended after sentence-ending
 * punctuation, and the original clipboard is only restored if nothing else has
 * since overwritten what we wrote (so a deliberate user copy is not clobbered).
 *
 * Electron's clipboard API only round-trips text/html/image, so unlike the
 * macOS version this preserves text content rather than every pasteboard type.
 */
export async function pasteText(text: string): Promise<void> {
  if (text.length === 0) {
    return;
  }

  const lastChar = text[text.length - 1];
  const textToWrite = ".!?".includes(lastChar) ? `${text} ` : text;

  const previous = clipboard.readText();
  clipboard.writeText(textToWrite);

  // nut-js inserts autoDelayMs between each key event; the default is tuned for
  // reliability but feels sluggish for a two-key combo. Keep it small but
  // non-zero so the target app registers the modifier before V.
  keyboard.config.autoDelayMs = 4;

  await delay(PASTE_SETTLE_MS);
  await keyboard.pressKey(Key.LeftControl, Key.V);
  await keyboard.releaseKey(Key.V, Key.LeftControl);

  setTimeout(() => {
    if (clipboard.readText() === textToWrite) {
      clipboard.writeText(previous);
    }
  }, CLIPBOARD_RESTORE_DELAY_MS);
}

// How long to wait for the target app to answer a synthetic Ctrl+C before we
// read the clipboard. Copy is usually slower to land than paste.
const COPY_SETTLE_MS = 120;

/**
 * Capture the current selection by firing a synthetic Ctrl+C and reading what
 * lands on the clipboard, then restoring the original clipboard. Used by Edit
 * Mode to grab the highlighted text before transforming it. Returns "" if the
 * copy produced nothing new (no selection), so the caller can fall back to
 * ordinary dictation. Mirrors the macOS accessibility-selection read, done here
 * through the clipboard since Windows has no equivalent cross-app selection API.
 */
export async function getSelectedText(): Promise<string> {
  const previous = clipboard.readText();
  // A sentinel lets us tell "copied the same text again" from "nothing copied".
  const sentinel = `__freeflow_sel_${process.hrtime.bigint()}__`;
  clipboard.writeText(sentinel);

  keyboard.config.autoDelayMs = 4;
  await keyboard.pressKey(Key.LeftControl, Key.C);
  await keyboard.releaseKey(Key.C, Key.LeftControl);
  await delay(COPY_SETTLE_MS);

  const copied = clipboard.readText();
  clipboard.writeText(previous);
  return copied === sentinel ? "" : copied;
}
