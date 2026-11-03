#!/usr/bin/env node
// ================================================================
// Unit tests — engine firing animation on the ship (ticket #49)
//
// Same harness style as tests/ship-damage.test.mjs: runs the REAL
// <script> from asteroids.html in a sandboxed vm context with stubbed
// window/document/canvas, drives frames through the captured
// requestAnimationFrame callback, and asserts on the recorded
// canvas calls. The ctx stub here additionally records path
// coordinates (moveTo/lineTo) and transform calls, so tests can tell
// the flickering flame path apart from the static hull path: in the
// ship's local frame the flame is the only thing drawn behind the
// hull's rearmost vertex at x = -0.7 * SHIP_RADIUS.
//
// Run: node tests/engine-flame.test.mjs
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
// The ctx stub records every relevant call with its arguments so
// per-frame path geometry and transforms can be inspected.
function boot(width = 960, height = 600) {
  let rafCallback = null;
  const listeners = {};
  const record = [];
  const ctxStub = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        if (prop === "fillText") return (text) => record.push({ m: "fillText", text: String(text) });
        if (prop === "moveTo" || prop === "lineTo") return (x, y) => record.push({ m: prop, x, y });
        if (typeof prop === "string" && !prop.startsWith("_")) {
          return (...args) => record.push({ m: prop, a: args });
        }
        return (..._args) => record.push({ m: String(prop) });
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
  // Dismiss the start screen so this suite drives the running
  // simulation (Enter starts play), then blank the boot frame.
  for (const cb of listeners["keydown"] ?? []) cb({ code: "Enter", preventDefault() {} });
  record.length = 0;

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
  return { tick, key, q, record };
}

// One rendered frame as its own slice of the call record.
function frameCalls(g) {
  const start = g.record.length;
  g.tick(1);
  return g.record.slice(start);
}

// The hull's rearmost vertex sits at x = -0.7 * SHIP_RADIUS in the
// ship's local frame; on a clean field (no hazards, no lasers) the
// flame is the ONLY path drawn further behind it. Half a px of slack.
function flameExtentX(calls, shipRadius) {
  const threshold = -0.7 * shipRadius - 0.5;
  let min = null;
  for (const c of calls) {
    if ((c.m === "moveTo" || c.m === "lineTo") && c.x < threshold) {
      if (min === null || c.x < min) min = c.x;
    }
  }
  return min; // null = no flame path this frame
}

// Suppress all auto-spawning: zero-sized wave rosters spawn nothing,
// so the field stays clean and only ship-layer paths appear.
function suppressSpawns(g) {
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0");
}

// Pin the injectable random to a repeating sequence so flame flicker
// is fully deterministic per frame.
function pinRandom(g, seq) {
  g.q(`random = (function () {
    const seq = (${JSON.stringify(seq)});
    let i = 0;
    return function () { return seq[i++ % seq.length]; };
  })()`);
}

// ================================================================
// Criterion 2 (constants): ENGINE_FLAME_MIN_PX / ENGINE_FLAME_MAX_PX
// exist as mutable var knobs with MIN < MAX
// ================================================================
check("ENGINE_FLAME_MIN_PX / ENGINE_FLAME_MAX_PX exist as mutable knobs, MIN < MAX", () => {
  const g = boot();
  const min = g.q("typeof ENGINE_FLAME_MIN_PX === 'number' ? ENGINE_FLAME_MIN_PX : NaN");
  const max = g.q("typeof ENGINE_FLAME_MAX_PX === 'number' ? ENGINE_FLAME_MAX_PX : NaN");
  assert(Number.isFinite(min), "ENGINE_FLAME_MIN_PX must be a numeric knob");
  assert(Number.isFinite(max), "ENGINE_FLAME_MAX_PX must be a numeric knob");
  assert(min > 0, "the flame must have a positive minimum extent");
  assert(max > min, "ENGINE_FLAME_MAX_PX must exceed ENGINE_FLAME_MIN_PX");
  g.q("ENGINE_FLAME_MAX_PX = ENGINE_FLAME_MIN_PX + 3");
  assertClose(g.q("ENGINE_FLAME_MAX_PX"), min + 3, 0, "the knobs must be reassignable (mutable var)");
});

// ================================================================
// Criterion 1: while thrust is held AND the ship is alive, the draw
// pass renders a flame path behind the hull; with no thrust held the
// flame is absent
// ================================================================
check("holding ArrowUp on a live ship draws the flame path behind the hull", () => {
  const g = boot();
  suppressSpawns(g);
  g.tick(); // settle (dt = 0 first frame)
  const sr = g.q("SHIP_RADIUS");
  g.key("ArrowUp", true);
  const calls = frameCalls(g);
  const tip = flameExtentX(calls, sr);
  assert(tip !== null,
    `held thrust must draw a flame path behind x=${(-0.7 * sr).toFixed(1)}, but no such path coordinates were recorded`);
  // Two distinct paths this frame: the static hull plus the flame.
  const begins = calls.filter((c) => c.m === "beginPath").length;
  assert(begins >= 2, `expected hull + flame paths (>=2 beginPath), got ${begins}`);
});

check("holding KeyW (alternate thrust key) also draws the flame", () => {
  const g = boot();
  suppressSpawns(g);
  g.tick();
  const sr = g.q("SHIP_RADIUS");
  g.key("KeyW", true);
  const tip = flameExtentX(frameCalls(g), sr);
  assert(tip !== null, "KeyW thrust must draw the flame path");
});

check("releasing the thrust key removes the flame from the next frame", () => {
  const g = boot();
  suppressSpawns(g);
  g.tick();
  const sr = g.q("SHIP_RADIUS");
  g.key("ArrowUp", true);
  frameCalls(g); // confirm the flame is up while held
  g.key("ArrowUp", false);
  g.key("KeyW", false); // belt and braces: no other thrust key latched
  const calls = frameCalls(g);
  assert(flameExtentX(calls, sr) === null,
    "no flame path may be drawn once both thrust keys are released");
  const begins = calls.filter((c) => c.m === "beginPath").length;
  assert(begins === 1, `release frame must draw only the hull path (1 beginPath), got ${begins}`);
});

// ================================================================
// Criterion 2 (flicker): 60 held-thrust frames draw at least two
// distinct flame extents, every one inside [MIN, MAX]
// ================================================================
check("60 held-thrust frames flicker: >=2 distinct lengths, all within [MIN, MAX]", () => {
  const g = boot();
  suppressSpawns(g);
  pinRandom(g, [0.1, 0.9]); // deterministic alternating flicker
  g.tick();
  const sr = g.q("SHIP_RADIUS");
  const min = g.q("ENGINE_FLAME_MIN_PX");
  const max = g.q("ENGINE_FLAME_MAX_PX");
  g.key("ArrowUp", true);
  // The flame tip sits at x = -0.4*SHIP_RADIUS - len, so the drawn
  // extent recovers len directly from the recorded coordinates.
  const base = 0.4 * sr;
  const lengths = new Set();
  for (let f = 0; f < 60; f++) {
    const tip = flameExtentX(frameCalls(g), sr);
    assert(tip !== null, `frame ${f}: held thrust must keep the flame drawn`);
    const len = -tip - base;
    assert(len >= min - 1e-9 && len <= max + 1e-9,
      `frame ${f}: flame extent ${len} escaped [${min}, ${max}]`);
    lengths.add(Math.round(len * 1000) / 1000);
  }
  assert(lengths.size >= 2, `60 frames must show at least two distinct flame lengths, saw ${lengths.size}`);
});

// ================================================================
// Criterion 3 (heading): the flame is drawn inside the hull's
// transform, inheriting rotate(ship.heading)
// ================================================================
check("the flame is drawn inside the hull transform, rotating with ship.heading", () => {
  const g = boot();
  suppressSpawns(g);
  g.tick();
  const heading = Math.PI / 3; // steer away from the default up-facing pose
  g.q(`ship.heading = ${heading}`);
  const sr = g.q("SHIP_RADIUS");
  g.key("ArrowUp", true);
  const calls = frameCalls(g);
  // Find the ship's rotate: it must carry the live heading...
  const rotates = calls.map((c, i) => ({ c, i })).filter(({ c }) => c.m === "rotate");
  assert(rotates.length >= 1, "ship frame must rotate into its local transform");
  const rotated = rotates.find(({ c }) => Math.abs(c.a[0] - heading) < 1e-9);
  assert(rotated, `ship frame must call rotate(ship.heading=${heading})`);
  // ...and the flame path must be built AFTER that rotate, i.e. in the
  // same local frame the hull is drawn in.
  const tip = calls.map((c, i) => ({ c, i }))
    .find(({ c }) => (c.m === "lineTo" || c.m === "moveTo") && c.x < -0.7 * sr - 0.5);
  assert(tip, "held thrust must draw the flame path in this frame");
  assert(tip.i > rotated.i, "the flame path must be drawn after rotate(heading), inheriting the ship transform");
  const restoreIdx = calls.map((c, i) => ({ c, i })).find(({ c }) => c.m === "restore");
  assert(restoreIdx && tip.i < restoreIdx.i, "the flame must close within the ship's save/restore");
});

// ================================================================
// Criterion 3 (death): the flame is suppressed once shipDead is
// latched; ticket #5's "no translate after death" invariant holds
// ================================================================
check("with shipDead latched the flame is suppressed and no ship transform is drawn", () => {
  const g = boot();
  suppressSpawns(g);
  g.tick();
  const sr = g.q("SHIP_RADIUS");
  g.q("shipDead = true"); // final-blow latch (update/render both key off it)
  g.key("ArrowUp", true); // held thrust must do nothing visually
  const calls = frameCalls(g);
  assert(flameExtentX(calls, sr) === null, "a dead ship must not draw the engine flame");
  assert(!calls.some((c) => c.m === "translate"), "ticket #5: no translate calls after death");
});

// ================================================================
// Criterion 4 (allocation): sustained thrust never grows a pool —
// the flame rides on the hull's existing path/stroke, no new state
// ================================================================
check("60 frames of sustained thrust leave every pool at its allocated size", () => {
  const g = boot();
  suppressSpawns(g);
  pinRandom(g, [0.3, 0.7]);
  g.tick();
  const sizes = g.q("({ lasers: laserPool.slots.length, asteroids: asteroids.slots.length, drones: drones.slots.length, particles: particlePool.slots.length })");
  g.key("ArrowUp", true);
  g.tick(60);
  const after = g.q("({ lasers: laserPool.slots.length, asteroids: asteroids.slots.length, drones: drones.slots.length, particles: particlePool.slots.length })");
  assert(JSON.stringify(after) === JSON.stringify(sizes),
    `sustained thrust must not resize any pool (${JSON.stringify(sizes)} -> ${JSON.stringify(after)})`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
