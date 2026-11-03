#!/usr/bin/env node
// ================================================================
// Unit tests — chasing drones (ticket #6)
//
// Same harness style as tests/ship-damage.test.mjs: runs the REAL
// <script> from asteroids.html in a sandboxed vm context with stubbed
// window/document/canvas, drives frames through the captured
// requestAnimationFrame callback, and asserts on observable game
// state plus the recorded canvas calls. No network, no external
// services.
//
// Run: node tests/drones.test.mjs
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
// Signed angular difference wrapped to [-PI, PI].
function angDiff(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

// Boot a fresh copy of the game with a canvas of the given size.
// The ctx stub records both method names and fillText payloads so
// tests can assert on HUD text and on what the render layers draw.
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
    score: () => q("score"),
    asteroidCount: () => q("asteroids.slots.reduce((n, a) => n + (a.active ? 1 : 0), 0)"),
    droneCount: () => q("drones.slots.reduce((n, d) => n + (d.active ? 1 : 0), 0)"),
    // The single active drone (fixtures keep at most one alive).
    drone: () =>
      q("(() => { const d = drones.slots.find((s) => s.active); " +
        "return d ? { x: d.x, y: d.y, heading: d.heading } : null; })()"),
    activeParticles: () => q("particlePool.slots.filter((p) => p.active)"),
    clearField: () => q(
      "asteroids.slots.forEach((a) => (a.active = false)); " +
      "drones.slots.forEach((d) => (d.active = false))"
    ),
  };
}

// Manually place a live drone centred at (x, y) with the given heading.
function placeDrone(g, x, y, heading = 0) {
  g.q(`(() => { const s = drones.slots.find((d) => !d.active);
    if (!s) throw new Error("no free drone slot for fixture");
    s.active = true; s.tier = 0; s.x = ${x}; s.y = ${y}; s.heading = ${heading}; return true; })()`);
}

// Manually place a live, parked asteroid centred at (x, y).
function placeAst(g, x, y, r = 20) {
  g.q(`(() => { const s = asteroids.slots.find((a) => !a.active);
    if (!s) throw new Error("no free asteroid slot for fixture");
    s.active = true; s.tier = 0; s.x = ${x}; s.y = ${y}; s.r = ${r};
    s.vx = 0; s.vy = 0; s.rot = 0; s.spin = 0; s.entry = -1;
    s.shape.length = 6; return true; })()`);
}

// Suppress all auto-spawning and start from an empty field.
function quietField(g) {
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0");
  g.clearField();
  g.tick(); // bootstrap frame (dt = 0): nothing spawns or moves
}

// ================================================================
// Criterion 1: the drone roster caps the field; drones spawn at
// the edges; zeroing the drone roster disables spawning entirely
// ================================================================
check("DRONE_BASE, DRONE_GROWTH and SCORE_PER_DRONE are named constants; SCORE_PER_DRONE defaults to 25", () => {
  const g = boot();
  for (const name of ["DRONE_BASE", "DRONE_GROWTH", "SCORE_PER_DRONE"]) {
    assert(typeof g.q(name) === "number", `${name} must be a named numeric constant`);
  }
  assertClose(g.q("DRONE_BASE"), 0, 0, "default DRONE_BASE must be 0 (no drones in wave 1)");
  assertClose(g.q("DRONE_GROWTH"), 1, 0, "default DRONE_GROWTH must be 1");
  assertClose(g.q("SCORE_PER_DRONE"), 25, 0, "default SCORE_PER_DRONE must be 25");
  assert(g.q("drones.slots.length") >= 1, "a pre-allocated drone pool must exist");
});

check("drones spawn at the screen edges and the field never exceeds the drone roster", () => {
  const g = boot(960, 600);
  // Invariant this spawn/cap wait relies on: at 960x600 the ship rests
  // at the centre (480,300) and no point of any edge band lies within
  // SPAWN_SAFE_RADIUS (200) of it (closest is 300 px at a side
  // midpoint), so the safe-radius rejection can never stall the build.
  // Rock-free world with a flat roster of three drones on every wave.
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 3; DRONE_GROWTH = 0");
  g.tick(); // bootstrap frame: spawner builds the wave roster immediately
  const firstWave = g.droneCount();
  assert(firstWave >= 1, `spawner must produce drones on the first eligible frame, got ${firstWave}`);
  // On the dt=0 bootstrap frame freshly spawned drones are still at
  // their spawn point: r+1 px outside one of the four edges.
  const R = g.q("DRONE_RADIUS");
  const wave = g.q("drones.slots.filter((d) => d.active)");
  for (const d of wave) {
    const nearEdge = Math.min(d.x, d.y, 960 - d.x, 600 - d.y);
    assert(nearEdge <= R + 2,
      `freshly spawned drone at (${d.x}, ${d.y}) must start just outside an edge (min edge distance ${nearEdge})`);
  }
  let maxSeen = g.droneCount();
  for (let i = 0; i < 600; i++) {
    g.tick(); // 10 s of play (includes the ship being whittled down)
    maxSeen = Math.max(maxSeen, g.droneCount());
  }
  assert(maxSeen === 3, `the field must build up to the drone roster (saw ${maxSeen})`);
  assert(g.droneCount() <= 3, `the field must never exceed the drone roster`);
});

check("zeroing the drone roster disables drone spawning entirely", () => {
  const g = boot();
  g.q("DRONE_BASE = 0; DRONE_GROWTH = 0");
  for (let i = 0; i < 300; i++) {
    g.tick(); // 5 s of play
    if (g.droneCount() > 0) throw new Error(`a zeroed drone roster must never spawn drones, saw ${g.droneCount()}`);
  }
});

// ================================================================
// Criterion 2: with the ship parked, the drone's heading turns
// toward the ship at a bounded rate, and the closing distance
// decreases every second
// ================================================================
check("a parked-ship drone turns its heading toward the ship, bounded by the turn rate each frame", () => {
  const g = boot();
  quietField(g);
  // Top-left corner, heading east (0 rad); desired aim is ~0.5 rad,
  // so it must actually turn, but never more than one frame's budget.
  placeDrone(g, 40, 60, 0);
  const limit = g.q("DRONE_TURN_SPEED * (1000/60) / 1000");
  let prev = g.drone().heading;
  let turned = 0;
  for (let i = 0; i < 30; i++) {
    g.tick();
    const h = g.drone().heading;
    const delta = Math.abs(angDiff(h, prev));
    assert(delta <= limit * 1.01 + 1e-9,
      `per-frame turn ${delta.toFixed(5)} rad exceeds the bounded budget ${limit.toFixed(5)} rad`);
    turned += delta;
    prev = h;
  }
  assert(turned > 0.3, `the heading must actually rotate toward the ship (only turned ${turned.toFixed(3)} rad)`);
  const d = g.drone();
  const s = g.ship();
  const desired = Math.atan2(s.y - d.y, s.x - d.x);
  assert(Math.abs(angDiff(d.heading, desired)) < 0.15,
    `after 0.5 s the heading must track the ship (off by ${Math.abs(angDiff(d.heading, desired)).toFixed(3)} rad)`);
});

check("with the ship parked, the drone's distance to the ship decreases each second", () => {
  const g = boot();
  quietField(g);
  placeDrone(g, 40, 60, 0.5); // roughly aimed at the ship
  const s = g.ship();
  const dist = () => {
    const d = g.drone();
    assert(d, "the drone must still be alive (far enough away that it has not closed in)");
    return Math.hypot(d.x - s.x, d.y - s.y);
  };
  const d0 = dist();
  g.tick(30); // 0.5 s
  const d1 = dist();
  g.tick(60); // 1.0 s more
  const d2 = dist();
  assert(d1 < d0, `distance must shrink after 0.5 s (${d0.toFixed(1)} -> ${d1.toFixed(1)})`);
  assert(d2 < d1, `distance must shrink over each following second (${d1.toFixed(1)} -> ${d2.toFixed(1)})`);
  assert(d2 < d0, `distance must decrease over the second as a whole (${d0.toFixed(1)} -> ${d2.toFixed(1)})`);
});

// ================================================================
// Criterion 3: a laser crossing a drone destroys it with the
// shared particle burst and adds exactly SCORE_PER_DRONE to the
// HUD score
// ================================================================
check("a laser crossing a drone destroys it, fires the shared burst, and scores exactly SCORE_PER_DRONE", () => {
  const g = boot();
  quietField(g);
  // Straight down the ship's firing axis, born facing the ship, so
  // it holds the x = 480 line the beam travels.
  placeDrone(g, 480, 200, Math.PI / 2);
  const scoreBefore = g.score();
  g.key("Space", true);
  let killFrame = -1;
  let last = null;
  for (let i = 0; i < 30; i++) {
    last = g.drone();
    g.ctxCalls.length = 0;
    g.tick();
    if (!g.drone()) { killFrame = i; break; }
  }
  assert(killFrame >= 0, "the beam must destroy the drone");
  assertClose(g.score() - scoreBefore, g.q("SCORE_PER_DRONE"), 0,
    "a laser kill must credit exactly SCORE_PER_DRONE");
  assert(g.ctxTexts.some((t) => t === `SCORE ${g.score()}`),
    `the HUD must show the updated score, got ${JSON.stringify(g.ctxTexts)}`);
  // Shared particle burst at the kill point: >= 10 pooled particles,
  // drawn as rectangles on the kill frame.
  const parts = g.activeParticles();
  assert(parts.length >= 10, `the kill must burst at least 10 particles, got ${parts.length}`);
  for (const p of parts) {
    const d = Math.hypot(p.x - last.x, p.y - last.y);
    assert(d < 12, `particle at (${p.x}, ${p.y}) is not at the kill point (${last.x}, ${last.y})`);
  }
  const rects = g.ctxCalls.filter((c) => c === "fillRect").length;
  assert(rects >= 11, `render must draw the burst rectangles on the kill frame (expected >10 fillRect, got ${rects})`);
});

// ================================================================
// Criterion 4: overlapping a drone deals exactly 1 HP through the
// same hit pipeline as asteroid collisions, including the INVULN_MS
// window
// ================================================================
check("overlapping a drone costs exactly 1 HP, destroys the drone, and bursts at the overlap", () => {
  const g = boot();
  quietField(g);
  assertClose(g.hp(), 3, 0, "precondition: full health");
  placeDrone(g, 480, 276.5, Math.PI / 2); // 23.5 px away: inside 14 + 10
  g.ctxCalls.length = 0;
  g.tick();
  assertClose(g.hp(), 2, 0, "one drone overlap must cost exactly 1 hp");
  assert(g.droneCount() === 0, "the impact must destroy the drone");
  const parts = g.activeParticles();
  assert(parts.length >= 10, `impact must burst at least 10 particles, got ${parts.length}`);
  for (const p of parts) {
    const d = Math.hypot(p.x - 480, p.y - 288.25); // mid-point of the overlap
    assert(d < 12, `particle at (${p.x}, ${p.y}) is not at the impact point (dist ${d.toFixed(1)})`);
  }
  const rects = g.ctxCalls.filter((c) => c === "fillRect").length;
  assert(rects >= 11, `render must draw the burst rectangles on the impact frame (got ${rects} fillRect)`);
  g.tick(30);
  assertClose(g.hp(), 2, 0, "while invulnerable (and with no hazard left), hp must not drain");
});

check("a drone held overlapping during the INVULN_MS window costs nothing until the window lapses", () => {
  const g = boot();
  quietField(g);
  placeDrone(g, 480, 276.5, Math.PI / 2);
  g.tick(); // first frame runs with dt = 0, so the hit lands at gameTime = 0;
            // the ship is then invulnerable for the default 1500 ms
  assertClose(g.hp(), 2, 0, "first impact drops hp to 2");
  g.q("DRONE_SPEED = 5"); // crawl: the second drone stays in the overlap band the whole test
  placeDrone(g, 480, 318.5, -Math.PI / 2);
  g.tick(45); // t ~= 0.8 s: deep inside the 1500 ms window
  assertClose(g.hp(), 2, 0, "a drone overlapping inside the invulnerable window must not decrement hp");
  assertClose(g.droneCount(), 1, 0, "the ignored drone must survive the window (same as an ignored rock)");
  g.tick(90); // t ~= 2.3 s: window long over, still overlapping
  assertClose(g.hp(), 1, 0, "once the window has elapsed, the pending drone costs exactly 1 hp");
  assert(g.droneCount() === 0, "the late impact must destroy the drone");
});

check("a rock and a drone overlapping in one frame cost exactly 1 hp", () => {
  const g = boot();
  quietField(g);
  g.q("INVULN_MS = 200");
  placeAst(g, 480, 275, 20);       // overlapping rock (25 < 20 + 14)
  placeDrone(g, 480, 318.5, -Math.PI / 2); // overlapping drone (18.5 < 10 + 14)
  g.tick();
  assertClose(g.hp(), 2, 0, "a frame of double overlap must cost exactly 1 hp");
});

check("drones alone can drain HP to 0 through the same pipeline (shipDead, GAME OVER)", () => {
  const g = boot();
  quietField(g);
  g.q("INVULN_MS = 200");
  for (let hit = 1; hit <= 3; hit++) {
    placeDrone(g, 480, 276.5, Math.PI / 2);
    for (let t = 0; t < 30 && g.hp() !== 3 - hit; t++) g.tick();
    assertClose(g.hp(), 3 - hit, 0, `drone impact ${hit} must land (hp ${g.hp()}, want ${3 - hit})`);
  }
  assert(g.q("shipDead") === true, "ship must be marked dead at hp 0");
  g.ctxTexts.length = 0;
  g.tick();
  assert(g.ctxTexts.some((t) => t.includes("GAME OVER")),
    `a GAME OVER text must be drawn, got ${JSON.stringify(g.ctxTexts)}`);
  assert(g.ctxTexts.some((t) => t === "HP 0"), "HUD must show the depleted counter (HP 0)");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
