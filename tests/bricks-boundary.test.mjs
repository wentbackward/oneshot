#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html playfield boundary rendering (ticket #69):
// solid bounce walls (top/left/right) + dashed bottom "danger" line
//
// Same harness style as the sibling bricks suites: runs the REAL
// <script> from bricks.html in a sandboxed vm context with stubbed
// window/document/localStorage/requestAnimationFrame and DOM element
// stubs. Unlike the siblings, the 2d context stub RECORDS every call
// and property write ([opName, argsArray] in order), so a driven
// frame's stroke paths — segments, dash pattern, colours, widths —
// are assertable at exact canvas coordinates. The dash-argument
// identity checks additionally prove the draw pass reuses prebuilt
// arrays (no per-frame allocation). `random` is pinned, no network,
// no wall clock, no sleeps.
//
// Run: node tests/bricks-boundary.test.mjs
// ================================================================
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "bricks.html"), "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error("no <script> block found in bricks.html");
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

// A DOM element stub: records text/listeners, answers click().
function makeEl(id) {
  const el = {
    id,
    style: {},
    textContent: "",
    className: "",
    children: [],
    listeners: {},
    addEventListener(type, cb) {
      (this.listeners[type] ??= []).push(cb);
    },
    click() {
      for (const cb of this.listeners["click"] ?? []) cb({ type: "click" });
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      return child;
    },
  };
  Object.defineProperty(el, "firstChild", {
    enumerable: true,
    get: () => (el.children.length > 0 ? el.children[0] : null),
  });
  return el;
}
// NOTE: this ticket adds NO new boot-time DOM elements — the boundary
// is pure canvas — so every sibling suite's stub map stays exhaustive.

// A recording 2d context: every method call pushes [name, argsArray]
// (argsArray is the RAW argument list, preserving reference identity
// of arrays such as the setLineDash pattern) and every property write
// pushes ["set:<prop>", [value]].
function makeRecordingCtx(ops) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        return (...args) => ops.push([String(prop), args]);
      },
      set(_t, prop, value) {
        ops.push(["set:" + String(prop), [value]]);
        return true;
      },
    }
  );
}

// Boot a fresh copy of the game on a width×height viewport.
function boot(width, height) {
  const ops = [];
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    rect: { left: 0, top: 0, width, height },
    getBoundingClientRect: () => canvas.rect,
    listeners: {},
    getContext: () => makeRecordingCtx(ops),
    addEventListener(type, cb) {
      (this.listeners[type] ??= []).push(cb);
    },
    dispatch(type, ev) {
      for (const cb of this.listeners[type] ?? []) cb(ev);
    },
  };
  const els = {
    "game": canvas,
    "screen-start": makeEl("screen-start"),
    "screen-pause": makeEl("screen-pause"),
    "screen-gameover": makeEl("screen-gameover"),
    "btn-start": makeEl("btn-start"),
    "difficulty-easy": makeEl("difficulty-easy"),
    "difficulty-normal": makeEl("difficulty-normal"),
    "difficulty-hard": makeEl("difficulty-hard"),
    "theme-classic": makeEl("theme-classic"),
    "theme-neon": makeEl("theme-neon"),
    "theme-minimal": makeEl("theme-minimal"),
    "mode-classic": makeEl("mode-classic"),
    "mode-exciting": makeEl("mode-exciting"),
    "mode-alleyway": makeEl("mode-alleyway"),    "btn-mute": makeEl("btn-mute"),
    "sound-volume": makeEl("sound-volume"),
    "ball-speed": makeEl("ball-speed"),
    "btn-resume": makeEl("btn-resume"),
    "btn-restart": makeEl("btn-restart"),
    "btn-menu": makeEl("btn-menu"),
    "gameover-final": makeEl("gameover-final"),
    "hud-score": makeEl("hud-score"),
    "hud-level": makeEl("hud-level"),
    "hiscore": makeEl("hiscore"),
    "lives": makeEl("lives"),
    "btn-reset-hiscore": makeEl("btn-reset-hiscore"),
    "leaderboard-start": makeEl("leaderboard-start"),
    "leaderboard-gameover": makeEl("leaderboard-gameover"),
  };
  const winListeners = {};
  let rafCb = null;
  let rafId = 0;
  const sandbox = {
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {
      innerWidth: width,
      innerHeight: height,
      addEventListener: (type, cb) => {
        (winListeners[type] ??= []).push(cb);
      },
    },
    document: {
      getElementById: (id) => els[id] ?? null,
      createElement: (tag) => makeEl(tag),
    },
    requestAnimationFrame: (cb) => {
      rafCb = cb;
      return ++rafId;
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);
  vm.runInContext("random = () => 1;", context); // no capsule drops by chance

  let nowMs = 0;
  const FRAME_MS = 1000 / 60;
  function tick(n = 1) {
    for (let i = 0; i < n; i += 1) {
      nowMs += FRAME_MS;
      rafCb(nowMs);
    }
  }
  function key(code) {
    for (const cb of winListeners["keydown"] ?? [])
      cb({ type: "keydown", code, preventDefault() {} });
  }
  // Enter live play with the serve ball in flight.
  function startAndLaunch() {
    els["btn-start"].click();
    canvas.dispatch("click", { type: "click" });
  }
  const q = (expr) => vm.runInContext(expr, context);
  return { canvas, els, ops, q, tick, key, startAndLaunch,
           state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState") };
}

// ---------- op-stream analysis ----------
// Reconstruct the stroked paths of a recorded op stream: each
// beginPath→stroke span yields { segments, dash, lineWidth,
// strokeStyle }, with stroke-side state captured as it stood at
// beginPath time (the game sets width/style/dash right before the
// path it strokes). Non-stroke draw calls (fills, arcs) are ignored.
function strokedPaths(ops) {
  const paths = [];
  let cur = null;
  let dash = [];
  let width = 0;
  let style = null;
  for (const [name, args] of ops) {
    if (name === "setLineDash") dash = args[0] || [];
    else if (name === "set:lineWidth") width = args[0];
    else if (name === "set:strokeStyle") style = args[0];
    else if (name === "beginPath") {
      // a beginPath abandoned before a stroke is dropped:
      // a fresh record replaces the previous one and is never flushed
      cur = { segments: [], dash, lineWidth: width, strokeStyle: style, from: null, stroked: false };
    } else if (name === "moveTo") {
      if (cur) cur.from = [args[0], args[1]];
    } else if (name === "lineTo") {
      if (cur && cur.from) cur.segments.push([cur.from, [args[0], args[1]]]);
      if (cur) cur.from = [args[0], args[1]];
    } else if (name === "stroke") {
      if (cur) { cur.stroked = true; paths.push(cur); cur = null; }
    }
  }
  // A beginPath abandoned before a stroke (e.g. the ball's
  // arc→fill span) is not a stroke path: never flushed.
  return paths;
}
// Drive exactly one frame and return its recorded ops + stroked paths.
function drawFrame(g) {
  const from = g.ops.length;
  g.tick(1);
  const ops = g.ops.slice(from);
  return { ops, paths: strokedPaths(ops) };
}
const segEq = (s, ax, ay, bx, by) =>
  s[0][0] === ax && s[0][1] === ay && s[1][0] === bx && s[1][1] === by;
const hasSeg = (segs, ax, ay, bx, by) => segs.some((s) => segEq(s, ax, ay, bx, by));
// Read a game global, tolerating absence (test-first friendliness).
const gv = (g, name) =>
  g.q(`typeof ${name} === "undefined" ? "<absent>" : ${name}`);

// Expected palette values per theme (ticket: colours come from the
// active theme's palette, consistent with the existing tables).
const EXPECTED = {
  classic: { wall: "#5cf2b0", danger: "#ef5d62" },
  neon: { wall: "#00f0ff", danger: "#ff2d78" },
  minimal: { wall: "#14141a", danger: "#57534e" },
};

// ================================================================
// Criterion 1: a playing frame draws three solid wall segments whose
// coordinates equal the ball's bounce rectangle (0 / canvas.width /
// canvas.height — the exact values bounceWalls compares against),
// plus one dashed bottom segment on the lose-a-life line
// ================================================================
check("a playing frame strokes exactly three solid wall segments on the bounce rectangle (top, left, right)", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  const { paths } = drawFrame(g);
  assert(paths.length === 2,
    `a playing frame must stroke exactly two paths (walls + danger), got ${paths.length}`);
  const solid = paths[0];
  const w = g.q("canvas.width");
  const h = g.q("canvas.height");
  assert(solid.dash.length === 0,
    `the wall path must be solid (no dash), dash=${JSON.stringify(solid.dash)}`);
  assert(solid.segments.length === 3,
    `the wall path must hold exactly three segments, got ${solid.segments.length}: ${JSON.stringify(solid.segments)}`);
  assert(hasSeg(solid.segments, 0, 0, w, 0),
    `missing TOP wall (0,0)→(${w},0): ${JSON.stringify(solid.segments)}`);
  assert(hasSeg(solid.segments, 0, 0, 0, h),
    `missing LEFT wall (0,0)→(0,${h}): ${JSON.stringify(solid.segments)}`);
  assert(hasSeg(solid.segments, w, 0, w, h),
    `missing RIGHT wall (${w},0)→(${w},${h}): ${JSON.stringify(solid.segments)}`);
  // The endpoints must be precisely the bounceWalls boundaries — no
  // inset, no second source of truth.
  for (const s of solid.segments) {
    for (const [x, y] of s) {
      assert((x === 0 || x === w) && (y === 0 || y === h),
        `wall endpoint (${x},${y}) is not on the bounce rectangle 0/${w}/0/${h}`);
    }
  }
});

check("a playing frame strokes exactly one dashed danger segment on the lose-a-life bottom edge", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  const { paths } = drawFrame(g);
  assert(paths.length === 2, `expected walls + danger paths, got ${paths.length}`);
  const danger = paths[1];
  const w = g.q("canvas.width");
  const h = g.q("canvas.height");
  assert(Array.isArray(danger.dash) && danger.dash.length > 0,
    `the danger path must be dashed, dash=${JSON.stringify(danger.dash)}`);
  assert(danger.dash.every((v) => v > 0),
    `dash pattern must carry positive on/off values, got ${JSON.stringify(danger.dash)}`);
  assert(danger.segments.length === 1,
    `the danger path must hold exactly one segment, got ${danger.segments.length}`);
  assert(segEq(danger.segments[0], 0, h, w, h),
    `the danger segment must run (0,${h})→(${w},${h}), got ${JSON.stringify(danger.segments[0])}`);
});

check("the wall and danger lines use the named tunable widths (positive numbers, console-addressable)", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  const { paths } = drawFrame(g);
  assert(paths.length === 2, "precondition: walls + danger drawn");
  const wallW = gv(g, "WALL_LINE_W");
  const dangerW = gv(g, "DANGER_LINE_W");
  assert(typeof wallW === "number" && wallW > 0, `WALL_LINE_W must be a positive number, got ${wallW}`);
  assert(typeof dangerW === "number" && dangerW > 0, `DANGER_LINE_W must be a positive number, got ${dangerW}`);
  assert(paths[0].lineWidth === wallW,
    `the wall stroke must use WALL_LINE_W (${wallW}), got ${paths[0].lineWidth}`);
  assert(paths[1].lineWidth === dangerW,
    `the danger stroke must use DANGER_LINE_W (${dangerW}), got ${paths[1].lineWidth}`);
});

check("the dash pattern and its reset are PREBUILT globals, identity-stable across frames (no per-frame allocation)", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  const patterns = [];
  const resets = [];
  for (let i = 0; i < 3; i += 1) {
    const { ops } = drawFrame(g);
    for (const [name, args] of ops) {
      if (name !== "setLineDash") continue;
      const arr = args[0];
      if (arr && arr.length > 0) patterns.push(arr);
      else resets.push(arr);
    }
  }
  const dash = gv(g, "DANGER_DASH");
  const noDash = gv(g, "NO_DASH");
  assert(Array.isArray(dash) && dash.length > 0,
    `DANGER_DASH must be a non-empty prebuilt array, got ${JSON.stringify(dash)}`);
  assert(Array.isArray(noDash) && noDash.length === 0,
    `NO_DASH must be a prebuilt empty reset array, got ${JSON.stringify(noDash)}`);
  assert(patterns.length === 3, `expected one dash per frame, saw ${patterns.length}`);
  assert(resets.length === 3, `expected one reset per frame, saw ${resets.length}`);
  for (const p of patterns) {
    assert(p === dash, `every frame must pass the SAME DANGER_DASH reference (prebuilt, no new array literal)`);
  }
  for (const r of resets) {
    assert(r === noDash, `every frame must pass the SAME NO_DASH reference after the dashed stroke`);
  }
});

// ================================================================
// Criterion 2: the boundary follows the existing "playing field
// visible" render gating — the field (and hence the boundary) is
// hidden on the start screen only; it is drawn while playing,
// paused and on game over (the frozen field behind the overlay)
// ================================================================
check("the start screen strokes no boundary at all (background fill only)", () => {
  const g = boot(960, 600);
  g.tick(3);
  assert(g.state() === "start", `precondition: on the start screen, state is ${g.state()}`);
  assert(g.ops.some(([n]) => n === "fillRect"),
    "sanity: the background fill must have run");
  const strokes = g.ops.filter(([n]) => n === "stroke");
  assert(strokes.length === 0,
    `no stroke may occur while the field is hidden, got ${strokes.length} stroke calls`);
  assert(strokedPaths(g.ops).length === 0, "no stroked path on the start screen");
});

check("a paused frame still strokes the full boundary (the field stays visible under the pause overlay)", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.tick(2);
  g.key("Escape");
  assert(g.state() === "paused", `precondition: paused, state is ${g.state()}`);
  const { paths } = drawFrame(g);
  assert(paths.length === 2,
    `the paused frame must keep drawing walls + danger, stroked ${paths.length} paths`);
});

check("a game-over frame still strokes the full boundary (the frozen field behind the overlay)", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.q("lives = 1;");
  g.q("balls[0].attached = false; balls[0].y = canvas.height + 100;");
  g.tick(1); // loseLife -> game over happens inside update this frame
  assert(g.state() === "gameover", `precondition: run over, state is ${g.state()}`);
  const { paths } = drawFrame(g);
  assert(paths.length === 2,
    `the game-over frame must keep drawing walls + danger, stroked ${paths.length} paths`);
});

// ================================================================
// Criterion 3: wall colours come from the active theme's palette —
// switching themes changes the recorded stroke colours, and every
// theme carries a sensible (defined, hex, visible, non-clashing) pair
// ================================================================
check("a playing frame records the classic palette's wall and danger stroke colours by default", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  const { paths } = drawFrame(g);
  assert(paths.length === 2, "precondition: walls + danger drawn");
  assert(paths[0].strokeStyle === EXPECTED.classic.wall,
    `wall colour must be the classic wall value ${EXPECTED.classic.wall}, recorded ${paths[0].strokeStyle}`);
  assert(paths[1].strokeStyle === EXPECTED.classic.danger,
    `danger colour must be the classic danger value ${EXPECTED.classic.danger}, recorded ${paths[1].strokeStyle}`);
});

check("switching to neon changes the recorded wall and danger stroke colours to the neon palette values", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.els["theme-neon"].click();
  const { paths } = drawFrame(g);
  assert(paths.length === 2, "precondition: walls + danger drawn");
  assert(g.q("COLOR_WALL") === EXPECTED.neon.wall,
    `COLOR_WALL must follow the neon theme (${EXPECTED.neon.wall}), got ${g.q("COLOR_WALL")}`);
  assert(paths[0].strokeStyle === EXPECTED.neon.wall,
    `recorded wall colour must be the neon value ${EXPECTED.neon.wall}, got ${paths[0].strokeStyle}`);
  assert(paths[1].strokeStyle === EXPECTED.neon.danger,
    `recorded danger colour must be the neon value ${EXPECTED.neon.danger}, got ${paths[1].strokeStyle}`);
});

check("switching to minimal changes the recorded wall and danger stroke colours to the minimal palette values", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.els["theme-minimal"].click();
  const { paths } = drawFrame(g);
  assert(paths.length === 2, "precondition: walls + danger drawn");
  assert(g.q("COLOR_DANGER") === EXPECTED.minimal.danger,
    `COLOR_DANGER must follow the minimal theme (${EXPECTED.minimal.danger}), got ${g.q("COLOR_DANGER")}`);
  assert(paths[0].strokeStyle === EXPECTED.minimal.wall,
    `recorded wall colour must be the minimal value ${EXPECTED.minimal.wall}, got ${paths[0].strokeStyle}`);
  assert(paths[1].strokeStyle === EXPECTED.minimal.danger,
    `recorded danger colour must be the minimal value ${EXPECTED.minimal.danger}, got ${paths[1].strokeStyle}`);
});

check("every theme defines a wall and danger colour that is a hex value, distinct from itself's partner and from its background", () => {
  const g = boot(960, 600);
  const themes = g.q("THEMES");
  assert(themes && typeof themes === "object", "THEMES must be a module-level table");
  for (const name of ["classic", "neon", "minimal"]) {
    const row = themes[name];
    const wall = row && row.palette ? row.palette.wall : "<absent>";
    const danger = row && row.palette ? row.palette.danger : "<absent>";
    const bg = row.palette.bg;
    assert(/^#[0-9a-f]{6}$/i.test(wall),
      `${name} theme must define a hex wall colour, got ${wall}`);
    assert(/^#[0-9a-f]{6}$/i.test(danger),
      `${name} theme must define a hex danger colour, got ${danger}`);
    assert(wall.toLowerCase() !== danger.toLowerCase(),
      `${name}: wall and danger must be visually distinct (${wall} vs ${danger})`);
    assert(wall.toLowerCase() !== bg.toLowerCase(),
      `${name}: the wall colour must not vanish into the background (${wall} on ${bg})`);
    assert(danger.toLowerCase() !== bg.toLowerCase(),
      `${name}: the danger colour must not vanish into the background (${danger} on ${bg})`);
    assert(wall === EXPECTED[name].wall && danger === EXPECTED[name].danger,
      `${name}: palette row must match the expected boundary values, got wall=${wall} danger=${danger}`);
  }
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
