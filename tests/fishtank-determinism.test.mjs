#!/usr/bin/env node
// ================================================================
// Unit tests — deterministic fixed-timestep world (ticket #119,
// PRD §1): a world step(dt) with an explicit dt; two independently
// constructed worlds given the same seed must hash identically
// after 100 fixed steps, proving the sim carries no hidden
// non-determinism (Math.random, unordered iteration, ...).
//
// Harness: stock node with flag-free .ts type-stripping imports the
// real src/sim sources; the state hash is node:crypto sha256 over
// the world's fixed-precision serialized state. No network, no
// wall-clock dependence.
//
// Run: node tests/fishtank-determinism.test.mjs
// ================================================================
import { createHash } from "node:crypto";
import { World, TANK_WIDTH, TANK_HEIGHT } from "../src/sim/world.ts";
import { FIXED_DT } from "../src/sim/constants.ts";
import { mulberry32 } from "../src/sim/rng.ts";

const STEPS = 100;

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

const stateHash = (w) => createHash("sha256").update(w.serializeState()).digest("hex");

/** Run a world for exactly STEPS fixed steps and return its hash. */
function hashAfterSteps(seed) {
  const w = new World({ seed });
  for (let i = 0; i < STEPS; i++) w.step(FIXED_DT);
  return { w, h: stateHash(w) };
}

// ================================================================
// Criterion: the world API — explicit-dt step(), seedable
// construction, serializable state at fixed precision
// ================================================================
check("World.step takes an explicit dt and advance() always feeds it FIXED_DT", () => {
  const w = new World({ seed: 7 });
  assert(typeof w.step === "function", "World must expose step(dt)");
  w.advance(FIXED_DT * 2 + 0.001); // two whole steps + a sub-step remainder
  assert(w.time === 2 * FIXED_DT, `clock must advance in exact FIXED_DT multiples, got ${w.time}`);
  assert(Math.abs(w.acc - 0.001) < 1e-12, `leftover must be carried, got ${w.acc}`);
  w.step(FIXED_DT * 0.5);
  assert(w.time === 2 * FIXED_DT + FIXED_DT * 0.5, "step(dt) must advance the clock by exactly dt");
  const w2 = new World({ seed: 8 });
  w2.advance(FIXED_DT * 2); // a whole number of steps: the accumulator drains
  assert(w2.time === 2 * FIXED_DT, "whole steps must advance the clock in exact FIXED_DT multiples");
  assert(Math.abs(w2.acc) < 1e-12,
    `whole steps must drain the accumulator to ~0 (fp epsilon), got acc=${w2.acc}`);
});

check("the same seed builds the same initial population", () => {
  const a = new World({ seed: 1234 });
  const b = new World({ seed: 1234 });
  assert(stateHash(a) === stateHash(b), "zero-step states from the same seed must hash identically");
  assert(a.agents.length > 0, "a seeded world must spawn a population");
});

// ================================================================
// Criterion: 100 steps, same seed, independently constructed —
// serialized states hash identically
// ================================================================
check(`two same-seed worlds hash identically after ${STEPS} fixed steps`, () => {
  const { h: ha } = hashAfterSteps(0xdeadbeef);
  const { h: hb } = hashAfterSteps(0xdeadbeef);
  assert(ha === hb, `state hashes diverged after ${STEPS} steps:\n  a: ${ha}\n  b: ${hb}`);
});

check(`determinism holds across multiple seeds (${STEPS} steps each)`, () => {
  for (const seed of [1, 42, 999999999]) {
    const { h: ha } = hashAfterSteps(seed);
    const { h: hb } = hashAfterSteps(seed);
    assert(ha === hb, `seed ${seed}: hashes diverged after ${STEPS} steps (${ha} vs ${hb})`);
  }
});

check("a different seed produces a different trajectory (the seed matters)", () => {
  const { h: ha } = hashAfterSteps(1);
  const { h: hb } = hashAfterSteps(2);
  assert(ha !== hb, "distinct seeds must not collapse onto one trajectory");
});

// ================================================================
// Supporting invariants: serialized precision is fixed, motion is
// bounded, time is exact — the properties that make the hash
// meaningful
// ================================================================
check("serialized state uses fixed 6-decimal precision for every coordinate", () => {
  const w = new World({ seed: 55 });
  w.step(FIXED_DT);
  const s = w.serializeState();
  const lines = s.split("\n").slice(1); // first line is the clock
  assert(lines.length === w.agents.length, "one state line per agent");
  for (const line of lines) {
    const nums = line.split(",").map(Number);
    assert(nums.length === 4, `agent line must carry x,y,vx,vy, got "${line}"`);
    for (const n of nums) {
      assert(Number.isFinite(n), `state must be finite, got ${n}`);
      const str = String(n);
      const frac = str.includes(".") ? str.split(".")[1] : "";
      assert(frac.length <= 6, `precision must be fixed (<= 6 decimals), got ${str}`);
    }
  }
});

check("after 100 steps every agent stays inside the tank domain (bounded, finite)", () => {
  const { w } = hashAfterSteps(77);
  for (const a of w.agents) {
    assert(Number.isFinite(a.x) && Number.isFinite(a.y), "no NaN/Infinity coordinates");
    assert(a.x >= 0 && a.x < TANK_WIDTH && a.y >= 0 && a.y < TANK_HEIGHT,
      `agent escaped the tank: (${a.x}, ${a.y})`);
  }
});

check("the world clock is STEPS * FIXED_DT up to fp accumulation error after the run", () => {
  const { w } = hashAfterSteps(77);
  // 100 successive additions of FIXED_DT differ from one multiply by
  // up to a few ulp — that is accumulation error, not drift.
  assert(Math.abs(w.time - STEPS * FIXED_DT) < 1e-9,
    `clock must be ~${STEPS * FIXED_DT}, got ${w.time}`);
});

// ================================================================
// The rng itself must be a genuine deterministic mulberry32
// (regression: re-implementations of the PRNG break all of this)
// ================================================================
check("mulberry32 is deterministic per seed and differs across seeds", () => {
  const a = mulberry32(2026);
  const b = mulberry32(2026);
  const c = mulberry32(2027);
  const da = Array.from({ length: 8 }, a);
  const db = Array.from({ length: 8 }, b);
  const dc = Array.from({ length: 8 }, c);
  assert(JSON.stringify(da) === JSON.stringify(db), "same seed must replay the same stream");
  assert(JSON.stringify(da) !== JSON.stringify(dc), "different seeds must not share a stream");
  for (const v of [...da, ...dc]) {
    assert(v >= 0 && v < 1, `stream values must sit in [0, 1), got ${v}`);
  }
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
