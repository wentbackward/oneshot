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
// Deterministic-RNG factory: emits SELF-CONTAINED source (no closures), so
// the generated function keeps working when evaluated inside the vm sandbox.
function mulberry32Source(seed) {
  return `(() => { let a = ${(seed >>> 0) | 0};
    return () => { a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })()`;
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
// Criterion 1 (constants): ASTEROID_BASE / ASTEROID_GROWTH / 
// SCORE_PER_ASTEROID are named, mutable tuning constants with the
// required defaults
// ================================================================
check("ASTEROID_BASE and ASTEROID_GROWTH default to 6 / +2, and SCORE_PER_ASTEROID defaults to exactly 10", () => {
  const g = boot();
  assertClose(g.q("SCORE_PER_ASTEROID"), 10, 0, "default SCORE_PER_ASTEROID must be 10");
  assertClose(g.q("ASTEROID_BASE"), 6, 0, "default ASTEROID_BASE must be 6 (wave 1 roster)");
  assertClose(g.q("ASTEROID_GROWTH"), 2, 0, "default ASTEROID_GROWTH must be 2");
  assert(Number.isInteger(g.q("ASTEROID_BASE")) && g.q("ASTEROID_BASE") > 0,
    "ASTEROID_BASE must be a positive integer by default");
});

// ================================================================
// Criterion 1 (roster=0): zeroing the wave rosters stops all
// spawning permanently
// ================================================================
check("zeroing the wave rosters stops all asteroid spawning", () => {
  const g = boot();
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0");
  for (let i = 0; i < 2400; i++) g.tick(); // 40 s with no player input
  assert(g.count() === 0, `no asteroid may ever spawn from zero-sized rosters, got ${g.count()}`);
});

// ================================================================
// Criterion 1 (population): active count builds up to the wave
// roster and follows console reassignments
// ================================================================
check("active asteroid count builds up to the wave roster and follows reassignments", () => {
  const g = boot(400, 300);
  g.clearField();
  // Deterministic seed chosen so a field of 2 fills within one spawn burst:
  g.q(`random = ${mulberry32Source(4)}`);
  // Wave-shaped world: flat roster, no drones.
  g.q("ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0");
  g.q("ASTEROID_BASE = 2");
  for (let i = 0; i < 60 && g.count() < 2; i++) g.tick();
  assertClose(g.count(), 2, 0, "field must build up to the wave roster");
  for (let i = 0; i < 1800; i++) g.tick(); // 30 s
  assert(g.count() <= 2, `population must never exceed the roster, got ${g.count()}`);
  // Raise the roster: the build resumes until the count climbs back to it.
  g.q("ASTEROID_BASE = 4");
  for (let i = 0; i < 120 && g.count() < 4; i++) g.tick();
  assertClose(g.count(), 4, 0, `raising the roster must rebuild the field, got ${g.count()}`);
});

// ================================================================
// Criterion 2 (invariant): every naturally spawned asteroid is at
// least SPAWN_SAFE_RADIUS (200) px from the ship at spawn time
// ================================================================
check("every naturally spawned asteroid starts at least SPAWN_SAFE_RADIUS (200) px from the ship", () => {
  const g = boot(480, 360); // ship (240,180); corners ~300 px away -> room to live
  // Pool slots are recycled in place, so we cannot memoise on slot identity
  // alone: detect each inactive->active transition every frame instead,
  // which catches new-wave rosters as well as first activations.
  let prevActive = new Set();
  let spawns = 0;
  for (let i = 0; i < 4800; i++) { // 80 s of drift, wraps and new-wave rosters
    g.tick();
    const act = g.activeAsteroids();
    const nowActive = new Set(act);
    for (const a of act) {
      if (prevActive.has(a)) continue; // still alive from the previous frame
      spawns++;
      const ship = g.ship();
      const d = Math.hypot(a.x - ship.x, a.y - ship.y);
      assert(d >= g.q("SPAWN_SAFE_RADIUS") - 1e-9,
        `spawn must be >= SPAWN_SAFE_RADIUS from the ship (dist ${d.toFixed(1)} at spawn)`);
    }
    for (const a of prevActive) if (!nowActive.has(a)) prevActive.delete(a);
    for (const a of nowActive) if (!prevActive.has(a)) prevActive.add(a);
  }
  assert(spawns > 0, "the field must actually respawn asteroids over the run");
});

// ================================================================
// Criterion 2 (rejection path, deterministic): an edge spawn inside
// the safe radius is rejected and the retry lands outside it
// ================================================================
check("edge spawns within the safe radius are rejected; a candidate outside it is accepted", () => {
  const g = boot(300, 300);
  // Ship sits near the left edge so the left edge band lies inside the 200 px safe disc.
  g.q("ship.x = 100; ship.y = 150; ship.vx = 0; ship.vy = 0");
  const before = g.count();
  // Stream where every candidate lands at (-15,150), only 115 px from the ship:
  // all retries must be rejected and the spawn abandoned.
  g.q(`random = (() => { const r = [0.5, 0.25, 0.5]; let i = 0; return () => r[i++ % r.length]; })()`);
  assert(g.q("spawnAsteroid()") === false,
    "candidates within the safe radius must be rejected (spawn returns false)");
  assert(g.count() === before, "rejected spawns must not change the field");
  // Stream whose single candidate is the right edge at (317,150), 217 px from the ship.
  g.q(`random = (() => { const r = [0.95, 0.5, 0.5]; let i = 0; return () => r[i++ % r.length]; })()`);
  assert(g.q("spawnAsteroid()") === true, "a candidate outside the safe disc must be accepted");
  const a = g.activeAsteroids()[0];
  assertClose(a.x, 317, 1e-9, "accepted spawn is the deterministic candidate (317,150)");
  assertClose(a.y, 150, 1e-9, "accepted spawn sits at the seeded edge coordinate");
  const ship = g.ship();
  assert(Math.hypot(a.x - ship.x, a.y - ship.y) >= g.q("SPAWN_SAFE_RADIUS"),
    "accepted spawn must lie outside the safe disc");
});

// Regression for the wrap-before-entry bug: a freshly spawned rock is fully
// off-screen, so the old "fully off -> wrap" rule teleported it to the
// opposite edge on the very next frame. While the rock's centre is still
// outside the field, its coordinate along the spawn axis must therefore move
// monotonically through the edge it spawned at, and never leave the spawn
// band. (Previously this test only asserted y > y0 with y0 = -17, which the
// teleport to y = 615 trivially satisfied.)
check("spawned asteroids enter monotonically through their spawn edge (no wrap-teleport)", () => {
  const g = boot(960, 600); // ship (480,300) at centre: every edge is well outside the safe disc
  // Seeded: top edge at (480, -17) (r = 16), jitter 0 -> straight down toward
  // the centre at 100 px/s; with vy > 0, y must climb smoothly from -17 to 0.
  const rands = [0.2, 0.5, 0.5, 0.5];
  g.q(`random = (() => { const r = [${rands}]; let i = 0; return () => r[i++ % r.length]; })()`);
  assert(g.q("spawnAsteroid()"), "fixture spawn succeeds");
  const a = g.activeAsteroids()[0]; // vm slot objects keep identity across ticks
  assertClose(a.y, -17, 1e-9, "spawn sits just off the top edge at y = -(r+1)");
  assert(a.vy > 0, "velocity is directed into the field (downward from the top edge)");
  let prev = a.y;
  for (let i = 0; i < 30 && a.y <= 0; i++) {
    g.tick();
    assert(a.y >= prev - 1e-9, `y must not decrease while entering (frame ${i + 1}: ${prev} -> ${a.y})`);
    assert(a.y >= -(a.r + 1) - 1e-9, `y must stay inside the spawn band, got ${a.y}`);
    assert(a.y < 600, `rock must not be teleported across the field, got y=${a.y}`);
    prev = a.y;
  }
  assert(a.y > 0, "rock's centre must cross into the field at the top edge");
});

// Even with bounded ±60° jitter, a candidate near a screen corner can be
// aimed outward along the spawn edge (velocity component away from the
// field). Such a candidate must be re-aimed inward, or it would drift away
// forever and silently eat a pool slot.
check("outward-pointing spawn candidates are re-aimed into the field", () => {
  const g = boot(960, 600);
  // Seeded: top edge at x = 0; direction to centre tilts ~57° off the
  // inward normal, and the seeded jitter rotates the heading a further
  // ~46° the wrong way -> raw velocity points up and away from the field.
  const rands = [0.01, 0.5, 0, 0.1];
  g.q(`random = (() => { const r = [${rands}]; let i = 0; return () => r[i++ % r.length]; })()`);
  assert(g.q("spawnAsteroid()"), "corner candidate still spawns");
  const a = g.activeAsteroids()[0];
  assert(a.x === 0 && a.y < 0, "fixture is the top-edge corner candidate");
  assert(a.vy > 0, "spawn velocity must point into the field (downward from the top edge)");
  let prev = a.y;
  for (let i = 0; i < 900 && a.y <= 0; i++) {
    g.tick();
    assert(a.y >= prev - 1e-9, `y must not decrease while entering (frame ${i + 1})`);
    prev = a.y;
  }
  assert(a.y > 0, "re-aimed rock must eventually cross into the field");
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
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0"); // zero rosters: only our fixtures exist
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
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0"); // zero rosters: only our fixtures exist
  g.key("Space", true);
  g.tick();
  assertClose(g.q("score"), 10, 0, "one kill scores exactly 10");
  assertClose(g.count(), 1, 0, "only the crossed asteroid is destroyed");
  g.tick(); // beam sweeps 34.7..46.3 px: still short of the second asteroid's 70 px edge
  assertClose(g.q("score"), 10, 0, "second asteroid untouched while the beam has not reached it");
  g.tick(4); // beam sweeps up to 93 px: well inside the second asteroid's 70..110 band
  assertClose(g.q("score"), 20, 0, "two kills score exactly 2 x SCORE_PER_ASTEROID");
  assertClose(g.count(), 0, 0, "both asteroids removed");
});

check("setting SCORE_PER_ASTEROID to 50 makes each kill worth exactly 50", () => {
  const g = boot(960, 600);
  g.q("SCORE_PER_ASTEROID = 50");
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0"); // zero rosters: only our fixtures exist
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
  assert(calls.includes("fill") && calls.includes("stroke"),
    "asteroid polygon must be filled and stroked procedurally");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
