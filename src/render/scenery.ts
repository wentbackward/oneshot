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
import { KELP_SEGMENTS } from "../sim/constants.ts";
import type { KelpStrand } from "../sim/kelp.ts";
import type { ArtTexture } from "./tinting.ts";

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
 *  tank → canvas mapping like everything else. When the kelp-strip
 *  art slot carries a bitmap (ticket #139) the textured quads
 *  REPLACE these strokes; the quads keep the same constant
 *  device-px weight (KELP_QUAD_HALF_WIDTH below). */
const KELP_DARK = "#2c6e46";
const KELP_LIGHT = "#5aa873";
const KELP_WIDTH_DARK = 7; // canvas px (constant, see above)
const KELP_WIDTH_LIGHT = 2.5; // canvas px (constant, see above)

/** Half-blade of a textured kelp quad, canvas px (the procedural
 *  blade's 7 px width halved — the art replaces the stroke, not
 *  the scale). */
export const KELP_QUAD_HALF_WIDTH = 3.5;

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
 *  the water backdrop). When the frame's art table carries the
 *  kelp-strip texture (ticket #139) each strand is painted as
 *  textured quads riding its verlet bones (KELP_SEGMENTS of them
 *  — the physics is untouched); without the asset the strand
 *  falls back to the procedural strokes. */
export function drawKelp(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  strands: readonly KelpStrand[],
  textures: Record<string, ArtTexture> = {},
): void {
  const sx = width / TANK_WIDTH;
  const sy = height / TANK_HEIGHT;
  const strip = textures["kelp-strip"];
  if (strip !== undefined && strip.width > 0 && strip.height > 0) {
    for (const strand of strands) drawKelpQuads(ctx, strand, sx, sy, strip);
    return;
  }
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

/** One strand as KELP_SEGMENTS textured quads: segment i of the
 *  verlet chain gets row i of the strip (source rect) mapped onto
 *  the quad between points i and i+1 — the art RIDES the bones;
 *  nothing here touches the physics. Each quad is one
 *  save/translate/rotate/drawImage/restore with local scalars
 *  only (allocation-free; a collapsed segment paints nothing). */
function drawKelpQuads(
  ctx: CanvasRenderingContext2D,
  strand: KelpStrand,
  sx: number,
  sy: number,
  strip: ArtTexture,
): void {
  const pts = strand.points;
  const srcRow = strip.height / KELP_SEGMENTS; // source strip height per segment
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const ax = a.x * sx;
    const ay = a.y * sy;
    const dx = b.x * sx - ax;
    const dy = b.y * sy - ay;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-3)) continue; // collapsed segment: no quad to paint
    ctx.save();
    ctx.translate(ax + dx / 2, ay + dy / 2);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.drawImage(strip, 0, i * srcRow, strip.width, srcRow, -len / 2, -KELP_QUAD_HALF_WIDTH, len, KELP_QUAD_HALF_WIDTH * 2);
    ctx.restore();
  }
}

/** Paint every placed rock. Without the pebble art (headless
 *  boots, missing asset) a rock is a smooth rounded river stone:
 *  placement is anywhere in the tank (placeRock imposes no
 *  substrate band), so the shading sells an ADRIFT stone — NOT a
 *  pebble sitting on gravel: the radial highlight is light from
 *  above, and the 0.78x vertical squash is a deliberate
 *  stylised foreshortening, not a contact shadow. Collision is
 *  the FULL rock.r circle (a slightly generous read on the
 *  squashed silhouette — deliberate: the fish should skirt the
 *  stone, and physics never disagrees with the drawn body in a
 *  direction the eye can test). With the pebble art (ticket
 *  #139, alternating the two variants by placement order) the
 *  sprite replaces the procedural stone at the collision
 *  circle's FULL WIDTH (2r — the ticket's "render at full r"
 *  option: the pebble now matches the collision body's horizon
 *  instead of the old 0.78x-squashed ellipse), keeping its own
 *  aspect for height — the silhouette thus stays slightly
 *  SHORTER than the circle's 2r top-to-bottom: the fish skirt a
 *  circle a hair more generous than the drawn caps, the same
 *  deliberate generosity as the procedural stone's read. */
export function drawRocks(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  rocks: readonly Rock[],
  textures: Record<string, ArtTexture> = {},
): void {
  const sx = width / TANK_WIDTH;
  const sy = height / TANK_HEIGHT;
  for (let i = 0; i < rocks.length; i += 1) {
    const rock = rocks[i]!;
    const pebble = i % 2 === 0 ? textures["pebble-1"] : textures["pebble-2"];
    if (pebble !== undefined && pebble.width > 0 && pebble.height > 0) {
      const cx = rock.x * sx;
      const cy = rock.y * sy;
      const wpx = rock.r * 2 * sx; // the collision circle's full width
      const hpx = wpx * (pebble.height / pebble.width); // the sprite's own aspect (see doc)
      ctx.drawImage(pebble, cx - wpx / 2, cy - hpx / 2, wpx, hpx);
      continue;
    }
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
