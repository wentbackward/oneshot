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
//   5  surface ripples
//   6  kelp strands (placed, PRD §3 — roots rest on the gravel)
//   7  rocks (placed, PRD §3 — behind the school)
//   8  angelfish spines (PRD §2 — behind the school, the large
//      slow independents drawn by the SAME tetra spine renderer
//      with a complementary palette, #123)
//   9  tetra spines (PRD §2)
//   10 dropped pellets (PRD §3 — food floats over the school)
//   11 bubble column (pool, painted in slot order)
//   12 shockwave rings (PRD §3 tap-glass — on the GLASS, in front
//       of everything, incl. the bubbles)
// Layers 10/12 draw nothing while the world carries no food/rings,
// so a fresh boot's frame is byte-identical to the pre-food one.
// ================================================================

import type { World } from "../sim/world.ts";
import { drawKelp, drawRocks } from "./scenery.ts";
import { ANGEL_HUE_OFFSET, drawTetras } from "./tetras.ts";
import { drawBackdrop, drawSurfaceRipples } from "./water.ts";
import { lightPhaseAt } from "./lighting.ts";
import { drawCausticShafts } from "./caustics.ts";
import { BubbleColumn } from "./bubbles.ts";
import { Substrate } from "./substrate.ts";
import { drawPellets, drawShockwaves } from "./food.ts";

// Embedded-texture overlay strengths (ticket #137): the textures
// sit OVER the procedural paint, which stays the scene's light —
// the alpha blend keeps the Day/Dusk/Night cycle visibly driving
// the frame while placeholder/final art rides on top.
const BACKGROUND_TEXTURE_ALPHA = 0.35;

/** Gravel band height above the floor, fraction of tank height
 *  (mirrors substrate.ts's GRAVEL_BAND 0.06 so the texture sits
 *  inside the gravel the procedural stones decorate). */
const GRAVEL_TEXTURE_BAND = 0.055;
const GRAVEL_TEXTURE_ALPHA = 0.3;

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

  /** Paint one frame of the given world state. The scene ambient is
   *  resolved from world.time + the lighting-phase offset (a paused
   *  sim freezes it; the offset is the PRD §4 save/load knob); the
   *  rest of the frame is painted in the documented order above —
   *  the kelp and rocks sit after the substrate (their roots/bodies
   *  rest on the gravel) and behind the tetra school. */
  render(ctx: CanvasRenderingContext2D, width: number, height: number, world: World): void {
    const light = lightPhaseAt(world.time + world.lightingPhaseOffset);
    drawBackdrop(ctx, width, height, light.palette);
    this.paintBackgroundTexture(ctx, width, height);
    this.substrate.paintFar(ctx, width, height, world.time);
    this.substrate.paintNear(ctx, width, height, world.time);
    this.paintGravelTexture(ctx, width, height);
    drawCausticShafts(ctx, width, height, world.time, light.palette);
    drawSurfaceRipples(ctx, width, world.time);
    drawKelp(ctx, width, height, world.kelp);
    drawRocks(ctx, width, height, world.rocks);
    drawTetras(ctx, width, height, world.angels, this.angelColours, ANGEL_HUE_OFFSET);
    drawTetras(ctx, width, height, world.agents, this.tetraColours);
    drawPellets(ctx, width, height, world.pellets);
    this.bubbles.paint(ctx, width, height, world.time);
    drawShockwaves(ctx, width, height, world.shockwaves);
  }

  /** Wire the boot's decode cache (called once, before the first
   *  frame). Kept by reference: entries land during the boot
   *  decode, which settles before any frame runs. */
  bindAssets(bitmaps: Record<string, ImageBitmap>): void {
    this.assetBitmaps = bitmaps;
  }

  /** Full-frame underwater background texture over the procedural
   *  ambient (placeholder today; final art arrives via the
   *  sourcing runbook — data-only swap, no code change). No
   *  save/translate: the flat-rect overlay must not disturb the
   *  draw-recording audits of the procedural layers. */
  private paintBackgroundTexture(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const tex = this.assetBitmaps["bg"];
    if (!tex) return;
    ctx.globalAlpha = BACKGROUND_TEXTURE_ALPHA;
    ctx.drawImage(tex, 0, 0, width, height);
    ctx.globalAlpha = 1;
  }

  /** Seamless gravel tile along the floor (placeholder; the tile
   *  is verified seamless by the integrity suite). Aspect-preserving
   *  horizontal tiling, drawn as plain drawImage rectangles — no
   *  transforms, no per-frame allocation (tile count is fixed for
   *  a given viewport width). */
  private paintGravelTexture(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const tex = this.assetBitmaps["gravel-tile"];
    if (!tex) return;
    const band = height * GRAVEL_TEXTURE_BAND;
    const tileW = band * (tex.width / tex.height);
    // A zero-height canvas makes the tile step 0 — the tiling loop
    // would spin forever and freeze the tab.
    if (tileW <= 0) return;
    ctx.globalAlpha = GRAVEL_TEXTURE_ALPHA;
    for (let x = 0; x < width; x += tileW) {
      ctx.drawImage(tex, x, height - band, tileW, band);
    }
    ctx.globalAlpha = 1;
  }
}
