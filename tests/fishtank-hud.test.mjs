#!/usr/bin/env node
// ================================================================
// Unit tests — collapsible HUD telemetry (ticket #126, PRD §4):
// one toggle collapses/expands the telemetry panel, which shows
// the live FPS, per-species entity counts and the spatial-grid
// cell utilization (occupied cells ÷ total cells).
//
// Harness: house style — the REAL bundled <script> from the
// committed fishtank.html boots in a sandboxed node:vm context
// with stubbed window/document elements; frames are driven
// through the captured requestAnimationFrame callback on a
// PINNED 60 Hz clock. Species counts and grid utilization are
// asserted against the world's LIVE state (the HUD must be a
// view, never a copy). No network, no external services.
//
// Run: node tests/fishtank-hud.test.mjs
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

// A minimal element stub: captures listeners, keeps its class set
// and textContent in plain JS state the test can read back.
function makeEl(id) {
  const el = {
    id,
    listeners: {},
    classes: new Set(),
    textContent: "",
    attrs: {},
    setAttribute: function (name, value) { this.attrs[name] = value; },
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

// A 2d-context stub that absorbs every draw call the loop makes.
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

const HUD_IDS = [
  "hud", "hud-toggle", "hud-panel",
  "hud-fps", "hud-count-tetra", "hud-count-predator", "hud-grid",
];
const SPEED_IDS = ["speed-pause", "speed-1x", "speed-2x", "speed-4x"];
const TOOL_IDS = ["tool-place-rock", "tool-place-kelp", "tool-remove"];

function boot(width, height) {
  const els = new Map();
  for (const id of [...HUD_IDS, ...SPEED_IDS, ...TOOL_IDS]) els.set(id, makeEl(id));
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
    canvas,
    q: (expr) => vm.runInContext(expr, context),
    frameAt,
    // n frames on the pinned 60 Hz clock, starting just after t=0.
    // Caller drives frameAt(0) first (dt 0) then tick(n).
    tick(n) {
      let now = 0;
      for (let i = 1; i <= n; i++) {
        now += 1000 / 60;
        frameAt(now);
      }
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

// Spatial-grid geometry (must mirror src/sim: cell 64, tank
// 1600×1000 ⇒ 25 × 16 cells). Used to RECOMPUTE the utilization
// figure independently of the HUD.
const TANK_W = 1600;
const TANK_H = 1000;
const CELL = 64;
const COLS = Math.ceil(TANK_W / CELL);
const ROWS = Math.ceil(TANK_H / CELL);
const TOTAL_CELLS = COLS * ROWS;

function occupiedCellCount(pos) {
  const seen = new Set();
  for (const [x, y] of pos) {
    const c = Math.min(COLS - 1, Math.max(0, Math.floor(x / CELL)));
    const r = Math.min(ROWS - 1, Math.max(0, Math.floor(y / CELL)));
    seen.add(r * COLS + c);
  }
  return seen.size;
}

// ================================================================
// Criterion: static markup — one HUD, one toggle, the telemetry
// panel with fps / per-species counts / grid-utilization fields
// ================================================================
check("the page carries exactly one hud toggle (the single collapse control)", () => {
  const toggles = html.match(/id="hud-toggle"/g) ?? [];
  assert(toggles.length === 1,
    `the HUD must have exactly one toggle control, found ${toggles.length}`);
});

check("the telemetry panel markup carries the fps, per-species count and grid-utilization fields", () => {
  for (const id of ["hud-panel", "hud-fps", "hud-count-tetra", "hud-count-predator", "hud-grid"]) {
    const hits = html.match(new RegExp(`id="${id}"`, "g")) ?? [];
    assert(hits.length === 1, `the page must carry exactly one #${id}, found ${hits.length}`);
  }
});

// ================================================================
// Criterion: per-species counts — the displayed numbers equal the
// world's LIVE pool counts (queried at the same instant)
// ================================================================
check("the HUD's per-species counts equal the world's live pools", () => {
  const g = boot(800, 600);
  assert(typeof g.q("FISH_TANK_HUD") === "object" && g.q("FISH_TANK_HUD") !== null,
    "FISH_TANK_HUD must be exposed on the test seam");
  g.frameAt(0);
  g.tick(90); // let the school swim (and the HUD refresh)
  const tetras = g.q("FISH_TANK_WORLD.agents.length");
  const predator = g.q("FISH_TANK_WORLD.predator !== null ? 1 : 0");
  assert(g.els.get("hud-count-tetra").textContent === String(tetras),
    `the displayed tetra count must equal the live pool (${tetras}), got "${g.els.get("hud-count-tetra").textContent}"`);
  assert(g.els.get("hud-count-predator").textContent === String(predator),
    `the displayed predator count must equal the live pool (${predator}), got "${g.els.get("hud-count-predator").textContent}"`);
});

check("the tetra display follows a live population change (removal is reflected)", () => {
  const g = boot(800, 600);
  g.frameAt(0);
  g.q("FISH_TANK_WORLD.setTetraCount(42)");
  g.tick(3);
  assert(g.els.get("hud-count-tetra").textContent === "42",
    `after trimming the pool to 42 the HUD must show 42, got "${g.els.get("hud-count-tetra").textContent}"`);
});

// ================================================================
// Criterion: grid utilization — occupied cells ÷ total, recomputed
// independently from the grid's live state
// ================================================================
check("the HUD's grid utilization equals occupied/total recomputed from the live tetra positions", () => {
  const g = boot(800, 600);
  g.frameAt(0);
  g.tick(5);
  const pos = g.q("FISH_TANK_WORLD.agents.map((t) => [t.x, t.y])");
  const used = occupiedCellCount(pos);
  const shown = g.els.get("hud-grid").textContent;
  const m = String(shown).match(/^(\d+)\/(\d+)$/);
  assert(m, `the grid-utilization field must read "occupied/total", got "${shown}"`);
  assert(Number(m[2]) === TOTAL_CELLS,
    `the total cell count must be the grid's cols×rows (${TOTAL_CELLS}), got ${m[2]}`);
  assert(Number(m[1]) === used,
    `the occupied cell count must equal the live grid (${used}), got ${m[1]}`);
});

// ================================================================
// Criterion: FPS — on the pinned 60 Hz clock the readout settles
// at the clock's rate
// ================================================================
check("the HUD FPS readout settles at the pinned 60 Hz frame rate", () => {
  const g = boot(800, 600);
  g.frameAt(0);
  g.tick(60);
  assert(g.els.get("hud-fps").textContent === "60",
    `on a pinned 60 Hz clock the FPS readout must read 60, got "${g.els.get("hud-fps").textContent}"`);
});

// ================================================================
// Criterion: collapsible — one toggle click hides the panel, a
// second re-expands it (and the loop keeps running throughout)
// ================================================================
check("one toggle click collapses the HUD panel; a second click re-expands it", () => {
  const g = boot(800, 600);
  g.frameAt(0);
  g.tick(3);
  const hud = g.q("FISH_TANK_HUD");
  assert(hud.collapsed === false, "the HUD must start expanded");
  g.clickButton("hud-toggle");
  assert(hud.collapsed === true, "the toggle must collapse the HUD");
  assert(g.els.get("hud").classes.has("collapsed"),
    "the collapsed state must be visible on the HUD container's class");
  g.clickButton("hud-toggle");
  assert(hud.collapsed === false, "a second toggle must re-expand the HUD");
  assert(!g.els.get("hud").classes.has("collapsed"),
    "re-expanding must clear the collapsed class");
});

check("a collapsed HUD keeps receiving frames and re-renders its data when expanded again", () => {
  const g = boot(800, 600);
  g.frameAt(0);
  g.tick(5);
  g.clickButton("hud-toggle"); // collapsed
  g.tick(15); // frames must not throw while collapsed
  assert(g.q("FISH_TANK_HUD.collapsed") === true, "still collapsed");
  g.clickButton("hud-toggle"); // re-expand
  g.tick(1);
  const pos = g.q("FISH_TANK_WORLD.agents.map((t) => [t.x, t.y])");
  const used = occupiedCellCount(pos);
  assert(g.els.get("hud-grid").textContent === `${used}/${TOTAL_CELLS}`,
    "after re-expanding the utilization must reflect the current grid");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
