#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html pause and resume screen via Escape/P
// (ticket #24, PRD section 3: Screens with a Pause overlay)
//
// Same harness style as tests/bricks-scaffold.test.mjs: runs the
// REAL <script> from bricks.html in a sandboxed vm context with
// stubbed window/document/localStorage/requestAnimationFrame and
// DOM element stubs that record styles and event listeners. Pause
// keys are edge-dispatched into the registered window keydown/
// keyup/blur listeners; the 600-frame soak snapshots the run state
// through JSON.stringify, so bit identity is asserted exactly.
// Like every sibling suite, `random` is pinned so a capsule can
// never drop by chance mid-test. No network, no external services.
//
// Run: node tests/bricks-screens.test.mjs
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

// A DOM element stub: records style writes (in order — overlay
// churn is asserted as "no NEW writes"), text, listeners and child
// nodes (lives icons are appended/removed by the game).
function makeEl(id) {
  const styleTarget = {};
  const el = {
    id,
    style: new Proxy(styleTarget, {
      get(_t, prop) {
        return _t[prop];
      },
      set(_t, prop, value) {
        _t[prop] = value;
        el.styleWrites.push([prop, value]);
        return true;
      },
    }),
    styleWrites: [],
    textContent: "",
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
function boot(width, height) {
  const canvas = {
    width: 0,
    height: 0,
    // Records CSS style writes (stage letterbox fit) and answers
    // getBoundingClientRect() with a rect filling the boot viewport.
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
    "screen-pause": makeEl("screen-pause"),
    "screen-gameover": makeEl("screen-gameover"),
    "btn-start": makeEl("btn-start"),
    "difficulty-easy": makeEl("difficulty-easy"),
    "difficulty-normal": makeEl("difficulty-normal"),
    "difficulty-hard": makeEl("difficulty-hard"),
    "theme-classic": makeEl("theme-classic"),
    "theme-neon": makeEl("theme-neon"),
    "theme-minimal": makeEl("theme-minimal"),
    "btn-mute": makeEl("btn-mute"),
    "sound-volume": makeEl("sound-volume"),
    "btn-resume": makeEl("btn-resume"),
    "btn-restart": makeEl("btn-restart"),
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

  let nowMs = 0;
  const FRAME_MS = 1000 / 60;
  function tick(n = 1) {
    for (let i = 0; i < n; i += 1) {
      nowMs += FRAME_MS;
      rafCb(nowMs);
    }
  }
  // Edge-dispatch one keydown/keyup of a specific code into the
  // registered window listeners, the way a single physical press
  // arrives (auto-repeat is modelled by a second keydown with no
  // keyup in between).
  function key(type, code) {
    for (const cb of winListeners[type] ?? []) cb({ type, code, preventDefault() {} });
  }
  function blur() {
    for (const cb of winListeners["blur"] ?? []) cb({ type: "blur" });
  }
  const q = (expr) => vm.runInContext(expr, context);
  // Exact snapshot of everything the pause must freeze: every ball
  // slot (position + flags), paddle centre, the whole brick pool
  // (active flags, tiers, geometry), score, level and lives.
  const snap = () =>
    q(
      'JSON.stringify({ balls, paddle: { x: paddle.x }, bricks, score, level, lives })'
    );
  const state = () =>
    q("typeof gameState === 'undefined' ? 'undefined' : gameState");
  // Enter live play: start, then launch the serve ball straight up.
  function startAndLaunch() {
    els["btn-start"].click();
    q("random = function () { return 1; };"); // no capsule drops by chance
    canvas.dispatch("click", { type: "click" });
  }
  return { canvas, els, q, tick, key, blur, snap, state, startAndLaunch };
}
const DISPLAY = (el) => el.style.display;

// ================================================================
// Criterion 1: Escape / KeyP keydown while "playing" -> "paused",
// pause overlay visible with a Resume CTA, other overlays undisturbed
// ================================================================
check("Escape keydown during 'playing' pauses the game and shows the pause overlay", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.tick(5);
  g.key("keydown", "Escape");
  assert(g.state() === "paused",
    `Escape during play must enter "paused", state is ${g.state()}`);
  assert(DISPLAY(g.els["screen-pause"]) === "flex",
    `the pause overlay must be visible, display=${JSON.stringify(DISPLAY(g.els["screen-pause"]))}`);
  assert(DISPLAY(g.els["screen-start"]) === "none",
    `the start overlay must stay hidden, display=${JSON.stringify(DISPLAY(g.els["screen-start"]))}`);
  assert(DISPLAY(g.els["screen-gameover"]) === "none",
    `the game-over overlay must stay hidden, display=${JSON.stringify(DISPLAY(g.els["screen-gameover"]))}`);
});

check("KeyP keydown during 'playing' pauses the game and shows the pause overlay", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.key("keydown", "KeyP");
  assert(g.state() === "paused",
    `KeyP during play must enter "paused", state is ${g.state()}`);
  assert(DISPLAY(g.els["screen-pause"]) === "flex",
    `the pause overlay must be visible, display=${JSON.stringify(DISPLAY(g.els["screen-pause"]))}`);
});

check("the pause overlay ships a Resume CTA button wired to a click handler", () => {
  const g = boot(960, 600);
  const btn = g.els["btn-resume"];
  assert((btn.listeners["click"] ?? []).length === 1,
    `the Resume CTA must register exactly one click handler, got ${btn.listeners["click"]?.length}`);
  assert(/<button\b[^>]*id="btn-resume"[^>]*>\s*resume[^<]*\s*<\/button>/i.test(html),
    "the <button id=btn-resume> markup must carry a Resume label");
});

// ================================================================
// Criterion 2: while "paused", 600 frames change nothing — the run
// state (ball, paddle, bricks, score, level, lives) is bit-identical
// before and after the soak
// ================================================================
check("600 paused frames leave the run bit-identical (ball, paddle, bricks, score, level, lives)", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  const yAtLaunch = g.q("balls[0].y");
  g.tick(30);
  assert(g.q("balls[0].y") !== yAtLaunch,
    `the launched ball must be in flight before the soak, y is still ${yAtLaunch}`);
  const before = g.snap();
  g.key("keydown", "Escape");
  assert(g.state() === "paused", `precondition: the run must be paused, state is ${g.state()}`);
  g.tick(600);
  assert(g.state() === "paused",
    `the soak must hold the game in "paused", state is ${g.state()}`);
  const after = g.snap();
  assert(after === before,
    `the paused soak must leave the run bit-identical\n  got  ${after}\n  want ${before}`);
  assert(DISPLAY(g.els["screen-pause"]) === "flex",
    "the pause overlay must remain visible through the soak");
});

// (The pointer listeners stay state-ungated by documented decision —
// the full-viewport overlay occludes the canvas in a real browser, so
// no stray pointer input reaches them while paused; the paddle suite
// pins that contract.)
// ================================================================
// Criterion 3: clicking Resume (or pressing the pause key again)
// returns to "playing"; the first resumed frame resumes motion
// ================================================================
check("clicking the Resume button returns to 'playing' and hides the pause overlay", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.key("keydown", "Escape");
  assert(g.state() === "paused", "precondition: must be paused");
  g.els["btn-resume"].click();
  assert(g.state() === "playing",
    `the Resume click must return to "playing", state is ${g.state()}`);
  assert(DISPLAY(g.els["screen-pause"]) === "none",
    `the pause overlay must be hidden, display=${JSON.stringify(DISPLAY(g.els["screen-pause"]))}`);
  assert(DISPLAY(g.els["screen-start"]) === "none",
    `the start overlay must stay hidden, display=${JSON.stringify(DISPLAY(g.els["screen-start"]))}`);
  assert(DISPLAY(g.els["screen-gameover"]) === "none",
    `the game-over overlay must stay hidden, display=${JSON.stringify(DISPLAY(g.els["screen-gameover"]))}`);
});

check("the first frame after resuming continues the ball's motion", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.tick(10);
  g.key("keydown", "Escape");
  assert(g.state() === "paused", "precondition: must be paused");
  const frozenY = g.q("balls[0].y");
  g.els["btn-resume"].click();
  assert(g.state() === "playing", "precondition: must be playing again");
  g.tick(1); // exactly one frame
  assert(g.q("balls[0].y") !== frozenY,
    `motion must resume on the FIRST frame after resume, ball y is still ${frozenY}`);
});

check("re-pressing the pause key during 'paused' resumes", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.key("keydown", "Escape");
  g.key("keyup", "Escape"); // full press, released
  assert(g.state() === "paused", "precondition: still paused after keyup");
  g.key("keydown", "Escape");
  assert(g.state() === "playing",
    `a fresh Escape press must resume, state is ${g.state()}`);
  assert(DISPLAY(g.els["screen-pause"]) === "none",
    `the pause overlay must be hidden, display=${JSON.stringify(DISPLAY(g.els["screen-pause"]))}`);
});

check("KeyP resumes a pause entered with Escape (either pause key toggles back)", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.key("keydown", "Escape");
  assert(g.state() === "paused", "precondition: must be paused");
  g.key("keyup", "Escape");
  g.key("keydown", "KeyP");
  assert(g.state() === "playing",
    `KeyP must resume a pause entered with Escape, state is ${g.state()}`);
});

check("auto-repeat of a HELD pause key does not toggle the pause screen back", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.key("keydown", "Escape");
  assert(g.state() === "paused", "precondition: first edge must pause");
  g.key("keydown", "Escape"); // browser auto-repeat while the key is held
  g.key("keydown", "Escape");
  g.tick(3);
  assert(g.state() === "paused",
    `repeat keydowns of a held key must not resume, state is ${g.state()}`);
  g.key("keyup", "Escape");
  assert(g.state() === "paused", "keyup alone must not resume");
  g.key("keydown", "Escape");
  assert(g.state() === "playing",
    `the next physical press must resume, state is ${g.state()}`);
});

check("a blur clears held pause keys, so the next press can resume", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.key("keydown", "Escape");
  assert(g.state() === "paused", "precondition: paused with the key still logically held");
  g.blur(); // window loses focus: keyups are lost with it
  g.key("keydown", "Escape");
  assert(g.state() === "playing",
    `after a blur the next Escape press must resume (no ghost-held key), state is ${g.state()}`);
});

check("clicking Resume while 'playing' is a no-op (cannot hide a live run)", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  const pauseEl = g.els["screen-pause"];
  const marked = pauseEl.styleWrites.length;
  g.els["btn-resume"].click();
  assert(g.state() === "playing",
    `a stray Resume click during play must not change the state, state is ${g.state()}`);
  assert(pauseEl.styleWrites.length === marked,
    `the stray Resume click must not touch any overlay, new writes=${JSON.stringify(pauseEl.styleWrites.slice(marked))}`);
  assert(DISPLAY(pauseEl) === "none", "the pause overlay must never have been shown");
});

// ================================================================
// Criterion 4: the pause keys outside "playing"/"paused" are no-ops —
// state unchanged, no overlay churn (campaign-1 edge-triggered,
// state-gated transition precedent)
// ================================================================
check("Escape and KeyP during 'start' are no-ops (state and overlays untouched)", () => {
  const g = boot(960, 600);
  assert(g.state() === "start", "precondition: booted on the start screen");
  const pauseEl = g.els["screen-pause"];
  const startEl = g.els["screen-start"];
  const markedPause = pauseEl.styleWrites.length;
  const markedStart = startEl.styleWrites.length;
  g.key("keydown", "Escape");
  g.tick(2);
  g.key("keydown", "KeyP");
  g.tick(2);
  assert(g.state() === "start",
    `the pause keys must not leave "start", state is ${g.state()}`);
  assert(DISPLAY(startEl) === "flex", "the start overlay must remain visible");
  assert(DISPLAY(pauseEl) === "none", "the pause overlay must stay hidden");
  assert(pauseEl.styleWrites.length === markedPause && startEl.styleWrites.length === markedStart,
    `no overlay may churn, pause=${JSON.stringify(pauseEl.styleWrites.slice(markedPause))} start=${JSON.stringify(startEl.styleWrites.slice(markedStart))}`);
});

check("Escape and KeyP during 'gameover' are no-ops (state and overlays untouched)", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  // Walk the real loseLife -> game-over path with one life left.
  g.q("lives = 1;");
  g.q("balls[0].attached = false; balls[0].y = canvas.height + 100;");
  g.tick(1);
  assert(g.state() === "gameover", `precondition: run must be over, state is ${g.state()}`);
  const pauseEl = g.els["screen-pause"];
  const overEl = g.els["screen-gameover"];
  const markedPause = pauseEl.styleWrites.length;
  const markedOver = overEl.styleWrites.length;
  g.key("keydown", "Escape");
  g.tick(2);
  g.key("keydown", "KeyP");
  g.tick(2);
  assert(g.state() === "gameover",
    `the pause keys must not leave "gameover", state is ${g.state()}`);
  assert(DISPLAY(overEl) === "flex", "the game-over overlay must remain visible");
  assert(DISPLAY(pauseEl) === "none", "the pause overlay must stay hidden");
  assert(pauseEl.styleWrites.length === markedPause && overEl.styleWrites.length === markedOver,
    `no overlay may churn, pause=${JSON.stringify(pauseEl.styleWrites.slice(markedPause))} over=${JSON.stringify(overEl.styleWrites.slice(markedOver))}`);
});

check("an unrelated key during 'playing' does not pause", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  const pauseEl = g.els["screen-pause"];
  const marked = pauseEl.styleWrites.length;
  g.key("keydown", "KeyQ");
  g.key("keydown", "Enter");
  g.tick(2);
  assert(g.state() === "playing",
    `only Escape/KeyP may pause, state is ${g.state()}`);
  assert(pauseEl.styleWrites.length === marked, "the pause overlay must never have been touched");
  assert(DISPLAY(pauseEl) === "none", "the pause overlay must stay hidden");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
