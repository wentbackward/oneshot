#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html pointer steering (ticket #95,
// redesigning the #91 rules): a pointer maps its clientX THROUGH
// the stage's fitted bounding rect onto the paddle's reachable
// range and the paddle is SET there in ONE event — instant 1:1
// positional tracking, no per-event displacement cap. Off the
// stage the paddle HUGS the corresponding wall (left/right of the
// rect → left/right wall; above/below → still tracks by the
// horizontal position). The #91 POINTER_MAX_STEP cap and the
// out-of-rect hold are GONE.
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
    "capsule-legend": makeEl("capsule-legend"),
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
  // An omitted clientY sits at the rect's vertical midline.
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
    // Park the paddle at an exact x so the next event's landing is
    // a pure function of the mapping.
    park(x) {
      q("paddle.x = " + x + ";");
    },
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
// The regression itself: the #91 per-event speed cap is GONE.
// ================================================================
check("the #91 POINTER_MAX_STEP cap knob no longer exists in the game", () => {
  const g = boot(960, 600);
  const kind = g.q("typeof POINTER_MAX_STEP");
  assert(kind === "undefined",
    `POINTER_MAX_STEP must be deleted with all its usages, got ${kind}`);
  assert(!html.includes("POINTER_MAX_STEP"),
    "no trace of POINTER_MAX_STEP may remain in bricks.html");
});

// ================================================================
// Criterion 1: responsive 1:1 tracking — an in-rect pointer's
// rect-mapped x is SET on the paddle in ONE event, however far
// away it is. No cap, no convergence walk.
// ================================================================
check("AC1: a FAR in-rect event lands the paddle at the rect-mapped cursor x in a SINGLE event (no cap, no crawl)", () => {
  const g = boot(960, 600);
  start(g);
  g.park(960); // centre — 760 px from the target
  g.mouseMove(100); // maps to (100/960)·1920 = 200
  assertClose(g.paddleX(), 200, 1e-9,
    `one in-rect event 760 px away must land the paddle at 200 in that same event, got ${g.paddleX()}`);
});

check("AC1: tracking is 1:1 across the whole reachable range — a sequence of in-rect events puts the paddle exactly under each cursor x", () => {
  const g = boot(960, 600);
  start(g);
  // Every sample maps into the paddle's reachable range
  // [paddleW/2, canvas.width − paddleW/2] = [60, 1860], so the
  // landing is the raw rect mapping, uncapped and unclamped.
  const samples = [31, 123, 480, 777, 920, 40, 900];
  for (const c of samples) {
    g.mouseMove(c); // maps to (c/960)·1920
    assertClose(g.paddleX(), (c / 960) * g.canvas.width, 1e-9,
      `an in-rect event at clientX ${c} must sit the paddle exactly at ${(c / 960) * g.canvas.width}, got ${g.paddleX()}`);
  }
});

check("AC1: an in-rect event at the rect's left rim clamps to the left wall and its right-rim twin to the right wall (rim reach, both walls)", () => {
  const g = boot(960, 600);
  start(g);
  g.setRect(FULL_RECT);
  g.park(g.q("canvas.width - paddleW / 2")); // far from the left wall
  g.mouseMove(FULL_RECT.left); // maps to 0 → clamps to the left wall
  assert(g.paddleX() === g.q("paddleW / 2"),
    `a cursor on the rect's left rim must land the paddle exactly on the left wall in one event, got ${g.paddleX()}`);
  g.park(g.q("paddleW / 2")); // far from the right wall
  g.mouseMove(FULL_RECT.left + FULL_RECT.width); // maps to 1920 → right wall
  assert(g.paddleX() === g.q("canvas.width - paddleW / 2"),
    `a cursor on the rect's right rim must land the paddle exactly on the right wall in one event, got ${g.paddleX()}`);
});

check("AC1: deterministic — repeating the same in-rect event lands the paddle at the same x every time", () => {
  const g = boot(960, 600);
  start(g);
  const seen = new Set();
  for (let i = 0; i < 3; i += 1) {
    g.park(960);
    g.mouseMove(100);
    assertClose(g.paddleX(), 200, 1e-9,
      `event #${i}: the landing must be the rect-mapped 200, got ${g.paddleX()}`);
    seen.add(g.paddleX());
  }
  assert(seen.size === 1,
    `every repetition must land bitwise on the same x, saw ${seen.size} distinct values`);
});

// ================================================================
// Criterion 2: wall-hug — a cursor LEFT or RIGHT of the stage rect
// (letterbox bar, HUD, off-window) sets the paddle to the matching
// wall instead of freezing it (the #91 hold) or crawling there
// (the #91 cap).
// ================================================================
check("AC2: a cursor LEFT of the stage rect hugs the LEFT wall — controllable, no freeze", () => {
  const g = boot(960, 600);
  start(g);
  // Letterboxed stage: a 480×300 rect centred in a wider viewport.
  g.setRect({ left: 240, top: 0, width: 480, height: 300 });
  g.park(1400); // somewhere mid-stage, far from the left wall
  g.mouseMove(239); // 1 px short of the rect's left edge
  g.tick(10); // in-range play frames: the hug must STICK
  assert(g.paddleX() === g.q("paddleW / 2"),
    `a cursor 1 px left of the rect must hug the left wall and hold it, got ${g.paddleX()}`);
  g.mouseMove(-10000); // deep in the left letterbox bar: still the wall
  assert(g.paddleX() === g.q("paddleW / 2"),
    `a cursor deep in the left letterbox must keep hugging the left wall, got ${g.paddleX()}`);
});

check("AC2: a cursor RIGHT of the stage rect hugs the RIGHT wall — controllable, no freeze", () => {
  const g = boot(960, 600);
  start(g);
  g.setRect({ left: 240, top: 0, width: 480, height: 300 });
  g.park(500); // somewhere mid-stage, far from the right wall
  g.mouseMove(721); // 1 px past the rect's right edge
  g.tick(10);
  assert(g.paddleX() === g.q("canvas.width - paddleW / 2"),
    `a cursor 1 px right of the rect must hug the right wall and hold it, got ${g.paddleX()}`);
  g.mouseMove(10000); // deep in the right letterbox bar: still the wall
  assert(g.paddleX() === g.q("canvas.width - paddleW / 2"),
    `a cursor deep in the right letterbox must keep hugging the right wall, got ${g.paddleX()}`);
});

check("AC2: the hug is a CONTINUOUS command — a cursor sliding outward stays glued, and pulling it back in hands control over immediately", () => {
  const g = boot(960, 600);
  start(g);
  g.setRect({ left: 240, top: 0, width: 480, height: 300 });
  g.mouseMove(0); // far left: hug the left wall
  assert(g.paddleX() === g.q("paddleW / 2"),
    `an off-rect-left cursor must hug the left wall, got ${g.paddleX()}`);
  g.mouseMove(900); // far right: the wall flips in one event
  assert(g.paddleX() === g.q("canvas.width - paddleW / 2"),
    `swinging the cursor to the right letterbox must flip to the right wall in one event, got ${g.paddleX()}`);
  g.mouseMove(480); // back inside, mid-rect: 1:1 resumes instantly
  assertClose(g.paddleX(), ((480 - 240) / 480) * g.canvas.width, 1e-9,
    `a cursor pulled back inside must hand over 1:1 tracking in one event, got ${g.paddleX()}`);
});

// ================================================================
// Criterion 3: above/below the rect (the vertical letterbox bars,
// the HUD) does NOT freeze or wall-hug vertically — the paddle
// still tracks the cursor's HORIZONTAL position.
// ================================================================
check("AC3: a cursor ABOVE the rect but within its horizontal span still tracks horizontally", () => {
  const g = boot(960, 600);
  start(g);
  g.setRect({ left: 240, top: 100, width: 480, height: 300 });
  g.park(960);
  g.mouseMove(400, 99); // 1 px above the rect, x inside the span
  assertClose(g.paddleX(), ((400 - 240) / 480) * g.canvas.width, 1e-9,
    `a cursor 1 px above the rect must still track its horizontal position, got ${g.paddleX()}`);
  g.mouseMove(10000, -10000); // deep in the top bar, x far past the right span
  assert(g.paddleX() === g.q("canvas.width - paddleW / 2"),
    `a cursor deep above, horizontally past the right span, must hug the right wall, got ${g.paddleX()}`);
});

check("AC3: a cursor BELOW the rect but within its horizontal span still tracks horizontally", () => {
  const g = boot(960, 600);
  start(g);
  g.setRect({ left: 240, top: 100, width: 480, height: 300 });
  g.park(960);
  g.mouseMove(320, 401); // 1 px below the rect, x inside the span
  assertClose(g.paddleX(), ((320 - 240) / 480) * g.canvas.width, 1e-9,
    `a cursor 1 px below the rect must still track its horizontal position, got ${g.paddleX()}`);
  g.mouseMove(200, 10000); // deep in the bottom bar, x left of the span
  assert(g.paddleX() === g.q("paddleW / 2"),
    `a cursor deep below, horizontally left of the span, must hug the left wall, got ${g.paddleX()}`);
});

// ================================================================
// Criterion 4: the touch path obeys the SAME rules — instant
// rect-mapped 1:1 in-rect, wall-hug off-rect.
// ================================================================
check("AC4: an in-rect touch lands the paddle at the rect-mapped x in one event, exactly like mouse", () => {
  const g = boot(960, 600);
  start(g);
  g.setRect({ left: 240, top: 100, width: 480, height: 300 });
  g.park(960);
  g.touchDrag(270, 250); // maps to ((270−240)/480)·1920 = 120
  assertClose(g.paddleX(), 120, 1e-9,
    `a single in-rect touch 840 px away must land the paddle at the rect-mapped 120, got ${g.paddleX()}`);
});

check("AC4: a touch left of / right of the rect hugs the matching wall, above/below still tracks — same rules as mouse", () => {
  const g = boot(960, 600);
  start(g);
  g.setRect({ left: 240, top: 100, width: 480, height: 300 });
  g.park(g.q("canvas.width / 2"));
  g.touchDrag(239, 250); // 1 px left of the rect
  assert(g.paddleX() === g.q("paddleW / 2"),
    `a touch left of the rect must hug the left wall, got ${g.paddleX()}`);
  g.touchDrag(721, 250); // 1 px right of the rect
  assert(g.paddleX() === g.q("canvas.width - paddleW / 2"),
    `a touch right of the rect must hug the right wall, got ${g.paddleX()}`);
  g.touchDrag(480, 99); // above the rect, mid-span
  assertClose(g.paddleX(), ((480 - 240) / 480) * g.canvas.width, 1e-9,
    `a touch above the rect must still track its horizontal position, got ${g.paddleX()}`);
});

// ================================================================
// Criterion 5: the surviving guards — a degenerate (zero-width)
// rect and a missing/NaN clientX are IGNORED: they can never
// poison paddle.x.
// ================================================================
check("AC5: a degenerate (zero-width) rect is ignored — no divide-by-zero poisoning, and the paddle resumes tracking once the rect recovers", () => {
  const g = boot(960, 600);
  start(g);
  g.mouseMove(100);
  const before = g.paddleX();
  assert(Number.isFinite(before), `sanity: the paddle must be finite after a normal move, got ${before}`);
  g.setRect({ left: 0, top: 0, width: 0, height: 0 }); // e.g. rect queried while hidden
  g.mouseMove(480); // naive mapping divides by rect.width → NaN
  assert(Number.isFinite(g.paddleX()), `a width-0 rect must not NaN the paddle, got ${g.paddleX()}`);
  assertClose(g.paddleX(), before, 1e-9,
    `a degenerate-rect mousemove must leave the paddle alone, got ${g.paddleX()}, want ${before}`);
  g.setRect({ left: 0, top: 0, width: 960, height: 600 }); // viewport reappears
  g.park(1700);
  g.mouseMove(100);
  assertClose(g.paddleX(), 200, 1e-9,
    `after the rect recovers the 1:1 tracking must work again (want 200), got ${g.paddleX()}`);
});

check("AC5: a missing/NaN clientX is ignored — the paddle is never poisoned by a malformed coordinate", () => {
  const g = boot(960, 600);
  start(g);
  g.mouseMove(100);
  const before = g.paddleX();
  g.mouseMove(NaN); // malformed coordinate (a browser always delivers a finite one)
  assert(Number.isFinite(g.paddleX()), `a NaN clientX must not NaN the paddle, got ${g.paddleX()}`);
  assertClose(g.paddleX(), before, 1e-9,
    `a NaN-clientX mousemove must leave the paddle alone, got ${g.paddleX()}, want ${before}`);
  g.park(1700);
  g.mouseMove(100); // the mapping must still work afterwards
  assertClose(g.paddleX(), 200, 1e-9,
    `after a malformed event the 1:1 tracking must work again (want 200), got ${g.paddleX()}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
