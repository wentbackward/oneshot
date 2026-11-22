#!/usr/bin/env node
// ================================================================
// Unit tests — toolbar Place/Remove modes (ticket #122, PRD §3):
// the REAL bundled <script> from the committed fishtank.html boots
// in a sandboxed node:vm context; toolbar buttons and canvas clicks
// are driven through captured DOM listeners and the world counts
// (rocks, kelp anchors) are asserted to follow placements/removals
// EXACTLY — including the ROCK_MAX / KELP_MAX caps — and that
// removing a rock restores steering (no obstacle force remains).
//
// No network, no wall-clock dependence; seeded nothing — the boot
// is deterministic by construction (same seed 1 default world).
//
// Run: node tests/fishtank-placement.test.mjs
// ================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { obstacleAvoidance } from "../src/sim/steering.ts";
import { TANK_HEIGHT } from "../src/sim/world.ts";
import { ROCK_COLLIDE_PAD } from "../src/sim/constants.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "fishtank.html"), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("no <script> block found in fishtank.html");
const gameSource = scriptMatch[1];

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
const mag = (v) => Math.hypot(v.x, v.y);

// ---------- vm stubs (toolbar-aware) ----------

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

function boot(width, height, dpr = 1, toolbarRect = null) {
  const buttons = {
    "tool-place-rock": makeButton(),
    "tool-place-kelp": makeButton(),
    "tool-remove": makeButton(),
  };
  const toolbar =
    toolbarRect === null
      ? null
      : { getBoundingClientRect: () => ({ ...toolbarRect }) };
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
  const winListeners = {};
  const win = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: dpr,
    addEventListener: (type, cb) => {
      (winListeners[type] ??= []).push(cb);
    },
    requestAnimationFrame: (cb) => {
      rafCb = cb;
      return 1;
    },
  };
  const sandbox = {
    window: win,
    document: {
      getElementById: (id) =>
        id === "game" ? canvas : buttons[id] ?? (id === "toolbar" ? toolbar : null),
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);

  // One boot frame so the rAF loop is established.
  rafCb(0);

  const q = (expr) => vm.runInContext(expr, context);
  return {
    buttons,
    canvas,
    q,
    // Drive a real canvas click through the captured listener.
    clickCanvas(clientX, clientY) {
      const cbs = canvas.listeners["click"];
      assert(cbs && cbs.length >= 1, "the canvas click listener must be wired at boot");
      cbs[cbs.length - 1]({ clientX, clientY });
    },
    // Drive a toolbar mode switch through the captured listener.
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
// inverse of a (px, py) click at a 800×600 canvas is:
//   tankX = px * 1600/800, tankY = py * 1000/600
const W = 800;
const H = 600;
const toTankX = (px) => (px / W) * 1600;
const toTankY = (py) => (py / H) * 1000;

// ================================================================
// Criterion (boot): toolbar seams exposed, world starts empty
// ================================================================
check("vm boot: the toolbar is wired, the default mode is place-rock, and the world starts with no rocks and no kelp", () => {
  const g = boot(W, H);
  assert(typeof g.q("FISH_TANK_TOOLBAR") === "object" && g.q("FISH_TANK_TOOLBAR") !== null,
    "FISH_TANK_TOOLBAR must be exposed on the test seam");
  assert(g.q("FISH_TANK_TOOLBAR.mode") === "place-rock",
    `the default toolbar mode must be place-rock, got ${g.q("FISH_TANK_TOOLBAR.mode")}`);
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 0, "a fresh world has no rocks");
  assert(g.q("FISH_TANK_WORLD.kelp.length") === 0, "a fresh world has no kelp");
  assert(g.buttons["tool-place-rock"].classes.has("selected"),
    "the place-rock button must be selected at boot");
});

// ================================================================
// Criterion: Place mode adds rocks — world counts follow
// placements exactly (and placements land where the cursor said)
// ================================================================
check("place-rock mode: canvas clicks add rocks and world counts follow placements exactly", () => {
  const g = boot(W, H);
  g.clickCanvas(200, 150);
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 1,
    `one click must add exactly one rock, got ${g.q("FISH_TANK_WORLD.rocks.length")}`);
  const rock = g.q("FISH_TANK_WORLD.rocks[0]");
  assert(Math.abs(rock.x - toTankX(200)) < 1e-9,
    `the rock must land at the cursor's tank x (${toTankX(200)}), got ${rock.x}`);
  assert(Math.abs(rock.y - toTankY(150)) < 1e-9,
    `the rock must land at the cursor's tank y (${toTankY(150)}), got ${rock.y}`);
  assert(rock.r === g.q("ROCK_RADIUS"),
    `the rock radius must be the named ROCK_RADIUS, got ${rock.r}`);
  g.clickCanvas(500, 300);
  g.clickCanvas(600, 450);
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 3,
    `three clicks must add exactly three rocks, got ${g.q("FISH_TANK_WORLD.rocks.length")}`);
});

// ================================================================
// Criterion: Place mode adds kelp anchors — switched through the
// toolbar button, anchored at the substrate, counts follow exactly
// ================================================================
check("place-kelp mode (switched via the toolbar button): clicks add substrate-anchored kelp and counts follow exactly", () => {
  const g = boot(W, H);
  g.clickButton("tool-place-kelp");
  assert(g.q("FISH_TANK_TOOLBAR.mode") === "place-kelp",
    "clicking the place-kelp button must switch the mode");
  g.clickCanvas(240, 500);
  assert(g.q("FISH_TANK_WORLD.kelp.length") === 1,
    `one click must add exactly one kelp strand, got ${g.q("FISH_TANK_WORLD.kelp.length")}`);
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 0,
    "a kelp placement must not add a rock");
  const anchor = g.q("FISH_TANK_WORLD.kelp[0].points[0]");
  assert(Math.abs(anchor.x - toTankX(240)) < 1e-9,
    `the kelp anchor must follow the cursor x, got ${anchor.x}`);
  assert(anchor.y === TANK_HEIGHT,
    `the kelp anchor must sit at the substrate (y=${TANK_HEIGHT}), got ${anchor.y}`);
  g.clickCanvas(640, 500);
  assert(g.q("FISH_TANK_WORLD.kelp.length") === 2,
    `two clicks must add exactly two kelp strands, got ${g.q("FISH_TANK_WORLD.kelp.length")}`);
});

// ================================================================
// Criterion: Remove mode removes — counts follow exactly, and a
// click on empty water removes nothing
// ================================================================
check("remove mode: a click removes the nearest object under the cursor; empty water removes nothing", () => {
  const g = boot(W, H);
  g.clickCanvas(200, 150); // rock A at tank (400, 250)
  g.clickCanvas(700, 550); // rock B at tank (1400, 916)
  g.clickButton("tool-remove");
  assert(g.q("FISH_TANK_TOOLBAR.mode") === "remove", "the mode must switch to remove");
  g.clickCanvas(710, 555); // on rock B
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 1,
    `removing rock B must leave exactly 1 rock, got ${g.q("FISH_TANK_WORLD.rocks.length")}`);
  assert(Math.abs(g.q("FISH_TANK_WORLD.rocks[0].x") - 400) < 1e-9,
    "rock A must be the survivor");
  g.clickCanvas(10, 10); // empty water, far from everything
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 1,
    "a click on empty water must not remove anything");
  // Remove kelp through the same mode.
  g.clickButton("tool-place-kelp");
  g.clickCanvas(240, 500); // kelp anchored near tank x 480
  g.clickButton("tool-remove");
  g.clickCanvas(240, 590); // near the anchor
  assert(g.q("FISH_TANK_WORLD.kelp.length") === 0,
    "remove mode must also remove kelp anchors");
});

// ================================================================
// Criterion: removal restores steering — no obstacle force remains
// for a removed rock
// ================================================================
check("removing a rock restores steering: no obstacle force remains for a removed rock", () => {
  const g = boot(W, H);
  g.clickCanvas(400, 300); // rock at tank (800, 500)
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 1, "test setup: one rock placed");
  // A probe body 60 tank units from the rock centre: deep inside
  // the obstacle sense distance, so the force is provably nonzero.
  const probe = { x: 860, y: 500, vx: 50, vy: 0 };
  const before = mag(obstacleAvoidance(probe, g.q("FISH_TANK_WORLD.rocks")));
  assert(before > 0, `the probe must feel the obstacle while the rock is placed (got ${before})`);
  g.clickButton("tool-remove");
  g.clickCanvas(400, 300); // on the rock
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 0, "the rock must be removed");
  const after = mag(obstacleAvoidance(probe, g.q("FISH_TANK_WORLD.rocks")));
  assert(after === 0,
    `no obstacle force may remain for a removed rock (got ${after})`);
});

// ================================================================
// Criterion: caps — placements are capped at ROCK_MAX / KELP_MAX
// and further attempts are no-ops, so the count stays EXACT
// ================================================================
check("place-rock is capped at ROCK_MAX: extra clicks and direct calls are rejected, the count stays exact", () => {
  const g = boot(W, H);
  const cap = g.q("ROCK_MAX");
  assert(Number.isInteger(cap) && cap > 0, `ROCK_MAX must be a positive integer, got ${cap}`);
  for (let i = 0; i < cap + 12; i++) {
    // Scatter the clicks so they land on distinct tank positions.
    g.clickCanvas(40 + i * 7, 100 + (i % 8) * 60);
  }
  assert(g.q("FISH_TANK_WORLD.rocks.length") === cap,
    `the rock count must stay exactly at ROCK_MAX (${cap}), got ${g.q("FISH_TANK_WORLD.rocks.length")}`);
  assert(g.q("FISH_TANK_WORLD.placeRock(100, 100)") === null,
    "a direct placeRock past the cap must return null");
});

check("place-kelp is capped at KELP_MAX: extra clicks are rejected, the count stays exact", () => {
  const g = boot(W, H);
  g.clickButton("tool-place-kelp");
  const cap = g.q("KELP_MAX");
  assert(Number.isInteger(cap) && cap > 0, `KELP_MAX must be a positive integer, got ${cap}`);
  for (let i = 0; i < cap + 12; i++) {
    g.clickCanvas(30 + i * 5, 500);
  }
  assert(g.q("FISH_TANK_WORLD.kelp.length") === cap,
    `the kelp count must stay exactly at KELP_MAX (${cap}), got ${g.q("FISH_TANK_WORLD.kelp.length")}`);
  assert(g.q("FISH_TANK_WORLD.placeKelp(100)") === null,
    "a direct placeKelp past the cap must return null");
});

// ================================================================
// Review fix: Hi-DPI (devicePixelRatio 2) — the click normalises
// against the CSS (layout) viewport, not the device-px backing
// store, so a click at CSS (200, 150) lands at the cursor's tank
// position (400, 250), not at 1/dpr of it
// ================================================================
check("hi-DPI (devicePixelRatio 2): a click lands at the cursor's tank position, not 1/dpr of it", () => {
  const g = boot(W, H, 2);
  assert(g.canvas.width === W * 2 && g.canvas.height === H * 2,
    `the backing store must be sized in device px (${W * 2}×${H * 2}), got ${g.canvas.width}×${g.canvas.height}`);
  g.clickCanvas(200, 150);
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 1, "one click must add exactly one rock");
  const rock = g.q("FISH_TANK_WORLD.rocks[0]");
  assert(Math.abs(rock.x - toTankX(200)) < 1e-9,
    `dpr=2: the rock must land at the cursor's tank x (${toTankX(200)}), got ${rock.x}`);
  assert(Math.abs(rock.y - toTankY(150)) < 1e-9,
    `dpr=2: the rock must land at the cursor's tank y (${toTankY(150)}), got ${rock.y}`);
});

// ================================================================
// Review fix: the kelp pick is bounded to the anchor/substrate
// band — a remove click on open water high above a strand must not
// strike it; a click on the band must
// ================================================================
check("remove mode: a kelp click on open water above the substrate band removes nothing; the band removes", () => {
  const g = boot(W, H);
  g.clickButton("tool-place-kelp");
  g.clickCanvas(240, 500); // kelp anchored at tank x 480
  g.clickButton("tool-remove");
  g.clickCanvas(240, 100); // tank (480, 166.7): open water ~833 u above the anchor
  assert(g.q("FISH_TANK_WORLD.kelp.length") === 1,
    "a remove click on open water above the substrate band must not strike the strand");
  g.clickCanvas(240, 590); // tank (480, 983.3): inside the substrate band
  assert(g.q("FISH_TANK_WORLD.kelp.length") === 0,
    "a remove click on the anchor/substrate band must remove the strand");
});

// ================================================================
// Review fix: single-wire invariant — a second attach() must not
// stack a duplicate canvas-click listener (a click would then place
// twice)
// ================================================================
check("attach() is single-shot: a second attach stacks no duplicate listeners and a click still places exactly one rock", () => {
  const g = boot(W, H);
  g.q("FISH_TANK_TOOLBAR.attach(document, document.getElementById('game'))");
  assert(g.canvas.listeners["click"].length === 1,
    `a second attach must not stack a duplicate canvas listener, got ${g.canvas.listeners["click"].length}`);
  g.clickCanvas(200, 150);
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 1,
    "a single canvas click must place exactly one rock after a double attach");
});

// ================================================================
// Review fix: click-region guard — in place modes the first
// instinct is the top-left corner, which is UNDER the toolbar. A
// click anywhere in the toolbar's on-screen rect must be dropped:
// nothing is ever placed or removed hidden behind it
// ================================================================
check("clicks inside the toolbar's on-screen rect are dropped: nothing is placed or removed under the toolbar", () => {
  // Toolbar rect: a 220×30 strip at the top-left of the 800×600
  // canvas (matching the fixed 10px/10px layout) → tank x 0…440,
  // y 0…50, covering the corner a first place-mode click aims at.
  const g = boot(W, H, 1, { left: 10, top: 10, right: 230, bottom: 40 });
  g.clickCanvas(60, 20); // under the toolbar → tank (120, 33.3)
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 0,
    "a place-rock click under the toolbar must not place a rock");
  g.clickButton("tool-place-kelp");
  g.clickCanvas(60, 20);
  assert(g.q("FISH_TANK_WORLD.kelp.length") === 0,
    "a place-kelp click under the toolbar must not place kelp");
  g.clickButton("tool-place-rock");
  g.clickCanvas(400, 300); // clear of the toolbar → tank (800, 500)
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 1,
    "a click clear of the toolbar must still place");
  // A rock directly under the toolbar's rect (via the seam — a
  // click could never get it there): a remove click at the same
  // spot would delete it if the guard did not drop the click.
  g.q("FISH_TANK_WORLD.placeRock(120, 40)");
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 2, "test setup: second rock placed");
  g.clickButton("tool-remove");
  g.clickCanvas(60, 20); // tank (120, 33.3): ~7 u from the rock's centre
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 2,
    "a remove click under the toolbar must not remove anything");
});

// ================================================================
// Review fix (round 3): seam.ROCK_COLLIDE_PAD is CONSUMED — the
// vm-booted (bundled) collision pad must equal the canonical source
// constant, and a rock dropped on the bundled world's own school
// must keep the school out of rock.r + pad for 300 bundled steps
// ================================================================
check("vm soak: a rock dropped on the school keeps every tetra outside rock.r + seam.ROCK_COLLIDE_PAD for 300 steps", () => {
  const g = boot(W, H);
  const pad = g.q("ROCK_COLLIDE_PAD");
  assert(Number.isFinite(pad) && pad > 0,
    `ROCK_COLLIDE_PAD must be exposed on the seam and positive, got ${pad}`);
  assert(pad === ROCK_COLLIDE_PAD,
    `the bundled pad (${pad}) must equal the source constant (${ROCK_COLLIDE_PAD})`);
  // A rock on the spawn-cluster centre: guaranteed overlaps at
  // placement, so the bundle's own resolution must clear them.
  g.clickCanvas(400, 300); // tank (800, 500)
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 1, "test setup: one rock placed");
  const report = g.q(`(function () {
    const w = FISH_TANK_WORLD;
    const min = w.rocks[0].r + ROCK_COLLIDE_PAD;
    let worst = Infinity;
    let badStep = -1;
    for (let i = 0; i < 300; i++) {
      w.step(FIXED_DT);
      for (const t of w.agents) {
        const d = Math.hypot(t.x - w.rocks[0].x, t.y - w.rocks[0].y);
        if (d < worst) worst = d;
        if (d < min - 1e-6 && badStep < 0) badStep = i + 1;
      }
    }
    return { worst: worst, badStep: badStep, min: min };
  })()`);
  assert(report.badStep === -1,
    `a bundled tetra entered rock.r + ROCK_COLLIDE_PAD at step ${report.badStep} (worst dist ${report.worst} < ${report.min})`);
  assert(report.worst >= report.min - 1e-6,
    `worst distance over 300 bundled steps must stay >= rock.r + pad (${report.worst} < ${report.min})`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
