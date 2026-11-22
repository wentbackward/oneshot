#!/usr/bin/env node
// ================================================================
// Unit tests — simulation speed controls (ticket #126, PRD §4):
// Pause / 1x / 2x / 4x buttons on a PINNED 60 Hz rAF clock.
//
// Exactness model (IEEE 754, honest): a 1/60 s frame gap cannot be
// represented exactly in millisecond rAF timestamps, so the per-
// frame budget (mult × FIXED_DT) can wobble by ≲1e-16 s and a
// single frame may carry at most one fixed step into the next.
// The assertions below therefore pin what the engine CAN hold
// exactly, and that is the behaviour the AC names:
//  - over 60 pinned 1/60 s frames the world takes EXACTLY
//    60 × mult fixed steps (an integer, checked with ===);
//  - the world clock delta over those 60 frames EQUALS (Object.is)
//    the clock advanced by folding exactly 60 × mult additions of
//    FIXED_DT from the same start value — i.e. the sim advanced
//    by exactly 60 × mult × FIXED_DT in fixed-step units, nothing
//    finer, nothing coarser;
//  - no single frame strays more than one fixed step away from
//    its mult × FIXED_DT budget (no bursts, no stalls, no more
//    than one step of carry);
//  - paused frames advance 0 (clock byte-identical, zero steps);
//  - resuming takes exactly one step on the next frame (no
//    catch-up burst).
//
// Harness: house style — the real bundled <script> from the
// committed fishtank.html boots in a sandboxed node:vm context;
// frames are driven through the captured requestAnimationFrame
// callback. No network, no external services.
//
// Run: node tests/fishtank-speed.test.mjs
// ================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "fishtank.html"), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("no <script> block found in fishtank.html");
const gameSource = scriptMatch[1];

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

// ---------- vm stubs ----------

function makeEl(id) {
  const el = {
    id,
    listeners: {},
    classes: new Set(),
    textContent: "",
    addEventListener: function (type, cb) {
      (this.listeners[type] ??= []).push(cb);
    },
  };
  el.classList = {
    add: (c) => el.classes.add(c),
    remove: (c) => el.classes.delete(c),
    contains: (c) => el.classes.has(c),
  };
  return el;
}

function makeCtx() {
  const gradient = { addColorStop: () => {} };
  const target = {
    canvas: null,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => ({}),
    measureText: () => ({ width: 0 }),
  };
  for (const m of [
    "clearRect", "fillRect", "strokeRect",
    "beginPath", "closePath", "moveTo", "lineTo", "rect",
    "arc", "ellipse", "quadraticCurveTo", "bezierCurveTo",
    "fill", "stroke", "fillText", "strokeText",
    "save", "restore", "translate", "scale", "rotate", "setTransform",
    "drawImage",
  ]) {
    target[m] = () => {};
  }
  return new Proxy(target, {
    get(t, prop) {
      const value = t[prop];
      return typeof value === "function" ? (...args) => value(...args) : value;
    },
    set() {
      return true;
    },
  });
}

const SPEED_IDS = ["speed-pause", "speed-1x", "speed-2x", "speed-4x"];
const OTHER_IDS = [
  "hud", "hud-toggle", "hud-panel", "hud-fps",
  "hud-count-tetra", "hud-count-predator", "hud-grid",
  "tool-place-rock", "tool-place-kelp", "tool-remove",
];

function boot(width, height) {
  const els = new Map();
  for (const id of [...SPEED_IDS, ...OTHER_IDS]) els.set(id, makeEl(id));
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    listeners: {},
    addEventListener: function (type, cb) {
      (this.listeners[type] ??= []).push(cb);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    getContext: () => makeCtx(),
  };
  let rafCb = null;
  let rafSeq = 0;
  const winListeners = {};
  const win = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    addEventListener: (type, cb) => {
      (winListeners[type] ??= []).push(cb);
    },
    requestAnimationFrame: (cb) => {
      rafCb = cb;
      return ++rafSeq;
    },
  };
  const sandbox = {
    window: win,
    document: {
      getElementById: (id) =>
        id === "game" ? canvas : els.get(id) ?? null,
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);

  function frameAt(ms) {
    const cb = rafCb;
    if (typeof cb !== "function") {
      throw new Error("the rAF loop stopped scheduling frames");
    }
    rafCb = null;
    cb(ms);
  }
  return {
    els,
    q: (expr) => vm.runInContext(expr, context),
    frameAt,
    // n pinned 1/60 s frames (timestamps i*1000/60, i = 1..n).
    // Caller drives frameAt(0) first (dt 0) then tick(n).
    tick(n) {
      for (let i = 1; i <= n; i++) frameAt(i * (1000 / 60));
    },
    clickButton(id) {
      const el = els.get(id);
      assert(el !== undefined, `no stub element for #${id}`);
      const cbs = el.listeners["click"];
      assert(cbs && cbs.length >= 1, `the ${id} button listener must be wired at boot`);
      cbs[cbs.length - 1]({});
    },
    resize: () => {
      for (const cb of winListeners["resize"] ?? []) cb({ type: "resize" });
    },
  };
}

/** Advance `steps` fixed steps from start by repeated addition of
 *  dt — the EXACT clock value the world must hold after taking
 *  that many FIXED_DT steps from the same starting time. */
function foldedClock(start, dt, steps) {
  let t = start;
  for (let i = 0; i < steps; i++) t += dt;
  return t;
}

/** Drive 60 pinned frames and enforce the per-frame budget
 *  discipline: no frame may take more than one fixed step away
 *  from its `mult` × FIXED_DT budget (carry allowed, bursts and
 *  stalls are not). */
function drive60(g, mult) {
  const dt = g.q("FIXED_DT");
  for (let i = 1; i <= 60; i++) {
    const sBefore = g.q("FISH_TANK_WORLD.steps");
    g.frameAt(i * (1000 / 60));
    const frameSteps = g.q("FISH_TANK_WORLD.steps") - sBefore;
    const lo = mult === 0 ? 0 : mult - 1;
    const hi = mult === 0 ? 0 : mult + 1;
    assert(frameSteps >= lo && frameSteps <= hi,
      `frame ${i}: a ${mult}x frame must stay within one fixed step of its budget (${lo}..${hi}), took ${frameSteps}`);
  }
}

// ================================================================
// Criterion: static markup — the four speed controls, each once
// ================================================================
check("the page carries the pause/1x/2x/4x speed buttons, each exactly once", () => {
  for (const id of SPEED_IDS) {
    const hits = html.match(new RegExp(`id="${id}"`, "g")) ?? [];
    assert(hits.length === 1, `the page must carry exactly one #${id}, found ${hits.length}`);
  }
});

check("the app boots at 1x with the 1x button selected and no others", () => {
  const g = boot(800, 600);
  assert(g.q("FISH_TANK_SPEED") !== null && typeof g.q("FISH_TANK_SPEED") === "object",
    "FISH_TANK_SPEED must be exposed on the test seam");
  assert(g.q("FISH_TANK_SPEED.mult") === 1,
    `the default simulation speed must be 1x, got ${g.q("FISH_TANK_SPEED.mult")}`);
  assert(g.els.get("speed-1x").classes.has("selected"), "the 1x button must be selected at boot");
  for (const id of SPEED_IDS) {
    if (id !== "speed-1x") {
      assert(!g.els.get(id).classes.has("selected"), `#${id} must not be selected at boot`);
    }
  }
});

// ================================================================
// Criterion: 1x baseline — 60 pinned frames advance the sim by
// exactly 60 × FIXED_DT
// ================================================================
check("at 1x, 60 pinned 1/60 s frames advance the world by exactly 60 × FIXED_DT", () => {
  const g = boot(800, 600);
  g.frameAt(0);
  const dt = g.q("FIXED_DT");
  const t0 = g.q("FISH_TANK_WORLD.time");
  const s0 = g.q("FISH_TANK_WORLD.steps");
  drive60(g, 1);
  assert(g.q("FISH_TANK_WORLD.steps") - s0 === 60,
    `60 pinned frames at 1x must take exactly 60 fixed steps, took ${g.q("FISH_TANK_WORLD.steps") - s0}`);
  assert(Object.is(g.q("FISH_TANK_WORLD.time"), foldedClock(t0, dt, 60)),
    `the clock must equal the start advanced by exactly 60 × FIXED_DT, got ${g.q("FISH_TANK_WORLD.time")} vs ${foldedClock(t0, dt, 60)}`);
  assert(g.q("FISH_TANK_WORLD.acc") < dt,
    `no more than one fixed step may be pending, acc=${g.q("FISH_TANK_WORLD.acc")}`);
});

// ================================================================
// Criterion: 2x — 60 pinned frames advance the sim by exactly
// 2 × FIXED_DT per frame (120 fixed steps total)
// ================================================================
check("at 2x, 60 pinned 1/60 s frames advance the world by exactly 120 × FIXED_DT (2 × FIXED_DT per frame)", () => {
  const g = boot(800, 600);
  g.frameAt(0);
  g.clickButton("speed-2x");
  assert(g.q("FISH_TANK_SPEED.mult") === 2, "selecting 2x must set the speed mult to 2");
  const dt = g.q("FIXED_DT");
  const t0 = g.q("FISH_TANK_WORLD.time");
  const s0 = g.q("FISH_TANK_WORLD.steps");
  drive60(g, 2);
  assert(g.q("FISH_TANK_WORLD.steps") - s0 === 120,
    `60 pinned frames at 2x must take exactly 120 fixed steps, took ${g.q("FISH_TANK_WORLD.steps") - s0}`);
  assert(Object.is(g.q("FISH_TANK_WORLD.time"), foldedClock(t0, dt, 120)),
    `the clock must equal the start advanced by exactly 120 × FIXED_DT, got ${g.q("FISH_TANK_WORLD.time")} vs ${foldedClock(t0, dt, 120)}`);
  assert(g.q("FISH_TANK_WORLD.acc") < dt,
    `no more than one fixed step may be pending, acc=${g.q("FISH_TANK_WORLD.acc")}`);
});

// ================================================================
// Criterion: 4x — 60 pinned frames advance the sim by exactly
// 4 × FIXED_DT per frame (240 fixed steps total)
// ================================================================
check("at 4x, 60 pinned 1/60 s frames advance the world by exactly 240 × FIXED_DT (4 × FIXED_DT per frame)", () => {
  const g = boot(800, 600);
  g.frameAt(0);
  g.clickButton("speed-4x");
  assert(g.q("FISH_TANK_SPEED.mult") === 4, "selecting 4x must set the speed mult to 4");
  const dt = g.q("FIXED_DT");
  const t0 = g.q("FISH_TANK_WORLD.time");
  const s0 = g.q("FISH_TANK_WORLD.steps");
  drive60(g, 4);
  assert(g.q("FISH_TANK_WORLD.steps") - s0 === 240,
    `60 pinned frames at 4x must take exactly 240 fixed steps, took ${g.q("FISH_TANK_WORLD.steps") - s0}`);
  assert(Object.is(g.q("FISH_TANK_WORLD.time"), foldedClock(t0, dt, 240)),
    `the clock must equal the start advanced by exactly 240 × FIXED_DT, got ${g.q("FISH_TANK_WORLD.time")} vs ${foldedClock(t0, dt, 240)}`);
  assert(g.q("FISH_TANK_WORLD.acc") < dt,
    `no more than one fixed step may be pending, acc=${g.q("FISH_TANK_WORLD.acc")}`);
});

// ================================================================
// Criterion: Pause — 60 pinned frames advance nothing
// ================================================================
check("paused, 60 pinned 1/60 s frames advance the world clock by exactly 0", () => {
  const g = boot(800, 600);
  g.frameAt(0);
  g.clickButton("speed-pause");
  assert(g.q("FISH_TANK_SPEED.mult") === 0, "selecting pause must set the speed mult to 0");
  const t0 = g.q("FISH_TANK_WORLD.time");
  const s0 = g.q("FISH_TANK_WORLD.steps");
  const a0 = g.q("FISH_TANK_WORLD.acc");
  drive60(g, 0);
  assert(g.q("FISH_TANK_WORLD.steps") === s0, "a paused sim must take no fixed steps");
  assert(Object.is(g.q("FISH_TANK_WORLD.time"), t0),
    `a paused sim clock must not move, went ${t0} → ${g.q("FISH_TANK_WORLD.time")}`);
  assert(Object.is(g.q("FISH_TANK_WORLD.acc"), a0),
    "a paused sim must not touch its accumulator");
});

// ================================================================
// Criterion: resume — no catch-up burst after a pause
// ================================================================
check("resuming after a pause takes exactly one step on the next pinned frame (no burst)", () => {
  const g = boot(800, 600);
  g.frameAt(0);
  g.clickButton("speed-pause");
  g.tick(20); // wall time passes while paused
  const dt = g.q("FIXED_DT");
  const t0 = g.q("FISH_TANK_WORLD.time");
  const s0 = g.q("FISH_TANK_WORLD.steps");
  g.clickButton("speed-1x");
  g.frameAt(20 * (1000 / 60) + 1000 / 60);
  assert(g.q("FISH_TANK_WORLD.steps") - s0 === 1,
    `the first frame after resume must take exactly 1 step, took ${g.q("FISH_TANK_WORLD.steps") - s0}`);
  assert(Object.is(g.q("FISH_TANK_WORLD.time"), foldedClock(t0, dt, 1)),
    `the first frame after resume must advance exactly 1 × FIXED_DT, got ${g.q("FISH_TANK_WORLD.time")}`);
});

// ================================================================
// Criterion: selection — exactly one speed button highlighted at
// a time, tracking the active setting
// ================================================================
check("each speed selection highlights exactly that button and no other", () => {
  const g = boot(800, 600);
  g.frameAt(0);
  for (const [id, mult] of [["speed-pause", 0], ["speed-2x", 2], ["speed-4x", 4], ["speed-1x", 1]]) {
    g.clickButton(id);
    const selected = SPEED_IDS.filter((s) => g.els.get(s).classes.has("selected"));
    assert(selected.length === 1,
      `after selecting ${id} exactly one button must be highlighted, got [${selected}]`);
    assert(selected[0] === id, `the highlighted button must be ${id}, got ${selected[0]}`);
    assert(g.q("FISH_TANK_SPEED.mult") === mult,
      `after selecting ${id} the speed mult must be ${mult}, got ${g.q("FISH_TANK_SPEED.mult")}`);
  }
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
