#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html power-up drops with the expand paddle
// (ticket #25)
//
// Same harness style as tests/bricks-grid.test.mjs: runs the REAL
// <script> from bricks.html in a sandboxed vm context with stubbed
// window/document/canvas/DOM elements. Timing is asserted by driving
// the captured requestAnimationFrame callback and sampling the
// runtime paddle width / sim clock each frame. Drops are forced
// deterministically by reassigning the game's mutable `random` hook;
// bricks are destroyed through the game's own destroyBrick()
// (console-style direct access). The ball is never launched — it
// rides the paddle while attached, so no physics interferes with
// the capsules. No network, no external services.
//
// Run: node tests/bricks-powerups.test.mjs
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
// set is allowed. When `fills` is given it receives one record per
// fillRect call: { style, x, y, w, h } — enough to audit what the
// draw pass renders.
function makeCtx(fills) {
  const noop = () => {};
  let style = "";
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        if (prop === "fillRect" && fills) {
          return (x, y, w, h) => {
            fills.push({ style, x, y, w, h });
          };
        }
        return noop;
      },
      set(_t, prop, value) {
        if (prop === "fillStyle") style = value;
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
    // Records CSS style writes (stage letterbox fit) and answers
    // getBoundingClientRect() with a rect filling the boot viewport.
    style: {},
    rect: { left: 0, top: 0, width, height },
    getBoundingClientRect: () => canvas.rect,
    listeners: {},
    getContext: () => makeCtx(fills),
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
    "difficulty-easy": makeEl("difficulty-easy"),
    "difficulty-normal": makeEl("difficulty-normal"),
    "difficulty-hard": makeEl("difficulty-hard"),
    "screen-gameover": makeEl("screen-gameover"),
    "btn-restart": makeEl("btn-restart"),
    "screen-pause": makeEl("screen-pause"),
    "btn-resume": makeEl("btn-resume"),
    "gameover-final": makeEl("gameover-final"),
    "hud-score": makeEl("hud-score"),
    "hud-level": makeEl("hud-level"),
    "hiscore": makeEl("hiscore"),
    lives: makeEl("lives"),
  };
  const winListeners = {};
  let rafCb = null;
  let rafId = 0;
  const fills = [];
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
  const q = (expr) => vm.runInContext(expr, context);
  return {
    els,
    canvas,
    winListeners,
    q,
    tick,
    // One fillRect record per call across the lifetime of this boot:
    // { style, x, y, w, h }.
    fills,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    lives: () => q("typeof lives === 'undefined' ? NaN : lives"),
    score: () => q("typeof score === 'undefined' ? NaN : score"),
    paddleX: () => q("typeof paddle === 'undefined' ? NaN : paddle.x"),
    // Power-up accessors
    paddleW: () => q("typeof paddleW === 'undefined' ? NaN : paddleW"),
    baseW: () => q("typeof BASE_PADDLE_W === 'undefined' ? NaN : BASE_PADDLE_W"),
    simTime: () => q("typeof simTime === 'undefined' ? NaN : simTime"),
    expandUntil: () => q("typeof expandUntil === 'undefined' ? NaN : expandUntil"),
    capsPoolLen: () => q("typeof capsules === 'undefined' ? -1 : capsules.length"),
    capsActive: () =>
      q("typeof capsules === 'undefined' ? -1 : capsules.reduce((n, c) => n + (c.active ? 1 : 0), 0)"),
    capsActiveInfo: () =>
      q("typeof capsules === 'undefined' ? [] : capsules.filter((c) => c.active).map((c) => ({ kind: c.kind, x: c.x, y: c.y }))"),
    brickAt(row, col) {
      const cols = q("BRICK_COLS");
      return q(`(() => {
        const t = bricks[${row * cols + col}];
        return { active: t.active, tier: t.tier, x: t.x, y: t.y, w: t.w, h: t.h };
      })()`);
    },
  };
}

const start = (g) => {
  g.els["btn-start"].click();
  g.tick(1);
};
const kill = (g, row, col) =>
  g.q(`destroyBrick(${row * g.q("BRICK_COLS") + col})`);

// Pin the game's mutable `random` hook so every drop roll lands the
// same way: low() always drops, high() never does.
function dropRolls(g) {
  const rate = g.q("POWERUP_DROP_RATE");
  assert(
    Number.isFinite(rate) && rate > 0 && rate < 1,
    `POWERUP_DROP_RATE must be a probability in (0,1), got ${rate}`
  );
  const low = () => g.q(`random = () => ${rate / 2}; 1`);
  const high = () => g.q(`random = () => ${Math.min(1 - 1e-9, rate * 1.5)}; 1`);
  return { rate, low, high };
}

// Aim the paddle at the given brick, destroy it with drops forced
// on, and drive frames until the capsule is caught. Returns the sim
// time of the catching frame.
function dropAndCatch(g, row, col, maxFrames = 600) {
  const b = g.brickAt(row, col);
  g.q(`paddle.x = ${b.x + b.w / 2}`);
  assert(b.active, `setup: the brick at (${row},${col}) must be alive`);
  kill(g, row, col);
  assert(g.capsActive() === 1, `setup: the kill must release exactly one capsule, got ${g.capsActive()}`);
  for (let i = 0; i < maxFrames && g.capsActive() === 1; i += 1) g.tick(1);
  assert(g.capsActive() === 0, "the capsule must be caught by the aimed paddle");
  assert(g.paddleW() !== g.baseW(), "the catch must widen the paddle");
  return g.simTime();
}

// ================================================================
// Criterion 1: destroyed bricks drop a power-up capsule with
// probability named POWERUP_DROP_RATE, routed through the mutable
// `random` hook; capsules come from a fixed pool (no allocation on
// drop)
// ================================================================
check("a destroyed brick drops a capsule with probability POWERUP_DROP_RATE, rolled through the mutable random hook", () => {
  const g = boot(960, 600);
  start(g);
  assert(g.capsActive() === 0, "setup: no capsules before any kill");
  const rolls = dropRolls(g);
  rolls.high(); // every roll misses the rate
  kill(g, 4, 5);
  kill(g, 4, 6);
  kill(g, 4, 7);
  assert(g.capsActive() === 0,
    `with every roll above the rate, no capsule may drop, active=${g.capsActive()}`);
  rolls.low(); // every roll hits the rate
  kill(g, 4, 8);
  assert(g.capsActive() === 1,
    `with every roll below the rate, the kill must drop exactly one capsule, active=${g.capsActive()}`);
});

check("capsule pool is fixed-size: a burst of forced drops never grows it and frees slots for later drops", () => {
  const g = boot(960, 600);
  start(g);
  const pool = g.q("CAPSULE_POOL_SIZE");
  assert(Number.isInteger(pool) && pool > 0, `CAPSULE_POOL_SIZE must be a positive integer, got ${pool}`);
  assert(g.capsPoolLen() === pool, `the pool starts at its named size, got ${g.capsPoolLen()}`);
  dropRolls(g).low();
  for (let c = 3; c < 10; c += 1) kill(g, 4, c); // seven forced drops
  assert(g.capsPoolLen() === pool,
    `the pool length must stay constant under drops, got ${g.capsPoolLen()}`);
  assert(g.capsActive() === pool,
    `the pool may hold at most its full size concurrently, active=${g.capsActive()}`);
  g.tick(420); // the whole batch falls past the bottom edge
  assert(g.capsActive() === 0,
    `missed capsules must free their slots, active=${g.capsActive()}`);
  kill(g, 0, 0);
  kill(g, 0, 1);
  assert(g.capsActive() === 2,
    `freed slots must be reused by later drops, active=${g.capsActive()}`);
  assert(g.capsPoolLen() === pool,
    `the pool length must still be constant, got ${g.capsPoolLen()}`);
});

check("every spawned capsule's kind is an entry of the enumerated CAPSULE_KINDS constant", () => {
  const g = boot(960, 600);
  start(g);
  const kinds = g.q("CAPSULE_KINDS");
  assert(Array.isArray(kinds) && kinds.length > 0, "CAPSULE_KINDS must be a non-empty array");
  assert(kinds.every((k) => Number.isInteger(k) && k >= 0),
    `kinds must be non-negative integers, got ${JSON.stringify(kinds)}`);
  assert(new Set(kinds).size === kinds.length, "kinds must be distinct");
  assert(g.q("KIND_EXPAND") === 0, `KIND_EXPAND must be 0, got ${g.q("KIND_EXPAND")}`);
  assert(kinds.includes(0), "KIND_EXPAND must be an entry of CAPSULE_KINDS");
  dropRolls(g).low();
  kill(g, 4, 9);
  const live = g.capsActiveInfo();
  assert(live.length === 1, `setup: one live capsule, got ${live.length}`);
  assert(kinds.includes(live[0].kind),
    `the dropped capsule's kind (${live[0].kind}) must be an entry of CAPSULE_KINDS`);
});

// ================================================================
// Criterion 2: a caught Expand capsule sets the paddle width to
// BASE_PADDLE_W * PADDLE_EXPAND_FACTOR for PADDLE_EXPAND_DURATION_S
// of simulation time, then restores the base width; a second Expand
// while active extends the expiry to now + the full duration (not
// additive). Timing asserted by driving the rAF callback and
// sampling widths.
// ================================================================
check("a caught expand sets the paddle width to exactly BASE_PADDLE_W * PADDLE_EXPAND_FACTOR (named constants, queried via vm)", () => {
  const g = boot(960, 600);
  start(g);
  const base = g.baseW();
  const factor = g.q("PADDLE_EXPAND_FACTOR");
  assert(Number.isFinite(base) && base > 0, `BASE_PADDLE_W must be positive, got ${base}`);
  assert(Number.isFinite(factor) && factor > 1, `PADDLE_EXPAND_FACTOR must exceed 1, got ${factor}`);
  assert(g.paddleW() === base, `setup: the resting width is the base width, got ${g.paddleW()}`);
  dropRolls(g).low();
  dropAndCatch(g, 4, 5);
  const widened = g.paddleW();
  assert(widened === base * factor,
    `the widened width must be exactly BASE_PADDLE_W * PADDLE_EXPAND_FACTOR (${base * factor}), got ${widened}`);
});

check("the widen lasts exactly PADDLE_EXPAND_DURATION_S of simulation time, then restores the base width", () => {
  const g = boot(960, 600);
  start(g);
  const D = g.q("PADDLE_EXPAND_DURATION_S");
  assert(typeof D === "number" && D > 0,
    `PADDLE_EXPAND_DURATION_S must be a named positive duration, got ${D}`);
  dropRolls(g).low();
  const t0 = dropAndCatch(g, 4, 5);
  const expiry = g.expandUntil();
  assert(expiry === t0 + D,
    `the catch must arm the expiry at catch time + full duration (${t0 + D}), got ${expiry}`);
  assert(g.paddleW() === g.baseW() * g.q("PADDLE_EXPAND_FACTOR"),
    "the paddle must be widened right after the catch");
  let guard = 0;
  while (g.simTime() < expiry && guard < 2000) {
    g.tick(1);
    guard += 1;
    if (g.simTime() < expiry) {
      assert(g.paddleW() === g.baseW() * g.q("PADDLE_EXPAND_FACTOR"),
        `the paddle must stay widened before its expiry (sim ${g.simTime()} < ${expiry})`);
    }
  }
  assert(g.simTime() >= expiry, `setup: the clock must reach the expiry, sim=${g.simTime()}`);
  assert(g.paddleW() === g.baseW(),
    `once the expiry passes the paddle must be back at the base width, got ${g.paddleW()}`);
  assertClose(g.simTime() - t0, D, 2 / 60,
    `the widen must last exactly D seconds of simulation time`);
});

check("a second expand caught while active extends the expiry to now + full duration — extended, not additive", () => {
  const g = boot(960, 600);
  start(g);
  const D = g.q("PADDLE_EXPAND_DURATION_S");
  const widened = g.baseW() * g.q("PADDLE_EXPAND_FACTOR");
  dropRolls(g).low();
  const t0 = dropAndCatch(g, 4, 5);
  const exp1 = g.expandUntil();
  assert(exp1 === t0 + D, `setup: first arm is t0 + D, got ${exp1}`);
  // Second capsule: same x column one row up, so it lands on the
  // aimed paddle well before the first arm would expire.
  const b = g.brickAt(3, 5);
  g.q(`paddle.x = ${b.x + b.w / 2}`);
  kill(g, 3, 5);
  assert(g.capsActive() === 1, "setup: the second kill releases one capsule");
  let t1 = null;
  for (let i = 0; i < 600 && t1 === null; i += 1) {
    g.tick(1);
    if (g.expandUntil() !== exp1) t1 = g.simTime();
  }
  assert(t1 !== null, "the second capsule must be caught while the widen is live");
  assert(t1 > t0, `the second catch must come after the first (${t1} > ${t0})`);
  assert(t1 < exp1, `the second catch must land before the first expiry, ${t1} vs ${exp1}`);
  const exp2 = g.expandUntil();
  assert(exp2 === t1 + D,
    `the re-arm must set the expiry to catch time + full duration (${t1 + D}), got ${exp2}`);
  assert(exp2 > exp1,
    `the expiry must extend beyond the first arm (extended), ${exp2} vs ${exp1}`);
  assert(exp2 < t0 + 2 * D,
    `the expiry must not be additive (would be t0 + 2D = ${t0 + 2 * D}), got ${exp2}`);
  assert(g.paddleW() === widened, "the paddle must stay widened across the re-arm");
  // Past the re-armed expiry the widen must end.
  let guard = 0;
  while (g.simTime() < exp2 && guard < 2000) {
    g.tick(1);
    guard += 1;
    if (g.simTime() < exp2) {
      assert(g.paddleW() === widened,
        `the paddle must stay widened before the re-armed expiry (sim ${g.simTime()} < ${exp2})`);
    }
  }
  assert(g.paddleW() === g.baseW(),
    `after the re-armed expiry the paddle must restore to the base width, got ${g.paddleW()}`);
});

// ================================================================
// Criterion 3: a missed capsule falls past the bottom edge, is
// deactivated, and has no further effect
// ================================================================
check("a missed capsule falls past the bottom edge, deactivates, and has no further effect", () => {
  const g = boot(960, 600);
  start(g);
  dropRolls(g).low();
  g.q(`paddle.x = BASE_PADDLE_W / 2`); // park the paddle far from the drop x
  kill(g, 4, 5);
  assert(g.capsActive() === 1, "setup: the capsule is live");
  const scoreBefore = g.score();
  g.tick(30);
  assert(g.capsActive() === 1,
    `the capsule must still be falling shortly after the drop, active=${g.capsActive()}`);
  g.tick(420);
  assert(g.capsActive() === 0,
    `the capsule must be gone once it has fallen past the bottom, active=${g.capsActive()}`);
  assert(g.paddleW() === g.baseW(),
    `a missed capsule must not affect the paddle width, got ${g.paddleW()}`);
  assert(g.score() === scoreBefore,
    `a missed capsule must not touch the score, got ${g.score()}`);
  assert(g.lives() === 3, `a missed capsule must not cost a life, lives=${g.lives()}`);
  assert(g.state() === "playing", `the run must continue, state=${g.state()}`);
  g.tick(30);
  assert(g.capsActive() === 0 && g.paddleW() === g.baseW(),
    "the deactivated capsule must have no lingering effect");
});

// ================================================================
// Review round 1 fold-ins: the edge-clamp lock, the exhaustive
// capsule colour table, and capsule drawing limited to "playing"
// ================================================================
check("an expand caught with the paddle parked at the right rim locks the centre to exactly canvas.width - paddleW/2", () => {
  const g = boot(960, 600);
  start(g);
  dropRolls(g).low();
  g.q("paddle.x = canvas.width - BASE_PADDLE_W / 2"); // park at the right rim
  g.q("maybeDropCapsule(paddle.x, paddleTop() - CAPSULE_H - 4)");
  assert(g.capsActive() === 1, "setup: a capsule is falling on the rim-parked paddle");
  let guard = 0;
  while (g.capsActive() === 1 && guard < 600) {
    g.tick(1);
    guard += 1;
  }
  assert(g.capsActive() === 0, "the capsule must be caught by the rim-parked paddle");
  assert(g.paddleW() === g.baseW() * g.q("PADDLE_EXPAND_FACTOR"), "the catch must widen the paddle");
  const rim = g.q("canvas.width") - g.paddleW() / 2;
  assert(g.paddleX() === rim,
    `the widened paddle must sit at exactly canvas.width - paddleW/2 (${rim}), got ${g.paddleX()}`);
  // The lock must hold frame after frame, even while the right key
  // is held against the rim.
  for (const cb of g.winListeners["keydown"]) cb({ code: "ArrowRight", preventDefault() {} });
  for (let i = 0; i < 10; i += 1) g.tick(1);
  assert(g.paddleX() === rim,
    `holding the rim must keep the centre locked at ${rim}, got ${g.paddleX()}`);
  for (const cb of g.winListeners["keyup"]) cb({ code: "ArrowRight" });
});

check("capsule colours come from an exhaustive kind-to-colour table covering every enumerated kind", () => {
  const g = boot(960, 600);
  start(g);
  const table = g.q("CAPSULE_COLORS");
  assert(Array.isArray(table), "CAPSULE_COLORS must be a named exhaustive table (array)");
  assert(table.every((c) => typeof c === "string" && c.length > 0),
    "each table entry must be a colour string");
  const kinds = g.q("CAPSULE_KINDS");
  assert(kinds.every((k) => typeof table[k] === "string"),
    `every enumerated kind needs a table entry, kinds=${JSON.stringify(kinds)}, table=${JSON.stringify(table)}`);
  assert(table.length === kinds.length,
    "the table must carry no speculative row (one colour per kind, none left over)");
  assert(table[g.q("KIND_EXPAND")] === g.q("COLOR_CAPSULE_EXPAND"),
    "the expand kind must map to COLOR_CAPSULE_EXPAND");
  assert(!gameSource.includes("COLOR_CAPSULE_EXPAND : COLOR_BALL"),
    "the speculative ternary fallback must be gone from the source");
});

check("each airborne capsule is drawn in its table colour while playing", () => {
  const g = boot(960, 600);
  start(g);
  const W = g.q("CAPSULE_W");
  const H = g.q("CAPSULE_H");
  const color = g.q("COLOR_CAPSULE_EXPAND");
  dropRolls(g).low();
  g.q("paddle.x = canvas.width / 2");
  g.q("maybeDropCapsule(paddle.x, canvas.height * 0.3)");
  assert(g.capsActive() === 1, "setup: the capsule is airborne");
  g.tick(1);
  const drawn = g.fills.filter((f) => f.w === W && f.h === H && f.style === color);
  assert(drawn.length >= 1,
    "while playing the airborne capsule must be drawn in its table colour");
});

check("capsules are not drawn outside playing: the game-over field stays tidy and frozen", () => {
  const g = boot(960, 600);
  start(g);
  const W = g.q("CAPSULE_W");
  const H = g.q("CAPSULE_H");
  const color = g.q("COLOR_CAPSULE_EXPAND");
  dropRolls(g).low();
  g.q("paddle.x = canvas.width / 2");
  g.q("maybeDropCapsule(paddle.x, canvas.height * 0.3)");
  assert(g.capsActive() === 1, "setup: the capsule is airborne");
  g.q("lives = 1; loseLife();");
  assert(g.state() === "gameover", "setup: the run is over");
  assert(g.capsActive() === 1, "setup: the capsule is still frozen in the air");
  const before = g.fills.length;
  g.tick(1);
  const frame = g.fills.slice(before);
  assert(frame.some((f) => f.style === g.q("COLOR_PADDLE")),
    "the game-over field must still be drawn (paddle visible)");
  const leak = frame.filter((f) => f.w === W && f.h === H && f.style === color);
  assert(leak.length === 0,
    `no capsule may be drawn outside playing, leaked ${leak.length}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
