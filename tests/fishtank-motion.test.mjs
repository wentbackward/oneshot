#!/usr/bin/env node
// ================================================================
// Unit tests — schooling motion overhaul (ticket #144, PRD §2):
// fish-like continuous motion instead of billiard-ball bounces.
//
//   AC1 no axis-mirrors:    a 1000-step default-population run
//     must contain no magnitude-preserving velocity-component sign
//     flip across a wall contact (the elastic reflection), and a
//     constructed wall contact must absorb the outward normal
//     (never mirror it).
//   AC2 turn smoothness:    max |Δheading| per step over a run
//     stays under the named TETRA_TURN_RATE_RAD_S × FIXED_DT cap.
//   AC4 species verticals:  lone tetra sinks slowly (net negative
//     buoyancy), rises under thrust (lift > gravity at high
//     speed), angels hold altitude, predator holds patrol depth.
//
// Startle scatter speed is covered by the EXISTING suite
// (tests/fishtank-tetras.test.mjs — 60 frames of positive radial
// velocity), which must stay green unmodified.
//
// Harness: stock node with flag-free .ts type-stripping imports the
// real src/sim sources; no network, no wall-clock dependence.
//
// Run: node tests/fishtank-motion.test.mjs
// ================================================================
import { World, TANK_WIDTH, TANK_HEIGHT } from "../src/sim/world.ts";
import { PREDATOR_PATROL_ROUTE } from "../src/sim/predator.ts";
import {
  FIXED_DT,
  TETRA_GRAVITY,
  TETRA_MAX_SPEED,
  TETRA_MIN_SPEED,
  TETRA_THRUST_LIFT,
  TETRA_TURN_RATE_RAD_S,
  PREDATOR_WAYPOINT_TOLERANCE,
} from "../src/sim/constants.ts";

// ---------- tiny test harness (house style) ----------
let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${name}\n       ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const wrapPi = (a) => {
  a %= Math.PI * 2;
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const CAP = TETRA_TURN_RATE_RAD_S * FIXED_DT; // max |Δheading| per fixed step

/** Poke a lone-tetra world's fish to an exact state (test
 *  scenarios), then refresh the derived grid so the next step's
 *  queries see the poked configuration — the documented out-of-
 *  world mutation policy (World.rebuildGrid). */
function pokeLone(world, x, y, vx, vy) {
  const t = world.agents[0];
  t.x = x; t.y = y; t.vx = vx; t.vy = vy;
  t.heading = Math.atan2(vy, vx);
  t.torque = 0;
  world.rebuildGrid();
  return t;
}

// ================================================================
// AC1: no axis-mirrors — in a 1000-step run at default population
// a velocity-component sign change across a wall contact must
// never PRESERVE the component's magnitude. The old elastic
// reflection (+195 → −193 at the wall, per the #144 baseline
// evidence) is exactly such a magnitude-preserving flip and is
// the root cause of the right angles. Shrinking the outward
// normal to zero (the documented safety-net ABSORPTION — ratio 0)
// and steering-turn zero crossings (tiny, gradual flips while the
// heading passes through perpendicular) are not mirrors.
// ================================================================
// A flip that keeps ≥ MIRROR_RATIO of its magnitude is a
// reflection: measured reflections preserve ~100% (195 → −193),
// steering zero crossings keep a sliver (heading just past
// perpendicular), the safety net keeps 0. The flip must also be a
// flip of a MEANINGFUL normal component (≥ NORMAL_FRACTION of the
// speed): a fish riding the glass after a startle slides with its
// heading rocking a couple of degrees around perpendicular, and
// its ~1-u/s sideways wobble (≈ 2 % of a 50 u/s slide) flipping
// sign is organic wall-sliding, not a billiard-ball bounce — a real
// reflection flips the component that CARRIES the motion.
const MIRROR_RATIO = 0.7;
const NORMAL_FRACTION = 0.25;
// The wall band recognizing a "contact": ≥ 2× the max per-step
// overshoot (TETRA_MAX_SPEED × FIXED_DT ≈ 3.7), so both a
// reflection bounce (lands back inside at ≤ 2× overshoot) and the
// safety-net clamp (lands exactly on the wall) count.
const WALL_BAND = 8;

check("1000 steps, default population: no velocity component axis-mirrors across a wall contact", () => {
  const world = new World(); // TETRA_COUNT tetras + angels + predator
  const prev = new Map();
  let contacts = 0;
  for (let i = 0; i < 1000; i++) {
    // Two tap-glass startles: flinging the school toward the walls
    // is what drives fish INTO the wall band (and occasionally past
    // it, exercising the safety net) — a passive soak with the
    // boundary band in place rarely touches glass at all.
    if (i === 250) world.tapGlass(120, TANK_HEIGHT / 2);
    if (i === 700) world.tapGlass(TANK_WIDTH - 120, TANK_HEIGHT / 2);
    for (const t of world.agents) prev.set(t, { x: t.x, y: t.y, vx: t.vx, vy: t.vy });
    world.step(FIXED_DT);
    for (const t of world.agents) {
      const p = prev.get(t);
      const atSideWall = t.x <= WALL_BAND || t.x >= TANK_WIDTH - WALL_BAND;
      const atTopBot = t.y <= WALL_BAND || t.y >= TANK_HEIGHT - WALL_BAND;
      if (!atSideWall && !atTopBot) continue;
      contacts += 1;
      const flipX = Math.sign(p.vx) !== 0 && Math.sign(t.vx) === -Math.sign(p.vx);
      const flipY = Math.sign(p.vy) !== 0 && Math.sign(t.vy) === -Math.sign(p.vy);
      if (atSideWall && flipX && Math.abs(p.vx) >= NORMAL_FRACTION * Math.hypot(p.vx, p.vy)
          && Math.abs(t.vx) >= MIRROR_RATIO * Math.abs(p.vx)) {
        throw new Error(`step ${i}: x-component axis-mirrored at a side wall ` +
          `(${p.vx.toFixed(1)} -> ${t.vx.toFixed(1)}) at x=${t.x.toFixed(1)}`);
      }
      if (atTopBot && flipY && Math.abs(p.vy) >= NORMAL_FRACTION * Math.hypot(p.vx, p.vy)
          && Math.abs(t.vy) >= MIRROR_RATIO * Math.abs(p.vy)) {
        throw new Error(`step ${i}: y-component axis-mirrored at a top/bottom wall ` +
          `(${p.vy.toFixed(1)} -> ${t.vy.toFixed(1)}) at y=${t.y.toFixed(1)}`);
      }
    }
  }
  // The soak must actually have exercised the walls (otherwise the
  // property is vacuous for this seed/population).
  assert(contacts > 20, `soak sanity: expected wall-band contacts, saw ${contacts}`);
  // Belt-and-braces: no fish left the tank.
  for (const t of world.agents) {
    assert(t.x >= 0 && t.x <= TANK_WIDTH && t.y >= 0 && t.y <= TANK_HEIGHT,
      `tetra escaped the tank: (${t.x}, ${t.y})`);
  }
  console.log(`     (wall-band contacts observed in soak: ${contacts}, mirrors: 0)`);
});

// ================================================================
// AC1 (constructed safety net): a tetra driven straight into a wall
// at full speed must land ON the wall with the outward normal
// ABSORBED (shrunk toward zero) — never mirrored — and the heading
// delta of the contact step stays under the turn-rate cap.
// ================================================================
check("constructed wall contact: outward normal is absorbed, not mirrored", () => {
  // Right wall, full outward speed with a tangential component.
  const wr = new World({ seed: 5, population: 1, predator: false, angels: 0 });
  const tr = pokeLone(wr, TANK_WIDTH - 1, 500, TETRA_MAX_SPEED, 20);
  wr.step(FIXED_DT);
  assert(tr.x === TANK_WIDTH,
    `the safety net must clamp the fish exactly on the wall, got x=${tr.x}`);
  assert(tr.vx >= 0,
    `the outward normal must be absorbed (shrink toward 0), never mirrored: was ${TETRA_MAX_SPEED}, got ${tr.vx}`);
  assert(Math.abs(wrapPi(tr.heading - Math.atan2(20, TETRA_MAX_SPEED))) <= CAP + 1e-9,
    `the contact step's heading change must stay under the named cap`);
  assert(tr.vx <= TETRA_MAX_SPEED, "velocity must not grow on contact");
  // Bottom wall, full outward speed.
  const wb = new World({ seed: 6, population: 1, predator: false, angels: 0 });
  const tb = pokeLone(wb, 800, TANK_HEIGHT - 1, 20, TETRA_MAX_SPEED);
  for (let i = 0; i < 1; i++) wb.step(FIXED_DT);
  assert(tb.y === TANK_HEIGHT,
    `the safety net must clamp the fish exactly on the bottom wall, got y=${tb.y}`);
  assert(tb.vy >= 0,
    `the outward normal must be absorbed (shrink toward 0), never mirrored: was ${TETRA_MAX_SPEED}, got ${tb.vy}`);
});

// ================================================================
// AC2: turn smoothness — measured max |Δheading| per step over a
// run stays under the named cap, so every trajectory is a
// continuous curve (the before-evidence: the OLD code peaked at
// 140°/step, with 160 >90° steps in exactly this run).
// ================================================================
check("1000 steps, default population: max |Δheading| per step stays under the named turn-rate cap", () => {
  const world = new World();
  const prev = new Map();
  let maxDh = 0;
  let worst = null;
  for (let i = 0; i < 1000; i++) {
    for (const t of world.agents) prev.set(t, t.heading);
    world.step(FIXED_DT);
    for (const t of world.agents) {
      const dh = Math.abs(wrapPi(t.heading - prev.get(t)));
      if (dh > maxDh) { maxDh = dh; worst = { i, t }; }
    }
  }
  assert(maxDh <= CAP + 1e-9,
    `max |Δheading| per step must stay under ${CAP} rad (${(CAP * 180 / Math.PI).toFixed(2)}°), got ${maxDh} rad ` +
    `(${(maxDh * 180 / Math.PI).toFixed(1)}°) at step ${worst?.i}`);
  // The school must still move (a "fix" that freezes the fish is not
  // a schooling motion overhaul): mean speed stays well above stall.
  const meanSpeed = world.agents.reduce((s, t) => s + Math.hypot(t.vx, t.vy), 0) / world.agents.length;
  assert(meanSpeed > TETRA_MIN_SPEED * 1.5,
    `the school must keep swimming: mean speed ${meanSpeed} tank units/s`);
  console.log(`     (measured max |Δheading|/step: ${(maxDh * 180 / Math.PI).toFixed(2)}°)`);
});

// ================================================================
// AC4 species vertical behaviour: the school has a VERTICAL STORY —
// it sags under its own weight and climbs when it thrusters.
// ================================================================
check("lone tetra in open water sinks slowly: net vertical drift is downward and gains downward speed", () => {
  const world = new World({ seed: 7, population: 1, predator: false, angels: 0 });
  // Start with a vertical (downward, +y) velocity so the wander
  // force — perpendicular to the heading — acts HORIZONTALLY and
  // cannot contaminate the vertical reading.
  const t = pokeLone(world, TANK_WIDTH / 2, TANK_HEIGHT / 2, 0, TETRA_MIN_SPEED);
  const y0 = t.y;
  const vy0 = t.vy;
  const N = 180; // 3 s
  let speedSum = 0;
  for (let i = 0; i < N; i++) {
    world.step(FIXED_DT);
    speedSum += Math.hypot(t.vx, t.vy);
  }
  const drift = t.y - y0;
  const gainedVy = t.vy - vy0;
  assert(drift > 30,
    `net negative buoyancy: a lone tetra must SAG over 3 s (drift ${drift.toFixed(1)} tank units, want > 30)`);
  assert(gainedVy > 8,
    `gravity must WIN at low effort: downward speed must grow by > 8 tank units/s over 3 s, got ${gainedVy.toFixed(1)}`);
  assert(speedSum / N < TETRA_MAX_SPEED * 0.75,
    `the sink must be SLOW — a steady plunge at near-max speed is not "sink slowly": mean speed ${(speedSum / N).toFixed(1)}`);
});

check("lone tetra under thrust climbs: high speed reverses the net vertical acceleration", () => {
  const N = 60;
  // Full-speed burst: lift (TETRA_THRUST_LIFT at high speed) must
  // beat TETRA_GRAVITY, so the downward speed DECAYS.
  const fast = new World({ seed: 8, population: 1, predator: false, angels: 0 });
  const t2 = pokeLone(fast, TANK_WIDTH / 2, TANK_HEIGHT / 2, 0, TETRA_MAX_SPEED - 10);
  const vy0 = t2.vy;
  for (let i = 0; i < N; i++) fast.step(FIXED_DT);
  const fastDelta = t2.vy - vy0;
  assert(fastDelta < -0.5 * N * 0.05,
    `a thrusting tetra must LOSE downward speed (lift > gravity at high speed): Δvy=${fastDelta} over 1 s, want negative`);
  // Idle speed: gravity must win, so the downward speed GROWS.
  const slow = new World({ seed: 9, population: 1, predator: false, angels: 0 });
  const t3 = pokeLone(slow, TANK_WIDTH / 2, TANK_HEIGHT / 2, 0, TETRA_MIN_SPEED + 5);
  const vy1 = t3.vy;
  for (let i = 0; i < N; i++) slow.step(FIXED_DT);
  const slowDelta = t3.vy - vy1;
  assert(slowDelta > 0.5 * N * 0.05,
    `a low-effort tetra must gain downward speed (gravity wins at cruise): Δvy=${slowDelta} over 1 s, want positive`);
  assert(TETRA_THRUST_LIFT > TETRA_GRAVITY,
    "the thrust-lift ceiling must exceed gravity, or no speed can climb back up");
});

// ================================================================
// AC4 angel vertical: the grazing angel HOLDS ALTITUDE — a
// quiescent angel's base altitude drifts only a few tank units
// over a 300-step soak (the bob, pinned separately, is its entire
// vertical story).
// ================================================================
check("quiescent angels hold altitude: baseY drift stays in a small band over 300 steps", () => {
  const world = new World({ seed: 10 }); // no kelp, no pellets: quiescent
  const start = new Map(world.angels.map((a) => [a, a.baseY]));
  for (let i = 0; i < 300; i++) world.step(FIXED_DT);
  for (const a of world.angels) {
    const drift = Math.abs(a.baseY - start.get(a));
    assert(drift <= 10,
      `a quiescent angel must hold its altitude: baseY drifted ${drift} tank units over 5 s, band is 10`);
  }
});

// ================================================================
// AC4 predator vertical: the predator holds its PATROL DEPTH —
// while patrolling its y stays inside the named route's depth
// band (the route defines the depths; nothing sinks, nothing climbs).
// ================================================================
check("predator holds patrol depth: y stays inside the route band while patrolling", () => {
  const world = new World({ seed: 11 }); // default population; predator hungry but below the 0.7 threshold for 10 s
  const ys = PREDATOR_PATROL_ROUTE.map((wp) => wp.y);
  const yMin = Math.min(...ys) - PREDATOR_WAYPOINT_TOLERANCE;
  const yMax = Math.max(...ys) + PREDATOR_WAYPOINT_TOLERANCE;
  let patrolSamples = 0;
  for (let i = 0; i < 600; i++) {
    world.step(FIXED_DT);
    const p = world.predator;
    assert(p !== null, "the default world must own its predator");
    if (p.state === "patrol") {
      patrolSamples += 1;
      assert(p.y >= yMin && p.y <= yMax,
        `the patrolling predator must hold its route's depth band [${yMin}, ${yMax}]: y=${p.y.toFixed(1)} at step ${i}`);
    }
  }
  assert(patrolSamples > 500,
    `the predator must spend the soak patrolling (hunger 0.6 < 0.7), got ${patrolSamples}/600 patrol samples`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
