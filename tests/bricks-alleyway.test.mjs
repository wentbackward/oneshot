#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html ALLEYWAY mode: portrait 480×800 arena
// with its own level patterns (ticket #76)
//
// Same harness style as the sibling bricks-*.test.mjs suites: the
// REAL <script> from bricks.html runs in a sandboxed vm context
// with stubbed window/document/localStorage/requestAnimationFrame
// and DOM element stubs (including the third mode button,
// #mode-alleyway). `random` is pinned at boot so a capsule can
// never drop by chance mid-test; window pointer events are
// dispatched synthetically through the recorded listeners. No
// network, no external services, no wall clock or sleeps.
//
// Coverage against the ticket's acceptance criteria:
//   AC1 — persisted alleyway boot → selection shown; run start →
//         backing store 480×800×SCALE, CSS fit and grid 5×10
//         portrait, paddle clamped to the portrait width, ball
//         bounce rectangle = the portrait field
//   AC2 — serve → wall bounce → level clear frame-sequence walks
//         the portrait pattern table; level N ↔ Nth portrait pattern
//   AC3 — classic run regression (960×600, 5 rows × 10 cols) and
//         alleyway → menu → classic restores everything (no residue)
//   AC4 — pointer mapping through the fitted portrait rect: right
//         edge clientX → paddle at the right wall, not 960-space
//   AC5 — (structure) the table's geometry is named, the pattern
//         table is a SEPARATE portrait table, and every pattern is
//         provably clearable (flood-fill from the bottom)
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
const ALLEYWAY_W = 480;
const ALLEYWAY_H = 800;
const ALLEYWAY_BRICK_ROWS = 10;
const ALLEYWAY_BRICK_COLS = 5;
const CLASSIC_W = 960;
const CLASSIC_H = 600;
const SCALE = 2;

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

// Boot a fresh copy of the game on a width×height viewport.
// initialStore seeds the backing object of the recording
// localStorage stub; pass a previous boot's `store` to simulate a
// page reload onto the same origin's storage.
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
  // Pin the mutable random hook (like every sibling suite):
  // random() => 1 makes `random() >= dropRate` always true, so a
  // destroyed brick can never release an unplanned capsule.
  vm.runInContext("random = () => 1;", context);

  let nowMs = 0;
  const FRAME_MS = 1000 / 60;
  function tick(n = 1) {
    for (let i = 0; i < n; i += 1) {
      nowMs += FRAME_MS;
      rafCb(nowMs);
    }
  }
  function winDispatch(type, ev) {
    for (const cb of winListeners[type] ?? []) cb(ev);
  }
  const q = (expr) => vm.runInContext(expr, context);
  return {
    canvas,
    els,
    q,
    tick,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    store,
    storage,
    win: { dispatch: winDispatch },
  };
}

// The three mode option button stubs for a booted game, keyed by mode.
const opts = (g) => ({
  classic: g.els["mode-classic"],
  exciting: g.els["mode-exciting"],
  alleyway: g.els["mode-alleyway"],
});
const isMarked = (el) => el.className.includes("selected");
const markedCount = (g) => Object.values(opts(g)).filter(isMarked).length;

// The raw #screen-start section source, for the static-HTML checks.
const startSection = (() => {
  const m = html.match(/<section class="screen" id="screen-start">([\s\S]*?)<\/section>/);
  if (!m) throw new Error("#screen-start section not found in bricks.html");
  return m[1];
})();

// Drain the live level (every breakable brick) through the game's
// own destroyBrick(), stopping the instant the clear advances the
// level so the loop never touches the freshly spawned board.
function drainLevel(g) {
  const startLevel = g.q("level");
  g.q(`(function () {
    for (var i = 0; i < bricks.length; i += 1) {
      if (bricks[i].active && !bricks[i].unbreakable) {
        destroyBrick(i);
        if (level !== ${startLevel}) break; // the clear advanced us
      }
    }
  })()`);
  assert(g.q("level") === startLevel + 1,
    `draining the level must advance it to ${startLevel + 1}, got ${g.q("level")}`);
}
const fixedCount = (g) =>
  g.q("bricks.filter(function (b) { return b.active && b.unbreakable; }).length");

// Flood-fill clearability oracle for a pattern table: the ball
// enters the field from BELOW, so walk 4-connected cells from the
// virtual row underneath the grid, treating every non-'X' cell as
// passable (breakable tiers die, fixed bricks do not move). Every
// breakable cell must lie in the visited region or the level could
// never clear.
function patternIsClearable(pattern, rows, cols) {
  const seen = new Set();
  const queue = [];
  for (let c = 0; c < cols; c += 1) {
    const key = `${rows}:${c}`;
    seen.add(key);
    queue.push([rows, c]);
  }
  while (queue.length > 0) {
    const [r, c] = queue.pop();
    const deltas = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dr, dc] of deltas) {
      const nr = r + dr;
      const nc = c + dc;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      if (pattern[nr].charAt(nc) === "X") continue;
      const key = `${nr}:${nc}`;
      if (!seen.has(key)) {
        seen.add(key);
        queue.push([nr, nc]);
      }
    }
  }
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const ch = pattern[r].charAt(c);
      if (ch !== "." && ch !== "X" && !seen.has(`${r}:${c}`)) return false;
    }
  }
  return true;
}

// ================================================================
// Static HTML: the third mode button in the selector row
// ================================================================
check("the start screen holds exactly three data-mode nodes — classic, exciting, alleyway — with the alleyway node as #mode-alleyway", () => {
  const values = [...startSection.matchAll(/data-mode="([^"]*)"/g)].map((m) => m[1]);
  const sorted = [...values].sort();
  assert(JSON.stringify(sorted) === JSON.stringify(["alleyway", "classic", "exciting"]),
    `the three data-mode values must be classic, exciting and alleyway (once each), got ${JSON.stringify(values)}`);
  const btn = startSection.match(/<button\b[^>]*id="mode-alleyway"[^>]*data-mode="alleyway"[^>]*>|<button\b[^>]*data-mode="alleyway"[^>]*id="mode-alleyway"[^>]*>/);
  assert(btn, "the alleyway option must be a <button id=\"mode-alleyway\" data-mode=\"alleyway\"> in #screen-start");
});

check("the static default-selection mark sits on the classic button only (alleyway not pre-marked)", () => {
  const tags = [...startSection.matchAll(/<button\b[^>]*data-mode="([^"]*)"[^>]*>/g)];
  assert(tags.length === 3, `expected 3 option buttons, found ${tags.length}`);
  for (const t of tags) {
    const marked = /class="[^"]*\bselected\b[^"]*"/.test(t[0]);
    if (t[1] === "classic") {
      assert(marked, `the classic button must be marked selected in the static markup, got: ${t[0]}`);
    } else {
      assert(!marked, `the ${t[1]} button must not be pre-marked selected, got: ${t[0]}`);
    }
  }
});

// ================================================================
// Selection + persistence (brickbreaker.mode = classic|exciting|alleyway)
// ================================================================
check("a persisted 'alleyway' boot restores the selection: only the alleyway button is marked", () => {
  const g = boot(960, 600, { [KEY]: '"alleyway"' });
  assert(g.state() === "start", `boot must land on the start screen, state is ${g.state()}`);
  assert(g.q("selectedMode") === "alleyway",
    `the stored alleyway choice must load at boot, got ${g.q("selectedMode")}`);
  const o = opts(g);
  assert(isMarked(o.alleyway) && !isMarked(o.classic) && !isMarked(o.exciting),
    `only the alleyway button may be marked, classic=${o.classic.className} exciting=${o.exciting.className} alleyway=${o.alleyway.className}`);
});

check("clicking the third button persists exactly one JSON entry \"alleyway\" and moves the mark to it alone", () => {
  const g = boot(960, 600);
  opts(g).alleyway.click();
  assert(g.q("selectedMode") === "alleyway",
    `the click must switch the mode to alleyway, got ${g.q("selectedMode")}`);
  assert(markedCount(g) === 1 && isMarked(opts(g).alleyway),
    `exactly one mode button may be marked, and it must be alleyway, got ${markedCount(g)}`);
  assert(JSON.stringify(g.storage.writes) === JSON.stringify([[KEY, '"alleyway"']]),
    `exactly one setItem of ${KEY}="alleyway" must fire, writes were ${JSON.stringify(g.storage.writes)}`);
});

check("a simulated reload (fresh vm sandbox, same backing store) round-trips the alleyway choice", () => {
  const before = boot(960, 600);
  opts(before).alleyway.click();
  const after = boot(960, 600, before.store);
  assert(after.q("selectedMode") === "alleyway",
    `the reloaded session must restore alleyway, got ${after.q("selectedMode")}`);
  assert(markedCount(after) === 1 && isMarked(opts(after).alleyway),
    `the reload must re-mark only the alleyway button`);
});

// ================================================================
// Acceptance 1 — run start: portrait backing store, grid, paddle,
// bounce rectangle; geometry switches at RUN START, not at boot
// ================================================================
check("persisted-alleyway boot (before any run) still holds the landscape 960×600 stage — geometry switches at run start", () => {
  const g = boot(400, 700, { [KEY]: '"alleyway"' });
  assert(g.state() === "start", `setup: booted on the start screen`);
  assert(g.q("GAME_W") === CLASSIC_W && g.q("GAME_H") === CLASSIC_H,
    `the start screen keeps the landscape stage, got ${g.q("GAME_W")}×${g.q("GAME_H")}`);
  assert(g.canvas.width === CLASSIC_W * SCALE && g.canvas.height === CLASSIC_H * SCALE,
    `pre-run backing store must be landscape ${CLASSIC_W * SCALE}×${CLASSIC_H * SCALE}, got ${g.canvas.width}×${g.canvas.height}`);
});

check("starting the run switches the stage to ALLEYWAY_W×ALLEYWAY_H (480×800) with a 480×800×SCALE backing store", () => {
  const g = boot(400, 700, { [KEY]: '"alleyway"' });
  g.els["btn-start"].click();
  assert(g.state() === "playing", `the start button must begin the run, state is ${g.state()}`);
  assert(g.q("runMode") === "alleyway",
    `beginRun must snapshot the selected mode, runMode is ${g.q("runMode")}`);
  const w = g.q("GAME_W");
  const h = g.q("GAME_H");
  assert(w === ALLEYWAY_W, `GAME_W must be the named ALLEYWAY_W (${ALLEYWAY_W}), got ${w}`);
  assert(h === ALLEYWAY_H, `GAME_H must be the named ALLEYWAY_H (${ALLEYWAY_H}), got ${h}`);
  assert(g.q("ALLEYWAY_W") === ALLEYWAY_W && g.q("ALLEYWAY_H") === ALLEYWAY_H,
    `the named vars ALLEYWAY_W/ALLEYWAY_H must be ${ALLEYWAY_W}/${ALLEYWAY_H}, got ${g.q("ALLEYWAY_W")}/${g.q("ALLEYWAY_H")}`);
  assert(g.canvas.width === ALLEYWAY_W * SCALE,
    `the backing store width must be ALLEYWAY_W × SCALE (${ALLEYWAY_W * SCALE}), got ${g.canvas.width}`);
  assert(g.canvas.height === ALLEYWAY_H * SCALE,
    `the backing store height must be ALLEYWAY_H × SCALE (${ALLEYWAY_H * SCALE}), got ${g.canvas.height}`);
});

check("the CSS letterbox fit follows the portrait dimensions (400×700 viewport → 400×667 fitted stage)", () => {
  const g = boot(400, 700, { [KEY]: '"alleyway"' });
  g.els["btn-start"].click();
  const fit = Math.min(400 / ALLEYWAY_W, 700 / ALLEYWAY_H, 1);
  const wPx = Math.round(ALLEYWAY_W * fit) + "px";
  const hPx = Math.round(ALLEYWAY_H * fit) + "px";
  assert(g.canvas.style.width === wPx,
    `the fitted CSS width must be ${wPx} for a portrait stage, got ${g.canvas.style.width}`);
  assert(g.canvas.style.height === hPx,
    `the fitted CSS height must be ${hPx} for a portrait stage, got ${g.canvas.style.height}`);
  assert(hPx !== wPx, `the portrait fit must NOT be square-like 16:10 reuse, got ${wPx}×${hPx}`);
});

check("the alleyway brick grid is 5 columns × 10 rows on the 50-cell pool with portrait layout math", () => {
  const g = boot(400, 700, { [KEY]: '"alleyway"' });
  g.els["btn-start"].click();
  assert(g.q("BRICK_ROWS") === ALLEYWAY_BRICK_ROWS,
    `BRICK_ROWS must be the named ALLEYWAY_BRICK_ROWS (${ALLEYWAY_BRICK_ROWS}), got ${g.q("BRICK_ROWS")}`);
  assert(g.q("BRICK_COLS") === ALLEYWAY_BRICK_COLS,
    `BRICK_COLS must be the named ALLEYWAY_BRICK_COLS (${ALLEYWAY_BRICK_COLS}), got ${g.q("BRICK_COLS")}`);
  assert(g.q("ALLEYWAY_BRICK_ROWS") === ALLEYWAY_BRICK_ROWS && g.q("ALLEYWAY_BRICK_COLS") === ALLEYWAY_BRICK_COLS,
    `the named grid vars must be ${ALLEYWAY_BRICK_ROWS}/${ALLEYWAY_BRICK_COLS}, got ${g.q("ALLEYWAY_BRICK_ROWS")}/${g.q("ALLEYWAY_BRICK_COLS")}`);
  assert(g.q("bricks.length") === ALLEYWAY_BRICK_ROWS * ALLEYWAY_BRICK_COLS,
    `the pool must hold ${ALLEYWAY_BRICK_ROWS * ALLEYWAY_BRICK_COLS} cells, got ${g.q("bricks.length")}`);
  // Layout of pool cell (row 0, col 0) against the game's own vars.
  const bw = (g.canvas.width - 2 * g.q("BRICK_SIDE_MARGIN") - (ALLEYWAY_BRICK_COLS - 1) * g.q("BRICK_GAP")) / ALLEYWAY_BRICK_COLS;
  const b0 = g.q("bricks[0]");
  assert(b0.active === true, `cell (0,0) of the level-1 portrait pattern must be occupied, got active=${b0.active}`);
  assert(b0.x === g.q("BRICK_SIDE_MARGIN"), `brick (0,0).x must be BRICK_SIDE_MARGIN, got ${b0.x}`);
  assert(b0.y === g.q("BRICK_TOP_MARGIN"), `brick (0,0).y must be BRICK_TOP_MARGIN, got ${b0.y}`);
  assert(b0.w === bw, `brick (0,0).w must be the portrait column width ${bw}, got ${b0.w}`);
  assert(b0.w > g.q("BRICK_HEIGHT"), `portrait bricks (${b0.w}×${b0.h}) must read as wide corridor tiles, not a squeezed landscape row`);
  // Column mapping: pool index = row × BRICK_COLS + col (5-wide rows).
  const idx21 = 2 * ALLEYWAY_BRICK_COLS + 1; // row 2, col 1
  const b = g.q(`bricks[${idx21}]`);
  assert(b.x === g.q("BRICK_SIDE_MARGIN") + 1 * (bw + g.q("BRICK_GAP")),
    `brick (2,1).x must sit one column in, got ${b.x}`);
});

check("the paddle is clamped to the narrower portrait width: hard right bound = canvas.width − paddleW/2, inside 480 stage units", () => {
  const g = boot(400, 700, { [KEY]: '"alleyway"' });
  g.els["btn-start"].click();
  g.q("paddle.x = 1e9; clampPaddle();");
  const maxX = g.q("paddle.x");
  const expected = g.canvas.width - g.q("paddleW") / 2;
  assert(maxX === expected,
    `clampPaddle must pin the paddle to the right wall (${expected}), got ${maxX}`);
  assert(maxX + g.q("paddleW") / 2 <= g.q("GAME_W") * g.q("CANVAS_SCALE"),
    `the clamped paddle must not overshoot the portrait width in canvas px`);
  assert(maxX / g.q("CANVAS_SCALE") <= ALLEYWAY_W,
    `the clamped paddle centre must be within ${ALLEYWAY_W} stage units, got ${maxX / g.q("CANVAS_SCALE")}`);
});

check("the ball's bounce rectangle is the portrait field: a right-bound ball pins at canvas.width − R and flips, and a driven frame stays inside the portrait walls", () => {
  const g = boot(400, 700, { [KEY]: '"alleyway"' });
  g.els["btn-start"].click();
  // Direct probe of bounceWalls' constants on a throwaway circle.
  const probe = g.q(`(() => {
    const p = { x: canvas.width - BALL_RADIUS + 5, y: 400, vx: 100, vy: 0 };
    bounceWalls(p);
    return { x: p.x, vx: p.vx };
  })()`);
  assert(probe.x === g.canvas.width - g.q("BALL_RADIUS"),
    `the right wall must sit at canvas.width − R (${g.canvas.width - g.q("BALL_RADIUS")}), got ${probe.x}`);
  assert(probe.vx < 0, `the right-wall hit must flip vx negative, got ${probe.vx}`);
  // Driven frame: park the live ball 1px inside the wall, heading right.
  g.q(`(function () {
    var b = balls[0];
    b.attached = false;
    b.x = canvas.width - BALL_RADIUS - 1;
    b.y = 360; // inside the level-1 empty row band: no brick interference
    b.vx = 120;
    b.vy = 0;
  })()`);
  g.tick(); // prime the frame clock: the first frame after boot has dt=0
  g.tick(); // the driven frame
  const b = g.q("balls[0]");
  assert(b.x === g.canvas.width - g.q("BALL_RADIUS"),
    `after one frame the ball must be pinned to the portrait right wall, got x=${b.x}`);
  assert(b.vx < 0, `the frame bounce must reflect the ball inward, got vx=${b.vx}`);
});

// ================================================================
// Acceptance 2 — playthrough frame-sequence walks the PORTRAIT
// pattern table: level N maps to the Nth portrait pattern
// ================================================================
check("level 1 of an alleyway run serves the FIRST portrait pattern (its own table, not the landscape one)", () => {
  const g = boot(400, 700, { [KEY]: '"alleyway"' });
  g.els["btn-start"].click();
  assert(g.q("level") === 1, `the run must start on level 1, got ${g.q("level")}`);
  const table = JSON.parse(g.q("JSON.stringify(ALLEYWAY_LEVEL_PATTERNS)"));
  assert(Array.isArray(table) && table.length >= 2,
    `ALLEYWAY_LEVEL_PATTERNS must hold at least 2 portrait patterns, got ${table.length}`);
  const fixed = fixedCount(g);
  const expectedFixed = table[0].join("").split("").filter((ch) => ch === "X").length;
  assert(fixed === expectedFixed,
    `the live board must carry the first portrait pattern's ${expectedFixed} fixed bricks, got ${fixed}`);
  const left = g.q("bricksLeft");
  const expectedBreakable = table[0].join("").replace(/[.X]/g, "").length;
  assert(left === expectedBreakable,
    `bricksLeft must count the first pattern's ${expectedBreakable} breakables, got ${left}`);
  // And it must be a DIFFERENT board than the landscape level 1.
  const landscapeTable = JSON.parse(g.q("JSON.stringify(LEVEL_PATTERNS)"));
  const sameShape = table[0].length === landscapeTable[0][0].length &&
    JSON.stringify(table[0]) === JSON.stringify(landscapeTable[0]);
  assert(!sameShape, `portrait pattern 0 must not be a reuse of landscape pattern 0`);
});

check("serve → launch → wall bounce → clear: draining level 1 spawns the SECOND portrait pattern on level 2", () => {
  const g = boot(400, 700, { [KEY]: '"alleyway"' });
  g.els["btn-start"].click();
  // Beat 1 — the serve: one resting ball on the paddle.
  assert(g.q("balls[0].active === true && balls[0].attached === true"),
    `the run must open with one attached serve ball`);
  // Beat 2 — launch via the canvas click, then a wall bounce (AC2
  // frame sequence, driven deterministically).
  g.canvas.dispatch("click", {});
  assert(g.q("balls[0].attached === false && balls[0].vy < 0"),
    `the click must launch the ball upward`);
  g.q(`(function () {
    var b = balls[0];
    b.attached = false;
    b.x = canvas.width - BALL_RADIUS - 1;
    b.y = 360;
    b.vx = 120;
    b.vy = 0;
  })()`);
  g.tick(); // prime the frame clock: the first frame after boot has dt=0
  g.tick(); // the driven frame
  assert(g.q("balls[0].x") === g.canvas.width - g.q("BALL_RADIUS") && g.q("balls[0].vx") < 0,
    `the sequence frame must show a clean right-wall bounce`);
  // Beat 3 — clear the board through the game's own kill path.
  const table = JSON.parse(g.q("JSON.stringify(ALLEYWAY_LEVEL_PATTERNS)"));
  drainLevel(g);
  assert(g.q("level") === 2, `the cleared board must advance to level 2, got ${g.q("level")}`);
  const expectedFixed = table[1].join("").split("").filter((ch) => ch === "X").length;
  const expectedBreakable = table[1].join("").replace(/[.X]/g, "").length;
  assert(fixedCount(g) === expectedFixed,
    `level 2 must carry the second portrait pattern's ${expectedFixed} fixed bricks, got ${fixedCount(g)}`);
  assert(g.q("bricksLeft") === expectedBreakable,
    `level 2 must count ${expectedBreakable} breakables of the second pattern, got ${g.q("bricksLeft")}`);
  // A fresh serve re-parked after the advance.
  assert(g.q("balls[0].active === true && balls[0].attached === true"),
    `the level advance must re-serve an attached ball`);
});

check("level 3 cycles back to the FIRST portrait pattern (level N ↔ pattern (N−1) mod table length)", () => {
  const g = boot(400, 700, { [KEY]: '"alleyway"' });
  g.els["btn-start"].click();
  const table = JSON.parse(g.q("JSON.stringify(ALLEYWAY_LEVEL_PATTERNS)"));
  drainLevel(g); // 1 → 2
  drainLevel(g); // 2 → 3
  assert(g.q("level") === 3, `the second clear must advance to level 3, got ${g.q("level")}`);
  const expectedFixed = table[0].join("").split("").filter((ch) => ch === "X").length;
  const expectedBreakable = table[0].join("").replace(/[.X]/g, "").length;
  assert(fixedCount(g) === expectedFixed && g.q("bricksLeft") === expectedBreakable,
    `level 3 must replay the first portrait pattern (${expectedFixed} fixed / ${expectedBreakable} breakable), got ${fixedCount(g)}/${g.q("bricksLeft")}`);
});

// ================================================================
// Acceptance 3 — classic regression and no-residue restore
// ================================================================
check("a classic run is EXACTLY the legacy landscape: 960×600, 1920×1200 store, 5 rows × 10 cols, landscape pattern 0", () => {
  const g = boot(400, 700);
  g.els["btn-start"].click();
  assert(g.q("runMode") === "classic", `the default run must be classic, got ${g.q("runMode")}`);
  assert(g.q("GAME_W") === CLASSIC_W && g.q("GAME_H") === CLASSIC_H,
    `the classic stage must stay ${CLASSIC_W}×${CLASSIC_H}, got ${g.q("GAME_W")}×${g.q("GAME_H")}`);
  assert(g.canvas.width === CLASSIC_W * SCALE && g.canvas.height === CLASSIC_H * SCALE,
    `the classic backing store must stay ${CLASSIC_W * SCALE}×${CLASSIC_H * SCALE}, got ${g.canvas.width}×${g.canvas.height}`);
  assert(g.q("BRICK_ROWS") === 5 && g.q("BRICK_COLS") === 10,
    `the classic grid must stay 5 rows × 10 cols, got ${g.q("BRICK_ROWS")}×${g.q("BRICK_COLS")}`);
  assert(g.q("bricks.length") === 50, `the classic pool must stay 50 cells, got ${g.q("bricks.length")}`);
  const landscape = JSON.parse(g.q("JSON.stringify(LEVEL_PATTERNS)"));
  const expectedBreakable = landscape[0].join("").replace(/[.X]/g, "").length;
  assert(g.q("bricksLeft") === expectedBreakable,
    `the classic level 1 must count ${expectedBreakable} breakables, got ${g.q("bricksLeft")}`);
  const b10 = g.q("bricks[10]"); // row 1, col 0 of "AAAAAAAAAA/BBBBBBBBBB/..."
  assert(b10.active === true && b10.tier === 1,
    `classic brick (1,0) must be the B tier, got active=${b10.active} tier=${b10.tier}`);
  assert(b10.w === (g.canvas.width - 2 * g.q("BRICK_SIDE_MARGIN") - 9 * g.q("BRICK_GAP")) / 10,
    `classic bricks must keep the 10-column landscape width math`);
});

check("alleyway run → menu → classic run: stage, grid, dimensions and paddle reset with NO residue", () => {
  const g = boot(400, 700, { [KEY]: '"alleyway"' });
  g.els["btn-start"].click();
  assert(g.q("GAME_W") === ALLEYWAY_W && g.q("BRICK_COLS") === ALLEYWAY_BRICK_COLS,
    `setup: the first run must be the portrait alleyway stage`);
  g.q("paddle.x = 1e9; clampPaddle();"); // park the paddle at the portrait wall
  g.q("quitToMenu()");
  assert(g.state() === "start", `quitToMenu must return to the start screen, state is ${g.state()}`);
  opts(g).classic.click();
  assert(g.q("selectedMode") === "classic", `the reselect must switch back to classic, got ${g.q("selectedMode")}`);
  g.els["btn-start"].click();
  assert(g.q("runMode") === "classic", `the next run must be classic, got ${g.q("runMode")}`);
  assert(g.q("GAME_W") === CLASSIC_W && g.q("GAME_H") === CLASSIC_H,
    `the restored stage must be ${CLASSIC_W}×${CLASSIC_H}, got ${g.q("GAME_W")}×${g.q("GAME_H")}`);
  assert(g.canvas.width === CLASSIC_W * SCALE && g.canvas.height === CLASSIC_H * SCALE,
    `the restored backing store must be ${CLASSIC_W * SCALE}×${CLASSIC_H * SCALE}, got ${g.canvas.width}×${g.canvas.height}`);
  assert(g.q("BRICK_ROWS") === 5 && g.q("BRICK_COLS") === 10,
    `the restored grid must be 5 rows × 10 cols, got ${g.q("BRICK_ROWS")}×${g.q("BRICK_COLS")}`);
  assert(g.q("bricksLeft") === 50,
    `the restored classic level 1 must be the full 50-breakable landscape wall, got ${g.q("bricksLeft")}`);
  // Paddle width reset: no widen/sticky/multiplier residue from the run.
  assert(g.q("paddleW") === g.q("basePaddleW") && g.q("paddleW") === g.q("DIFFICULTY")[g.q("selectedDifficulty")].paddleWidth,
    `the restored run's paddle must sit at its base width, got ${g.q("paddleW")}`);
  assert(g.q("expandUntil") === -1 && g.q("stickyUntil") === -1 && g.q("multUntil") === -1,
    `no timed effect may carry across the menu return`);
  assert(g.q("paddle.x") >= g.q("paddleW") / 2 && g.q("paddle.x") <= g.canvas.width - g.q("paddleW") / 2,
    `the paddle must sit inside the restored landscape field`);
});

// ================================================================
// Acceptance 4 — pointer mapping through the portrait rect
// ================================================================
check("pointer at the RIGHT EDGE of the portrait-fitted canvas lands the paddle at the right wall (rect-mapped, not 960-space)", () => {
  const g = boot(400, 700, { [KEY]: '"alleyway"' });
  g.els["btn-start"].click();
  // The fitted CSS rect the game itself computed (400×700 viewport).
  const fit = Math.min(400 / ALLEYWAY_W, 700 / ALLEYWAY_H, 1);
  const rw = Math.round(ALLEYWAY_W * fit);
  const rh = Math.round(ALLEYWAY_H * fit);
  assert(g.canvas.style.width === rw + "px" && g.canvas.style.height === rh + "px",
    `setup: the fitted rect must be ${rw}×${rh}, got ${g.canvas.style.width}×${g.canvas.style.height}`);
  g.canvas.rect = { left: 0, top: 0, width: rw, height: rh };

  g.win.dispatch("mousemove", { clientX: rw }); // right edge
  const rightEdge = g.q("paddle.x");
  assert(rightEdge === g.canvas.width - g.q("paddleW") / 2,
    `the right-edge clientX must map to the full-rect fraction and pin the paddle at the portrait right wall (${g.canvas.width - g.q("paddleW") / 2}), got ${rightEdge}`);

  g.win.dispatch("mousemove", { clientX: rw / 2 }); // centre
  assert(g.q("paddle.x") === g.canvas.width / 2,
    `the rect centre must map to the backing-store centre (${g.canvas.width / 2}), got ${g.q("paddle.x")}`);

  g.win.dispatch("mousemove", { clientX: -100 }); // off-field left
  assert(g.q("paddle.x") === g.q("paddleW") / 2,
    `an off-field position must clamp to the nearest portrait edge (${g.q("paddleW") / 2}), got ${g.q("paddle.x")}`);
});

// ================================================================
// Structure — named geometry, separate portrait table, clearability,
// classic economy
// ================================================================
check("ALLEYWAY_LEVEL_PATTERNS is a SEPARATE table of ≥2 portrait patterns: 10 rows × 5 cells, valid grammar, every pattern uses A/B/C and X", () => {
  const g = boot(960, 600);
  const table = JSON.parse(g.q("JSON.stringify(ALLEYWAY_LEVEL_PATTERNS)"));
  assert(Array.isArray(table) && table.length >= 2,
    `the portrait table must hold at least 2 distinct patterns, got ${table.length}`);
  const shapes = new Set();
  for (const pattern of table) {
    assert(Array.isArray(pattern) && pattern.length === ALLEYWAY_BRICK_ROWS,
      `every portrait pattern must have exactly ${ALLEYWAY_BRICK_ROWS} rows, got ${pattern.length}`);
    for (const line of pattern) {
      assert(typeof line === "string" && line.length === ALLEYWAY_BRICK_COLS && /^[.ABCX]+$/.test(line),
        `every portrait row must be ${ALLEYWAY_BRICK_COLS} cells of ./A/B/C/X, got ${JSON.stringify(line)}`);
    }
    const joined = pattern.join("");
    for (const ch of ["A", "B", "C", "X"]) {
      assert(joined.includes(ch),
        `every portrait pattern must reuse the tier system, and this one lacks '${ch}': ${JSON.stringify(pattern)}`);
    }
    shapes.add(joined);
  }
  assert(shapes.size === table.length, `the portrait patterns must be pairwise distinct, got ${shapes.size} unique of ${table.length}`);
  const landscape = JSON.parse(g.q("JSON.stringify(LEVEL_PATTERNS)"));
  for (const p of table) {
    assert(!landscape.some((lp) => JSON.stringify(lp) === JSON.stringify(p)),
      `a portrait pattern must not be a copy of a landscape pattern`);
  }
});

check("every portrait pattern is clearable: a flood-fill from below the grid (X-impassable) reaches every breakable cell", () => {
  const g = boot(960, 600);
  const table = JSON.parse(g.q("JSON.stringify(ALLEYWAY_LEVEL_PATTERNS)"));
  table.forEach((pattern, i) => {
    assert(patternIsClearable(pattern, ALLEYWAY_BRICK_ROWS, ALLEYWAY_BRICK_COLS),
      `portrait pattern ${i} traps a breakable brick behind fixed bricks — the level could never clear: ${JSON.stringify(pattern)}`);
  });
});

check("alleyway runs the CLASSIC economy and rules: dropRate × 1.0, no exciting multiplier", () => {
  const g = boot(960, 600, { [KEY]: '"alleyway"' });
  assert(g.q("MODES").alleyway.dropFactor === 1.0,
    `the alleyway mode row must keep the classic drop factor 1.0, got ${g.q("MODES").alleyway.dropFactor}`);
  g.els["btn-start"].click();
  assert(g.q("dropRate") === g.q("POWERUP_DROP_RATE"),
    `the alleyway run's dropRate must be the preset rate itself (×1.0), got ${g.q("dropRate")} vs ${g.q("POWERUP_DROP_RATE")}`);
  assert(g.q("dropRate") !== g.q("POWERUP_DROP_RATE") * g.q("EXCITING_DROP_FACTOR"),
    `the alleyway economy must not inherit the exciting multiplier`);
});

check("mid-run mode clicks do not disturb the live run; the next run adopts the new stage", () => {
  const g = boot(960, 600, { [KEY]: '"alleyway"' });
  g.els["btn-start"].click();
  assert(g.q("GAME_W") === ALLEYWAY_W, `setup: the live run is portrait`);
  opts(g).classic.click();
  assert(g.q("selectedMode") === "classic", `the mid-run click must reselect classic`);
  assert(g.q("GAME_W") === ALLEYWAY_W && g.q("BRICK_COLS") === ALLEYWAY_BRICK_COLS,
    `a mid-run click must never resize a live run`);
  g.q("quitToMenu()");
  g.els["btn-start"].click();
  assert(g.q("GAME_W") === CLASSIC_W && g.q("BRICK_COLS") === 10,
    `the next run must adopt the classic landscape stage`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
