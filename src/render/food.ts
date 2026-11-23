// ================================================================
// Dropped food & tap-glass rendering (PRD §3, #121): the pellet
// flakes and the expanding glass shockwave rings, painted from
// the world state alone — a pure observer of the sim, same
// contract as the water and scenery layers. Tank units stretch to
// the canvas exactly like everything else (sx = width/TANK_WIDTH,
// sy = height/TANK_HEIGHT), so food and rings stay glued to the
// fish whatever the viewport.
// ================================================================

import { PELLET_RADIUS, SHOCKWAVE_RING_MAX_RADIUS } from "../sim/constants.ts";
import { TANK_HEIGHT, TANK_WIDTH } from "../sim/world.ts";
import type { Pellet, Shockwave } from "../sim/pellets.ts";

/** Pellet body: a small warm flake against the cold water. */
const PELLET_FILL = "#d9a441";
const PELLET_EDGE = "rgba(90, 60, 20, 0.55)";

/** Ring ink: cool, bright, mostly transparent — light bouncing off
 *  the glass, not a physical object in the water. The alpha is a
 *  pure function of how far the ring has already expanded. */
const RING_RGB = "210, 235, 255";
/** Stroke weight in constant DEVICE px (like the kelp blades):
 *  a thin ripple at any viewport size. */
const RING_WIDTH = 3;

/** Paint every live pellet (Renderer.render calls this after the
 *  tetra spines — food floats over the school so an eaten flake
 *  visibly vanishes). Each pellet is a small shaded ellipse, with
 *  a device-px floor so it never disappears on a large tank→canvas
 *  squash. */
export function drawPellets(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  pellets: readonly Pellet[],
): void {
  if (pellets.length === 0) return;
  const sx = width / TANK_WIDTH;
  const sy = height / TANK_HEIGHT;
  ctx.strokeStyle = PELLET_EDGE;
  ctx.lineWidth = 1;
  for (const p of pellets) {
    const rx = Math.max(1.5, PELLET_RADIUS * sx);
    const ry = Math.max(1.5, PELLET_RADIUS * sy);
    ctx.beginPath();
    ctx.ellipse(p.x * sx, p.y * sy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = PELLET_FILL;
    ctx.fill();
    ctx.stroke();
  }
}

/** Paint every live shockwave ring (Renderer.render calls this
 *  LAST — the ripple rides the GLASS, in front of everything in
 *  the scene). Each ring is a stroke circle at its CURRENT radius,
 *  fading as it expands: alpha 1 at birth, 0 at
 *  SHOCKWAVE_RING_MAX_RADIUS — a pure function of radius, so no
 *  separate age channel to desynchronize from the sim. */
export function drawShockwaves(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  shockwaves: readonly Shockwave[],
): void {
  if (shockwaves.length === 0) return;
  const sx = width / TANK_WIDTH;
  const sy = height / TANK_HEIGHT;
  ctx.lineWidth = RING_WIDTH;
  for (const s of shockwaves) {
    const fade = 1 - s.radius / SHOCKWAVE_RING_MAX_RADIUS;
    if (fade <= 0) continue; // a full ring is invisible by construction
    ctx.beginPath();
    ctx.ellipse(s.x * sx, s.y * sy, s.radius * sx, s.radius * sy, 0, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${RING_RGB}, ${fade.toFixed(3)})`;
    ctx.stroke();
  }
}
