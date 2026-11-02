#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html: timed power-up durations doubled
// (ticket #100)
//
// Timed powerups expired before the ball completed a round trip.
// The fix doubles the five named durations:
//   PADDLE_EXPAND_DURATION_S   6 -> 12
//   STICKY_DURATION_S          6 -> 12
//   MULT_DURATION_S            6 -> 12
//   INVULNERABLE_DURATION_S    6 -> 12
//   BLAST_DURATION_S           5 -> 10
// Extra/Life remain instant (no duration). Base game speed is
// deliberately UNTOUCHED (see docs/DECISIONS.md, ticket #100).
//
// Same harness style as tests/bricks-powerups.test.mjs: the real
// <script> from bricks.html runs in a sandboxed vm context; timing
// is asserted by driving the captured requestAnimationFrame
// callback at a fixed 60 fps clock and sampling game state. Effects
// are applied through the game's own applyCapsule(), so the expiry
// stamps and liveness predicates are the ones production uses. No
// network, no external services.
//
// Run: node tests/bricks-powerup-durations.test.mjs
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
  };
  return el;
}

function makeCtx() {
  const noop = () => {};
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        return noop;
      },
      set(_t, _prop, _value) {
        return true;
      },
    }
  );
}

// Boot a fresh copy of the game on a width×height viewport.
function boot(width = 960, height = 600) {
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
  let rafCb = null;
  let rafId = 0;
  const sandbox = {
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {
      innerWidth: width,
      innerHeight: height,
      addEventListener: () => {},
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
    q,
    tick,
    simTime: () => q("simTime"),
    paddleW: () => q("paddleW"),
    baseW: () => q("BASE_PADDLE_W"),
    paddleX: () => q("paddle.x"),
    // Balls: { active, attached, x, y, vx, vy } for slot 0.
    ball0: () =>
      q("(() => { const b = balls[0]; return { active: b.active, attached: b.attached, x: b.x, y: b.y, vx: b.vx, vy: b.vy }; })()"),
  };
}

// Begin a run: the start button click + one settle frame.
const start = (g) => {
  g.q("document.getElementById('btn-start').click()");
  g.tick(1);
};

// Clear the whole brick field so the descended ball has a straight lane.
const clearBricks = (g) =>
  g.q("for (var i = 0; i < bricks.length; i += 1) bricks[i].active = false; bricksLeft = 0; 1");

// Drive the 60 fps clock until simTime reaches target.
function stepUntil(g, target, maxFrames = 2400) {
  let guard = maxFrames;
  while (g.simTime() < target && guard > 0) {
    g.tick(1);
    guard -= 1;
  }
  assert(g.simTime() >= target, `the clock must reach ${target}, at ${g.simTime()}`);
}

// The five (variable, new value, previous value) pins from the ticket.
const DURATIONS = [
  ["PADDLE_EXPAND_DURATION_S", 12, 6],
  ["STICKY_DURATION_S", 12, 6],
  ["MULT_DURATION_S", 12, 6],
  ["INVULNERABLE_DURATION_S", 12, 6],
  ["BLAST_DURATION_S", 10, 5],
];

// ================================================================
// Criterion 1: the five timed durations are pinned at exactly
// 2x their previous game-time values, kept as the existing named
// top-level console-retunable vars
// ================================================================
check("the five timed powerup durations are pinned at exactly 2x their previous values (12/12/12/12/10)", () => {
  const g = boot(960, 600);
  for (const [name, wanted, previous] of DURATIONS) {
    const D = g.q(name);
    assert(typeof D === "number", `${name} must be a named numeric var, got ${typeof D}`);
    assert(D === wanted,
      `${name} must be exactly ${wanted} (2x the previous ${previous}), got ${D}`);
    assert(D === 2 * previous,
      `${name} (${D}) must be exactly double the previous game-time (${previous})`);
    // House style: a top-level `var` declaration, so the console can retune it.
    const declared = new RegExp(`^var ${name}\\s*=`, "m").test(gameSource);
    assert(declared, `${name} must stay a top-level \`var\` declaration`);
  }
});

check("instant kinds stay instant: no extra/life duration var exists", () => {
  assert(!/var\s+(EXTRA|LIFE)_DURATION_S/.test(gameSource),
    "extra/life are instant effects and must not gain a duration var");
});

// ================================================================
// Criterion 2: an effect applied at simTime T still holds at
// T + D/2 and is gone at T + D (observed through the effect's own
// observable state, per kind)
// ================================================================
check("expand applied at T: the paddle is widened at T+D/2 and back to base width at T+D", () => {
  const g = boot(960, 600);
  start(g);
  const D = g.q("PADDLE_EXPAND_DURATION_S");
  const widened = g.baseW() * g.q("PADDLE_EXPAND_FACTOR");
  const T = g.simTime();
  g.q("applyCapsule(KIND_EXPAND)");
  assert(g.q("expandUntil") === T + D, `setup: expiry armd at T + D (${T + D}), got ${g.q("expandUntil")}`);
  stepUntil(g, T + D / 2);
  assert(g.paddleW() === widened,
    `the paddle must still be widened at T+D/2 (sim ${g.simTime()}), got ${g.paddleW()}`);
  stepUntil(g, T + D + 1 / 60);
  assert(g.paddleW() === g.baseW(),
    `the paddle must be back to the base width once simTime passes T+D (sim ${g.simTime()}), got ${g.paddleW()}`);
});

check("sticky applied at T: a ball hitting the paddle at T+D/2 still attaches (effect holds)", () => {
  const g = boot(960, 600);
  start(g);
  clearBricks(g);
  const D = g.q("STICKY_DURATION_S");
  const T = g.simTime();
  g.q("applyCapsule(KIND_STICKY)");
  assert(g.q("stickyUntil") === T + D, `setup: expiry armed at T + D (${T + D}), got ${g.q("stickyUntil")}`);
  // Descend ball 0 straight down onto the paddle, timed so its
  // contact lands within one frame of T + D/2 (deep inside the window).
  const y0 = 100;
  const dist = g.q("paddleTop()") - g.q("BALL_RADIUS") - y0;
  const v = dist / (D / 2);
  g.q(`paddle.x = 100;
       balls[0].x = 100; balls[0].y = ${y0}; balls[0].vx = 0; balls[0].vy = ${v}; balls[0].attached = false;`);
  let guard = 1800;
  while (!g.ball0().attached && guard > 0) {
    g.tick(1);
    guard -= 1;
  }
  assert(g.ball0().attached,
    `a paddle contact at ~T+D/2 (sim ${g.simTime()}) must attach the ball — sticky still holds`);
});

check("sticky applied at T: a ball hitting the paddle just after T+D reflects, not catches (effect gone)", () => {
  const g = boot(960, 600);
  start(g);
  clearBricks(g);
  const D = g.q("STICKY_DURATION_S");
  const T = g.simTime();
  g.q("applyCapsule(KIND_STICKY)");
  // Descend ball 0 so its contact lands a few frames AFTER T + D.
  const y0 = 100;
  const dist = g.q("paddleTop()") - g.q("BALL_RADIUS") - y0;
  const v = dist / (D + 5 / 60);
  g.q(`paddle.x = 100;
       balls[0].x = 100; balls[0].y = ${y0}; balls[0].vx = 0; balls[0].vy = ${v}; balls[0].attached = false;`);
  let reflected = false;
  let guard = 2400;
  while (!reflected && guard > 0) {
    g.tick(1);
    guard -= 1;
    if (g.ball0().vy < 0) reflected = true;
  }
  assert(reflected, `the ball must eventually reflect off the paddle (sim=${g.simTime()})`);
  assert(g.simTime() > T + D,
    `the contact must land after the expiry (${T + D}), at sim ${g.simTime()}`);
  const b = g.ball0();
  assert(!b.attached,
    `a paddle contact after T+D must reflect, not catch (sim ${g.simTime()})`);
  assert(b.vy < 0, "the reflected ball leaves the paddle upward");
});

check("multiplier applied at T: the score window is still armed at T+D/2 and cleared by updatePowerups() at T+D", () => {
  const g = boot(960, 600);
  start(g);
  const D = g.q("MULT_DURATION_S");
  const T = g.simTime();
  g.q("applyCapsule(KIND_MULTIPLIER)");
  assert(g.q("multUntil") === T + D, `setup: expiry armed at T + D (${T + D}), got ${g.q("multUntil")}`);
  stepUntil(g, T + D / 2);
  assert(g.q("multUntil") !== -1 && g.q("simTime < multUntil"),
    `the multiplier window must still be armed at T+D/2 (sim ${g.simTime()})`);
  stepUntil(g, T + D + 1 / 60);
  assert(g.q("multUntil") === -1,
    `once simTime passes T+D the window must be cleared, got ${g.q("multUntil")} (sim ${g.simTime()})`);
});

check("invulnerable applied at T: invulnActive() still true at T+D/2 and false at T+D", () => {
  const g = boot(960, 600);
  start(g);
  const D = g.q("INVULNERABLE_DURATION_S");
  const T = g.simTime();
  g.q("applyCapsule(KIND_INVULNERABLE)");
  assert(g.q("invulnUntil") === T + D, `setup: expiry armed at T + D (${T + D}), got ${g.q("invulnUntil")}`);
  stepUntil(g, T + D / 2);
  assert(g.q("invulnActive()") === true,
    `invulnActive() must still be true at T+D/2 (sim ${g.simTime()})`);
  stepUntil(g, T + D + 1 / 60);
  assert(g.q("invulnActive()") === false,
    `invulnActive() must be false once simTime passes T+D (sim ${g.simTime()})`);
});

check("blast applied at T: blastActive() still true at T+D/2 and false at T+D", () => {
  const g = boot(960, 600);
  start(g);
  const D = g.q("BLAST_DURATION_S");
  const T = g.simTime();
  g.q("applyCapsule(KIND_BLAST)");
  assert(g.q("blastUntil") === T + D, `setup: expiry armed at T + D (${T + D}), got ${g.q("blastUntil")}`);
  stepUntil(g, T + D / 2);
  assert(g.q("blastActive()") === true,
    `blastActive() must still be true at T+D/2 (sim ${g.simTime()})`);
  stepUntil(g, T + D + 1 / 60);
  assert(g.q("blastActive()") === false,
    `blastActive() must be false once simTime passes T+D (sim ${g.simTime()})`);
});

// ================================================================
// Criterion 3: the operator's "maybe the base game speed is too
// slow?" question is a QUESTION, not a directive — the base speed
// and the speed curve stay untouched; the BALL SPEED slider (50-150%)
// remains the tempo escape hatch
// ================================================================
check("base serve speed and the level speed curve are untouched; the ball-speed slider stays the tempo knob", () => {
  const g = boot(960, 600);
  // The ticket pins the base explicitly; this guards against a
  // drive-by tempo change smuggled in with the duration fix.
  assert(g.q("BALL_SERVE_SPEED") === 480,
    `BALL_SERVE_SPEED must stay at its documented base 480, got ${g.q("BALL_SERVE_SPEED")}`);
  assert(g.q("LEVEL_SPEED_GROWTH") === 1.15,
    `LEVEL_SPEED_GROWTH must stay at 1.15, got ${g.q("LEVEL_SPEED_GROWTH")}`);
  // The slider escape hatch keeps its 50-150% range.
  assert(g.q("MIN_BALL_SPEED_PCT") === 50 && g.q("MAX_BALL_SPEED_PCT") === 150,
    `the ball-speed slider range must stay 50-150, got ${g.q("MIN_BALL_SPEED_PCT")}-${g.q("MAX_BALL_SPEED_PCT")}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
