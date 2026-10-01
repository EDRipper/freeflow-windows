import { EventEmitter } from "node:events";
import {
  GlobalKeyboardListener,
  IGlobalKeyEvent,
  IGlobalKeyListener,
} from "node-global-key-listener";
import { AppConfig, ShortcutBinding } from "../shared/types";

type ShortcutEvent =
  | "holdActivated"
  | "holdDeactivated"
  | "toggleActivated"
  | "toggleDeactivated";

type SessionAction =
  | { kind: "start"; mode: "hold" | "toggle" }
  | { kind: "stop" }
  | { kind: "switchedToToggle" };

/**
 * Port of DictationShortcutSessionController. Collapses the raw
 * activate/deactivate edges from both bindings into start/stop decisions and
 * handles the hold -> toggle latch when the toggle combo is a superset of the
 * hold combo (e.g. hold = RIGHT ALT, toggle = LEFT CTRL + RIGHT ALT).
 */
class SessionController {
  private activeMode: "hold" | "toggle" | null = null;
  private toggleStopArmed = false;

  handle(event: ShortcutEvent): SessionAction | null {
    if (this.activeMode === null) {
      switch (event) {
        case "toggleActivated":
          this.activeMode = "toggle";
          this.toggleStopArmed = false;
          return { kind: "start", mode: "toggle" };
        case "holdActivated":
          this.activeMode = "hold";
          this.toggleStopArmed = false;
          return { kind: "start", mode: "hold" };
        default:
          return null;
      }
    }

    if (this.activeMode === "hold") {
      switch (event) {
        case "toggleActivated":
          // The superset combo fired while holding: latch into toggle mode so
          // releasing the hold key no longer stops the session.
          this.activeMode = "toggle";
          this.toggleStopArmed = false;
          return { kind: "switchedToToggle" };
        case "holdDeactivated":
          this.reset();
          return { kind: "stop" };
        default:
          return null;
      }
    }

    // activeMode === "toggle"
    switch (event) {
      case "toggleDeactivated":
        // First release of the toggle combo arms the stop; the next press stops.
        this.toggleStopArmed = true;
        return null;
      case "toggleActivated":
        if (!this.toggleStopArmed) {
          return null;
        }
        this.reset();
        return { kind: "stop" };
      default:
        return null;
    }
  }

  reset(): void {
    this.activeMode = null;
    this.toggleStopArmed = false;
  }
}

function specificity(binding: ShortcutBinding): number {
  return binding.keys.length;
}

/**
 * Global hotkey engine built on node-global-key-listener. Tracks the set of
 * currently held keys, evaluates the hold and toggle bindings as chords (a
 * binding is active when every one of its keys is down), and emits "start" /
 * "stop" events for the recording pipeline.
 */
export class HotkeyEngine extends EventEmitter {
  private listener: GlobalKeyboardListener | null = null;
  private readonly keyListener: IGlobalKeyListener;
  private readonly pressed = new Set<string>();
  private readonly session = new SessionController();

  private hold: ShortcutBinding;
  private toggle: ShortcutBinding;
  private holdActive = false;
  private toggleActive = false;
  private busy = false;

  constructor(config: AppConfig) {
    super();
    this.hold = config.holdShortcut;
    this.toggle = config.toggleShortcut;
    this.keyListener = (event) => {
      this.onKeyEvent(event);
      // Never swallow the event: suppressing modifiers like Ctrl or AltGr
      // system-wide would break normal typing in other apps.
      return false;
    };
  }

  async start(): Promise<void> {
    if (this.listener) {
      return;
    }
    this.listener = new GlobalKeyboardListener();
    await this.listener.addListener(this.keyListener);
  }

  stop(): void {
    if (this.listener) {
      this.listener.kill();
      this.listener = null;
    }
    this.pressed.clear();
    this.holdActive = false;
    this.toggleActive = false;
    this.session.reset();
  }

  updateConfig(config: AppConfig): void {
    this.hold = config.holdShortcut;
    this.toggle = config.toggleShortcut;
    this.pressed.clear();
    this.holdActive = false;
    this.toggleActive = false;
    this.session.reset();
  }

  /**
   * When the pipeline is running the hold key may still be released; treat the
   * engine as idle so a stray start/stop during transcription is dropped. The
   * session controller already resets on stop, so this just guards starts.
   */
  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  private onKeyEvent(event: IGlobalKeyEvent): void {
    const name = event.name;
    if (!name) {
      return;
    }

    if (event.state === "DOWN") {
      if (this.pressed.has(name)) {
        // Key-repeat auto-fire: the chord state has not changed, ignore it.
        return;
      }
      this.pressed.add(name);
    } else {
      if (!this.pressed.has(name)) {
        return;
      }
      this.pressed.delete(name);
    }

    this.evaluate();
  }

  private bindingSatisfied(binding: ShortcutBinding): boolean {
    if (binding.keys.length === 0) {
      return false;
    }
    return binding.keys.every((key) => this.pressed.has(key));
  }

  private evaluate(): void {
    const prevHold = this.holdActive;
    const prevToggle = this.toggleActive;
    this.holdActive = this.bindingSatisfied(this.hold);
    this.toggleActive = this.bindingSatisfied(this.toggle);

    for (const event of this.collectEvents(prevHold, prevToggle)) {
      this.dispatch(event);
    }
  }

  private collectEvents(prevHold: boolean, prevToggle: boolean): ShortcutEvent[] {
    const activations: Array<{ event: ShortcutEvent; score: number }> = [];
    const deactivations: Array<{ event: ShortcutEvent; score: number }> = [];

    if (!prevHold && this.holdActive) {
      activations.push({ event: "holdActivated", score: specificity(this.hold) });
    }
    if (!prevToggle && this.toggleActive) {
      activations.push({ event: "toggleActivated", score: specificity(this.toggle) });
    }
    if (prevHold && !this.holdActive) {
      deactivations.push({ event: "holdDeactivated", score: specificity(this.hold) });
    }
    if (prevToggle && !this.toggleActive) {
      deactivations.push({ event: "toggleDeactivated", score: specificity(this.toggle) });
    }

    // More specific activations win first (toggle before hold); less specific
    // deactivations release first (hold before toggle). This keeps the superset
    // latch from stopping the session on the shared key's release.
    activations.sort((a, b) => b.score - a.score);
    deactivations.sort((a, b) => a.score - b.score);

    return [...activations.map((a) => a.event), ...deactivations.map((d) => d.event)];
  }

  private dispatch(event: ShortcutEvent): void {
    const action = this.session.handle(event);
    if (!action) {
      return;
    }
    switch (action.kind) {
      case "start":
        if (this.busy) {
          this.session.reset();
          return;
        }
        this.emit("start", action.mode);
        break;
      case "stop":
        this.emit("stop");
        break;
      case "switchedToToggle":
        this.emit("switchedToToggle");
        break;
    }
  }
}
