// ================================================================
// Apex predator state machine (PRD §2's third behaviour, ticket
// #124): patrol → stalk → feed → rest → patrol. Pure sim — no
// canvas, no DOM; the World owns the instance and steps it after
// the tetras on every fixed step.
//
//   patrol: cruise the named waypoint loop at PREDATOR_PATROL_SPEED
//     (arrival is a closed ball of PREDATOR_WAYPOINT_TOLERANCE; the
//     loop advances one stop per arrival, cyclically). Once hunger
//     is at or above PREDATOR_STALK_THRESHOLD, the nearest ISOLATED
//     tetra within PREDATOR_SIGHT_RANGE is locked and the flip to
//     stalk — and the first step of pursuit — happen in that SAME
//     step.
//   stalk:  chase the locked prey at PREDATOR_STALK_SPEED (deliber-
//     ately above TETRA_MAX_SPEED, so every chase closes). The lock
//     releases back to patrol if the prey ceases to be isolated.
//     Within PREDATOR_CAPTURE_RADIUS the prey is captured: removed
//     from the world, hunger resets to 0, and the predator enters
//     rest.
//   rest:   drift straight ahead at PREDATOR_REST_SPEED while the
//     PREDATOR_REST_STEPS countdown runs; the step that brings the
//     countdown to 0 is the boundary step and already executes as
//     a normal patrol step.
//
// Prey eligibility ("isolated"): a tetra is prey-eligible only when
// no other tetra lies within PREDATOR_ISOLATION_RADIUS — schools are
// safe, stragglers are not.
//
// Control law: direct kinematics — each step SETS the velocity to
// (heading direction) × (state speed), no inertia. That keeps the
// machine exact for the behavioural tests (patrol speed ceiling,
// monotone chase closure, fixed rest window) and allocation-free.
//
// Determinism: no random draws; prey selection scans agents in
// fixed array order with a strict distance comparison, so the same
// inputs pick the same prey. The only world mutation besides the
// predator itself is the capture splice.
// ================================================================

import type { World } from "./world.ts";
import type { Tetra } from "./world.ts";
import {
  PREDATOR_CAPTURE_RADIUS,
  PREDATOR_HUNGER_RATE,
  PREDATOR_ISOLATION_RADIUS,
  PREDATOR_PATROL_SPEED,
  PREDATOR_REST_SPEED,
  PREDATOR_REST_STEPS,
  PREDATOR_SIGHT_RANGE,
  PREDATOR_STALK_SPEED,
  PREDATOR_STALK_THRESHOLD,
  PREDATOR_WAYPOINT_TOLERANCE,
  TANK_HEIGHT,
  TANK_WIDTH,
} from "./constants.ts";

/** One named stop of the patrol loop, walked cyclically. */
export interface PatrolWaypoint {
  name: string;
  x: number;
  y: number;
}

/** The fixed patrol loop the predator walks each lap: four named
 *  waypoints around the middle of the tank (a 2400-unit lap). The
 *  names are part of the contract — tests assert visits by name. */
export const PREDATOR_PATROL_ROUTE: PatrolWaypoint[] = [
  { name: "north-west", x: 400, y: 300 },
  { name: "north-east", x: 1200, y: 300 },
  { name: "south-east", x: 1200, y: 700 },
  { name: "south-west", x: 400, y: 700 },
];

/** The spawn point: off the loop, mid-west — the first lap opens
 *  with the walk IN from the west wall onto the north-west stop. */
export const PREDATOR_SPAWN_X = 100;
export const PREDATOR_SPAWN_Y = 500;

/** The predator's behavioural state. */
export type PredatorState = "patrol" | "stalk" | "rest";

export class ApexPredator {
  x = PREDATOR_SPAWN_X;
  y = PREDATOR_SPAWN_Y;
  /** Velocity (direction AND speed) in tank units/s — direct
   *  kinematics: the step re-sets this from the state every time. */
  vx: number;
  vy: number;
  state: PredatorState = "patrol";
  /** Hunger in [0, 1]: rises at PREDATOR_HUNGER_RATE (even during
   *  rest), resets to 0 on a feed. */
  hunger = 0;
  /** Index into PREDATOR_PATROL_ROUTE of the stop currently being
   *  sought; advances on each arrival (cyclically). */
  waypointIndex = 0;
  /** The locked prey (a live reference into world.agents) or null.
   *  A non-null lock is always live: the only removal path is a
   *  capture, which nulls the lock in the same step. */
  prey: Tetra | null = null;
  /** Rest steps remaining: armed to PREDATOR_REST_STEPS on a feed,
   *  counts down during rest, hits 0 at the boundary step. */
  restRemaining = 0;
  /** How many tetras this predator has eaten (telemetry). */
  fedCount = 0;

  constructor() {
    // Born facing the first waypoint at patrol speed.
    const wp = PREDATOR_PATROL_ROUTE[0]!;
    const dx = wp.x - this.x;
    const dy = wp.y - this.y;
    const d = Math.hypot(dx, dy);
    this.vx = d > 0 ? (dx / d) * PREDATOR_PATROL_SPEED : PREDATOR_PATROL_SPEED;
    this.vy = d > 0 ? (dy / d) * PREDATOR_PATROL_SPEED : 0;
  }

  /** Advance the predator by exactly dt seconds against the world.
   *  Called by World.step AFTER the tetras have moved, so prey
   *  positions are current (the neighbor grid is rebuilt at the
   *  start of each step — the same one-step-stale view the tetras'
   *  own steering uses). May mutate world.agents: a capture splices
   *  the victim out. */
  step(dt: number, world: World): void {
    this.hunger = Math.min(1, this.hunger + PREDATOR_HUNGER_RATE * dt);

    let dirX: number;
    let dirY: number;
    let speed: number;

    let drifting = false;
    if (this.state === "rest") {
      this.restRemaining -= 1;
      if (this.restRemaining <= 0) {
        // Boundary step: the rest window is spent, and THIS step
        // already runs as a normal patrol step (resuming at full
        // speed toward the current waypoint).
        this.state = "patrol";
      } else {
        drifting = true;
      }
    }
    if (drifting) {
      // Coast straight at rest speed along the fed-through heading
      // (the walls flip it via the velocity below).
      const m = Math.hypot(this.vx, this.vy);
      dirX = m > 0 ? this.vx / m : 1;
      dirY = m > 0 ? this.vy / m : 0;
      speed = PREDATOR_REST_SPEED;
    } else {
      if (this.state === "patrol" && this.hunger >= PREDATOR_STALK_THRESHOLD) {
        const target = this.findPrey(world);
        if (target) {
          this.state = "stalk";
          this.prey = target;
        }
      }
      let prey = this.state === "stalk" ? this.prey : null;
      if (prey && !this.isIsolated(prey, world)) {
        // The prey slipped back into school: release the lock.
        this.prey = null;
        prey = null;
      }
      if (prey) {
        const dx = prey.x - this.x;
        const dy = prey.y - this.y;
        const d = Math.hypot(dx, dy);
        dirX = d > 0 ? dx / d : 1;
        dirY = d > 0 ? dy / d : 0;
        speed = PREDATOR_STALK_SPEED;
      } else {
        this.prey = null;
        this.state = "patrol";
        // Arrival on the current stop advances the loop; then seek
        // the stop now being sought.
        let i = this.waypointIndex;
        const wp = PREDATOR_PATROL_ROUTE[i]!;
        if (Math.hypot(wp.x - this.x, wp.y - this.y) <= PREDATOR_WAYPOINT_TOLERANCE) {
          i = (i + 1) % PREDATOR_PATROL_ROUTE.length;
          this.waypointIndex = i;
        }
        const next = PREDATOR_PATROL_ROUTE[i]!;
        const dx = next.x - this.x;
        const dy = next.y - this.y;
        const d = Math.hypot(dx, dy);
        dirX = d > 0 ? dx / d : 1;
        dirY = d > 0 ? dy / d : 0;
        speed = PREDATOR_PATROL_SPEED;
      }
    }

    // One capture point for every path: stalking within range eats.
    const victim = this.state === "stalk" ? this.prey : null;
    if (victim &&
        Math.hypot(victim.x - this.x, victim.y - this.y) <= PREDATOR_CAPTURE_RADIUS) {
      const at = world.agents.indexOf(victim);
      if (at >= 0) world.agents.splice(at, 1);
      this.prey = null;
      this.hunger = 0;
      this.fedCount += 1;
      this.state = "rest";
      this.restRemaining = PREDATOR_REST_STEPS;
      speed = PREDATOR_REST_SPEED; // settle: this step already drifts
    }

    this.vx = dirX * speed;
    this.vy = dirY * speed;
    let x = this.x + this.vx * dt;
    let y = this.y + this.vy * dt;
    // Elastic wall reflection, then a hard clamp as belt-and-braces
    // (same policy as the tetras): the predator cannot leave the
    // tank. Reflections flip the stored velocity, so the rest drift
    // bounces off walls and keeps going.
    if (x < 0) { x = -x; this.vx = -this.vx; } else if (x > TANK_WIDTH) { x = 2 * TANK_WIDTH - x; this.vx = -this.vx; }
    if (y < 0) { y = -y; this.vy = -this.vy; } else if (y > TANK_HEIGHT) { y = 2 * TANK_HEIGHT - y; this.vy = -this.vy; }
    if (x < 0) x = 0; else if (x > TANK_WIDTH) x = TANK_WIDTH;
    if (y < 0) y = 0; else if (y > TANK_HEIGHT) y = TANK_HEIGHT;
    this.x = x;
    this.y = y;
  }

  /** The nearest ISOLATED tetra within PREDATOR_SIGHT_RANGE, or
   *  null: fixed agents order with a strict best-distance scan, so
   *  the choice is deterministic (ties keep the earliest swimmer). */
  private findPrey(world: World): Tetra | null {
    let best: Tetra | null = null;
    let bestDist = PREDATOR_SIGHT_RANGE;
    for (const t of world.agents) {
      const d = Math.hypot(t.x - this.x, t.y - this.y);
      if (d >= bestDist) continue;
      if (!this.isIsolated(t, world)) continue;
      best = t;
      bestDist = d;
    }
    return best;
  }

  /** A tetra is prey-eligible ("isolated") only when no other
   *  tetra lies within PREDATOR_ISOLATION_RADIUS. Neighbourhood is
   *  answered by the world's spatial grid (PRD §1). */
  private isIsolated(t: Tetra, world: World): boolean {
    for (const n of world.grid.query(t.x, t.y, PREDATOR_ISOLATION_RADIUS)) {
      if (n !== t && Math.hypot(n.x - t.x, n.y - t.y) <= PREDATOR_ISOLATION_RADIUS) return false;
    }
    return true;
  }
}
