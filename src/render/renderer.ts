// ================================================================
// Frame renderer (PRD §1: render isolated from sim): observes the
// World and paints it into the canvas. Entity layers (fish, food,
// obstacles — PRD §2/§3) render here once they exist.
// ================================================================

import type { World } from "../sim/world.ts";
import { drawWater } from "./water.ts";

export class Renderer {
  /** Paint one frame of the given world state. */
  render(ctx: CanvasRenderingContext2D, width: number, height: number, world: World): void {
    drawWater(ctx, width, height, world.time);
  }
}
