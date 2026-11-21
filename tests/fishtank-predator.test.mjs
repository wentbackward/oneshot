#!/usr/bin/env node
// ================================================================
// Unit tests — apex predator (ticket #124, PRD §2 third behaviour):
//  - PATROL: a satiated (never-hungry) predator walks the named
//    waypoint loop — it visits each named patrol waypoint within
//    PREDATOR_WAYPOINT_TOLERANCE in CYCLIC ORDER over a 600-step
//    soak, and its speed never exceeds PREDATOR_PATROL_SPEED;
//  - HUNGER / STALK: hunger rises at the named PREDATOR_HUNGER_RATE;
//    the state flips to `stalk` in the SAME STEP as hunger crossing
//    PREDATOR_STALK_THRESHOLD while a lone tetra is in sight, and
//    the predator closes on it — the distance to the prey strictly
//    DECREASES every frame of the chase;
//  - FEED + REST: on capture the tetra count drops by EXACTLY 1,
//    hunger resets to 0, and the predator rests for exactly
//    PREDATOR_REST_STEPS steps (no re-stalk before, slow-drift
//    speed during, normal patrol resumes AT the boundary step);
//  - RECENT FEED: a predator that has recently fed never re-stalks
//    even when a NEW isolated tetra sits in its sight (hunger stays
//    below the stalk threshold throughout the rest window);
//  - ISOLATION: prey eligibility is the lone-tetra rule — a tight
//    (non-isolated) cluster in sight never triggers stalk; leaving
//    exactly one tetra flips the state to `stalk` within 1 step and
//    the capture removes exactly that tetra;
//  - DETERMINISM: same-seed worlds replay byte-identical predator
//    trajectories through a full feed + rest cycle.
//
// Harness: stock node with flag-free .ts type-stripping imports the
// real src/sim sources; every world is seeded (no network, no
// wall-clock dependence).
//
// Run: node tests/fishtank-predator.test.mjs
// ================================================================
import { World } from "../src/sim/world.ts";
import { PREDATOR_PATROL_ROUTE } from "../src/sim/predator.ts";
import {
  FIXED_DT,
  PREDATOR_CAPTURE_RADIUS,
  PREDATOR_HUNGER_RATE,
  PREDATOR_ISOLATION_RADIUS,
  PREDATOR_PATROL_SPEED,
  PREDATOR_REST_SPEED,
  PREDATOR_REST_STEPS,
  PREDATOR_SIGHT_RANGE,
  PREDATOR_STALK_THRESHOLD,
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

/** A plain tetra-shaped agent (same shape World.spawn produces) so
 *  tests can seed the school by hand. */
function makeTetra(x, y, vx, vy) {
  return { x, y, vx, vy, phase: 0, torque: 0, heading: Math.atan2(vy, vx) };
}

/** Park the predator and a lone tetra at a controlled spacing with
 *  a given starting hunger; returns [world, predator, tetra]. */
function setupLonePrey(seed, predatorX, predatorY, tetraX, tetraY, tetraVx, tetraVy, hunger) {
  const world = new World({ seed, population: 1 });
  const p = world.predator;
  p.x = predatorX;
  p.y = predatorY;
  p.hunger = hunger;
  const t = world.agents[0];
  t.x = tetraX;
  t.y = tetraY;
  t.vx = tetraVx;
  t.vy = tetraVy;
  return [world, p, t];
}

/** Step until the predator feeds (or the cap is hit); returns the
 *  capture step number or -1. */
function runToCapture(world, cap) {
  for (let step = 1; step <= cap; step++) {
    world.step(FIXED_DT);
    if (world.agents.length === 0) return step;
  }
  return -1;
}

// ================================================================
// Criterion 1 — PATROL: a full (not-hungry) predator walks the
// named waypoint loop in cyclic order over 600 steps, never above
// PREDATOR_PATROL_SPEED
// ================================================================
check("patrol: a satiated predator visits each named waypoint in cyclic order (within tolerance) over 600 steps, speed ≤ PREDATOR_PATROL_SPEED", () => {
  const world = new World({ seed: 11, population: 0 }); // empty tank: nothing to hunt
  const p = world.predator;
  assert(p.state === "patrol", `a fresh predator must start in patrol, got ${p.state}`);
  const names = PREDATOR_PATROL_ROUTE.map((w) => w.name);
  assert(new Set(names).size === PREDATOR_PATROL_ROUTE.length,
    `the patrol route must carry DISTINCT waypoint names, got ${JSON.stringify(names)}`);

  const visited = [];
  let prevIndex = p.waypointIndex;
  let prevX = p.x;
  let prevY = p.y;
  for (let step = 1; step <= 600; step++) {
    world.step(FIXED_DT);
    const speed = Math.hypot(p.vx, p.vy);
    assert(speed <= PREDATOR_PATROL_SPEED + 1e-9,
      `step ${step}: speed ${speed} exceeded PREDATOR_PATROL_SPEED (${PREDATOR_PATROL_SPEED})`);
    if (p.waypointIndex !== prevIndex) {
      // The advance fired FROM the pre-step position (sim checks
      // arrival before moving), so that position must lie within
      // the tolerance of the waypoint that was just left.
      const wp = PREDATOR_PATROL_ROUTE[prevIndex];
      const d = Math.hypot(prevX - wp.x, prevY - wp.y);
      assert(d <= PREDATOR_WAYPOINT_TOLERANCE + 1e-9,
        `advance past "${wp.name}" from (${prevX}, ${prevY}) at ${d.toFixed(3)} — outside tolerance ${PREDATOR_WAYPOINT_TOLERANCE}`);
      visited.push(wp.name);
      prevIndex = p.waypointIndex;
    }
    prevX = p.x;
    prevY = p.y;
  }
  assert(p.state === "patrol", `with nothing to hunt it must still be patrolling, got ${p.state}`);
  const firstFour = PREDATOR_PATROL_ROUTE.map((w) => w.name);
  assert(JSON.stringify(visited.slice(0, 4)) === JSON.stringify(firstFour),
    `must visit each named waypoint in cyclic order within 600 steps, got ${JSON.stringify(visited)}`);
  assert(visited[4] === PREDATOR_PATROL_ROUTE[0].name,
    `the loop must CLOSE back onto the first waypoint in cyclic order, got visits ${JSON.stringify(visited)}`);
});

// ================================================================
// Criterion 2 — HUNGER / STALK: hunger rises at PREDATOR_HUNGER_RATE
// and the state flips to `stalk` in the same step as the threshold
// crossing while a lone tetra is in sight; the chase closes every
// frame (distance strictly decreasing)
// ================================================================
check("stalk: the state flips in the SAME STEP hunger crosses PREDATOR_STALK_THRESHOLD (lone tetra in sight) and the distance to the prey strictly decreases every frame", () => {
  const [world, p, t] = setupLonePrey(12, 400, 500, 700, 500, 50, 30, PREDATOR_STALK_THRESHOLD - 0.01);
  assert(Math.hypot(t.x - p.x, t.y - p.y) <= PREDATOR_SIGHT_RANGE,
    "test setup: the lone tetra must start in sight");
  let crossingStep = -1;
  let flipStep = -1;
  let captureStep = -1;
  let prevH = p.hunger;
  let prevD = Math.hypot(t.x - p.x, t.y - p.y);
  for (let step = 1; step <= 300; step++) {
    world.step(FIXED_DT);
    if (world.agents.length === 0) { captureStep = step; break; } // capture resets hunger: stop auditing the rise
    const dh = p.hunger - prevH;
    assert(Math.abs(dh - PREDATOR_HUNGER_RATE * FIXED_DT) <= 1e-9,
      `step ${step}: hunger rose by ${dh}, expected exactly PREDATOR_HUNGER_RATE × FIXED_DT (${PREDATOR_HUNGER_RATE * FIXED_DT})`);
    if (crossingStep < 0 && p.hunger >= PREDATOR_STALK_THRESHOLD) crossingStep = step;
    if (crossingStep < 0) assert(p.state === "patrol",
      `step ${step}: entered stalk BEFORE hunger crossed the threshold (hunger ${p.hunger})`);
    if (flipStep < 0 && p.state === "stalk") {
      flipStep = step;
      assert(p.prey === t, "the locked prey must be the lone tetra");
    }
    const d = Math.hypot(t.x - p.x, t.y - p.y);
    if (flipStep >= 0) {
      assert(d < prevD,
        `frame ${step} after the flip: distance to the lone tetra went ${prevD.toFixed(3)} → ${d.toFixed(3)}; the chase must close EVERY frame`);
    }
    prevD = d;
    prevH = p.hunger;
  }
  assert(crossingStep > 0, `hunger must cross PREDATOR_STALK_THRESHOLD within 300 steps (last ${prevH})`);
  assert(flipStep > 0, `the state must flip to stalk once hunger crosses, got flipStep ${flipStep}`);
  assert(flipStep <= crossingStep + 1,
    `the flip must land within 1 step of the crossing (crossed step ${crossingStep}, flipped step ${flipStep})`);
  assert(flipStep >= crossingStep, "the flip may not precede the crossing");
  assert(captureStep > flipStep, "the chase must close on the lone tetra");
});

// ================================================================
// Criterion 3 — FEED + REST: capture drops the tetra count by
// exactly 1, resets hunger, and the predator rests for EXACTLY
// PREDATOR_REST_STEPS steps (no re-stalk before, slow drift during,
// normal patrol resumes at the boundary step)
// ================================================================
check("feed+rest: capture drops the count by exactly 1, resets hunger, rests exactly PREDATOR_REST_STEPS steps; normal patrol resumes at the boundary step", () => {
  const [world, p] = setupLonePrey(13, 460, 500, 500, 500, 0, 30, 0.99);
  assert(world.agents.length === 1, "test setup");
  const captureStep = runToCapture(world, 30);
  assert(captureStep > 0, "the chase must capture the lone tetra within 30 steps");
  assert(world.agents.length === 0, "capture must remove exactly 1 tetra from a population of 1");
  assert(p.state === "rest", `must enter rest on the capture step (step ${captureStep}), got ${p.state}`);
  assert(p.hunger === 0, `hunger must reset to 0 on the capture step, got ${p.hunger}`);
  assert(p.restRemaining === PREDATOR_REST_STEPS,
    `rest must be armed for PREDATOR_REST_STEPS (${PREDATOR_REST_STEPS}) steps, got ${p.restRemaining}`);
  for (let k = 1; k <= PREDATOR_REST_STEPS; k++) {
    world.step(FIXED_DT);
    const speed = Math.hypot(p.vx, p.vy);
    assert(world.agents.length === 0, `rest step ${k}: no new prey exists, the count must stay 0`);
    if (k < PREDATOR_REST_STEPS) {
      assert(p.state === "rest", `rest step ${k}/${PREDATOR_REST_STEPS}: left rest early (no re-stalk allowed before the boundary), got ${p.state}`);
      assert(speed > 0, `rest step ${k}: the predator must still drift, not stall`);
      assert(speed <= PREDATOR_REST_SPEED + 1e-9,
        `rest step ${k}: drift speed ${speed} exceeds PREDATOR_REST_SPEED (${PREDATOR_REST_SPEED})`);
    } else {
      assert(p.state === "patrol",
        `the BOUNDARY step (rest ${k}/${PREDATOR_REST_STEPS}) must resume normal patrol, got ${p.state}`);
      assert(Math.abs(speed - PREDATOR_PATROL_SPEED) <= 1e-9,
        `the boundary step must patrol at full speed, got ${speed}`);
    }
  }
  // A few steps past the boundary: still a healthy patrol.
  for (let step = 1; step <= 30; step++) {
    world.step(FIXED_DT);
    assert(p.state === "patrol", `step ${step} past rest: must stay in patrol, got ${p.state}`);
    assert(Math.hypot(p.vx, p.vy) <= PREDATOR_PATROL_SPEED + 1e-9,
      `step ${step} past rest: back inside the patrol speed cap`);
  }
});

// ================================================================
// Criterion 4 — RECENT FEED: a predator that has recently fed never
// re-stalks during its rest window (hunger below threshold
// throughout), even with a NEW isolated tetra in its sight
// ================================================================
check("recent feed: a fed predator never re-stalks while its rest-window + recovery hunger stays below the threshold, even with a new isolated tetra in sight", () => {
  const [world, p] = setupLonePrey(14, 460, 500, 500, 500, 0, 30, 0.99);
  const captureStep = runToCapture(world, 30);
  assert(captureStep > 0, "test setup: the predator must feed first");
  // A brand-new isolated tetra, parked in sight of the resting
  // predator — well out of capture range.
  const newcomer = makeTetra(Math.max(40, p.x - 150), p.y, 30, 0);
  world.agents.push(newcomer);
  assert(Math.hypot(newcomer.x - p.x, newcomer.y - p.y) <= PREDATOR_SIGHT_RANGE,
    "test setup: the newcomer must sit in sight of the resting predator");
  assert(Math.hypot(newcomer.x - p.x, newcomer.y - p.y) > PREDATOR_CAPTURE_RADIUS,
    "test setup: the newcomer must not be in immediate capture range");
  const WINDOW = PREDATOR_REST_STEPS + 240; // the whole rest + 4 s of patrol recovery
  let maxHunger = 0;
  for (let k = 1; k <= WINDOW; k++) {
    world.step(FIXED_DT);
    maxHunger = Math.max(maxHunger, p.hunger);
    assert(p.state !== "stalk",
      `step ${k} after the feed: the recently-fed predator re-stalked (hunger ${p.hunger}, threshold ${PREDATOR_STALK_THRESHOLD})`);
  }
  assert(maxHunger < PREDATOR_STALK_THRESHOLD,
    `hunger must stay below the stalk threshold across the whole window, peaked at ${maxHunger}`);
  assert(world.agents.length === 1 && world.agents[0] === newcomer,
    "the newcomer must survive the whole window untouched");
});

// ================================================================
// Supporting criterion — ISOLATION: prey eligibility is the
// lone-tetra rule. A tight cluster in sight never triggers stalk;
// once exactly one tetra is left (isolated, in sight), the flip is
// immediate and the capture removes exactly that tetra
// ================================================================
check("isolation: a tight (non-isolated) cluster in sight never triggers stalk; a lone survivor flips stalk within 1 step and is the only one captured", () => {
  const world = new World({ seed: 15, population: 0 });
  const p = world.predator;
  p.hunger = 1;
  const a = makeTetra(490, 460, 30, 0);
  const b = makeTetra(490, 520, 30, 0);
  const c = makeTetra(550, 490, 30, 0);
  world.agents.push(a, b, c);
  for (const t of world.agents) {
    for (const u of world.agents) {
      if (t !== u) assert(Math.hypot(t.x - u.x, t.y - u.y) <= PREDATOR_ISOLATION_RADIUS,
        "test setup: the cluster must be tighter than PREDATOR_ISOLATION_RADIUS");
    }
  }
  assert(Math.hypot(490 - p.x, 470 - p.y) <= PREDATOR_SIGHT_RANGE,
    "test setup: the cluster must start in sight");
  for (let step = 1; step <= 60; step++) {
    world.step(FIXED_DT);
    assert(world.agents.length === 3, `step ${step}: test setup integrity — the cluster must stay intact`);
    assert(p.state === "patrol", `step ${step}: a NON-ISOLATED cluster must never trigger stalk`);
  }
  // Leave exactly one tetra: the survivor is now isolated and in sight.
  world.agents.splice(0, 2);
  assert(world.agents[0] === c, "test setup: the lone survivor is c");
  let flipStep = -1;
  for (let step = 1; step <= 10; step++) {
    world.step(FIXED_DT);
    if (p.state === "stalk") { flipStep = step; break; }
  }
  assert(flipStep <= 1,
    `with an isolated tetra in sight and full hunger, the flip must land within 1 step (flipped step ${flipStep})`);
  assert(p.prey === c, "the locked prey must be the lone survivor");
  const captureStep = runToCapture(world, 120);
  assert(captureStep > 0, "the lone survivor must be captured");
  assert(world.agents.length === 0, "capture must remove exactly 1 tetra");
});

// ================================================================
// Determinism (contract inherited from tickets #119/#120): same
// seed + same setup ⇒ byte-identical trajectories, predator state
// included (serialized), through a full feed + rest cycle
// ================================================================
check("determinism: two same-seed worlds replay byte-identical predator trajectories through a feed + rest cycle", () => {
  const setup = (seed) => setupLonePrey(seed, 460, 500, 500, 500, 0, 30, 0.99);
  const a = setup(99);
  const b = setup(99);
  for (let i = 0; i < 600; i++) { a.step(FIXED_DT); b.step(FIXED_DT); }
  assert(a[1].fedCount === 1, "test setup: the 600-step soak must include a feed");
  assert(a.serializeState() === b.serializeState(),
    "same seed + same predator setup must replay byte-identical state (predator included)");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
