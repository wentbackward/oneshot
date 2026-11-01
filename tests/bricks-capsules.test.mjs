#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html life-restore and score-multiplier
// capsule kinds (ticket #45)
//
// Same harness style as tests/bricks-powerups.test.mjs: runs the
// REAL <script> from bricks.html in a sandboxed vm context with
// stubbed window/document/canvas/DOM elements. Kind-specific drops
// are forced deterministically by pinning the game's mutable
// `random` hook to a two-call sequence: the first call passes the
// drop-rate roll, the second selects the kind index
// (floor(v * CAPSULE_KINDS.length)). Kills go through the game's
// own destroyBrick() (console-style direct access); timing is
// asserted by driving the captured requestAnimationFrame callback.
// No network, no external services.
//
// Run: node tests/bricks-capsules.test.mjs
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
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    lives: () => q("typeof lives === 'undefined' ? NaN : lives"),
    score: () => q("typeof score === 'undefined' ? NaN : score"),
    simTime: () => q("typeof simTime === 'undefined' ? NaN : simTime"),
    multUntil: () => q("typeof multUntil === 'undefined' ? NaN : multUntil"),
    capsPoolLen: () => q("typeof capsules === 'undefined' ? -1 : capsules.length"),
    capsActive: () =>
      q("typeof capsules === 'undefined' ? -1 : capsules.reduce((n, c) => n + (c.active ? 1 : 0), 0)"),
    capsActiveInfo: () =>
      q("typeof capsules === 'undefined' ? [] : capsules.filter((c) => c.active).map((c) => ({ kind: c.kind, x: c.x, y: c.y }))"),
    // Index of the first active, breakable brick of `tier` (-1 = any
    // breakable brick), or null: used to steer kills at a known tier.
    firstBreakableIndex(tier = -1) {
      return q(`(() => {
        for (let i = 0; i < bricks.length; i += 1) {
          const b = bricks[i];
          if (!b.active || b.unbreakable) continue;
          if (${tier} >= 0 && b.tier !== ${tier}) continue;
          return i;
        }
        return null;
      })()`);
    },
    centerX(index) {
      return q(`bricks[${index}].x + bricks[${index}].w / 2`);
    },
  };
}

const start = (g) => {
  g.els["btn-start"].click();
  g.tick(1);
};
const kill = (g, index) => g.q(`destroyBrick(${index})`);
// Deactivate every pooled capsule in place (console-style cleanup so
// a missed capsule cannot leak into the next phase of a test).
const drainCapsules = (g) => g.q("capsules.forEach(c => c.active = false); 1");

// Pin the game's mutable `random` hook to a two-call sequence: the
// first call is the drop-rate roll (below the run's dropRate, so the
// drop fires), the second is the kind roll, which the game maps to
// CAPSULE_KINDS[floor(v * CAPSULE_KINDS.length)].
function pinKindDrop(g, kindIndex) {
  const rate = g.q("POWERUP_DROP_RATE");
  const kindsLen = g.q("CAPSULE_KINDS.length");
  const v = (kindIndex + 0.5) / kindsLen;
  g.q(`random = (function () {
        var n = 0;
        var roll = ${v};
        return function () { return n++ === 0 ? ${rate / 2} : roll; };
      })(); 1`);
}
// Pin the hook so every drop-rate roll misses (no capsule drops).
function pinNoDrop(g) {
  const rate = g.q("POWERUP_DROP_RATE");
  g.q(`random = () => ${Math.min(1 - 1e-9, rate * 1.5)}; 1`);
}

// Destroy the brick at `index` with a forced KIND-index drop, aim the
// paddle at the drop point, and drive frames until the capsule is
// caught. Returns the sim time of the catching frame.
function dropKindAndCatch(g, index, kindIndex) {
  const b = g.q(`(() => { const t = bricks[${index}]; return { x: t.x + t.w / 2 }; })()`);
  pinKindDrop(g, kindIndex);
  kill(g, index);
  assert(g.capsActive() === 1, `setup: the kill must release exactly one capsule, got ${g.capsActive()}`);
  g.q(`paddle.x = ${b.x}`);
  for (let i = 0; i < 600 && g.capsActive() === 1; i += 1) g.tick(1);
  assert(g.capsActive() === 0, "the capsule must be caught by the aimed paddle");
  return g.simTime();
}

// ================================================================
// Criterion 1: two new kind constants (KIND_LIFE, KIND_MULTIPLIER)
// are appended to CAPSULE_KINDS with exactly one new CAPSULE_COLORS
// row each; CAPSULE_COLORS.length === CAPSULE_KINDS.length with
// exhaustive coverage
// ================================================================
check("KIND_LIFE and KIND_MULTIPLIER are appended after the existing kinds, one new colour row each", () => {
  const g = boot(960, 600);
  start(g);
  const kinds = g.q("CAPSULE_KINDS");
  assert(Array.isArray(kinds) && kinds.length === 5,
    `CAPSULE_KINDS must enumerate exactly 5 kinds, got ${JSON.stringify(kinds)}`);
  assert(g.q("KIND_EXPAND") === 0 && g.q("KIND_EXTRA") === 1 && g.q("KIND_STICKY") === 2,
    "the pre-existing kinds must keep their indices");
  assert(g.q("KIND_LIFE") === 3, `KIND_LIFE must be the 4th kind (index 3), got ${g.q("KIND_LIFE")}`);
  assert(g.q("KIND_MULTIPLIER") === 4, `KIND_MULTIPLIER must be the 5th kind (index 4), got ${g.q("KIND_MULTIPLIER")}`);
  assert(kinds.join(",") === "0,1,2,3,4",
    `the new kinds must be appended in order, got ${JSON.stringify(kinds)}`);
  const lifeColor = g.q("COLOR_CAPSULE_LIFE");
  const multColor = g.q("COLOR_CAPSULE_MULT");
  assert(typeof lifeColor === "string" && lifeColor.length > 0, "COLOR_CAPSULE_LIFE must be a colour string");
  assert(typeof multColor === "string" && multColor.length > 0, "COLOR_CAPSULE_MULT must be a colour string");
  assert(lifeColor !== multColor, "the two new capsule colours must be distinct");
  const table = g.q("CAPSULE_COLORS");
  assert(table[g.q("KIND_LIFE")] === lifeColor,
    "the life kind must map to COLOR_CAPSULE_LIFE");
  assert(table[g.q("KIND_MULTIPLIER")] === multColor,
    "the multiplier kind must map to COLOR_CAPSULE_MULT");
});

check("CAPSULE_COLORS stays exhaustive: one row per kind, no row left over", () => {
  const g = boot(960, 600);
  start(g);
  const table = g.q("CAPSULE_COLORS");
  const kinds = g.q("CAPSULE_KINDS");
  assert(table.length === kinds.length,
    `CAPSULE_COLORS.length (${table.length}) must equal CAPSULE_KINDS.length (${kinds.length})`);
  assert(kinds.every((k) => typeof table[k] === "string" && table[k].length > 0),
    "every enumerated kind needs a colour row");
  const colors = table.map((c) => c);
  assert(new Set(colors).size === colors.length,
    "each capsule kind must have a distinct colour row");
});

// ================================================================
// Criterion 2: a caught life capsule restores one life (icons
// rebuilt); at the cap lives === PLAYER_LIVES a catch leaves it at
// the cap
// ================================================================
check("a life capsule caught at lives = 2 restores lives to 3 and rebuilds the #lives icons to 3", () => {
  const g = boot(960, 600);
  start(g);
  const cap = g.q("PLAYER_LIVES");
  assert(cap === 3, `sanity: PLAYER_LIVES is 3, got ${cap}`);
  g.q("lives = 2; renderLives(); 1");
  assert(g.lives() === 2 && g.els["lives"].children.length === 2,
    "setup: the run has 2 lives and 2 icons");
  const b = g.firstBreakableIndex(0);
  assert(b !== null, "setup: a tier-A brick is alive");
  dropKindAndCatch(g, b, g.q("KIND_LIFE"));
  assert(g.lives() === 3, `the catch must restore one life (2 -> 3), got ${g.lives()}`);
  assert(g.els["lives"].children.length === 3,
    `the #lives node must be rebuilt to 3 icons, got ${g.els["lives"].children.length}`);
  assert(g.state() === "playing", `the run must continue, state=${g.state()}`);
});

check("a life capsule caught at the cap (lives === PLAYER_LIVES) leaves lives at the cap", () => {
  const g = boot(960, 600);
  start(g);
  const cap = g.q("PLAYER_LIVES");
  assert(g.lives() === cap, `setup: the fresh run starts at the cap (${cap}), got ${g.lives()}`);
  const b = g.firstBreakableIndex(0);
  assert(b !== null, "setup: a tier-A brick is alive");
  dropKindAndCatch(g, b, g.q("KIND_LIFE"));
  assert(g.lives() === cap,
    `a catch at the cap must not overflow lives (cap ${cap}), got ${g.lives()}`);
  assert(g.els["lives"].children.length === cap,
    `the #lives node must still hold exactly ${cap} icons, got ${g.els["lives"].children.length}`);
});

// ================================================================
// Criterion 3: a caught multiplier capsule arms a timed window
// (MULT_DURATION_S, expired in updatePowerups()); while armed a
// tier-A kill adds POINTS_BRICK_A * MULT_VALUE, after expiry it
// adds POINTS_BRICK_A again; a re-catch re-arms the full duration,
// never extends
// ================================================================
check("a caught multiplier arms a window expiring at catch time + MULT_DURATION_S, expired by updatePowerups()", () => {
  const g = boot(960, 600);
  start(g);
  const D = g.q("MULT_DURATION_S");
  assert(typeof D === "number" && D > 0, `MULT_DURATION_S must be a named positive duration, got ${D}`);
  const b = g.firstBreakableIndex(0);
  assert(b !== null, "setup: a tier-A brick is alive");
  const t0 = dropKindAndCatch(g, b, g.q("KIND_MULTIPLIER"));
  const expiry = g.multUntil();
  assert(expiry === t0 + D,
    `the catch must arm the expiry at catch time + full duration (${t0 + D}), got ${expiry}`);
  // The expiry bookkeeping belongs to updatePowerups(): stepping
  // simTime past the expiry clears it back to -1.
  let guard = 0;
  while (g.simTime() < expiry + 1 / 60 && guard < 2000) {
    g.tick(1);
    guard += 1;
  }
  assert(g.multUntil() === -1,
    `once simTime passes the expiry, updatePowerups() must clear the window, got ${g.multUntil()}`);
});

check("while the multiplier is armed, destroying a tier-A brick adds POINTS_BRICK_A * MULT_VALUE", () => {
  const g = boot(960, 600);
  start(g);
  const pts = g.q("POINTS_BRICK_A");
  const m = g.q("MULT_VALUE");
  assert(Number.isFinite(pts) && pts > 0, `POINTS_BRICK_A must be positive, got ${pts}`);
  assert(Number.isFinite(m) && m > 1, `MULT_VALUE must exceed 1, got ${m}`);
  const first = g.firstBreakableIndex(0);
  assert(first !== null, "setup: a tier-A brick is alive");
  dropKindAndCatch(g, first, g.q("KIND_MULTIPLIER"));
  assert(g.multUntil() > g.simTime(), "setup: the window is armed");
  const victim = g.firstBreakableIndex(0);
  assert(victim !== null && victim.i !== first.i, "setup: a second tier-A brick is alive");
  pinNoDrop(g); // this kill must not release an interfering capsule
  const before = g.score();
  kill(g, victim.i);
  assert(g.score() - before === pts * m,
    `an armed-tier-A kill must credit POINTS_BRICK_A * MULT_VALUE (${pts * m}), credited ${g.score() - before}`);
});

check("after the multiplier window elapses, destroying a tier-A brick adds POINTS_BRICK_A again", () => {
  const g = boot(960, 600);
  start(g);
  const pts = g.q("POINTS_BRICK_A");
  const first = g.firstBreakableIndex(0);
  assert(first !== null, "setup: a tier-A brick is alive");
  dropKindAndCatch(g, first, g.q("KIND_MULTIPLIER"));
  const expiry = g.multUntil();
  // Step simTime past the expiry via the game's own frame clock.
  let guard = 0;
  while (g.simTime() < expiry + 1 / 60 && guard < 2000) {
    g.tick(1);
    guard += 1;
  }
  assert(g.multUntil() === -1, "setup: the window has been cleared by updatePowerups()");
  const victim = g.firstBreakableIndex(0);
  assert(victim !== null, "setup: a tier-A brick is still alive");
  pinNoDrop(g);
  const before = g.score();
  kill(g, victim.i);
  assert(g.score() - before === pts,
    `an unarmed tier-A kill must credit plain POINTS_BRICK_A (${pts}), credited ${g.score() - before}`);
});

check("a second multiplier caught mid-window re-arms the full duration — re-armed, never extended", () => {
  const g = boot(960, 600);
  start(g);
  const D = g.q("MULT_DURATION_S");
  const first = g.firstBreakableIndex(0);
  assert(first !== null, "setup: a tier-A brick is alive");
  const t0 = dropKindAndCatch(g, first, g.q("KIND_MULTIPLIER"));
  const exp1 = g.multUntil();
  assert(exp1 === t0 + D, `setup: first arm is t0 + D (${t0 + D}), got ${exp1}`);
  // Second multiplier capsule; the brick sits elsewhere on the board
  // so its capsule falls on the re-aimed paddle before exp1.
  const second = g.firstBreakableIndex(0);
  assert(second !== null && second !== first, "setup: a second tier-A brick is alive");
  pinKindDrop(g, g.q("KIND_MULTIPLIER"));
  kill(g, second);
  assert(g.capsActive() === 1, "setup: the second kill releases one capsule");
  g.q(`paddle.x = ${g.centerX(second)}`);
  let t1 = null;
  for (let i = 0; i < 600 && t1 === null; i += 1) {
    g.tick(1);
    if (g.multUntil() !== exp1) t1 = g.simTime();
  }
  assert(t1 !== null, "the second capsule must be caught while the window is live");
  assert(t1 < exp1, `the second catch must land before the first expiry, ${t1} vs ${exp1}`);
  const exp2 = g.multUntil();
  assert(exp2 === t1 + D,
    `the re-arm must set the expiry to catch time + full duration (${t1 + D}), got ${exp2}`);
  assert(exp2 > exp1,
    `the expiry must re-arm beyond the first arm (re-armed), ${exp2} vs ${exp1}`);
  assert(exp2 < t0 + 2 * D,
    `the expiry must not be additive (would be t0 + 2D = ${t0 + 2 * D}), got ${exp2}`);
});

// ================================================================
// Criterion 4: maybeDropCapsule still never allocates (pool
// CAPSULE_POOL_SIZE unchanged) and rolls the new kinds through the
// random hook uniformly
// ================================================================
check("capsule drops still never allocate: the pool stays at CAPSULE_POOL_SIZE under a burst of forced drops", () => {
  const g = boot(960, 600);
  start(g);
  const pool = g.q("CAPSULE_POOL_SIZE");
  assert(pool === 4, `CAPSULE_POOL_SIZE must be unchanged (4), got ${pool}`);
  assert(g.capsPoolLen() === pool, `the pool starts at its named size, got ${g.capsPoolLen()}`);
  const rate = g.q("POWERUP_DROP_RATE");
  g.q(`random = () => ${rate / 2}; 1`); // every drop fires, kind rolls mid-table
  g.q(`killCount = 0; (() => {
        for (let i = 0; i < bricks.length && killCount < 7; i += 1) {
          if (bricks[i].active && !bricks[i].unbreakable) {
            destroyBrick(i);
            killCount += 1;
          }
        }
      })(); 1`);
  assert(g.q("killCount") === 7,
    `setup: seven bricks destroyed, got ${g.q("killCount")}`);
  assert(g.capsPoolLen() === pool,
    `the pool length must stay constant under a drop burst, got ${g.capsPoolLen()}`);
  assert(g.capsActive() === pool,
    `the pool may hold at most its full size concurrently, active=${g.capsActive()}`);
  drainCapsules(g);
  // The burst saturated the pool; freed slots must be reusable.
  g.q(`(() => {
        for (let i = 0; i < bricks.length; i += 1) {
          if (bricks[i].active && !bricks[i].unbreakable) { destroyBrick(i); return; }
        }
      })(); 1`);
  assert(g.capsActive() === 1,
    `a freed pool slot must be reused by a later drop, active=${g.capsActive()}`);
  assert(g.capsPoolLen() === pool,
    `the pool length must still be constant, got ${g.capsPoolLen()}`);
});

check("the kind roll is uniform over all five kinds: each pinned roll index produces exactly that kind", () => {
  const g = boot(960, 600);
  start(g);
  const kinds = g.q("CAPSULE_KINDS");
  for (let idx = 0; idx < kinds.length; idx += 1) {
    const victim = g.firstBreakableIndex(-1);
    assert(victim !== null, `setup: a breakable brick is alive for roll ${idx}`);
    pinKindDrop(g, idx);
    kill(g, victim);
    const live = g.capsActiveInfo();
    assert(live.length === 1, `roll ${idx}: exactly one capsule must be live, got ${live.length}`);
    assert(live[0].kind === kinds[idx],
      `a kind roll in [${idx / kinds.length}, ${(idx + 1) / kinds.length}) must yield CAPSULE_KINDS[${idx}] (${kinds[idx]}), got ${live[0].kind}`);
    drainCapsules(g);
  }
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
