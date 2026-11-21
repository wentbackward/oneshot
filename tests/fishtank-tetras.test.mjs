#!/usr/bin/env node
// ================================================================
// Unit tests — schooling tetras (ticket #120, PRD §1/§2/§5):
//  - the default World spawns TETRA_COUNT schooling tetras that
//    swim cohesively via the steering forces and STAY INSIDE the
//    tank (no escapes, no NaNs, ever);
//  - the pure sim API `startleAt(x, y)` gives every tetra within
//    STARTLE_RADIUS an outward impulse; for the 60 frames after
//    the event the school's MEAN RADIAL VELOCITY away from
//    (x, y) is positive, while tetras outside the radius are
//    untouched;
//  - determinism is preserved: same seed ⇒ identical trajectory,
//    different seed ⇒ different trajectory.
//
// Harness: stock node with flag-free .ts type-stripping imports the
// real src/sim sources; every world is seeded (no network, no
// wall-clock dependence).
//
// Run: node tests/fishtank-tetras.test.mjs
// ================================================================
import { TANK_WIDTH, TANK_HEIGHT, World } from "../src/sim/world.ts";
import { FIXED_DT, TETRA_COUNT, STARTLE_RADIUS } from "../src/sim/constants.ts";

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

// ---------- world helpers ----------

function stepN(world, n) {
  for (let i = 0; i < n; i++) world.step(FIXED_DT);
}

/** Mean distance of the school from its own centroid (compactness). */
function meanRadius(world) {
  let cx = 0, cy = 0;
  for (const t of world.tetras) { cx += t.x; cy += t.y; }
  cx /= world.tetras.length;
  cy /= world.tetras.length;
  let r = 0;
  for (const t of world.tetras) r += Math.hypot(t.x - cx, t.y - cy);
  return r / world.tetras.length;
}

/** Assert every tetra is finite and inside the tank bounds (closed). */
function assertAllInBounds(world, label) {
  for (const [i, t] of world.tetras.entries()) {
    assert(Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.vx) && Number.isFinite(t.vy),
      `${label}: tetra ${i} went non-finite at (${t.x}, ${t.y})`);
    assert(t.x >= 0 && t.x <= TANK_WIDTH && t.y >= 0 && t.y <= TANK_HEIGHT,
      `${label}: tetra ${i} escaped the tank at (${t.x}, ${t.y})`);
  }
}

/** Mean radial velocity of the school away from (x, y). */
function meanRadialVelocity(world, x, y) {
  let sum = 0;
  let counted = 0;
  for (const t of world.tetras) {
    const dx = t.x - x;
    const dy = t.y - y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-9) continue; // a tetra exactly on the epicentre casts no radial vote
    sum += (t.vx * dx + t.vy * dy) / d;
    counted += 1;
  }
  assert(counted > 0, "no tetra lies off the epicentre: the radial mean is undefined");
  return sum / counted;
}

// ================================================================
// Criterion (supporting): the default World IS a tetra school of
// the exported TETRA_COUNT, born inside the tank
// ================================================================
check("a default World spawns TETRA_COUNT schooling tetras, all inside the tank", () => {
  const world = new World();
  assert(typeof TETRA_COUNT === "number" && Number.isInteger(TETRA_COUNT) && TETRA_COUNT > 0,
    `TETRA_COUNT must be a positive integer, got ${TETRA_COUNT}`);
  assert(world.tetras.length === TETRA_COUNT,
    `the default population must be TETRA_COUNT (${TETRA_COUNT}), got ${world.tetras.length}`);
  assertAllInBounds(world, "at spawn");
  // Every tetra is a real swimmer with a positive cruise speed.
  for (const t of world.tetras) {
    assert(Math.hypot(t.vx, t.vy) > 0, "a spawned tetra must already be swimming");
  }
});

// ================================================================
// Criterion: the school SWIMS COHESIVELY — the mean distance from
// the school centroid tightens over time (no dispersal)
// ================================================================
check("the tetra school tightens: after 300 fixed steps the mean radius from the centroid shrank", () => {
  const world = new World({ seed: 7 });
  const r0 = meanRadius(world);
  assert(r0 > 20, `test setup: the fresh spawn must not be pre-coalesced (r0=${r0})`);
  for (let step = 0; step < 300; step++) {
    world.step(FIXED_DT);
    if (step % 30 === 0) assertAllInBounds(world, `during cohesion soak, step ${step}`);
  }
  const r1 = meanRadius(world);
  assert(r1 < r0 * 0.8,
    `the school must swim cohesively: mean radius after 5 s must shrink below 0.8× initial (${r1} vs ${r0})`);
  assert(r1 < 160,
    `the school must stay a compact ball, not a smeared crowd (mean radius ${r1} tank units)`);
});

// ================================================================
// Criterion: STAYS INSIDE THE TANK — a long soak with a startle
// mid-run: every sampled tetra, every step, finite and in bounds
// ================================================================
check("soak: 600 fixed steps (with two startles) — no tetra ever leaves the tank or goes non-finite", () => {
  const world = new World({ seed: 13, population: 150 });
  world.startleAt(TANK_WIDTH * 0.25, TANK_HEIGHT * 0.3);
  stepN(world, 300);
  world.startleAt(TANK_WIDTH * 0.75, TANK_HEIGHT * 0.7);
  for (let step = 0; step < 300; step++) {
    world.step(FIXED_DT);
    if (step < 60 || step % 50 === 0) assertAllInBounds(world, `soak step ${step}`);
  }
  assertAllInBounds(world, "soak end");
});

// ================================================================
// Criterion: startleAt(x, y) — every tetra within STARTLE_RADIUS
// receives an outward impulse; for the 60 frames AFTER the event
// the mean radial velocity away from (x, y) is positive
// ================================================================
check("startleAt: for 60 consecutive frames the school's mean radial velocity away from the epicentre is positive", () => {
  const world = new World({ seed: 21 });
  const cx = TANK_WIDTH / 2;
  const cy = TANK_HEIGHT / 2;
  world.startleAt(cx, cy); // the default school spawns around the tank centre
  for (let frame = 1; frame <= 60; frame++) {
    world.step(FIXED_DT);
    const v = meanRadialVelocity(world, cx, cy);
    assert(v > 0,
      `frame ${frame} after startle: mean radial velocity must be positive (outward), got ${v}`);
    assertAllInBounds(world, `post-startle frame ${frame}`);
  }
});

check("startleAt: the number of startled tetras equals the count independently measured within STARTLE_RADIUS", () => {
  const world = new World({ seed: 23 });
  const x = TANK_WIDTH / 2;
  const y = TANK_HEIGHT / 2;
  let expected = 0;
  for (const t of world.tetras) {
    if (Math.hypot(t.x - x, t.y - y) <= STARTLE_RADIUS) expected += 1;
  }
  assert(expected > 0, "test setup: the epicentre must catch at least one tetra");
  const startled = world.startleAt(x, y);
  assert(startled === expected,
    `startleAt must report exactly the tetras within STARTLE_RADIUS (${STARTLE_RADIUS}), got ${startled}, expected ${expected}`);
  // The outward impulse must actually show up in velocity.
  const cx = world.tetras.reduce((s, t) => s + t.vx, 0) / world.tetras.length;
  const cy2 = world.tetras.reduce((s, t) => s + t.vy, 0) / world.tetras.length;
  assert(Math.hypot(cx, cy2) < 260, "the impulse must stay a sane speed kick, not an explosion");
});

check("startleAt outside the school: no tetra is within STARTLE_RADIUS → zero startled, state byte-identical", () => {
  const world = new World({ seed: 29 });
  const before = world.serializeState();
  // Hunt a corner where nothing swims: scan corners until one is quiet.
  const corners = [[0, 0], [TANK_WIDTH, 0], [0, TANK_HEIGHT], [TANK_WIDTH, TANK_HEIGHT]];
  const spot = corners.find(([x, y]) =>
    world.tetras.every((t) => Math.hypot(t.x - x, t.y - y) > STARTLE_RADIUS));
  assert(spot, "test setup: at least one tank corner must be free of the spawn cluster");
  assert(world.startleAt(spot[0], spot[1]) === 0, "a startle that catches nothing must report 0");
  assert(world.serializeState() === before, "a startle that catches nothing must not touch any state");
});

check("startleAt rejects non-finite coordinates: no-op, reports 0, state untouched", () => {
  const world = new World({ seed: 31 });
  const before = world.serializeState();
  assert(world.startleAt(Number.NaN, TANK_HEIGHT / 2) === 0, "NaN x must be rejected with a 0 report");
  assert(world.startleAt(TANK_WIDTH / 2, Infinity) === 0, "Infinity y must be rejected with a 0 report");
  assert(world.serializeState() === before, "a rejected startle must not touch any state");
});

// ================================================================
// Determinism (PRD §1, contract inherited from ticket #119): same
// seed replays byte-identically, different seed diverges
// ================================================================
check("two same-seed worlds replay byte-identical trajectories over 120 steps (incl. a startle)", () => {
  const a = new World({ seed: 42 });
  const b = new World({ seed: 42 });
  a.startleAt(TANK_WIDTH / 2, TANK_HEIGHT / 2);
  b.startleAt(TANK_WIDTH / 2, TANK_HEIGHT / 2);
  for (let i = 0; i < 120; i++) { a.step(FIXED_DT); b.step(FIXED_DT); }
  assert(a.serializeState() === b.serializeState(),
    "same seed + same startle must replay byte-identical state");
});

check("different seeds produce different trajectories", () => {
  const a = new World({ seed: 42 });
  const b = new World({ seed: 43 });
  stepN(a, 60);
  stepN(b, 60);
  assert(a.serializeState() !== b.serializeState(), "distinct seeds must not clone the tank");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
