#!/usr/bin/env node
// ================================================================
// Unit tests — ship damage, invulnerability, particle bursts (ticket #5)
//
// Same harness style as tests/asteroids.test.mjs: runs the REAL
// <script> from asteroids.html in a sandboxed vm context with stubbed
// window/document/canvas, drives frames through the captured
// requestAnimationFrame callback, and asserts on observable game
// state plus the recorded canvas calls (fillText text and method
// names). No network, no external services.
//
// Run: node tests/ship-damage.test.mjs
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

// Boot a fresh copy of the game with a canvas of the given size.
// The ctx stub records both method names and fillText payloads so
// tests can assert on HUD text and on what the ship/particle layers
// actually draw.
function boot(width = 960, height = 600) {
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
  function key(code, down) {
    for (const cb of listeners[down ? "keydown" : "keyup"] ?? []) {
      cb({ code, preventDefault() {} });
    }
  }
  const q = (expr) => vm.runInContext(expr, context);
  return {
    tick,
    key,
    q,
    ctxCalls,
    ctxTexts,
    ship: () => q("({ x: ship.x, y: ship.y, vx: ship.vx, vy: ship.vy })"),
    hp: () => q("hp"),
    asteroidCount: () => q("asteroids.slots.reduce((n, a) => n + (a.active ? 1 : 0), 0)"),
    laserCount: () => q("laserPool.slots.reduce((n, s) => n + (s.active ? 1 : 0), 0)"),
    activeParticles: () => q("particlePool.slots.filter((p) => p.active)"),
    clearField: () => q("asteroids.slots.forEach((a) => (a.active = false))"),
  };
}

// Manually place a live, parked asteroid centred at (x, y).
function placeAst(g, x, y, r = 20) {
  g.q(`(() => { const s = asteroids.slots.find((a) => !a.active);
    if (!s) throw new Error("no free asteroid slot for fixture");
    s.active = true; s.tier = 0; s.x = ${x}; s.y = ${y}; s.r = ${r};
    s.vx = 0; s.vy = 0; s.rot = 0; s.spin = 0; s.entry = -1;
    s.shape.length = 6; return true; })()`);
}

// On the default 960x600 boot the ship rests at (480, 300); a parked
// rock with r = 20 centred 25 px away overlaps (25 < 14 + 20).
const HIT_X = 480;
const HIT_Y = 275;

// Suppress all auto-spawning: zero-sized wave rosters spawn nothing,
// and an endless empty wave never completes (no wave cycling).
function suppressSpawns(g) {
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0");
}

// ================================================================
// Criterion 1: ship starts at PLAYER_MAX_HP (default 3), shown in the
// HUD; HUD and counter update on every change
// ================================================================
check("PLAYER_MAX_HP defaults to 3, INVULN_MS defaults to 1500, and hp starts at PLAYER_MAX_HP", () => {
  const g = boot();
  assertClose(g.q("PLAYER_MAX_HP"), 3, 0, "default PLAYER_MAX_HP must be 3");
  assertClose(g.q("INVULN_MS"), 1500, 0, "default INVULN_MS must be 1500");
  assertClose(g.hp(), 3, 0, "hp must start at PLAYER_MAX_HP");
  assert(g.q("shipDead") === false, "ship must be alive at boot");
});

check("HUD draws the HP counter, and it updates from 3 to 2 on a collision", () => {
  const g = boot();
  g.clearField();
  suppressSpawns(g);
  g.tick();
  assert(g.ctxTexts.some((t) => t === "HP 3"), `fresh boot must draw "HP 3" in the HUD, got ${JSON.stringify(g.ctxTexts)}`);
  placeAst(g, HIT_X, HIT_Y);
  g.ctxTexts.length = 0;
  g.tick();
  assertClose(g.hp(), 2, 0, "one overlap must leave exactly hp 2");
  assert(g.ctxTexts.some((t) => t === "HP 2"), `HUD must redraw "HP 2" after the hit, got ${JSON.stringify(g.ctxTexts)}`);
});

// ================================================================
// Criterion 2 (damage): an overlapping asteroid decrements HP by
// exactly 1, even when several hazards overlap in the same frame
// ================================================================
check("overlapping an asteroid decrements HP by exactly 1", () => {
  const g = boot();
  g.clearField();
  suppressSpawns(g);
  g.tick(); // settle to hp 3
  assertClose(g.hp(), 3, 0, "precondition: full health");
  placeAst(g, HIT_X, HIT_Y);
  g.tick();
  assertClose(g.hp(), 2, 0, "one overlap must cost exactly 1 hp");
  g.tick(30);
  assertClose(g.hp(), 2, 0, "while the ship is invulnerable, hp must not keep draining");
});

check("two hazards overlapping in one frame cost exactly 1 hp", () => {
  const g = boot();
  g.clearField();
  suppressSpawns(g);
  g.q("INVULN_MS = 200");
  g.tick();
  placeAst(g, HIT_X, HIT_Y);
  placeAst(g, 480, 300 + 25);
  g.tick();
  assertClose(g.hp(), 2, 0, "a frame of double overlap must cost exactly 1 hp");
});

// ================================================================
// Criterion 2 (burst): a visible particle burst of at least 10
// particles at the impact point, drawn from a pooled particle array
// ================================================================
check("hull impact spawns at least 10 particles at the impact point", () => {
  const g = boot();
  g.clearField();
  suppressSpawns(g);
  g.tick();
  placeAst(g, HIT_X, HIT_Y);
  g.ctxCalls.length = 0;
  g.tick();
  const parts = g.activeParticles();
  assert(parts.length >= 10, `impact must burst at least 10 particles, got ${parts.length}`);
  // Impact point is the midpoint between the resting ship (480,300)
  // and the rock centre (480,275): (480, 287.5). Fresh particles have
  // moved at most a few px in the very frame they spawn.
  for (const p of parts) {
    const d = Math.hypot(p.x - 480, p.y - 287.5);
    assert(d < 12, `particle at (${p.x}, ${p.y}) is not at the impact point (dist ${d.toFixed(1)})`);
  }
  // The burst is drawn this same frame: one fillRect per particle on
  // top of the single background clear.
  const rects = g.ctxCalls.filter((c) => c === "fillRect").length;
  assert(rects >= 11, `render must draw the burst rectangles (expected >10 fillRect, got ${rects})`);
});

check("particles come from a fixed-size pooled array that never reallocates", () => {
  const g = boot();
  g.clearField();
  suppressSpawns(g);
  g.q("INVULN_MS = 200");
  const poolSize = g.q("particlePool.slots.length");
  assert(Number.isInteger(poolSize) && poolSize >= 10, "a pre-allocated particle pool must exist");
  g.tick();
  for (let i = 0; i < 6; i++) {
    placeAst(g, HIT_X, HIT_Y);
    for (let t = 0; t < 60 && g.hp() > 0; t++) g.tick();
  }
  assert(g.hp() === 0, "six impacts must eventually bring the ship down");
  assert(g.q("particlePool.slots.length") === poolSize,
    "the particle pool must keep its allocated size no matter how many bursts fired");
});

check("an exhausted particle pool absorbs a burst without allocating or crashing", () => {
  const g = boot();
  g.clearField();
  suppressSpawns(g);
  const poolSize = g.q("particlePool.slots.length");
  g.q(`particlePool.slots.forEach((p) => { p.active = true; p.x = 0; p.y = 0; p.vx = 0; p.vy = 0; p.age = 0.5; })`);
  placeAst(g, HIT_X, HIT_Y);
  g.tick(); // must not throw even though no slot is free
  assert(g.hp() === 2, "damage still applies even when the burst cannot grow the pool");
  assert(g.q("particlePool.slots.length") === poolSize, "exhaustion must never allocate new slots");
});

// ================================================================
// Criterion 3: after a hit the ship is invulnerable for INVULN_MS
// (default 1500) — a second hazard inside that window costs nothing
// ================================================================
check("hazard flown through during the INVULN_MS window does not decrement HP", () => {
  const g = boot();
  g.clearField();
  suppressSpawns(g);
  placeAst(g, HIT_X, HIT_Y);
  g.tick(); // first frame runs with dt = 0, so the hit lands at gameTime = 0;
            // the ship is then invulnerable for INVULN_MS of sim time
  assertClose(g.hp(), 2, 0, "first impact drops hp to 2");
  placeAst(g, 480, 300 + 25); // second hazard, overlapping during the window
  g.tick(45); // t ~= 766 ms: deep inside the 1500 ms window
  assertClose(g.hp(), 2, 0, "overlap inside the invulnerable window must not decrement hp");
  g.tick(90); // t ~= 2283 ms: window long over
  assertClose(g.hp(), 1, 0, "once the window has elapsed, the pending hazard costs exactly 1 hp");
});

check("parking inside a single asteroid for 3 s costs exactly 1 hp (ticket's browser check)", () => {
  const g = boot();
  g.clearField();
  suppressSpawns(g); // the parked rock is the only hazard (auto-spawns off)
  placeAst(g, HIT_X, HIT_Y);
  g.tick();
  assertClose(g.hp(), 2, 0, "single impact at the 3 s mark boundary");
  g.tick(180); // full 3 s of overlap with no other hazards around
  assertClose(g.hp(), 2, 0, "a 3 s park must cost exactly the single impact, no drain");
});

// ================================================================
// Criterion 4: at HP 0 the ship is removed, all input is ignored,
// and a static GAME OVER text is shown
// ================================================================
function drainHp(g, steps) {
  // Park overlapping rocks one at a time with a short invuln window
  // until the ship has taken `steps` hits.
  g.q("INVULN_MS = 200");
  for (let i = 0; i < steps; i++) {
    placeAst(g, HIT_X, HIT_Y);
    for (let t = 0; t < 60 && g.hp() > 3 - (i + 1); t++) g.tick();
  }
}

check("when HP reaches 0 all input is ignored and hp stays at 0", () => {
  const g = boot();
  g.clearField();
  suppressSpawns(g);
  drainHp(g, 3);
  assertClose(g.hp(), 0, 0, "three impacts must reach hp 0");
  assert(g.q("shipDead") === true, "ship must be marked dead at hp 0");
  const before = g.ship();
  g.key("ArrowUp", true);
  g.key("Space", true);
  g.tick(60);
  const after = g.ship();
  assert(before.x === after.x && before.y === after.y, `dead ship must not move (moved ${before.x},${before.y} -> ${after.x},${after.y})`);
  assert(after.vx === 0 && after.vy === 0, "dead ship must have no velocity");
  assert(g.laserCount() === 0, "holding Space on a dead ship must not fire lasers");
  assertClose(g.hp(), 0, 0, "hp must stay at 0 — no further damage events");
});

check("at HP 0 the ship is removed from the scene and a static GAME OVER text is drawn", () => {
  const g = boot();
  g.clearField();
  suppressSpawns(g);
  drainHp(g, 3);
  g.ctxCalls.length = 0;
  g.ctxTexts.length = 0;
  g.tick();
  assert(!g.ctxCalls.includes("translate"), "ship transform (translate) must not be drawn after death");
  assert(g.ctxTexts.some((t) => t.includes("GAME OVER")),
    `a GAME OVER text must be drawn, got ${JSON.stringify(g.ctxTexts)}`);
  assert(g.ctxTexts.some((t) => t === "HP 0"), "HUD must show the depleted counter (HP 0)");
  g.tick(30);
  const gameOverCount = g.ctxTexts.filter((t) => t.includes("GAME OVER")).length;
  assert(gameOverCount === 31, "GAME OVER must be drawn statically every frame (one text per frame)");
});

// ================================================================
// #6-2 (should-fix): the rock/drone hull-impact block is defined once
// (a single named helper) so the hit pipeline can never diverge
// ================================================================
check("the hull-impact pipeline is defined once in a single named helper (applyHullImpact)", () => {
  const g = boot();
  assert(g.q("typeof applyHullImpact") === "function",
    "applyHullImpact must be the single named hull-impact helper");
  // Behavioural spot-check that the shared pipeline still runs: one rock
  // overlap costs exactly 1 hp through it.
  g.clearField();
  suppressSpawns(g);
  g.tick();
  placeAst(g, HIT_X, HIT_Y);
  g.tick();
  assertClose(g.hp(), 2, 0, "one overlap through the shared pipeline must cost exactly 1 hp");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
