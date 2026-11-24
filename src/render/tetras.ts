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
import type { ApexPredator } from "../sim/predator.ts";
import type { ArtTexture } from "./tinting.ts";

/** Points per spine path (head first): a MULTI-segment articulated
 *  spine, pinned by tests/fishtank-tetra-render.test.mjs. */
export const TETRA_SPINE_SEGMENTS = 7;

/** Body length in tank units (head to tail tip). */
export const TETRA_BODY_LENGTH = 24;

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

/** Palette shift (degrees) for the angelfish, which reuse this
 *  spine renderer (PRD §2 spine reuse, #123): a ~half-wheel offset
 *  keeps the independents visibly distinct from the tetra school.
 *  Exported — the Renderer picks it at the call site. */
export const ANGEL_HUE_OFFSET = 180;

const TAU = 2 * Math.PI;

// ================================================================
// Hybrid body sprites (PRD §2 "the hybrid is the intended design",
// ticket #139): the procedural spine STILL provides the motion —
// tail undulation stays speed/torque-scaled and audited — while a
// single body sprite rides it (ONE swim frame per species is the
// ticket's accepted placeholder baseline; more frames arrive with
// the final art). The placeholder art faces LEFT in its local
// frame (head at the left, tail at the right), so a left-
// travelling fish draws it as-is and a RIGHT-travelling fish
// receives one horizontal mirror (scale(-1, 1)) — the head leads
// the travel direction and the belly stays down either way.
// Direction is a per-frame decision on the current velocity; the
// articulated spine underneath keeps the motion honest.
// ================================================================

/** Canvas length of a body sprite over its spine length: the
 *  sprite slightly OVERSCALES the spine (the art's body is inset
 *  from the sheet edges), so a fish reads bigger, not identical,
 *  once textured. One named knob for every species. */
export const BODY_SPRITE_OVERSCALE = 1.6;

/** The fishtank's fish-body sprite slots
 *  (assets/fishtank/manifest.json): tetra, angelfish and the
 *  apex predator each carry ONE body slot. Typing the head-
 *  fraction table against this union makes a mistyped slot name
 *  a COMPILE ERROR — never a silent fallback onto another
 *  species' geometry. */
export type BodySpriteSlot = "tetra-body" | "angel-body" | "predator-body";

/** The head's x within the sprite sheet, as a fraction of the
 *  sheet width measured from the LEFT (head) edge — placeholder
 *  geometry (the eye dot's position), per slot. The sprite is
 *  anchored so this fraction sits on the spine's head point.
 *  Exhaustive over BodySpriteSlot: no default, no fallback. */
const HEAD_FRACTIONS: Record<BodySpriteSlot, number> = {
  "tetra-body": 0.25,
  "angel-body": 0.15,
  "predator-body": 0.15,
};

/** Paint a body sprite riding a spine head: the sprite's head
 *  fraction lands on (cx, cy) and the rest trails behind along
 *  the travel direction, so the tail sways with the spine's
 *  undulation. Allocation-free: one save/translate/rotate/
 *  [scale]/scale/drawImage/restore per fish, every quantity a
 *  local scalar. */
function drawBodySprite(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  vx: number,
  vy: number,
  minScale: number,
  bodyLength: number,
  tex: ArtTexture,
  headFraction: number,
): void {
  const w = tex.width;
  const h = tex.height;
  if (!(w > 0) || !(h > 0)) return; // degenerate bitmap: the spine carries the fish
  const len = bodyLength * BODY_SPRITE_OVERSCALE * minScale;
  const k = len / w; // uniform scale on both axes, so rotate stays a true rotation
  // The art faces -x; it is mirrored exactly when the swimmer
  // travels right. Derivation: the tail (local +x) must land on
  // -heading — non-mirrored: R(θ)·(1,0) = -h ⇒ θ = atan2(-vy, -vx);
  // mirrored: R(θ)·M·(1,0) = R(θ)·(-1,0) = -h ⇒ θ = atan2(vy, vx).
  const mirrored = vx >= 0;
  const angle = mirrored ? Math.atan2(vy, vx) : Math.atan2(-vy, -vx);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  if (mirrored) ctx.scale(-1, 1);
  ctx.scale(k, k);
  ctx.drawImage(tex, -headFraction * w, -h / 2, w, h);
  ctx.restore();
}

/** Cached body-colour lookup (index-deterministic: no per-frame
 *  string churn in the hot path — the cache only grows). The cache
 *  ARRAY IS OWNED BY THE CALLER (a Renderer instance) so the render
 *  layer carries no module-level state. `hueOffset` shifts the
 *  palette (angels reuse this renderer with a complementary hue,
 *  #123); 0 keeps the historical tetra colours. */
export function tetraColour(cache: string[], index: number, hueOffset = 0): string {
  let c = cache[index];
  if (c === undefined) {
    c = `hsl(${(index * 47 + hueOffset) % 360}, 82%, 66%)`;
    cache[index] = c;
  }
  return c;
}

/** Paint a spine school, mapping tank units to the current canvas
 *  (stretch: the tank aspect is fixed, the canvas is the viewport).
 *  `colours` is the caller's per-fish colour cache (owned by the
 *  Renderer instance), `hueOffset` the palette shift (see
 *  tetraColour), `sprite` the body-sprite slot riding the spine
 *  (empty string keeps the pure-spine frame) and `textures` the
 *  frame's art table (the active lighting phase's, #139). Every
 *  swimmer must carry the spine-fish shape (position, velocity,
 *  tail phase) — the angelfish pool qualifies and is painted by
 *  exactly this function (PRD §2 spine reuse, #123). */
export function drawTetras(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  fish: Tetra[],
  colours: string[],
  hueOffset = 0,
  sprite: BodySpriteSlot | "" = "tetra-body",
  textures: Record<string, ArtTexture> = {},
): void {
  const sx = width / TANK_WIDTH;
  const sy = height / TANK_HEIGHT;
  const bodyTex = sprite === "" ? undefined : textures[sprite];
  // sprite === "" carries no body at all, so its head fraction is
  // never read — 0 keeps the branch exhaustive without pretending
  // a geometry.
  const headFraction = sprite === "" ? 0 : HEAD_FRACTIONS[sprite];
  for (let i = 0; i < fish.length; i++) {
    drawTetra(ctx, fish[i]!, i, sx, sy, colours, hueOffset, bodyTex, headFraction);
  }
}

function drawTetra(
  ctx: CanvasRenderingContext2D,
  t: Tetra,
  index: number,
  sx: number,
  sy: number,
  colours: string[],
  hueOffset: number,
  bodyTex: ArtTexture | undefined,
  headFraction: number,
): void {
  const headX = t.x * sx;
  const headY = t.y * sy;
  const colourForFish = tetraColour(colours, index, hueOffset);
  traceSpine(ctx, t.x, t.y, t.vx, t.vy, t.phase, TETRA_BODY_LENGTH, TETRA_TAIL_AMPLITUDE, sx, sy);
  ctx.strokeStyle = colourForFish;
  ctx.lineWidth = TETRA_STROKE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(headX, headY, TETRA_HEAD_RADIUS, 0, TAU);
  ctx.fillStyle = colourForFish;
  ctx.fill();
  if (bodyTex !== undefined) {
    drawBodySprite(ctx, headX, headY, t.vx, t.vy, Math.min(sx, sy), TETRA_BODY_LENGTH, bodyTex, headFraction);
  }
}

/** Trace (NOT paint) a swimmer's articulated spine path: a
 *  polyline of TETRA_SPINE_SEGMENTS points swept from the head
 *  back along the (negative) heading, with the travelling sine
 *  wave (sin(phase − k·seg)) giving the tail its undulation.
 *  Shared by the school renderer and the predator (the PRD's
 *  spine recipe, parameterised by body length / amplitude). */
function traceSpine(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  vx: number,
  vy: number,
  phase: number,
  bodyLength: number,
  tailAmplitude: number,
  sx: number,
  sy: number,
): void {
  const speed = Math.hypot(vx, vy);
  const hx = speed > 0 ? vx / speed : 1; // unit heading (defensive: sim guarantees speed > 0)
  const hy = speed > 0 ? vy / speed : 0;
  const px = -hy; // unit perpendicular
  const py = hx;
  const headX = x * sx;
  const headY = y * sy;
  const tailSpan = TETRA_SPINE_SEGMENTS - 1;
  ctx.beginPath();
  ctx.moveTo(headX, headY);
  for (let seg = 1; seg < TETRA_SPINE_SEGMENTS; seg++) {
    const k = seg / tailSpan; // 0 (head) … 1 (tail tip)
    const back = bodyLength * k;
    const sway = tailAmplitude * k * Math.sin(phase - seg * TETRA_TAIL_WAVE_NUMBER);
    ctx.lineTo((x - hx * back + px * sway) * sx, (y - hy * back + py * sway) * sy);
  }
}

// ================================================================
// The apex predator (ticket #139 — its FIRST visual: the sim
// always owned it, the render layer never drew it). It rides the
// SAME spine recipe as the school, upscaled to its body size, and
// carries its own body sprite. Its tail phase is RENDER-OWNED —
// the predator's sim state carries no phase (src/sim is untouched
// by the ticket, and the spine-observer contract forbids
// inventing sim state) — so the Renderer advances it by sim-time
// deltas each frame at an omega scaled by the predator's current
// speed (PRD §2 — the same speed-proportional rule the school
// runs through tailFrequency); a paused sim freezes it, like
// every other layer in this module.
// ================================================================

/** Predator body length in tank units (~1.7× the tetra's — the
 *  body sheet is the largest in the set). */
export const PREDATOR_BODY_LENGTH = 40;

/** Predator tail sway amplitude, tank units. */
const PREDATOR_TAIL_AMPLITUDE = 9;

/** Predator spine stroke / head dot, canvas px. */
const PREDATOR_STROKE_WIDTH = 7;
const PREDATOR_HEAD_RADIUS = 6;

/** The predator's spine colour: a slate underlay the body sprite
 *  rides (the sprite leaves the skeleton visible at the flanks —
 *  the same relationship as the tetra/angel). */
const PREDATOR_COLOUR = "#5b6c7e";

/** Paint the predator (a null world owns none — a predator-less
 *  tank paints nothing here). `phase` is the Renderer's
 *  render-owned tail phase (see the section header). */
export function drawPredator(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  pred: ApexPredator | null,
  phase: number,
  textures: Record<string, ArtTexture> = {},
): void {
  if (pred === null) return;
  const sx = width / TANK_WIDTH;
  const sy = height / TANK_HEIGHT;
  traceSpine(ctx, pred.x, pred.y, pred.vx, pred.vy, phase, PREDATOR_BODY_LENGTH, PREDATOR_TAIL_AMPLITUDE, sx, sy);
  ctx.strokeStyle = PREDATOR_COLOUR;
  ctx.lineWidth = PREDATOR_STROKE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  const headX = pred.x * sx;
  const headY = pred.y * sy;
  ctx.beginPath();
  ctx.arc(headX, headY, PREDATOR_HEAD_RADIUS, 0, TAU);
  ctx.fillStyle = PREDATOR_COLOUR;
  ctx.fill();
  const tex = textures["predator-body"];
  if (tex !== undefined) {
    drawBodySprite(ctx, headX, headY, pred.vx, pred.vy, Math.min(sx, sy), PREDATOR_BODY_LENGTH, tex, HEAD_FRACTIONS["predator-body"]);
  }
}
