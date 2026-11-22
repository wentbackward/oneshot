#!/usr/bin/env node
// ================================================================
// VM-boot tests — drop-food & tap-glass toolbar tools (ticket
// #121, PRD §3): the REAL bundled <script> from the committed
// fishtank.html boots in a sandboxed node:vm context; the new
// toolbar buttons are driven through captured DOM listeners and
// the world counts are asserted to follow EXACTLY:
//  - activating Drop Food then N canvas clicks raises the pellet
//    count to exactly N, capped at the named PELLET_MAX;
//  - a Tap Glass click spawns an expanding ring whose radius
//    strictly grows for 30 frames;
//  - the same tap startles at the cursor: the tetras inside
//    STARTLE_RADIUS scatter with a positive mean outward radial
//    velocity (same assertion shape as the tetra ticket's startle
//    test, tests/fishtank-tetras.test.mjs).
//
// No network, no wall-clock dependence — the boot is deterministic
// by construction (default seed-1 world).
//
// Run: node tests/fishtank-food-toolbar.test.mjs
// ================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { STARTLE_RADIUS } from "../src/sim/constants.ts";

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

/** Mean radial velocity of a SET of tetras away from (x, y) — the
 *  same shape as the tetras suite' startle assertion. */
function meanRadialVelocity(agents, x, y) {
  let sum = 0;
  let counted = 0;
  for (const t of agents) {
    const dx = t.x - x;
    const dy = t.y - y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-9) continue; // a tetra exactly on the epicentre casts no radial vote
    sum += (t.vx * dx + t.vy * dy) / d;
    counted += 1;
  }
  assert(counted > 0, "no tetra lies off the epicentre: the radial mean is undefined");
  return sum / counted;
}

// ---------- vm stubs (toolbar-aware, same contract as the
// placement suite) ----------
function makeButton() {
  const classes = new Set();
  const listeners = {};
  return {
    classes,
    listeners,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    addEventListener: (type, cb) => {
      (listeners[type] ??= []).push(cb);
    },
  };
}

function boot(width, height) {
  const buttons = {
    "tool-drop-food": makeButton(),
    "tool-tap-glass": makeButton(),
    "tool-place-rock": makeButton(),
    "tool-place-kelp": makeButton(),
    "tool-remove": makeButton(),
  };
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    listeners: {},
    addEventListener: (type, cb) => {
      (canvas.listeners[type] ??= []).push(cb);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    getContext: () => makeCtx(),
  };
  let rafCb = null;
  const win = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    addEventListener: () => {},
    requestAnimationFrame: (cb) => {
      rafCb = cb;
      return 1;
    },
  };
  const sandbox = {
    window: win,
    document: {
      getElementById: (id) => (id === "game" ? canvas : buttons[id] ?? null),
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);
  rafCb(0); // one boot frame so the rAF loop is established

  const q = (expr) => vm.runInContext(expr, context);
  return {
    buttons,
    q,
    clickCanvas(clientX, clientY) {
      const cbs = canvas.listeners["click"];
      assert(cbs && cbs.length >= 1, "the canvas click listener must be wired at boot");
      cbs[cbs.length - 1]({ clientX, clientY });
    },
    clickButton(id) {
      const cbs = buttons[id].listeners["click"];
      assert(cbs && cbs.length >= 1, `the ${id} button listener must be wired at boot`);
      cbs[cbs.length - 1]({});
    },
  };
}

// The 2d stub only needs to absorb the boot frame's draws.
function makeCtx() {
  const gradient = { addColorStop: () => {} };
  const target = {
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => ({}),
    measureText: () => ({ width: 0 }),
    canvas: null,
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

// The app maps tank units → canvas px by a plain stretch, so the
// inverse of a (px, py) click at an 800×600 canvas is:
//   tankX = px * 1600/800, tankY = py * 1000/600
const W = 800;
const H = 600;
const toTankX = (px) => (px / W) * 1600;
const toTankY = (py) => (py / H) * 1000;

// ================================================================
// Criterion (boot): the toolbar OFFERS Drop Food and Tap Glass —
// static buttons are wired, the world starts with zero food and
// zero rings, the default mode is unchanged
// ================================================================
check("vm boot: the toolbar offers Drop Food and Tap Glass; the world starts with 0 pellets and 0 shockwave rings", () => {
  const g = boot(W, H);
  assert(typeof g.q("FISH_TANK_TOOLBAR") === "object" && g.q("FISH_TANK_TOOLBAR") !== null,
    "FISH_TANK_TOOLBAR must be exposed on the test seam");
  for (const id of ["tool-drop-food", "tool-tap-glass"]) {
    assert(g.buttons[id].listeners["click"] && g.buttons[id].listeners["click"].length === 1,
      `the ${id} button must be wired with exactly one click listener`);
  }
  assert(g.q("FISH_TANK_WORLD.pellets.length") === 0, "a fresh world has no pellets");
  assert(g.q("FISH_TANK_WORLD.shockwaves.length") === 0, "a fresh world has no shockwave rings");
  assert(g.q("FISH_TANK_TOOLBAR.mode") === "place-rock",
    "the default mode must remain place-rock");
  assert(!g.buttons["tool-drop-food"].classes.has("selected") &&
         !g.buttons["tool-tap-glass"].classes.has("selected"),
    "neither new button may be selected at boot");
});

// ================================================================
// Criterion: toolbar activation + N spawn triggers raise the
// pellet count to EXACTLY N, at the cursor positions
// ================================================================
check("drop food: toolbar activation then N canvas clicks spawns exactly N pellets, at the cursor", () => {
  const g = boot(W, H);
  g.clickButton("tool-drop-food");
  assert(g.q("FISH_TANK_TOOLBAR.mode") === "drop-food",
    "clicking the drop-food button must activate the mode");
  const clicks = [[150, 120], [300, 200], [500, 150], [620, 320], [720, 260]];
  for (const [px, py] of clicks) g.clickCanvas(px, py);
  const n = g.q("FISH_TANK_WORLD.pellets.length");
  assert(n === clicks.length,
    `${clicks.length} spawn triggers must raise the pellet count to exactly ${clicks.length}, got ${n}`);
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 0,
    "food drops must not add rocks");
  assert(g.q("FISH_TANK_WORLD.kelp.length") === 0,
    "food drops must not add kelp");
  const p = g.q("FISH_TANK_WORLD.pellets[0]");
  assert(Math.abs(p.x - toTankX(150)) < 1e-9 && Math.abs(p.y - toTankY(120)) < 1e-9,
    `pellet 0 must land at the cursor's tank position (${toTankX(150)}, ${toTankY(120)}), got (${p.x}, ${p.y})`);
});

// ================================================================
// Criterion: spawns are capped at the named PELLET_MAX — further
// triggers are no-ops, the count stays EXACT
// ================================================================
check("drop food is capped at PELLET_MAX: extra spawn triggers are rejected, the count stays exact", () => {
  const g = boot(W, H);
  g.clickButton("tool-drop-food");
  const cap = g.q("PELLET_MAX");
  assert(Number.isInteger(cap) && cap > 0, `PELLET_MAX must be a positive integer, got ${cap}`);
  for (let i = 0; i < cap + 12; i++) {
    // Scatter the clicks so they land on distinct tank positions.
    g.clickCanvas(30 + i * 4, 100 + (i % 9) * 50);
  }
  assert(g.q("FISH_TANK_WORLD.pellets.length") === cap,
    `the pellet count must stay exactly at PELLET_MAX (${cap}), got ${g.q("FISH_TANK_WORLD.pellets.length")}`);
  assert(g.q("FISH_TANK_WORLD.dropFood(100, 100)") === null,
    "a direct dropFood past the cap must return null");
});

// ================================================================
// Criterion: tap glass spawns an EXPANDING ring — its radius
// strictly grows for 30 frames
// ================================================================
check("tap glass: a canvas click spawns one ring whose radius strictly grows for 30 frames", () => {
  const g = boot(W, H);
  g.clickButton("tool-tap-glass");
  assert(g.q("FISH_TANK_TOOLBAR.mode") === "tap-glass",
    "clicking the tap-glass button must activate the mode");
  g.clickCanvas(400, 300); // tank (800, 500)
  assert(g.q("FISH_TANK_WORLD.shockwaves.length") === 1,
    "one tap must spawn exactly one ring");
  const r0 = g.q("FISH_TANK_WORLD.shockwaves[0]");
  assert(Math.abs(r0.x - toTankX(400)) < 1e-9 && Math.abs(r0.y - toTankY(300)) < 1e-9,
    `the ring must sit at the cursor's tank position (${toTankX(400)}, ${toTankY(300)}), got (${r0.x}, ${r0.y})`);
  let prev = -Infinity;
  for (let frame = 1; frame <= 30; frame++) {
    g.q("FISH_TANK_WORLD.step(FIXED_DT)");
    assert(g.q("FISH_TANK_WORLD.shockwaves.length") === 1,
      `frame ${frame}: the ring must still be alive within 30 frames`);
    const r = g.q("FISH_TANK_WORLD.shockwaves[0].radius");
    assert(r > prev, `frame ${frame}: ring radius must strictly grow (${prev} -> ${r})`);
    prev = r;
  }
});

// ================================================================
// Criterion: the tap also CALLS startleAt AT THE CURSOR — tetras
// inside STARTLE_RADIUS scatter with a positive mean outward
// radial velocity (same assertion shape as the tetras suite)
// ================================================================
check("tap glass startles at the cursor: the in-radius tetras' mean outward radial velocity is positive", () => {
  const g = boot(W, H);
  const cx = toTankX(400);
  const cy = toTankY(300);
  const agents = g.q("FISH_TANK_WORLD.agents");
  // Precompute the startled subset with the exact predicate the
  // sim uses (hypot ≤ STARTLE_RADIUS) BEFORE the event.
  const startled = agents.filter(
    (t) => Math.hypot(t.x - cx, t.y - cy) <= STARTLE_RADIUS,
  );
  assert(startled.length > 0, "test setup: the epicentre must catch at least one tetra");
  g.clickButton("tool-tap-glass");
  g.clickCanvas(400, 300);
  const v = meanRadialVelocity(startled, cx, cy);
  assert(v > 0,
    `the startled subset's (${startled.length} tetras) mean radial velocity must be positive (outward), got ${v}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
