// ================================================================
// Tetra spine rendering (PRD §2: procedural spine/fin animation):
// each tetra is painted as a multi-segment articulated spine — a
// polyline of TETRA_SPINE_SEGMENTS points swept from the head back
// along the (negative) heading, with a travelling sine wave
// (sin(phase − k·seg)) giving the tail its undulation. The phase
// is SIM-OWNED (advanced each fixed step at tailFrequency(speed,
// torque)), so the renderer stays a pure observer: an identical
// world state paints an identical spine.
// ================================================================

import type { Tetra } from "../sim/world.ts";
import { TANK_HEIGHT, TANK_WIDTH } from "../sim/world.ts";

/** Points per spine path (head first): a MULTI-segment articulated
 *  spine, pinned by tests/fishtank-tetra-render.test.mjs. */
export const TETRA_SPINE_SEGMENTS = 7;

/** Body length in tank units (head to tail tip). */
const TETRA_BODY_LENGTH = 24;

/** Tail sway amplitude in tank units, scaled by the head→tail
 *  fraction so the head is rigid and the tip beats widest. */
const TETRA_TAIL_AMPLITUDE = 5;

/** Wave number in radians of phase offset per spine segment: one
 *  full ripple per tail at ~7 segments. */
const TETRA_TAIL_WAVE_NUMBER = 0.9;

/** Stroke width in canvas px. */
const TETRA_STROKE_WIDTH = 4;

/** Head dot radius in canvas px. */
const TETRA_HEAD_RADIUS = 3.5;

const TAU = 2 * Math.PI;

/** Cached body-colour lookup (index-deterministic: no per-frame
 *  string churn in the hot path — the cache only grows). The cache
 *  ARRAY IS OWNED BY THE CALLER (a Renderer instance) so the render
 *  layer carries no module-level state. */
export function tetraColour(cache: string[], index: number): string {
  let c = cache[index];
  if (c === undefined) {
    c = `hsl(${(index * 47) % 360}, 82%, 66%)`;
    cache[index] = c;
  }
  return c;
}

/** Paint every tetra of the school, mapping tank units to the
 *  current canvas (stretch: the tank aspect is fixed, the canvas
 *  is the viewport). `colours` is the caller's per-fish colour
 *  cache (owned by the Renderer instance). */
export function drawTetras(ctx: CanvasRenderingContext2D, width: number, height: number, tetras: Tetra[], colours: string[]): void {
  const sx = width / TANK_WIDTH;
  const sy = height / TANK_HEIGHT;
  for (let i = 0; i < tetras.length; i++) {
    drawTetra(ctx, tetras[i]!, i, sx, sy, colours);
  }
}

function drawTetra(ctx: CanvasRenderingContext2D, t: Tetra, index: number, sx: number, sy: number, colours: string[]): void {
  const speed = Math.hypot(t.vx, t.vy);
  const hx = speed > 0 ? t.vx / speed : 1; // unit heading (defensive: sim guarantees speed > 0)
  const hy = speed > 0 ? t.vy / speed : 0;
  const px = -hy; // unit perpendicular
  const py = hx;
  const headX = t.x * sx;
  const headY = t.y * sy;
  const colourForFish = tetraColour(colours, index);
  const tailSpan = TETRA_SPINE_SEGMENTS - 1;
  ctx.beginPath();
  ctx.moveTo(headX, headY);
  for (let seg = 1; seg < TETRA_SPINE_SEGMENTS; seg++) {
    const k = seg / tailSpan; // 0 (head) … 1 (tail tip)
    const back = TETRA_BODY_LENGTH * k;
    const sway = TETRA_TAIL_AMPLITUDE * k * Math.sin(t.phase - seg * TETRA_TAIL_WAVE_NUMBER);
    ctx.lineTo((t.x - hx * back + px * sway) * sx, (t.y - hy * back + py * sway) * sy);
  }
  ctx.strokeStyle = colourForFish;
  ctx.lineWidth = TETRA_STROKE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(headX, headY, TETRA_HEAD_RADIUS, 0, TAU);
  ctx.fillStyle = colourForFish;
  ctx.fill();
}
