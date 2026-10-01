// Preload bridge. Runs with contextIsolation on, so the renderer never touches
// ipcRenderer directly — it only sees the typed `freeflow` object below.
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc";
import type { FreeflowBridge } from "../shared/ipc";
import type { AppConfig, PipelineResult, RecordingState } from "../shared/types";

const bridge: FreeflowBridge = {
  getConfig(): Promise<AppConfig> {
    return ipcRenderer.invoke(IPC.getConfig);
  },
  setConfig(config: AppConfig): Promise<void> {
    return ipcRenderer.invoke(IPC.setConfig, config);
  },
  isApiKeySet(): Promise<boolean> {
    return ipcRenderer.invoke(IPC.getApiKeyPresence);
  },
  setApiKey(key: string): Promise<void> {
    return ipcRenderer.invoke(IPC.setApiKey, key);
  },
  runPipeline(audio: ArrayBuffer, mimeType: string): Promise<PipelineResult> {
    return ipcRenderer.invoke(IPC.runPipeline, audio, mimeType);
  },
  onStartCapture(cb: () => void): void {
    ipcRenderer.on(IPC.startCapture, () => cb());
  },
  onStopCapture(cb: () => void): void {
    ipcRenderer.on(IPC.stopCapture, () => cb());
  },
  onRecordingState(cb: (state: RecordingState) => void): void {
    ipcRenderer.on(IPC.recordingStateChanged, (_event, state: RecordingState) => cb(state));
  },
  reportAudioLevel(level: number): void {
    ipcRenderer.send(IPC.audioLevel, level);
  },
};

// Renderer convenience over the existing IPC.audioLevel channel: when main
// forwards a level to a display window (the overlay), let that window subscribe.
// This does not change the shared contract — it only consumes a declared channel
// in the main -> renderer direction.
const levelListener = {
  onAudioLevel(cb: (level: number) => void): void {
    ipcRenderer.on(IPC.audioLevel, (_event, level: number) => cb(level));
  },
};

contextBridge.exposeInMainWorld("freeflow", { ...bridge, ...levelListener });
