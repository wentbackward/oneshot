// ================================================================
// Procedural water (render, PRD §3): the aquarium backdrop is a
// PURE function of the lighting palette and the world clock — an
// ambient depth gradient (whose stops ARE the scene ambient, lit
// by the current phase of the lighting cycle) and drifting surface
// ripples. The caustic shafts, bubble column and substrate will
// live in their own modules (composed by the renderer in a
// documented order).
//
// Stateless and allocation-free: an identical palette and world
// time paint an identical frame, which is what makes fixed-step
// physics tests reproducible.
// ================================================================

import type { LightPalette } from "./lighting.ts";

const SURFACE_RIPPLES = 3;
const RIPPLE_AMPLITUDE = 6; // px
const RIPPLE_SPEED = 1.4; // rad/s
const RIPPLE_STEP = 16; // px between path samples
const RIPPLE_COLOR = "230, 250, 255";

/** Paint the ambient water backdrop: a top->bottom gradient whose
 *  two stops are exactly the active palette's (surface, depth) —
 *  the recording tests audit this pair as the scene ambient. */
export function drawBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number, palette: LightPalette): void {
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, palette.surface);
  grad.addColorStop(1, palette.depth);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
}

/** Thin shimmering bands just under the surface, scrolling with
 *  the world clock. */
export function drawSurfaceRipples(ctx: CanvasRenderingContext2D, width: number, t: number): void {
  ctx.lineWidth = 1.5;
  for (let j = 0; j < SURFACE_RIPPLES; j++) {
    const yBase = 14 + j * 9;
    const alpha = 0.25 - j * 0.06;
    ctx.beginPath();
    for (let x = 0; x <= width; x += RIPPLE_STEP) {
      const y = yBase + Math.sin(x * 0.02 + t * RIPPLE_SPEED + j * 1.3) * RIPPLE_AMPLITUDE;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(${RIPPLE_COLOR}, ${alpha.toFixed(3)})`;
    ctx.stroke();
  }
}
