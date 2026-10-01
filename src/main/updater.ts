import { app, dialog } from "electron";

// Auto-update via electron-updater against the GitHub releases feed configured
// in package.json build.publish. The macOS app had UpdateManager/Sparkle; this
// is the Windows-native equivalent. Kept quiet: it checks in the background and
// only prompts the user once an update is downloaded and ready to install.

// electron-updater is external (not bundled) so it can read app-update.yml from
// the packaged resources at runtime. Loaded lazily so a dev run without it, or a
// first launch from an unpublished build, degrades to a no-op instead of crashing.
interface AutoUpdater {
  autoDownload: boolean;
  logger: unknown;
  on(event: string, listener: (...args: unknown[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

function loadUpdater(): AutoUpdater | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("electron-updater") as { autoUpdater: AutoUpdater };
    return mod.autoUpdater;
  } catch {
    return null;
  }
}

/**
 * Check for updates in the background. In dev (not packaged) this is a no-op.
 * On a downloaded update, offers a restart-to-install prompt rather than forcing
 * it, so an in-progress dictation session is never interrupted.
 */
export function initAutoUpdater(): void {
  if (!app.isPackaged) {
    return;
  }
  const updater = loadUpdater();
  if (!updater) {
    return;
  }

  updater.autoDownload = true;

  updater.on("update-downloaded", (...args: unknown[]) => {
    const info = args[0] as { version?: string } | undefined;
    const version = info?.version ? ` (${info.version})` : "";
    dialog
      .showMessageBox({
        type: "info",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
        title: "Update ready",
        message: `A new version of FreeFlow${version} has been downloaded.`,
        detail: "Restart to install it. Your settings are kept.",
      })
      .then((choice) => {
        if (choice.response === 0) {
          updater.quitAndInstall();
        }
      })
      .catch(() => {
        /* ignore dialog errors */
      });
  });

  updater.on("error", () => {
    // Network/feed errors are non-fatal; stay quiet and retry next launch.
  });

  void updater.checkForUpdates().catch(() => {
    /* offline or no feed yet - ignore */
  });
}
