import { app, BrowserWindow, Menu, nativeImage, session, Tray } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { IPC } from "../shared/ipc";
import { AppConfig, RecordingState } from "../shared/types";
import { ConfigStore } from "./config";
import { HotkeyEngine } from "./hotkey";
import { registerIpcHandlers, MainContext } from "./ipc";
import { OverlayController, overlayPaths } from "./overlay";

const preloadPath = path.join(__dirname, "../preload/index.js");
const settingsHtmlPath = path.join(__dirname, "../renderer/settings.html");

const ERROR_RESET_MS = 2000;

const config = new ConfigStore();
let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let overlay: OverlayController;
let hotkey: HotkeyEngine;
let recordingState: RecordingState = "idle";
let errorResetTimer: NodeJS.Timeout | null = null;

function rendererWindows(): BrowserWindow[] {
  const windows: BrowserWindow[] = [];
  const overlayWindow = overlay.getWindow();
  if (overlayWindow) {
    windows.push(overlayWindow);
  }
  if (captureWindow && !captureWindow.isDestroyed()) {
    windows.push(captureWindow);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    windows.push(settingsWindow);
  }
  return windows;
}

function broadcast(channel: string, payload?: unknown): void {
  for (const window of rendererWindows()) {
    window.webContents.send(channel, payload);
  }
}

function setRecordingState(state: RecordingState): void {
  recordingState = state;
  broadcast(IPC.recordingStateChanged, state);
}

function beginRecording(): void {
  if (recordingState !== "idle" && recordingState !== "error") {
    return;
  }
  if (errorResetTimer) {
    clearTimeout(errorResetTimer);
    errorResetTimer = null;
  }
  overlay.show();
  broadcast(IPC.startCapture);
  setRecordingState("recording");
}

function endRecording(): void {
  if (recordingState !== "recording") {
    return;
  }
  broadcast(IPC.stopCapture);
  setRecordingState("transcribing");
  hotkey.setBusy(true);
}

function onPipelineSettled(ok: boolean): void {
  hotkey.setBusy(false);
  overlay.hide();
  if (ok) {
    setRecordingState("idle");
    return;
  }
  setRecordingState("error");
  errorResetTimer = setTimeout(() => {
    errorResetTimer = null;
    if (recordingState === "error") {
      setRecordingState("idle");
    }
  }, ERROR_RESET_MS);
}

async function applyConfig(next: AppConfig): Promise<void> {
  hotkey.updateConfig(next);
  app.setLoginItemSettings({
    openAtLogin: next.launchAtLogin,
    path: process.execPath,
  });
  await Promise.resolve();
}

function createSettingsWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 820,
    height: 600,
    minWidth: 640,
    minHeight: 480,
    title: "FreeFlow",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void window.loadFile(settingsHtmlPath);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    settingsWindow = null;
  });
  return window;
}

// Minimal file:// host page for the capture engine. getUserMedia requires a
// secure context, which a loaded local file satisfies (a data: URL would not).
const CAPTURE_HOST_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>FreeFlow Capture</title></head><body></body></html>';

/**
 * Persistent, hidden window that hosts the renderer capture engine (audio.js).
 * The engine subscribes to the capture IPC channels, owns the microphone and
 * MediaRecorder, reports audio levels, and runs the finished blob through the
 * pipeline. It must always exist so recording works whether or not the settings
 * window is open.
 */
async function createCaptureWindow(): Promise<BrowserWindow> {
  const hostPath = path.join(app.getPath("userData"), "capture.html");
  await fs.writeFile(hostPath, CAPTURE_HOST_HTML, "utf8");

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await window.loadFile(hostPath);
  const audioBundle = await fs.readFile(path.join(__dirname, "../renderer/audio.js"), "utf8");
  await window.webContents.executeJavaScript(audioBundle, true);

  window.on("closed", () => {
    captureWindow = null;
  });
  return window;
}

function showSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) {
      settingsWindow.restore();
    }
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = createSettingsWindow();
}

function buildTrayIcon(): Electron.NativeImage {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = 6.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const inside = Math.hypot(x - center, y - center) <= radius;
      // BGRA, premultiplied alpha. A filled dot in near-black for light trays.
      buffer[offset] = 40;
      buffer[offset + 1] = 40;
      buffer[offset + 2] = 40;
      buffer[offset + 3] = inside ? 255 : 0;
    }
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

function createTray(): void {
  tray = new Tray(buildTrayIcon());
  tray.setToolTip("FreeFlow");
  const menu = Menu.buildFromTemplate([
    { label: "Settings…", click: () => showSettings() },
    { type: "separator" },
    { label: "Quit FreeFlow", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => showSettings());
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId("com.freeflow.windows");

  const loaded = await config.load();

  // The capture engine needs the microphone; grant media and deny everything else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");

  const { preloadPath: overlayPreload, htmlPath: overlayHtml } = overlayPaths(__dirname);
  overlay = new OverlayController(overlayPreload, overlayHtml);
  overlay.prepare();

  captureWindow = await createCaptureWindow();

  hotkey = new HotkeyEngine(loaded);
  hotkey.on("start", () => beginRecording());
  hotkey.on("stop", () => endRecording());

  const ctx: MainContext = {
    config,
    overlay,
    broadcast,
    onPipelineSettled,
    applyConfig,
  };
  registerIpcHandlers(ctx);

  createTray();
  await applyConfig(loaded);

  try {
    await hotkey.start();
  } catch (error) {
    console.error("Failed to start global hotkey listener:", error);
  }

  if (!loaded.provider.baseUrl || !(await config.isApiKeySet())) {
    showSettings();
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showSettings());

  app.on("window-all-closed", () => {
    // Tray-resident app: closing the settings window must not quit.
  });

  app.on("before-quit", () => {
    hotkey?.stop();
    overlay?.destroy();
    if (captureWindow && !captureWindow.isDestroyed()) {
      captureWindow.destroy();
      captureWindow = null;
    }
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  app.whenReady().then(bootstrap).catch((error) => {
    console.error("FreeFlow failed to start:", error);
    app.quit();
  });
}
