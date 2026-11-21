#!/usr/bin/env node
// ================================================================
// Unit tests — procedural tail undulation (ticket #120, PRD §2):
// the exported pure formula `tailFrequency(speed, torque)` must be
// monotonic (non-decreasing) in BOTH inputs and zero (within
// epsilon) for a stationary, non-turning fish — the PRD rule that
// tail frequency scales dynamically with swimming speed and turning
// torque.
//
// Harness: stock node with flag-free .ts type-stripping imports the
// real src/sim/tail.ts (no network, no wall-clock dependence).
//
// Run: node tests/fishtank-tail.test.mjs
// ================================================================
import { tailFrequency } from "../src/sim/tail.ts";

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

// ---------- API surface ----------

check("tail.ts exports a pure tailFrequency(speed, torque) function", () => {
  assert(typeof tailFrequency === "function", "tailFrequency must be an exported function");
  // Purity: repeated calls, same args → same result.
  const a = tailFrequency(42, -1.3);
  const b = tailFrequency(42, -1.3);
  assert(a === b, `tailFrequency must be deterministic, got ${a} vs ${b}`);
});

// ================================================================
// Criterion: ZERO (within epsilon) for a stationary, non-turning
// fish
// ================================================================
check("tailFrequency is zero (within 1e-9) for a stationary, non-turning fish", () => {
  assert(Math.abs(tailFrequency(0, 0)) <= 1e-9,
    `stationary non-turning fish must have ~zero frequency, got ${tailFrequency(0, 0)}`);
  // Sign symmetry: a zero torque expressed as -0.0 must agree.
  assert(Math.abs(tailFrequency(0, -0)) <= 1e-9, "negative-zero torque must also give ~zero");
});

// ================================================================
// Criterion: MONOTONIC in speed (for every fixed torque)
// ================================================================
check("tailFrequency is non-decreasing in speed for a sweep of fixed torques", () => {
  const torques = [-8, -2.5, -0.1, 0, 0.1, 2.5, 8];
  for (const torque of torques) {
    let prev = -Infinity;
    for (let speed = 0; speed <= 400; speed += 2.5) {
      const f = tailFrequency(speed, torque);
      assert(Number.isFinite(f), `frequency must be finite at speed=${speed}, torque=${torque}`);
      assert(f >= prev - 1e-12,
        `frequency decreased with speed at torque=${torque}: ${f} < ${prev}`);
      prev = f;
    }
  }
});

// ================================================================
// Criterion: MONOTONIC in |torque| (for every fixed speed, both
// sign directions)
// ================================================================
check("tailFrequency is non-decreasing in |torque| for a sweep of fixed speeds", () => {
  for (const speed of [0, 10, 40, 80, 200]) {
    // Positive-torque sweep.
    let prev = -Infinity;
    for (let torque = 0; torque <= 8; torque += 0.1) {
      const f = tailFrequency(speed, torque);
      assert(f >= prev - 1e-12,
        `frequency decreased with +torque at speed=${speed}: ${f} < ${prev}`);
      prev = f;
    }
    // Negative-torque sweep (turning the other way must respond the same way).
    prev = -Infinity;
    for (let torque = 0; torque >= -8; torque -= 0.1) {
      const f = tailFrequency(speed, torque);
      assert(f >= prev - 1e-12,
        `frequency decreased with -torque at speed=${speed}: ${f} < ${prev}`);
      prev = f;
    }
    // Symmetry: turning either way at the same rate must cost the same frequency.
    const left = tailFrequency(speed, 3.7);
    const right = tailFrequency(speed, -3.7);
    assert(Math.abs(left - right) <= 1e-9,
      `frequency must be sign-symmetric in torque, got ${left} vs ${right}`);
  }
});

// ================================================================
// Both terms must actually contribute (PRD: frequency scales with
// speed AND with turning torque) — a formula that ignores either
// input fails here even though it is monotonic.
// ================================================================
check("swimming speed alone raises the frequency above the resting value", () => {
  const f = tailFrequency(80, 0);
  assert(f > 1e-9, `a cruising (speed 80) fish must tail at a positive frequency, got ${f}`);
});

check("turning torque alone raises the frequency above the resting value", () => {
  const f = tailFrequency(0, 2);
  assert(f > 1e-9, `a turning (torque 2 rad/s) fish must tail at a positive frequency, got ${f}`);
});

// ================================================================
// Degeneracies: absurd magnitudes stay finite and non-negative
// ================================================================
check("absurd inputs stay finite and non-negative", () => {
  for (const [speed, torque] of [[1e9, 1e9], [1e9, -1e9], [0, 1e9], [1e-300, 1e-300]]) {
    const f = tailFrequency(speed, torque);
    assert(Number.isFinite(f), `frequency must be finite for (speed=${speed}, torque=${torque})`);
    assert(f >= 0, `frequency must be non-negative, got ${f}`);
  }
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
