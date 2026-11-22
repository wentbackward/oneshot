#!/usr/bin/env node
// ================================================================
// Unit tests — placed rocks as dynamic collision obstacles
// (ticket #122, PRD §3): obstacle avoidance is WIRED into the
// world — a seeded 600-step soak asserts no fish ever enters a
// rock's collision radius (r + ROCK_COLLIDE_PAD) once the rock is
// placed, while the fish keep swimming (mean speed > 0). Plus the
// placement/removal accounting the vm-boot suite also pins from
// the toolbar side (duplicate placements, unknown removals,
// non-finite coordinates).
//
// Harness: stock node with flag-free .ts type-stripping imports the
// real src/sim sources; seeded worlds (no network, no wall-clock
// dependence).
//
// Run: node tests/fishtank-rocks.test.mjs
// ================================================================
import { TANK_HEIGHT, TANK_WIDTH, World } from "../src/sim/world.ts";
import {
  FIXED_DT,
  ROCK_COLLIDE_PAD,
  ROCK_MAX,
  ROCK_RADIUS,
  TETRA_COUNT,
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

function stepN(world, n) {
  for (let i = 0; i < n; i++) world.step(FIXED_DT);
}

/** Assert every tetra sits outside every rock's collision radius. */
function assertClearOfRocks(world, label) {
  for (const [ti, t] of world.agents.entries()) {
    for (const rock of world.rocks) {
      const d = Math.hypot(t.x - rock.x, t.y - rock.y);
      const min = rock.r + ROCK_COLLIDE_PAD;
      assert(d >= min - 1e-6,
        `${label}: tetra ${ti} entered rock's collision radius ` +
        `(dist ${d} < ${min} at (${t.x}, ${t.y}) vs rock at (${rock.x}, ${rock.y}))`);
    }
  }
}

// ================================================================
// Criterion (accounting): world counts follow placements/removals
// exactly, including the edges
// ================================================================
check("rocks are placed as circles of ROCK_RADIUS and world counts follow placements/removals exactly", () => {
  const world = new World({ seed: 3, population: 0 });
  assert(world.rocks.length === 0, "a fresh world has no rocks");
  const a = world.placeRock(400, 400);
  const b = world.placeRock(1000, 600);
  assert(a !== null && b !== null, "placeRock must succeed below the cap");
  assert(world.rocks.length === 2, `expected 2 rocks, got ${world.rocks.length}`);
  assert(a.r === ROCK_RADIUS && b.r === ROCK_RADIUS,
    `placed rocks must be circles of ROCK_RADIUS (${ROCK_RADIUS}), got (${a.r}, ${b.r})`);
  // Removal restores the exact count; a second removal fails.
  assert(world.removeRock(a) === true, "removeRock must remove a placed rock");
  assert(world.rocks.length === 1, `expected 1 rock after removal, got ${world.rocks.length}`);
  assert(world.removeRock(a) === false, "removing an unknown rock must fail");
  assert(world.rocks.length === 1, "a failed removal must not change the count");
});

check("duplicate placements both count; removing one leaves the other", () => {
  const world = new World({ seed: 3, population: 0 });
  const a = world.placeRock(500, 500);
  const b = world.placeRock(500, 500);
  assert(a !== null && b !== null && world.rocks.length === 2,
    "two placements at the same spot must both count");
  assert(world.removeRock(b) === true, "removing the later duplicate must succeed");
  assert(world.rocks.length === 1, `expected 1 rock left, got ${world.rocks.length}`);
  assert(world.rocks[0] === a, "the surviving rock must be the first placement");
});

check("non-finite placements are rejected without touching the world", () => {
  const world = new World({ seed: 3, population: 0 });
  assert(world.placeRock(NaN, 400) === null, "placeRock(NaN, _) must return null");
  assert(world.placeRock(400, Infinity) === null, "placeRock(_, +∞) must return null");
  assert(world.rocks.length === 0, "a rejected placement must not change the count");
});

check("the rock cap is honored: ROCK_MAX placements succeed, the next is rejected", () => {
  const world = new World({ seed: 3, population: 0 });
  for (let i = 0; i < ROCK_MAX; i++) {
    const r = world.placeRock(100 + i * 40, 300);
    assert(r !== null, `placement ${i} of ${ROCK_MAX} must succeed`);
  }
  assert(world.placeRock(900, 900) === null, "placement past ROCK_MAX must return null");
  assert(world.rocks.length === ROCK_MAX,
    `the cap must hold exactly at ROCK_MAX (${ROCK_MAX}), got ${world.rocks.length}`);
});

// ================================================================
// Criterion (main soak): obstacle avoidance wired — in a seeded
// 600-step soak, no fish ever enters a rock's collision radius
// once the rock is placed, and the fish keep swimming
// ================================================================
check("600-step seeded soak: no fish ever enters a rock's collision radius and mean speed stays > 0", () => {
  const world = new World({ seed: 2024 }); // full default school
  assert(world.agents.length === TETRA_COUNT, "test setup: default school population");
  stepN(world, 60); // settle the school first

  // Two rocks in the school's cruising lanes.
  const r1 = world.placeRock(500, 400);
  const r2 = world.placeRock(1100, 600);
  assert(r1 !== null && r2 !== null, "test setup: rocks must be placed");

  let meanSpeed = 0;
  for (let step = 1; step <= 600; step++) {
    world.step(FIXED_DT);
    assertClearOfRocks(world, `soak step ${step}`);
    if (step === 600) {
      for (const t of world.agents) meanSpeed += Math.hypot(t.vx, t.vy);
      meanSpeed /= world.agents.length;
    }
  }
  assert(meanSpeed > 0, `the fish must keep swimming (mean speed ${meanSpeed})`);
});

// ================================================================
// Edge: a rock dropped ON TOP of the school ejects the fish out of
// the collision radius (overlap cannot persist)
// ================================================================
check("a rock placed inside the school ejects every fish out of its collision radius", () => {
  const world = new World({ seed: 77 });
  // Centre of the spawn cluster: maximum guaranteed overlap.
  const rock = world.placeRock(TANK_WIDTH / 2, TANK_HEIGHT / 2);
  assert(rock !== null, "test setup: central placement must succeed");
  // Some tetras are guaranteed to be inside the collision radius now
  // (the spawn cluster spans radius 120 around the same point).
  let overlapped = 0;
  for (const t of world.agents) {
    if (Math.hypot(t.x - rock.x, t.y - rock.y) < rock.r + ROCK_COLLIDE_PAD) overlapped++;
  }
  assert(overlapped > 0, `test setup: the central rock must overlap the school (got ${overlapped})`);
  stepN(world, 120);
  assertClearOfRocks(world, "post-drop soak");
});

// ---------- regression helpers (review round 2) ----------

/** Seat the (single) tetra at an exact pose — squeezing scenarios.
 *  Only valid on worlds spawned with population: 1. */
function pressFish(world, x, y, vx, vy) {
  const t = world.agents[0];
  t.x = x;
  t.y = y;
  t.vx = vx;
  t.vy = vy;
  t.heading = Math.atan2(vy, vx);
  return t;
}

/** Assert every tetra sits INSIDE the tank (the step() contract). */
function assertInsideTank(world, label) {
  for (const [ti, t] of world.agents.entries()) {
    assert(t.x >= -1e-6 && t.x <= TANK_WIDTH + 1e-6,
      `${label}: tetra ${ti} escaped the tank at x=${t.x}`);
    assert(t.y >= -1e-6 && t.y <= TANK_HEIGHT + 1e-6,
      `${label}: tetra ${ti} escaped the tank at y=${t.y}`);
  }
}

// ================================================================
// Regression (review round 2): the single-pass position resolution
// (one clamp, one sequential rock projection) left a tetra inside a
// rock's collision radius when the two constraints fought each
// other — a later projection re-pushing the fish into an earlier
// rock, and a wall-clamped rock's projection running after the tank
// clamp and ejecting the fish through the wall. The invariants must
// hold EVERY step, not just on average.
// ================================================================
check("overlapping rocks mid-school: a tetra squeezed between them ends every step outside every collision disk", () => {
  const world = new World({ seed: 5150, population: 1 });
  const t = pressFish(world, 430, 400, 50, 10);
  const a = world.placeRock(400, 400);
  const b = world.placeRock(460, 400);
  assert(a !== null && b !== null, "test setup: both placements must succeed");
  assert(Math.hypot(t.x - a.x, t.y - a.y) < a.r + ROCK_COLLIDE_PAD &&
         Math.hypot(t.x - b.x, t.y - b.y) < b.r + ROCK_COLLIDE_PAD,
    "test setup: the fish must start squeezed inside BOTH disks");
  for (let step = 1; step <= 300; step++) {
    world.step(FIXED_DT);
    assertClearOfRocks(world, `overlap-soak step ${step}`);
    assertInsideTank(world, `overlap-soak step ${step}`);
  }
});

check("a single step clears a tetra sitting between two overlapping corner rocks", () => {
  // The exact round-2 repro: rocks at (40,40) and (100,40), fish at
  // (70,40) — the single pass ended the step at dA=14 (inside rock
  // A's body).
  const world = new World({ seed: 4242, population: 1 });
  pressFish(world, 70, 40, 50, 10);
  const a = world.placeRock(40, 40);
  const b = world.placeRock(100, 40);
  assert(a !== null && b !== null, "test setup: both placements must succeed");
  world.step(FIXED_DT);
  const min = a.r + ROCK_COLLIDE_PAD;
  const dA = Math.hypot(world.agents[0].x - a.x, world.agents[0].y - a.y);
  const dB = Math.hypot(world.agents[0].x - b.x, world.agents[0].y - b.y);
  assert(dA >= min - 1e-6 && dB >= min - 1e-6,
    `after one step the tetra must be clear of both disks (dA ${dA}, dB ${dB}, min ${min})`);
  assertInsideTank(world, "after one step");
});

check("a wall-clamped rock: a tetra pressed to the edge never leaves the tank or the rock's solid body", () => {
  // The exact round-2 repro: a (0,0) placement clamps to
  // (40,40), its r+PAD disk pokes past y=0, and the old order
  // (projection after the tank clamp) ejected the fish at (40,1)
  // to y=-6. In that configuration the two constraints are
  // mutually exclusive in a thin sliver, so the invariants that
  // MUST hold are the documented ones: INSIDE the tank, and never
  // inside the rock's SOLID body (a wall-clamped rock only touches
  // the wall tangentially, so that is always achievable).
  const world = new World({ seed: 9090, population: 1 });
  const t = pressFish(world, 40, 1, 50, 20);
  const rock = world.placeRock(0, 0);
  assert(rock !== null && rock.x === ROCK_RADIUS && rock.y === ROCK_RADIUS,
    `test setup: the (0,0) placement must clamp to (${ROCK_RADIUS}, ${ROCK_RADIUS}), got (${rock.x}, ${rock.y})`);
  assert(Math.hypot(t.x - rock.x, t.y - rock.y) < rock.r + ROCK_COLLIDE_PAD,
    "test setup: the fish must start inside the collision ring");
  for (let step = 1; step <= 300; step++) {
    world.step(FIXED_DT);
    assertInsideTank(world, `wall-soak step ${step}`);
    const d = Math.hypot(t.x - rock.x, t.y - rock.y);
    assert(d >= rock.r - 1e-6,
      `wall-soak step ${step}: tetra inside the rock's solid body (dist ${d} < ${rock.r} at (${t.x}, ${t.y}))`);
  }
});

// ================================================================
// Regression (review round 3): with >= 3 densely overlapping
// rocks (a 2x2 grid at 40-unit spacing, collision ring 46) the
// FIRST-PAIR exit strategy ping-ponged deterministically between
// two different rock pairs: the cap-rest position sat buried in a
// rock's SOLID body (min distance to a ring 21.76) and the
// invariants broke EVERY step. The exit choice must be GLOBAL:
// every candidate (each violator's radial exit + every violator
// pair's boundary intersections) is scored by its WORST remaining
// ring depth and the best is taken. Both variants below are
// gameplay-reachable (clicking a 2x2 grid on the spawn school).
// ================================================================
// Grid corners at 40-unit spacing around the tank centre: the
// reviewer's exact configuration.
const GRID = [
  [780, 480],
  [820, 480],
  [780, 520],
  [820, 520],
];
function placeGrid(world) {
  const rocks = [];
  for (const [gx, gy] of GRID) {
    const rock = world.placeRock(gx, gy);
    assert(rock !== null, "test setup: grid placement must succeed");
    rocks.push(rock);
  }
  return rocks;
}

check("2x2 grid at 40 spacing: a tetra in the middle resolves every step outside every collision disk AND inside the tank", () => {
  const world = new World({ seed: 310122, population: 1 });
  pressFish(world, 800, 500, 30, 15);
  const rocks = placeGrid(world);
  assert(Math.hypot(world.agents[0].x - 800, world.agents[0].y - 500) === 0, "test setup: tetra seated at the grid centre");
  // The centre is inside ALL FOUR rings: the dense-cluster case the
  // first-pair strategy cycled on forever.
  assert(rocks.every((r) => Math.hypot(800 - r.x, 500 - r.y) < r.r + ROCK_COLLIDE_PAD),
    "test setup: the tetra must start inside every one of the four rings");
  for (let step = 1; step <= 300; step++) {
    world.step(FIXED_DT);
    assertClearOfRocks(world, `grid-soak step ${step}`);
    assertInsideTank(world, `grid-soak step ${step}`);
  }
});

check("2x2 grid at 40 spacing placed ON THE SCHOOL: every tetra resolves every step outside every collision disk AND inside the tank", () => {
  // Seed 1 is the reviewer's regime made deterministic: at placement,
  // three schoolmates are driven into the B∩C-ring pocket whose
  // nearer boundary intersection sits 7.99 u from D's centre (in the
  // SOLID body). The first-pair strategy's "nearer intersection" pick
  // re-selects the point the tetra already sits on (a fixed point of
  // its own choice), burns the pass cap, and rests buried — the
  // invariant breaks at the placement step, reproducibly.
  const world = new World({ seed: 1 }); // full default school
  const rocks = placeGrid(world);
  // Several tetras are guaranteed to start inside rings (the spawn
  // cluster spans ±120 around the grid centre).
  let overlapped = 0;
  for (const t of world.agents) {
    if (rocks.some((r) => Math.hypot(t.x - r.x, t.y - r.y) < r.r + ROCK_COLLIDE_PAD)) overlapped++;
  }
  assert(overlapped > 0, `test setup: the grid must overlap the school (got ${overlapped})`);
  for (let step = 1; step <= 300; step++) {
    world.step(FIXED_DT);
    assertClearOfRocks(world, `school-grid soak step ${step}`);
    assertInsideTank(world, `school-grid soak step ${step}`);
  }
});

// One-shot exit property (review round 3): from EVERY point in the
// union of the four rings, a single step must end FULLY clear of
// all four and inside the tank. This pins the failure class in
// general, not just the two soak trajectories above: a local
// (first-pair) exit choice fails it at the B∩C pocket intersections
// (7.99 u from D's centre).
//
// Single WORLD with the tetra re-seated per sample (review round 4):
// the lattice must stay growable — rebuilding a World per point
// (≈ 1500 constructions) turned the runtime cost quadratic in the
// lattice size.
check("2x2 grid at 40 spacing: one step from any point inside the union of the four rings ends fully clear of all rings and inside the tank", () => {
  const world = new World({ seed: 310124, population: 1, predator: false }); // the lattice runs ~1500 steps: a live predator would capture the lone tetra mid-scan (hunger crosses its stalk threshold well inside it)
  const t = world.agents[0];
  const rocks = placeGrid(world);
  const min = ROCK_RADIUS + ROCK_COLLIDE_PAD;
  let samples = 0;
  for (let x = 734; x <= 866; x += 3) {
    for (let y = 434; y <= 566; y += 3) {
      let inUnion = false;
      for (const r of rocks) if (Math.hypot(x - r.x, y - r.y) < min - 1e-6) { inUnion = true; break; }
      if (!inUnion) continue;
      samples++;
      pressFish(world, x, y, 30, 10);
      world.step(FIXED_DT);
      for (const r of rocks) {
        const d = Math.hypot(t.x - r.x, t.y - r.y);
        assert(d >= min - 1e-6,
          `one step from union point (${x}, ${y}) must clear every ring, ended at dist ${d} < ${min} from rock at (${r.x}, ${r.y})`);
      }
      assert(t.x >= -1e-6 && t.x <= TANK_WIDTH + 1e-6 && t.y >= -1e-6 && t.y <= TANK_HEIGHT + 1e-6,
        `one step from union point (${x}, ${y}) must stay inside the tank, ended at (${t.x}, ${t.y})`);
    }
  }
  assert(samples > 1500, `test setup: expected a meaningful sample lattice, got ${samples}`);
});

// ================================================================
// Regression (review round 4): a 2x2 grid WEDGED INTO A CORNER
// exposes the phantom-clear failure of the round-3 scorer: each
// candidate was scored at its RAW coordinates, then the wall clamp
// took the final word of the same pass and re-projected the chosen
// point BACK INTO a ring — the next pass re-selected the same
// phantom-clear candidate, cycled to the cap, and the cap-rest
// fallback repeated the same unclamped radial exit. A tetra seated
// against the wall rested inside a ring for 300/300 steps while a
// genuinely clear candidate existed but lost the raw-coordinate
// scoring. The corners of the tank must be exactly as safe as the
// centre: every step outside every ring AND inside the tank.
// ================================================================
// Corner-hugging grid: the tightest legal placements (placeRock
// clamps centres to >= ROCK_RADIUS from both walls).
const CORNER_GRID = [
  [40, 40],
  [80, 40],
  [40, 80],
  [80, 80],
];
// Eight start poses seated against the walls / inside the union,
// including the reviewer's stuck repro poses (60,20), (20,60),
// (46,46) and the deep-centre pocket (60,40).
const CORNER_POSES = [
  [60, 40],
  [30, 30],
  [40, 60],
  [60, 20],
  [20, 60],
  [60, 80],
  [80, 60],
  [46, 46],
];

check("corner-hugging 2x2 grid: a tetra seated against the wall ends EVERY step outside every collision disk AND inside the tank", () => {
  const min = ROCK_RADIUS + ROCK_COLLIDE_PAD;
  for (const [px, py] of CORNER_POSES) {
    const world = new World({ seed: 310199, population: 1 });
    pressFish(world, px, py, 20, 20);
    for (const [gx, gy] of CORNER_GRID) {
      const rock = world.placeRock(gx, gy);
      assert(rock !== null, "test setup: corner grid placement must succeed");
    }
    // Every sampled pose must actually start INSIDE the union: the
    // whole point is the resolution, not open-water swimming.
    assert(CORNER_GRID.some(([gx, gy]) => Math.hypot(px - gx, py - gy) < min),
      `test setup: pose (${px}, ${py}) must start inside the corner union`);
    for (let step = 1; step <= 300; step++) {
      world.step(FIXED_DT);
      assertClearOfRocks(world, `corner soak pose (${px}, ${py}) step ${step}`);
      assertInsideTank(world, `corner soak pose (${px}, ${py}) step ${step}`);
    }
  }
});

// Corner variant of the one-shot lattice property (review round 4):
// from ANY point in the union of the four corner rings, one step
// ends fully clear of all rings and inside the tank — the
// wall-corridor escape the centre-tank lattice cannot exercise.
// Single world, tetra re-seated per sample (same round-4
// restructure as the centre-tank variant).
check("corner-hugging 2x2 grid: one step from any point inside the union of the four rings ends fully clear of all rings and inside the tank", () => {
  const world = new World({ seed: 310198, population: 1, predator: false }); // the lattice runs ~1500 steps: a live predator would capture the lone tetra mid-scan (hunger crosses its stalk threshold well inside it)
  const t = world.agents[0];
  const rocks = [];
  for (const [gx, gy] of CORNER_GRID) {
    const rock = world.placeRock(gx, gy);
    assert(rock !== null, "test setup: corner grid placement must succeed");
    rocks.push(rock);
  }
  const min = ROCK_RADIUS + ROCK_COLLIDE_PAD;
  let samples = 0;
  for (let x = 0; x <= 126; x += 3) {
    for (let y = 0; y <= 126; y += 3) {
      let inUnion = false;
      for (const r of rocks) if (Math.hypot(x - r.x, y - r.y) < min - 1e-6) { inUnion = true; break; }
      if (!inUnion) continue;
      samples++;
      pressFish(world, x, y, 30, 10);
      world.step(FIXED_DT);
      for (const r of rocks) {
        const d = Math.hypot(t.x - r.x, t.y - r.y);
        assert(d >= min - 1e-6,
          `one step from corner union point (${x}, ${y}) must clear every ring, ended at dist ${d} < ${min} from rock at (${r.x}, ${r.y})`);
      }
      assert(t.x >= -1e-6 && t.x <= TANK_WIDTH + 1e-6 && t.y >= -1e-6 && t.y <= TANK_HEIGHT + 1e-6,
        `one step from corner union point (${x}, ${y}) must stay inside the tank, ended at (${t.x}, ${t.y})`);
    }
  }
  assert(samples > 500, `test setup: expected a meaningful corner sample lattice, got ${samples}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
