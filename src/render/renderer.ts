// ================================================================
// Frame renderer (PRD §1: render isolated from sim): observes the
// World and paints it into the canvas.
//
// DRAW ORDER (the draw-recording tests parse per-frame event logs
// against it — keep any change deliberate):
//   1  ambient water backdrop (current lighting phase, §3)
//   2  substrate far layer  (gravel, save/translate/restore)
//   3  substrate near layer (top decor, save/translate/restore)
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

  /** Paint one frame of the given world state. The scene ambient is
   *  resolved from world.time + the lighting-phase offset (a paused
   *  sim freezes it; the offset is the PRD §4 save/load knob); the
   *  rest of the frame is painted in the documented order above —
   *  the kelp and rocks sit after the substrate (their roots/bodies
   *  rest on the gravel) and behind the tetra school. */
  render(ctx: CanvasRenderingContext2D, width: number, height: number, world: World): void {
    const light = lightPhaseAt(world.time + world.lightingPhaseOffset);
    drawBackdrop(ctx, width, height, light.palette);
    this.substrate.paintFar(ctx, width, height, world.time);
    this.substrate.paintNear(ctx, width, height, world.time);
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
}
