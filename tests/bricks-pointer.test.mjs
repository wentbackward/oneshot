#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html pointer steering outside the stage rect
// (ticket #91): a pointer whose position falls OUTSIDE the stage's
// fitted bounding rect must HOLD the paddle (no edge-pin), and every
// pointer event must move the paddle at most POINTER_MAX_STEP,
// inside the rect too. Supersedes the ticket #40 edge-clamp.
//
// Same harness style as tests/bricks-paddle.test.mjs: runs the REAL
// <script> from bricks.html in a sandboxed vm context with stubbed
// window/document/canvas/DOM elements. Frames are driven through the
// captured requestAnimationFrame callback; mouse/touch events are
// dispatched into the recorded WINDOW listeners. No network, no
// external services.
//
// The canvas stub answers getBoundingClientRect() from a mutable
// rect object (defaults to the stage filling the boot viewport);
// setRect() narrows/moves it to simulate a letterboxed fit.
//
// Run: node tests/bricks-pointer.test.mjs
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
function assertClose(actual, expected, tol, msg) {
  const diff = Math.abs(actual - expected);
  if (!Number.isFinite(diff) || diff > tol) {
    throw new Error(`${msg} (got ${actual}, want ${expected} ± ${tol})`);
  }
}

// A DOM element stub: records style writes, text, listeners and
// child nodes.
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

// Boot a fresh copy of the game on a width×height viewport. The
// canvas stub records CSS style writes and answers
// getBoundingClientRect() from a mutable rect object that defaults
// to a stage filling the boot viewport — setRect() narrows it to a
// letterboxed fit.
function boot(width = 960, height = 600) {
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    rect: { left: 0, top: 0, width, height },
    listeners: {},
    getContext: () => makeCtx(),
    getBoundingClientRect: () => canvas.rect,
    addEventListener(type, cb) {
      (this.listeners[type] ??= []).push(cb);
    },
  };
  const els = {
    game: canvas,
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
    lives: makeEl("lives"),
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
      listeners: winListeners,
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
  const fireWin = (type, ev) => {
    for (const cb of winListeners[type] ?? []) cb(ev);
  };
  const q = (expr) => vm.runInContext(expr, context);
  // An omitted clientY sits at the rect's vertical midline (inside
  // the rect) — a cursor dragged at mid-height.
  const midY = () => canvas.rect.top + canvas.rect.height / 2;
  return {
    els,
    canvas,
    win: sandbox.window,
    q,
    tick,
    setRect(parts) {
      Object.assign(canvas.rect, parts);
    },
    paddleX: () => q("typeof paddle === 'undefined' ? NaN : paddle.x"),
    // Park the paddle at an exact x, then any single event within
    // the cap lands deterministically.
    park(x) {
      q("paddle.x = " + x + ";");
    },
    cap: () => q("typeof POINTER_MAX_STEP === 'undefined' ? NaN : POINTER_MAX_STEP"),
    mouseMove(clientX, clientY) {
      fireWin("mousemove", {
        clientX,
        clientY: clientY === undefined ? midY() : clientY,
      });
    },
    touchDrag(clientX, clientY) {
      fireWin("touchmove", {
        touches: [{ clientX, clientY: clientY === undefined ? midY() : clientY }],
        preventDefault() {},
      });
    },
  };
}

const start = (g) => {
  g.els["btn-start"].click();
  g.tick(1);
};

// The boot stage: 960 logical px × CANVAS_SCALE 2 = 1920 canvas px;
// a pointer at clientX c over the full-viewport rect maps to 2c.
const FULL_RECT = { left: 0, top: 0, width: 960, height: 600 };

// ================================================================
// The cap knob: a named top-level `var`, console-retunable, whose
// default is ~1.5× the keyboard paddle's per-frame travel
// (PADDLE_SPEED / 60).
// ================================================================
check("POINTER_MAX_STEP is a named top-level numeric var, defaulting to 1.5× the keyboard per-frame travel (18 px)", () => {
  const g = boot(960, 600);
  const cap = g.cap();
  assert(g.q("typeof POINTER_MAX_STEP") === "number",
    `POINTER_MAX_STEP must be a top-level numeric var, got ${g.q("typeof POINTER_MAX_STEP")}`);
  assert(cap > 0 && Number.isFinite(cap), `the cap must be positive and finite, got ${cap}`);
  assert(cap === 1.5 * (g.q("PADDLE_SPEED") / 60),
    `the default cap must be 1.5× PADDLE_SPEED/60 (${1.5 * (g.q("PADDLE_SPEED") / 60)}), got ${cap}`);
  assert(cap === 18, `with the shipped PADDLE_SPEED the cap must be 18 px, got ${cap}`);
});

// ================================================================
// Criterion 1: an in-rect pointer follows the paddle through the
// rect mapping, still clamped to the field — the follow rule is
// unchanged; only the per-event step is now capped.
// ================================================================
check("AC1: an in-rect pointer steers the paddle to the rect-mapped cursor x (exact, within the cap)", () => {
  const g = boot(960, 600);
  start(g);
  assert(g.canvas.rect.left === FULL_RECT.left, "sanity: the boot rect fills the viewport");
  g.park(955);
  g.mouseMove(485); // maps to (485/960)·1920 = 970, 15 px away — under the cap
  assertClose(g.paddleX(), 970, 0.01,
    `an in-rect mousemove at clientX 485 must land the paddle at 970, got ${g.paddleX()}`);
});

check("AC1: a cursor at the rect's left edge still reaches the left wall — full wall-to-wall reach is preserved", () => {
  const g = boot(960, 600);
  start(g);
  g.setRect(FULL_RECT);
  g.park(g.q("paddleW / 2") + 5); // 65: just off the left wall
  g.mouseMove(FULL_RECT.left); // maps to 0 → clamps to the wall
  assert(g.paddleX() === g.q("paddleW / 2"),
    `a cursor at the rect's left edge must bring the paddle to the left wall, got ${g.paddleX()}`);
});

// ================================================================
// Criterion 2: a pointer OUTSIDE the rect (left, right, above,
// below, including the deep letterbox bars) must NOT steer — the
// paddle HOLDS its last position across subsequent frames instead
// of pinning to the nearest edge (supersedes #40's edge-clamp).
// ================================================================
check("AC2: a pointer left of the rect holds the paddle — no edge-pin, across subsequent frames", () => {
  const g = boot(960, 600);
  start(g);
  // Letterboxed stage: a 480×300 rect centred in a wider viewport.
  g.setRect({ left: 240, top: 0, width: 480, height: 300 });
  const x0 = g.paddleX();
  assert(x0 === 960, `sanity: the paddle boots centred, got ${x0}`);
  g.mouseMove(-10000); // deep in the left letterbox bar
  g.mouseMove(239); // 1 px short of the rect's left edge
  g.tick(10); // in-range play frames
  assert(g.paddleX() === x0,
    `a pointer left of the rect must hold the paddle at ${x0}, got ${g.paddleX()}`);
  assert(g.paddleX() !== g.q("paddleW / 2"),
    `the paddle must NOT be pinned to the left wall, got ${g.paddleX()}`);
});

check("AC2: a pointer right of the rect holds the paddle — no edge-pin", () => {
  const g = boot(960, 600);
  start(g);
  g.setRect({ left: 240, top: 0, width: 480, height: 300 });
  const x0 = g.paddleX();
  g.mouseMove(721); // 1 px past the rect's right edge
  g.mouseMove(10000); // deep in the right letterbox bar
  g.tick(10);
  assert(g.paddleX() === x0,
    `a pointer right of the rect must hold the paddle at ${x0}, got ${g.paddleX()}`);
  assert(g.paddleX() !== g.q("canvas.width - paddleW / 2"),
    `the paddle must NOT be pinned to the right wall, got ${g.paddleX()}`);
});

check("AC2: a pointer above or below the rect (the vertical letterbox bars) holds the paddle", () => {
  const g = boot(960, 600);
  start(g);
  g.setRect({ left: 240, top: 100, width: 480, height: 300 });
  const x0 = g.paddleX();
  const midX = 240 + 480 / 2; // 480: inside the rect horizontally
  g.mouseMove(midX, 99); // 1 px above the rect
  g.mouseMove(midX, -10000); // deep in the top letterbox bar
  g.mouseMove(midX, 401); // 1 px below the rect
  g.mouseMove(midX, 10000); // deep in the bottom letterbox bar
  g.tick(10);
  assert(g.paddleX() === x0,
    `a pointer above/below the rect must hold the paddle at ${x0}, got ${g.paddleX()}`);
});

check("AC2: the containment test is inclusive on all four edges — a pointer exactly ON a rect edge still steers", () => {
  const g = boot(960, 600);
  start(g);
  g.setRect(FULL_RECT);
  const cap = g.cap();
  g.park(950);
  g.mouseMove(FULL_RECT.left, 300); // exactly on the left edge → target 0, capped step
  assert(g.paddleX() === 950 - cap,
    `a pointer on the left edge is inside: the paddle must step ${cap} px left, got ${g.paddleX()}`);
  g.park(950);
  g.mouseMove(FULL_RECT.left + FULL_RECT.width, 300); // exactly on the right edge → target 1920, capped step
  assert(g.paddleX() === 950 + cap,
    `a pointer on the right edge is inside: the paddle must step ${cap} px right, got ${g.paddleX()}`);
  g.park(950);
  g.mouseMove(480, FULL_RECT.top); // exactly on the top edge → target 960
  assert(g.paddleX() === 960,
    `a pointer on the top edge is inside: the paddle must land at 960, got ${g.paddleX()}`);
  g.park(950);
  g.mouseMove(480, FULL_RECT.top + FULL_RECT.height); // exactly on the bottom edge → target 960
  assert(g.paddleX() === 960,
    `a pointer on the bottom edge is inside: the paddle must land at 960, got ${g.paddleX()}`);
});

check("AC2: when the pointer re-enters the rect, following resumes immediately", () => {
  const g = boot(960, 600);
  start(g);
  g.park(960);
  g.mouseMove(-5000); // outside: holds at 960
  assert(g.paddleX() === 960, `the outside event must hold the paddle at 960, got ${g.paddleX()}`);
  g.mouseMove(475); // back inside: maps to 950, 10 px away — under the cap
  assertClose(g.paddleX(), 950, 0.01,
    `a pointer re-entering the rect must resume following and land at 950, got ${g.paddleX()}`);
});

// ================================================================
// Criterion 3: a single pointer event may move the paddle AT MOST
// POINTER_MAX_STEP — deterministically asserted, inside the rect,
// in both directions; the cap is the named var and is
// console-retunable.
// ================================================================
check("AC3: one event landing far inside the rect moves the paddle AT MOST the cap, toward the cursor (left)", () => {
  const g = boot(960, 600);
  start(g);
  const cap = g.cap();
  g.park(960);
  g.mouseMove(100); // maps to 200: 760 px away, far beyond the cap
  assert(g.paddleX() === 960 - cap,
    `one event may move the paddle at most ${cap} px toward the cursor, got ${g.paddleX()} (want ${960 - cap})`);
  assert(g.paddleX() !== 200,
    `the paddle must NOT teleport to the cursor position, got ${g.paddleX()}`);
});

check("AC3: one event landing far inside the rect moves the paddle AT MOST the cap, toward the cursor (right)", () => {
  const g = boot(960, 600);
  start(g);
  const cap = g.cap();
  g.park(960);
  g.mouseMove(860); // maps to 1720: 760 px to the right
  assert(g.paddleX() === 960 + cap,
    `one event may move the paddle at most ${cap} px right, got ${g.paddleX()} (want ${960 + cap})`);
});

check("AC3: repeated far events step at most the cap per event and converge exactly on the cursor", () => {
  const g = boot(960, 600);
  start(g);
  const cap = g.cap();
  g.park(960);
  for (let i = 0; i < 5; i += 1) g.mouseMove(100); // still 760−5·cap away: full cap each
  assert(g.paddleX() === 960 - 5 * cap,
    `five far events must step exactly ${cap} px each (want ${960 - 5 * cap}), got ${g.paddleX()}`);
  for (let i = 0; i < 200; i += 1) g.mouseMove(100); // eventually converges
  assertClose(g.paddleX(), 200, 0.01,
    `sustained events must converge exactly on the cursor position 200, got ${g.paddleX()}`);
});

check("AC3: POINTER_MAX_STEP is console-retunable — raising it from the console lets one event make the full jump", () => {
  const g = boot(960, 600);
  start(g);
  g.park(960);
  g.q("POINTER_MAX_STEP = 100000;"); // console retune: lift the cap
  g.mouseMove(100); // maps to (100/960)·1920 = 200
  assertClose(g.paddleX(), 200, 0.01,
    `with the cap raised from the console the event must make the full jump to 200, got ${g.paddleX()}`);
});

// ================================================================
// Criterion 4: the touch path obeys the SAME rules — asserted
// through the same window-level touchmove handler: outside the
// rect holds, inside follows, and the per-event cap applies.
// ================================================================
check("AC4: touchmove outside the rect (horizontally) holds the paddle — same rule as mouse", () => {
  const g = boot(960, 600);
  start(g);
  g.setRect({ left: 240, top: 100, width: 480, height: 300 });
  const x0 = g.paddleX();
  g.touchDrag(239, 250); // 1 px left of the rect
  g.touchDrag(10000, 250); // deep in the right letterbox bar
  g.tick(5);
  assert(g.paddleX() === x0,
    `touches left of / right of the rect must hold the paddle at ${x0}, got ${g.paddleX()}`);
});

check("AC4: touchmove above/below the rect holds the paddle — same rule as mouse", () => {
  const g = boot(960, 600);
  start(g);
  g.setRect({ left: 240, top: 100, width: 480, height: 300 });
  const x0 = g.paddleX();
  g.touchDrag(480, 99); // 1 px above the rect
  g.touchDrag(480, 401); // 1 px below the rect
  g.tick(5);
  assert(g.paddleX() === x0,
    `touches above/below the rect must hold the paddle at ${x0}, got ${g.paddleX()}`);
});

check("AC4: an in-rect touch follows, capped per event, exactly like mouse", () => {
  const g = boot(960, 600);
  start(g);
  g.setRect({ left: 240, top: 100, width: 480, height: 300 });
  const cap = g.cap();
  g.park(960);
  g.touchDrag(250, 250); // maps to ((250−240)/480)·1920 = 40: 920 px away
  assert(g.paddleX() === 960 - cap,
    `an in-rect touch far from the paddle must step exactly ${cap} px left, got ${g.paddleX()}`);
  g.touchDrag(360, 250); // maps to 480: still 462 px away
  assert(g.paddleX() === 960 - 2 * cap,
    `the next in-rect touch must step another ${cap} px (want ${960 - 2 * cap}), got ${g.paddleX()}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
