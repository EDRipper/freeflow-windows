import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { IPC } from "../shared/ipc";

const OVERLAY_WIDTH = 240;
const OVERLAY_HEIGHT = 72;
const OVERLAY_BOTTOM_MARGIN = 96;

/**
 * Frameless, transparent, always-on-top recording overlay. It is click-through
 * so it never steals focus or intercepts clicks from the app the user is
 * dictating into. The same renderer captures the microphone and reports audio
 * levels, which we echo back here to drive its waveform.
 */
export class OverlayController {
  private window: BrowserWindow | null = null;

  constructor(
    private readonly preloadPath: string,
    private readonly htmlPath: string,
  ) {}

  private create(): BrowserWindow {
    const { workArea } = screen.getPrimaryDisplay();
    const x = Math.round(workArea.x + (workArea.width - OVERLAY_WIDTH) / 2);
    const y = workArea.y + workArea.height - OVERLAY_HEIGHT - OVERLAY_BOTTOM_MARGIN;

    const window = new BrowserWindow({
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setIgnoreMouseEvents(true, { forward: true });
    void window.loadFile(this.htmlPath);

    window.on("closed", () => {
      this.window = null;
    });

    this.window = window;
    return window;
  }

  private ensure(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }
    return this.create();
  }

  /** Create and load the overlay up front so the first show() has no load race. */
  prepare(): void {
    this.ensure();
  }

  show(): void {
    const window = this.ensure();
    window.showInactive();
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.window.hide();
    }
  }

  forwardAudioLevel(level: number): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC.audioLevel, level);
    }
  }

  getWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = null;
  }
}

export function overlayPaths(dirname: string): { preloadPath: string; htmlPath: string } {
  return {
    preloadPath: path.join(dirname, "../preload/index.js"),
    htmlPath: path.join(dirname, "../renderer/overlay.html"),
  };
}
