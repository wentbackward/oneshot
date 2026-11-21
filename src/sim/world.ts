// ================================================================
// The tank world (PRD §1/§2): owns simulation state and advances it
// in deterministic fixed timesteps, decoupled from rendering frame
// pacing. The renderer is a pure observer of the tetras; nothing
// here touches the canvas or the DOM.
//
// Species: schooling tetras (PRD §2's first behaviour). Each tetra
// composes the Reynolds steering forces (separation, alignment,
// cohesion, boundary avoidance — src/sim/steering.ts), is kept
// inside the tank by an elastic wall reflection plus a hard clamp,
// and owns an articulated tail: its phase advances every step at
// tailFrequency(speed, torque) (src/sim/tail.ts).
//
// Determinism contract:
//  - every random draw goes through a seeded mulberry32 stream;
//  - step(dt) takes an EXPLICIT timestep (the app always feeds
//    FIXED_DT) and mutates tetras in a fixed array order;
//  - two worlds built from the same seed replay identical
//    trajectories (incl. startleAt events), so serializeState()
//    hashes identically — pinned by tests/fishtank-tetras.test.mjs.
// ================================================================

import {
  FIXED_DT,
  STARTLE_IMPULSE,
  STARTLE_RADIUS,
  TETRA_COUNT,
  TETRA_MAX_SPEED,
  TETRA_MIN_SPEED,
} from "./constants.ts";
import { mulberry32 } from "./rng.ts";
import { tailFrequency } from "./tail.ts";
import { FISH_MAX_SPEED, alignment, boundaryAvoidance, cohesion, separation } from "./steering.ts";
import { SpatialGrid, type Positioned } from "./spatialGrid.ts";

/** Logical tank extent in tank units (rendering maps it to the viewport). */
export const TANK_WIDTH = 1600;
export const TANK_HEIGHT = 1000;

/** Spatial grid cell edge in tank units (≈ 25 × 16 cells). */
const GRID_CELL_SIZE = 64;

/** Initial school spread: a fresh world spawns ONE loose cluster
 *  centred on the tank (radius in tank units) — compact enough to
 *  read as a school at boot, dispersed enough to prove cohesion. */
const SPAWN_CLUSTER_RADIUS = 120;

/** Heading scatter (±radians) around the school's shared base
 *  heading at spawn: a school is born roughly aligned, not as a
 *  swarm of random directions. */
const SPAWN_HEADING_JITTER = 0.5;

/** The spawn cluster is squashed vertically to the tank's aspect
 *  ratio so it fills the wide viewport naturally. */
const SPAWN_CLUSTER_SQUASH = 0.6;

/** Fresh tetras cruise inside this speed band, tank units/s. */
const SPAWN_SPEED_MIN = 40;
const SPAWN_SPEED_MAX = 80;

/** Alignment is a unit-scale heading average (its named clamp is 1);
 *  applying it at cruise speed turns it into Reynolds' "desired
 *  heading" steering: steer toward where the school is HEADED, as
 *  hard as a cruising turn can be. */
const ALIGNMENT_CRUISE_SPEED = FISH_MAX_SPEED;

/** Per-step blend of the instantaneous turning torque into the
 *  smoothed one feeding the tail formula: 0.25 reacts in ≈ 4 steps
 *  without strobing on per-step force jitter. */
const TORQUE_SMOOTHING = 0.25;

/** How far a tetra SENSES its school (alignment + cohesion), tank
 *  units. Deliberately wider than NEIGHBOUR_RADIUS: a real school
 *  tracks dozens of metres of shoalmates, while separation stays
 *  personal — separation() filters each candidate against its own
 *  NEIGHBOUR_RADIUS internally, so feeding it the wider list keeps
 *  it exactly the #119 personal-repulsion force. */
const SCHOOL_PERCEPTION_RADIUS = 180;

const TAU = 2 * Math.PI;

/** A schooling tetra: a position and a velocity in tank units,
 *  plus the articulated-tail state the renderer observes. */
export interface Tetra extends Positioned {
  vx: number;
  vy: number;
  /** Accumulated tail phase in radians (monotonically increasing —
   *  the renderer samples sin(phase − k·seg) along the spine). */
  phase: number;
  /** Smoothed turning torque, rad/s — the tail formula's input. */
  torque: number;
  /** Heading (radians) at the end of the previous step: the
   *  reference for the torque measurement. */
  heading: number;
}

/** World construction options. */
export interface WorldOptions {
  /** Seed for the world's PRNG: same seed ⇒ identical tank. */
  seed?: number;
  /** How many tetras to spawn (defaults to TETRA_COUNT). */
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
  /** The tetra school, in fixed iteration order. Named `agents` to
   *  stay the stable per-world surface (the #119 determinism test
   *  hashes on it); every entry is a Tetra. */
  agents: Tetra[] = [];
  /** Neighbor grid (typed Tetra so queries hand back moving bodies
   *  straight into the steering forces), rebuilt every fixed step
   *  (PRD §1). */
  readonly grid: SpatialGrid<Tetra>;
  /** Reused neighbour scratch per step (allocation-free hot path):
   *  steering forces only READ the list, so one shared buffer is
   *  safe across the fixed-order iteration. */
  private readonly neighbours: Tetra[] = [];

  constructor(options: WorldOptions = {}) {
    this.seed = options.seed ?? 1;
    this.grid = new SpatialGrid(TANK_WIDTH, TANK_HEIGHT, GRID_CELL_SIZE);
    this.spawn(options.population ?? TETRA_COUNT);
  }

  /** Spawn n tetras as one loose cluster at the tank centre: a
   *  shared base heading (jittered ±SPAWN_HEADING_JITTER) so the
   *  school is born roughly aligned, with seeded random offsets and
   *  speeds inside the cluster (uniform disk: the square-root keeps
   *  the density flat, not rim-heavy). */
  private spawn(count: number): void {
    const rng = mulberry32(this.seed);
    const baseHeading = rng() * TAU;
    for (let i = 0; i < count; i++) {
      const heading = baseHeading + (rng() * 2 - 1) * SPAWN_HEADING_JITTER;
      const offAngle = rng() * TAU;
      const radius = SPAWN_CLUSTER_RADIUS * Math.sqrt(rng());
      const speed = SPAWN_SPEED_MIN + rng() * (SPAWN_SPEED_MAX - SPAWN_SPEED_MIN);
      this.agents.push({
        x: TANK_WIDTH / 2 + Math.cos(offAngle) * radius,
        y: TANK_HEIGHT / 2 + Math.sin(offAngle) * radius * SPAWN_CLUSTER_SQUASH,
        vx: Math.cos(heading) * speed,
        vy: Math.sin(heading) * speed,
        phase: rng() * TAU,
        torque: 0,
        heading,
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
   *  neighbor grid, then for every tetra (fixed array order)
   *  compose the steering forces, clamp the speed, integrate and
   *  keep the body INSIDE the tank (elastic reflection plus a hard
   *  clamp), and advance its articulated tail at
   *  tailFrequency(speed, torque). */
  step(dt: number): void {
    this.time += dt;
    this.rebuildGrid();
    for (const t of this.agents) {
      this.neighbours.length = 0;
      for (const n of this.grid.query(t.x, t.y, SCHOOL_PERCEPTION_RADIUS)) {
        if (n !== t) this.neighbours.push(n);
      }
      const sep = separation(t, this.neighbours);
      const ali = alignment(this.neighbours);
      const coh = cohesion(t, this.neighbours);
      const bou = boundaryAvoidance(t, TANK_WIDTH, TANK_HEIGHT);
      const ax = sep.x + ali.x * ALIGNMENT_CRUISE_SPEED + coh.x + bou.x;
      const ay = sep.y + ali.y * ALIGNMENT_CRUISE_SPEED + coh.y + bou.y;
      let vx = t.vx + ax * dt;
      let vy = t.vy + ay * dt;
      const speed = Math.hypot(vx, vy);
      if (speed > TETRA_MAX_SPEED) {
        const s = TETRA_MAX_SPEED / speed;
        vx *= s;
        vy *= s;
      } else if (speed > 0 && speed < TETRA_MIN_SPEED) {
        const s = TETRA_MIN_SPEED / speed;
        vx *= s;
        vy *= s;
      }
      let x = t.x + vx * dt;
      let y = t.y + vy * dt;
      // Elastic wall reflection, then a hard clamp as belt-and-braces:
      // a tetra can never leave the tank, whatever forced it here.
      if (x < 0) { x = -x; vx = -vx; } else if (x > TANK_WIDTH) { x = 2 * TANK_WIDTH - x; vx = -vx; }
      if (y < 0) { y = -y; vy = -vy; } else if (y > TANK_HEIGHT) { y = 2 * TANK_HEIGHT - y; vy = -vy; }
      if (x < 0) x = 0; else if (x > TANK_WIDTH) x = TANK_WIDTH;
      if (y < 0) y = 0; else if (y > TANK_HEIGHT) y = TANK_HEIGHT;
      const nx = Math.hypot(vx, vy);
      const heading = nx > 0 ? Math.atan2(vy, vx) : t.heading;
      const instantTorque = wrapPi(heading - t.heading) / dt;
      t.torque += TORQUE_SMOOTHING * (instantTorque - t.torque);
      t.x = x;
      t.y = y;
      t.vx = vx;
      t.vy = vy;
      t.heading = heading;
      t.phase += TAU * tailFrequency(nx, t.torque) * dt;
    }
  }

  /** Startle event (PRD §2: the school scatters when the user taps
   *  the glass): every tetra within STARTLE_RADIUS of (x, y)
   *  receives an OUTWARD impulse of STARTLE_IMPULSE straight away
   *  from the epicentre. A tetra sitting exactly ON the epicentre
   *  (undefined radial direction) is flung along its own heading,
   *  or +x if it has none — deterministic. Non-finite coordinates
   *  are rejected: the event is a no-op reporting 0, touching
   *  nothing (same well-formedness philosophy as advance()).
   *  Returns the number of startled tetras. */
  startleAt(x: number, y: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    let startled = 0;
    for (const t of this.agents) {
      const dx = t.x - x;
      const dy = t.y - y;
      const d = Math.hypot(dx, dy);
      if (d > STARTLE_RADIUS) continue;
      let ux: number;
      let uy: number;
      if (d > 0) {
        ux = dx / d;
        uy = dy / d;
      } else {
        const s = Math.hypot(t.vx, t.vy);
        ux = s > 0 ? t.vx / s : 1;
        uy = s > 0 ? t.vy / s : 0;
      }
      t.vx += ux * STARTLE_IMPULSE;
      t.vy += uy * STARTLE_IMPULSE;
      startled += 1;
    }
    return startled;
  }

  /** Fixed-precision snapshot of the whole sim state: clock first,
   *  then one `x,y,vx,vy` line per tetra at 6 decimals. The tail
   *  state (phase, torque) is excluded deliberately: heading is a
   *  pure function of (vx, vy) and the tail scalars are deterministic
   *  functions of the full history, so this fingerprint already
   *  proves replay identity. Two same-seed worlds hash this
   *  byte-identically (determinism proof). */
  serializeState(): string {
    const lines = [this.time.toFixed(6)];
    for (const t of this.agents) {
      lines.push(`${t.x.toFixed(6)},${t.y.toFixed(6)},${t.vx.toFixed(6)},${t.vy.toFixed(6)}`);
    }
    return lines.join("\n");
  }

  /** Clear + re-insert every tetra: the O(1)-average neighbor
   *  lookup the steering forces (PRD §2) consume each step. */
  private rebuildGrid(): void {
    this.grid.clear();
    for (const t of this.agents) this.grid.insert(t);
  }
}

/** Wrap a heading delta into (−π, π]: the shortest angular
 *  difference, so the torque measurement sees a U-turn as π, not
 *  2π. */
function wrapPi(angle: number): number {
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}
