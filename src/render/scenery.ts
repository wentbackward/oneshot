// ================================================================
// Placed-scenery rendering (PRD §3): the smooth river rocks and
// the kelp strands, painted from the world state alone — a pure
// observer of the sim, same contract as the water and tetra
// layers. Tank units are stretched to the canvas exactly like
// drawTetras/drawWater (sx = width/TANK_WIDTH, sy = height/
// TANK_HEIGHT), so scenery stays glued to the fish whatever the
// viewport.
// ================================================================

import { TANK_HEIGHT, TANK_WIDTH, type Rock } from "../sim/world.ts";
import type { KelpStrand } from "../sim/kelp.ts";

const TAU = 2 * Math.PI;

/** Rock body fill, light → dark (a smooth, wet pebble). */
const ROCK_LIGHT = "#93a0ad";
const ROCK_DARK = "#49545f";
/** Specular sheen on the upper face. */
const ROCK_SHEEN = "rgba(235, 244, 252, 0.18)";

/** Kelp body: one broad dark stroke (the blade) plus one narrow
 *  light stroke (the midrib), so a strand reads as a leaf, not a
 *  stick. BLADE THICKNESS IS CONSTANT DEVICE PX BY DESIGN — the
 *  kelp keeps a constant on-screen weight at any viewport/zoom,
 *  deliberately unlike the rocks, whose bodies stretch with the
 *  tank → canvas mapping like everything else. */
const KELP_DARK = "#2c6e46";
const KELP_LIGHT = "#5aa873";
const KELP_WIDTH_DARK = 7; // canvas px (constant, see above)
const KELP_WIDTH_LIGHT = 2.5; // canvas px (constant, see above)

/** Walk a strand's points as a smoothed polyline (quadratic
 *  curves through segment midpoints) — shared by the blade and
 *  the midrib strokes. */
function traceStrand(
  ctx: CanvasRenderingContext2D,
  strand: KelpStrand,
  sx: number,
  sy: number,
): void {
  const pts = strand.points;
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x * sx, pts[0]!.y * sy);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = ((pts[i]!.x + pts[i + 1]!.x) / 2) * sx;
    const my = ((pts[i]!.y + pts[i + 1]!.y) / 2) * sy;
    ctx.quadraticCurveTo(pts[i]!.x * sx, pts[i]!.y * sy, mx, my);
  }
  const tip = pts[pts.length - 1]!;
  ctx.lineTo(tip.x * sx, tip.y * sy);
}

/** Paint every kelp strand (Renderer.render calls this ahead of
 *  the rocks and the fish — the fixed back-to-front z-order: the
 *  kelp sits at the BACK of the scene, in front of nothing but
 *  the water backdrop). */
export function drawKelp(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  strands: readonly KelpStrand[],
): void {
  const sx = width / TANK_WIDTH;
  const sy = height / TANK_HEIGHT;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const strand of strands) {
    traceStrand(ctx, strand, sx, sy);
    ctx.strokeStyle = KELP_DARK;
    ctx.lineWidth = KELP_WIDTH_DARK;
    ctx.stroke();
    traceStrand(ctx, strand, sx, sy);
    ctx.strokeStyle = KELP_LIGHT;
    ctx.lineWidth = KELP_WIDTH_LIGHT;
    ctx.stroke();
  }
}

/** Paint every placed rock: a smooth rounded river stone. Placement
 *  is anywhere in the tank (placeRock imposes no substrate band), so
 *  the shading sells an ADRIFT stone — NOT a pebble sitting on
 *  gravel: the radial highlight is light from above, and the 0.78x
 *  vertical squash is a deliberate stylised foreshortening, not a
 *  contact shadow. Collision is the FULL rock.r circle (a slightly
 *  generous read on the squashed silhouette — deliberate: the fish
 *  should skirt the stone, and physics never disagrees with the
 *  drawn body in a direction the eye can test). */
export function drawRocks(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  rocks: readonly Rock[],
): void {
  const sx = width / TANK_WIDTH;
  const sy = height / TANK_HEIGHT;
  for (const rock of rocks) {
    const cx = rock.x * sx;
    const cy = rock.y * sy;
    const rx = rock.r * sx;
    const ry = rock.r * sy * 0.78;
    const grad = ctx.createRadialGradient(
      cx - rx * 0.35,
      cy - ry * 0.45,
      Math.max(1, rx * 0.15),
      cx,
      cy,
      Math.max(rx, ry),
    );
    grad.addColorStop(0, ROCK_LIGHT);
    grad.addColorStop(1, ROCK_DARK);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx - rx * 0.2, cy - ry * 0.35, rx * 0.4, ry * 0.22, 0, 0, TAU);
    ctx.fillStyle = ROCK_SHEEN;
    ctx.fill();
  }
}
