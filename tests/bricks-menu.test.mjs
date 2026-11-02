#!/usr/bin/env node
// ================================================================
// Unit tests — main menu reachable from pause (M) and game over
// (ticket #70, PRD section 3: Screens)
//
// Same harness style as the sibling bricks suites: runs the REAL
// <script> from bricks.html in a sandboxed vm context with stubbed
// window/document/canvas and DOM element stubs that record styles
// and listeners. localStorage is a Map-backed capture so
// persistence across the return to menu is observable. Frames are
// driven through the captured requestAnimationFrame callback;
// `random` is pinned so no capsule can drop by chance. No network,
// no external services, no wall clock.
//
// Run: node tests/bricks-menu.test.mjs
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

// A DOM element stub: records style writes, text, listeners and
// child nodes (lives icons / leaderboard rows are appended by the
// game).
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
// `seedStore` optionally pre-fills the localStorage capture with
// {key: jsonString} entries so a boot loads persisted records.
function boot(width, height, seedStore = {}) {
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
    "screen-pause": makeEl("screen-pause"),
    "screen-gameover": makeEl("screen-gameover"),
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
  const store = new Map(Object.entries(seedStore));
  const sandbox = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => {
        store.set(k, String(v));
      },
      removeItem: (k) => {
        store.delete(k);
      },
    },
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
  function key(type, code) {
    for (const cb of winListeners[type] ?? []) cb({ type, code, preventDefault() {} });
  }
  const q = (expr) => vm.runInContext(expr, context);
  const state = () =>
    q("typeof gameState === 'undefined' ? 'undefined' : gameState");
  // Enter live play: start, then launch the serve ball (with the pinned
  // random=1 the #97 launch jitter is +LAUNCH_JITTER_ANGLE from vertical).
  function startAndLaunch() {
    els["btn-start"].click();
    q("random = function () { return 1; };"); // no capsule drops by chance
    canvas.dispatch("click", { type: "click" });
  }
  // Walk the real loseLife -> game-over path with one life left:
  // drop the last live ball off the bottom of the stage.
  function runToGameOver() {
    q("lives = 1;");
    q("balls[0].attached = false; balls[0].y = canvas.height + 100;");
    tick(1);
    assert(state() === "gameover",
      `precondition: the run must be over, state is ${state()}`);
  }
  return { canvas, els, q, tick, key, state, startAndLaunch, runToGameOver, store };
}
const DISPLAY = (el) => el.style.display;
// Full run state the return to menu must reset in one pass.
const RUN_SNAP = "JSON.stringify({ score, level, lives, simTime, balls, capsules, expandUntil, stickyUntil, multUntil, paddleW, bricksLeft })";
// The pause overlay section of the shipped markup, isolated.
const pauseSection = (() => {
  const m = html.match(/<section class="screen" id="screen-pause">([\s\S]*?)<\/section>/);
  assert(m, "the <section id=screen-pause> markup must exist");
  return m[1];
})();
const gameOverSection = (() => {
  const m = html.match(/<section class="screen" id="screen-gameover">([\s\S]*?)<\/section>/);
  assert(m, "the <section id=screen-gameover> markup must exist");
  return m[1];
})();

// ================================================================
// Criterion 1: from a paused run, M abandons the run — state
// "start", start overlay visible, run fully reset; M in every
// non-playing state is a no-op
// ================================================================
check("M during 'paused' abandons the run: state 'start', start overlay visible, run fully reset", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.tick(30);
  g.q("score = 120;"); // mid-run marker: the reset must zero it
  g.key("keydown", "Escape");
  assert(g.state() === "paused", "precondition: the run must be paused");
  g.key("keyup", "Escape");
  g.key("keydown", "KeyM");
  assert(g.state() === "start",
    `M while paused must return to "start", state is ${g.state()}`);
  assert(DISPLAY(g.els["screen-start"]) === "flex",
    `the start overlay must be visible, display=${JSON.stringify(DISPLAY(g.els["screen-start"]))}`);
  assert(DISPLAY(g.els["screen-pause"]) === "none",
    `the pause overlay must be hidden, display=${JSON.stringify(DISPLAY(g.els["screen-pause"]))}`);
  assert(DISPLAY(g.els["screen-gameover"]) === "none",
    `the game-over overlay must be hidden, display=${JSON.stringify(DISPLAY(g.els["screen-gameover"]))}`);
  const run = JSON.parse(g.q(RUN_SNAP));
  assert(run.score === 0, `the run score must reset to 0, got ${run.score}`);
  assert(run.level === 1, `the run level must reset to 1, got ${run.level}`);
  assert(run.lives === 3, `the run lives must reset to full, got ${run.lives}`);
  assert(run.simTime === 0, `simTime must reset to 0, got ${run.simTime}`);
  assert(run.balls.filter((b) => b.active).length === 1 && run.balls[0].attached,
    "the ball pool must hold exactly one resting serve ball");
  assert(run.capsules.every((c) => !c.active), "no capsule may survive the return");
  assert(run.expandUntil === -1 && run.stickyUntil === -1 && run.multUntil === -1,
    "no timed power-up window may survive the return");
  assert(run.paddleW === 120, `the paddle width must reset to the base, got ${run.paddleW}`);
});

check("abandoning to the menu with M, Start Game then begins a fresh run", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.tick(10);
  g.key("keydown", "Escape");
  assert(g.state() === "paused", "precondition: must be paused");
  g.key("keyup", "Escape");
  g.key("keydown", "KeyM");
  assert(g.state() === "start", "precondition: must be back on the start screen");
  g.els["btn-start"].click();
  assert(g.state() === "playing",
    `the Start Game CTA must start a fresh run, state is ${g.state()}`);
  assert(g.q("score") === 0 && g.q("level") === 1,
    "the fresh run must start from score 0, level 1");
  assert(g.q("bricksLeft") > 0, "the fresh run must have a spawned brick board");
});

check("M during 'playing' is a no-op (does not pause, does not abandon)", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.tick(5);
  const pauseEl = g.els["screen-pause"];
  const startEl = g.els["screen-start"];
  const markedPause = pauseEl.styleWrites.length;
  const markedStart = startEl.styleWrites.length;
  g.key("keydown", "KeyM");
  g.tick(2);
  g.key("keyup", "KeyM");
  assert(g.state() === "playing",
    `M during play must not change the state, state is ${g.state()}`);
  assert(DISPLAY(pauseEl) === "none", "M during play must not show the pause overlay");
  assert(DISPLAY(startEl) === "none", "M during play must not show the start overlay");
  assert(pauseEl.styleWrites.length === markedPause && startEl.styleWrites.length === markedStart,
    "no overlay may churn from a stray M during play");
});

check("M during 'start' is a no-op (no pause from start, no overlay churn)", () => {
  const g = boot(960, 600);
  assert(g.state() === "start", "precondition: booted on the start screen");
  const pauseEl = g.els["screen-pause"];
  const startEl = g.els["screen-start"];
  const markedPause = pauseEl.styleWrites.length;
  const markedStart = startEl.styleWrites.length;
  g.key("keydown", "KeyM");
  g.tick(2);
  g.key("keyup", "KeyM");
  assert(g.state() === "start",
    `M during "start" must not change the state, state is ${g.state()}`);
  assert(DISPLAY(startEl) === "flex", "the start overlay must remain visible");
  assert(DISPLAY(pauseEl) === "none", "M must not pause from the start screen");
  assert(pauseEl.styleWrites.length === markedPause && startEl.styleWrites.length === markedStart,
    "no overlay may churn from a stray M during start");
});

check("M during 'gameover' is a no-op (the Menu button is the only exit there)", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.runToGameOver();
  const overEl = g.els["screen-gameover"];
  const marked = overEl.styleWrites.length;
  g.key("keydown", "KeyM");
  g.tick(2);
  assert(g.state() === "gameover",
    `M during "gameover" must not change the state, state is ${g.state()}`);
  assert(DISPLAY(overEl) === "flex", "the game-over overlay must remain visible");
  assert(overEl.styleWrites.length === marked, "no overlay may churn from a stray M");
});

check("auto-repeat of a HELD M key cannot toggle the screens", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.key("keydown", "Escape");
  assert(g.state() === "paused", "precondition: first pause edge must pause");
  g.key("keyup", "Escape");
  g.key("keydown", "KeyM");
  assert(g.state() === "start", "precondition: one M press must reach the menu");
  g.key("keydown", "KeyM"); // browser auto-repeat while the key is held
  g.key("keydown", "KeyM");
  g.tick(3);
  assert(g.state() === "start",
    `repeat M presses must stay a no-op on the start screen, state is ${g.state()}`);
  assert(DISPLAY(g.els["screen-pause"]) === "none",
    "a repeat M must never open the pause screen");
});

check("high score and leaderboard survive the return to the menu (M path)", () => {
  const g = boot(960, 600, {
    "brickbreaker.highScore": "500",
    "brickbreaker.leaderboard": "[500, 300]",
  });
  assert(g.q("highScore") === 500, "precondition: boot must load the stored high score");
  g.startAndLaunch();
  g.tick(10);
  g.q("score = 900;"); // the run overtakes the record
  g.tick(1);           // syncScore promotes + persists it
  assert(g.store.get("brickbreaker.highScore") === "900",
    "precondition: the overtaken record must be persisted mid-run");
  g.key("keydown", "Escape");
  assert(g.state() === "paused", "precondition: must be paused");
  g.key("keyup", "Escape");
  g.key("keydown", "KeyM");
  assert(g.state() === "start", "precondition: must be back on the menu");
  assert(g.q("highScore") === 900,
    `the live high score must survive the return, got ${g.q("highScore")}`);
  assert(g.store.get("brickbreaker.highScore") === "900",
    "the stored high score must survive the return");
  // Compare parsed content, not byte form: the game writes compact
  // JSON, and the seeded value here carries a space after the comma.
  assert(JSON.stringify(JSON.parse(g.store.get("brickbreaker.leaderboard"))) === "[500,300]",
    `the stored leaderboard must survive the return, got ${JSON.stringify(g.store.get("brickbreaker.leaderboard"))}`);
  assert(JSON.stringify(g.q("leaderboard")) === "[500,300]",
    "the in-memory leaderboard must survive the return");
});

// ================================================================
// Criterion 2: from game over, clicking #btn-menu returns to the
// start screen with the same reset; #btn-restart is unchanged
// ================================================================
check("clicking #btn-menu on game over returns to 'start' with the run fully reset", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.tick(20);
  g.q("score = 80;");
  g.runToGameOver();
  g.els["btn-menu"].click();
  assert(g.state() === "start",
    `the Menu click must return to "start", state is ${g.state()}`);
  assert(DISPLAY(g.els["screen-start"]) === "flex",
    `the start overlay must be visible, display=${JSON.stringify(DISPLAY(g.els["screen-start"]))}`);
  assert(DISPLAY(g.els["screen-gameover"]) === "none",
    `the game-over overlay must be hidden, display=${JSON.stringify(DISPLAY(g.els["screen-gameover"]))}`);
  const run = JSON.parse(g.q(RUN_SNAP));
  assert(run.score === 0 && run.level === 1 && run.lives === 3,
    `score/level/lives must reset, got ${run.score}/${run.level}/${run.lives}`);
  assert(run.simTime === 0, `simTime must reset, got ${run.simTime}`);
  assert(run.balls.filter((b) => b.active).length === 1 && run.balls[0].attached,
    "the ball pool must hold exactly one resting serve ball");
});

check("clicking #btn-menu on game over leaves high score and leaderboard intact", () => {
  const g = boot(960, 600, {
    "brickbreaker.highScore": "700",
    "brickbreaker.leaderboard": "[700, 400]",
  });
  g.startAndLaunch();
  g.runToGameOver();
  g.els["btn-menu"].click();
  assert(g.state() === "start", "precondition: must be back on the menu");
  assert(g.q("highScore") === 700,
    `the live high score must survive, got ${g.q("highScore")}`);
  assert(g.store.get("brickbreaker.highScore") === "700",
    "the stored high score must survive");
  assert(JSON.stringify(g.q("leaderboard")) === "[700,400]",
    "the in-memory leaderboard must survive");
});

check("#btn-restart (Try Again) still starts a fresh run from game over, unchanged", () => {
  const g = boot(960, 600);
  g.startAndLaunch();
  g.runToGameOver();
  g.els["btn-restart"].click();
  assert(g.state() === "playing",
    `the Try Again click must start a fresh run, state is ${g.state()}`);
  assert(g.q("score") === 0 && g.q("level") === 1,
    "the fresh run must start from score 0, level 1");
});

check("stray #btn-menu clicks outside 'gameover' are no-ops (state-gated)", () => {
  const g = boot(960, 600);
  assert(g.state() === "start", "precondition: booted on the start screen");
  const startEl = g.els["screen-start"];
  const startMarked = startEl.styleWrites.length;
  g.els["btn-menu"].click(); // stray click on the start screen
  assert(g.state() === "start",
    `a stray Menu click during "start" must not change the state, state is ${g.state()}`);
  assert(startEl.styleWrites.length === startMarked,
    "a stray Menu click on the start screen must not churn overlays");
  g.startAndLaunch();
  g.tick(5);
  const pauseEl = g.els["screen-pause"];
  const pauseMarked = pauseEl.styleWrites.length;
  g.els["btn-menu"].click(); // stray click mid-run
  assert(g.state() === "playing",
    `a stray Menu click during play must not change the state, state is ${g.state()}`);
  assert(pauseEl.styleWrites.length === pauseMarked &&
      g.els["screen-start"].styleWrites.length === startEl.styleWrites.length,
    "a stray Menu click during play must not churn overlays");
});

// ================================================================
// Criterion 3: #btn-menu follows the existing state-gating + CTA
// pattern of #btn-restart
// ================================================================
check("#btn-menu sits beside #btn-restart on the game-over overlay with a Menu label", () => {
  assert(
    /<button\b[^>]*id="btn-restart"[^>]*>\s*try again\s*<\/button>\s*<button\b[^>]*id="btn-menu"[^>]*>\s*menu\s*<\/button>/i
      .test(gameOverSection),
    "the game-over overlay must carry #btn-menu with a Menu label beside #btn-restart"
  );
  const g = boot(960, 600);
  const btn = g.els["btn-menu"];
  assert((btn.listeners["click"] ?? []).length === 1,
    `#btn-menu must register exactly one click handler, got ${btn.listeners["click"]?.length}`);
});

check("the CTA button rule selects #btn-menu alongside #btn-start/#btn-resume/#btn-restart", () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const rule = css.split("}").find((r) => r.includes("{") && r.split("{")[0].includes("#btn-start"));
  assert(rule, "the stylesheet must carry a CTA button rule selecting #btn-start");
  assert(rule.includes("#btn-menu"),
    "the CTA rule must also select #btn-menu so the Menu button shares the CTA look");
});

// ================================================================
// Criterion 4: the pause overlay gains an "M menu" hint line —
// present while paused, absent otherwise
// ================================================================
check("the pause overlay markup carries the 'ESC RESUME · M MENU' hint line", () => {
  assert(/esc\s+resume/i.test(pauseSection),
    "the pause overlay must carry an esc-resume hint");
  assert(/m\s*menu/i.test(pauseSection),
    "the pause overlay must carry an M-menu hint line");
});

check("the hint line rides the pause overlay: visible only while paused", () => {
  const g = boot(960, 600);
  const pauseEl = g.els["screen-pause"];
  assert(DISPLAY(pauseEl) === "none", "precondition: no pause overlay on the start screen");
  g.startAndLaunch();
  assert(DISPLAY(pauseEl) === "none", "precondition: no pause overlay during play");
  g.key("keydown", "Escape");
  assert(g.state() === "paused", "precondition: must be paused");
  assert(DISPLAY(pauseEl) === "flex", "the pause overlay (with its hint line) must be visible while paused");
  g.key("keyup", "Escape");
  g.key("keydown", "Escape"); // resume
  assert(g.state() === "playing", "precondition: resumed");
  assert(DISPLAY(pauseEl) === "none", "the pause overlay (with its hint line) must be hidden after resume");
  g.q("lives = 1;");
  g.q("balls[0].attached = false; balls[0].y = canvas.height + 100;");
  g.tick(1);
  assert(g.state() === "gameover", "precondition: run is over");
  assert(DISPLAY(pauseEl) === "none", "the pause overlay (with its hint line) must be hidden on game over");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
