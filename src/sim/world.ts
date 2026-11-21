// ================================================================
// The tank world (PRD §1): owns simulation state and advances it in
// deterministic fixed timesteps, decoupled from rendering frame
// pacing. The renderer is a pure observer of `time`; nothing here
// touches the canvas or the DOM.
//
// Determinism contract (pinned by tests/fishtank-determinism.test.mjs):
//  - every random draw goes through a seeded mulberry32 stream;
//  - step(dt) takes an EXPLICIT timestep (the app always feeds
//    FIXED_DT) and mutates agents in a fixed array order;
//  - two worlds built from the same seed replay identical
//    trajectories, so serializeState() hashes identically.
// ================================================================

import { FIXED_DT } from "./constants.ts";
import { mulberry32 } from "./rng.ts";
import { SpatialGrid, type Positioned } from "./spatialGrid.ts";

/** Logical tank extent in tank units (rendering maps it to the viewport). */
export const TANK_WIDTH = 1600;
export const TANK_HEIGHT = 1000;

/** Spatial grid cell edge in tank units (≈ 25 × 16 cells). */
const GRID_CELL_SIZE = 64;

/** Default seeded population (per-species variety arrives in a
 *  later ticket; every agent follows the same cruise law for now). */
export const DEFAULT_POPULATION = 40;

/** Cruise-speed band for freshly spawned agents, tank units/s. */
const SPAWN_SPEED_MIN = 20;
const SPAWN_SPEED_MAX = 60;

/** A swimming agent: a position and a velocity in tank units. */
export interface Agent extends Positioned {
  vx: number;
  vy: number;
}

/** World construction options. */
export interface WorldOptions {
  /** Seed for the world's PRNG: same seed ⇒ identical tank. */
  seed?: number;
  /** How many agents to spawn (defaults to DEFAULT_POPULATION). */
  population?: number;
}

export class World {
  /** World clock in seconds: advances in exact step-size multiples. */
  time = 0;
  /** Seconds carried over between frames from an incomplete step. */
  acc = 0;
  /** Numeric PRNG seed this world was built from: a plain number,
   *  not a stateful stream — the mulberry32 stream is (re)created
   *  from it at construction, and same seed ⇒ identical tank. */
  readonly seed: number;
  /** Every simulated swimmer, in fixed iteration order. */
  agents: Agent[] = [];
  /** Neighbor grid, rebuilt every fixed step (PRD §1). */
  readonly grid: SpatialGrid<Positioned>;

  constructor(options: WorldOptions = {}) {
    this.seed = options.seed ?? 1;
    this.grid = new SpatialGrid(TANK_WIDTH, TANK_HEIGHT, GRID_CELL_SIZE);
    this.spawn(options.population ?? DEFAULT_POPULATION);
  }

  /** Spawn n agents at seeded random positions/headings. */
  private spawn(count: number): void {
    const rng = mulberry32(this.seed);
    for (let i = 0; i < count; i++) {
      const heading = rng() * 2 * Math.PI;
      const speed = SPAWN_SPEED_MIN + rng() * (SPAWN_SPEED_MAX - SPAWN_SPEED_MIN);
      this.agents.push({
        x: rng() * TANK_WIDTH,
        y: rng() * TANK_HEIGHT,
        vx: Math.cos(heading) * speed,
        vy: Math.sin(heading) * speed,
      });
    }
  }

  /** Feed up to deltaSeconds of wall time to the sim: consume it in
   *  exact FIXED_DT steps, carry the leftover. Returns the number of
   *  steps taken. The app's only entry point — tests drive step(dt)
   *  directly.
   *
   *  Precondition (enforced by the CALLER, not here): deltaSeconds
   *  must be clamped into [0, MAX_FRAME_DELTA] before this call —
   *  fishtank-main.ts does this via clampDelta() — so a tab switch
   *  or long pause cannot burst thousands of fixed steps in one
   *  frame. advance() deliberately does not clamp itself: silently
   *  dropping the excess would change the accumulator's accounting
   *  semantics.
   *
   *  WELL-FORMEDNESS (enforced here): a non-finite delta (NaN, ±∞)
   *  is rejected — returns 0, touches nothing. A NaN would poison
   *  the accumulator permanently (every later `acc >= FIXED_DT`
   *  compares false and the sim freezes silently); +∞ would spin
   *  the step loop forever. The rejected frame simply accounts as
   *  no progress; the next well-formed frame drives normally.
   */
  advance(deltaSeconds: number): number {
    if (!Number.isFinite(deltaSeconds)) return 0;
    this.acc += Math.max(0, deltaSeconds);
    let steps = 0;
    while (this.acc >= FIXED_DT) {
      this.acc -= FIXED_DT;
      this.step(FIXED_DT);
      steps += 1;
    }
    return steps;
  }

  /** One deterministic step of EXACTLY dt seconds: rebuild the
   *  neighbor grid, integrate every agent in fixed order, wrap the
   *  swarm torus-style so the domain stays a closed universe. */
  step(dt: number): void {
    this.time += dt;
    this.rebuildGrid();
    for (const agent of this.agents) {
      let x = agent.x + agent.vx * dt;
      let y = agent.y + agent.vy * dt;
      x = ((x % TANK_WIDTH) + TANK_WIDTH) % TANK_WIDTH;
      y = ((y % TANK_HEIGHT) + TANK_HEIGHT) % TANK_HEIGHT;
      agent.x = x;
      agent.y = y;
    }
  }

  /** Fixed-precision snapshot of the whole sim state: clock first,
   *  then one `x,y,vx,vy` line per agent at 6 decimals. Two same-
   *  seed worlds hash this byte-identically (determinism proof). */
  serializeState(): string {
    const lines = [this.time.toFixed(6)];
    for (const agent of this.agents) {
      lines.push(`${agent.x.toFixed(6)},${agent.y.toFixed(6)},${agent.vx.toFixed(6)},${agent.vy.toFixed(6)}`);
    }
    return lines.join("\n");
  }

  /** Clear + re-insert every agent: the O(1)-average neighbor
   *  lookup the steering forces (PRD §2) will consume. */
  private rebuildGrid(): void {
    this.grid.clear();
    for (const agent of this.agents) this.grid.insert(agent);
  }
}
