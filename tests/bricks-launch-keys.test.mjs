#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html launching the attached ball from the
// keyboard (ticket #41: Space or Enter)
//
// Same harness style as tests/bricks-screens.test.mjs: runs the
// REAL <script> from bricks.html in a sandboxed vm context with
// stubbed window/document/localStorage/requestAnimationFrame and
// DOM element stubs that record styles and event listeners. The
// window keydown listener is edge-dispatched with the exact codes
// the ticket names ("Space", "Enter"). The launch-path identity
// test boots two otherwise-identical runs and asserts the keyboard
// launch produces bit-identical velocities to the canvas-click
// launch — same code path, no duplicate physics.
// Like every sibling suite, `random` is pinned so a capsule can
// never drop by chance mid-test. No network, no external services.
//
// Run: node tests/bricks-launch-keys.test.mjs
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

// A DOM element stub: records style writes, text and listeners.
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
function boot(width, height) {
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
  const q = (expr) => vm.runInContext(expr, context);
  const state = () =>
    q("typeof gameState === 'undefined' ? 'undefined' : gameState");
  // Boot, click Start, pin the RNG — slot 0 is now the attached
  // serve ball and NOTHING else is launched (no canvas click).
  function startRun() {
    els["btn-start"].click();
    q("random = function () { return 1; };"); // no capsule drops by chance
  }
  return { canvas, els, q, tick, key, state, startRun };
}

// ================================================================
// Criterion 1: Space / Enter keydown while "playing" launches the
// attached serve ball up at exactly serveSpeed, through the SAME
// path the canvas click uses
// ================================================================
check("Space keydown during 'playing' detaches the serve ball upward at exactly serveSpeed", () => {
  const g = boot(960, 600);
  g.startRun();
  assert(g.state() === "playing", "precondition: run must be playing");
  assert(g.q("balls[0].attached") === true, "precondition: slot 0 must be the attached serve");
  const serveSpeed = g.q("serveSpeed");
  g.key("keydown", "Space");
  assert(g.q("balls[0].attached") === false,
    `Space must detach the serve ball, attached=${g.q("balls[0].attached")}`);
  assert(g.q("balls[0].vy") < 0,
    `the launched ball must travel upward, vy=${g.q("balls[0].vy")}`);
  assert(Math.hypot(g.q("balls[0].vx"), g.q("balls[0].vy")) === serveSpeed,
    `the launch speed must equal serveSpeed exactly, got ${Math.hypot(g.q("balls[0].vx"), g.q("balls[0].vy"))}`);
});

check("Enter keydown (second run) detaches the serve ball upward at exactly serveSpeed", () => {
  const g = boot(960, 600);
  g.startRun();
  assert(g.state() === "playing", "precondition: run must be playing");
  assert(g.q("balls[0].attached") === true, "precondition: slot 0 must be the attached serve");
  const serveSpeed = g.q("serveSpeed");
  g.key("keydown", "Enter");
  assert(g.q("balls[0].attached") === false,
    `Enter must detach the serve ball, attached=${g.q("balls[0].attached")}`);
  assert(g.q("balls[0].vy") < 0,
    `the launched ball must travel upward, vy=${g.q("balls[0].vy")}`);
  assert(Math.hypot(g.q("balls[0].vx"), g.q("balls[0].vy")) === serveSpeed,
    `the launch speed must equal serveSpeed exactly, got ${Math.hypot(g.q("balls[0].vx"), g.q("balls[0].vy"))}`);
});

check("the keyboard launch is the SAME path as the click launch (bit-identical velocities at a true interior paddle offset, rel = 2/3)", () => {
  // Two otherwise-identical runs: same viewport, same pre-launch
  // paddle offset. One launches via canvas click, one via Space; the
  // resulting velocities must match exactly — the keyboard event
  // routes through launchAttachedBalls, it must not invent its own
  // physics. The paddle sits OFFSET_PX canvas px off the serve
  // ball's ride line, i.e. rel = OFFSET_PX / (paddleW/2) = 2/3 — a
  // TRUE interior offset (0 < rel < 1), so the sin/cos angle math
  // itself is pinned, not just the rel=±1 rim clamp. The offset is
  // also checked against an independent expectation computed from
  // the documented angle law (linear in rel, 60° from vertical at
  // the rim), not only by comparing the two runs against each other.
  const OFFSET_PX = 40; // 2/3 of the level-1 half-paddle (120/2 = 60)
  const mk = () => {
    const g = boot(960, 600);
    g.startRun();
    g.q(`paddle.x = balls[0].x - ${OFFSET_PX};`); // deterministic interior offset
    return g;
  };
  const byClick = mk();
  byClick.canvas.dispatch("click", { type: "click" });
  const byKey = mk();
  byKey.key("keydown", "Space");
  const REL = OFFSET_PX / byKey.q("paddleW / 2");
  assert(REL > 0 && REL < 1,
    `fixture sanity: the offset must be interior to the half-paddle (no rim clamp), rel=${REL}`);
  const serveSpeed = byKey.q("serveSpeed");
  // Independent expectation: serveSpeed * sin/cos(rel * PI/3).
  const expectVel = [
    serveSpeed * Math.sin(REL * (Math.PI / 3)),
    -serveSpeed * Math.cos(REL * (Math.PI / 3)),
  ];
  const clickVel = byClick.q("[balls[0].vx, balls[0].vy]");
  const keyVel = byKey.q("[balls[0].vx, balls[0].vy]");
  assert(JSON.stringify(clickVel) === JSON.stringify(keyVel),
    `keyboard launch must reproduce the click launch exactly,\n  key   ${JSON.stringify(keyVel)}\n  click ${JSON.stringify(clickVel)}`);
  assert(JSON.stringify(keyVel) === JSON.stringify(expectVel),
    `both launches must land on the interior angle law,\n  got      ${JSON.stringify(keyVel)}\n  expected ${JSON.stringify(expectVel)}`);
  assert(byKey.q("balls[0].attached") === false, "the serve must be detached after the Space launch");
});

// ================================================================
// Criterion 2: state gating — the identical Space keydown outside
// "playing" leaves every ball untouched and the state unchanged.
// Full state matrix: start / gameover / paused (+ playing is the
// launch case itself).
// ================================================================
check("Space keydown during 'start' leaves every ball untouched and the state unchanged", () => {
  const g = boot(960, 600);
  assert(g.state() === "start", "precondition: booted on the start screen");
  const before = g.q("JSON.stringify(balls)");
  g.key("keydown", "Space");
  g.tick(2);
  assert(g.state() === "start",
    `Space must not leave "start", state is ${g.state()}`);
  assert(g.q("JSON.stringify(balls)") === before,
    "Space during 'start' must leave the entire ball pool untouched");
});

check("Space keydown during 'gameover' leaves every ball untouched and the state unchanged", () => {
  const g = boot(960, 600);
  g.startRun();
  g.canvas.dispatch("click", { type: "click" });
  // Walk the real loseLife -> game-over path with one life left.
  g.q("lives = 1;");
  g.q("balls[0].attached = false; balls[0].y = canvas.height + 100;");
  g.tick(1);
  assert(g.state() === "gameover", `precondition: run must be over, state is ${g.state()}`);
  const before = g.q("JSON.stringify(balls)");
  g.key("keydown", "Space");
  g.tick(2);
  assert(g.state() === "gameover",
    `Space must not leave "gameover", state is ${g.state()}`);
  assert(g.q("JSON.stringify(balls)") === before,
    "Space during 'gameover' must leave the entire ball pool untouched");
});

check("Space and Enter keydown during 'paused' leave every ball untouched and the state unchanged", () => {
  const g = boot(960, 600);
  g.startRun();
  g.key("keydown", "Escape"); // the real pause path: playing -> paused
  assert(g.state() === "paused", `precondition: run must be paused, state is ${g.state()}`);
  assert(g.q("balls[0].attached") === true, "precondition: the serve must still ride the paddle");
  const pauseEl = g.els["screen-pause"];
  const marked = pauseEl.styleWrites.length;
  const before = g.q("JSON.stringify(balls)");
  g.key("keydown", "Space");
  g.key("keydown", "Enter");
  g.tick(2);
  assert(g.state() === "paused",
    `Space/Enter must not leave "paused" (no resume), state is ${g.state()}`);
  assert(g.q("JSON.stringify(balls)") === before,
    "Space/Enter during 'paused' must leave the entire ball pool untouched");
  assert(pauseEl.styleWrites.length === marked,
    `the pause overlay must stay up, untouched, new writes=${JSON.stringify(pauseEl.styleWrites.slice(marked))}`);
});

// ================================================================
// Criterion 3: Space/Enter are NOT pause keys — pressing Space while
// "playing" must not open the pause screen
// ================================================================
check("Space and Enter during 'playing' do not open the pause screen", () => {
  const g = boot(960, 600);
  g.startRun();
  g.canvas.dispatch("click", { type: "click" }); // launched, in flight
  const pauseEl = g.els["screen-pause"];
  const marked = pauseEl.styleWrites.length;
  g.key("keydown", "Space");
  g.key("keydown", "Enter");
  g.tick(2);
  assert(g.state() === "playing",
    `Space/Enter must not pause the run, state is ${g.state()}`);
  assert(pauseEl.styleWrites.length === marked,
    `the pause overlay must never have been touched, new writes=${JSON.stringify(pauseEl.styleWrites.slice(marked))}`);
  assert(pauseEl.style.display === "none", "the pause overlay must stay hidden");
});

// Auto-repeat edge: a repeat Space keydown of an ALREADY-launched
// ball is a no-op — velocity is left intact, no re-launch.
check("auto-repeat Space after the ball is launched re-triggers nothing (velocity untouched)", () => {
  const g = boot(960, 600);
  g.startRun();
  g.key("keydown", "Space"); // first press: launch
  assert(g.q("balls[0].attached") === false, "precondition: the serve must be launched");
  g.tick(5); // ball in flight, moving
  const velBefore = g.q("JSON.stringify([balls[0].vx, balls[0].vy])");
  g.key("keydown", "Space"); // browser auto-repeat while the key is held
  g.key("keydown", "Space");
  assert(g.q("balls[0].attached") === false, "the ball must stay in flight");
  assert(g.q("JSON.stringify([balls[0].vx, balls[0].vy])") === velBefore,
    `repeat keydowns of an unattached ball must not re-launch it, vel is ${velBefore}`);
  assert(g.state() === "playing", "state must stay 'playing'");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
