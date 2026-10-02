import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG } from "../shared/types.js";
import { HotkeyEngine } from "./hotkey.js";

// uiohook keycodes (from uiohook-napi's UiohookKey table).
const LEFT_CTRL = 29;
const RIGHT_ALT = 3640;

// Drive the private key handler directly so no native hook is needed.
type RawHandler = (keycode: number, time: number, state: "DOWN" | "UP") => void;
function send(engine: HotkeyEngine, keycode: number, time: number, state: "DOWN" | "UP"): void {
  (engine as unknown as { onKeyEvent: RawHandler }).onKeyEvent(keycode, time, state);
}

// Record start/stop decisions. setBusy(true) on stop mirrors endRecording, which
// marks the engine busy while transcription runs so a stray start is dropped.
function trackedEngine(): { engine: HotkeyEngine; events: string[] } {
  const engine = new HotkeyEngine(DEFAULT_CONFIG);
  const events: string[] = [];
  engine.on("start", (mode: string) => events.push(`start:${mode}`));
  engine.on("stop", () => {
    events.push("stop");
    engine.setBusy(true);
  });
  return { engine, events };
}

test("hold key (Right Alt) down then up starts then stops a hold session", () => {
  const { engine, events } = trackedEngine();
  send(engine, RIGHT_ALT, 0, "DOWN");
  send(engine, RIGHT_ALT, 120, "UP");
  assert.deepEqual(events, ["start:hold", "stop"]);
});

test("AltGr (synthetic LEFT CTRL + RIGHT ALT) is treated as a hold, not the toggle chord", () => {
  const { engine, events } = trackedEngine();
  // AltGr: LEFT CTRL and RIGHT ALT at the same timestamp, then auto-repeat.
  send(engine, LEFT_CTRL, 1000, "DOWN");
  send(engine, RIGHT_ALT, 1000, "DOWN");
  send(engine, LEFT_CTRL, 1033, "DOWN"); // repeat
  send(engine, RIGHT_ALT, 1033, "DOWN"); // repeat
  // Release both.
  send(engine, RIGHT_ALT, 1500, "UP");
  send(engine, LEFT_CTRL, 1500, "UP");
  assert.deepEqual(events, ["start:hold", "stop"]);
});

test("a real LEFT CTRL + RIGHT ALT chord toggles on, then off on the next press", () => {
  const { engine, events } = trackedEngine();
  // Deliberate press: LEFT CTRL, then RIGHT ALT 300ms later (well past the AltGr window).
  send(engine, LEFT_CTRL, 0, "DOWN");
  send(engine, RIGHT_ALT, 300, "DOWN");
  // Release the combo; a toggle session stays active.
  send(engine, RIGHT_ALT, 400, "UP");
  send(engine, LEFT_CTRL, 410, "UP");
  // Press the combo again to stop.
  send(engine, LEFT_CTRL, 900, "DOWN");
  send(engine, RIGHT_ALT, 1200, "DOWN");
  assert.deepEqual(events, ["start:toggle", "stop"]);
});
