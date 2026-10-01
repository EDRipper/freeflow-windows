import type { AppContext } from "../shared/types";

// Nearby-app context. The macOS app (AppContextService.swift) reads the
// frontmost app name, window title, and selected text through the Accessibility
// API to help the cleanup model spell names/terms the way the current app does.
// Windows has no equivalent passive cross-app selection read, so we capture the
// foreground app name + window title via active-win. Selected text is handled
// separately by Edit Mode's clipboard copy and is not read here (doing it
// passively would clobber the clipboard on every dictation).

// active-win is CommonJS and marked external so its bundled helper binaries
// resolve against node_modules at runtime rather than being inlined.
type ActiveWinResult = { title?: string; owner?: { name?: string } } | undefined;
type ActiveWin = (options?: { screenRecordingPermission?: boolean }) => Promise<ActiveWinResult>;

let activeWin: ActiveWin | null = null;
function loadActiveWin(): ActiveWin | null {
  if (activeWin) {
    return activeWin;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    activeWin = require("active-win") as ActiveWin;
    return activeWin;
  } catch {
    return null;
  }
}

/**
 * Capture the foreground app name + window title as cleanup context, bounded by
 * `timeoutSeconds` so a slow/unavailable query never stalls the pipeline.
 * Returns undefined when nothing useful could be read.
 */
export async function captureContext(timeoutSeconds: number): Promise<AppContext | undefined> {
  const win = loadActiveWin();
  if (!win) {
    return undefined;
  }

  const timeout = new Promise<ActiveWinResult>((resolve) =>
    setTimeout(() => resolve(undefined), Math.max(1, timeoutSeconds) * 1000),
  );

  let result: ActiveWinResult;
  try {
    result = await Promise.race([win(), timeout]);
  } catch {
    return undefined;
  }
  if (!result) {
    return undefined;
  }

  const appName = result.owner?.name?.trim();
  const windowTitle = result.title?.trim();
  if (!appName && !windowTitle) {
    return undefined;
  }
  return { appName: appName || undefined, windowTitle: windowTitle || undefined };
}
