#!/usr/bin/env node
// ================================================================
// Unit tests — asteroid subsystem (ticket #4)
//
// Same harness style as tests/lasers.test.mjs: runs the REAL
// <script> from index.html in a sandboxed vm context with stubbed
// window/document/canvas, drives frames through the captured
// requestAnimationFrame callback, and asserts on observable game
// state. Spawn randomness is made deterministic where needed by
// reassigning the game's `random` hook from the "console" side.
// No network, no external services.
//
// Run: node tests/asteroids.test.mjs
// ================================================================
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error("no <script> block found in index.html");
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
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Boot a fresh copy of the game with a canvas of the given size.
function boot(width = 960, height = 600) {
  let rafCallback = null;
  const listeners = {};
  const ctxCalls = [];
  const ctxStub = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        return (..._args) => ctxCalls.push(String(prop));
      },
      set(_t, prop) {
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

  let nowMs = 0;
  const FRAME_MS = 1000 / 60;
  function tick(n = 1) {
    for (let i = 0; i < n; i++) {
      nowMs += FRAME_MS;
      rafCallback(nowMs);
    }
  }
  const keydownFlag = { prevented: false };
  function key(code, down) {
    for (const cb of listeners[down ? "keydown" : "keyup"] ?? []) {
      cb({
        code,
        preventDefault() {
          if (code === "Space") keydownFlag.prevented = true;
        },
      });
    }
  }
  const q = (expr) => vm.runInContext(expr, context);
  return {
    tick,
    key,
    q,
    keydownFlag,
    ctxCalls,
    activeAsteroids: () => q("asteroids.slots.filter((a) => a.active)"),
    count: () => q("asteroids.slots.reduce((n, a) => n + (a.active ? 1 : 0), 0)"),
    clearField: () => q("asteroids.slots.forEach((a) => (a.active = false))"),
    ship: () => q("({ x: ship.x, y: ship.y })"),
  };
}

// Manually place a live asteroid at (x, y) with a given radius.
function placeAst(g, x, y, r = 20) {
  const s = g.q("asteroids.slots.find((a) => !a.active)");
  assert(s, "an inactive asteroid slot was available for the test fixture");
  g.q(`(() => { const s = asteroids.slots.find((a) => !a.active);
    s.active = true; s.x = ${x}; s.y = ${y}; s.r = ${r};
    s.vx = 0; s.vy = 0;
    s.shape.length = 6; s.rot = 0; s.spin = 0; return true; })()`);
}

// ================================================================
// Criterion 1 (constants): ASTEROID_TARGET / SCORE_PER_ASTEROID are
// named, mutable tuning constants with the required defaults
// ================================================================
check("ASTEROID_TARGET defaults to a positive integer and SCORE_PER_ASTEROID defaults to exactly 10", () => {
  const g = boot();
  assertClose(g.q("SCORE_PER_ASTEROID"), 10, 0, "default SCORE_PER_ASTEROID must be 10");
  assert(Number.isInteger(g.q("ASTEROID_TARGET")) && g.q("ASTEROID_TARGET") > 0,
    "ASTEROID_TARGET must be a positive integer by default");
});

// ================================================================
// Criterion 1 (target=0): setting ASTEROID_TARGET to 0 stops all
// spawning permanently
// ================================================================
check("setting ASTEROID_TARGET to 0 stops all spawning", () => {
  const g = boot();
  g.q("ASTEROID_TARGET = 0");
  for (let i = 0; i < 2400; i++) g.tick(); // 40 s with no player input
  assert(g.count() === 0, `no asteroid may ever spawn at ASTEROID_TARGET=0, got ${g.count()}`);
});

// ================================================================
// Criterion 1 (population): active count converges on ASTEROID_TARGET
// and follows console reassignments
// ================================================================
check("active asteroid count converges on ASTEROID_TARGET and follows reassignments", () => {
  const g = boot(400, 300);
  g.clearField();
  // Deterministic seed chosen so a field of 2 fills without rejections:
  g.q(`random = (() => { const f = ${String(mulberry32(4))}; return f; })()`);
  g.q("ASTEROID_TARGET = 2");
  for (let i = 0; i < 60 && g.count() < 2; i++) g.tick();
  assertClose(g.count(), 2, 0, "field must fill up to ASTEROID_TARGET");
  for (let i = 0; i < 1800; i++) g.tick(); // 30 s
  assert(g.count() <= 2, `population must never exceed the target, got ${g.count()}`);
  // Raise the target: new spawns resume until the count climbs back to it.
  g.q("ASTEROID_TARGET = 4");
  for (let i = 0; i < 120 && g.count() < 4; i++) g.tick();
  assertClose(g.count(), 4, 0, `raising ASTEROID_TARGET must repopulate the field, got ${g.count()}`);
});

// ================================================================
// Criterion 2 (invariant): every naturally spawned asteroid is at
// least SPAWN_SAFE_RADIUS (200) px from the ship at spawn time
// ================================================================
check("every naturally spawned asteroid starts at least SPAWN_SAFE_RADIUS (200) px from the ship", () => {
  const g = boot(480, 360); // ship (240,180); corners ~300 px away -> room to live
  g.q("ASTEROID_TARGET = 4");
  const ids = new Set();
  let spawns = 0;
  for (let i = 0; i < 4800; i++) { // 80 s of drift, wraps and respawns
    g.tick();
    for (const a of g.activeAsteroids()) {
      if (ids.has(a)) continue;
      ids.add(a);
      spawns++;
      const ship = g.ship();
      const d = Math.hypot(a.x - ship.x, a.y - ship.y);
      assert(d >= g.q("SPAWN_SAFE_RADIUS") - 1e-9,
        `spawn must be >= SPAWN_SAFE_RADIUS from the ship (dist ${d.toFixed(1)} at spawn)`);
    }
  }
  assert(spawns > 0, "the field must actually respawn asteroids over the run");
});

// ================================================================
// Criterion 2 (rejection path, deterministic): an edge spawn inside
// the safe radius is rejected and the retry lands outside it
// ================================================================
check("an edge spawn within the safe radius is rejected and retried outside it", () => {
  const g = boot(300, 300);
  // Ship sits near the left edge so the left edge band falls inside the 200 px safe disc.
  g.q("ship.x = 100; ship.y = 150; ship.vx = 0; ship.vy = 0");
  // Deterministic sequence: attempt 1 -> left edge at (-15,150), 115 px from the ship
  // (rejected); attempt 2 -> right edge at (317,150), 217 px (accepted).
  const rands = [0.5, 0.25, 0.5, 0.5, 0.95, 0.5, 0.5, 0.5];
  g.q(`random = (() => { const r = [${rands}]; let i = 0; return () => r[i++ % r.length]; })()`);
  const before = g.count();
  assert(g.q("spawnAsteroid()") === false,
    "first candidate at (-15,150) is only 115 px from the ship -> spawn must be rejected");
  assert(g.count() === before, "a rejected spawn must not change the field");
  assert(g.q("spawnAsteroid()") === true, "retry from the same seed stream must succeed");
  const a = g.activeAsteroids()[0];
  assertClose(a.x, 317, 1e-9, "accepted spawn is the next deterministic candidate (317,150)");
  assertClose(a.y, 150, 1e-9, "accepted spawn sits on the same edge row (deterministic seed)");
  const ship = g.ship();
  assert(Math.hypot(a.x - ship.x, a.y - ship.y) >= g.q("SPAWN_SAFE_RADIUS"),
    "accepted spawn must lie outside the safe disc");
});

check("spawned asteroids drift from the edge into the field", () => {
  const g = boot(960, 600); // ship (480,300) at centre: every edge is well outside the safe disc
  const rands = [0.2, 0.5, 0.5, 0.5]; // top edge at (464,-17), jitter 0 -> straight toward centre
  g.q(`random = (() => { const r = [${rands}]; let i = 0; return () => r[i++ % r.length]; })()`);
  assert(g.q("spawnAsteroid()"), "fixture spawn succeeds");
  const a = g.activeAsteroids()[0];
  // The spawn point sits just above the top edge (y = -(r+1)).
  assert(a.y < 0 && a.y > -2 * g.q("ASTEROID_MAX_R"), "spawn sits just off the top edge");
  assert(a.vy > 0, "velocity is directed into the field (downward from the top edge)");
  const y0 = a.y;
  g.tick(10);
  assert(a.y > y0, "asteroid drifts inward over the next frames");
});

// ================================================================
// Criterion 3 (initial): HUD score starts at 0
// ================================================================
check("score starts at 0", () => {
  const g = boot();
  assertClose(g.q("score"), 0, 0, "score must be 0 at boot");
});

// ================================================================
// Criterion 3 (kill): a laser crossing an asteroid destroys it and
// adds exactly SCORE_PER_ASTEROID
// ================================================================
check("a laser crossing an asteroid destroys it and adds exactly SCORE_PER_ASTEROID", () => {
  const g = boot(960, 600); // ship (480,300) facing up
  placeAst(g, 480, 300 - 40); // r=20 -> band 20..60 px above the ship; frame-1 beam sweep (23..34.7) crosses it
  g.key("Space", true);
  g.tick(); // frame 1: beam spans 23..34.7 px above the ship
  assertClose(g.q("score"), 10, 0, "first crossing scores exactly the default 10");
  assert(g.count() === 0, "killed asteroid must be removed from the field");
  g.tick(60); // no further kills possible: empty field
  assertClose(g.q("score"), 10, 0, "score must not change without further kills");
});

check("each kill adds exactly SCORE_PER_ASTEROID and kills accumulate", () => {
  const g = boot(960, 600);
  placeAst(g, 480, 300 - 40); // band 20..60 px -> crossed by the frame-1 sweep (23..34.7)
  placeAst(g, 480, 300 - 90); // band 70..110 px -> crossed by the frame-5 sweep (69.7..81.3)
  g.key("Space", true);
  g.tick();
  assertClose(g.q("score"), 10, 0, "one kill scores exactly 10");
  assertClose(g.count(), 1, 0, "only the crossed asteroid is destroyed");
  g.tick(); // beam sweeps 34.7..46.3 px: still short of the second asteroid's 70 px edge
  assertClose(g.q("score"), 10, 0, "second asteroid untouched while the beam has not reached it");
  g.tick(3); // beam sweeps up to 81.3 px: enters the second asteroid's 70..110 band
  assertClose(g.q("score"), 20, 0, "two kills score exactly 2 x SCORE_PER_ASTEROID");
  assertClose(g.count(), 0, 0, "both asteroids removed");
});

check("setting SCORE_PER_ASTEROID to 50 makes each kill worth exactly 50", () => {
  const g = boot(960, 600);
  g.q("SCORE_PER_ASTEROID = 50");
  placeAst(g, 480, 300 - 40);
  g.key("Space", true);
  g.tick();
  assertClose(g.q("score"), 50, 0, "kill must credit the reassigned constant");
});

// ================================================================
// Criterion 4: asteroids are drawn as procedural canvas polygons
// (path building, not image assets) and the HUD draws the score
// ================================================================
check("rendering builds polygon paths per asteroid and draws the score text", () => {
  const g = boot(960, 600);
  placeAst(g, 480, 220);
  g.ctxCalls.length = 0;
  g.tick();
  const calls = g.ctxCalls;
  const closePaths = calls.filter((c) => c === "closePath").length;
  assert(closePaths >= 2,
    `render must build a closed polygon path for the asteroid (and the ship); got ${closePaths} closePath calls`);
  assert(calls.some((c) => c === "fillText"), "HUD score must be drawn with fillText");
  assert(calls.includes("strokeStyle") || calls.includes("fillStyle"),
    "asteroid polygon must be styled and filled/stroked procedurally");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
