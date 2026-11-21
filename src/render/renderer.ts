// ================================================================
// Frame renderer (PRD §1: render isolated from sim): observes the
// World and paints it into the canvas.
//
// DRAW ORDER (the draw-recording tests parse per-frame event logs
// against it — keep any change deliberate):
//   1  ambient water backdrop (current lighting phase, §3)
//   2  caustic light shafts (five save/translate/restore groups)
//   3  surface ripples
//   4  tetra spines (PRD §2)
//   5  bubble column (pool, painted in slot order)
// (the parallax substrate joins between the backdrop and the
//  caustics in the next slice of this ticket)
// Food and obstacle layers join here once they exist.
// ================================================================

import type { World } from "../sim/world.ts";
import { drawTetras } from "./tetras.ts";
import { drawBackdrop, drawSurfaceRipples } from "./water.ts";
import { lightPhaseAt } from "./lighting.ts";
import { drawCausticShafts } from "./caustics.ts";
import { BubbleColumn } from "./bubbles.ts";

export class Renderer {
  /** Per-instance tetra colour cache (src/render/tetras.ts builds
   *  the render layer with NO module-level state — the only mutable
   *  render state a Renderer owns). */
  private readonly tetraColours: string[] = [];
  /** The pooled bubble emitter (src/render/bubbles.ts): built once
   *  per Renderer, recycled in place every frame. */
  private readonly bubbles = new BubbleColumn();

  /** Paint one frame of the given world state. The scene ambient is
   *  resolved from world.time (a paused sim freezes it); the rest
   *  of the frame is painted in the documented order above. */
  render(ctx: CanvasRenderingContext2D, width: number, height: number, world: World): void {
    const light = lightPhaseAt(world.time);
    drawBackdrop(ctx, width, height, light.palette);
    drawCausticShafts(ctx, width, height, world.time, light.palette);
    drawSurfaceRipples(ctx, width, world.time);
    drawTetras(ctx, width, height, world.agents, this.tetraColours);
    this.bubbles.paint(ctx, width, height, world.time);
  }
}
