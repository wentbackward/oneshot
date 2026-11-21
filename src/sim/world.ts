// ================================================================
// The tank world (PRD §1): owns simulation state and advances it in
// deterministic fixed timesteps, decoupled from rendering frame
// pacing. The renderer is a pure observer of `time`; nothing here
// touches the canvas or the DOM.
// ================================================================

import { FIXED_DT } from "./constants.ts";
import { SpatialGrid, type Positioned } from "./spatialGrid.ts";

/** Logical tank extent in tank units (rendering maps it to the viewport). */
export const TANK_WIDTH = 1600;
export const TANK_HEIGHT = 1000;

/** Spatial grid cell edge in tank units (≈ 25 × 16 cells). */
const GRID_CELL_SIZE = 64;

export class World {
  /** World clock in seconds: advances in exact FIXED_DT multiples. */
  time = 0;
  /** Seconds carried over between frames from an incomplete step. */
  acc = 0;
  /** Every simulated entity (fish, pellets, obstacles) lives here. */
  entities: Positioned[] = [];
  /** Neighbor grid, rebuilt every fixed step (PRD §1). */
  readonly grid: SpatialGrid<Positioned>;

  constructor() {
    this.grid = new SpatialGrid(TANK_WIDTH, TANK_HEIGHT, GRID_CELL_SIZE);
  }

  /** Feed up to deltaSeconds of wall time to the sim: consume it in
   *  exact FIXED_DT steps, carry the leftover. Returns the number of
   *  steps taken. */
  advance(deltaSeconds: number): number {
    this.acc += Math.max(0, deltaSeconds);
    let steps = 0;
    while (this.acc >= FIXED_DT) {
      this.acc -= FIXED_DT;
      this.step();
      steps += 1;
    }
    return steps;
  }

  /** One fixed step: advance the clock and rebuild the neighbor
   *  grid. Per-entity behaviours (steering, PRD §2) plug into this
   *  method in a later ticket. */
  private step(): void {
    this.time += FIXED_DT;
    this.grid.clear();
    for (const entity of this.entities) this.grid.insert(entity);
  }
}
