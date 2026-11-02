#!/usr/bin/env node
// ================================================================
// Unit tests — laser subsystem (ticket #3)
//
// Extended by ticket #52: wrap semantics replace the old off-screen
// recycle. Adaptations, documented:
//   * "lasers deactivate once off-screen and are recycled..." was
//     rewritten for wrap + LASER_LIFETIME_S recycling (criterion 4).
//   * the 2 s cooldown soak raises LASER_LIFETIME_S = 10: under the
//     old off-screen cull the giant canvas kept beams alive for the
//     whole 1.9 s window; with wrap the lifetime knob now does that.
//   * the pool-saturation soak (LASER_SPEED = 0) raises
//     LASER_LIFETIME_S = 100: the default 1.5 s lifetime would reclaim
//     slots before the 32-slot pool saturates.
//
// Runs the REAL <script> from asteroids.html inside a sandboxed
// vm context with a stubbed window/document/canvas, drives frames
// through the captured requestAnimationFrame callback, and asserts
// on observable game state. No network, no external services.
//
// Run: node tests/lasers.test.mjs
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
// A very large canvas is used where a test counts total shots fired
// (so no laser ever leaves the screen and gets recycled mid-test).
function boot(width = 960, height = 600) {
  let rafCallback = null;
  const listeners = {};
  const ctxCalls = [];
  const ctxLines = []; // (ticket #52) moveTo/lineTo coordinates, in draw order
  const ctxProps = new Map(); // records style/property sets so they don't churn the proxy
  const ctxStub = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        return (...args) => {
          ctxCalls.push(String(prop));
          if (prop === "moveTo" || prop === "lineTo") {
            ctxLines.push({ cmd: prop, x: args[0], y: args[1] });
          }
        };
      },
      set(_t, prop, value) {
        ctxProps.set(prop, value);
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
  function tick(ms = FRAME_MS) {
    nowMs += ms;
    rafCallback(nowMs);
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
    fire: (type) => {
      for (const cb of listeners[type] ?? []) cb({});
    },
    q,
    keydownFlag,
    ctxCalls,
    ctxLines,
    activeSlots: () => q("[...laserPool.slots].filter((s) => s.active)"),
    activeCount: () =>
      q("laserPool.slots.reduce((n, s) => n + (s.active ? 1 : 0), 0)"),
  };
}

// Manually place a live asteroid at (x, y) with a given radius — the
// same fixture helper the asteroids suite uses.
function placeAst(g, x, y, r = 20) {
  g.q(`(() => { const s = asteroids.slots.find((a) => !a.active);
    s.active = true; s.tier = 0; s.x = ${x}; s.y = ${y}; s.r = ${r};
    s.vx = 0; s.vy = 0;
    s.shape.length = 6; s.rot = 0; s.spin = 0; return true; })()`);
}

// (ticket #52) zero all rosters, optionally re-aim the parked ship, then
// fire exactly one beam: the bootstrap frame (dt = 0) releases it from
// the nose, and releasing Space keeps the field to a single beam.
function soloBeam(g, heading) {
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0;");
  if (heading !== undefined) g.q(`ship.heading = ${heading};`);
  g.key("Space", true);
  g.tick();
  g.key("Space", false);
  assert(g.activeCount() === 1, `exactly one beam after the solo shot, got ${g.activeCount()}`);
}

// ================================================================
// CRITERION 2a: LASER_COOLDOWN_MS exists and defaults to 150
// ================================================================
check("LASER_COOLDOWN_MS is a named constant defaulting to 150", () => {
  const g = boot();
  const value = g.q("typeof LASER_COOLDOWN_MS === 'number' ? LASER_COOLDOWN_MS : NaN");
  assertClose(value, 150, 0, "default LASER_COOLDOWN_MS must be 150");
});

// ================================================================
// CRITERION 4 (ticket #52): LASER_LIFETIME_S exists, defaults to a
// positive number of seconds, and is console-retunable (a `var`)
// ================================================================
check("LASER_LIFETIME_S is a named var defaulting to 1.5 s and is console-retunable", () => {
  const g = boot();
  const value = g.q("typeof LASER_LIFETIME_S === 'number' ? LASER_LIFETIME_S : NaN");
  assertClose(value, 1.5, 0, "default LASER_LIFETIME_S must be 1.5 s");
  g.q("LASER_LIFETIME_S = 0.25"); // var bindings accept console reassignment
  assertClose(g.q("LASER_LIFETIME_S"), 0.25, 0, "reassignment from the console must stick");
});

// ================================================================
// CRITERION 1: Space fires one laser from the nose along the heading
// ================================================================
check("pressing Space fires exactly one laser from the ship's nose along its heading", () => {
  const g = boot(); // ship starts centred, heading = -PI/2 (up), at rest
  g.key("Space", true);
  assert(g.keydownFlag.prevented, "Space keydown must be preventDefaulted (no page scroll)");
  g.tick(); // frame 1 (dt=0 bootstrap, shot released)
  g.tick(); // frame 2 (one 60fps step of motion)
  const n = g.activeCount();
  assert(n === 1, `exactly one laser after one shot, got ${n}`);
  const [L] = g.activeSlots();
  const ship = g.q("({ x: ship.x, y: ship.y })");
  const expectedDist = g.q("SHIP_RADIUS + LASER_LENGTH / 2 + LASER_SPEED * (1000/60) / 1000");
  const dist = Math.hypot(L.x - ship.x, L.y - ship.y);
  assertClose(L.x, ship.x, 0.5, "laser stays on the ship's heading axis (no drift sideways)");
  assertClose(dist, expectedDist, 0.5, "laser spawns at the nose and advances one frame along the heading");
  assert(L.y < ship.y, "laser is in front of (above) an upward-heading ship");
  const yBefore = g.activeSlots()[0].y;
  g.tick();
  const yAfter = g.activeSlots()[0].y;
  assert(yAfter < yBefore, "beam moves up and toward off-screen while the ship holds still");
});

check("no laser is fired unless Space is held", () => {
  const g = boot();
  g.tick();
  g.key("ArrowUp", true); // moving alone must not fire
  for (let i = 0; i < 60; i++) g.tick();
  assert(g.activeCount() === 0, `held movement without Space must not fire, got ${g.activeCount()} lasers`);
});

// ================================================================
// CRITERION 2b: raising the constant to 2000 caps fire at 1 per 2 s
// ================================================================
check("setting LASER_COOLDOWN_MS to 2000 limits sustained fire to at most one laser per 2 s", () => {
  const g = boot(100000, 100000); // giant canvas: beams never cross a seam in the window
  g.q("LASER_COOLDOWN_MS = 2000");
  g.q("LASER_LIFETIME_S = 10"); // ticket #52: the lifetime, not the cull, must keep the
                                 // single beam alive across the 1.9 s window
  g.key("Space", true);
  // ~1.9 s of held fire: a compliant implementation fires exactly once.
  for (let i = 0; i < 114; i++) g.tick();
  const n = g.activeCount();
  assert(n >= 1, `firing must still work at a 2 s cooldown, got ${n} lasers`);
  assert(n <= 1, `at most one laser per 2 s, got ${n} in 1.9 s`);
});

// ================================================================
// CRITERION 3: sustained fire >= 5 lasers/s at the default constant
// ================================================================
check("sustained fire at the default 150 ms cooldown sustains at least 5 lasers per second", () => {
  const g = boot(100000, 100000);
  g.key("Space", true);
  for (let i = 0; i < 60; i++) g.tick(); // 1 s of held fire
  const n = g.activeCount();
  assert(n >= 5, `expected at least 5 lasers in 1 s, got ${n}`);
  assert(n <= 10, `cooldown must still gate fire at the default, got ${n} in 1 s`);
});

// ================================================================
// CRITERION 4 (ticket #52): wrap + lifetime replace the old
// off-screen recycle. Beams cross every seam alive, recycle from the
// pre-allocated pool on LASER_LIFETIME_S, and a rapid-fire burst never
// exhausts the pool differently than before for the same cooldown.
// ================================================================
check("beams survive every seam crossing and are recycled only at LASER_LIFETIME_S from the pre-allocated pool", () => {
  const g = boot(200, 200); // small screen: the beam crosses the seam every ~0.34 s
  const size0 = g.q("laserPool.slots.length");
  assertClose(size0, g.q("LASER_POOL_SIZE"), 0, "pool is pre-allocated at boot to LASER_POOL_SIZE");
  const slotIds = g.q("[...laserPool.slots]"); // same object references as the game's slots
  soloBeam(g);
  const perY = g.q("canvas.height + 2 * LASER_LENGTH");
  let crossings = 0;
  let prev = g.activeSlots()[0].y;
  for (let i = 1; i <= 89; i++) { // age 11/60..89/60 s: under the 1.5 s lifetime
    g.tick();
    const n = g.activeCount();
    assert(n === 1, `the beam must stay alive on tick ${i} (age ${i / 60}s < 1.5 s) — the off-screen cull must be gone`);
    const [L] = g.activeSlots();
    if (prev < 0 && L.y > g.q("canvas.height")) crossings++; // top -> bottom seam
    prev = L.y;
  }
  assert(crossings >= 3, `the beam must cross seams many times while alive, saw ${crossings}`);
  for (let i = 0; i < 3; i++) g.tick(); // ticks 92..94: well past the 90-tick (1.5 s) mark
  assertClose(g.activeCount(), 0, 0, "the beam must be recycled after LASER_LIFETIME_S of sim time");
  // Pool discipline unchanged: same pre-allocated slots, same size.
  g.key("Space", true);
  let s0WasActive = false;
  let s0Recycled = false;
  for (let i = 0; i < 120; i++) { // 2 s of held fire: beats past the 1.5 s lifetime
    g.tick();
    for (const s of g.activeSlots()) assert(slotIds.includes(s), "every fired laser occupies a pre-existing slot object");
    const s0 = g.q("laserPool.slots[0].active");
    s0WasActive = s0WasActive || s0;
    s0Recycled = s0Recycled || (s0WasActive && !s0);
  }
  assert(s0Recycled, "the same pre-allocated slot object is reused across shots");
  assertClose(g.q("laserPool.slots.length"), size0, 0, "pool size never grows while firing");
});

check("a burst of rapid fire at the default cooldown never exhausts the 32-slot pool", () => {
  const g = boot(960, 600);
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0");
  g.key("Space", true);
  let maxActive = 0;
  let lateFired = 0;
  for (let i = 0; i < 120; i++) { // 2 s of sustained fire, longer than the lifetime
    g.tick();
    const n = g.activeCount();
    maxActive = Math.max(maxActive, n);
    if (i >= 105) lateFired = Math.max(lateFired, n);
  }
  assert(maxActive > 0, "rapid fire actually produced beams");
  assert(maxActive < g.q("LASER_POOL_SIZE"),
    `concurrent beams must stay far below the 32-slot pool for the same cooldown (peak ${maxActive})`);
  assert(lateFired > 0, "fire must continue across the whole window (slots recycle into new shots)");
});

check("pool exhaustion never allocates: firing waits for a free slot", () => {
  const g = boot(200, 200);
  g.q("LASER_SPEED = 0"); // pathological console tune: lasers never move, pool saturates
  g.q("LASER_COOLDOWN_MS = 50"); // fast cadence so 4 s comfortably overfills the 32-slot pool
  g.q("LASER_LIFETIME_S = 100"); // ticket #52: hold the beams long enough for saturation
  const size0 = g.q("laserPool.slots.length");
  g.key("Space", true);
  for (let i = 0; i < 240; i++) g.tick(); // 4 s >> pool capacity at 50 ms cadence
  const n = g.activeCount();
  assertClose(n, g.q("LASER_POOL_SIZE"), 0, "saturated pool holds exactly LASER_POOL_SIZE lasers, no overflow objects");
  assertClose(g.q("laserPool.slots.length"), size0, 0, "exhausted pool does not grow or crash");
});

// ================================================================
// #2-1 (should-fix): losing focus clears the pressed-keys set — a
// movement key held while the tab loses focus (alt-tab) must not
// keep pushing the ship once focus returns
// ================================================================
check("window blur clears the pressed-keys set: a held W after an alt-tab leaves the ship stationary", () => {
  const g = boot();
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0"); // empty field: thrust is the only input
  g.key("KeyW", true);
  for (let i = 0; i < 30; i++) g.tick(); // ~0.5 s of thrust (this suite's tick(ms) is ONE frame of length ms)
  assert(g.q("ship.vy") < -1, "precondition: held W gives the ship real upward speed");
  g.fire("blur"); // focus loss (alt-tab): held keys no longer reach the game
  assert(g.q("keys.size") === 0, "blur must clear the pressed-keys set");
  // Ticket #50 adaptation: the old 0.90 always-on friction is gone; the
  // residual speed now dies by coast inertia (SHIP_COAST_FRICTION) plus
  // the STOP_SPEED snap — from ~210 px/s that settles at frame ~105,
  // well inside the 120-frame window below (contract: COAST_SETTLE_S).
  // Afterwards the ship must stay put.
  let rest = null;
  for (let i = 0; i < 120; i++) {
    g.tick();
    if (g.q("ship.vx") === 0 && g.q("ship.vy") === 0) {
      rest = g.q("({ x: ship.x, y: ship.y })");
      break;
    }
  }
  assert(rest, "coast inertia must bring the ship to rest once the keys are cleared");
  for (let i = 0; i < 120; i++) g.tick(); // 2 s with no reachable input
  const p = g.q("({ x: ship.x, y: ship.y })");
  assert(p.x === rest.x && p.y === rest.y,
    `ship must remain stationary after the held key was dropped (drifted to ${p.x},${p.y} from ${rest.x},${rest.y} — ghost thrust)`);
});

// ================================================================
// #3-2 (should-fix): tryFire finds a free slot with a plain indexed
// loop — no .find closure allocated per shot
// ================================================================
check("tryFire scans the laser pool by index (no per-shot closure allocation)", () => {
  assert(!gameSource.includes("laserPool.slots.find"),
    "tryFire must not locate a free slot with .find (a closure per shot in the hot path)");
  // And the scan must still find a free slot: sustained fire keeps working.
  const g = boot(100000, 100000);
  g.key("Space", true);
  for (let i = 0; i < 60; i++) g.tick();
  assert(g.activeCount() >= 5, `indexed scan must still recycle slots (fired ${g.activeCount()} lasers in 1 s)`);
});

// ================================================================
// #3-3 (should-fix): render() skips the laser beginPath/stroke when
// no lasers are active (an empty path is pure waste at 60 fps)
// ================================================================
check("render begins no laser path with an empty pool, and exactly one batched path with lasers live", () => {
  const g = boot(960, 600);
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0"); // only the ship draws
  g.tick(); // bootstrap frame (dt = 0)
  g.ctxCalls.length = 0;
  g.tick();
  const emptyPaths = g.ctxCalls.filter((c) => c === "beginPath").length;
  assert(emptyPaths === 1,
    `with no active lasers only the ship path may be begun, got ${emptyPaths} beginPath calls`);
  // One active laser -> exactly one more (batched) path.
  g.q("laserPool.slots[0].active = true; laserPool.slots[0].x = 480; laserPool.slots[0].y = 100; laserPool.slots[0].dx = 0; laserPool.slots[0].dy = -1;");
  g.ctxCalls.length = 0;
  g.tick();
  const livePaths = g.ctxCalls.filter((c) => c === "beginPath").length;
  assert(livePaths === 2,
    `one active laser must add exactly one batched path, got ${livePaths} beginPath calls`);
});

// ================================================================
// CRITERION 1 (ticket #52): a beam crossing any edge re-emergs on the
// opposite edge in the same update, offset by the exact remainder —
// the ship's wrap convention (margin LASER_LENGTH, full-period shift).
// Fixtures for all four edges, plus a near-corner diagonal.
// ================================================================
// Drive the solo beam until its centre jumps to the opposite side of
// the given axis; returns { prev, after, slot } for the crossing frame.
function awaitSeamCrossing(g, { axis, fromEdge, ticks = 40 }) {
  const L0 = g.activeSlots()[0];
  let prevX = L0.x;
  let prevY = L0.y;
  for (let i = 0; i < ticks; i++) {
    g.tick();
    assert(g.activeCount() === 1, `exactly one beam on tick ${i} (it must not die at the seam)`);
    const L = g.activeSlots()[0];
    if (axis === "y" && fromEdge === "top" && prevY < 0 && L.y > g.q("canvas.height")) {
      return { prevX, prevY, L };
    }
    if (axis === "y" && fromEdge === "bottom" && prevY > g.q("canvas.height") && L.y < g.q("LASER_LENGTH")) {
      return { prevX, prevY, L };
    }
    if (axis === "x" && fromEdge === "left" && prevX < 0 && L.x > g.q("canvas.width")) {
      return { prevX, prevY, L };
    }
    if (axis === "x" && fromEdge === "right" && prevX > g.q("canvas.width") && L.x < g.q("LASER_LENGTH")) {
      return { prevX, prevY, L };
    }
    prevX = L.x;
    prevY = L.y;
  }
  throw new Error(`no ${axis} seam crossing observed within ${ticks} ticks`);
}

check("beam crossing the TOP edge re-emergs at the bottom at y = canvas.height + (exact remainder), x unchanged", () => {
  const g = boot(200, 200); // ship (100,100) heading up: beam fires straight up from mid-field
  soloBeam(g);
  const { prevX, prevY, L } = awaitSeamCrossing(g, { axis: "y", fromEdge: "top" });
  const step = g.q("LASER_SPEED * (1000/60) / 1000");
  const perY = g.q("canvas.height + 2 * LASER_LENGTH");
  assertClose(L.y, prevY - step + perY, 1e-9, "re-entry y is the pre-wrap step plus exactly one full period");
  assertClose(L.y - g.q("canvas.height"), prevY - step + 2 * g.q("LASER_LENGTH"), 1e-9,
    "y = canvas.height + (previous y remainder past the wrap margin)");
  assertClose(L.x, prevX, 1e-9, "x is unchanged by a vertical wrap");
  assert(L.y < g.q("canvas.height + 2 * LASER_LENGTH"), "the beam lands inside the opposite margin band, not past it");
});

check("beam crossing the BOTTOM edge re-emergs at the top with the exact remainder, x unchanged", () => {
  const g = boot(200, 200);
  soloBeam(g, Math.PI / 2); // heading down
  const { prevX, prevY, L } = awaitSeamCrossing(g, { axis: "y", fromEdge: "bottom" });
  const step = g.q("LASER_SPEED * (1000/60) / 1000");
  const perY = g.q("canvas.height + 2 * LASER_LENGTH");
  assertClose(L.y, prevY + step - perY, 1e-9, "re-entry y is the pre-wrap step minus exactly one full period");
  assertClose(L.x, prevX, 1e-9, "x is unchanged by a vertical wrap");
});

check("beam crossing the LEFT edge re-emergs at the right with the exact remainder, y unchanged", () => {
  const g = boot(200, 200);
  soloBeam(g, Math.PI); // heading left
  const { prevX, prevY, L } = awaitSeamCrossing(g, { axis: "x", fromEdge: "left" });
  const step = g.q("LASER_SPEED * (1000/60) / 1000");
  const perX = g.q("canvas.width + 2 * LASER_LENGTH");
  assertClose(L.x, prevX - step + perX, 1e-9, "re-entry x is the pre-wrap step plus exactly one full period");
  assertClose(L.y, prevY, 1e-9, "y is unchanged by a horizontal wrap");
});

check("beam crossing the RIGHT edge re-emergs at the left with the exact remainder, y unchanged", () => {
  const g = boot(200, 200);
  soloBeam(g, 0); // heading right
  const { prevX, prevY, L } = awaitSeamCrossing(g, { axis: "x", fromEdge: "right" });
  const step = g.q("LASER_SPEED * (1000/60) / 1000");
  const perX = g.q("canvas.width + 2 * LASER_LENGTH");
  assertClose(L.x, prevX + step - perX, 1e-9, "re-entry x is the pre-wrap step minus exactly one full period");
  assertClose(L.y, prevY, 1e-9, "y is unchanged by a horizontal wrap");
});

check("near-corner diagonal wraps BOTH edges in the same update and re-emergs at the opposite corner", () => {
  const g = boot(200, 200);
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0;");
  g.q("ship.x = 30; ship.y = 30; ship.heading = Math.PI / 4;"); // near the top-left corner, firing down-right
  g.key("Space", true);
  g.tick();
  g.key("Space", false);
  const stepAxis = g.q("Math.cos(Math.PI/4) * LASER_SPEED * (1000/60) / 1000");
  const per = g.q("canvas.width + 2 * LASER_LENGTH"); // square canvas: perX === perY
  let wrapped = false;
  let prevX = g.activeSlots()[0].x;
  let prevY = g.activeSlots()[0].y;
  for (let i = 0; i < 40; i++) {
    g.tick();
    assert(g.activeCount() === 1, `exactly one beam on tick ${i}`);
    const L = g.activeSlots()[0];
    const crossedX = prevX > g.q("canvas.width") && L.x < g.q("LASER_LENGTH");
    const crossedY = prevY > g.q("canvas.height") && L.y < g.q("LASER_LENGTH");
    if (crossedX && crossedY) {
      wrapped = true;
      assertClose(L.x, prevX + stepAxis - per, 1e-9, "x wraps by exactly one period in the crossing frame");
      assertClose(L.y, prevY + stepAxis - per, 1e-9, "y wraps by exactly one period in the crossing frame");
      assert(L.x < 0 && L.y < 0, "the beam re-enters just past the opposite (top-left) corner");
      break;
    }
    prevX = L.x;
    prevY = L.y;
  }
  assert(wrapped, "a near-corner diagonal beam must cross both edges in the same update");
});

// ================================================================
// CRITERION 2 (ticket #52): the wrap margin follows the ship
// convention — once fully past an edge by LASER_LENGTH the beam
// re-enters the opposite one, so the ctx record never shows a frame
// drawing a beam straddling both edges of the screen.
// ================================================================
check("no frame draws a beam straddling both edges (ctx record), and no beam endpoint escapes the wrap-margin band", () => {
  const g = boot(200, 200);
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0"); // ship + beams only
  const w = g.q("canvas.width");
  const h = g.q("canvas.height");
  const M = g.q("LASER_LENGTH");
  const MB = M + M / 2; // beam endpoints sit ± LASER_LENGTH/2 from the centre, and the
                        // centre may legally rest in the ±M wrap band outside the edge
  g.key("Space", true);
  let laserSegs = 0;
  let straddling = 0;
  let outOfBand = 0;
  for (let i = 0; i < 120; i++) { // 2 s of held fire: dozens of seam crossings
    g.ctxLines.length = 0;
    g.tick();
    // A beam is a moveTo immediately followed by one lineTo, segment
    // length exactly LASER_LENGTH. The ship's own path is local-space
    // (edges 25.2 / 9 / 9 px) and never matches that length.
    for (let j = 0; j + 1 < g.ctxLines.length; j++) {
      const a = g.ctxLines[j];
      const b = g.ctxLines[j + 1];
      if (a.cmd !== "moveTo" || b.cmd !== "lineTo") continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (Math.abs(len - M) > 2) continue;
      laserSegs++;
      const straddleV = (a.y < 0 && b.y > h) || (b.y < 0 && a.y > h);
      const straddleH = (a.x < 0 && b.x > w) || (b.x < 0 && a.x > w);
      if (straddleV || straddleH) straddling++;
      if (Math.min(a.x, b.x) < -MB || Math.max(a.x, b.x) > w + MB ||
          Math.min(a.y, b.y) < -MB || Math.max(a.y, b.y) > h + MB) outOfBand++;
    }
  }
  assert(laserSegs > 20, `the soak must have drawn many beams (${laserSegs} segments)`);
  assert(straddling === 0, `no frame may draw a beam straddling both edges (${straddling} offending draws)`);
  assert(outOfBand === 0, `no beam endpoint may ever leave the wrap-margin band (${outOfBand} offending draws)`);
});

// ================================================================
// CRITERION 3 (ticket #52): kill detection works across the seam —
// the sweep-segment test accounts for the wrapped position, so a rock
// sitting just inside the opposite edge is killed by the wrapped beam
// (deterministic fixture: static ship, single beam, parked rock).
// ================================================================
check("a wrapped beam kills a rock sitting just inside the opposite edge (deterministic fixture)", () => {
  const g = boot(200, 200);
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0");
  placeAst(g, 100, 188, 12); // rock fully inside, its skin touching the bottom edge (y = 200)
  soloBeam(g); // single beam straight up from (100,100)
  // #51: the fixture keeps its default tier (0 large), so the cross-seam
  // kill is credited as a large-rock score and shatters the rock into
  // 2 medium fragments (which stay immune to the shattering beam).
  for (let i = 0; i < 8; i++) { // beam still approaching / just past the top edge
    g.tick();
    assertClose(g.q("score"), 0, 0, `the unwrapped beam cannot reach the rock (tick ${i + 1})`);
  }
  for (let i = 0; i < 12; i++) { // the beam must cross the seam and sweep the rock
    g.tick();
    if (g.q("score") > 0) break;
  }
  assertClose(g.q("score"), g.q("SCORE_PER_LARGE"), 0, "the cross-seam kill credits exactly one rock score");
  assert(g.q("asteroids.slots.filter((a) => a.active && a.tier === 1).length") === 2,
    "the wrapped beam must have shattered the large fixture into 2 medium fragments");
});

// ================================================================
// CRITERION 4 (ticket #52): recycling follows the SIM-time lifetime,
// not the first off-screen exit, and a console retune applies.
// ================================================================
check("a beam recycled on first off-screen exit under the old rules stays alive to the lifetime now", () => {
  const g = boot(200, 200);
  soloBeam(g);
  // Old behaviour: the beam left the field (top edge) around tick 9 and
  // was deleted. It must now be alive — and wrapped — well past that.
  for (let i = 0; i < 30; i++) g.tick(); // 0.5 s: the beam has left and re-entered the field many times
  assertClose(g.activeCount(), 1, 0, "a beam fully past the old cull margin must still be alive at 0.5 s");
  const y = g.activeSlots()[0].y;
  assert(y > 0 && y < g.q("canvas.height"), "and it is inside the field, not parked off-screen");
});

check("retuned LASER_LIFETIME_S = 0.2 recycles beams early, on the simulation clock", () => {
  const g = boot(200, 200);
  g.q("LASER_LIFETIME_S = 0.2");
  soloBeam(g);
  for (let i = 0; i < 11; i++) g.tick(); // age 11/60 s = 0.183 s: still inside the retuned life
  assertClose(g.activeCount(), 1, 0, "beam must live until the retuned lifetime");
  for (let i = 0; i < 3; i++) g.tick(); // age 14/60 s = 0.233 s: past it
  assertClose(g.activeCount(), 0, 0, "beam must be recycled at the retuned lifetime, not the default");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
