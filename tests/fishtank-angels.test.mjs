#!/usr/bin/env node
// ================================================================
// Unit tests — grazing angelfish (ticket #123, PRD §2's second
// behaviour): slower independent cruisers with vertical bobbing
// that forage near bottom plants and drift toward dropped food.
//  - ANGEL_COUNT angels spawn and cruise at ≤ ANGEL_CRUISE_SPEED,
//    INDEPENDENT of one another — two nearby angels do not
//    converge over 300 steps (no cohesion force between them);
//  - vertical bobbing: a quiescent angel's y oscillates sinusoidally
//    within baseY ± ANGEL_BOB_AMP over 600 steps (extrema inside
//    the band, ≥ 2 sign changes of the vertical velocity);
//  - foraging: with one kelp strand placed and an angel spawned
//    nearby, a seeded 600-step soak keeps the angel ≥ 70 % of its
//    steps within ANGEL_FORAGE_RADIUS of the kelp base;
//  - food seeking: with one pellet dropped, the angel's distance to
//    the pellet strictly decreases across 120 steps and the pellet
//    is consumed on contact exactly once; multiple angels converge
//    on the same pellet (competition) and exactly one consumes it;
//  - a pellet OUTSIDE PELLET_SENSE_RADIUS alters the angel's course
//    not at all (byte-identical twin).
//
// Harness: stock node with flag-free .ts type-stripping imports the
// real src/sim sources; every world is seeded (no network, no
// wall-clock dependence).
//
// Run: node tests/fishtank-angels.test.mjs
// ================================================================
import { World, TANK_WIDTH, TANK_HEIGHT } from "../src/sim/world.ts";
import {
  ANGEL_BOB_AMP,
  ANGEL_BOB_OMEGA,
  ANGEL_COUNT,
  ANGEL_CRUISE_SPEED,
  ANGEL_FORAGE_RADIUS,
  FIXED_DT,
  PELLET_SENSE_RADIUS,
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

// ---------- world helpers ----------

function stepN(world, n) {
  for (let i = 0; i < n; i++) world.step(FIXED_DT);
}

/** Assert every angel is finite and inside the tank bounds (closed). */
function assertAllAngelsInBounds(world, label) {
  for (const [i, a] of world.angels.entries()) {
    assert(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.vx) && Number.isFinite(a.vy),
      `${label}: angel ${i} went non-finite at (${a.x}, ${a.y})`);
    assert(a.x >= 0 && a.x <= TANK_WIDTH && a.y >= 0 && a.y <= TANK_HEIGHT,
      `${label}: angel ${i} escaped the tank at (${a.x}, ${a.y})`);
  }
}

/** Place an angel in open water in a QUIESCENT cruise state:
 *  base altitude fixed, bobbing from `bobPhase`, horizontal cruise
 *  velocity (the stored vy is recomputed from the bob oscillator so
 *  the stored state is self-consistent with the step's composition). */
function placeAngel(a, x, baseY, bobPhase, vx) {
  a.x = x;
  a.baseY = baseY;
  a.y = baseY + ANGEL_BOB_AMP * Math.sin(bobPhase);
  a.bobPhase = bobPhase;
  a.baseVx = vx;
  a.baseVy = 0;
  a.cruiseSpeed = ANGEL_CRUISE_SPEED;
  a.vx = vx;
  a.vy = ANGEL_BOB_AMP * ANGEL_BOB_OMEGA * Math.cos(bobPhase);
  a.heading = vx >= 0 ? 0 : Math.PI;
  a.torque = 0;
}

// ================================================================
// Criterion (supporting): the default World owns exactly the named
// ANGEL_COUNT angelfish, all born inside the tank
// ================================================================
check("a default World spawns exactly ANGEL_COUNT angelfish, all inside the tank", () => {
  assert(Number.isInteger(ANGEL_COUNT) && ANGEL_COUNT > 0,
    `ANGEL_COUNT must be a positive integer, got ${ANGEL_COUNT}`);
  const world = new World();
  assert(world.angels.length === ANGEL_COUNT,
    `the default world must hold exactly ANGEL_COUNT (${ANGEL_COUNT}) angels, got ${world.angels.length}`);
  assertAllAngelsInBounds(world, "at spawn");
});

// ================================================================
// Criterion (guard, symmetric with setTetraCount): a NON-INTEGER or
// NEGATIVE angels count is REFUSED — the world comes up with an
// EMPTY angel pool instead of silently truncating or looping fewer
// times
// ================================================================
check("a non-integer or negative angels count is refused (empty pool, nothing spawned)", () => {
  for (const bad of [2.5, -1]) {
    const world = new World({ seed: 3, population: 0, predator: false, angels: bad });
    assert(world.angels.length === 0,
      `angels: ${bad} must be refused (mirrors setTetraCount), got ${world.angels.length} angel(s)`);
  }
});

// ================================================================
// Criterion: SLOWER CRUISERS — an angel's speed NEVER exceeds the
// named ANGEL_CRUISE_SPEED (sampled at EVERY step of a 300-step run
// in the full default tank: tetras + predator + kelp-free water)
// ================================================================
check("angels cruise at or below ANGEL_CRUISE_SPEED at every one of 300 fixed steps", () => {
  const world = new World({ seed: 7 });
  for (let step = 0; step < 300; step++) {
    world.step(FIXED_DT);
    for (const [i, a] of world.angels.entries()) {
      const speed = Math.hypot(a.vx, a.vy);
      assert(speed <= ANGEL_CRUISE_SPEED + 1e-9,
        `step ${step + 1}: angel ${i} exceeded the named cruise speed (${speed} > ${ANGEL_CRUISE_SPEED})`);
    }
    assertAllAngelsInBounds(world, `step ${step + 1}`);
  }
});

// ================================================================
// Criterion: INDEPENDENT — no cohesion force between angels: two
// angels spawned nearby do not CONVERGE over 300 steps (their
// separation neither collapses nor trends downward; a schooling
// cohesion would have drawn them together)
// ================================================================
check("independence: two nearby angels do not converge over 300 steps (no cohesion between them)", () => {
  const world = new World({ seed: 13, population: 0, predator: false, angels: 2 });
  assert(world.angels.length === 2, "test setup: the world must carry exactly 2 angels");
  const a = world.angels[0];
  const b = world.angels[1];
  placeAngel(a, 700, 500, 0, 40);
  placeAngel(b, 900, 500, 0, 40); // 200 units apart, cruising in open water
  const d0 = Math.hypot(b.x - a.x, b.y - a.y);
  assert(d0 === 200, `test setup: the pair must start 200 units apart, got ${d0}`);
  let earlySum = 0;
  let lateSum = 0;
  for (let step = 0; step < 300; step++) {
    world.step(FIXED_DT);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    assertAllAngelsInBounds(world, `independence step ${step + 1}`);
    if (step < 100) earlySum += d;
    else if (step >= 200) lateSum += d;
    assert(d > d0 * 0.5,
      `step ${step + 1}: the angels must NOT converge (separation ${d} fell below half of the initial ${d0})`);
  }
  // No downward trend either: the mean late-run separation must not
  // sit below half of the mean early-run separation.
  assert(lateSum / 100 >= 0.5 * (earlySum / 100),
    `the angels' mean separation must not trend toward each other (late ${lateSum / 100} < 0.5 × early ${earlySum / 100})`);
});

// ================================================================
// Criterion: VERTICAL BOBBING — a quiescent angel's y oscillates
// sinusoidally within baseY ± ANGEL_BOB_AMP over 600 steps: every
// sampled extremum sits inside the band, the swing reaches the
// full amplitude, and the vertical velocity changes sign ≥ 2 times
// ================================================================
check("quiescent bob: over 600 steps y stays within live baseY ± ANGEL_BOB_AMP and vy changes sign at least twice", () => {
  const world = new World({ seed: 21, population: 0, predator: false });
  const a = world.angels[0];
  // Quiescent by construction: no kelp, no pellet — open-water cruise.
  placeAngel(a, 800, 500, 0, 50);
  let minY = Infinity;
  let maxY = -Infinity;
  let bandViolation = 0;
  let signChanges = 0;
  let prevVy = a.vy;
  for (let step = 0; step < 600; step++) {
    world.step(FIXED_DT);
    minY = Math.min(minY, a.y);
    maxY = Math.max(maxY, a.y);
    // The band is read against the angel's LIVE base altitude:
    // the bob must never carry y past baseY ± ANGEL_BOB_AMP.
    if (a.y > a.baseY + ANGEL_BOB_AMP + 1e-6 || a.y < a.baseY - ANGEL_BOB_AMP - 1e-6) bandViolation += 1;
    const s = a.vy === 0 ? 0 : Math.sign(a.vy);
    const ps = prevVy === 0 ? 0 : Math.sign(prevVy);
    if (s !== 0 && ps !== 0 && s !== ps) signChanges += 1;
    prevVy = a.vy;
    assertAllAngelsInBounds(world, `bob step ${step + 1}`);
  }
  assert(bandViolation === 0,
    `${bandViolation} of 600 steps left the band baseY ± ${ANGEL_BOB_AMP}`);
  assert(maxY - minY >= 1.8 * ANGEL_BOB_AMP,
    `the bob must actually swing (peak-to-peak ${maxY - minY} < 1.8 × amplitude ${ANGEL_BOB_AMP})`);
  assert(signChanges >= 2,
    `the vertical velocity must change sign at least twice over 600 steps (a sinusoidal bob), saw ${signChanges}`);
});

// ================================================================
// Criterion: FORAGING — one kelp strand, an angel spawned nearby,
// a seeded 600-step soak: the angel spends ≥ 70 % of its steps
// within ANGEL_FORAGE_RADIUS of the kelp base
// ================================================================
check("foraging: with one kelp strand a seeded 600-step soak keeps the angel ≥ 70 % of steps within ANGEL_FORAGE_RADIUS of the kelp base", () => {
  const world = new World({ seed: 11, population: 0, predator: false });
  const strand = world.placeKelp(500);
  assert(strand !== null, "test setup: the kelp strand must be placed");
  const a = world.angels[0];
  // Spawn NEARBY, just outside the forage radius: the angel must
  // actually SEEK the plant, not merely start inside it.
  placeAngel(a, 540, TANK_HEIGHT - 190, 0, 0);
  const d0 = Math.hypot(a.x - strand.anchorX, a.y - TANK_HEIGHT);
  assert(d0 > ANGEL_FORAGE_RADIUS && d0 < 2 * ANGEL_FORAGE_RADIUS,
    `test setup: the angel must start just outside the forage radius (d=${d0}, radius=${ANGEL_FORAGE_RADIUS})`);
  let inside = 0;
  for (let step = 0; step < 600; step++) {
    world.step(FIXED_DT);
    const d = Math.hypot(a.x - strand.anchorX, a.y - TANK_HEIGHT);
    if (d <= ANGEL_FORAGE_RADIUS) inside += 1;
    assertAllAngelsInBounds(world, `forage step ${step + 1}`);
  }
  const fraction = inside / 600;
  assert(fraction >= 0.7,
    `the angel must forage: only ${fraction} of its 600 steps sat within ANGEL_FORAGE_RADIUS (${ANGEL_FORAGE_RADIUS}) of the kelp base (need ≥ 0.7)`);
});

// ================================================================
// Criterion: FOOD SEEKING — one dropped pellet: the angel's
// distance to it strictly decreases across 120 steps and the
// pellet is consumed on contact (the count transitions 1 → 0 a
// single time, the same single-consume assertion as the tetra test)
// ================================================================
check("food seeking: the angel's distance to a dropped pellet strictly decreases and the pellet is consumed exactly once", () => {
  // Still water (zero ambient current, same convention as the kelp
  // settle tests): the criterion pins the ANGEL'S seeking behaviour,
  // not the pellet drift the current would add.
  const world = new World({ seed: 17, population: 0, predator: false, ambientCurrentX: 0 });
  const a = world.angels[0];
  placeAngel(a, 800, 560, Math.PI, 0); // bobbing at a trough: vy points up, at the pellet
  const p = world.dropFood(800, 480);
  assert(p !== null && Math.hypot(p.x - a.x, p.y - a.y) <= PELLET_SENSE_RADIUS,
    "test setup: the pellet must sit inside the sense radius");
  let prev = Math.hypot(p.x - a.x, p.y - a.y);
  let transitions = 0;
  let count = world.pellets.length;
  assert(count === 1, "test setup: exactly one pellet in the tank");
  let consumedAt = -1;
  for (let step = 0; step < 120; step++) {
    world.step(FIXED_DT);
    if (world.pellets.length !== count) transitions += 1;
    count = world.pellets.length;
    if (count === 0) { consumedAt = step + 1; break; }
    const d = Math.hypot(p.x - a.x, p.y - a.y);
    assert(d < prev - 1e-9,
      `step ${step + 1}: the angel→pellet distance must strictly decrease (${prev} -> ${d})`);
    prev = d;
  }
  assert(consumedAt > 0, "the pellet must be consumed within 120 steps");
  assert(world.pellets.length === 0,
    `the single pellet must be consumed (1 → 0), got ${world.pellets.length} left`);
  assert(transitions === 1,
    `a single pellet may be consumed exactly ONCE (1 → 0), saw ${transitions} transitions`);
});

// ================================================================
// Criterion (competition): MULTIPLE angels converge on the same
// pellet — every angel closes on it, and exactly one consumes it
// ================================================================
check("competition: two in-sense angels converge on one pellet and exactly one consumes it", () => {
  // Still water (see the food-seeking test's note).
  const world = new World({ seed: 23, population: 0, predator: false, ambientCurrentX: 0, angels: 2 });
  const [a, b] = world.angels;
  assert(a && b, "test setup: the world must carry at least 2 angels");
  // Both angels start BELOW the flake, nearly nose-to-nose (the
  // tetra-suite's scenario): the pellet sinks toward them, so
  // closure outruns the angel cruise ceiling — at terminal sink
  // speed a diagonal intercept can never gain vertical ground.
  placeAngel(a, 788, 560, Math.PI, 0);
  placeAngel(b, 812, 560, Math.PI, 0);
  const p = world.dropFood(800, 480);
  assert(p !== null, "test setup: one pellet spawned");
  const dA0 = Math.hypot(p.x - a.x, p.y - a.y);
  const dB0 = Math.hypot(p.x - b.x, p.y - b.y);
  assert(dA0 <= PELLET_SENSE_RADIUS && dB0 <= PELLET_SENSE_RADIUS,
    `test setup: both angels must sit inside the sense radius (dA=${dA0}, dB=${dB0}, radius=${PELLET_SENSE_RADIUS})`);
  let minA = dA0;
  let minB = dB0;
  let transitions = 0;
  let count = world.pellets.length;
  for (let step = 0; step < 120; step++) {
    world.step(FIXED_DT);
    minA = Math.min(minA, Math.hypot(p.x - a.x, p.y - a.y));
    minB = Math.min(minB, Math.hypot(p.x - b.x, p.y - b.y));
    if (world.pellets.length !== count) transitions += 1;
    count = world.pellets.length;
    if (count === 0) break;
  }
  assert(count === 0, "the pellet must be consumed within 120 steps");
  assert(transitions === 1,
    `a single pellet may be consumed exactly ONCE (1 → 0) — no double-consume — saw ${transitions} transitions`);
  assert(minA < dA0 * 0.75,
    `angel A must CONVERGE on the pellet (min distance ${minA} not below 0.75 × initial ${dA0})`);
  assert(minB < dB0 * 0.75,
    `angel B must CONVERGE on the pellet (min distance ${minB} not below 0.75 × initial ${dB0})`);
});

// ================================================================
// Criterion (guard): a pellet OUTSIDE PELLET_SENSE_RADIUS alters
// the angel's course not at all — its trajectory stays identical
// to a pellet-free twin world (the pellet row is the only allowed
// difference in the serialized state)
// ================================================================
check("a pellet outside PELLET_SENSE_RADIUS leaves the angel trajectory identical (pellet-free twin)", () => {
  const seed = 29;
  const a = new World({ seed, population: 0, predator: false });
  const b = new World({ seed, population: 0, predator: false });
  const aAngel = a.angels[0];
  placeAngel(aAngel, 800, 520, 0, 40);
  // Mirror the SAME placement onto the twin — only the pellet may
  // differ between the two worlds.
  placeAngel(b.angels[0], 800, 520, 0, 40);
  const far = a.dropFood(60, 60);
  assert(far !== null, "test setup: pellet spawned");
  const d = Math.hypot(aAngel.x - far.x, aAngel.y - far.y);
  assert(d > PELLET_SENSE_RADIUS,
    `test setup: the pellet must sit OUTSIDE the sense radius (d=${d})`);
  stepN(a, 120);
  stepN(b, 120);
  const nonPelletLines = (w) => w.serializeState().split("\n").filter((l) => !l.startsWith("F:")).join("\n");
  assert(nonPelletLines(a) === nonPelletLines(b),
    "an out-of-sense pellet must leave the angel (and the clock) trajectory identical");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
