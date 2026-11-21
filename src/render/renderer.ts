// ================================================================
// Frame renderer (PRD §1: render isolated from sim): observes the
// World and paints it into the canvas.
//
// DRAW ORDER (the draw-recording tests parse per-frame event logs
// against it — keep any change deliberate):
//   1  ambient water backdrop (current lighting phase, §3)
//   2  surface ripples
//   3  tetra spines (PRD §2)
// (caustic shafts, substrate and bubbles join below the backdrop
//  in their own slices of this ticket)
// Food and obstacle layers join here once they exist.
// ================================================================

import type { World } from "../sim/world.ts";
import { drawTetras } from "./tetras.ts";
import { drawBackdrop, drawSurfaceRipples } from "./water.ts";
import { lightPhaseAt } from "./lighting.ts";

export class Renderer {
  /** Per-instance tetra colour cache (src/render/tetras.ts builds
   *  the render layer with NO module-level state — the only mutable
   *  render state a Renderer owns). */
  private readonly tetraColours: string[] = [];

  /** Paint one frame of the given world state. The scene ambient is
   *  resolved from world.time (a paused sim freezes it); the rest
   *  of the frame is painted in the documented order above. */
  render(ctx: CanvasRenderingContext2D, width: number, height: number, world: World): void {
    const light = lightPhaseAt(world.time);
    drawBackdrop(ctx, width, height, light.palette);
    drawSurfaceRipples(ctx, width, world.time);
    drawTetras(ctx, width, height, world.agents, this.tetraColours);
  }
}
