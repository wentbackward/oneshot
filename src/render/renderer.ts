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
//   8  tetra spines (PRD §2)
//   9  bubble column (pool, painted in slot order)
// The food layer joins here once it exists.
// ================================================================

import type { World } from "../sim/world.ts";
import { drawKelp, drawRocks } from "./scenery.ts";
import { drawTetras } from "./tetras.ts";
import { drawBackdrop, drawSurfaceRipples } from "./water.ts";
import { lightPhaseAt } from "./lighting.ts";
import { drawCausticShafts } from "./caustics.ts";
import { BubbleColumn } from "./bubbles.ts";
import { Substrate } from "./substrate.ts";

export class Renderer {
  /** Per-instance tetra colour cache (src/render/tetras.ts builds
   *  the render layer with NO module-level state — the only mutable
   *  render state a Renderer owns). */
  private readonly tetraColours: string[] = [];
  /** The pooled bubble emitter (src/render/bubbles.ts): built once
   *  per Renderer, recycled in place every frame. */
  private readonly bubbles = new BubbleColumn();
  /** The two parallax substrate layers (src/render/substrate.ts):
   *  built once per Renderer, seeded, reused forever. */
  private readonly substrate = new Substrate();

  /** Paint one frame of the given world state. The scene ambient is
   *  resolved from world.time (a paused sim freezes it); the rest
   *  of the frame is painted in the documented order above — the
   *  kelp and rocks sit after the substrate (their roots/bodies
   *  rest on the gravel) and behind the tetra school. */
  render(ctx: CanvasRenderingContext2D, width: number, height: number, world: World): void {
    const light = lightPhaseAt(world.time);
    drawBackdrop(ctx, width, height, light.palette);
    this.substrate.paintFar(ctx, width, height, world.time);
    this.substrate.paintNear(ctx, width, height, world.time);
    drawCausticShafts(ctx, width, height, world.time, light.palette);
    drawSurfaceRipples(ctx, width, world.time);
    drawKelp(ctx, width, height, world.kelp);
    drawRocks(ctx, width, height, world.rocks);
    drawTetras(ctx, width, height, world.agents, this.tetraColours);
    this.bubbles.paint(ctx, width, height, world.time);
  }
}
