// ================================================================
// Grazing angelfish (PRD §2's second behaviour, ticket #123): a
// SLOW, INDEPENDENT cruiser with a vertical bob that forages near
// bottom kelp and drifts toward dropped food. Pure sim — no
// canvas, no DOM; the World owns the pool and steps every angel
// after the tetras on every fixed step.
//
// Independence (the PRD's "independent cruisers"): an angel composes
// NO inter-fish force — no cohesion, alignment or separation, with
// tetras or fellow angels. Its entire control law is
//
//   food    >  forage  >  cruise
//
//   food:   the nearest live pellet inside PELLET_SENSE_RADIUS is
//     homed on at full cruise speed; inside PELLET_EAT_RADIUS the
//     pellet is consumed (its per-step claim flag makes one pellet
//     ever eat exactly once, shared with the tetra pass).
//   forage: with any kelp present, the nearest base is sought at
//     full speed until inside ANGEL_FORAGE_RADIUS, then the angel
//     hovers a slow ORBIT around it (a graze ring of
//     GRAZE_ORBIT_RADIUS, well inside the forage radius, with a
//     proportional radial pull) — it keeps moving, never stalls.
//   cruise: no food, no plants — a smooth horizontal wander
//     (bounded turning, zero base-vertical acceleration) — plus
//     the #144 boundary band steering the angel away from the
//     SIDE walls (x only), so it curves off the glass instead of
//     grinding into it.
//
// The vertical bob is KINEMATIC, layered ON TOP of the steering:
// all steering happens in the "base plane" (x, baseY); the rendered
// y is `baseY + ANGEL_BOB_AMP · sin(bobPhase)` and the rendered vy
// is `baseVy + ANGEL_BOB_AMP · ANGEL_BOB_OMEGA · cos(bobPhase)`.
// Because the bob is a pure function of baseY and a phase that
// advances by ANGEL_BOB_OMEGA · dt, a quiescent angel's y sits
// EXACTLY inside baseY ± ANGEL_BOB_AMP with a sinusoidal vertical
// velocity (pinned by tests/fishtank-angels.test.mjs). The named
// cruise ceiling is enforced on the COMPOSED (rendered) speed, so
// bob + swim can never exceed ANGEL_CRUISE_SPEED together.
//
// Control law: Reynolds steering in the base plane — the desired
// state velocity minus the current one, clamped to
// ANGEL_MAX_STEER — plus a speed clamp. No random draws: the
// wander is a smooth deterministic function of (world.time,
// per-angel parameters fixed at spawn), so same seed ⇒ identical
// angels (determinism contract, src/sim/world.ts).
//
// Deliberate scope (documented in docs/DECISIONS.md): angels do not
// steer around rocks, do not drag kelp, are not startle targets and
// are not predator prey — none of it is in the ticket, and the
// default tank ships no rocks.
// ================================================================

import type { World } from "./world.ts";
import {
  ANGEL_BOB_AMP,
  ANGEL_BOB_OMEGA,
  ANGEL_CRUISE_SPEED,
  ANGEL_FORAGE_RADIUS,
  ANGEL_SEED_STRIDE,
  BOUNDARY_MARGIN,
  MAX_BOUNDARY_AVOIDANCE_FORCE,
  PELLET_EAT_RADIUS,
  PELLET_SENSE_RADIUS,
  TANK_HEIGHT,
  TANK_WIDTH,
} from "./constants.ts";
import { mulberry32 } from "./rng.ts";
import { TAU, TORQUE_SMOOTHING, wrapPi } from "./angles.ts";
import { tailFrequency } from "./tail.ts";

/** Maximum steering acceleration in the base plane, tank units/s²:
 *  the angel's agility. */
const ANGEL_MAX_STEER = 120;

/** Priority gain on FOOD seeking only (1/s): Reynolds' steer
 *  (desired − current velocity) applied at this gain makes the
 *  commitment snappy — τ = 1/GAIN = 0.25 s to acquire full cruise
 *  on a flake — while forage and cruise stay on gain-1 steering
 *  (the big, unhurried read). A hungry angelfish is decisive;
 *  a cruising one is not. */
const ANGEL_SEEK_GAIN = 4;

/** Arrive deceleration radius around a pellet, tank units: the
 *  desired speed ramps from full cruise to half cruise as the gap
 *  closes to zero inside this ball (speed · (0.5 + 0.5 · d/R)), so
 *  an angel braking for a flake lands on it instead of swinging
 *  past — pursuing a pellet at terminal sink speed with full-
 *  cruise momentum settles into an orbit that never touches the
 *  PELLET_EAT_RADIUS window. Must exceed PELLET_EAT_RADIUS. */
const ANGEL_ARRIVE_RADIUS = 40;

/** Graze ring radius (tank units) the foraging angel orbits at,
 *  well inside ANGEL_FORAGE_RADIUS: the orbit keeps a wide safety
 *  margin to the forage band even with steering transients. */
const GRAZE_ORBIT_RADIUS = 90;
/** Orbital speed as a fraction of the angel's cruise speed: a
 *  slow circle, the "grazing" read. */
const GRAZE_ORBIT_SPEED_FRACTION = 0.5;
/** Proportional radial gain on the graze ring, 1/s: pulls the
 *  angel back toward GRAZE_ORBIT_RADIUS after any transient. */
const GRAZE_RADIAL_GAIN = 1.5;

/** Cruise wander: bounded turning (rad/s peak) driven by a slow
 *  per-angel sine — smooth, deterministic, no per-step randomness. */
const WANDER_RATE = 0.9;
const WANDER_FREQ_MIN = 0.25;
const WANDER_FREQ_SPREAD = 0.75;

/** Spawn spread: angels appear in the lower half of the tank (the
 *  plant zone) across its full width. */
const SPAWN_X_MARGIN = 80;
const SPAWN_BASEY_LOW = 0.45;
const SPAWN_BASEY_HIGH = 0.8;
/** Per-angel cruise speed as a fraction of the named ceiling:
 *  everyone swims UNDER the cap, never over it. */
const SPAWN_SPEED_MIN_FRACTION = 0.75;

/** A deterministic per-angel random draw (mulberry32 stream). */
type Rng = () => number;

/** One grazing angelfish. The first eight fields form the same
 *  spine-fish shape as a Tetra (position, velocity, tail phase,
 *  torque, heading), which is exactly what lets the render layer
 *  reuse the tetra spine renderer unchanged; the rest is the
 *  base-plane / bob state the step composes from. */
export class Angel {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Accumulated tail phase in radians (advances at
   *  tailFrequency(speed, torque), the tetra renderer's input). */
  phase: number;
  /** Smoothed turning torque, rad/s — the tail formula's input. */
  torque: number;
  /** Heading (radians) at the end of the previous step. */
  heading: number;

  /** Base altitude: the bob oscillates AROUND this, and ALL
   *  steering physics runs on (x, baseY) — y itself is rendered
   *  as baseY + ANGEL_BOB_AMP · sin(bobPhase). */
  baseY: number;
  /** Base-plane velocities (x and baseY); the rendered velocity is
   *  (baseVx, baseVy + bob velocity). */
  baseVx: number;
  baseVy: number;
  /** Bob oscillator phase in radians (advances by
   *  ANGEL_BOB_OMEGA · dt each step). */
  bobPhase: number;
  /** This angel's cruise speed, tank units/s — always ≤
   *  ANGEL_CRUISE_SPEED (fixed at spawn). */
  cruiseSpeed: number;
  /** Wander oscillator: angular rate (rad/s) and phase offset. */
  wanderFreq: number;
  wanderPhase: number;
  /** Unbounded cruise heading (radians): the wander integrates
   *  into it; only its cosine is used (cruise is horizontal). */
  cruiseHeading: number;
  /** Orbit direction (±1) of the graze ring, fixed at spawn so the
   *  circle keeps one handedness. */
  orbitDir: number;

  constructor(x: number, baseY: number, cruiseHeading: number, cruiseSpeed: number,
              bobPhase: number, wanderFreq: number, wanderPhase: number, orbitDir: number) {
    this.x = x;
    this.baseY = baseY;
    this.cruiseHeading = cruiseHeading;
    this.cruiseSpeed = cruiseSpeed;
    this.bobPhase = bobPhase;
    this.wanderFreq = wanderFreq;
    this.wanderPhase = wanderPhase;
    this.orbitDir = orbitDir;
    this.baseVx = Math.cos(cruiseHeading) * cruiseSpeed;
    this.baseVy = 0;
    this.y = baseY + ANGEL_BOB_AMP * Math.sin(bobPhase);
    this.vx = this.baseVx;
    this.vy = this.baseVy + ANGEL_BOB_AMP * ANGEL_BOB_OMEGA * Math.cos(bobPhase);
    this.phase = 0;
    this.torque = 0;
    this.heading = Math.atan2(this.vy, this.vx);
  }

  /** Advance this angel by exactly dt seconds against the world.
   *  Called by World.step AFTER the tetras (prey/food state is
   *  current). May set a live pellet's per-step claim flag on an
   *  in-contact eat — the same single-consume mechanism the tetra
   *  pass uses (later consumers in the same fixed step see the
   *  flag and pass). */
  step(dt: number, world: World): void {
    this.bobPhase += ANGEL_BOB_OMEGA * dt;
    const bobVy = ANGEL_BOB_AMP * ANGEL_BOB_OMEGA * Math.cos(this.bobPhase);

    // ---- 1. target selection: food > forage > cruise ----
    let pellet: { x: number; y: number; dead: boolean } | null = null;
    let pelletD = Infinity;
    if (world.pellets.length > 0) {
      for (const p of world.pellets) {
        if (p.dead) continue;
        // Convention (do not "fix" one side only): SENSE and EAT
        // distances are measured on the RENDERED y (bob-inclusive)
        // — the fish is physically at the flake it sees — while the
        // HOMING below steers on baseY. The two disagree by at most
        // ±ANGEL_BOB_AMP (14 u), which is harmless against the sense
        // (120 u) and eat (16 u) radii.
        const d = Math.hypot(p.x - this.x, p.y - this.y);
        if (d <= PELLET_SENSE_RADIUS && d < pelletD) {
          pelletD = d;
          pellet = p;
        }
      }
    }
    let eating = false;
    let dvx = 0;
    let dvy = 0;
    if (pellet !== null) {
      if (pelletD <= PELLET_EAT_RADIUS) {
        // Contact: the first in-contact consumer claims the pellet;
        // the flag keeps it single-use for the whole fixed step.
        pellet.dead = true;
        eating = true;
      } else {
        // Home in the BASE plane: full cruise speed outside the
        // arrive ball, decelerating inside it so the fish LANDS on
        // the flake instead of swinging past it (see
        // ANGEL_ARRIVE_RADIUS).
        const dx = pellet.x - this.x;
        const dy = pellet.y - this.baseY;
        const d = Math.max(Math.hypot(dx, dy), 1e-9);
        const arrive = Math.min(1, d / ANGEL_ARRIVE_RADIUS);
        const speed = this.cruiseSpeed * (0.5 + 0.5 * arrive);
        dvx = (dx / d) * speed;
        dvy = (dy / d) * speed;
      }
    }
    if (pellet === null) {
      const kelp = world.kelp;
      if (kelp.length > 0) {
        // Nearest kelp base (the substrate anchor), fixed order:
        // ties keep the earliest strand.
        let baseX = kelp[0]!.anchorX;
        let baseD = Infinity;
        for (const strand of kelp) {
          const d = Math.hypot(strand.anchorX - this.x, TANK_HEIGHT - this.baseY);
          if (d < baseD) {
            baseD = d;
            baseX = strand.anchorX;
          }
        }
        const dx = baseX - this.x;
        const dy = TANK_HEIGHT - this.baseY;
        const d = Math.max(Math.hypot(dx, dy), 1e-9);
        if (d > ANGEL_FORAGE_RADIUS) {
          // Outside the forage band: come IN at full speed.
          dvx = (dx / d) * this.cruiseSpeed;
          dvy = (dy / d) * this.cruiseSpeed;
        } else {
          // Inside: hover the graze ring — tangent at a fixed
          // handedness, plus a proportional radial pull back to
          // GRAZE_ORBIT_RADIUS (clamped to the cruise speed).
          const ux = (this.x - baseX) / d;
          const uy = (this.baseY - TANK_HEIGHT) / d;
          const pull = (GRAZE_ORBIT_RADIUS - d) * GRAZE_RADIAL_GAIN;
          const orbitSpeed = this.cruiseSpeed * GRAZE_ORBIT_SPEED_FRACTION;
          dvx = this.orbitDir * -uy * orbitSpeed + ux * pull;
          dvy = this.orbitDir * ux * orbitSpeed + uy * pull;
          const m = Math.hypot(dvx, dvy);
          if (m > this.cruiseSpeed) {
            dvx *= this.cruiseSpeed / m;
            dvy *= this.cruiseSpeed / m;
          }
        }
      } else {
        // Quiescent cruise: smooth horizontal wander, ZERO
        // base-vertical acceleration — the bob is the whole
        // vertical story here (baseY is frozen, see the module
        // header; pinned by the bob test).
        this.cruiseHeading +=
          WANDER_RATE * Math.sin(this.wanderFreq * world.time + this.wanderPhase) * dt;
        dvx = Math.cos(this.cruiseHeading) * this.cruiseSpeed;
        dvy = 0;
      }
    }

    // ---- 2. Reynolds steering in the base plane: an in-contact
    //         eat is a pure glide this step (no force — the fish
    //         coasts through; the next step picks a new mode). Food
    //         seeking runs at the priority gain; everything else
    //         steers at gain 1. ----
    const gain = pellet !== null && !eating ? ANGEL_SEEK_GAIN : 1;
    let ax = gain * (dvx - this.baseVx);
    let ay = gain * (dvy - this.baseVy);
    if (eating) {
      ax = 0;
      ay = 0;
    } else {
      const a = Math.hypot(ax, ay);
      if (a > ANGEL_MAX_STEER) {
        ax *= ANGEL_MAX_STEER / a;
        ay *= ANGEL_MAX_STEER / a;
      }
    }
    // #144 boundary band: angels steer away from the SIDE walls the
    // way tetras do (gain-1, the band's own master clamp) so a
    // cruising angel curves off the glass instead of grinding into
    // it and relying on the absorption net. X only: the vertical
    // story is the bob + the base-altitude clamp (unchanged —
    // pushing baseY would fight the forage behaviour pinned at
    // ANGEL_FORAGE_RADIUS). Inlined (the steering layer's
    // boundaryAvoidance allocates) — the angel path is
    // allocation-free, same as before #144.
    let bx = 0;
    if (this.x < BOUNDARY_MARGIN) bx += ((BOUNDARY_MARGIN - this.x) / BOUNDARY_MARGIN) * MAX_BOUNDARY_AVOIDANCE_FORCE;
    else if (this.x > TANK_WIDTH - BOUNDARY_MARGIN) bx -= ((this.x - (TANK_WIDTH - BOUNDARY_MARGIN)) / BOUNDARY_MARGIN) * MAX_BOUNDARY_AVOIDANCE_FORCE;
    ax += bx;
    this.baseVx += ax * dt;
    this.baseVy += ay * dt;

    // ---- 3. compose with the bob; enforce the cruise ceiling on
    //         the ACTUAL (rendered) speed ----
    let vx = this.baseVx;
    let vy = this.baseVy + bobVy;
    const speed = Math.hypot(vx, vy);
    if (speed > ANGEL_CRUISE_SPEED) {
      const s = ANGEL_CRUISE_SPEED / speed;
      vx *= s;
      vy *= s;
      // Re-derive the base-plane velocity from the clamped pair so
      // the next step's steering starts from the real state.
      this.baseVx = vx;
      this.baseVy = vy - bobVy;
    }

    // ---- 4. integrate (x, baseY), keep the tank as the final
    //         authority — #144: clamp + ABSORB the outward normal,
    //         never mirror it (an axis flip is banned across the
    //         sim; the boundary band below does the turning) ----
    let x = this.x + this.baseVx * dt;
    if (x < 0) {
      x = 0;
      if (this.baseVx < 0) this.baseVx = 0;
    } else if (x > TANK_WIDTH) {
      x = TANK_WIDTH;
      if (this.baseVx > 0) this.baseVx = 0;
    }
    let baseY = this.baseY + this.baseVy * dt;
    // The bob needs its full amplitude headroom at both walls, so
    // the BASE altitude is clamped to keep y itself in the tank.
    if (baseY < ANGEL_BOB_AMP) {
      baseY = ANGEL_BOB_AMP;
      if (this.baseVy < 0) this.baseVy = 0;
    } else if (baseY > TANK_HEIGHT - ANGEL_BOB_AMP) {
      baseY = TANK_HEIGHT - ANGEL_BOB_AMP;
      if (this.baseVy > 0) this.baseVy = 0;
    }

    // ---- 5. publish the rendered state + advance the tail ----
    this.x = x;
    this.baseY = baseY;
    this.y = baseY + ANGEL_BOB_AMP * Math.sin(this.bobPhase);
    this.vx = this.baseVx;
    this.vy = this.baseVy + bobVy;
    const finalSpeed = Math.hypot(this.vx, this.vy);
    const heading = finalSpeed > 1e-6 ? Math.atan2(this.vy, this.vx) : this.heading;
    const instantTorque = wrapPi(heading - this.heading) / dt;
    this.torque += TORQUE_SMOOTHING * (instantTorque - this.torque);
    this.heading = heading;
    this.phase += TAU * tailFrequency(finalSpeed, this.torque) * dt;
  }
}

/** Build the full angel pool of a world: one seeded stream
 *  (worldSeed + ANGEL_SEED_STRIDE) in a FIXED draw order per
 *  angel, so the same seed always yields the same independents.
 *  Positions spread across the lower half (the plant zone).
 *  A non-integer or negative count is refused (empty pool),
 *  mirroring setTetraCount's refusal. */
export function spawnAngels(worldSeed: number, count: number): Angel[] {
  if (!Number.isInteger(count) || count < 0) return [];
  const rng: Rng = mulberry32(worldSeed + ANGEL_SEED_STRIDE);
  const angels: Angel[] = [];
  for (let i = 0; i < count; i++) {
    const x = SPAWN_X_MARGIN + rng() * (TANK_WIDTH - 2 * SPAWN_X_MARGIN);
    const baseY = TANK_HEIGHT * (SPAWN_BASEY_LOW + (SPAWN_BASEY_HIGH - SPAWN_BASEY_LOW) * rng());
    const cruiseHeading = rng() * Math.PI;
    const cruiseSpeed =
      ANGEL_CRUISE_SPEED *
      (SPAWN_SPEED_MIN_FRACTION +
        (1 - SPAWN_SPEED_MIN_FRACTION) * rng());
    const bobPhase = rng() * TAU;
    const wanderFreq = WANDER_FREQ_MIN + WANDER_FREQ_SPREAD * rng();
    const wanderPhase = rng() * TAU;
    const orbitDir = rng() < 0.5 ? -1 : 1;
    angels.push(new Angel(x, baseY, cruiseHeading, cruiseSpeed,
                          bobPhase, wanderFreq, wanderPhase, orbitDir));
  }
  return angels;
}
