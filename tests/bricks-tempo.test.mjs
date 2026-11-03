#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html run tempo scaling (ticket #89): the
// run's ball-speed percent (#73's speedFactor) must scale the
// WHOLE tempo — capsule fall speed and keyboard paddle speed in
// addition to the serve. Both are snapshotted in beginRun() beside
// the serve snapshots; the pointer paddle is position-following
// and deliberately NOT scaled.
//
// Same harness style as the sibling bricks-*.test.mjs suites: the
// REAL <script> from bricks.html runs in a sandboxed vm context
// with stubbed window/document/localStorage/requestAnimationFrame
// and DOM element stubs. Driven frames at a fixed 60 fps clock;
// `random` is pinned at boot so a capsule can never drop by
// chance mid-test. No network, no external services.
//
// Run: node tests/bricks-tempo.test.mjs
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
// House tolerance pattern for driven-frame displacement comparisons.
function assertClose(got, want, tol, msg) {
  if (Math.abs(got - want) > tol) {
    throw new Error(`${msg}: got ${got}, want ${want} (+/- ${tol})`);
  }
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
function boot(width, height) {
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
    dispatch(type, ev) {
      for (const cb of this.listeners[type] ?? []) cb(ev);
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
  const fireWin = (type, ev) => {
    for (const cb of winListeners[type] ?? []) cb(ev);
  };
  const q = (expr) => vm.runInContext(expr, context);
  return {
    els,
    canvas,
    q,
    tick,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    paddleX: () => q("typeof paddle === 'undefined' ? NaN : paddle.x"),
    // Activate one pooled capsule in place (console-style) at a
    // known position far from the centred paddle: no catch, no
    // miss within the driven window, so its y displacement is
    // exactly the fall speed integrated over the frames.
    dropCapsule: (x, y) =>
      q(`capsules[0].active = true;
         capsules[0].kind = KIND_EXPAND;
         capsules[0].x = ${x}; capsules[0].y = ${y}; 1`),
    capY: () => q("capsules[0].y"),
    capActive: () => q("capsules[0].active"),
    key(type, code) {
      fireWin(type, { code, preventDefault() {} });
    },
    mouseMove(clientX, clientY) {
      fireWin("mousemove", {
        clientX,
        clientY:
          clientY === undefined ? canvas.rect.top + canvas.rect.height / 2 : clientY,
      });
    },
  };
}

// Drive the #ball-speed slider the way a browser drag would: write
// the element value, then dispatch its input event.
function setSlider(g, v) {
  const el = g.els["ball-speed"];
  el.value = String(v);
  for (const cb of el.listeners["input"] ?? []) cb({ type: "input" });
}
const start = (g) => {
  g.els["btn-start"].click();
  g.tick(1);
};

// Fixed 60 fps clock: one driven frame integrates exactly
// speed · (1/60) seconds, so the expected displacement over N
// frames is speed · N / 60 (computed from the BASE named vars,
// exactly as today's unscaled code integrates them).
const FRAMES_PER_SEC = 60;

// ================================================================
// AC4: the snapshots live in beginRun() beside the serve
// snapshots — the base named vars are MULTIPLIED by the run's
// factor, never replaced (checked at an odd, non-power-of-two
// percent so a replace-by-rounded-integer or additive scheme
// cannot masquerade as a multiply).
// ================================================================
check("AC4: beginRun() multiplies CAPSULE_FALL_SPEED and PADDLE_SPEED by the run's factor (snapshots at 125%)", () => {
  const g = boot(960, 600);
  setSlider(g, 125);
  start(g);
  const want = 1.25;
  assert(
    g.q("typeof runCapsuleFallSpeed === 'number'"),
    "beginRun() must snapshot the run's capsule fall speed into a named module var");
  assert(
    g.q("typeof runPaddleKeySpeed === 'number'"),
    "beginRun() must snapshot the run's keyboard paddle speed into a named module var");
  assert(
    g.q("runCapsuleFallSpeed") === g.q("CAPSULE_FALL_SPEED") * want,
    `the run's capsule fall speed must be CAPSULE_FALL_SPEED * ${want} exactly, got ${g.q("runCapsuleFallSpeed")}`);
  assert(
    g.q("runPaddleKeySpeed") === g.q("PADDLE_SPEED") * want,
    `the run's keyboard paddle speed must be PADDLE_SPEED * ${want} exactly, got ${g.q("runPaddleKeySpeed")}`);
});

check("AC4: a mid-run slider move changes NEITHER speed live; the next run re-snapshots", () => {
  const g = boot(960, 600);
  setSlider(g, 150);
  start(g);
  assert(g.state() === "playing", "setup: the run must be playing");
  const fifteen = g.q("CAPSULE_FALL_SPEED") * 1.5;
  assert(g.q("runCapsuleFallSpeed") === fifteen, "setup: 150% snapshot");
  assert(g.q("runPaddleKeySpeed") === g.q("PADDLE_SPEED") * 1.5, "setup: 150% snapshot");
  // Mid-run drag to 100%: the run must keep flying at the old tempo.
  setSlider(g, 100);
  assert(
    g.q("runCapsuleFallSpeed") === fifteen,
    "a mid-run slider move must not change the run's capsule fall speed");
  assert(
    g.q("runPaddleKeySpeed") === g.q("PADDLE_SPEED") * 1.5,
    "a mid-run slider move must not change the run's keyboard paddle speed");
  // The old tempo still drives the capsule live.
  g.dropCapsule(60, 100);
  const y0 = g.capY();
  g.tick(10);
  assertClose(g.capY() - y0, (fifteen / FRAMES_PER_SEC) * 10, (fifteen / FRAMES_PER_SEC) * 10 * 0.01,
    "the capsule must keep falling at the pre-move 150% rate mid-run");
  // The next run re-snapshots the moved slider (pause, M to the
  // start screen — beginRun() drains the run there).
  g.key("keydown", "Escape");
  assert(g.state() === "paused", "setup: Escape pauses the run");
  g.key("keydown", "KeyM");
  assert(g.state() === "start", "setup: M abandons a paused run to the start screen");
  assert(
    g.q("runCapsuleFallSpeed") === g.q("CAPSULE_FALL_SPEED"),
    "the next run must snapshot the 100% capsule fall speed");
  assert(
    g.q("runPaddleKeySpeed") === g.q("PADDLE_SPEED"),
    "the next run must snapshot the 100% keyboard paddle speed");
});

// ================================================================
// AC1: at 150% the whole tempo moves — capsule and keyboard
// paddle fly 1.5× their base rates (driven-frame displacement,
// 1% tolerance per the existing pattern).
// ================================================================
check("AC1: at 150% a dropped capsule falls 1.5× the base fall speed per frame", () => {
  const g = boot(960, 600);
  setSlider(g, 150);
  start(g);
  g.dropCapsule(60, 100);
  const y0 = g.capY();
  g.tick(30);
  assert(g.capActive() === true, "sanity: the capsule must still be airborne");
  const want = (g.q("CAPSULE_FALL_SPEED") * 1.5 / FRAMES_PER_SEC) * 30;
  assertClose(g.capY() - y0, want, want * 0.01,
    "the capsule's y-displacement over 30 frames at 150% must be 1.5× the base");
});

check("AC1: at 150% the keyboard-held paddle moves 1.5× the base keyspeed per frame", () => {
  const g = boot(960, 600);
  setSlider(g, 150);
  start(g);
  g.q("paddle.x = canvas.width / 2;");
  g.key("keydown", "ArrowRight");
  g.tick(10);
  const d = g.paddleX() - g.q("canvas.width / 2");
  const want = (g.q("PADDLE_SPEED") * 1.5 / FRAMES_PER_SEC) * 10;
  assertClose(d, want, want * 0.01,
    "the paddle's displacement over 10 held frames at 150% must be 1.5× the base");
  g.key("keyup", "ArrowRight");
});

check("AC1: at 150% the faster keyboard paddle respects the existing wall clamp", () => {
  const g = boot(960, 600);
  setSlider(g, 150);
  start(g);
  g.q("paddle.x = canvas.width / 2;");
  g.key("keydown", "ArrowRight");
  // 150% reaches the right wall (~50 frames) well before 55, while
  // the 100% base rate only reaches the wall at ~frame 75 (~240 px
  // short at frame 55) — so the assert discriminates the scale.
  g.tick(55);
  const wall = g.q("canvas.width - paddleW / 2");
  assert(g.paddleX() === wall,
    `the held paddle must clamp at the right wall (x=${wall}), got ${g.paddleX()}`);
  g.key("keyup", "ArrowRight");
});

// ================================================================
// AC2: at 100% the snapshot factor is exactly 1 — the hot path
// consumes a value BITWISE IDENTICAL to today's base named vars,
// so the motion is byte-identical, not merely approximate.
// ================================================================
check("AC2: at 100% both run snapshots are bitwise-identical to the base named vars", () => {
  const g = boot(960, 600);
  start(g);
  assert(g.q("ballSpeedPct") === 100, "setup: the default percent is 100");
  assert(
    g.q("runCapsuleFallSpeed") === g.q("CAPSULE_FALL_SPEED"),
    "at 100% the run's capsule fall speed must be BITWISE-identical to CAPSULE_FALL_SPEED");
  assert(
    g.q("runPaddleKeySpeed") === g.q("PADDLE_SPEED"),
    "at 100% the run's keyboard paddle speed must be BITWISE-identical to PADDLE_SPEED");
});

check("AC2: at 100% capsule fall and keyboard paddle match today's (unscaled) displacement", () => {
  const g = boot(960, 600);
  start(g);
  g.dropCapsule(60, 100);
  const y0 = g.capY();
  g.tick(30);
  const wantY = (g.q("CAPSULE_FALL_SPEED") / FRAMES_PER_SEC) * 30;
  assertClose(g.capY() - y0, wantY, wantY * 0.01,
    "the capsule's y-displacement over 30 frames at 100% must equal today's");
  g.q("capsules[0].active = false; paddle.x = canvas.width / 2; 1");
  g.key("keydown", "ArrowRight");
  const x0 = g.paddleX();
  g.tick(30);
  const wantX = (g.q("PADDLE_SPEED") / FRAMES_PER_SEC) * 30;
  assertClose(g.paddleX() - x0, wantX, wantX * 0.01,
    "the paddle's displacement over 30 held frames at 100% must equal today's");
  g.key("keyup", "ArrowRight");
});

// ================================================================
// AC3: at 50% the whole tempo halves — both 0.5× base.
// ================================================================
check("AC3: at 50% a dropped capsule falls 0.5× the base fall speed per frame", () => {
  const g = boot(960, 600);
  setSlider(g, 50);
  start(g);
  g.dropCapsule(60, 100);
  const y0 = g.capY();
  g.tick(30);
  const want = (g.q("CAPSULE_FALL_SPEED") * 0.5 / FRAMES_PER_SEC) * 30;
  assertClose(g.capY() - y0, want, want * 0.01,
    "the capsule's y-displacement over 30 frames at 50% must be 0.5× the base");
});

check("AC3: at 50% the keyboard-held paddle moves 0.5× the base keyspeed per frame", () => {
  const g = boot(960, 600);
  setSlider(g, 50);
  start(g);
  g.q("paddle.x = canvas.width / 2;");
  g.key("keydown", "ArrowRight");
  g.tick(10);
  const d = g.paddleX() - g.q("canvas.width / 2");
  const want = (g.q("PADDLE_SPEED") * 0.5 / FRAMES_PER_SEC) * 10;
  assertClose(d, want, want * 0.01,
    "the paddle's displacement over 10 held frames at 50% must be 0.5× the base");
  g.key("keyup", "ArrowRight");
});

// ================================================================
// AC5: the pointer-driven paddle follows POSITION, never a speed
// — the same gesture must land the paddle at the bitwise-same x
// at any slider setting (the mapping is a pure function of the
// rect and the cursor, #95).
// ================================================================
check("AC5: pointer-driven paddle landing is unchanged by the factor (100% vs 150%)", () => {
  const slow = boot(960, 600);
  const fast = boot(960, 600);
  start(slow);
  setSlider(fast, 150);
  start(fast);
  const gesture = (g) => {
    g.q("paddle.x = canvas.width / 2;");
    // A far in-rect move, then a second event: with 1:1 tracking
    // the landing is a pure function of the rect mapping — the
    // cursor's final clientX (890/960 · canvas.width), whatever the
    // run's factor.
    g.mouseMove(900);
    g.mouseMove(890);
    return g.paddleX();
  };
  const xSlow = gesture(slow);
  const xFast = gesture(fast);
  assert(xSlow === xFast,
    `the pointer gesture must land the paddle at the identical x regardless of the run's factor: 100% -> ${xSlow}, 150% -> ${xFast}`);
  const want = slow.q("(890 / 960) * canvas.width");
  assert(xFast === want,
    `the gesture's final event must land the paddle at the rect-mapped x (${want}), got ${xFast}`);
});

// ================================================================
// House constraint: the file stays self-contained.
// ================================================================
check("the file gains no external references", () => {
  const ext = (html.match(/(src|href)=/g) ?? []).length;
  assert(ext === 0, `bricks.html must stay self-contained (0 src/href), found ${ext}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
