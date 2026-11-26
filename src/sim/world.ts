// ================================================================
// The tank world (PRD §1/§2): owns simulation state and advances it
// in deterministic fixed timesteps, decoupled from rendering frame
// pacing. The renderer is a pure observer of the tetras; nothing
// here touches the canvas or the DOM.
//
// Species (PRD §2): schooling tetras (the first behaviour) and the
// apex predator (the third, ticket #124). Each tetra composes the
// Reynolds steering forces (separation, alignment, cohesion,
// boundary avoidance — src/sim/steering.ts) plus the #144 motion
// story: organic wander, net-negative buoyancy with thrust lift,
// and a per-step turn-rate cap that makes every trajectory a
// continuous curve. Walls are STEERING, not collisions: the
// boundary band turns a fish well short of the glass, and a
// rare contact is handled by a non-mirroring safety net (position
// clamp + outward-normal absorption) instead of an elastic bounce.
// Each tetra owns an articulated tail: its phase advances every
// step at tailFrequency(speed, torque) (src/sim/tail.ts). The predator
// (src/sim/predator.ts) patrols a named waypoint loop, stalks
// isolated tetras once hunger crosses the threshold, and rests for
// a fixed window after each feed; the World steps it after the
// tetras so it always acts on current prey positions. The grazing
// angelfish (the second behaviour, ticket #123 — src/sim/angels.ts)
// are slow independent cruisers with a vertical bob: no inter-fish
// forces at all, own pool, stepped after the tetras and before the
// pellet pass, rendered by the same spine renderer as the tetras.
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
  ANGEL_COUNT,
  AMBIENT_CURRENT_X,
  FIXED_DT,
  KELP_MAX,
  KELP_PICK_BAND,
  KELP_PICK_SLACK,
  KELP_SEED_STRIDE,
  PELLET_EAT_RADIUS,
  PELLET_MAX,
  PELLET_RADIUS,
  PELLET_SENSE_RADIUS,
  ROCK_COLLIDE_PAD,
  ROCK_MAX,
  ROCK_PICK_SLACK,
  ROCK_RADIUS,
  SAVE_MAX_TETRA,
  SHOCKWAVE_MAX_RINGS,
  SHOCKWAVE_RING_MAX_RADIUS,
  SHOCKWAVE_RING_SPEED,
  STARTLE_IMPULSE,
  STARTLE_RADIUS,
  TANK_HEIGHT,
  TANK_WIDTH,
  TETRA_COUNT,
  TETRA_GRAVITY,
  TETRA_MAX_SPEED,
  TETRA_MIN_SPEED,
  TETRA_THRUST_LIFT,
  TETRA_TURN_RATE_RAD_S,
  TETRA_WALL_NORMAL_RETENTION,
  WANDER_ACCEL,
  WANDER_FREQ_MIN,
  WANDER_FREQ_SPREAD,
} from "./constants.ts";
import { KelpStrand } from "./kelp.ts";
import { Angel, spawnAngels } from "./angels.ts";
import { TAU, TORQUE_SMOOTHING, wrapPi } from "./angles.ts";
import { stepPellet, type Pellet, type Shockwave } from "./pellets.ts";
import { mulberry32 } from "./rng.ts";
import { tailFrequency } from "./tail.ts";
import {
  FISH_MAX_SPEED,
  alignment,
  boundaryAvoidance,
  cohesion,
  obstacleAvoidance,
  separation,
  seek,
} from "./steering.ts";
import { SpatialGrid, type Positioned } from "./spatialGrid.ts";
import { ApexPredator } from "./predator.ts";

// The tank extent is defined in constants.ts (leaf modules such as
// predator.ts need it without an import cycle); both re-exports are
// kept for the existing importers (tests, render layer).
export { TANK_WIDTH, TANK_HEIGHT } from "./constants.ts";

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

/** Population-top-up reseed stride: a school grown by
 *  setTetraCount() past its spawn size draws each cohort from
 *  `seed + POP_RESEED_STRIDE · (cohort index)`, so the top-up is a
 *  deterministic function of (seed, current size) — the same
 *  policy that keeps kelp placement reproducible
 *  (KELP_SEED_STRIDE). */
const POP_RESEED_STRIDE = 1_000_003;

/** Alignment is a unit-scale heading average (its named clamp is 1);
 *  applying it at cruise speed turns it into Reynolds' "desired
 *  heading" steering: steer toward where the school is HEADED, as
 *  hard as a cruising turn can be. */
const ALIGNMENT_CRUISE_SPEED = FISH_MAX_SPEED;

/** How far a tetra SENSES its school (alignment + cohesion), tank
 *  units. Deliberately wider than NEIGHBOUR_RADIUS: a real school
 *  tracks dozens of metres of shoalmates, while separation stays
 *  personal — separation() filters each candidate against its own
 *  NEIGHBOUR_RADIUS internally, so feeding it the wider list keeps
 *  it exactly the #119 personal-repulsion force. */
const SCHOOL_PERCEPTION_RADIUS = 180;

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
  /** Per-tetra wander frequency (rad/s, #144): drawn on the spawn
   *  stream; the wander force is WANDER_ACCEL · sin(wanderFreq ·
   *  world.time + wanderPhase) applied PERPENDICULAR to the
   *  heading. Static per fish (set at spawn) — not serialized,
   *  the same policy as phase/torque. */
  wanderFreq: number;
  /** Per-tetra wander phase offset (radians, #144). */
  wanderPhase: number;
}

/** A placed rock (PRD §3): a smooth river-rock CIRCLE — the
 *  circular collision obstacle the steering layer's
 *  obstacleAvoidance() steers around. Structurally an Obstacle. */
export interface Rock {
  x: number;
  y: number;
  r: number;
}

/** A live pellet: the pure Pellet plus the per-step claim flag the
 *  tetra pass sets when an in-contact tetra eats it (checked by
 *  LATER tetras in the same fixed step, so one pellet is ever
 *  consumed exactly once). Cleared with the pellet — it is never
 *  a persisted trait. */
interface LivePellet extends Pellet {
  dead: boolean;
}

/** World construction options. */
export interface WorldOptions {
  /** Seed for the world's PRNG: same seed ⇒ identical tank. */
  seed?: number;
  /** How many tetras to spawn (defaults to TETRA_COUNT). */
  population?: number;
  /** Horizontal ambient flow, ONE dial with two consumer roles
   *  (defaults to AMBIENT_CURRENT_X; 0 = still water for the kelp
   *  settle tests). The kelp strands verlet it as a UNIFORM
   *  ACCELERATION (tank units/s², entering their position as
   *  current · dt²); the pellet integrator consumes the same value
   *  as a FLOW VELOCITY (units/s), relaxing the pellet's vx to the
   *  equilibrium `ambientCurrentX / PELLET_DRAG`. The fish are not
   *  advected. */
  ambientCurrentX?: number;
  /** Whether the world owns the apex predator (defaults to true;
   *  the rock/kelp solver unit tests opt out so their lone tetra
   *  cannot be captured mid-scenario). */
  predator?: boolean;
  /** How many angelfish to spawn (defaults to ANGEL_COUNT).
   *  Independent cruisers — see src/sim/angels.ts. A non-integer
   *  or negative count is refused (empty pool), mirroring
   *  setTetraCount's refusal. */
  angels?: number;
}

/** Worst collision-ring violation depth at (cx, cy) over ALL rocks:
 *  max over i of (rock_i.r + ROCK_COLLIDE_PAD − dist_i). Negative
 *  when the point clears every ring; positive otherwise — by exactly
 *  how deep the worst violation there is. */
function worstRingDepth(
  rocks: readonly Rock[],
  cx: number,
  cy: number,
): number {
  let worst = -Infinity;
  for (const rock of rocks) {
    const depth = rock.r + ROCK_COLLIDE_PAD - Math.hypot(cx - rock.x, cy - rock.y);
    if (depth > worst) worst = depth;
  }
  return worst;
}

/** Clamp a coordinate into a tank edge. */
function clampX(value: number): number {
  return value < 0 ? 0 : value > TANK_WIDTH ? TANK_WIDTH : value;
}
function clampY(value: number): number {
  return value < 0 ? 0 : value > TANK_HEIGHT ? TANK_HEIGHT : value;
}

/** Allocation-free scratch for a (x, y) pair, reused on hot paths
 *  (owned by the World, see World.stripV). */
interface Vec2Scratch {
  x: number;
  y: number;
}

/** Strip the component of (vx, vy) heading INTO any rock ring the
 *  point (x, y) sits in or on, so a tetra parked or sliding on
 *  those surfaces does not dig in next step. The 1e-9 slack keeps
 *  engaged the disks an exit candidate sits on in floating point
 *  (met exactly at their boundary); a tetra clear of every ring
 *  and not approaching one is untouched.
 *  Writes the stripped velocity into `out`. */
function stripInwardVelocity(
  rocks: readonly Rock[],
  x: number,
  y: number,
  vx: number,
  vy: number,
  out: Vec2Scratch,
): void {
  out.x = vx;
  out.y = vy;
  for (const rock of rocks) {
    const rx = x - rock.x;
    const ry = y - rock.y;
    const d = Math.hypot(rx, ry);
    if (d >= rock.r + ROCK_COLLIDE_PAD + 1e-9) continue;
    const ux = d > 0 ? rx / d : 1; // centre-on-body: deterministic +x
    const uy = d > 0 ? ry / d : 0;
    const vr = out.x * ux + out.y * uy;
    if (vr < 0) {
      out.x -= vr * ux;
      out.y -= vr * uy;
    }
  }
}

export class World {
  /** World clock in seconds: advances in exact step-size multiples. */
  time = 0;
  /** Seconds carried over between frames from an incomplete step. */
  acc = 0;
  /** Total fixed steps taken since construction (telemetry, PRD §4;
   *  lets a pinned-clock test assert exact step consumption). */
  steps = 0;
  /** Lighting-phase shift in simulation seconds (PRD §4 save/load):
   *  the renderer resolves the palette at `time + offset`, so a
   *  loaded layout can hold Day/Dusk/Night at a fresh t = 0. The
   *  offset is a whole phase-table quantity (see
   *  src/fishtank-storage.ts), keeping every boundary on a step
   *  boundary. */
  lightingPhaseOffset = 0;
  /** Numeric PRNG seed this world was built from: a plain number,
   *  not a stateful stream — the mulberry32 stream is (re)created
   *  from it at construction, and same seed ⇒ identical tank. */
  readonly seed: number;
  /** The tetra school, in fixed iteration order. Named `agents` to
   *  stay the stable per-world surface (the #119 determinism test
   *  hashes on it); every entry is a Tetra. The angelfish live in
   *  their OWN pool (world.angels) and are NOT in the grid — they
   *  compose no inter-fish forces, so no tetra ever senses one. */
  agents: Tetra[] = [];
  /** Neighbor grid (typed Tetra so queries hand back moving bodies
   *  straight into the steering forces). Populated at construction,
   *  on every population change and at the END of every fixed step
   *  (PRD §1) — so after any step or setTetraCount it holds the
   *  CURRENT positions and telemetry (HUD utilization, PRD §4)
   *  never reads a stale grid. During a step, queries see the
   *  PREVIOUS step's end positions (the tetras act one step behind
   *  their own motion — the predator's isolation checks reuse the
   *  same view). */
  readonly grid: SpatialGrid<Tetra>;
  /** The apex predator (PRD §2, ticket #124): owned by the world,
   *  stepped after the tetras each fixed step. Null when the world
   *  was built without a predator (solver unit tests); save/load
   *  (PRD §4) may add or remove it via setPredatorPresent(). */
  predator: ApexPredator | null;
  /** Placed rocks (PRD §3): the dynamic circular obstacles. Fed to
   *  obstacleAvoidance() every step and enforced by a hard contact
   *  projection, so a removed rock leaves NO residual steering.
   *  Capped at ROCK_MAX by placeRock(). */
  readonly rocks: Rock[] = [];
  /** Placed kelp strands (PRD §3): verlet chains anchored at the
   *  substrate, capped at KELP_MAX by placeKelp(). */
  readonly kelp: KelpStrand[] = [];
  /** Grazing angelfish (PRD §2's second behaviour, #123): slow
   *  independent cruisers — their own pool, iterated in fixed
   *  order AFTER the tetras each fixed step, NOT in the grid (no
   *  inter-fish forces at all) and outside the predator's prey
   *  scan. Spawned from `seed + ANGEL_SEED_STRIDE`. */
  readonly angels: Angel[] = [];
  /** Live (uneaten, unsettled) dropped pellets (PRD §3): capped at
   *  PELLET_MAX by dropFood(), stepped by the pure stepPellet()
   *  integrator, consumed by the nearest in-contact tetra. */
  readonly pellets: LivePellet[] = [];
  /** Live tap-glass shockwave rings (PRD §3): capped at
   *  SHOCKWAVE_MAX_RINGS by tapGlass(), retired by step() once a
   *  ring reaches SHOCKWAVE_RING_MAX_RADIUS. */
  readonly shockwaves: Shockwave[] = [];
  /** Horizontal ambient flow. Dual role, dual units — kelp: a
   *  uniform acceleration (tank units/s², see WorldOptions);
   *  pellets: a flow velocity (units/s) whose drag equilibrium the
   *  pellet's vx relaxes to (`ambientCurrentX / PELLET_DRAG`). */
  readonly ambientCurrentX: number;
  /** Reused neighbour scratch per step (allocation-free hot path):
   *  steering forces only READ the list, so one shared buffer is
   *  safe across the fixed-order iteration. */
  private readonly neighbours: Tetra[] = [];
  /** Reused violator scratch (allocation-free hot path): the rocks
   *  whose collision ring the tetra is inside, in world order.
   *  PER-WORLD so concurrent worlds can never share mutation state. */
  private readonly rockViolators: Rock[] = [];
  /** The chosen exit point from pickBestExit (per-world scratch). */
  private readonly bestExit: Vec2Scratch = { x: 0, y: 0 };
  /** The inward-velocity strip scratch (per-world scratch). */
  private readonly stripV: Vec2Scratch = { x: 0, y: 0 };
  /** Deterministic per-strand jitter source: identical placement
   *  sequences on identical seeds yield identical strands. */
  private kelpSequence = 0;

  constructor(options: WorldOptions = {}) {
    this.seed = options.seed ?? 1;
    this.ambientCurrentX = options.ambientCurrentX ?? AMBIENT_CURRENT_X;
    this.grid = new SpatialGrid(TANK_WIDTH, TANK_HEIGHT, GRID_CELL_SIZE);
    this.spawn(options.population ?? TETRA_COUNT);
    this.angels = spawnAngels(this.seed, options.angels ?? ANGEL_COUNT);
    this.predator = options.predator === false ? null : new ApexPredator();
    // FIRST grid population (derived state): nothing may read an
    // empty grid before the first step — telemetry (PRD §4) reads
    // occupancy from the very first frame, and step N's queries use
    // the grid as left by the previous step, so a fresh world must
    // start with it populated. From then on the end-of-step rebuild
    // (and setTetraCount) keep it current.
    this.rebuildGrid();
  }

  // ---------- population & predator (PRD §4 save/load) ----------

  /** Grow or trim the tetra pool to exactly n (clamped into
   *  [0, SAVE_MAX_TETRA]). Trimming splices the TAIL of the fixed
   *  order; growing appends one deterministic cohort drawn from
   *  `seed + POP_RESEED_STRIDE · startIndex`, so the same top-up
   *  on same-seed worlds yields the same school (pinned by
   *  tests/fishtank-save.test.mjs). Non-finite or fractional n is
   *  refused (touches nothing). */
  setTetraCount(n: number): void {
    if (!Number.isInteger(n) || n < 0) return;
    const target = Math.min(n, SAVE_MAX_TETRA);
    if (target < this.agents.length) {
      this.agents.length = target;
      // The grid must not outlive the pool: a trimmed tail left in
      // the grid would keep steering as a ghost for a step, and a
      // grown cohort must be a neighbour from the NEXT step's
      // queries — the same views the step-end rebuild maintains.
      this.rebuildGrid();
    } else if (target > this.agents.length) {
      this.spawnCohort(this.agents.length, target - this.agents.length);
      this.rebuildGrid();
    }
  }

  /** Add or remove the apex predator (PRD §4 save/load). */
  setPredatorPresent(present: boolean): void {
    this.predator = present ? new ApexPredator() : null;
  }

  // ---------- placement tools (PRD §3) ----------

  /** Drop a food pellet at (x, y): spawned at rest — the water
   *  does the rest (see stepPellet). Returns the pellet, or null
   *  when the tank is at the PELLET_MAX cap or the coordinates are
   *  non-finite (a rejected drop touches nothing). Coordinates are
   *  clamped fully inside the tank, same policy as placeRock(). */
  dropFood(x: number, y: number): Pellet | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (this.pellets.length >= PELLET_MAX) return null;
    const pellet: LivePellet = {
      x: clampX(x),
      y: clampY(y),
      vx: 0,
      vy: 0,
      dead: false,
    };
    this.pellets.push(pellet);
    return pellet;
  }

  /** Tap the glass at (x, y): spawn the expanding shockwave ring
   *  there (capped at SHOCKWAVE_MAX_RINGS — at the cap a NEW ring
   *  is refused, but the scare itself is never refused) and startle
   *  the school at the cursor. Returns the number of startled
   *  tetras (the startleAt() report); non-finite coordinates are
   *  rejected — a no-op reporting 0, touching nothing. The
   *  coordinates are clamped to the tank ONCE and the SAME clamped
   *  pair drives both the ring's visible epicentre and the
   *  startle, so the two can never disagree. */
  tapGlass(x: number, y: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    const cx = clampX(x);
    const cy = clampY(y);
    if (this.shockwaves.length < SHOCKWAVE_MAX_RINGS) {
      this.shockwaves.push({ x: cx, y: cy, radius: 0 });
    }
    return this.startleAt(cx, cy);
  }

  /** Place a rock at (x, y): a circle of ROCK_RADIUS clamped fully
   *  inside the tank. Returns the rock, or null when the tank is
   *  at the ROCK_MAX cap or the coordinates are non-finite (a
   *  rejected placement touches nothing). */
  placeRock(x: number, y: number): Rock | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (this.rocks.length >= ROCK_MAX) return null;
    const rock: Rock = {
      x: Math.min(TANK_WIDTH - ROCK_RADIUS, Math.max(ROCK_RADIUS, x)),
      y: Math.min(TANK_HEIGHT - ROCK_RADIUS, Math.max(ROCK_RADIUS, y)),
      r: ROCK_RADIUS,
    };
    this.rocks.push(rock);
    return rock;
  }

  /** Remove a previously placed rock. Returns false (and touches
   *  nothing) when the rock is not present. */
  removeRock(rock: Rock): boolean {
    const at = this.rocks.indexOf(rock);
    if (at < 0) return false;
    this.rocks.splice(at, 1);
    return true;
  }

  /** Place a kelp strand anchored at (x, TANK_HEIGHT) — the
   *  substrate. Returns the strand, or null when the tank is at the
   *  KELP_MAX cap or the coordinate is non-finite. */
  placeKelp(x: number): KelpStrand | null {
    if (!Number.isFinite(x)) return null;
    if (this.kelp.length >= KELP_MAX) return null;
    const anchorX = Math.min(TANK_WIDTH, Math.max(0, x));
    const strand = new KelpStrand(
      anchorX,
      TANK_HEIGHT,
      this.seed + KELP_SEED_STRIDE * (++this.kelpSequence),
    );
    this.kelp.push(strand);
    return strand;
  }

  /** Remove a previously placed kelp strand. Returns false (and
   *  touches nothing) when the strand is not present. */
  removeKelp(strand: KelpStrand): boolean {
    const at = this.kelp.indexOf(strand);
    if (at < 0) return false;
    this.kelp.splice(at, 1);
    return true;
  }

  /** Remove-mode pick: the nearest object whose pick region covers
   *  (x, y) — rocks first (their body + ROCK_PICK_SLACK, anywhere
   *  in the tank), then kelp anchors (± KELP_PICK_SLACK around the
   *  anchor x, but ONLY inside the KELP_PICK_BAND substrate band:
   *  a remove click on open water high above a strand must not
   *  strike it). Returns the removed object, or null when the
   *  click hit open water. Non-finite coordinates are rejected
   *  (no-op, same policy as advance()/step()). */
  removeNearestAt(x: number, y: number): Rock | KelpStrand | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    let bestRock: Rock | null = null;
    let bestRockDist = Infinity;
    for (const rock of this.rocks) {
      const d = Math.hypot(x - rock.x, y - rock.y);
      if (d <= rock.r + ROCK_PICK_SLACK && d < bestRockDist) {
        bestRockDist = d;
        bestRock = rock;
      }
    }
    if (bestRock !== null) {
      this.removeRock(bestRock);
      return bestRock;
    }
    let bestKelp: KelpStrand | null = null;
    let bestKelpDist = Infinity;
    for (const strand of this.kelp) {
      // The kelp pick reaches only into the substrate band (the
      // anchor region), not the whole tank height.
      if (y < TANK_HEIGHT - KELP_PICK_BAND) continue;
      const d = Math.abs(x - strand.anchorX);
      if (d <= KELP_PICK_SLACK && d < bestKelpDist) {
        bestKelpDist = d;
        bestKelp = strand;
      }
    }
    if (bestKelp !== null) {
      this.removeKelp(bestKelp);
      return bestKelp;
    }
    return null;
  }

  /** Spawn count tetras as one loose cluster at the tank centre
   *  from a FRESH seeded stream: a shared base heading (jittered
   *  ±SPAWN_HEADING_JITTER) so the school is born roughly aligned,
   *  with seeded random offsets and speeds inside the cluster
   *  (uniform disk: the square-root keeps the density flat, not
   *  rim-heavy). */
  private spawn(count: number): void {
    this.spawnCohort(0, count);
  }

  /** Append count tetras to the existing school (population
   *  top-up): same cluster shape as spawn(), drawn from a stream
   *  reseeded on (seed, startIndex) — deterministic per world. */
  private spawnCohort(startIndex: number, count: number): void {
    const rng = mulberry32(this.seed + POP_RESEED_STRIDE * startIndex);
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
        wanderFreq: WANDER_FREQ_MIN + WANDER_FREQ_SPREAD * rng(),
        wanderPhase: rng() * TAU,
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

  /** One deterministic step of EXACTLY dt seconds: for every tetra
   *  (fixed array order) compose the steering forces (including
   *  obstacle avoidance around the placed rocks, the #144 organic
   *  wander, and the vertical story: net-negative buoyancy with
   *  thrust lift) against the grid as left by the previous step,
   *  clamp the speed, integrate, and keep the body INSIDE the tank
   *  — walls are STEERING, not collisions (the boundary band turns
   *  a fish well short of the glass; a rare contact is resolved by
   *  the bounded position resolution plus the non-mirroring safety
   *  net below), hard-resolve it against every rock's collision
   *  radius together with the tank walls, absorb any outward wall
   *  normal, apply the per-step turn-rate cap so the heading never
   *  swings more than TETRA_TURN_RATE_RAD_S · dt, and advance its
   *  articulated tail at tailFrequency(speed, torque). Finally,
   *  advance every kelp strand under the ambient current, letting
   *  the tetras drag the strands they swim through, the predator
   *  acts, and the neighbor grid is REBUILT LAST from the post-step
   *  positions (see the inline comment) so post-step consumers —
   *  the HUD's utilization telemetry (PRD §4) — read current
   *  occupancy.
   *
   *  WELL-FORMEDNESS (enforced here, same policy as advance()): a
   *  non-finite dt (NaN, ±∞) or a dt <= 0 is refused — step() is a
   *  no-op that touches nothing. A NaN/±∞ would divide through the
   *  torque measurement and permanently poison every tetra's
   *  torque/phase; a negative dt would integrate the tank
   *  backwards. Pinned by tests/fishtank-determinism.test.mjs:
   *  a refused step leaves the world byte-identical and drivable. */
  step(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.time += dt;
    this.steps += 1;
    for (const t of this.agents) {
      this.neighbours.length = 0;
      for (const n of this.grid.query(t.x, t.y, SCHOOL_PERCEPTION_RADIUS)) {
        if (n !== t) this.neighbours.push(n);
      }
      const sep = separation(t, this.neighbours);
      const ali = alignment(this.neighbours);
      const coh = cohesion(t, this.neighbours);
      const bou = boundaryAvoidance(t, TANK_WIDTH, TANK_HEIGHT);
      const obs = obstacleAvoidance(t, this.rocks);
      // #144 vertical story: net NEGATIVE BUOYANCY — gravity is a
      // constant downward (screen +y) pull; the thrust LIFT scales
      // with the squared speed ratio (thrust ∝ effort²), so a
      // low-effort fish sags slowly (gravity wins below ≈ 139
      // u/s) while a full-speed burst climbs (lift wins) — the
      // school's altitude is a function of its energy, not of a
      // target depth (data: TETRA_GRAVITY / TETRA_THRUST_LIFT).
      const spd = Math.hypot(t.vx, t.vy);
      const sr = spd / TETRA_MAX_SPEED;
      const buoyancy = TETRA_GRAVITY - TETRA_THRUST_LIFT * sr * sr;
      // #144 organic wander: a gentle acceleration PERPENDICULAR
      // to the heading, modulated by a slow per-tetra sine of world
      // time — idle paths curve like real fish instead of running
      // straight lines. Sized BELOW TETRA_GRAVITY so the vertical
      // story's drift is not swamped by the sideways pull, and
      // negligible against a full-speed heading; present at idle,
      // where it bends the path; deterministic (no random draws).
      let wx = 0;
      let wy = 0;
      if (spd > 1e-9) {
        const wob = WANDER_ACCEL * Math.sin(t.wanderFreq * this.time + t.wanderPhase);
        wx = (-t.vy / spd) * wob;
        wy = (t.vx / spd) * wob;
      }
      // Food seeking (PRD §3): the NEAREST live pellet inside
      // PELLET_SENSE_RADIUS steers the tetra on it via Reynolds
      // seek(); inside PELLET_EAT_RADIUS the pellet is consumed
      // INSTANTLY — the fixed iteration order makes the first
      // in-contact tetra the sole claimant (later tetras see the
      // dead flag and pass), so one pellet is ever eaten exactly
      // once. A pellet outside the sense radius contributes nothing
      // at all (byte-identical trajectories — pinned by
      // tests/fishtank-pellets.test.mjs).
      let foodX = 0;
      let foodY = 0;
      if (this.pellets.length > 0) {
        let nearest: LivePellet | null = null;
        let nearestD = Infinity;
        for (const p of this.pellets) {
          if (p.dead) continue;
          const d = Math.hypot(p.x - t.x, p.y - t.y);
          if (d <= PELLET_SENSE_RADIUS && d < nearestD) {
            nearestD = d;
            nearest = p;
          }
        }
        if (nearest !== null) {
          if (nearestD <= PELLET_EAT_RADIUS) {
            nearest.dead = true;
          } else {
            const f = seek(t, nearest);
            foodX = f.x;
            foodY = f.y;
          }
        }
      }
      const ax =
        sep.x + ali.x * ALIGNMENT_CRUISE_SPEED + coh.x + bou.x + obs.x + foodX + wx;
      const ay =
        sep.y + ali.y * ALIGNMENT_CRUISE_SPEED + coh.y + bou.y + obs.y + foodY + wy + buoyancy;
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
      // #144: no elastic reflection here — walls are steering. The
      // boundary band above has already turned this fish; if a fast
      // approach STILL overshot a wall, the bounded position
      // resolution below clamps the position and the non-mirroring
      // safety net (after the rock resolution) handles the
      // velocity. The old axis-mirror is exactly what produced
      // the #144 right-angle bounces.
      // Hard rock contact: the steering force above curves a tetra
      // AROUND the rock, but a steep approach can still clip its
      // surface between steps — the resolution below guarantees
      // the 600-step-soak invariant (no tetra inside r +
      // ROCK_COLLIDE_PAD, pinned by tests/fishtank-rocks.test.mjs)
      // regardless of force balance: even a rock dropped straight
      // onto the school ejects every fish.
      //
      // The rock disks and the tank walls are two position
      // constraints that can fight each other, so they are resolved
      // TOGETHER to a bounded fixed point — never in one sequential
      // pass: a single clamp→project (or project→clamp) pass can
      // leave the other constraint violated, because a projection
      // can push the tetra into a second rock or out through the
      // wall. Each pass takes the GLOBAL exit (see pickBestExit):
      // every candidate — each violator's radial exit, each
      // violator pair's boundary intersections, each violator ring's
      // crossings with the four tank walls — is tank-clamped FIRST
      // (the walls are the final authority of the pass, so a
      // candidate is scored at the point the tetra actually lands
      // at) and then scored by its worst remaining ring depth over
      // ALL rocks; only a STRICT improvement over the current
      // point is adopted, which makes the choice self-cycle-proof:
      // an accepted point always has a strictly smaller worst
      // depth, so no pass can re-select a point already reached.
      // Overlapping disks (legal — placements may overlap) are thus
      // exited in one jump, the choice never lands in a third
      // ring's burrow, and a wedged-against-the-wall cluster has
      // its along-the-wall escape corridor represented explicitly
      // by the ring∩wall candidates. After an exit the tank walls
      // get the final word, so step()'s INSIDE-TANK contract
      // survives every pass and every conflict.
      //
      // The loop is CAPPED at rocks.length + 1 passes because the
      // constraints are genuinely mutually exclusive where a rock's
      // collision ring overhangs a wall in a thin sliver. Honest
      // residual of the cap: in a wall sliver the tetra may rest
      // inside the PAD RING (a wall-clamped rock only touches the
      // wall tangentially, so a wall-resting tetra is never inside
      // that rock's solid body), and in an adversarial geometry
      // where the bounded candidate set offers no fully-clear
      // point a cap-rest can still sit inside a ring — the
      // cap-rest fallback below refuses to make the rest WORSE, and
      // the next step's global search resumes from the rest
      // position (plus the fish's own velocity keeps pressing it
      // along the surface). What every step guarantees: INSIDE the
      // tank, and clear of every ring whenever the bounded search
      // offers a strictly-improving clear candidate — true for all
      // reviewed configurations (two overlapping disks, the 2x2
      // grid at 40-unit spacing, the corner-hugging 2x2 grid,
      // single tetra and on-school), pinned by the round-2 …
      // round-4 regression soaks and one-step lattices in
      // tests/fishtank-rocks.test.mjs.
      for (let pass = 0; pass <= this.rocks.length; pass++) {
        let moved = false;
        const n = this.collectViolators(x, y);
        if (n > 0 && this.pickBestExit(n, x, y)) {
          x = this.bestExit.x;
          y = this.bestExit.y;
          moved = true;
          // Slide along instead of digging in: strip the inward
          // radial velocity against any ring the exit point sits on
          // or in — the disks the exit was scored against, plus
          // the third-party rings of the dense-cluster case.
          stripInwardVelocity(this.rocks, x, y, vx, vy, this.stripV);
          vx = this.stripV.x;
          vy = this.stripV.y;
        }
        // Tank walls — the final authority of each pass (a no-op
        // after an exit, whose candidates were pre-clamped; active
        // when the integrated point overshot a wall).
        if (x < 0) { x = 0; moved = true; } else if (x > TANK_WIDTH) { x = TANK_WIDTH; moved = true; }
        if (y < 0) { y = 0; moved = true; } else if (y > TANK_HEIGHT) { y = TANK_HEIGHT; moved = true; }
        if (!moved) break;
      }
      // Cap-rest fallback: only reachable when the pass cap expired
      // with rings still violated — the genuinely conflicted
      // geometries. One final radial exit from the DEEPEST violator
      // (largest ring depth, ties to the earlier rock in world
      // order), evaluated AFTER the tank clamp (the walls are the
      // final authority, same as in pickBestExit) and ADOPTED ONLY
      // IF IT STRICTLY IMPROVES the rest position's worst depth:
      // a fallback that merely re-enters a ring (the round-3
      // unclamped-exit failure, corner-hugging cluster) is rejected
      // and the cap's rest position stands.
      {
        const n = this.collectViolators(x, y);
        let depth = 0;
        let worst: Rock | null = null;
        for (let i = 0; i < n; i++) {
          const rock = this.rockViolators[i]!;
          const d = rock.r + ROCK_COLLIDE_PAD - Math.hypot(x - rock.x, y - rock.y);
          if (d > depth) {
            depth = d;
            worst = rock;
          }
        }
        if (worst !== null) {
          const m = worst.r + ROCK_COLLIDE_PAD;
          const rx = x - worst.x;
          const ry = y - worst.y;
          const d = Math.hypot(rx, ry);
          const ux = d > 0 ? rx / d : 1; // centre-on-body: deterministic +x
          const uy = d > 0 ? ry / d : 0;
          const exitX = clampX(worst.x + ux * m);
          const exitY = clampY(worst.y + uy * m);
          if (worstRingDepth(this.rocks, exitX, exitY) < depth) {
            x = exitX;
            y = exitY;
          }
        }
      }
      // Inward-velocity strip at REST: a no-op in the common case
      // (the resolution above left the tetra clear of every ring),
      // exactly the cap-rest violators in the conflicted geometries.
      stripInwardVelocity(this.rocks, x, y, vx, vy, this.stripV);
      vx = this.stripV.x;
      vy = this.stripV.y;
      // #144 wall safety net (the rare residue): the position
      // clamp in the resolution above already put the fish INSIDE
      // exactly on the wall; here its VELOCITY is brought in line
      // — the OUTWARD normal component is absorbed (scaled by
      // TETRA_WALL_NORMAL_RETENTION = 0) instead of mirrored:
      // mirroring is the axis-flip behind the reported right-angle
      // bounces, and it would also hand the fish back OUT through
      // the glass next step. The tangential component is preserved
      // in full, the boundary force does the turning, and the
      // turn-rate cap below keeps even this residue a continuous
      // curve. No code path in the sim flips a velocity component's
      // sign: this net only SHRINKS a component toward zero.
      if (x === 0 && vx < 0) vx *= TETRA_WALL_NORMAL_RETENTION;
      else if (x === TANK_WIDTH && vx > 0) vx *= TETRA_WALL_NORMAL_RETENTION;
      if (y === 0 && vy < 0) vy *= TETRA_WALL_NORMAL_RETENTION;
      else if (y === TANK_HEIGHT && vy > 0) vy *= TETRA_WALL_NORMAL_RETENTION;
      // Zero-velocity relaunch (#144): the rare case where the safety
      // net drained the outward normal AND the tangential was already
      // ~zero — a full-speed fish that struck the wall squarely, or a
      // fish resting inside a rock's collision ring zeroed by
      // stripInwardVelocity. A zero velocity has no heading (atan2(0, 0)
      // would snap the spine to +x), so relaunch at min speed along the
      // wall's INWARD normal when a wall is involved; in the wall-free
      // rock case the final fallback relaunches straight down (-y) —
      // bounded, deterministic, and the one non-wall velocity injection
      // in the sim (it bends back under the same turn-rate cap).
      let nx = Math.hypot(vx, vy);
      if (nx < 1e-6) {
        if (x === 0) vx = TETRA_MIN_SPEED;
        else if (x === TANK_WIDTH) vx = -TETRA_MIN_SPEED;
        else if (y === 0) vy = TETRA_MIN_SPEED;
        else vy = -TETRA_MIN_SPEED;
        nx = TETRA_MIN_SPEED;
      }
      // #144 turn-rate cap: per fixed step the heading may swing by
      // at most TETRA_TURN_RATE_RAD_S × dt — all trajectories are
      // continuous curves. A full-speed turn needs only ≈
      // MAX_STEERING_FORCE / TETRA_MAX_SPEED ≈ 0.9 rad/s, so the
      // cap binds only at LOW speed, where a force spike would
      // otherwise whip the fish around. Applied to the FINAL
      // velocity (post safety net, post rock strip) so the
      // MEASURED per-step heading — including the rare contact
      // residue — can never exceed the cap. The velocity is rebuilt
      // at the LIMITED heading (old heading advanced toward the raw
      // heading by at most the cap, speed preserved): clamping the
      // DELTA and rotating the raw vector would measure the raw
      // swing, not the capped one.
      const rawHeading = Math.atan2(vy, vx);
      const maxDh = TETRA_TURN_RATE_RAD_S * dt;
      let dhh = wrapPi(rawHeading - t.heading);
      if (dhh > maxDh) dhh = maxDh;
      else if (dhh < -maxDh) dhh = -maxDh;
      const limHeading = t.heading + dhh;
      const m = Math.hypot(vx, vy);
      vx = m * Math.cos(limHeading);
      vy = m * Math.sin(limHeading);
      nx = m;
      const heading = Math.atan2(vy, vx);
      const instantTorque = wrapPi(heading - t.heading) / dt;
      t.torque += TORQUE_SMOOTHING * (instantTorque - t.torque);
      t.x = x;
      t.y = y;
      t.vx = vx;
      t.vy = vy;
      t.heading = heading;
      t.phase += TAU * tailFrequency(nx, t.torque) * dt;
    }
    // Grazing angelfish (PRD §2, #123): after the tetras, before
    // the pellet pass — an angel's in-contact claim lands on the
    // same per-step `dead` flag, so a pellet is consumed at most
    // once per step across BOTH species, and a pellet claimed
    // earlier this step is skipped by everything below it.
    for (const a of this.angels) a.step(dt, this);
    // Dropped food (PRD §3): the survivors (not claimed this step)
    // integrate under drag + the ambient horizontal current; wall-
    // contained in x, culled once eaten or settled onto the substrate
    // (uneaten food dissolves — the tank never accumulates flakes).
    if (this.pellets.length > 0) {
      for (const p of this.pellets) {
        if (p.dead) continue;
        stepPellet(p, dt, this.ambientCurrentX);
        if (p.x < 0) { p.x = 0; if (p.vx < 0) p.vx = 0; }
        else if (p.x > TANK_WIDTH) { p.x = TANK_WIDTH; if (p.vx > 0) p.vx = 0; }
      }
      if (this.pellets.some((p) => p.dead || p.y + PELLET_RADIUS >= TANK_HEIGHT)) {
        // Compacted IN PLACE (the field is readonly: stable array
        // identity, same contract as rocks/kelp), order preserved.
        const alive: LivePellet[] = [];
        for (const p of this.pellets) {
          if (!p.dead && p.y + PELLET_RADIUS < TANK_HEIGHT) alive.push(p);
        }
        this.pellets.length = 0;
        for (const p of alive) this.pellets.push(p);
      }
    }
    // Tap-glass rings (PRD §3): every live ring expands at the named
    // rate; a ring that reaches its full radius retires (the render
    // layer fades each ring as a pure function of its radius).
    if (this.shockwaves.length > 0) {
      for (const s of this.shockwaves) s.radius += SHOCKWAVE_RING_SPEED * dt;
      if (this.shockwaves.some((s) => s.radius >= SHOCKWAVE_RING_MAX_RADIUS)) {
        const alive: Shockwave[] = [];
        for (const s of this.shockwaves) {
          if (s.radius < SHOCKWAVE_RING_MAX_RADIUS) alive.push(s);
        }
        this.shockwaves.length = 0;
        for (const s of alive) this.shockwaves.push(s);
      }
    }
    // Kelp reacts to this step's fish positions (fixed order keeps
    // the drag deterministic) and to the ambient current.
    for (const strand of this.kelp) {
      strand.step(dt, this.ambientCurrentX, this.agents);
    }
    // The predator acts AFTER the tetras: prey positions are
    // current, and a capture splice affects the grid only through
    // the rebuild below.
    this.predator?.step(dt, this);
    // FINAL grid rebuild: the grid now holds the POST-STEP
    // positions, so a consumer reading it after the step (the HUD's
    // utilization telemetry, PRD §4) sees current occupancy. Step
    // N+1's queries then use these same end-of-step-N positions —
    // exactly the view the former start-of-step rebuild handed out,
    // so the sim's trajectory is bit-identical (pinned by the
    // determinism/steering suites and the grid-freshness check in
    // tests/fishtank-determinism.test.mjs).
    this.rebuildGrid();
  }

  /** Count the rocks whose collision ring (r + ROCK_COLLIDE_PAD) the
   *  point (x, y) is inside, recording them in rockViolators in
   *  world order (the fixed order keeps the resolution
   *  deterministic and provides its tie-breaks). */
  private collectViolators(x: number, y: number): number {
    let n = 0;
    for (const rock of this.rocks) {
      if (Math.hypot(x - rock.x, y - rock.y) < rock.r + ROCK_COLLIDE_PAD) {
        this.rockViolators[n++] = rock;
      }
    }
    return n;
  }

  /** Choose the GLOBAL exit for a point sitting inside `n`
   *  collision rings: enumerate EVERY candidate — each violator's
   *  radial exit (world order), each violator pair's two boundary
   *  intersections (world order; equal-radius pairs only, which is
   *  every pair since all placements are ROCK_RADIUS circles), and
   *  each violator ring's crossings with the four tank walls — and
   *  take the candidate whose worst remaining ring depth
   *  (worstRingDepth over all rocks, so a candidate that clears its
   *  own violators but digs into a third ring scores accordingly) is
   *  strictly LESS than the point's own depth: an exit that improves
   *  nothing is rejected outright, which is what makes the choice
   *  self-cycle-proof (a re-selected identical point can never be a
   *  strict improvement of itself).
   *
   *  EVERY candidate is tank-clamped BEFORE scoring: the walls take
   *  the final word of the same pass, so a candidate must be judged
   *  at the point the tetra actually lands at — not at its raw
   *  coordinates. (Review round 4: the raw-coordinate scorer found
   *  "phantom-clear" exits just outside the water whose clamp-back
   *  re-entered a ring, lost every scoring round to genuine clear
   *  points, and cycled to the cap with the tetra resting in-ring
   *  on a wall — the corner-hugging 2x2 configuration.) The wall-
   *  crossings exist for exactly this wedged-against-a-wall regime:
   *  when a cluster overhangs the walls, the escape corridor runs
   *  ALONG the wall, and only the ring∩wall points reach it in one
   *  jump (the centre-tank 2x2 and every reviewed configuration are
   *  pinned by the round-2 … round-4 regressions in
   *  tests/fishtank-rocks.test.mjs).
   *
   *  The enumeration order is rock order and strict improvement
   *  keeps the FIRST candidate on any tie, so the choice is
   *  deterministic. Writes bestExit.
   *  Returns false (nothing moved) when `n` is 0 or when no
   *  candidate beats the current depth. */
  private pickBestExit(n: number, x: number, y: number): boolean {
    if (n === 0) return false;
    let best = worstRingDepth(this.rocks, x, y); // the point itself
    let bestX = x;
    let bestY = y;
    const consider = (cx: number, cy: number): void => {
      // Score what the tetra actually lands at: the walls are the
      // final authority of this pass, so clamp first.
      const lcx = clampX(cx);
      const lcy = clampY(cy);
      const depth = worstRingDepth(this.rocks, lcx, lcy);
      if (depth < best) {
        best = depth;
        bestX = lcx;
        bestY = lcy;
      }
    };
    // 1) each violator's radial exit, world order. The deterministic
    //    +x direction for a centre-on-body point (d === 0) carries
    //    over as-is: such a candidate is scored like any other.
    for (let i = 0; i < n; i++) {
      const v = this.rockViolators[i]!;
      const m = v.r + ROCK_COLLIDE_PAD;
      const rx = x - v.x;
      const ry = y - v.y;
      const d = Math.hypot(rx, ry);
      const ux = d > 0 ? rx / d : 1;
      const uy = d > 0 ? ry / d : 0;
      consider(v.x + ux * m, v.y + uy * m);
    }
    // 2) each violator pair's boundary intersections, world order.
    for (let i = 0; i < n; i++) {
      const A = this.rockViolators[i]!;
      for (let j = i + 1; j < n; j++) {
        const B = this.rockViolators[j]!;
        if (A.r !== B.r) continue; // the math needs equal radii
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const d = Math.hypot(dx, dy);
        const m = A.r + ROCK_COLLIDE_PAD;
        if (d < 1e-9 || d >= 2 * m) continue; // no usable intersection
        const h = Math.sqrt(m * m - (d / 2) * (d / 2));
        const mx = (A.x + B.x) / 2;
        const my = (A.y + B.y) / 2;
        const nx = -dy / d;
        const ny = dx / d;
        consider(mx + h * nx, my + h * ny);
        consider(mx - h * nx, my - h * ny);
      }
    }
    // 3) each violator ring's crossings with the four tank walls,
    //    world order: the along-the-wall escape points a cluster
    //    wedged against a wall needs (they lie on a wall, so the
    //    pre-score clamp in consider() is a no-op for them).
    for (let i = 0; i < n; i++) {
      const v = this.rockViolators[i]!;
      const m = v.r + ROCK_COLLIDE_PAD;
      // y = 0 and y = TANK_HEIGHT
      for (const wallY of [0, TANK_HEIGHT]) {
        const dy = wallY - v.y;
        const q = m * m - dy * dy;
        if (q <= 0) continue; // the ring does not reach that wall
        const dx = Math.sqrt(q);
        consider(v.x - dx, wallY);
        consider(v.x + dx, wallY);
      }
      // x = 0 and x = TANK_WIDTH
      for (const wallX of [0, TANK_WIDTH]) {
        const dx = wallX - v.x;
        const q = m * m - dx * dx;
        if (q <= 0) continue;
        const dy = Math.sqrt(q);
        consider(wallX, v.y - dy);
        consider(wallX, v.y + dy);
      }
    }
    if (bestX === x && bestY === y) return false; // no strict improvement
    this.bestExit.x = bestX;
    this.bestExit.y = bestY;
    return true;
  }

  /** Startle event (PRD §2: the school scatters when the user taps
   *  the glass): every tetra within STARTLE_RADIUS of (x, y)
   *  receives an OUTWARD impulse of STARTLE_IMPULSE straight away
   *  from the epicentre. A tetra sitting exactly ON the epicentre
   *  (undefined radial direction) is flung along its own heading,
   *  or +x if it has none — deterministic. The impulse is a
   *  physical jolt that re-orients the velocity, so each startled
   *  tetra's heading — a pure function of its velocity — is
   *  refreshed in the same call: the next step's turn-rate cap
   *  measures from the post-impulse heading and does not fight the
   *  scatter (the tail torque smooths over the jolt). Non-finite
   *  coordinates are rejected: the event is a no-op reporting 0,
   *  touching nothing (same well-formedness philosophy as
   *  advance()). Returns the number of startled tetras. */
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
      // The velocity moved; its derived heading moves with it.
      t.heading = Math.atan2(t.vy, t.vx);
      startled += 1;
    }
    return startled;
  }

  /** Fixed-precision snapshot of the whole sim state: clock first,
   *  then one `x,y,vx,vy` line per tetra at 6 decimals, then one
   *  `A:` line per angelfish (same shape — #123), then one `P:` line
   *  for the predator (state, pose, hunger, route
   *  progress, rest window, feed count — the line is absent when
   *  the world was built without a predator (unit-test worlds),
   *  then one `F:` line per live pellet (x, y, vx, vy) and one
   *  `S:` line per shockwave ring (x, y, radius). The tail state
   *  (phase,
   *  torque) is excluded deliberately: heading is a pure function
   *  of (vx, vy) and the tail scalars are deterministic functions
   *  of the full history, so this fingerprint already proves replay
   *  identity — predator included. Two same-seed worlds hash this
   *  byte-identically (determinism proof). */
  serializeState(): string {
    const lines = [this.time.toFixed(6)];
    for (const t of this.agents) {
      lines.push(`${t.x.toFixed(6)},${t.y.toFixed(6)},${t.vx.toFixed(6)},${t.vy.toFixed(6)}`);
    }
    for (const a of this.angels) {
      lines.push(`A:${a.x.toFixed(6)},${a.y.toFixed(6)},${a.vx.toFixed(6)},${a.vy.toFixed(6)}`);
    }
    const p = this.predator;
    if (p !== null) {
      lines.push(
        `P:${p.state}:${p.x.toFixed(6)},${p.y.toFixed(6)},${p.vx.toFixed(6)},${p.vy.toFixed(6)},` +
        `${p.hunger.toFixed(6)},${p.waypointIndex},${p.restRemaining},${p.fedCount}`,
      );
    }
    for (const f of this.pellets) {
      lines.push(`F:${f.x.toFixed(6)},${f.y.toFixed(6)},${f.vx.toFixed(6)},${f.vy.toFixed(6)}`);
    }
    for (const s of this.shockwaves) {
      lines.push(`S:${s.x.toFixed(6)},${s.y.toFixed(6)},${s.radius.toFixed(6)}`);
    }
    return lines.join("\n");
  }

  /** Clear + re-insert every agent into the grid: the derived-state
   *  refresh behind the O(1)-average neighbour lookups (PRD §2).
   *  Maintained AUTOMATICALLY after construction, every
   *  setTetraCount() and the end of every step — the grid always
   *  holds current positions afterwards. Call it after poking the
   *  agent pool or agent fields from OUTSIDE the world (test
   *  scenarios) so the next step's queries see the poked
   *  configuration. */
  rebuildGrid(): void {
    this.grid.clear();
    for (const t of this.agents) this.grid.insert(t);
  }
}
