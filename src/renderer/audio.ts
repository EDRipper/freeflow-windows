// Renderer-side capture engine. The main process owns the hotkey and tells this
// surface when to start/stop via the capture IPC channels; we own the microphone,
// the MediaRecorder, and the live level meter. Importable from any renderer
// window — it no-ops if the freeflow bridge is not present (e.g. a window where
// the preload bridge was not injected).

/**
 * Port of LiveAudioLevelNormalizer.swift. Maps a raw RMS value to a smoothed
 * 0..1 display level by tracking an adaptive noise floor and peak ceiling in dB,
 * gating out ambient noise, and attack/release-smoothing the result. Keeping the
 * constants identical to the Swift original preserves the meter's feel.
 */
class LiveAudioLevelNormalizer {
  private static readonly minimumRMS = 0.00001;
  private static readonly minSpanDB = 18;
  private static readonly peakHeadroomDB = 8;
  private static readonly speechGateMarginDB = 3;
  private static readonly minimumVisibleActiveLevel = 0.12;
  private static readonly noiseGateNormalizedThreshold = 0.06;
  private static readonly floorRiseWindowDB = 4;
  private static readonly floorFallBlend = 0.12;
  private static readonly floorRiseBlend = 0.02;
  private static readonly peakAttackBlend = 0.55;
  private static readonly peakReleaseBlend = 0.04;
  private static readonly displayAttackBlend = 0.45;
  private static readonly displayReleaseBlend = 0.12;

  private noiseFloorDB = -55;
  private peakCeilingDB = -37;
  private displayLevel = 0;

  reset(): void {
    this.noiseFloorDB = -55;
    this.peakCeilingDB = -37;
    this.displayLevel = 0;
  }

  normalizedLevel(rms: number): number {
    const N = LiveAudioLevelNormalizer;
    const levelDB = 20 * Math.log10(Math.max(rms, N.minimumRMS));

    this.updateNoiseFloor(levelDB);
    this.updatePeakCeiling(levelDB);

    const displayCeilingDB = this.peakCeilingDB + N.peakHeadroomDB;
    const dynamicSpan = Math.max(displayCeilingDB - this.noiseFloorDB, N.minSpanDB + N.peakHeadroomDB);
    let normalized = this.clamp((levelDB - this.noiseFloorDB) / dynamicSpan);
    const isActiveSpeech = levelDB >= this.noiseFloorDB + N.speechGateMarginDB;

    if (normalized < N.noiseGateNormalizedThreshold && levelDB <= this.noiseFloorDB + N.speechGateMarginDB) {
      normalized = 0;
    } else if (isActiveSpeech) {
      normalized = Math.max(normalized, N.minimumVisibleActiveLevel);
    }

    const blend = normalized > this.displayLevel ? N.displayAttackBlend : N.displayReleaseBlend;
    this.displayLevel = this.mix(this.displayLevel, normalized, blend);
    return this.displayLevel;
  }

  private updateNoiseFloor(levelDB: number): void {
    const N = LiveAudioLevelNormalizer;
    const ceilingLimitedLevel = Math.min(levelDB, this.peakCeilingDB - N.minSpanDB);

    if (ceilingLimitedLevel <= this.noiseFloorDB) {
      this.noiseFloorDB = this.mix(this.noiseFloorDB, ceilingLimitedLevel, N.floorFallBlend);
    } else if (ceilingLimitedLevel <= this.noiseFloorDB + N.floorRiseWindowDB) {
      this.noiseFloorDB = this.mix(this.noiseFloorDB, ceilingLimitedLevel, N.floorRiseBlend);
    }
  }

  private updatePeakCeiling(levelDB: number): void {
    const N = LiveAudioLevelNormalizer;
    const minimumCeiling = this.noiseFloorDB + N.minSpanDB;

    if (levelDB >= this.peakCeilingDB) {
      this.peakCeilingDB = this.mix(this.peakCeilingDB, levelDB, N.peakAttackBlend);
    } else {
      this.peakCeilingDB = this.mix(this.peakCeilingDB, Math.max(levelDB, minimumCeiling), N.peakReleaseBlend);
    }

    this.peakCeilingDB = Math.max(this.peakCeilingDB, minimumCeiling);
  }

  private mix(current: number, target: number, blend: number): number {
    return current + (target - current) * blend;
  }

  private clamp(value: number): number {
    return Math.min(Math.max(value, 0), 1);
  }
}

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

function pickMimeType(): string {
  for (const candidate of MIME_CANDIDATES) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "audio/webm";
}

class CaptureEngine {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = "audio/webm";

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sampleBuffer: Float32Array<ArrayBuffer> | null = null;
  private levelTimer: number | null = null;
  private readonly normalizer = new LiveAudioLevelNormalizer();

  private starting = false;

  async start(): Promise<void> {
    if (this.starting || this.recorder) return;
    this.starting = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.stream = stream;
      this.mimeType = pickMimeType();

      const recorder = new MediaRecorder(stream, { mimeType: this.mimeType });
      this.chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      };
      recorder.start();
      this.recorder = recorder;

      this.startLevelMeter(stream);
    } catch (error) {
      this.reportError(error);
      this.teardown();
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) {
      // No active recording (e.g. getUserMedia failed at start). Main is already
      // in the transcribing state, so it must be told there is nothing coming.
      this.stopLevelMeter();
      window.freeflow.notifyCaptureEnded();
      return;
    }

    const blob = await this.finishRecorder(recorder);
    this.stopLevelMeter();
    this.releaseStream();
    this.recorder = null;

    if (!blob || blob.size === 0) {
      // Nothing was recorded (a quick tap, silence). Settle the state machine
      // instead of leaving it stuck on the transcribing spinner.
      window.freeflow.notifyCaptureEnded();
      return;
    }

    try {
      const buffer = await blob.arrayBuffer();
      await window.freeflow.runPipeline(buffer, this.mimeType);
    } catch (error) {
      this.reportError(error);
    }
  }

  private finishRecorder(recorder: MediaRecorder): Promise<Blob | null> {
    return new Promise((resolve) => {
      recorder.onstop = () => {
        if (this.chunks.length === 0) {
          resolve(null);
          return;
        }
        resolve(new Blob(this.chunks, { type: this.mimeType }));
        this.chunks = [];
      };
      if (recorder.state !== "inactive") {
        recorder.stop();
      } else {
        resolve(null);
      }
    });
  }

  private startLevelMeter(stream: MediaStream): void {
    this.normalizer.reset();
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    this.audioContext = audioContext;
    this.analyser = analyser;
    this.source = source;
    this.sampleBuffer = new Float32Array(new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));

    // ~30 Hz matches the Swift overlay's level update cadence.
    this.levelTimer = window.setInterval(() => this.sampleLevel(), 1000 / 30);
  }

  private sampleLevel(): void {
    const analyser = this.analyser;
    const samples = this.sampleBuffer;
    if (!analyser || !samples) return;

    analyser.getFloatTimeDomainData(samples);
    let sumOfSquares = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i];
      sumOfSquares += sample * sample;
    }
    const rms = Math.sqrt(sumOfSquares / samples.length);
    const level = this.normalizer.normalizedLevel(rms);
    window.freeflow.reportAudioLevel(level);
  }

  private stopLevelMeter(): void {
    if (this.levelTimer !== null) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    this.source?.disconnect();
    this.analyser?.disconnect();
    void this.audioContext?.close().catch(() => undefined);
    this.source = null;
    this.analyser = null;
    this.audioContext = null;
    this.sampleBuffer = null;
    window.freeflow.reportAudioLevel(0);
  }

  private releaseStream(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  private teardown(): void {
    this.stopLevelMeter();
    this.releaseStream();
    this.recorder = null;
    this.chunks = [];
  }

  private reportError(error: unknown): void {
    const isPermission =
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "SecurityError");
    const message = isPermission
      ? "Microphone access was denied. Enable it in Windows privacy settings."
      : error instanceof Error
        ? error.message
        : "Could not access the microphone.";
    console.error("[freeflow] capture error:", message);
    // The capture engine lives in a hidden window, so a console log is invisible.
    // Forward it so the main process can surface a dialog.
    window.freeflow?.reportCaptureError(message, isPermission);
  }
}

let wired = false;

/**
 * Wire the capture engine to the bridge's start/stop events. Idempotent and safe
 * to call in any renderer window; returns early (and warns once) when no bridge
 * is present, so importing this module where the bridge is absent is harmless.
 */
export function initAudioCapture(): void {
  if (wired) return;
  if (typeof window === "undefined" || !window.freeflow) {
    console.warn("[freeflow] audio capture: bridge unavailable, not wiring capture");
    return;
  }

  wired = true;
  const engine = new CaptureEngine();
  window.freeflow.onStartCapture(() => void engine.start());
  window.freeflow.onStopCapture(() => void engine.stop());
}

// Auto-initialize when loaded as a standalone entry (e.g. a dedicated hidden
// capture window). The idempotency guard keeps a later explicit call a no-op.
if (typeof window !== "undefined" && window.freeflow) {
  initAudioCapture();
}
