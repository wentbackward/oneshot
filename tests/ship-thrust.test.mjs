#!/usr/bin/env node
// ================================================================
// Unit tests — ship thrust & coast inertia (ticket #50)
//
// Same harness style as tests/asteroids.test.mjs: runs the REAL
// <script> from asteroids.html in a sandboxed vm context with stubbed
// window/document/canvas, drives frames through the captured
// requestAnimationFrame callback (with per-frame lengths we choose),
// and asserts on observable game state. No network, no external
// services.
//
// Acceptance criteria covered:
//   C1 — held thrust: speed non-decreasing over 180 driven frames,
//        strictly increasing while below SHIP_MAX_SPEED - SHIP_SPEED_EPS,
//        at steady state within SHIP_SPEED_EPS of the cap.
//        The non-decrease bound is sampled along a fixed heading; the
//        implementer's protocol. Rotating the ship under thrust couples
//        heading into the coasting velocity (thrust opposes it mid-turn)
//        and can transiently drop speed — the genre-standard
//        thrust-along-heading model, expected behaviour, not a bug.
//   C2 — coast on release: framerate-independent SHIP_COAST_FRICTION
//        decay; still >= 25% of release speed after 0.25 s; snapped to
//        exactly zero no later than COAST_SETTLE_S (via STOP_SPEED snap).
//   C3 — named, console-retunable top-level vars; direction of travel
//        preserved while coasting (velocity, not position, decays).
//
// Run: node tests/ship-thrust.test.mjs
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
function speedOf(g) {
  return g.q("Math.sqrt(ship.vx * ship.vx + ship.vy * ship.vy)");
}

// Boot a fresh copy of the game with a variable-length frame driver:
// tickFrame(dtMs) advances the rAF clock by exactly dtMs (the game
// clamps the delta to MAX_FRAME_SECONDS itself, so keep dtMs <= ~33).
function boot() {
  const listeners = {};
  const ctxStub = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        return (..._args) => {};
      },
      set(_t, prop) {
        return true;
      },
    }
  );
  const canvasStub = {
    width: 960,
    height: 600,
    getContext: () => ctxStub,
  };
  let rafCallback = null;
  const sandbox = {
    window: {
      innerWidth: 960,
      innerHeight: 600,
      addEventListener: (type, cb) => {
        (listeners[type] ??= []).push(cb);
      },
    },
    document: {
      getElementById: (id) => (id === "game" ? canvasStub : null),
      addEventListener: () => {}, // ticket #114: fullscreenchange registers on document at boot
    },
    requestAnimationFrame: (cb) => {
      rafCallback = cb;
      return 1;
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);
  // Dismiss the start screen (Enter starts play).
  for (const cb of listeners["keydown"] ?? []) cb({ code: "Enter", preventDefault() {} });

  let nowMs = 0;
  function tickFrame(dtMs) {
    nowMs += dtMs;
    rafCallback(nowMs);
  }
  const FRAME_MS = 1000 / 60;
  function tick(n = 1) {
    for (let i = 0; i < n; i++) tickFrame(FRAME_MS);
  }
  function key(code, down) {
    for (const cb of listeners[down ? "keydown" : "keyup"] ?? []) {
      cb({ code, preventDefault() {} });
    }
  }
  const q = (expr) => vm.runInContext(expr, context);
  return { tick, tickFrame, key, q };
}

// Empty field + fresh, centred, upright, still ship: thrust is the
// only input, so sampled speeds reflect the physics under test alone.
function stillShip(g) {
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0");
  g.q("ship.x = 480; ship.y = 300; ship.heading = -Math.PI / 2; ship.vx = 0; ship.vy = 0");
}

// ================================================================
// C3 (knobs): the new tuning vars are named top-level `var`s —
// numeric by default and reassignable from the "console"
// ================================================================
check("SHIP_MAX_SPEED, SHIP_COAST_FRICTION, COAST_SETTLE_S, SHIP_SPEED_EPS are named, mutable, sensible defaults", () => {
  const g = boot();
  assertClose(g.q("SHIP_MAX_SPEED"), 220, 0, "default SHIP_MAX_SPEED must be 220 px/s");
  assertClose(g.q("SHIP_COAST_FRICTION"), 0.95, 0, "default SHIP_COAST_FRICTION must be 0.95 per 60 Hz frame");
  const settle = g.q("COAST_SETTLE_S");
  assert(settle > 1 && settle <= 3, `COAST_SETTLE_S must be in (1, 3] s, got ${settle}`);
  assertClose(g.q("SHIP_SPEED_EPS"), 1, 0, "default SHIP_SPEED_EPS must be 1 px/s");
  // Mutable like every other campaign-1 knob: reassignment sticks.
  g.q("SHIP_MAX_SPEED = 90; SHIP_COAST_FRICTION = 0.9; COAST_SETTLE_S = 1.5; SHIP_SPEED_EPS = 2");
  assertClose(g.q("SHIP_MAX_SPEED"), 90, 0, "SHIP_MAX_SPEED must be reassignable");
  assertClose(g.q("SHIP_COAST_FRICTION"), 0.9, 0, "SHIP_COAST_FRICTION must be reassignable");
  assertClose(g.q("COAST_SETTLE_S"), 1.5, 0, "COAST_SETTLE_S must be reassignable");
  assertClose(g.q("SHIP_SPEED_EPS"), 2, 0, "SHIP_SPEED_EPS must be reassignable");
  // Source-level: `var` declarations at top level (console-retunable),
  // not `const`/`let` lexicals.
  for (const name of ["SHIP_MAX_SPEED", "SHIP_COAST_FRICTION", "COAST_SETTLE_S", "SHIP_SPEED_EPS"]) {
    assert(
      new RegExp("(^|\\n)\\s*var\\s+" + name + "\\s=").test(gameSource),
      `${name} must be a top-level \`var\``
    );
  }
});

// ================================================================
// C1: while thrust is held, speed climbs monotonically from rest
// toward the cap — sample 180 driven frames
// ================================================================
check("held thrust: speed non-decreasing over 180 frames, strictly rising until near the cap, flat at the cap", () => {
  const g = boot();
  stillShip(g);
  const cap = g.q("SHIP_MAX_SPEED");
  const eps = g.q("SHIP_SPEED_EPS");
  g.key("ArrowUp", true);
  const samples = [];
  for (let i = 0; i < 180; i++) {
    g.tick();
    samples.push(speedOf(g));
  }
  for (let i = 1; i < samples.length; i++) {
    assert(samples[i] >= samples[i - 1],
      `speed must never decrease while thrust is held (frame ${i + 1}: ${samples[i - 1]} -> ${samples[i]})`);
  }
  for (let i = 0; i < samples.length - 1; i++) {
    if (samples[i] < cap - eps) {
      assert(samples[i + 1] > samples[i],
        `below the cap minus epsilon the ship must keep accelerating (frame ${i + 1} stalls at ${samples[i]})`);
    }
  }
  assertClose(samples[samples.length - 1], cap, eps,
    "after 3 s of held thrust the ship sits at the cap (steady state)");
  // It must have arrived: early frames are clearly below the cap.
  assert(samples[5] < cap - eps, "early in the hold the ship must still be below the cap (it ramps, it does not jump)");
});

// ================================================================
// C2a: on release the ship still coasts — 0.25 s after letting go,
// speed is >= 25% of the release speed
// ================================================================
check("coast: 0.25 s after release the ship keeps >= 25% of its release speed", () => {
  const g = boot();
  stillShip(g);
  g.key("ArrowUp", true);
  for (let i = 0; i < 90; i++) g.tick(); // well past the ramp: released at the cap
  g.key("ArrowUp", false);
  const vRel = speedOf(g);
  assert(vRel > 50, `precondition: release from real speed, got ${vRel}`);
  g.tick(15); // exactly 0.25 s of coast at 60 fps
  const vQuarter = speedOf(g);
  assert(vQuarter >= 0.25 * vRel,
    `0.25 s after release speed must be >= 25% of release speed (got ${vQuarter} of ${vRel})`);
  assert(vQuarter < vRel, `coast must actually lose speed (release ${vRel} -> ${vQuarter})`);
});

// ================================================================
// C2b: the coast glides (no instant halt) and snaps to EXACTLY
// zero no later than COAST_SETTLE_S, from max speed, via the
// STOP_SPEED snap
// ================================================================
check("coast from max speed: still moving after 0.5 s, snapped to exactly zero within COAST_SETTLE_S", () => {
  const g = boot();
  stillShip(g);
  const settleFrames = Math.floor(g.q("COAST_SETTLE_S") * 60);
  g.key("ArrowUp", true);
  for (let i = 0; i < 90; i++) g.tick();
  g.key("ArrowUp", false);
  g.tick(30); // 0.5 s of coast
  assert(speedOf(g) > 0, "a 0.5 s-old coast must still be moving — no instant halt");
  let stoppedAt = null;
  for (let i = 31; i <= settleFrames; i++) {
    g.tick();
    if (g.q("ship.vx") === 0 && g.q("ship.vy") === 0) {
      stoppedAt = i;
      break;
    }
  }
  assert(stoppedAt !== null,
    `coast must snap to exactly zero by frame ${settleFrames} (${g.q("COAST_SETTLE_S")} s)`);
  assert(g.q("ship.vx") === 0 && g.q("ship.vy") === 0, "velocity must be exactly zero, not just tiny");
});

// ================================================================
// C3: direction of travel is preserved while coasting — the
// VELOCITY decays; the position keeps drifting along the original
// bearing
// ================================================================
check("coast preserves direction: velocity scales uniformly and position keeps drifting the same way", () => {
  const g = boot();
  stillShip(g);
  g.q("ship.x = 480; ship.y = 300");
  g.q("ship.vx = 80; ship.vy = -80"); // 45 deg up-right, no keys held
  const p0 = g.q("({ x: ship.x, y: ship.y })");
  g.tick(60);
  const v1 = g.q("({ vx: ship.vx, vy: ship.vy })");
  const p1 = g.q("({ x: ship.x, y: ship.y })");
  assert(Math.abs(v1.vy / v1.vx + 1) < 1e-9,
    `coast must scale vx and vy together (got vx=${v1.vx}, vy=${v1.vy} — bearing changed)`);
  assert(speedOf(g) < 80 * Math.SQRT2, "coast must reduce speed");
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  assert(dx > 0 && dy < 0, `position must keep drifting up-right while coasting (got ${dx}, ${dy})`);
  assert(Math.abs(dy / dx + 1) < 1e-9, `drift direction must match the coast bearing (got slope ${dy / dx})`);
});

// ================================================================
// C2 (pattern): the coast decay is framerate-independent —
// the v *= FRICTION^(dt*60) pattern: two histories of equal
// sim time (60 x 15 ms vs 30 x 30 ms frames) land on the same
// speed
// ================================================================
check("coast decay is framerate-independent (equal sim time -> equal speed at 15 ms and 30 ms frames)", () => {
  const a = boot();
  const b = boot();
  for (const g of [a, b]) {
    stillShip(g);
    g.q("ship.vx = 0; ship.vy = 150");
    // The first rAF frame always carries dt = 0 (no previous
    // timestamp), so consume it before measuring; both histories
    // lose exactly this one no-op frame.
    g.tickFrame(15);
  }
  for (let i = 0; i < 60; i++) a.tickFrame(15); // 0.9 s at 66.6 fps
  for (let i = 0; i < 30; i++) b.tickFrame(30); // 0.9 s at 33.3 fps
  assertClose(speedOf(a), speedOf(b), 1e-6,
    "equal sim time must yield equal coast speed regardless of frame length");
  assert(speedOf(a) < 150, "and both must be decaying, not holding speed");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
