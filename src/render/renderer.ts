// ================================================================
// Frame renderer (PRD §1: render isolated from sim): observes the
// World and paints it into the canvas.
//
// DRAW ORDER (the draw-recording tests parse per-frame event logs
// against it — keep any change deliberate):
//   1  ambient water backdrop (current lighting phase, §3)
//      + full-frame background TEXTURE overlay (embedded asset,
//      ticket #137 — no-op until the boot decoded one)
//   2  substrate far layer  (gravel, save/translate/restore)
//   3  substrate near layer (top decor, save/translate/restore)
//      + seamless gravel TEXTURE band (embedded asset, #137)
//   4  caustic light shafts (five save/translate/restore groups)
//   5  caustics-TILE grid — the seamless 128 px tile (manifest
//      geometry) repeating in a fixed grid that scrolls with
//      sim time (ticket #139 — the water's animated light texture)
//   6  surface ripples
//   7  kelp strands (placed, PRD §3 — roots rest on the gravel;
//      textured quads riding the verlet bones when the strip art
//      is decoded, ticket #139)
//   8  rocks (placed, PRD §3 — behind the school; pebble sprites
//      at the collision circle's full width when decoded, #139)
//   9  angelfish spines (PRD §2 — behind the school, the large
//      slow independents drawn by the SAME tetra spine renderer
//      with a complementary palette, #123) + their body SPRITES
//      riding the spines (the hybrid, #139)
//   10 tetra spines (PRD §2) + their body sprites (#139)
//   11 the predator (ticket #139 — its first visual): the same
//       articulated-spine recipe upscaled to its body, its body
//       sprite riding the spine, tail phase render-owned
//   12 dropped pellets (PRD §3 — food floats over the school)
//   13 bubble column (pool, painted in slot order; bubble SPRITES
//       when decoded, arcs as the fallback, #139)
//   14 shockwave rings (PRD §3 tap-glass — on the GLASS, in front
//       of everything, incl. the bubbles)
// Layers 12/14 draw nothing while the world carries no food/rings,
// and the texture passes 1/3/5 and the sprite halves of 7/8/9/
// 10/11/13 no-op without their decoded assets, so a headless
// boot's frame is byte-identical to the pre-#137 procedural one.
//
// THREE-PHASE TINTING (#139): the Day/Dusk/Night cycle tints the
// art at runtime — the ticket's default policy (one neutral-
// palette asset set, tinted): every decoded bitmap gets phase-
// baked copies at boot (src/render/tinting.ts), and each frame
// selects the ACTIVE PHASE'S table for every art slot. Day is
// the identity pass-through (the neutral table itself).
// ================================================================

import type { World } from "../sim/world.ts";
import { drawKelp, drawRocks } from "./scenery.ts";
import { ANGEL_HUE_OFFSET, drawPredator, drawTetras } from "./tetras.ts";
import { drawBackdrop, drawSurfaceRipples } from "./water.ts";
import { lightPhaseAt } from "./lighting.ts";
import { drawCausticShafts, CAUSTICS_TILE_ALPHA, CAUSTICS_TILE_CELL, CAUSTICS_TILE_DRIFT } from "./caustics.ts";
import { BubbleColumn } from "./bubbles.ts";
import { Substrate } from "./substrate.ts";
import { drawPellets, drawShockwaves } from "./food.ts";
import { bakeTintVariant, defaultSurfaceFactory, PHASE_TINTS, type ArtTexture } from "./tinting.ts";

// Embedded-texture overlay strengths (ticket #137): the textures
// sit OVER the procedural paint, which stays the scene's light —
// the alpha blend keeps the Day/Dusk/Night cycle visibly driving
// the frame while placeholder/final art rides on top.
const BACKGROUND_TEXTURE_ALPHA = 0.35;

/** Gravel band height above the floor, fraction of tank height
 *  (mirrors substrate.ts's GRAVEL_BAND 0.06 so the texture sits
 *  inside the gravel the procedural stones decorate). Exported —
 *  the render-contract tests derive the band's draw count from it. */
export const GRAVEL_TEXTURE_BAND = 0.055;
const GRAVEL_TEXTURE_ALPHA = 0.3;

/** Render-owned tail phase for the predator's spine, rad of
 *  phase per sim second: the predator's sim state carries no
 *  phase (src/sim is untouched by #139), so the spine's
 *  undulation is advanced in the Renderer by sim-time deltas —
 *  a paused sim freezes it like every other layer. */
const PREDATOR_TAIL_OMEGA = 7;

export class Renderer {
  /** Per-instance tetra colour cache (src/render/tetras.ts builds
   *  the render layer with NO module-level state — the only mutable
   *  render state a Renderer owns). The angels keep a SEPARATE
   *  cache: they reuse the tetra spine renderer with a hue offset
   *  (#123), so per-index colours must not bleed across species. */
  private readonly tetraColours: string[] = [];
  private readonly angelColours: string[] = [];
  /** The pooled bubble emitter (src/render/bubbles.ts): built once
   *  per Renderer, recycled in place every frame. */
  private readonly bubbles = new BubbleColumn();
  /** The two parallax substrate layers (src/render/substrate.ts):
   *  built once per Renderer, seeded, reused forever. */
  private readonly substrate = new Substrate();
  /** Cached ImageBitmap table (ticket #137): bindAssets() wires
   *  the boot's decode cache in ONCE; the frame loop only reads
   *  it, so per-frame texture cost is drawImage calls alone. An
   *  empty table (headless boots, decode failures) makes every
   *  texture pass a no-op and the frame is the pre-#137 one. */
  private assetBitmaps: Record<string, ImageBitmap> = {};
  /** Phase-baked art tables (ticket #139 three-phase tinting):
   *  palette name -> slot name -> the phase's canvas variant.
   *  Built ONCE by bakePhaseTints() after the boot decode settles
   *  (the frame then only does map lookups — zero per-frame work).
   *  Every slot falls back to its neutral bitmap inside the table
   *  when its bake degraded; LIGHT_DAY is ABSENT by design: day
   *  is the identity pass-through, so the frame uses the neutral
   *  table itself. */
  private readonly phaseTables: Record<string, Record<string, ArtTexture>> = {};
  /** The predator's render-owned tail phase (see PREDATOR_TAIL_
   *  OMEGA above) and the last rendered sim time it diffs against
   *  (null before the first frame). */
  private predatorPhase = 0;
  private lastRenderTime: number | null = null;

  /** Paint one frame of the given world state. The scene ambient is
   *  resolved from world.time + the lighting-phase offset (a paused
   *  sim freezes it; the offset is the PRD §4 save/load knob); the
   *  rest of the frame is painted in the documented order above —
   *  the kelp and rocks sit after the substrate (their roots/bodies
   *  rest on the gravel) and behind the tetra school. */
  render(ctx: CanvasRenderingContext2D, width: number, height: number, world: World): void {
    const light = lightPhaseAt(world.time + world.lightingPhaseOffset);
    // The frame's art table: the ACTIVE PHASE's baked variants
    // (or the neutral table for day / a not-yet-baked boot).
    const textures = this.phaseTables[light.palette.name] ?? this.assetBitmaps;
    drawBackdrop(ctx, width, height, light.palette);
    this.paintBackgroundTexture(ctx, width, height, textures);
    this.substrate.paintFar(ctx, width, height, world.time);
    this.substrate.paintNear(ctx, width, height, world.time);
    this.paintGravelTexture(ctx, width, height, textures);
    drawCausticShafts(ctx, width, height, world.time, light.palette);
    this.paintCausticsTile(ctx, width, height, world.time, textures);
    drawSurfaceRipples(ctx, width, world.time);
    drawKelp(ctx, width, height, world.kelp, textures);
    drawRocks(ctx, width, height, world.rocks, textures);
    drawTetras(ctx, width, height, world.angels, this.angelColours, ANGEL_HUE_OFFSET, "angel-body", textures);
    drawTetras(ctx, width, height, world.agents, this.tetraColours, 0, "tetra-body", textures);
    // The predator's spine phase advances by SIM TIME (a paused
    // sim freezes it); the world's clock is the ground truth.
    if (this.lastRenderTime !== null) {
      this.predatorPhase += (world.time - this.lastRenderTime) * PREDATOR_TAIL_OMEGA;
    }
    this.lastRenderTime = world.time;
    drawPredator(ctx, width, height, world.predator, this.predatorPhase, textures);
    drawPellets(ctx, width, height, world.pellets);
    this.bubbles.paint(ctx, width, height, world.time, textures);
    drawShockwaves(ctx, width, height, world.shockwaves);
  }

  /** Wire the boot's decode cache (called once, before the first
   *  frame). Kept by reference: entries land during the boot
   *  decode, which settles before any frame runs. */
  bindAssets(bitmaps: Record<string, ImageBitmap>): void {
    this.assetBitmaps = bitmaps;
  }

  /** Bake the three-phase art tinting (ticket #139) — called
   *  ONCE, after the boot decode has settled and before the first
   *  frame. For each tinted phase (dusk, night — day is the
   *  identity pass-through and keeps no bake) a phase table is
   *  built: every decoded slot gets its pre-baked canvas variant,
   *  or its neutral bitmap where the bake degraded — degradation,
   *  never a crash. Boot-time work only: the frame loop reads
   *  exactly one table per frame. */
  bakePhaseTints(): void {
    for (const name of Object.keys(PHASE_TINTS) as (keyof typeof PHASE_TINTS)[]) {
      const tint = PHASE_TINTS[name];
      if (tint === null) continue; // day: identity — the neutral table stands
      const table: Record<string, ArtTexture> = {};
      for (const slot of Object.keys(this.assetBitmaps)) {
        const bitmap = this.assetBitmaps[slot]!;
        const variant = bakeTintVariant(bitmap, tint, defaultSurfaceFactory);
        table[slot] = variant ?? bitmap; // degraded bake: keep the neutral art
      }
      this.phaseTables[name] = table;
    }
  }

  /** Full-frame underwater background texture over the procedural
   *  ambient (placeholder today; final art arrives via the
   *  sourcing runbook — data-only swap, no code change). No
   *  save/translate: the flat-rect overlay must not disturb the
   *  draw-recording audits of the procedural layers. */
  private paintBackgroundTexture(ctx: CanvasRenderingContext2D, width: number, height: number, textures: Record<string, ArtTexture>): void {
    const tex = textures["bg"];
    if (!tex) return;
    ctx.globalAlpha = BACKGROUND_TEXTURE_ALPHA;
    ctx.drawImage(tex, 0, 0, width, height);
    ctx.globalAlpha = 1;
  }

  /** Seamless caustics-TILE overlay (ticket #139): the #137
   *  verified-seamless tile repeats in a (floor(W/cell) + 2) ×
   *  (floor(H/cell) + 2) grid — a COUNT FIXED FOR THE VIEWPORT —
   *  that scrolls diagonally at CAUSTICS_TILE_DRIFT px of sim
   *  time: the grid is anchored at 0 and one row/column oversized,
   *  so every viewport pixel stays covered at every offset
   *  (seamless drift, no pop). Flat drawImage rectangles, no
   *  transforms — the same overlay discipline as the background/
   *  gravel passes; the active phase's table supplies the tint.
   */
  private paintCausticsTile(ctx: CanvasRenderingContext2D, width: number, height: number, t: number, textures: Record<string, ArtTexture>): void {
    const tex = textures["caustics-tile"];
    if (!tex || !(CAUSTICS_TILE_CELL > 0)) return;
    const cell = CAUSTICS_TILE_CELL;
    const off = (((t * CAUSTICS_TILE_DRIFT) % cell) + cell) % cell;
    const cols = Math.floor(width / cell) + 2;
    const rows = Math.floor(height / cell) + 2;
    ctx.globalAlpha = CAUSTICS_TILE_ALPHA;
    for (let i = 0; i < cols; i += 1) {
      for (let j = 0; j < rows; j += 1) {
        ctx.drawImage(tex, i * cell - off, j * cell - off, cell, cell);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Seamless gravel tile along the floor (placeholder; the tile
   *  is verified seamless by the integrity suite). Aspect-preserving
   *  horizontal tiling, drawn as plain drawImage rectangles — no
   *  transforms, no per-frame allocation (tile count is fixed for
   *  a given viewport width). */
  private paintGravelTexture(ctx: CanvasRenderingContext2D, width: number, height: number, textures: Record<string, ArtTexture>): void {
    const tex = textures["gravel-tile"];
    if (!tex) return;
    const band = height * GRAVEL_TEXTURE_BAND;
    const tileW = band * (tex.width / tex.height);
    // A zero-height canvas makes the tile step 0 (a degenerate
    // bitmap makes it NaN) — the tiling loop would spin forever
    // and freeze the tab; `!(> 0)` refuses both, 0 and NaN alike.
    if (!(tileW > 0)) return;
    ctx.globalAlpha = GRAVEL_TEXTURE_ALPHA;
    for (let x = 0; x < width; x += tileW) {
      ctx.drawImage(tex, x, height - band, tileW, band);
    }
    ctx.globalAlpha = 1;
  }
}
