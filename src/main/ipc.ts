import { dialog, ipcMain, IpcMainInvokeEvent } from "electron";
import { IPC } from "../shared/ipc";
import { AppConfig, HistoryEntry, PipelineResult } from "../shared/types";
import { runEditMode, runPipeline } from "../core/pipeline";
import { ConfigStore } from "./config";
import { HistoryStore } from "./history";
import { captureContext } from "./context";
import { OverlayController } from "./overlay";
import { getSelectedText, pasteText } from "./paste";

export interface MainContext {
  config: ConfigStore;
  history: HistoryStore;
  overlay: OverlayController;
  /** Push a message to every live renderer window. */
  broadcast(channel: string, payload?: unknown): void;
  /** Called after the pipeline finishes (ok) or throws (!ok) to update state. */
  onPipelineSettled(ok: boolean): void;
  /** Re-apply config side effects (hotkeys, launch-at-login) after a change. */
  applyConfig(config: AppConfig): Promise<void>;
}

export function registerIpcHandlers(ctx: MainContext): void {
  // Debounce user-facing error dialogs so a burst never stacks boxes.
  let lastErrorDialogAt = 0;
  const showErrorDialog = (title: string, detail: string): void => {
    const now = Date.now();
    if (now - lastErrorDialogAt < 3000) {
      return;
    }
    lastErrorDialogAt = now;
    dialog.showErrorBox(title, detail);
  };

  ipcMain.handle(IPC.getConfig, (): AppConfig => ctx.config.get());

  ipcMain.handle(IPC.setConfig, async (_event: IpcMainInvokeEvent, config: AppConfig): Promise<void> => {
    await ctx.config.set(config);
    await ctx.applyConfig(ctx.config.get());
  });

  ipcMain.handle(IPC.getApiKeyPresence, (): Promise<boolean> => ctx.config.isApiKeySet());

  ipcMain.handle(IPC.setApiKey, (_event: IpcMainInvokeEvent, key: string): Promise<void> =>
    ctx.config.setApiKey(key),
  );

  ipcMain.handle(IPC.getHistory, (): Promise<HistoryEntry[]> => ctx.history.list());

  ipcMain.handle(IPC.clearHistory, (): Promise<void> => ctx.history.clear());

  ipcMain.handle(
    IPC.runPipeline,
    async (_event: IpcMainInvokeEvent, audio: ArrayBuffer, mimeType: string): Promise<PipelineResult> => {
      const apiKey = await ctx.config.getApiKey();
      if (!apiKey) {
        ctx.onPipelineSettled(false);
        showErrorDialog(
          "FreeFlow: no API key",
          "No Groq API key is set. Open FreeFlow settings (tray icon) and paste your key from console.groq.com/keys.",
        );
        throw new Error("No API key configured.");
      }

      const config = ctx.config.get();
      try {
        // Edit Mode: if enabled and there's a live selection, transform it by the
        // spoken command instead of pasting a fresh dictation. No selection means
        // there's nothing to edit, so fall through to ordinary dictation.
        const selection = config.editModeEnabled ? await getSelectedText() : "";
        const editMode = Boolean(selection);
        const context = await captureContext(config.timeouts.contextRequestSeconds);
        const result = editMode
          ? await runEditMode(audio, mimeType, apiKey, config, selection, context)
          : await runPipeline(audio, mimeType, apiKey, config, context);
        const produced = result.cleanedText.trim().length > 0;
        if (produced) {
          await pasteText(result.cleanedText);
        }
        ctx.onPipelineSettled(true);
        // Record only dictations that produced text. A history write must never
        // break the dictation itself, so failures are swallowed with a log.
        if (produced) {
          try {
            await ctx.history.add({
              rawTranscript: result.rawTranscript,
              cleanedText: result.cleanedText,
              model: config.provider.postProcessingModel,
              durationMs: result.durationMs,
              editMode,
            });
          } catch (historyError) {
            console.error("Failed to record dictation history:", historyError);
          }
        }
        return result;
      } catch (error) {
        ctx.onPipelineSettled(false);
        const message = error instanceof Error ? error.message : String(error);
        showErrorDialog("FreeFlow: transcription failed", message);
        throw error;
      }
    },
  );

  // Audio levels travel renderer -> main on the same channel we use to push
  // them back out to the overlay window that renders the waveform.
  ipcMain.on(IPC.audioLevel, (_event, level: number) => {
    ctx.overlay.forwardAudioLevel(level);
  });

  // Capture finished with nothing to transcribe (empty/aborted recording): settle
  // the state machine to idle rather than leaving the transcribing spinner stuck.
  ipcMain.on(IPC.captureEnded, () => {
    ctx.onPipelineSettled(true);
  });

  // The capture engine runs in a hidden window; surface its failures so a denied
  // microphone reads as a clear message instead of silence. Debounced so a burst
  // of errors does not stack dialogs.
  ipcMain.on(IPC.captureError, (_event, message: string, isPermission: boolean) => {
    ctx.onPipelineSettled(false);
    const detail = isPermission
      ? "Windows is blocking microphone access for FreeFlow.\n\n" +
        "Open Settings -> Privacy & security -> Microphone and turn on both " +
        '"Microphone access" and "Let desktop apps access your microphone", then try again.\n\n' +
        message
      : message;
    showErrorDialog("FreeFlow: no microphone input", detail);
  });
}
