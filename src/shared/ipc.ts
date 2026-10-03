// IPC channel contract between main and renderer. Keep every channel name here
// so main, preload, and renderer agree. preload exposes these over a typed bridge.

export const IPC = {
  // renderer -> main (invoke/handle)
  getConfig: "config:get",
  setConfig: "config:set",
  getApiKeyPresence: "apikey:present",
  setApiKey: "apikey:set",
  // renderer -> main: a finished recording blob to run through the pipeline
  runPipeline: "pipeline:run",
  // renderer -> main: a capture failure worth surfacing to the user
  captureError: "capture:error",
  // main -> renderer (send)
  recordingStateChanged: "recording:state",
  startCapture: "capture:start",
  stopCapture: "capture:stop",
  audioLevel: "audio:level",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// Shape of the bridge preload exposes on window.freeflow
export interface FreeflowBridge {
  getConfig(): Promise<import("./types").AppConfig>;
  setConfig(config: import("./types").AppConfig): Promise<void>;
  isApiKeySet(): Promise<boolean>;
  setApiKey(key: string): Promise<void>;
  runPipeline(audio: ArrayBuffer, mimeType: string): Promise<import("./types").PipelineResult>;
  onStartCapture(cb: () => void): void;
  onStopCapture(cb: () => void): void;
  onRecordingState(cb: (state: import("./types").RecordingState) => void): void;
  reportAudioLevel(level: number): void;
  reportCaptureError(message: string, isPermission: boolean): void;
}

declare global {
  interface Window {
    freeflow: FreeflowBridge;
  }
}
