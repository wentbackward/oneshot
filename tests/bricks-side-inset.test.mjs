#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html brick field side inset: the horizontal
// gap between the outermost bricks and the side walls is the named,
// widened BRICK_SIDE_MARGIN (ticket #98 — angle reach)
//
// Same harness style as the sibling bricks-*.test.mjs suites: the
// REAL <script> from bricks.html runs in a sandboxed vm context
// with stubbed window/document/localStorage/requestAnimationFrame
// and DOM element stubs. No network, no external services, no wall
// clock or sleeps.
//
// Coverage against the ticket's acceptance criteria:
//   AC1 — the side gap is the NEW named value (40 canvas px) in
//         BOTH modes; the field is symmetric (left gap == right
//         gap); the top margin is untouched
//   AC2 — BRICK_COLS unchanged: classic stays 10-col, alleyway
//         stays 5-col portrait; column width shrinks by deriving
//         from the widened inset via layoutBricks() (no layout
//         count change)
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

// Mirrors the game's named constants (checked live against the
// booted game below as well, so a drift fails both sides).
const KEY = "brickbreaker.mode";
const CLASSIC_W = 960;
const CLASSIC_H = 600;
const CLASSIC_BRICK_ROWS = 5;
const CLASSIC_BRICK_COLS = 10;
const ALLEYWAY_W = 480;
const ALLEYWAY_H = 800;
const ALLEYWAY_BRICK_ROWS = 10;
const ALLEYWAY_BRICK_COLS = 5;
const SCALE = 2;
// The ticket's widened inset: previously 24 canvas px; the top
// margin is intentionally untouched.
const WIDE_INSET = 40;
const TOP_MARGIN = 64;

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

// A DOM element stub: records styles, text, listeners and classes.
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

// A canvas 2d context stub: every method is a no-op, every property
// set is allowed.
function makeCtx() {
  const noop = () => {};
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        return noop;
      },
      set() {
        return true;
      },
    }
  );
}

// Boot a fresh copy of the game; initialStore seeds localStorage so
// a persisted mode selection (alleyway) survives the reload stub.
function boot(width, height, initialStore = {}) {
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    rect: { left: 0, top: 0, width, height },
    getBoundingClientRect: () => canvas.rect,
    listeners: {},
    getContext: () => makeCtx(),
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
    "btn-start": makeEl("btn-start"),
    "difficulty-easy": makeEl("difficulty-easy"),
    "difficulty-normal": makeEl("difficulty-normal"),
    "difficulty-hard": makeEl("difficulty-hard"),
    "theme-classic": makeEl("theme-classic"),
    "theme-neon": makeEl("theme-neon"),
    "theme-minimal": makeEl("theme-minimal"),
    "mode-classic": makeEl("mode-classic"),
    "mode-exciting": makeEl("mode-exciting"),
    "mode-alleyway": makeEl("mode-alleyway"),
    "btn-mute": makeEl("btn-mute"),
    "sound-volume": makeEl("sound-volume"),
    "ball-speed": makeEl("ball-speed"),
    "ball-speed-label": makeEl("ball-speed-label"),
    "ball-speed-value": makeEl("ball-speed-value"),
    "screen-gameover": makeEl("screen-gameover"),
    "btn-restart": makeEl("btn-restart"),
    "btn-menu": makeEl("btn-menu"),
    "screen-pause": makeEl("screen-pause"),
    "btn-resume": makeEl("btn-resume"),
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
  const store = Object.assign(Object.create(null), initialStore);
  const storage = {
    reads: [],
    writes: [],
    getItem(key) {
      storage.reads.push(String(key));
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      storage.writes.push([String(key), String(value)]);
      store[key] = String(value);
    },
  };
  const sandbox = {
    localStorage: storage,
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

  let nowMs = 0;
  const FRAME_MS = 1000 / 60;
  function tick(n = 1) {
    for (let i = 0; i < n; i += 1) {
      nowMs += FRAME_MS;
      rafCb(nowMs);
    }
  }
  const q = (expr) => vm.runInContext(expr, context);
  return {
    els,
    canvas,
    store,
    q,
    tick,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    start() {
      els["btn-start"].click();
      tick(1);
    },
    // Whole-pool side profile: layoutBricks assigns x/w to every
    // pool cell (occupied or not), so the row-0 edge cells give the
    // field's true left and right faces for ANY level pattern.
    sideProfile() {
      return q(`(() => {
        var cols = BRICK_COLS;
        var left = bricks[0];
        var right = bricks[cols - 1];
        return {
          leftX: left.x,
          rightEdge: right.x + right.w,
          leftGap: left.x,
          rightGap: canvas.width - (right.x + right.w),
          colW: left.w,
          topY: left.y,
        };
      })()`);
    },
  };
}

// ================================================================
// AC1 (classic): the side gap is the widened named value, the
// field is symmetric, the top margin is untouched
// ================================================================
check("classic: BRICK_SIDE_MARGIN is the widened named value (40 canvas px, console-retunable var)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  assert(g.state() === "playing", `setup: run started, state=${g.state()}`);
  assert(g.q("BRICK_SIDE_MARGIN") === WIDE_INSET,
    `the named side inset must be the widened ${WIDE_INSET} canvas px, got ${g.q("BRICK_SIDE_MARGIN")}`);
  assert(g.q("BRICK_TOP_MARGIN") === TOP_MARGIN,
    `the top margin is intentionally untouched at ${TOP_MARGIN}, got ${g.q("BRICK_TOP_MARGIN")}`);
});

check("classic: the outermost bricks sit exactly one widened inset from both side walls — left gap == right gap", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  assert(g.q("canvas.width") === CLASSIC_W * SCALE,
    `setup: landscape backing store, got ${g.q("canvas.width")}`);
  const s = g.sideProfile();
  assert(s.leftGap === WIDE_INSET,
    `the leftmost brick must start at the widened inset ${WIDE_INSET}, got ${s.leftGap}`);
  assert(s.rightGap === WIDE_INSET,
    `the rightmost brick must end at the widened inset ${WIDE_INSET} from the right wall, got ${s.rightGap}`);
  assert(s.leftGap === s.rightGap,
    `the brick field must be symmetric (left ${s.leftGap} != right ${s.rightGap})`);
  assert(s.topY === g.q("BRICK_TOP_MARGIN"),
    `the top row must still sit at BRICK_TOP_MARGIN, got ${s.topY}`);
});

check("classic: the widened inset is visibly larger than the old 24 px gap while staying modest", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  const margin = g.q("BRICK_SIDE_MARGIN");
  assert(margin > 24, `the gap must be larger than the old 24 px, got ${margin}`);
  assert(margin <= 0.1 * g.q("canvas.width"),
    `the inset must stay a modest fraction of the field width, got ${margin} of ${g.q("canvas.width")}`);
});

// ================================================================
// AC2 (classic): BRICK_COLS unchanged (10); column width shrinks by
// deriving from the widened inset via layoutBricks()
// ================================================================
check("classic: 10 columns unchanged; column width derives from the widened inset (bricks shrink and centre)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  assert(g.q("BRICK_COLS") === CLASSIC_BRICK_COLS,
    `BRICK_COLS must stay the named ${CLASSIC_BRICK_COLS}, got ${g.q("BRICK_COLS")}`);
  assert(g.q("BRICK_ROWS") === CLASSIC_BRICK_ROWS,
    `BRICK_ROWS must stay the named ${CLASSIC_BRICK_ROWS}, got ${g.q("BRICK_ROWS")}`);
  const gap = g.q("BRICK_GAP");
  const wantW = (CLASSIC_W * SCALE - 2 * WIDE_INSET - (CLASSIC_BRICK_COLS - 1) * gap) / CLASSIC_BRICK_COLS;
  const s = g.sideProfile();
  assert(s.colW === wantW,
    `column width must be derived from the widened inset (${wantW}), got ${s.colW}`);
  assert(s.colW > 0 && s.colW < ((CLASSIC_W * SCALE - 2 * 24 - (CLASSIC_BRICK_COLS - 1) * gap) / CLASSIC_BRICK_COLS),
    `the widened inset must shrink the bricks, got ${s.colW}`);
});

// ================================================================
// AC1+AC2 (alleyway): the portrait 5-col arena gets the same
// widened inset, stays symmetric, and its wide columns remain
// balanced (no crowding)
// ================================================================
check("alleyway: BRICK_SIDE_MARGIN is the widened named value (40 canvas px) in the portrait arena", () => {
  const g = boot(400, 700, { [KEY]: '"alleyway"' });
  g.start();
  assert(g.state() === "playing", `setup: run started, state=${g.state()}`);
  assert(g.q("runMode") === "alleyway",
    `setup: the persisted alleyway selection must drive the run, runMode=${g.q("runMode")}`);
  assert(g.q("BRICK_SIDE_MARGIN") === WIDE_INSET,
    `the named side inset must be the widened ${WIDE_INSET} canvas px in alleyway too, got ${g.q("BRICK_SIDE_MARGIN")}`);
});

check("alleyway: the 5-col field sits one widened inset from both walls and is symmetric", () => {
  const g = boot(400, 700, { [KEY]: '"alleyway"' });
  g.start();
  assert(g.q("canvas.width") === ALLEYWAY_W * SCALE,
    `setup: portrait backing store, got ${g.q("canvas.width")}`);
  const s = g.sideProfile();
  assert(s.leftGap === WIDE_INSET,
    `the leftmost brick must start at the widened inset ${WIDE_INSET}, got ${s.leftGap}`);
  assert(s.rightGap === WIDE_INSET,
    `the rightmost brick must end at the widened inset ${WIDE_INSET} from the right wall, got ${s.rightGap}`);
  assert(s.leftGap === s.rightGap,
    `the portrait field must be symmetric (left ${s.leftGap} != right ${s.rightGap})`);
});

check("alleyway: 5 columns unchanged; the wide columns remain balanced (inset < column width, no crowding)", () => {
  const g = boot(400, 700, { [KEY]: '"alleyway"' });
  g.start();
  assert(g.q("BRICK_COLS") === ALLEYWAY_BRICK_COLS,
    `BRICK_COLS must stay the named ${ALLEYWAY_BRICK_COLS}, got ${g.q("BRICK_COLS")}`);
  assert(g.q("BRICK_ROWS") === ALLEYWAY_BRICK_ROWS,
    `BRICK_ROWS must stay the named ${ALLEYWAY_BRICK_ROWS}, got ${g.q("BRICK_ROWS")}`);
  const gap = g.q("BRICK_GAP");
  const wantW = (ALLEYWAY_W * SCALE - 2 * WIDE_INSET - (ALLEYWAY_BRICK_COLS - 1) * gap) / ALLEYWAY_BRICK_COLS;
  const s = g.sideProfile();
  assert(s.colW === wantW,
    `portrait column width must derive from the widened inset (${wantW}), got ${s.colW}`);
  assert(s.colW > WIDE_INSET,
    `the 5 wide columns must stay wider than the inset so the portrait field reads balanced, got ${s.colW} vs ${WIDE_INSET}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
