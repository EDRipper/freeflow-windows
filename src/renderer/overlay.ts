import type { FreeflowBridge } from "../shared/ipc";
import type { RecordingState } from "../shared/types";

// The overlay window is display-only: it reflects the recording state pushed by
// main and animates the live level forwarded over the audio:level channel. The
// preload exposes an onAudioLevel subscriber in addition to the core bridge.
interface OverlayBridge extends FreeflowBridge {
  onAudioLevel(cb: (level: number) => void): void;
}

const pill = document.getElementById("pill");
const label = document.getElementById("label");
const bars = Array.from(document.querySelectorAll<HTMLElement>(".indicator .bar"));

const LABELS: Partial<Record<RecordingState, string>> = {
  recording: "Recording",
  transcribing: "Transcribing",
  error: "Error",
};

function applyState(state: RecordingState): void {
  if (!pill || !label) return;
  // idle has no overlay; main hides the window. Treat it as recording-shaped
  // so a stray idle event does not blank the pill mid-animation.
  const phase = state === "idle" ? "recording" : state;
  pill.setAttribute("data-state", phase);
  label.textContent = LABELS[state] ?? "Recording";
  if (state !== "recording") setLevel(0);
}

// Smooth the incoming level toward its target with a short rAF ease so the bars
// glide rather than step, even if levels arrive at an irregular cadence.
let targetLevel = 0;
let shownLevel = 0;
let rafHandle = 0;

function setLevel(level: number): void {
  targetLevel = Math.min(Math.max(level, 0), 1);
  if (!rafHandle) rafHandle = requestAnimationFrame(animate);
}

function animate(): void {
  shownLevel += (targetLevel - shownLevel) * 0.35;
  if (Math.abs(targetLevel - shownLevel) < 0.001) shownLevel = targetLevel;

  for (const bar of bars) {
    bar.style.setProperty("--level", shownLevel.toFixed(3));
  }

  if (shownLevel !== targetLevel) {
    rafHandle = requestAnimationFrame(animate);
  } else {
    rafHandle = 0;
  }
}

function main(): void {
  const bridge = window.freeflow as OverlayBridge | undefined;
  if (!bridge) {
    console.warn("[freeflow] overlay: bridge unavailable");
    return;
  }

  bridge.onRecordingState(applyState);
  if (typeof bridge.onAudioLevel === "function") {
    bridge.onAudioLevel(setLevel);
  }
}

main();
