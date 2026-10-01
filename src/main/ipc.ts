import { ipcMain, IpcMainInvokeEvent } from "electron";
import { IPC } from "../shared/ipc";
import { AppConfig, PipelineResult } from "../shared/types";
import { runPipeline } from "../core/pipeline";
import { ConfigStore } from "./config";
import { OverlayController } from "./overlay";
import { pasteText } from "./paste";

export interface MainContext {
  config: ConfigStore;
  overlay: OverlayController;
  /** Push a message to every live renderer window. */
  broadcast(channel: string, payload?: unknown): void;
  /** Called after the pipeline finishes (ok) or throws (!ok) to update state. */
  onPipelineSettled(ok: boolean): void;
  /** Re-apply config side effects (hotkeys, launch-at-login) after a change. */
  applyConfig(config: AppConfig): Promise<void>;
}

export function registerIpcHandlers(ctx: MainContext): void {
  ipcMain.handle(IPC.getConfig, (): AppConfig => ctx.config.get());

  ipcMain.handle(IPC.setConfig, async (_event: IpcMainInvokeEvent, config: AppConfig): Promise<void> => {
    await ctx.config.set(config);
    await ctx.applyConfig(ctx.config.get());
  });

  ipcMain.handle(IPC.getApiKeyPresence, (): Promise<boolean> => ctx.config.isApiKeySet());

  ipcMain.handle(IPC.setApiKey, (_event: IpcMainInvokeEvent, key: string): Promise<void> =>
    ctx.config.setApiKey(key),
  );

  ipcMain.handle(
    IPC.runPipeline,
    async (_event: IpcMainInvokeEvent, audio: ArrayBuffer, mimeType: string): Promise<PipelineResult> => {
      const apiKey = await ctx.config.getApiKey();
      if (!apiKey) {
        ctx.onPipelineSettled(false);
        throw new Error("No API key configured.");
      }

      try {
        const result = await runPipeline(audio, mimeType, apiKey, ctx.config.get());
        if (result.cleanedText.trim().length > 0) {
          await pasteText(result.cleanedText);
        }
        ctx.onPipelineSettled(true);
        return result;
      } catch (error) {
        ctx.onPipelineSettled(false);
        throw error;
      }
    },
  );

  // Audio levels travel renderer -> main on the same channel we use to push
  // them back out to the overlay window that renders the waveform.
  ipcMain.on(IPC.audioLevel, (_event, level: number) => {
    ctx.overlay.forwardAudioLevel(level);
  });
}
