// ================================================================
// Parallax substrate (render, PRD §3 "layered parallax
// substrate/gravel"): two PROCEDURAL bedrock layers painted every
// frame — a far gravel bed and a nearer top-decor band (rocks +
// kelp tufts). Each element's position/size is drawn once from a
// SEEDED stream (src/sim/rng.ts), so identical boots paint
// identical beds.
//
// Parallax: both layers drift sideways with the world clock, the
// NEAR one at SUBSTRATE_NEAR_DRIFT and the far one at
// SUBSTRATE_FAR_DRIFT (slower) — depth from differential motion.
// Each layer's pattern is a seamless tile of width = viewport:
// every element is painted twice (once at x, once at x - tile),
// so the tile-doubled counts are what the draw-recording test
// audits. Tile wrap is invisible: an element leaving one edge is
// the tiled twin of one entering the other.
// ================================================================

import { mulberry32 } from "../sim/rng.ts";

/** Seed for the substrate streams (named like every other
 *  deterministic source in this repo). */
export const SUBSTRATE_SEED = 4091;

/** Gravel stones in the far layer. */
export const SUBSTRATE_GRAVEL_COUNT = 44;

/** Rocks in the near (top decor) layer. */
export const SUBSTRATE_DECOR_ROCKS = 6;

/** Kelp tufts in the near (top decor) layer. */
export const SUBSTRATE_KELP_TUFTS = 4;

/** Far-layer drift, px per SIMULATION second. */
export const SUBSTRATE_FAR_DRIFT = 1.2;

/** Near-layer drift, px per SIMULATION second — faster than the
 *  far layer, which IS the parallax. */
export const SUBSTRATE_NEAR_DRIFT = 3.0;

/** Gravel band height above the floor, fraction of tank height. */
const GRAVEL_BAND = 0.06;

/** Named stone colours (blue-grey far, charcoal near). */
const GRAVEL_FILLS = ["#31506b", "#3c5f7d", "#466a8c", "#2b455c"];
const ROCK_FILL = "#22384c";
const KELP_STROKE = "rgba(38, 104, 74, 0.85)";

/** Rad/s of the kelp idle sway. */
const KELP_SWAY_SPEED = 0.8;

/** Peak lateral sway of a kelp blade's mid-section, px. */
const KELP_SWAY_AMP = 6;

/** Tip multiplier over the mid-section sway — the blade bends
 *  more at its free end. */
const KELP_TIP_AMP = 1.6;

/** How deep a rock rests in the bed: fraction of its ry sunk
 *  below the floor line. */
const ROCK_RY_RATIO = 0.5;

/** Horizontal tile copies for the seamless double: every element
 *  is painted at x and x - tile (multiply the table entry by the
 *  tile width). Module-level on purpose — the per-frame paint must
 *  allocate nothing, so a literal [0, -tile] in the hot loop is
 *  not allowed (it would mint an array per element, per frame). */
const TILE_OFFSETS = [0, -1];

const TAU = 2 * Math.PI;

interface GravelStone {
  /** Position within the tile, fraction of tile width. */
  u: number;
  /** Distance above the floor, fraction of the gravel band. */
  v: number;
  rx: number;
  ry: number;
  fill: string;
}

interface Rock {
  u: number;
  rx: number;
  ry: number;
}

interface KelpTuft {
  u: number;
  /** Blade height, fraction of tank height. */
  h: number;
  /** Phase offset for the idle sway. */
  phase: number;
}

/** The substrate. Constructed once per Renderer; the element
 *  arrays are generated in the constructor and reused forever
 *  (per-frame painting is allocation-free: no new objects, the
 *  loops only write transform state and stroke/fill). */
export class Substrate {
  private readonly gravel: GravelStone[] = [];
  private readonly rocks: Rock[] = [];
  private readonly kelp: KelpTuft[] = [];

  constructor() {
    const rng = mulberry32(SUBSTRATE_SEED);
    for (let i = 0; i < SUBSTRATE_GRAVEL_COUNT; i++) {
      this.gravel.push({
        u: rng(),
        v: rng(),
        rx: 3 + 5 * rng(),
        ry: 2 + 3.5 * rng(),
        fill: GRAVEL_FILLS[Math.floor(rng() * GRAVEL_FILLS.length)]!, // mulberry32 yields [0,1): floor is always in range
      });
    }
    for (let i = 0; i < SUBSTRATE_DECOR_ROCKS; i++) {
      this.rocks.push({ u: rng(), rx: 18 + 24 * rng(), ry: 8 + 12 * rng() });
    }
    for (let i = 0; i < SUBSTRATE_KELP_TUFTS; i++) {
      this.kelp.push({ u: rng(), h: 0.06 + 0.07 * rng(), phase: rng() * TAU });
    }
  }

  /** Paint the FAR gravel layer (drawn first, i.e. behind the
   *  near layer): one save/translate/restore group for the layer
   *  drift, two tiles per element. */
  paintFar(ctx: CanvasRenderingContext2D, width: number, height: number, t: number): void {
    const tile = width;
    const off = (t * SUBSTRATE_FAR_DRIFT) % tile;
    const band = height * GRAVEL_BAND;
    ctx.save();
    ctx.translate(off, 0);
    for (const s of this.gravel) {
      const y = height - band * s.v;
      for (const copy of TILE_OFFSETS) {
        const x = s.u * tile + copy * tile;
        ctx.beginPath();
        ctx.ellipse(x, y, s.rx, s.ry, 0, 0, TAU);
        ctx.fillStyle = s.fill;
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** Paint the NEAR top-decor band (rocks resting on the bed,
   *  kelp tufts idling with a slow sway): one save/translate/
   *  restore group per LAYER (the drift), two tiles per element. */
  paintNear(ctx: CanvasRenderingContext2D, width: number, height: number, t: number): void {
    const tile = width;
    const off = (t * SUBSTRATE_NEAR_DRIFT) % tile;
    ctx.save();
    ctx.translate(off, 0);
    for (const r of this.rocks) {
      const y = height - r.ry * ROCK_RY_RATIO;
      for (const copy of TILE_OFFSETS) {
        const x = r.u * tile + copy * tile;
        ctx.beginPath();
        ctx.ellipse(x, y, r.rx, r.ry, 0, 0, TAU);
        ctx.fillStyle = ROCK_FILL;
        ctx.fill();
      }
    }
    ctx.strokeStyle = KELP_STROKE;
    ctx.lineWidth = 3;
    for (const k of this.kelp) {
      const baseX = k.u * tile;
      const topY = height - height * k.h;
      for (const copy of TILE_OFFSETS) {
        const x = baseX + copy * tile;
        const sway = Math.sin(t * KELP_SWAY_SPEED + k.phase) * KELP_SWAY_AMP;
        ctx.beginPath();
        ctx.moveTo(x, height);
        ctx.quadraticCurveTo(x + sway, (height + topY) / 2, x + sway * KELP_TIP_AMP, topY);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
