// ================================================================
// Telemetry HUD (ui, PRD §4): a collapsible panel (ONE toggle)
// showing the live FPS, per-species entity counts and the spatial-
// grid cell utilization (occupied cells ÷ total cells).
//
// The HUD is a VIEW, never a copy: every update() re-derives the
// figures from the live World at that instant, and a collapsed HUD
// keeps tracking its last values cheaply (a write only happens when
// the rendered string changes, so a steady tank costs nothing per
// frame). DOM contract matches the toolbar (src/ui/toolbar.ts):
// static page markup owned by the build template, every lookup
// null-guarded so headless node:vm boots degrade to a no-op HUD.
// ================================================================

import type { World } from "../sim/world.ts";

/** One per-species count row (see SPECIES_ROWS — the single
 *  registration point). */
interface SpeciesRow {
  /** Static element id of the count field (build template). */
  id: string;
  /** Live pool count on the world (must stay allocation-free). */
  count: (world: World) => number;
}

/** The single species registration point: the species the World
 *  currently owns (ticket #126 scope; the angel row joins with
 *  #123). When a new species joins the World it gains ONE row here
 *  (its id must match the build template's static markup). */
const SPECIES_ROWS: readonly SpeciesRow[] = [
  { id: "hud-count-tetra", count: (w) => w.agents.length },
  { id: "hud-count-predator", count: (w) => (w.predator !== null ? 1 : 0) },
];

/** Root container / toggle element ids (build template). The panel
 *  itself is CSS-only (the `collapsed` class on the container hides
 *  it), so no JS handle for it. */
const HUD_ROOT_ID = "hud";
const HUD_TOGGLE_ID = "hud-toggle";
const HUD_FPS_ID = "hud-fps";
const HUD_GRID_ID = "hud-grid";

export class Hud {
  /** Collapsed state (one toggle controls it, PRD §4). Expanded
   *  at boot: the tank boots with the telemetry visible. */
  collapsed = false;
  private attached = false;
  private rootEl: HTMLElement | null = null;
  private toggleEl: HTMLElement | null = null;
  private fpsEl: HTMLElement | null = null;
  private gridEl: HTMLElement | null = null;
  private readonly countEls: (HTMLElement | null)[] = [];
  /** Last rendered strings: skip the DOM write when unchanged. */
  private lastFps = "";
  private lastGrid = "";
  private lastCounts: string[] = [];

  /** Wire the static markup (all lookups null-guarded — a
   *  headless document yields a fully inert HUD, no boot crash). */
  attach(doc: Document): this {
    if (this.attached) return this;
    this.attached = true;
    this.rootEl = doc.getElementById(HUD_ROOT_ID);
    this.toggleEl = doc.getElementById(HUD_TOGGLE_ID);
    this.fpsEl = doc.getElementById(HUD_FPS_ID);
    this.gridEl = doc.getElementById(HUD_GRID_ID);
    this.countEls.length = 0;
    for (const row of SPECIES_ROWS) {
      this.countEls.push(doc.getElementById(row.id));
    }
    if (this.toggleEl !== null) {
      this.toggleEl.addEventListener("click", () => this.toggle());
    }
    return this;
  }

  /** Flip the panel between collapsed and expanded. THE collapse
   *  control (single toggle, PRD §4): the state drives the
   *  `collapsed` class on the container (CSS hides the panel) and
   *  aria-expanded on the toggle button. */
  toggle(): void {
    this.collapsed = !this.collapsed;
    if (this.rootEl !== null && this.rootEl.classList !== undefined) {
      if (this.collapsed) this.rootEl.classList.add("collapsed");
      else this.rootEl.classList.remove("collapsed");
    }
    if (this.toggleEl !== null) {
      this.toggleEl.setAttribute("aria-expanded", String(!this.collapsed));
    }
  }

  /** Refresh every field from the live world (allocation-light:
   *  fixed string shapes, DOM writes only on change). `fps` is
   *  the app's smoothed frame-rate estimate in frames/second
   *  (0 = unknown yet, the first frame has no prior timestamp). */
  update(world: World, fps: number): void {
    if (!this.attached) return;
    if (this.fpsEl !== null) {
      const text = fps > 0 ? String(Math.round(fps)) : "\u2013";
      if (text !== this.lastFps) {
        this.lastFps = text;
        this.fpsEl.textContent = text;
      }
    }
    if (this.gridEl !== null) {
      const text = `${world.grid.countOccupiedCells()}/${world.grid.totalCells}`;
      if (text !== this.lastGrid) {
        this.lastGrid = text;
        this.gridEl.textContent = text;
      }
    }
    for (let i = 0; i < SPECIES_ROWS.length; i++) {
      const el = this.countEls[i]!;
      if (el === null) continue;
      const text = String(SPECIES_ROWS[i]!.count(world));
      if (text !== this.lastCounts[i]) {
        this.lastCounts[i] = text;
        el.textContent = text;
      }
    }
  }
}
