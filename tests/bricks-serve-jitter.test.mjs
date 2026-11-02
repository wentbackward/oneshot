#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html serve launch jitter (ticket #97:
// kill the straight-up column eater)
//
// The exploit: a ball served from the paddle CENTRE gets rel=0 ->
// sin(0)=0 -> a perfectly vertical launch. Repeating "never move
// the paddle" eats a whole column straight up and down.
//
// The fix under test: launchAttachedBalls adds a small random
// lateral jitter drawn through the mutable `random` hook:
//   ang = rel * MAX_PADDLE_BOUNCE_ANGLE + (random()*2 - 1) * LAUNCH_JITTER_ANGLE
//
// Same harness style as the sibling bricks suites: runs the REAL
// <script> from bricks.html in a sandboxed vm context with stubbed
// window/document/canvas. `random` is pinned to known draws so every
// launch vector is fully determined. No network, no external
// services.
//
// Criteria covered:
//   (a) the launch vector is NOT exactly vertical at the centre for
//       a pinned random value;
//   (b) vy is strictly negative (upward) for every sampled launch
//       across the full rel sweep (centre, quarter, rim both sides)
//       at the worst-case jitter pins;
//   (c) LAUNCH_JITTER_ANGLE is a top-level var (retunable) and
//       setting it to 0 reproduces the pre-jitter angle law exactly
//       (zero-jitter reference), proving the jitter perturbs the
//       vector.
//
// Run: node tests/bricks-serve-jitter.test.mjs
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
function assertClose(a, b, eps, msg) {
  if (Math.abs(a - b) > eps) throw new Error(`${msg} (got ${a}, want ${b})`);
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
    requestAnimationFrame: () => 1,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);
  const q = (expr) => vm.runInContext(expr, context);
  // Click Start and pin `random` to a constant draw. A draw of 1 is
  // >= any drop rate, so no capsule can drop by chance mid-test.
  function startRun(randomDraw) {
    els["btn-start"].click();
    q(`random = function () { return ${randomDraw}; };`);
  }
  // Ride the serve ball at the given rel offset from the paddle
  // centre (clamped to the rim by launchAttachedBalls itself).
  function parkAtRel(rel) {
    q(`balls[0].x = paddle.x + ${rel} * (paddleW / 2); 1`);
  }
  return { canvas, els, q, startRun, parkAtRel };
}

// ================================================================
// Criterion (c): LAUNCH_JITTER_ANGLE is a top-level var (retunable)
// ================================================================
check("LAUNCH_JITTER_ANGLE is a top-level var: a finite positive number, readable at global scope", () => {
  const g = boot(960, 600);
  const t = g.q("typeof LAUNCH_JITTER_ANGLE");
  assert(t === "number", `LAUNCH_JITTER_ANGLE must be a top-level var, typeof=${t}`);
  const v = g.q("LAUNCH_JITTER_ANGLE");
  assert(Number.isFinite(v) && v > 0 && v < Math.PI / 2,
    `LAUNCH_JITTER_ANGLE must be a sane positive bound, got ${v}`);
});

check("LAUNCH_JITTER_ANGLE is retunable: changing the knob changes the centre launch vector accordingly", () => {
  const DRAW = 0.25; // pinned draw: jitter = (DRAW*2 - 1) * J
  const mk = (J) => {
    const g = boot(960, 600);
    g.startRun(DRAW);
    g.q(`LAUNCH_JITTER_ANGLE = ${J};`);
    g.canvas.dispatch("click", { type: "click" });
    return g;
  };
  const run0 = mk(0.12);
  const v0 = run0.q("[balls[0].vx, balls[0].vy]");
  const run1 = mk(0.2);
  const v1 = run1.q("[balls[0].vx, balls[0].vy]");
  assert(v0[0] !== v1[0],
    `the knob must actually steer the launch, vx(0.12)=${v0[0]} vs vx(0.2)=${v1[0]}`);
  // Each run must sit exactly on the documented angle law for ITS knob.
  for (const [g, vel, J] of [[run0, v0, 0.12], [run1, v1, 0.2]]) {
    const speed = g.q("serveSpeed");
    const ang = (DRAW * 2 - 1) * J; // centre serve: rel = 0
    assertClose(vel[0], speed * Math.sin(ang), 1e-9, `vx must follow the law at knob ${J}`);
    assertClose(vel[1], -speed * Math.cos(ang), 1e-9, `vy must follow the law at knob ${J}`);
  }
});

check("every launch sits exactly on ang = rel*MAX_PADDLE_BOUNCE_ANGLE + (draw*2-1)*LAUNCH_JITTER_ANGLE", () => {
  const DRAW = 0.75; // positive-side jitter: (0.75*2-1) = +0.5
  for (const rel of [0, 1]) {
    const gg = boot(960, 600);
    gg.startRun(DRAW);
    if (rel !== 0) gg.parkAtRel(rel);
    gg.canvas.dispatch("click", { type: "click" });
    const speed = gg.q("serveSpeed");
    const ang =
      rel * gg.q("MAX_PADDLE_BOUNCE_ANGLE") +
      (DRAW * 2 - 1) * gg.q("LAUNCH_JITTER_ANGLE");
    const got = gg.q("[balls[0].vx, balls[0].vy]");
    assertClose(got[0], speed * Math.sin(ang), 1e-9, `vx must match the jittered angle law at rel=${rel}`);
    assertClose(got[1], -speed * Math.cos(ang), 1e-9, `vy must match the jittered angle law at rel=${rel}`);
  }
});

// ================================================================
// Criterion (a): a centre serve is NOT exactly vertical for a
// pinned random value
// ================================================================
check("a centre serve with a pinned non-centre random draw is NOT perfectly vertical (vx != 0)", () => {
  const DRAW = 0.25; // jitter = -0.5 * LAUNCH_JITTER_ANGLE (negative side)
  const g = boot(960, 600);
  g.startRun(DRAW);
  g.canvas.dispatch("click", { type: "click" });
  const b = g.q("({ vx: balls[0].vx, vy: balls[0].vy })");
  assert(b.vx !== 0,
    `the centre serve must not be perfectly vertical, got vx=${b.vx} (the column-eater exploit)`);
  assert(b.vx < 0, `draw ${DRAW} is the negative jitter side, vx must be < 0, got ${b.vx}`);
  assert(b.vy < 0, `the ball must leave upward, vy=${b.vy}`);
  assertClose(Math.hypot(b.vx, b.vy), g.q("serveSpeed"), 1e-9,
    "the jitter rotates the vector, it must not scale the serve speed");
});

check("a centre serve with a pinned positive-side draw kicks right, still upward, still at serve speed", () => {
  const DRAW = 0.75; // jitter = +0.5 * LAUNCH_JITTER_ANGLE
  const g = boot(960, 600);
  g.startRun(DRAW);
  g.canvas.dispatch("click", { type: "click" });
  const b = g.q("({ vx: balls[0].vx, vy: balls[0].vy })");
  assert(b.vx > 0, `draw ${DRAW} is the positive jitter side, vx must be > 0, got ${b.vx}`);
  assert(b.vy < 0, `the ball must leave upward, vy=${b.vy}`);
  assertClose(Math.hypot(b.vx, b.vy), g.q("serveSpeed"), 1e-9, "speed must stay exactly the serve speed");
});

// Edge: the one draw (0.5) that makes the jitter term itself zero is
// the ONLY draw allowed to produce a vertical launch — jitter is the
// sole new degree of freedom, and it is provably random, not bias.
check("only the measure-zero draw 0.5 (zero jitter) yields a vertical launch; draws on both sides of it diverge from vertical", () => {
  const g = boot(960, 600);
  g.startRun(0.5);
  g.canvas.dispatch("click", { type: "click" });
  assert(g.q("balls[0].vx") === 0,
    `with a zero-jitter draw the launch must equal the old centre law exactly, vx=${g.q("balls[0].vx")}`);
  for (const draw of [0.49, 0.51]) {
    const gg = boot(960, 600);
    gg.startRun(draw);
    gg.canvas.dispatch("click", { type: "click" });
    const vx = gg.q("balls[0].vx");
    assert(vx !== 0, `draw ${draw} must disturb the vertical launch, got vx=${vx}`);
    assert((draw < 0.5) === (vx < 0),
      `draw ${draw} must land on the expected side, vx=${vx}`);
  }
});

// ================================================================
// Criterion (b): the ball ALWAYS leaves upward — vy strictly
// negative across the full rel sweep at BOTH worst-case jitter pins
// (draw 0 => jitter -max, draw 1 => jitter +max)
// ================================================================
check("worst-case negative jitter (draw 0): vy is strictly negative across the full rel sweep (centre, quarter, rim both sides)", () => {
  for (const rel of [0, 0.5, -0.5, 1, -1]) {
    const g = boot(960, 600);
    g.startRun(0); // jitter = -LAUNCH_JITTER_ANGLE, the full swing left
    if (rel !== 0) g.parkAtRel(rel);
    g.canvas.dispatch("click", { type: "click" });
    const b = g.q("({ vx: balls[0].vx, vy: balls[0].vy, attached: balls[0].attached })");
    assert(b.attached === false, `setup: the serve must be launched at rel=${rel}`);
    assert(b.vy < 0,
      `every launch must leave upward, rel=${rel} draw=0 gave vy=${b.vy}`);
    const ang = Math.atan2(b.vx, -b.vy);
    assert(ang <= Math.PI / 3 + 0.14 + 1e-9 && ang >= -(Math.PI / 3 + 0.14 + 1e-9),
      `the launch angle must stay inside the documented bound at rel=${rel}, ang=${ang}`);
  }
});

check("worst-case positive jitter (draw 1): vy is strictly negative across the full rel sweep (centre, quarter, rim both sides)", () => {
  for (const rel of [0, 0.5, -0.5, 1, -1]) {
    const g = boot(960, 600);
    g.startRun(1); // jitter = +LAUNCH_JITTER_ANGLE, the full swing right
    if (rel !== 0) g.parkAtRel(rel);
    g.canvas.dispatch("click", { type: "click" });
    const b = g.q("({ vx: balls[0].vx, vy: balls[0].vy, attached: balls[0].attached })");
    assert(b.attached === false, `setup: the serve must be launched at rel=${rel}`);
    assert(b.vy < 0,
      `every launch must leave upward, rel=${rel} draw=1 gave vy=${b.vy}`);
    assertClose(Math.hypot(b.vx, b.vy), g.q("serveSpeed"), 1e-9,
      "the serve speed is preserved for every swept launch");
  }
});

// The documented analytic bound, pinned against the source constants:
// |rel|*MAX_PADDLE_BOUNCE_ANGLE + LAUNCH_JITTER_ANGLE must stay
// strictly below PI/2, which is what guarantees vy < 0 forever.
check("analytic bound: PI/3 + LAUNCH_JITTER_ANGLE < PI/2 (the guarantee that vy < 0 for the full rel range)", () => {
  const g = boot(960, 600);
  const bound = g.q("MAX_PADDLE_BOUNCE_ANGLE + LAUNCH_JITTER_ANGLE");
  assert(bound < Math.PI / 2,
    `the worst-case launch angle (${bound} rad) must stay below PI/2 so cos stays positive`);
});

// ================================================================
// Zero-jitter reference: LAUNCH_JITTER_ANGLE = 0 reproduces the
// pre-jitter angle law bit-for-bit, and the default knob perturbs a
// centre launch AWAY from that reference — proving the jitter is the
// thing moving the vector.
// ================================================================
check("zero-jitter reference: with LAUNCH_JITTER_ANGLE = 0 a centre serve is exactly (0, -serveSpeed) for ANY draw", () => {
  for (const draw of [0, 0.25, 0.75, 1]) {
    const g = boot(960, 600);
    g.startRun(draw);
    g.q("LAUNCH_JITTER_ANGLE = 0;");
    g.canvas.dispatch("click", { type: "click" });
    const b = g.q("({ vx: balls[0].vx, vy: balls[0].vy })");
    assert(b.vx === 0,
      `zero jitter must restore the old vertical centre law for draw ${draw}, vx=${b.vx}`);
    assertClose(b.vy, -g.q("serveSpeed"), 1e-9,
      `zero jitter must leave straight up at serve speed for draw ${draw}, vy=${b.vy}`);
  }
});

check("the default knob perturbs the centre launch away from the zero-jitter reference (the jitter actually bites)", () => {
  const DRAW = 0.75;
  const ref = boot(960, 600);
  ref.startRun(DRAW);
  ref.q("LAUNCH_JITTER_ANGLE = 0;");
  ref.canvas.dispatch("click", { type: "click" });
  const refV = ref.q("[balls[0].vx, balls[0].vy]");
  const live = boot(960, 600);
  live.startRun(DRAW); // default knob
  live.canvas.dispatch("click", { type: "click" });
  const liveV = live.q("[balls[0].vx, balls[0].vy]");
  assert(liveV[0] !== refV[0] || liveV[1] !== refV[1],
    `the jittered launch must differ from the zero-jitter reference, both ${JSON.stringify(refV)} vs ${JSON.stringify(liveV)}`);
  // and it differs EXACTLY by the pinned jitter term, nothing else.
  const J = live.q("LAUNCH_JITTER_ANGLE");
  const speed = live.q("serveSpeed");
  assertClose(liveV[0], speed * Math.sin((DRAW * 2 - 1) * J), 1e-9, "the whole perturbation is the jitter term (vx)");
  assertClose(liveV[1], -speed * Math.cos((DRAW * 2 - 1) * J), 1e-9, "the whole perturbation is the jitter term (vy)");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
