#!/usr/bin/env node
// ================================================================
// Unit tests — verlet kelp strands (ticket #122, PRD §3/§5):
//  - each strand is ≥ 6 verlet segments anchored at the substrate;
//  - after 600 relaxed steps with ZERO current: every segment
//    length within 1 ± KELP_TOL of rest length, no NaN coordinates,
//    and the strand hangs within KELP_REST_ANGLE_TOL of vertical
//    (the PRD §5 kelp spring-constraint stability law);
//  - with the ambient current on: the strand tip deviates from
//    vertical beyond the named threshold KELP_CURRENT_TIP_DEVIATION_MIN;
//  - a fast fish passed near the strand displaces its tip by more
//    than the static-current deviation within 30 frames.
//
// Harness: stock node with flag-free .ts type-stripping imports the
// real src/sim sources; every world and strand is seeded (no network,
// no wall-clock dependence).
//
// Run: node tests/fishtank-kelp.test.mjs
// ================================================================
import { KelpStrand, tipDeviationFromVertical } from "../src/sim/kelp.ts";
import { TANK_HEIGHT, World } from "../src/sim/world.ts";
import {
  AMBIENT_CURRENT_X,
  FIXED_DT,
  KELP_CURRENT_TIP_DEVIATION_MIN,
  KELP_REST_ANGLE_TOL,
  KELP_SEGMENTS,
  KELP_TOL,
  KELP_TOTAL_LENGTH,
  TETRA_MAX_SPEED,
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

const RELAX_STEPS = 600; // the ticket's stabilization horizon
const SOAK_EPS = 1e-9;

function stepWorldN(world, n) {
  for (let i = 0; i < n; i++) world.step(FIXED_DT);
}

function relax(strand, n, currentX, fish) {
  for (let i = 0; i < n; i++) strand.step(FIXED_DT, currentX, fish);
}

function tip(strand) {
  return strand.points[strand.points.length - 1];
}

/** Every segment length as a ratio of the strand's rest length. */
function segmentRatios(strand) {
  const ratios = [];
  for (let i = 1; i < strand.points.length; i++) {
    const a = strand.points[i - 1];
    const b = strand.points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    ratios.push(len / strand.restLength);
  }
  return ratios;
}

function assertRatiosWithin(strand, label) {
  const ratios = segmentRatios(strand);
  assert(ratios.length === strand.segments,
    `${label}: expected ${strand.segments} segments, got ${ratios.length}`);
  for (const [i, r] of ratios.entries()) {
    assert(Number.isFinite(r), `${label}: segment ${i} length is non-finite`);
    assert(r >= 1 - KELP_TOL - SOAK_EPS && r <= 1 + KELP_TOL + SOAK_EPS,
      `${label}: segment ${i} length ratio ${r} outside 1 ± ${KELP_TOL}`);
  }
}

function assertNoNaN(strand, label) {
  for (const [i, p] of strand.points.entries()) {
    assert(Number.isFinite(p.x) && Number.isFinite(p.y) &&
           Number.isFinite(p.px) && Number.isFinite(p.py),
      `${label}: point ${i} went non-finite at (${p.x}, ${p.y})`);
  }
}

// ================================================================
// Criterion (structural): each strand is ≥ 6 verlet segments
// anchored at the substrate
// ================================================================
check("a kelp strand is built from >= 6 verlet segments anchored at the substrate", () => {
  assert(KELP_SEGMENTS >= 6, `KELP_SEGMENTS must be >= 6, got ${KELP_SEGMENTS}`);
  const strand = new KelpStrand(500, TANK_HEIGHT, 7);
  assert(strand.segments === KELP_SEGMENTS,
    `strand must use KELP_SEGMENTS segments, got ${strand.segments}`);
  assert(strand.points.length === KELP_SEGMENTS + 1,
    `a ${KELP_SEGMENTS}-segment strand needs ${KELP_SEGMENTS + 1} points, got ${strand.points.length}`);
  // The anchor (point 0) sits exactly at the substrate.
  assert(strand.anchorX === 500 && strand.anchorY === TANK_HEIGHT,
    `anchor must be (500, ${TANK_HEIGHT}), got (${strand.anchorX}, ${strand.anchorY})`);
  assert(strand.points[0].x === 500 && strand.points[0].y === TANK_HEIGHT,
    "point 0 must coincide with the substrate anchor");
  // The segments tile the strand's total length.
  assert(Math.abs(strand.restLength * strand.segments - KELP_TOTAL_LENGTH) <= 1e-9,
    `segment rest lengths must tile KELP_TOTAL_LENGTH (${KELP_TOTAL_LENGTH}), got ${strand.restLength * strand.segments}`);
});

// ================================================================
// Criterion (PRD §5 stability law): 600 relaxed steps with ZERO
// current — lengths within 1 ± KELP_TOL, no NaN, hangs within
// KELP_REST_ANGLE_TOL of vertical
// ================================================================
check("after 600 relaxed steps with zero current, all segment lengths are within 1 ± KELP_TOL of rest length", () => {
  const strand = new KelpStrand(800, TANK_HEIGHT, 11);
  relax(strand, RELAX_STEPS, 0, []);
  assertRatiosWithin(strand, "zero-current soak");
});

check("after 600 relaxed steps with zero current, the strand carries no NaN coordinates", () => {
  const strand = new KelpStrand(800, TANK_HEIGHT, 11);
  relax(strand, RELAX_STEPS, 0, []);
  assertNoNaN(strand, "zero-current soak");
});

check("after 600 relaxed steps with zero current, the strand hangs within KELP_REST_ANGLE_TOL of vertical", () => {
  const strand = new KelpStrand(800, TANK_HEIGHT, 11);
  relax(strand, RELAX_STEPS, 0, []);
  const angle = tipDeviationFromVertical(strand);
  assert(Number.isFinite(angle), `tip angle must be finite, got ${angle}`);
  assert(angle < KELP_REST_ANGLE_TOL,
    `relaxed strand must hang within ${KELP_REST_ANGLE_TOL} rad of vertical, got ${angle}`);
});

// ================================================================
// Criterion: response to flow — with the ambient current on the
// tip deviates beyond the named threshold, and the constraint
// solver stays stable under load
// ================================================================
check("with the ambient current on, strand tips deviate from vertical beyond KELP_CURRENT_TIP_DEVIATION_MIN", () => {
  const strand = new KelpStrand(800, TANK_HEIGHT, 23);
  relax(strand, RELAX_STEPS, AMBIENT_CURRENT_X, []);
  const angle = tipDeviationFromVertical(strand);
  assert(angle > KELP_CURRENT_TIP_DEVIATION_MIN,
    `tip must lean beyond ${KELP_CURRENT_TIP_DEVIATION_MIN} rad in the current, got ${angle}`);
  // Swaying must not break the spring: lengths and finiteness survive.
  assertRatiosWithin(strand, "current soak");
  assertNoNaN(strand, "current soak");
});

// ================================================================
// Criterion: response to fish — a fast fish passed near a strand
// displaces its tip by more than the static-current deviation
// within 30 frames
// ================================================================
check("a fast test fish displaces the kelp tip by more than the static-current deviation within 30 frames", () => {
  const world = new World({ seed: 99, population: 1, ambientCurrentX: AMBIENT_CURRENT_X });
  const strand = world.placeKelp(800);
  assert(strand !== null, "placeKelp must succeed on a fresh world");

  // Park the lone tetra clear of the strand and let the strand
  // settle into its static-current pose.
  const fish = world.agents[0];
  fish.x = 200; fish.y = 300; fish.vx = 30; fish.vy = 0;
  stepWorldN(world, 300);
  fish.x = 200; fish.y = 300; fish.vx = 30; fish.vy = 0;
  stepWorldN(world, 10); // re-equilibrate with the fish far away

  const restTip = { x: tip(strand).x, y: tip(strand).y };
  // The static-current deviation: how far the settled tip sits from
  // directly above the anchor (a straight, current-free strand).
  const staticDeviation = Math.hypot(
    restTip.x - strand.anchorX,
    restTip.y - (strand.anchorY - KELP_TOTAL_LENGTH),
  );
  assert(staticDeviation > 5,
    `test setup: the current must lean the strand measurably (deviation ${staticDeviation})`);

  // Fly the fish across the strand right at the settled tip's
  // height, full cruise speed (starts at the anchor's x: the fish
  // heads straight for the tip and out the far side within the
  // 30-frame window).
  fish.x = strand.anchorX;
  fish.y = restTip.y;
  fish.vx = TETRA_MAX_SPEED;
  fish.vy = 0;

  let maxDisplacement = 0;
  for (let frame = 0; frame < 30; frame++) {
    world.step(FIXED_DT);
    const disp = Math.hypot(tip(strand).x - restTip.x, tip(strand).y - restTip.y);
    maxDisplacement = Math.max(maxDisplacement, disp);
    assertNoNaN(strand, `fish-pass frame ${frame}`);
  }
  assert(maxDisplacement > staticDeviation,
    `the fish pass must displace the tip by more than the static-current deviation ` +
    `(${maxDisplacement} vs ${staticDeviation}) within 30 frames`);
});

// ================================================================
// Edge: a non-finite or zero dt is a no-op (same well-formedness
// policy as World.step)
// ================================================================
check("strand.step refuses NaN/±∞/non-positive dt without touching state", () => {
  const strand = new KelpStrand(400, TANK_HEIGHT, 31);
  relax(strand, 60, AMBIENT_CURRENT_X, []);
  const before = JSON.stringify(strand.points);
  strand.step(NaN, AMBIENT_CURRENT_X, []);
  strand.step(Infinity, AMBIENT_CURRENT_X, []);
  strand.step(-FIXED_DT, AMBIENT_CURRENT_X, []);
  strand.step(0, AMBIENT_CURRENT_X, []);
  assert(JSON.stringify(strand.points) === before,
    "a refused step must leave the strand byte-identical");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
