// ================================================================
// Caustic light shafts (render, PRD §3 "Atmospheric Rendering"):
// five soft volumetric shafts raking down from the surface, each
// a TOP-DOWN LINEAR GRADIENT (bright at the waterline, gone by the
// floor) tinted by the active lighting palette.
//
// Each shaft owns a horizontal SWEEP PHASE: a sawtooth offset that
// advances CAUSTIC_SWEEP_SPEED px per SIMULATION second and wraps
// every CAUSTIC_SWEEP_SPAN px. The phase is applied as the shaft's
// translate, so it is a plain linear function of world time (the
// draw-recording test measures its exact per-step increment from
// the recorded translates), and a paused sim freezes it. Shafts
// are staggered across the width so the sweep reads as drifting
// light, not marching.
//
// The sawtooth's lateral reset is MASKED, not faked away: over
// CAUSTIC_WRAP_FADE of the span on each side of the wrap the
// shaft's alpha fades smoothly to zero, so the 120 px pop happens
// while the shaft is invisible — light drifting off the tank, not
// snapping (see docs/DECISIONS.md, ticket #125). The fade only
// multiplies the alpha: the recorded translates still ARE the
// phase.
//
// Stateless per frame: identical (t, palette) repaints identically.
// ================================================================

import type { LightPalette } from "./lighting.ts";

/** Number of caustic shafts painted per frame. */
export const CAUSTIC_SHAFTS = 5;

/** How fast the shaft sweep phase advances, px per SIMULATION second. */
export const CAUSTIC_SWEEP_SPEED = 6;

/** How far a shaft travels before the sweep phase wraps, px. */
export const CAUSTIC_SWEEP_SPAN = 120;

/** Fraction of the sweep span, on each side of the wrap, over
 *  which a shaft's alpha fades smoothly to zero — masks the
 *  sawtooth's lateral reset (pinned by the "sweep wrap is masked"
 *  check in tests/fishtank-atmosphere.test.mjs). */
export const CAUSTIC_WRAP_FADE = 0.25;

/** Rad/s of the per-shaft alpha pulse (the breathing of the light). */
const CAUSTIC_PULSE_SPEED = 1.5;

/** Half-width of a shaft at the surface, fraction of tank width. */
const CAUSTIC_TOP_HALF_WIDTH = 0.03;

/** Half-width at the floor: light spreads as it penetrates. */
const CAUSTIC_BOTTOM_HALF_WIDTH = 0.09;

/** Bottom shear, fraction of tank width — the shafts lean slightly
 *  with depth so they read as raking rays, not pillars. */
const CAUSTIC_LEAN = 0.1;

/** Paint the caustic shafts for world time t under the given
 *  palette. One save/translate/restore group per shaft. */
export function drawCausticShafts(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  t: number,
  palette: LightPalette,
): void {
  const top = width * CAUSTIC_TOP_HALF_WIDTH;
  const bot = width * CAUSTIC_BOTTOM_HALF_WIDTH;
  const lean = width * CAUSTIC_LEAN;
  for (let i = 0; i < CAUSTIC_SHAFTS; i++) {
    const phase =
      (t * CAUSTIC_SWEEP_SPEED + (i * CAUSTIC_SWEEP_SPAN) / CAUSTIC_SHAFTS) % CAUSTIC_SWEEP_SPAN;
    const sway = phase - CAUSTIC_SWEEP_SPAN / 2;
    // Sweep-wrap mask (smoothstep): the alpha falls to zero as the
    // shaft nears its sawtooth reset and recovers over the same
    // span on the other side, so the lateral pop happens while
    // invisible. It only multiplies the alpha — never the phase.
    const distToWrap =
      Math.min(phase, CAUSTIC_SWEEP_SPAN - phase) / (CAUSTIC_SWEEP_SPAN * CAUSTIC_WRAP_FADE);
    const wrapFade =
      distToWrap >= 1 ? 1 : distToWrap <= 0 ? 0 : distToWrap * distToWrap * (3 - 2 * distToWrap);
    const alpha =
      wrapFade *
      (palette.causticBaseAlpha + palette.causticPulseAlpha * Math.sin(t * CAUSTIC_PULSE_SPEED + i * 2.6));
    // Translate FIRST, then build the gradient: the draw-recording
    // test locates each shaft's phase as the translate sitting
    // immediately before that shaft's gradient.
    ctx.save();
    ctx.translate(width * ((i + 0.5) / CAUSTIC_SHAFTS) + sway, 0);
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, `rgba(${palette.causticRgb}, ${alpha.toFixed(4)})`);
    grad.addColorStop(1, `rgba(${palette.causticRgb}, 0)`);
    ctx.beginPath();
    ctx.moveTo(-top, 0);
    ctx.lineTo(top, 0);
    ctx.lineTo(lean + bot, height);
    ctx.lineTo(lean - bot, height);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
  }
}
