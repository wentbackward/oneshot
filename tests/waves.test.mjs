#!/usr/bin/env node
// ================================================================
// Unit tests — numbered waves with rising difficulty (ticket #7)
//
// Same harness style as tests/drones.test.mjs: runs the REAL
// <script> from asteroids.html in a sandboxed vm context with stubbed
// window/document/canvas, drives frames through the captured
// requestAnimationFrame callback, and asserts on observable game
// state plus the recorded canvas calls (HUD text).
//
// The behavioural tests park the ship in a corner so drifting rocks
// (which are aimed at the field centre) cannot destroy wave hazards
// behind the player's back and skew the counted rosters, and pin the
// game's `random` hook to a fixed mulberry32 sequence so every run
// (including every roster-count wait) is bit-for-bit deterministic.
//
// Run: node tests/waves.test.mjs
// ================================================================
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "asteroids.html"), "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error("no <script> block found in asteroids.html");
const gameSource = match[1];

// ---------- tiny test harness ----------
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
function assertClose(actual, expected, tol, msg) {
  const diff = Math.abs(actual - expected);
  if (!Number.isFinite(diff) || diff > tol) {
    throw new Error(`${msg} (got ${actual}, want ~${expected})`);
  }
}

// Deterministic-RNG factory: emits SELF-CONTAINED source (no closures), so
// the generated function keeps working when evaluated inside the vm
// sandbox. Same precedent as tests/asteroids.test.mjs — every spawn roll
// in this suite is a fixed sequence, so every roster-count wait is
// deterministic and a drifted survivor can never shatter the asserted
// invariants.
function mulberry32Source(seed) {
  return `(() => { let a = ${(seed >>> 0) | 0};
    return () => { a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })()`;
}

// Boot a fresh copy of the game with a canvas of the given size.
// The ctx stub records both method names and fillText payloads so
// tests can assert on the HUD wave number.
// The game's `random` hook is pinned to a fixed mulberry32 sequence:
// identical rosters, drifts and collisions in every run.
function boot(width = 960, height = 600) {
  const seed = process.env.WAVES_TEST_SEED ? Number(process.env.WAVES_TEST_SEED) : 7;
  let rafCallback = null;
  const listeners = {};
  const ctxCalls = [];
  const ctxTexts = [];
  const ctxStub = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        if (prop === "fillText") return (text) => ctxTexts.push(String(text));
        return (..._args) => ctxCalls.push(String(prop));
      },
      set() {
        return true;
      },
    }
  );
  const canvasStub = { width, height, getContext: () => ctxStub };
  const sandbox = {
    window: {
      innerWidth: width,
      innerHeight: height,
      addEventListener: (type, cb) => {
        (listeners[type] ??= []).push(cb);
      },
    },
    document: { getElementById: (id) => (id === "game" ? canvasStub : null) },
    requestAnimationFrame: (cb) => {
      rafCallback = cb;
      return 1;
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);
  vm.runInContext(`random = ${mulberry32Source(seed)};`, context);
  // Ticket #8: dismiss the start screen so this suite drives the
  // running simulation (Enter starts play).
  for (const cb of listeners["keydown"] ?? []) cb({ code: "Enter", preventDefault() {} });

  let nowMs = 0;
  const FRAME_MS = 1000 / 60;
  function tick(n = 1) {
    for (let i = 0; i < n; i++) {
      nowMs += FRAME_MS;
      rafCallback(nowMs);
    }
  }
  const q = (expr) => vm.runInContext(expr, context);
  return {
    tick,
    q,
    ctxCalls,
    ctxTexts,
    wave: () => q("wave"),
    hazardCount: () =>
      q("(asteroids.slots.reduce((n, a) => n + (a.active ? 1 : 0), 0) + " +
        "drones.slots.reduce((n, d) => n + (d.active ? 1 : 0), 0))"),
    asteroidCount: () => q("asteroids.slots.reduce((n, a) => n + (a.active ? 1 : 0), 0)"),
    droneCount: () => q("drones.slots.reduce((n, d) => n + (d.active ? 1 : 0), 0)"),
    // "Destroy" every live hazard the way a laser kill does.
    clearField: () => q(
      "asteroids.slots.forEach((a) => (a.active = false)); " +
        "drones.slots.forEach((d) => (d.active = false))"
    ),
    // Destroy all but the last `keep` live hazards, then pin the
    // survivors so they can never wander into the parked ship and die
    // for the test's sake: zeroing vx/vy pins asteroids, but drone
    // motion is heading x DRONE_SPEED — pinning a drone requires
    // DRONE_SPEED = 0 (position/heading alone would just re-steer).
    keepLast: (keep) => q(`(() => {
      const ast = asteroids.slots.filter((a) => a.active);
      const dro = drones.slots.filter((d) => d.active);
      const all = ast.concat(dro);
      all.slice(${keep}).forEach((h) => (h.active = false));
      all.slice(0, ${keep}).forEach((h) => { h.vx = 0; h.vy = 0; });
      if (dro.length > 0) DRONE_SPEED = 0; // pin drone survivors (see above)
    })()`),
  };
}

// Zero all four wave-size constants: every wave's roster is empty,
// nothing auto-spawns, and the (empty) wave never "completes".
function suppressSpawns(g) {
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0");
}

// Park the ship in a top-left corner: rocks are aimed at the field
// centre, so a cornered ship keeps the wave roster intact for
// long passive simulations.
function parkShip(g) {
  g.q("ship.x = 40; ship.y = 40; ship.vx = 0; ship.vy = 0");
}

// Tick until `fn()` is true or the frame budget runs out.
function waitUntil(g, fn, frames = 300, what) {
  for (let i = 0; i < frames; i++) {
    if (fn()) return i;
    g.tick();
  }
  throw new Error(`timed out after ${frames} frames waiting for: ${what}`);
}

// ================================================================
// Criterion 2 (constants + formula): wave rosters are sized by
// named constants — ASTEROID_BASE + ASTEROID_GROWTH * (N-1) with
// defaults 6 / +2, DRONE_BASE + DRONE_GROWTH * (N-1) with defaults
// 0 / +1, and BETWEEN_WAVES_S defaulting to 3
// ================================================================
check("wave-size constants are named, mutable, and default to 6/+2 asteroids, 0/+1 drones, 3 s pause", () => {
  const g = boot();
  for (const name of ["ASTEROID_BASE", "ASTEROID_GROWTH", "DRONE_BASE", "DRONE_GROWTH", "BETWEEN_WAVES_S"]) {
    assert(typeof g.q(name) === "number", `${name} must be a named numeric constant`);
  }
  assertClose(g.q("ASTEROID_BASE"), 6, 0, "default ASTEROID_BASE must be 6");
  assertClose(g.q("ASTEROID_GROWTH"), 2, 0, "default ASTEROID_GROWTH must be 2");
  assertClose(g.q("DRONE_BASE"), 0, 0, "default DRONE_BASE must be 0");
  assertClose(g.q("DRONE_GROWTH"), 1, 0, "default DRONE_GROWTH must be 1");
  assertClose(g.q("BETWEEN_WAVES_S"), 3, 0, "default BETWEEN_WAVES_S must be 3");
  // Mutable like every other tuning knob: reassignment from the console sticks.
  g.q("ASTEROID_BASE = 1; DRONE_GROWTH = 4; BETWEEN_WAVES_S = 0.5");
  assertClose(g.q("ASTEROID_BASE"), 1, 0, "ASTEROID_BASE must be reassignable");
  assertClose(g.q("DRONE_GROWTH"), 4, 0, "DRONE_GROWTH must be reassignable");
  assertClose(g.q("BETWEEN_WAVES_S"), 0.5, 0, "BETWEEN_WAVES_S must be reassignable");
});

check("wave rosters follow the named formulas for any wave number", () => {
  const g = boot();
  assertClose(g.q("waveAsteroidCount(1)"), 6, 0, "wave 1 must field ASTEROID_BASE (6) asteroids");
  assertClose(g.q("waveAsteroidCount(2)"), 8, 0, "wave 2 must field ASTEROID_BASE + ASTEROID_GROWTH (8) asteroids");
  assertClose(g.q("waveAsteroidCount(5)"), 14, 0, "wave 5 must field ASTEROID_BASE + 4*ASTEROID_GROWTH (14) asteroids");
  assertClose(g.q("waveDroneCount(1)"), 0, 0, "wave 1 must field DRONE_BASE (0) drones");
  assertClose(g.q("waveDroneCount(2)"), 1, 0, "wave 2 must field DRONE_BASE + DRONE_GROWTH (1) drone");
  assertClose(g.q("waveDroneCount(4)"), 3, 0, "wave 4 must field DRONE_BASE + 3*DRONE_GROWTH (3) drones");
});

// ================================================================
// Criterion 1: HUD shows the current wave number, starting at 1
// ================================================================
check("HUD draws the wave number, starting at WAVE 1", () => {
  const g = boot();
  suppressSpawns(g); // keep the HUD assertion focused on wave text
  assertClose(g.wave(), 1, 0, "the game must start on wave 1");
  g.tick(5);
  assert(g.ctxTexts.some((t) => t === "WAVE 1"),
    `the HUD must draw "WAVE 1", got ${JSON.stringify([...new Set(g.ctxTexts)])}`);
});

// ================================================================
// Criterion 2 (behaviour): wave 1 has 6 asteroids and 0 drones;
// after clearing it, wave 2 has 8 asteroids and >= 1 drone
// ================================================================
check("wave 1 fields 6 asteroids and 0 drones; clearing it brings wave 2 with 8 asteroids and a drone", () => {
  const g = boot();
  parkShip(g);
  waitUntil(g, () => g.asteroidCount() === 6, 300, "wave 1 to build its 6-asteroid roster");
  assertClose(g.wave(), 1, 0, "the first field is wave 1");
  assert(g.ctxTexts.some((t) => t === "WAVE 1"), "HUD must show WAVE 1 while wave 1 is live");
  g.tick(120); // 2 s of wave 1 play
  assertClose(g.wave(), 1, 0, "wave 1 must not advance while its roster is alive");
  assertClose(g.droneCount(), 0, 0, "wave 1 must field no drones (DRONE_BASE is 0)");
  assertClose(g.asteroidCount(), 6, 0, "wave 1 must keep exactly its 6 asteroids");

  g.clearField(); // destroy every hazard -> wave 1 is cleared
  waitUntil(g, () => g.wave() === 2, 240, "wave 2 to start after the pause");
  assertClose(g.wave(), 2, 0, "clearing wave 1 must increment the wave number to exactly 2");
  assert(g.ctxTexts.some((t) => t === "WAVE 2"),
    `the HUD must show WAVE 2 after the advance, got ${JSON.stringify([...new Set(g.ctxTexts)])}`);
  waitUntil(g, () => g.asteroidCount() === 8 && g.droneCount() >= 1, 300,
    "wave 2 to build its 8 asteroids and at least 1 drone");
  assertClose(g.asteroidCount(), 8, 0, "wave 2 must field 8 asteroids");
  assert(g.droneCount() >= 1, "wave 2 must field at least 1 drone");
});

// ================================================================
// Criterion 3: the wave ends only when EVERY hazard is destroyed;
// the next wave spawns after exactly BETWEEN_WAVES_S (3 s), and
// the wave number increments by exactly 1
// ================================================================
check("a wave with one hazard still alive neither ends nor respawns its losses", () => {
  const g = boot();
  parkShip(g);
  waitUntil(g, () => g.asteroidCount() === 6, 300, "wave 1 to build its 6-asteroid roster");
  g.keepLast(1); // five destroyed, one survivor
  g.tick(300); // 5 s: far longer than the old 0.25 s respawn cadence
  assertClose(g.wave(), 1, 0, "the wave must not end while one hazard survives");
  assertClose(g.asteroidCount(), 1, 0,
    "destroyed hazards must not be replaced; the survivor is the only hazard in the field");
});

check("a cleared wave pauses for BETWEEN_WAVES_S (3 s) and the wave number rises by exactly 1", () => {
  const g = boot();
  parkShip(g);
  waitUntil(g, () => g.asteroidCount() === 6, 300, "wave 1 to build its 6-asteroid roster");
  g.clearField();
  // Count the frames from the clear until the next wave starts. The
  // clear lands on some frame; the completion is detected no later
  // than one frame later; 3 s = 180 frames. So the advance must
  // happen 180 or 181 frames after the clear, no sooner, no later.
  let framesSinceClear = 0;
  let advancedAt = -1;
  for (let i = 0; i < 240; i++) {
    g.tick();
    framesSinceClear++;
    assert(g.hazardCount() === 0,
      `the field must stay empty during the pause (frame ${framesSinceClear})`);
    if (g.wave() === 2) { advancedAt = framesSinceClear; break; }
  }
  assert(advancedAt >= 180 && advancedAt <= 181,
    `the next wave must start BETWEEN_WAVES_S (3 s = 180 frames) after the clear, got ${advancedAt} frames`);
  assertClose(g.wave(), 2, 0, "the wave number must rise by exactly 1");
  waitUntil(g, () => g.asteroidCount() >= 1, 300, "wave 2 to begin spawning after the pause");
});

// ================================================================
// Criterion 4: BETWEEN_WAVES_S = 0 starts the next wave immediately
// after the clear
// ================================================================
check("setting BETWEEN_WAVES_S to 0 starts the next wave immediately after the clear", () => {
  const g = boot();
  parkShip(g);
  g.q("BETWEEN_WAVES_S = 0");
  waitUntil(g, () => g.asteroidCount() === 6, 300, "wave 1 to build its 6-asteroid roster");
  g.clearField();
  for (let i = 0; i < 2 && g.wave() !== 2; i++) {
    g.tick(); // detection (at most one frame) + immediate start
  }
  assertClose(g.wave(), 2, 0,
    `with BETWEEN_WAVES_S = 0 the next wave must start on the next frame(s), still on wave ${g.wave()}`);
  waitUntil(g, () => g.asteroidCount() >= 1, 300, "wave 2 to spawn right away");
  assertClose(g.wave(), 2, 0, "the immediate next wave must still be wave 2 (+1, not +2)");
});

// ================================================================
// Edge: consecutive waves keep growing per the formulas, each step
// advancing the wave number by exactly one
// ================================================================
check("back-to-back clears walk the wave number 1 -> 2 -> 3 with rosters 6 / 8+1 / 10+2", () => {
  const g = boot();
  parkShip(g);
  const seen = [1];
  // Wave 1: 6 rocks, no drones.
  waitUntil(g, () => g.asteroidCount() === 6, 300, "wave 1 roster (6 asteroids)");
  assertClose(g.droneCount(), 0, 0, "wave 1 fields no drones");
  g.clearField();
  // Wave 2: 8 rocks, 1 drone.
  waitUntil(g, () => g.wave() === 2, 240, "advance to wave 2");
  assertClose(g.wave(), seen[seen.length - 1] + 1, 0, "the advance must be exactly one wave");
  seen.push(g.wave());
  waitUntil(g, () => g.asteroidCount() === 8 && g.droneCount() === 1, 300, "wave 2 roster (8 asteroids, 1 drone)");
  g.clearField();
  // Wave 3: 10 rocks, 2 drones.
  waitUntil(g, () => g.wave() === 3, 240, "advance to wave 3");
  assertClose(g.wave(), seen[seen.length - 1] + 1, 0, "the advance must be exactly one wave");
  seen.push(g.wave());
  waitUntil(g, () => g.asteroidCount() === 10 && g.droneCount() === 2, 300, "wave 3 roster (10 asteroids, 2 drones)");
  assert(g.ctxTexts.some((t) => t === "WAVE 3"), "HUD must show WAVE 3 by the third roster");
});

// ================================================================
// Edge: a zero-sized roster can never be "cleared" — hermetic
// zero-field setups must hold steady instead of cycling waves
// ================================================================
check("a zero-sized wave spawns nothing and never advances (no infinite wave cycling)", () => {
  const g = boot();
  suppressSpawns(g);
  for (let i = 0; i < 1200; i++) { // 20 s of idle play
    g.tick();
    assert(g.hazardCount() === 0, `no hazard may spawn from zero-sized rosters (frame ${i + 1})`);
  }
  assertClose(g.wave(), 1, 0, "an endless empty wave must keep the wave number at 1");
});

// ================================================================
// Edge (pool capacity): the per-wave roster is clamped to the
// pre-allocated pool size — a wave whose formula roster exceeds the
// pool must still build, clear, and advance instead of deadlocking
// (and cleared hazards must not respawn from an unreachable roster)
// ================================================================
check("waveTotal clamps each roster at its pool capacity (never exceeds the pooled slots)", () => {
  const g = boot();
  // Defaults: wave 23 wants 6 + 22*2 = 50 asteroids (pool 48) and
  // 22 drones (pool 24) -> effective roster 48 + 22 = 70, not 72.
  assertClose(g.q("waveTotal(23)"), 48 + 22, 0,
    "wave 23's roster must clamp to 48 asteroids + 22 drones = 70");
  // Console tune that blows through both pools at once: wave 1 wants
  // 50 asteroids and 25 drones -> clamped to the 48 + 24 pools.
  g.q("ASTEROID_BASE = 50; DRONE_BASE = 25");
  assertClose(g.q("waveTotal(1)"), 48 + 24, 0,
    "an over-full wave 1 must clamp to the 48 + 24 pool capacities");
  assert(g.q("waveTotal(100)") <= 48 + 24,
    "no wave may demand more hazards than exist as pooled slots");
});

check("an over-full asteroid roster clamps to the pool: the wave still completes and losses are not replaced",
() => {
  const g = boot();
  parkShip(g);
  g.q("ASTEROID_BASE = 50"); // wave 1 wants 50 rocks, only 48 slots exist
  waitUntil(g, () => g.asteroidCount() === 48, 1200, "the field to saturate the 48-slot asteroid pool");
  g.clearField(); // destroy every hazard of the clamped roster
  let advancedAt = -1;
  for (let i = 0; i < 300; i++) {
    g.tick();
    assert(g.hazardCount() === 0, `the field must stay empty while the clamped wave pauses (frame ${i + 1})`);
    if (g.wave() === 2) { advancedAt = i + 1; break; }
  }
  assert(advancedAt !== -1,
    "a roster larger than the pool must not deadlock the wave: clear + pause must reach wave 2");
  assertClose(g.wave(), 2, 0, "the clamped wave must advance by exactly one");
  waitUntil(g, () => g.asteroidCount() >= 1, 1200, "wave 2 to begin rebuilding after the pause");
});

check("an over-full drone roster clamps to the 24-slot drone pool without deadlocking",
() => {
  const g = boot();
  parkShip(g);
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 25; DRONE_GROWTH = 0");
  // Chasers that reach the parked ship die and (per the never-replace
  // rule) are not re-spawned once the clamped roster of 24 spawns has
  // all happened — so the invariant is "roster fully spawned", not
  // "24 alive at once" (the pool caps the latter by construction).
  waitUntil(g, () => g.q("waveBuilt >= waveTotal(1)"), 1200, "the clamped 24-drone roster to finish spawning");
  assert(g.droneCount() <= 24, `the drone field may never exceed the 24-slot pool, got ${g.droneCount()}`);
  assert(g.droneCount() >= 1, "at least one chaser must be alive once the roster has spawned");
  g.clearField();
  for (let i = 0; i < 300 && g.wave() !== 2; i++) {
    g.tick();
    assert(g.hazardCount() === 0, `the field must stay empty while the clamped wave pauses (frame ${i + 1})`);
  }
  assertClose(g.wave(), 2, 0,
    "a drone roster larger than the pool must not deadlock the wave");
  waitUntil(g, () => g.droneCount() >= 1, 1200, "wave 2 to rebuild its drone roster after the pause");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
