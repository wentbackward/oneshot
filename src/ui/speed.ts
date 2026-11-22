// ================================================================
// Simulation speed controls (ui, PRD §4): Pause / 1x / 2x / 4x.
//
// The control owns the SELECTED multiplier and the button
// highlight; the frame loop (src/fishtank-main.ts) is the ONLY
// consumer and multiplies the (already clamped) frame delta by it.
// mult 0 (pause) advances 0 fixed steps per frame — the loop
// still updates its timestamp, so resuming can never burst.
//
// DOM contract matches the toolbar (src/ui/toolbar.ts): static
// page markup with ids (build template), all lookups null-guarded
// so a headless node:vm boot degrades to an inert controller.
// ================================================================

/** The legal multipliers: 0 is Pause. */
export const SPEED_OPTIONS = [0, 1, 2, 4] as const;
export type SpeedOption = (typeof SPEED_OPTIONS)[number];

/** Button id per multiplier (must match the build template's
 *  static markup). */
export const SPEED_BUTTON_IDS: Record<SpeedOption, string> = {
  0: "speed-pause",
  1: "speed-1x",
  2: "speed-2x",
  4: "speed-4x",
};

export class SimSpeedControls {
  /** Active multiplier (1 at boot). */
  private value: SpeedOption = 1;
  private readonly onChange: (mult: SpeedOption) => void;
  private readonly buttons = new Map<SpeedOption, HTMLElement | null>();
  /** Single-wire invariant: a repeat attach is a no-op. */
  private attached = false;

  constructor(onChange: (mult: SpeedOption) => void) {
    this.onChange = onChange;
  }

  get mult(): SpeedOption {
    return this.value;
  }

  /** Wire the static buttons (all lookups null-guarded). */
  attach(doc: Document): this {
    if (this.attached) return this;
    this.attached = true;
    for (const option of SPEED_OPTIONS) {
      const el = doc.getElementById(SPEED_BUTTON_IDS[option]);
      this.buttons.set(option, el);
      if (el !== null) {
        el.addEventListener("click", () => this.select(option));
      }
    }
    this.syncHighlight();
    return this;
  }

  /** Select a speed setting. Illegal values are refused (no-op);
   *  a legal value updates the highlight and notifies the loop. */
  select(option: SpeedOption): void {
    if (!SPEED_OPTIONS.includes(option)) return;
    this.value = option;
    this.syncHighlight();
    this.onChange(option);
  }

  private syncHighlight(): void {
    for (const [option, el] of this.buttons) {
      if (el === null || el.classList === undefined) continue;
      if (option === this.value) el.classList.add("selected");
      else el.classList.remove("selected");
    }
  }
}
