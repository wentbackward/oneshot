// ================================================================
// Tank toolbar (ui, PRD §3): the Place/Remove modes for the
// placement tools — "place rock", "place kelp", "remove". Owns
// the MODE and translates canvas clicks into the pure sim API on
// the World; it owns no tank state itself, so it can be driven
// headless (node:vm) exactly like the real DOM wiring.
//
// DOM contract: the toolbar buttons are STATIC page markup with
// ids tool-place-rock / tool-place-kelp / tool-remove (the build
// template owns them). attach() finds them by id and wires their
// click listeners — every lookup is null-guarded, so a document
// that lacks any of them (the node:vm stubs) yields a fully
// functional headless toolbar instead of a boot crash.
// ================================================================

import { TANK_HEIGHT, TANK_WIDTH, type Rock, type World } from "../sim/world.ts";
import type { KelpStrand } from "../sim/kelp.ts";

/** The three toolbar modes. */
export type ToolMode = "place-rock" | "place-kelp" | "remove";

/** Button id per mode (must match the build template's static
 *  markup). */
export const TOOL_BUTTON_IDS: Record<ToolMode, string> = {
  "place-rock": "tool-place-rock",
  "place-kelp": "tool-place-kelp",
  "remove": "tool-remove",
};

/** Viewport size provider (the canvas's CSS/LAYOUT box in
 *  device-independent px — the space click coordinates arrive in;
 *  NOT the device-px backing store). */
export interface Viewport {
  width: number;
  height: number;
}

export class Toolbar {
  /** Active mode (place-rock is the default at boot). */
  mode: ToolMode = "place-rock";
  private readonly world: World;
  private readonly viewport: () => Viewport;
  private readonly buttons = new Map<ToolMode, HTMLElement | null>();
  private canvasEl: HTMLCanvasElement | null = null;
  /** The toolbar's on-screen rect provider (null in headless
   *  documents): the click-region guard that keeps placements and
   *  removals from hiding behind the toolbar. */
  private toolbarEl: HTMLElement | null = null;
  /** Single-wire invariant: once attached, every listener exists
   *  exactly once (a repeat attach is a no-op, so listeners never
   *  stack). */
  private attached = false;

  constructor(world: World, viewport: () => Viewport) {
    this.world = world;
    this.viewport = viewport;
  }

  /** Wire the static buttons and the canvas click (all
   *  null-guarded — headless documents simply get a headless
   *  toolbar). SINGLE-WIRE INARIANT: each listener is wired
   *  exactly once; a repeat attach() is a no-op, so a second call
   *  can never stack a duplicate canvas-click listener (which
   *  would place a rock twice per click). */
  attach(doc: Document, canvas: HTMLCanvasElement | null): this {
    if (this.attached) return this;
    this.attached = true;
    (Object.keys(TOOL_BUTTON_IDS) as ToolMode[]).forEach((mode) => {
      const el = doc.getElementById(TOOL_BUTTON_IDS[mode]);
      this.buttons.set(mode, el);
      if (!el) return;
      el.addEventListener("click", () => this.setMode(mode));
    });
    if (
      canvas !== null &&
      typeof canvas.addEventListener === "function" &&
      typeof canvas.getBoundingClientRect === "function"
    ) {
      this.canvasEl = canvas;
      this.toolbarEl = doc.getElementById("toolbar");
      canvas.addEventListener("click", (ev: MouseEvent) => {
        // Click-region guard: in place modes the first instinct is
        // the top-left corner — under the toolbar. A click anywhere
        // in the toolbar's on-screen rect is dropped, so nothing is
        // ever placed or removed hidden behind it (the real DOM
        // already swallows clicks on the buttons themselves; the
        // guard covers the gaps between them, the headless path,
        // and any future restyle).
        if (this.clickInsideToolbar(ev.clientX, ev.clientY)) return;
        const rect = canvas.getBoundingClientRect();
        this.handleClientClick(ev.clientX - rect.left, ev.clientY - rect.top);
      });
    }
    this.syncSelection();
    return this;
  }

  /** Switch the active mode and refresh the selected-button
   *  highlight (and the cursor hint on the canvas). */
  setMode(mode: ToolMode): void {
    this.mode = mode;
    this.syncSelection();
  }

  /** A canvas click in the active mode: viewport px → tank units
   *  → the world's pure placement/removal API. Returns the placed
   *  or removed object, or null (out-of-view click, cap reached,
   *  open water). Never throws on odd input. (Clicks under the
   *  toolbar's on-screen rect are dropped BEFORE reaching this —
   *  see the click-region guard in attach().) */
  handleClientClick(px: number, py: number): Rock | KelpStrand | null {
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    const vp = this.viewport();
    if (!(vp.width > 0) || !(vp.height > 0)) return null;
    // The renderer maps tank → canvas by a plain stretch, so the
    // inverse is a plain unstretch.
    const tx = (px / vp.width) * TANK_WIDTH;
    const ty = (py / vp.height) * TANK_HEIGHT;
    switch (this.mode) {
      case "place-rock":
        return this.world.placeRock(tx, ty);
      case "place-kelp":
        return this.world.placeKelp(tx);
      case "remove":
        return this.world.removeNearestAt(tx, ty);
    }
  }

  /** True when (clientX, clientY) falls inside the toolbar's
   *  on-screen rect (null in headless documents → false, so the
   *  guard is inert there). */
  private clickInsideToolbar(clientX: number, clientY: number): boolean {
    const el = this.toolbarEl;
    if (el === null || typeof el.getBoundingClientRect !== "function") {
      return false;
    }
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
    const r = el.getBoundingClientRect();
    return (
      clientX >= r.left && clientX <= r.right &&
      clientY >= r.top && clientY <= r.bottom
    );
  }

  private syncSelection(): void {
    this.buttons.forEach((el, mode) => {
      if (!el || !el.classList) return;
      if (mode === this.mode) el.classList.add("selected");
      else el.classList.remove("selected");
    });
    if (this.canvasEl && this.canvasEl.style) {
      this.canvasEl.style.cursor =
        this.mode === "remove" ? "pointer" : "crosshair";
    }
  }
}
