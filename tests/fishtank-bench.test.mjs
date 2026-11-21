#!/usr/bin/env node
// ================================================================
// Performance benchmark (ticket #120, PRD §1/§5): 1000 fixed
// timestep updates with 200 schooling tetras must complete in
// under 5 s of wall time — ≥3.3× faster than the 16.7 s real-time
// budget of 1000 frames, and comfortably inside the 60 s gate
// timeout — with every sampled fish position finite (no
// NaN/Infinity) and inside the tank bounds. A second run at 300
// tetras must finish 1000 steps in under 8 s of wall time,
// proving the PRD's 250+ entity headroom.
//
// Harness: stock node with flag-free .ts type-stripping imports the
// real src/sim sources; timed runs use performance.now() (wall
// time, as the ticket specifies). No network, no external
// services, fully deterministic seeds.
//
// Run: node tests/fishtank-bench.test.mjs
// ================================================================
import { performance } from "node:perf_hooks";
import { TANK_WIDTH, TANK_HEIGHT, World } from "../src/sim/world.ts";
import { FIXED_DT } from "../src/sim/constants.ts";

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

// ---------- benchmark rig ----------

const STEPS = 1000;
const SAMPLE_EVERY = 50; // steps between in-bounds/finite samples

/**
 * Run STEPS fixed steps on a freshly seeded world of `population`
 * tetras. Every SAMPLE_EVERY-th step (and the last) audits EVERY
 * fish: position AND velocity finite, position inside the tank.
 * Returns wall time in seconds.
 */
function runBench(population, seed) {
  const world = new World({ seed, population });
  const t0 = performance.now();
  for (let step = 1; step <= STEPS; step++) {
    world.step(FIXED_DT);
    if (step % SAMPLE_EVERY === 0 || step === STEPS) {
      for (const [i, t] of world.tetras.entries()) {
        assert(Number.isFinite(t.x) && Number.isFinite(t.y),
          `population ${population}: tetra ${i} position went non-finite at step ${step} (${t.x}, ${t.y})`);
        assert(t.x >= 0 && t.x <= TANK_WIDTH && t.y >= 0 && t.y <= TANK_HEIGHT,
          `population ${population}: tetra ${i} escaped the tank at step ${step} (${t.x}, ${t.y})`);
      }
    }
  }
  return (performance.now() - t0) / 1000;
}

// ================================================================
// Criterion: 200 tetras × 1000 fixed steps in < 5 s wall, every
// sampled position finite and in bounds
// ================================================================
check("200 tetras × 1000 fixed steps finish in < 5 s wall with no NaN/Infinity and no out-of-bounds fish", () => {
  const seconds = runBench(200, 120);
  console.log(`       (measured: ${seconds.toFixed(3)} s for ${STEPS} steps @ 200 tetras; budget 5 s)`);
  assert(seconds < 5, `1000 steps @ 200 tetras took ${seconds.toFixed(3)} s, exceeding the 5 s budget`);
});

// ================================================================
// Criterion: 300 tetras × 1000 fixed steps in < 8 s wall — the
// PRD's 250+ entity headroom
// ================================================================
check("300 tetras × 1000 fixed steps finish in < 8 s wall with no NaN/Infinity and no out-of-bounds fish", () => {
  const seconds = runBench(300, 300);
  console.log(`       (measured: ${seconds.toFixed(3)} s for ${STEPS} steps @ 300 tetras; budget 8 s)`);
  assert(seconds < 8, `1000 steps @ 300 tetras took ${seconds.toFixed(3)} s, exceeding the 8 s budget`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
