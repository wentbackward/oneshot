// ================================================================
// Habitat decor (ticket #145, design direction in
// docs/HABITAT-BRIEF.md, PRD §3 "Atmospheric Rendering"): three
// procedurally painted elements that make the tank floor read as a
// populated habitat on top of the seeded parallax substrate —
//   1. pulsing anemone/coral clusters (the warm accent),
//   2. swaying grass-tuft clusters (sea green),
//   3. drifting marine-snow motes through the water column.
//
// Contract (pinned by tests/fishtank-habitat.test.mjs):
//   - SEEDED placement: identical constructor seeds give identical
//     layouts, drawn from the repo-wide mulberry32 stream (the
//     same determinism discipline as every other source);
//   - per-element animation is a PURE FUNCTION OF SIM TIME: a
//     paused sim freezes the decor, exactly like the substrate
//     layers and the bubble column;
//   - current-field participation: the tuft tips carry a steady
//     lean proportional to the ambient current (the default
//     argument IS the world's ambient flow) on top of the shared
//     kelp idle-sway — nothing on the floor is static noise;
//   - ZERO PER-FRAME ALLOCATION: the pools are built once in the
//     constructor; painting writes only path/style state, one
//     style write per sub-layer, no arrays minted in the hot loop
//     (COPY_OFFSETS is module-level on purpose).
//
// Painting discipline: NO save/translate/rotate — the tile-doubled
// copies are computed inline (tile width = viewport, every floor
// element painted at x and x - tile, exactly the substrate band's
// seamless wrap), and floor elements share the substrate's
// SUBSTRATE_NEAR_DRIFT parallax. The motes are analytic in t and
// wrap both axes (pooled, stateless — the bubble-column recipe).
// Non-colliding: the sim never sees these elements. Draw order is
// owned by renderer.ts: painted after the placed scenery and
// strictly before the fish layers (everything stays behind the
// school).
// ================================================================

import { mulberry32 } from "../sim/rng.ts";
import { AMBIENT_CURRENT_X } from "../sim/constants.ts";
import { SUBSTRATE_NEAR_DRIFT } from "./substrate.ts";

/** Seed for the habitat streams (named like every other
 *  deterministic source in this repo). */
export const HABITAT_SEED = 4093;

/** Horizontal tile copies for the seamless double (module-level:
 *  a literal in the hot loop would mint an array per frame). */
export const HABITAT_TILE_COPIES = 2;

/** Grass-tuft clusters in the near (planted) band. */
export const HABITAT_TUFT_COUNT = 8;
/** Blades per cluster — a fan, not a stick. */
export const HABITAT_TUFT_BLADES = 3;
/** Cluster height band, fraction of viewport height. */
const TUFT_HEIGHT_MIN = 0.04;
const TUFT_HEIGHT_MAX = 0.09;
/** Blade spread within a cluster, ± px about the cluster base. */
const TUFT_SPREAD_PX = 8;
/** Idle-sway speed, rad of phase per sim second — the substrate
 *  kelp tufts run the SAME frequency: one shared current driver. */
export const HABITAT_TUFT_SWAY_SPEED = 0.8;
/** Peak lateral sway of a blade's mid-section, px. */
const TUFT_SWAY_AMP = 4.5;
/** Tip multiplier over the mid-section sway (free end bends more). */
const TUFT_TIP_AMP = 1.5;
/** Steady tip lean, px, at the default ambient current: the lean
 *  a blade rests at in flowing water, linear in currentX. */
export const HABITAT_TUFT_CURRENT_LEAN = 6;

/** Anemone/coral clusters in the near (planted) band. */
export const HABITAT_ANEMONE_COUNT = 3;
/** Tentacles per cluster. */
export const HABITAT_ANEMONE_TENTACLES = 5;
/** Cluster base radius band, px. */
const ANEMONE_BASE_MIN = 9;
const ANEMONE_BASE_MAX = 15;
/** Tentacle rest-length band, px. */
const ANEMONE_TENTACLE_MIN = 14;
const ANEMONE_TENTACLE_MAX = 24;
/** Fan the tentacles spread across, radians (about straight up). */
const ANEMONE_FAN = 2.0;
/** Pulse speed, rad of phase per sim second (the "breathe"). */
export const HABITAT_ANEMONE_PULSE_SPEED = 0.6;
/** Pulse amplitude as a fraction of tentacle rest length. */
export const HABITAT_ANEMONE_PULSE_AMP = 0.18;
/** Golden-angle phase offset per successive tentacle: the bloom
 *  rolls around the cluster instead of pulsing in a lump. */
const ANEMONE_TENTACLE_PHASE_STEP = Math.PI * (3 - Math.sqrt(5));

/** Marine-snow motes pooled through the water column. */
export const HABITAT_MOTE_COUNT = 48;
/** Mote fall-speed band, px per sim second. */
export const HABITAT_MOTE_FALL_MIN = 3;
export const HABITAT_MOTE_FALL_MAX = 6;
/** Lateral wobble amplitude band, px. */
const MOTE_WOBBLE_MIN = 3;
const MOTE_WOBBLE_MAX = 8;
/** Lateral wobble speed band, rad of phase per sim second. */
const MOTE_OMEGA_MIN = 0.15;
const MOTE_OMEGA_MAX = 0.45;
/** Mote radius band, px. */
const MOTE_SIZE_MIN = 0.8;
const MOTE_SIZE_MAX = 1.8;

// Day-neutral colours (see docs/HABITAT-BRIEF.md): sea green in
// FRONT of the darker placed kelp, the coral-rose accent the cool
// palette lacks, and a pale suspended snow.
const TUFT_STROKE = "rgba(74, 149, 102, 0.75)";
const ANEMONE_BASE_FILL = "#5a3d4e";
const ANEMONE_TENTACLE_STROKE = "rgba(226, 148, 155, 0.7)";
const MOTE_FILL = "rgba(205, 235, 250, 0.22)";
const TUFT_LINE_WIDTH = 2.5; // canvas px, constant like the kelp blades
const ANEMONE_TENTACLE_LINE_WIDTH = 3; // canvas px

const COPY_OFFSETS = [0, -1];
const TAU = 2 * Math.PI;

/** One narrow blade of a tuft cluster (fixed per layout). */
interface TuftBlade {
  /** Offset from the cluster base, px (spread). */
  du: number;
  /** Height factor over the cluster height (0.8–1.15). */
  dh: number;
  /** Phase offset so the cluster shimmers, not tilts. */
  dphase: number;
}

/** A grass-tuft cluster (fixed per layout; motion is f(t)). */
interface Tuft {
  /** Position within the tile, fraction of tile width. */
  u: number;
  /** Cluster height, fraction of viewport height. */
  h: number;
  /** Cluster sway phase. */
  phase: number;
  blades: TuftBlade[];
}

/** An anemone/coral cluster (fixed per layout; pulse is f(t)). */
interface Anemone {
  u: number;
  /** Base (footprint) radius, px. */
  baseR: number;
  /** Tentacle rest length, px. */
  tentLen: number;
  /** Pulse phase. */
  phase: number;
}

/** A pooled marine-snow mote (position is analytic in t). */
interface Mote {
  /** Lane + start position within the column, fractions. */
  x0: number;
  y0: number;
  /** Fall speed, px per sim second (inside the named band). */
  fall: number;
  /** Lateral wobble amplitude, px (inside the named band). */
  wobble: number;
  /** Lateral wobble speed, rad per sim second. */
  omega: number;
  /** Lateral wobble phase. */
  phase: number;
  /** Radius, px. */
  size: number;
}

const lerp = (a: number, b: number, r: number): number => a + (b - a) * r;

/** The habitat. Constructed once per Renderer; the pools are
 *  generated from the seed and reused forever (per-frame painting
 *  allocates nothing). */
export class Habitat {
  private readonly tufts: Tuft[];
  private readonly anemones: Anemone[];
  private readonly motes: Mote[];

  constructor(seed: number = HABITAT_SEED) {
    const rng = mulberry32(seed >>> 0);
    const tufts: Tuft[] = [];
    for (let i = 0; i < HABITAT_TUFT_COUNT; i++) {
      const blades: TuftBlade[] = [];
      for (let b = 0; b < HABITAT_TUFT_BLADES; b++) {
        blades.push({
          du: (rng() * 2 - 1) * TUFT_SPREAD_PX,
          dh: 0.8 + 0.35 * rng(),
          dphase: rng() * TAU,
        });
      }
      tufts.push({ u: rng(), h: lerp(TUFT_HEIGHT_MIN, TUFT_HEIGHT_MAX, rng()), phase: rng() * TAU, blades });
    }
    const anemones: Anemone[] = [];
    for (let i = 0; i < HABITAT_ANEMONE_COUNT; i++) {
      anemones.push({
        u: rng(),
        baseR: lerp(ANEMONE_BASE_MIN, ANEMONE_BASE_MAX, rng()),
        tentLen: lerp(ANEMONE_TENTACLE_MIN, ANEMONE_TENTACLE_MAX, rng()),
        phase: rng() * TAU,
      });
    }
    const motes: Mote[] = [];
    for (let i = 0; i < HABITAT_MOTE_COUNT; i++) {
      motes.push({
        x0: rng(),
        y0: rng(),
        fall: lerp(HABITAT_MOTE_FALL_MIN, HABITAT_MOTE_FALL_MAX, rng()),
        wobble: lerp(MOTE_WOBBLE_MIN, MOTE_WOBBLE_MAX, rng()),
        omega: lerp(MOTE_OMEGA_MIN, MOTE_OMEGA_MAX, rng()),
        phase: rng() * TAU,
        size: lerp(MOTE_SIZE_MIN, MOTE_SIZE_MAX, rng()),
      });
    }
    this.tufts = tufts;
    this.anemones = anemones;
    this.motes = motes;
  }

  /** The seeded element data (plain values): exposed for the
   *  placement-determinism audits, never mutated by painting. */
  get layout(): { tufts: Tuft[]; anemones: Anemone[]; motes: Mote[] } {
    return { tufts: this.tufts, anemones: this.anemones, motes: this.motes };
  }

  /** Paint the habitat decor into the frame at sim time `t`.
   *  `currentX` defaults to the world's ambient flow; pass 0 for
   *  still water. Sub-layer order: anemones (deepest, on the
   *  bed), then tufts, then the marine snow (front of the decor
   *  set — still strictly behind the fish, owned by the
   *  renderer's draw order). */
  paint(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    t: number,
    currentX: number = AMBIENT_CURRENT_X,
  ): void {
    const tile = width;
    const off = (t * SUBSTRATE_NEAR_DRIFT) % tile; // shared near-band parallax

    // --- anemone/coral clusters: footprint + pulsing tentacles ---
    ctx.lineCap = "round";
    ctx.fillStyle = ANEMONE_BASE_FILL;
    for (const a of this.anemones) {
      for (const copy of COPY_OFFSETS) {
        const bx = a.u * tile + off + copy * tile;
        ctx.beginPath();
        ctx.ellipse(bx, height, a.baseR, a.baseR * 0.35, 0, 0, TAU);
        ctx.fill();
      }
      ctx.strokeStyle = ANEMONE_TENTACLE_STROKE;
      ctx.lineWidth = ANEMONE_TENTACLE_LINE_WIDTH;
      for (const copy of COPY_OFFSETS) {
        const bx = a.u * tile + off + copy * tile;
        for (let i = 0; i < HABITAT_ANEMONE_TENTACLES; i++) {
          // Fan about straight up; the pulse stretches each
          // tentacle from its base centre, staggered golden-
          // angle phase per tentacle (the rolling bloom).
          const angle = -Math.PI / 2 + ANEMONE_FAN * (i / (HABITAT_ANEMONE_TENTACLES - 1) - 0.5);
          const pulse = 1 + HABITAT_ANEMONE_PULSE_AMP * Math.sin(
            t * HABITAT_ANEMONE_PULSE_SPEED + a.phase + i * ANEMONE_TENTACLE_PHASE_STEP);
          const len = a.tentLen * pulse;
          const dx = Math.cos(angle);
          const dy = Math.sin(angle);
          const side = i % 2 === 0 ? 1 : -1;
          const bow = len * 0.18 * side; // slight alternating curvature
          ctx.beginPath();
          ctx.moveTo(bx, height);
          ctx.quadraticCurveTo(
            bx + dx * len * 0.55 + Math.cos(angle + Math.PI / 2) * bow,
            height + dy * len * 0.55 + Math.sin(angle + Math.PI / 2) * bow,
            bx + dx * len,
            height + dy * len,
          );
          ctx.stroke();
        }
      }
    }

    // --- grass-tuft clusters: sway (shared kelp frequency) ---
    //   plus a steady lean LINEAR in the ambient current.
    ctx.strokeStyle = TUFT_STROKE;
    ctx.lineWidth = TUFT_LINE_WIDTH;
    const lean = HABITAT_TUFT_CURRENT_LEAN * (currentX / AMBIENT_CURRENT_X);
    for (const tf of this.tufts) {
      for (const copy of COPY_OFFSETS) {
        const baseX = tf.u * tile + off + copy * tile;
        for (const b of tf.blades) {
          const bx = baseX + b.du;
          const sway = Math.sin(t * HABITAT_TUFT_SWAY_SPEED + tf.phase + b.dphase) * TUFT_SWAY_AMP;
          const topY = height - tf.h * height * b.dh;
          ctx.beginPath();
          ctx.moveTo(bx, height);
          ctx.quadraticCurveTo(
            bx + sway * 0.6,
            height - (height - topY) * 0.55,
            bx + sway * TUFT_TIP_AMP + lean, // tip: free-end bend + current lean
            topY,
          );
          ctx.stroke();
        }
      }
    }

    // --- marine-snow motes: analytic fall + sinusoidal wobble, ---
    // both axes wrapping (pooled, stateless — the bubble recipe).
    ctx.fillStyle = MOTE_FILL;
    for (const m of this.motes) {
      const y = (((m.y0 * height + m.fall * t) % height) + height) % height;
      const x = (((m.x0 * width + Math.sin(t * m.omega + m.phase) * m.wobble) % width) + width) % width;
      ctx.beginPath();
      ctx.arc(x, y, m.size, 0, TAU);
      ctx.fill();
    }
  }
}
