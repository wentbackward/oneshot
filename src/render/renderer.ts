// ================================================================
// Frame renderer (PRD §1: render isolated from sim): observes the
// World and paints it into the canvas — water backdrop (PRD §3),
// then the tetra school's articulated spines (PRD §2). Food and
// obstacle layers join here once they exist.
// ================================================================

import type { World } from "../sim/world.ts";
import { drawTetras } from "./tetras.ts";
import { drawWater } from "./water.ts";

export class Renderer {
  /** Paint one frame of the given world state: the water backdrop,
   *  then the tetra school (PRD §2). */
  render(ctx: CanvasRenderingContext2D, width: number, height: number, world: World): void {
    drawWater(ctx, width, height, world.time);
    drawTetras(ctx, width, height, world.agents);
  }
}
