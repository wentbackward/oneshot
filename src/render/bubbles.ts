// ================================================================
// Bubble column (render, PRD §3 "rising bubble emitters with
// sinusoidal wobble"): a POOL of BUBBLE_POOL_SIZE preallocated
// slots — allocated ONCE at construction, never again. Every frame
// the pool computes each slot's arc position from the world clock
// (a pure function: same t repaints identically) and strokes the
// arc, in fixed slot order, so a bubble "emits" at the bottom,
// rises with a sinusoidal x-wobble, exits at the top and is
// recycled at the bottom: zero allocation, zero spawning, ever.
//
// The wobble runs BUBBLE_RISE_PERIODS full cycles per FULL RISE
// (its frequency scales with the bubble's rise speed), so EVERY
// bubble completes >= 1 wobble period per ascent at ANY viewport
// size — the guarantee the draw-recording test audits from the
// recorded positions.
//
// When the frame's art table carries the bubble sprite (ticket
// #139) each slot is painted as a SPRITE instead of a stroked arc
// — same position math, same pool, same identity: the slot's
// center anchors a drawImage sized 2·radius across, with the
// sprite's own aspect for height. The FULL slot frame is drawn
// (no placeholder-specific source cropping), so a data-only
// final-art swap per the sourcing runbook stays renderer-blind.
// Without the asset the arcs are the fallback: headless boots see
// exactly the pre-#139 frame.
// ================================================================

import type { ArtTexture } from "./tinting.ts";

/** Pool size: how many bubbles the emitter releases, always. */
export const BUBBLE_POOL_SIZE = 24;

/** Maximum lateral wobble (px) around a bubble's lane center. */
export const BUBBLE_WOBBLE_AMP = 8;

/** Full wobble cycles per full rise (bottom to top) — pinned at
 *  three so the AC's ">= 1 full period per rise" holds at any
 *  viewport, and fast risers visibly chatter more. */
export const BUBBLE_RISE_PERIODS = 3;

/** How far (px) above the top / below the bottom a bubble travels
 *  before recycling. Exported so the draw-recording test derives its
 *  pinned column height from the same named constant. */
export const BUBBLE_MARGIN = 12;

/** Rise-speed band, px/s (per slot, seeded). */
const BUBBLE_RISE_MIN = 40;
const BUBBLE_RISE_MAX = 100;

/** Bubble radius band, px (per slot, seeded). */
const BUBBLE_RADIUS_MIN = 1.5;
const BUBBLE_RADIUS_MAX = 5.0;

const BUBBLE_STROKE = "rgba(230, 250, 255, 0.35)";
const TAU = 2 * Math.PI;

/** Deterministic pseudo-random in [0,1) for one slot's lane, size,
 *  speed, stagger and wobble phase — same index, same bubble,
 *  every boot. */
function hash(unit: number, salt: number): number {
  const v = Math.sin(unit * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/** One pooled bubble: its SEEDED per-slot parameters, fixed for the
 *  life of the tank. The arc position at time t is a pure function
 *  of these fields (the painter computes it as local values, so
 *  painting allocates nothing). */
interface BubbleSlot {
  /** Lane center, fraction of tank width. */
  lane: number;
  radius: number;
  /** Rise speed, px/s. */
  speed: number;
  /** Stagger along the column at t = 0, fraction of the column. */
  offset: number;
  /** Initial wobble phase (rad). */
  phase0: number;
}

/** The pool. Construct once per Renderer (no module-level state). */
export class BubbleColumn {
  private readonly slots: BubbleSlot[] = [];

  constructor() {
    for (let i = 0; i < BUBBLE_POOL_SIZE; i++) {
      this.slots.push({
        lane: 0.04 + 0.92 * hash(i, 1),
        radius: BUBBLE_RADIUS_MIN + (BUBBLE_RADIUS_MAX - BUBBLE_RADIUS_MIN) * hash(i, 3),
        speed: BUBBLE_RISE_MIN + (BUBBLE_RISE_MAX - BUBBLE_RISE_MIN) * hash(i, 2),
        offset: hash(i, 4),
        phase0: hash(i, 5) * TAU,
      });
    }
  }

  /** Release (paint) the whole pool at world time t: every slot,
   *  in fixed slot order — the draw-recording test tracks slot i
   *  as the i-th bubble draw of each frame. Allocation-free: the
   *  loop only reads preallocated fields; `textures` is the frame's
   *  art table (the sprite slot, ticket #139). */
  paint(ctx: CanvasRenderingContext2D, width: number, height: number, t: number, textures: Record<string, ArtTexture> = {}): void {
    const column = height + BUBBLE_MARGIN * 2;
    const sprite = textures["bubble"];
    if (sprite !== undefined && sprite.width > 0 && sprite.height > 0) {
      const aspect = sprite.height / sprite.width;
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i]!;
        // One full rise (bottom margin to top margin) takes
        // column / speed seconds; the wobble completes
        // BUBBLE_RISE_PERIODS cycles over exactly that span.
        const rise = column / s.speed;
        const x = s.lane * width + Math.sin((t / rise) * TAU * BUBBLE_RISE_PERIODS + s.phase0) * BUBBLE_WOBBLE_AMP;
        const y = height + BUBBLE_MARGIN - ((t * s.speed + s.offset * column) % column);
        const rw = s.radius * 2; // the slot's diameter stays its identity
        ctx.drawImage(sprite, x - rw / 2, y - (rw * aspect) / 2, rw, rw * aspect);
      }
      return;
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = BUBBLE_STROKE;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      // One full rise (bottom margin to top margin) takes
      // column / speed seconds; the wobble completes
      // BUBBLE_RISE_PERIODS cycles over exactly that span.
      const rise = column / s.speed;
      const x = s.lane * width + Math.sin((t / rise) * TAU * BUBBLE_RISE_PERIODS + s.phase0) * BUBBLE_WOBBLE_AMP;
      const y = height + BUBBLE_MARGIN - ((t * s.speed + s.offset * column) % column);
      ctx.beginPath();
      ctx.arc(x, y, s.radius, 0, TAU);
      ctx.stroke();
    }
  }
}
