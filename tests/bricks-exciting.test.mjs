#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html EXCITING-mode capsules (ticket #75):
// invulnerable pass-through, multiball x10, and blast radius
//
// Same harness style as the sibling bricks-*.test.mjs suites: the
// REAL <script> from bricks.html runs in a sandboxed vm context
// with stubbed window/document/localStorage/requestAnimationFrame,
// DOM element stubs, and a canvas 2d stub that RECORDS fillStyle
// writes (so the invulnerability tint is assertable on the draw
// path). Frames are driven through the captured requestAnimationFrame
// callback; the `random` hook is pinned at boot and re-pinned
// per fixture so no capsule can drop by chance. Brick/ball fixtures
// are built with console-style direct pool access (the precedent
// from the durability and multiball siblings). No network, no
// external services.
//
// Run: node tests/bricks-exciting.test.mjs
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

// A DOM element stub: records style writes, text, listeners, classes.
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

// A canvas 2d context stub: every method is a no-op; fillStyle
// writes are APPENDED to rec.fills so draw-path colour choices are
// assertable (the invulnerability tint test reads them).
function makeCtx(rec) {
  const noop = () => {};
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        return noop;
      },
      set(_t, prop, value) {
        if (prop === "fillStyle") rec.fills.push(value);
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
    rec: { fills: [] },
    getContext: () => makeCtx(canvas.rec),
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
    "theme-classic": makeEl("theme-classic"),
    "theme-neon": makeEl("theme-neon"),
    "theme-minimal": makeEl("theme-minimal"),
    "mode-classic": makeEl("mode-classic"),
    "mode-exciting": makeEl("mode-exciting"),
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
  // Pin the mutable random hook at boot (house style): random() => 1
  // makes every drop roll miss, so no capsule can appear by chance.
  vm.runInContext("random = () => 1;", context);

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
    score: () => q("typeof score === 'undefined' ? NaN : score"),
    simTime: () => q("typeof simTime === 'undefined' ? NaN : simTime"),
    liveCount: () =>
      q("typeof balls === 'undefined' ? -1 : balls.reduce((n, b) => n + (b.active ? 1 : 0), 0)"),
    ballList: () =>
      q("balls.map((b, i) => ({ i: i, active: b.active, attached: b.attached, x: b.x, y: b.y, vx: b.vx, vy: b.vy }))"),
    capsActive: () => q("capsules.reduce((n, c) => n + (c.active ? 1 : 0), 0)"),
    capKinds: () => q("capsules.filter((c) => c.active).map((c) => c.kind)"),
    fills: () => canvas.rec.fills,
  };
}

// Begin a run in the SELECTED mode (defaults to classic); pass
// "exciting" to click the mode option first, exactly as a player would.
function startRun(g, mode) {
  if (mode === "exciting") g.els["mode-exciting"].click();
  g.els["btn-start"].click();
  g.tick(1);
}

// Deactivate the whole brick pool in place and zero the win counter:
// subsequent destroyBrick() calls decrement bricksLeft from 0 (so it
// can never hit 0 again — a fixture kill cannot win the level and
// respawn the board out from under the fixture).
function clearField(g) {
  g.q("for (var i = 0; i < bricks.length; i += 1) { bricks[i].active = false; bricks[i].charged = false; } bricksLeft = 0; 1");
}

// Park ONE in-flight ball in slot `slot` at (x, y) with velocity
// (vx, vy) — the deterministic trajectory primitive for fixtures.
function parkBall(g, slot, x, y, vx, vy) {
  g.q(`balls[${slot}].active = true; balls[${slot}].attached = false;
       balls[${slot}].x = ${x}; balls[${slot}].y = ${y};
       balls[${slot}].vx = ${vx}; balls[${slot}].vy = ${vy}; 1`);
}

// Place a brick in pool slot `idx` centred at (cx, cy) with size
// (w × h). Tier 0/1/2 are the breakable tiers, `fixed` arms the
// unbreakable tier.
function placeBrick(g, idx, cx, cy, w, h, fixed = false, tier = 2) {
  g.q(`(function () {
        var b = bricks[${idx}];
        b.active = true;
        b.tier = ${fixed ? "TIER_FIXED" : tier};
        b.unbreakable = ${fixed};
        b.charged = false;
        b.hp = BRICK_TIERS[b.tier].hp;
        b.x = ${cx} - ${w} / 2;
        b.y = ${cy} - ${h} / 2;
        b.w = ${w};
        b.h = ${h};
      })(); 1`);
}
function brickAlive(g, idx) {
  return g.q(`bricks[${idx}].active`);
}
const drainCapsules = (g) => g.q("capsules.forEach((c) => (c.active = false)); 1");
const drainBalls = (g) =>
  g.q("balls.forEach((b) => { b.active = false; b.attached = false; }); 1");

// ================================================================
// Criterion 1: kind constants appended after 0–4; only EXCITING's
// drop table contains the new kinds (pinned random + manipulated
// drop rate); a classic run never spawns them
// ================================================================
check("kinds 5/6/7 are named constants appended after the untouched 0–4", () => {
  const g = boot();
  assert(g.q("KIND_EXPAND") === 0 && g.q("KIND_EXTRA") === 1 && g.q("KIND_STICKY") === 2,
    "the pre-existing kinds keep their indices");
  assert(g.q("KIND_LIFE") === 3 && g.q("KIND_MULTIPLIER") === 4,
    "the pre-existing kinds keep their indices");
  const inv = g.q("typeof KIND_INVULNERABLE");
  const mb = g.q("typeof KIND_MULTIBALL");
  const bl = g.q("typeof KIND_BLAST");
  assert(inv === "number" && mb === "number" && bl === "number",
    "the three new kinds must be named numeric constants");
  assert(g.q("KIND_INVULNERABLE") === 5, `KIND_INVULNERABLE must be 5, got ${g.q("KIND_INVULNERABLE")}`);
  assert(g.q("KIND_MULTIBALL") === 6, `KIND_MULTIBALL must be 6, got ${g.q("KIND_MULTIBALL")}`);
  assert(g.q("KIND_BLAST") === 7, `KIND_BLAST must be 7, got ${g.q("KIND_BLAST")}`);
});

check("classic's drop table stays the original five kinds; EXCITING's table appends 5/6/7 in order", () => {
  const g = boot();
  assert(JSON.stringify(g.q("CAPSULE_KINDS")) === JSON.stringify([0, 1, 2, 3, 4]),
    `CAPSULE_KINDS must stay exactly [0..4], got ${JSON.stringify(g.q("CAPSULE_KINDS"))}`);
  const table = g.q("CAPSULE_KINDS_EXCITE");
  assert(Array.isArray(table) && JSON.stringify(table) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7]),
    `CAPSULE_KINDS_EXCITE must be [0..7] in order, got ${JSON.stringify(table)}`);
  assert(JSON.stringify(g.q("MODES.classic.capsuleKinds")) === JSON.stringify([0, 1, 2, 3, 4]),
    "the classic MODES row must carry the five-kind table");
  assert(JSON.stringify(g.q("MODES.exciting.capsuleKinds")) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7]),
    "the exciting MODES row must carry the eight-kind table");
});

check("a classic run NEVER spawns kinds 5/6/7: manipulated drop rate + pinned kind roll at the classic table's top bin across a dozen kills", () => {
  const g = boot();
  startRun(g);
  assert(g.q("runMode") === "classic", "setup: default run is classic");
  const seen = [];
  for (let round = 0; round < 3; round += 1) {
    g.q("dropRate = 1"); // manipulated: every kill rolls a drop
    for (let i = 0; i < 4; i += 1) {
      const victim = g.q("(() => { for (var j = 0; j < bricks.length; j += 1) if (bricks[j].active && !bricks[j].unbreakable) return j; return -1; })()");
      assert(victim >= 0, `setup: a breakable brick is alive for round ${round}, kill ${i}`);
      // drop roll 0.1 (< 1) fires the drop; kind roll 0.9 = the TOP
      // bin of the classic table (floor(0.9 * 5) = 4) — the roll
      // closest to the new kinds without reaching them.
      g.q("random = (function () { var a = [0.1, 0.9]; return function () { return a.shift(); }; })()");
      g.q(`destroyBrick(${victim})`);
      assert(g.capsActive() === 1, `kill ${i}: the forced roll must release exactly one capsule`);
      seen.push(...g.capKinds());
      drainCapsules(g);
    }
  }
  assert(seen.length === 12, `setup: twelve capsules rolled, got ${seen.length}`);
  assert(seen.every((k) => k >= 0 && k <= 4),
    `a classic run may only roll the five legacy kinds, saw ${JSON.stringify(seen)}`);
  assert(seen.every((k) => k === 4),
    `the pinned top-bin roll must yield kind 4 every time, saw ${JSON.stringify([...new Set(seen)])}`);
});

check("an exciting run DOES spawn kinds 5/6/7: each pinned top-table bin produces its kind", () => {
  const g = boot();
  startRun(g, "exciting");
  assert(g.q("runMode") === "exciting", "setup: the run is exciting");
  for (const kind of [5, 6, 7]) {
    g.q("dropRate = 1");
    const victim = g.q("(() => { for (var j = 0; j < bricks.length; j += 1) if (bricks[j].active && !bricks[j].unbreakable) return j; return -1; })()");
    assert(victim >= 0, `setup: a breakable brick is alive for kind ${kind}`);
    // drop roll 0 fires; kind roll (kind+0.5)/8 sits mid-bin for kind.
    g.q(`random = (function () { var a = [0, ${(kind + 0.5) / 8}]; return function () { return a.shift(); }; })()`);
    g.q(`destroyBrick(${victim})`);
    assert(g.capsActive() === 1, `kind ${kind}: the forced roll must release exactly one capsule`);
    assert(g.capKinds()[0] === kind,
      `a bin-${kind} roll on exciting must yield kind ${kind}, got ${g.capKinds()[0]}`);
    drainCapsules(g);
  }
});

// ================================================================
// Criterion 2: INVULNERABLE — pass-through destroys and scores each
// brick exactly once, fixed bricks stop, tint only while active,
// no drops during the window, timer expiry restores bounces
// ================================================================
check("a caught invulnerable capsule arms invulnUntil = catch time + INVULNERABLE_DURATION_S, console-retunable", () => {
  const g = boot();
  startRun(g, "exciting");
  const D = g.q("INVULNERABLE_DURATION_S");
  assert(typeof D === "number" && D > 0, `INVULNERABLE_DURATION_S must be a named positive var, got ${D}`);
  clearField(g);
  const t0 = g.simTime();
  g.q("applyCapsule(KIND_INVULNERABLE)");
  assert(g.q("invulnUntil") === t0 + D,
    `the catch must arm the expiry at catch time + full duration (${t0 + D}), got ${g.q("invulnUntil")}`);
  // Console retune: the NEXT arm must honour the new value.
  g.q("INVULNERABLE_DURATION_S = 1");
  g.q("invulnUntil = -1");
  const t1 = g.simTime();
  g.q("applyCapsule(KIND_INVULNERABLE)");
  assert(g.q("invulnUntil") === t1 + 1,
    `a re-caught capsule must honour the retuned duration (${t1 + 1}), got ${g.q("invulnUntil")}`);
});

check("pinned trajectory through a brick row: every passed brick is destroyed and scored exactly once, the ball is undeviated", () => {
  const g = boot();
  startRun(g, "exciting");
  clearField(g);
  // Three 1-hp tier-C bricks (10 pts each) stacked on the ball's
  // vertical line, far apart enough that the ball overlaps at most
  // one at a time.
  for (let r = 0; r < 3; r += 1) placeBrick(g, r, 500, 300 - r * 40, 40, 20);
  parkBall(g, 0, 500, 400, 0, -300);
  g.q("applyCapsule(KIND_INVULNERABLE)");
  assert(g.q("invulnUntil") > g.simTime(), "setup: the window is armed");
  // The ball covers 300 px/s upward; 12 s of frames is ample.
  for (let i = 0; i < 720 && (brickAlive(g, 0) || brickAlive(g, 1) || brickAlive(g, 2)); i += 1) g.tick(1);
  assert(!brickAlive(g, 0) && !brickAlive(g, 1) && !brickAlive(g, 2),
    "all three passed bricks must be destroyed");
  const pts = g.q("POINTS_BRICK_C");
  assert(g.score() === 3 * pts,
    `each passed brick must be scored exactly once (3 × ${pts} = ${3 * pts}), score is ${g.score()}`);
  const b = g.ballList()[0];
  assert(b.active, "the ball must still be alive — pass-through costs nothing");
  assertClose(b.x, 500, 1e-9, "the ball's x must be untouched (no pinning, no deflection)");
  assert(b.vy === -300, `the ball's vy must keep its exact incoming value, got ${b.vy}`);
});

check("with the multiplier window armed, pass-through kills score tier points × MULT_VALUE", () => {
  const g = boot();
  startRun(g, "exciting");
  clearField(g);
  placeBrick(g, 0, 500, 300, 40, 20);
  parkBall(g, 0, 500, 400, 0, -300);
  g.q("applyCapsule(KIND_INVULNERABLE)");
  g.q("applyCapsule(KIND_MULTIPLIER)"); // the armed window is honoured by the kill path
  for (let i = 0; i < 200 && brickAlive(g, 0); i += 1) g.tick(1);
  const want = g.q("POINTS_BRICK_C") * g.q("MULT_VALUE");
  assert(g.score() === want,
    `an armed pass-through kill must credit tier × MULT_VALUE (${want}), score is ${g.score()}`);
});

check("a fixed brick in the path STOPS the ball with a normal bounce, even mid-invuln", () => {
  const g = boot();
  startRun(g, "exciting");
  clearField(g);
  placeBrick(g, 0, 500, 260, 100, 20, true); // unbreakable slab on the line
  parkBall(g, 0, 500, 360, 0, -300);
  g.q("applyCapsule(KIND_INVULNERABLE)");
  assert(g.q("invulnUntil") > g.simTime(), "setup: the window is armed");
  for (let i = 0; i < 120; i += 1) {
    g.tick(1);
    const b = g.ballList()[0];
    if (b.vy > 0) break; // bounced
  }
  const b = g.ballList()[0];
  assert(b.vy === 300, `the ball must bounce straight back at its incoming speed, vy=${b.vy}`);
  assert(brickAlive(g, 0), "the fixed brick must still be alive — unpassable means unpassable");
  assert(b.y > 260 + 10 + g.q("BALL_RADIUS"),
    `the ball must be pinned below the slab's face, y=${b.y}`);
});

check("the tint is drawn only while the window is active: the named invuln colour appears in fillStyle mid-window and never after expiry", () => {
  const g = boot();
  startRun(g, "exciting");
  clearField(g);
  const tint = g.q("COLOR_BALL_INVLUN");
  assert(typeof tint === "string" && tint.length > 0, "COLOR_BALL_INVLUN must be a named colour");
  const slice = () => {
    const from = g.fills().length;
    g.tick(5);
    return g.fills().slice(from);
  };
  // Before the catch: no tint.
  let s = slice();
  assert(s.indexOf(tint) === -1,
    `the invuln tint must not be drawn before the window arms, fills=${JSON.stringify(s)}`);
  g.q("INVULNERABLE_DURATION_S = 1"); // short arm so the test drives fast
  g.q("applyCapsule(KIND_INVULNERABLE)");
  // Mid-window: the tint is painted.
  s = slice();
  assert(s.indexOf(tint) !== -1,
    `the ball must carry the distinct tint while the window is active, fills=${JSON.stringify(s)}`);
  // Wait out the window; updatePowerups() must clear it.
  let guard = 0;
  while (g.q("invulnUntil") !== -1 && guard < 300) {
    g.tick(1);
    guard += 1;
  }
  assert(g.q("invulnUntil") === -1, "setup: the window has been cleared by the frame clock");
  // After the window: the tint is gone, the normal ball colour returns.
  s = slice();
  assert(s.indexOf(tint) === -1,
    `the tint must be withdrawn once the window expires, fills=${JSON.stringify(s)}`);
  assert(s.indexOf(g.q("COLOR_BALL")) !== -1,
    `the normal ball colour must be drawn again after expiry, fills=${JSON.stringify(s)}`);
});

check("no capsule drops are spawned during the invulnerable window; a post-expiry kill drops normally", () => {
  const g = boot();
  startRun(g, "exciting");
  clearField(g);
  g.q("dropRate = 1"); // manipulated: every roll fires
  g.q("random = () => 0.5"); // drop roll 0.5 < 1 fires; kind bin 4 (legacy)
  placeBrick(g, 0, 500, 280, 40, 20); // smashed through while invuln
  placeBrick(g, 1, 500, 200, 40, 20); // hit normally after expiry
  parkBall(g, 0, 500, 380, 0, -300);
  g.q("INVULNERABLE_DURATION_S = 0.4"); // retuned short: window covers brick 0, not brick 1
  g.q("applyCapsule(KIND_INVULNERABLE)");
  // Brick 0's pass-through kill must NOT release a capsule.
  for (let i = 0; i < 120 && brickAlive(g, 0); i += 1) g.tick(1);
  assert(!brickAlive(g, 0), "setup: the ball passed through brick 0");
  assert(g.capsActive() === 0,
    `no capsule may be spawned during the invulnerable window, active=${g.capsActive()}`);
  // After expiry the same forced-economy kill drops normally.
  for (let i = 0; i < 200 && brickAlive(g, 1); i += 1) g.tick(1);
  assert(!brickAlive(g, 1), "setup: brick 1 was hit after the window closed");
  assert(g.q("invulnUntil") === -1, "setup: the window is expired");
  assert(g.capsActive() === 1,
    `the post-expiry kill must release its capsule normally, active=${g.capsActive()}`);
});

// ================================================================
// Criterion 3: MULTIBALL — 1 ball → 10 (count + angular spread),
// 3 → capped at 30, pool length never changes, deterministic order
// ================================================================
check("the ball pool is sized at boot for MAX_BALLS_EXCITE = 30; the classic MAX_BALLS = 5 cap stays named", () => {
  const g = boot();
  assert(g.q("MAX_BALLS") === 5, `MAX_BALLS must stay 5 for classic play, got ${g.q("MAX_BALLS")}`);
  const cap = g.q("MAX_BALLS_EXCITE");
  assert(typeof cap === "number" && cap === 30, `MAX_BALLS_EXCITE must be the named var 30, got ${cap}`);
  assert(g.q("balls.length") === cap,
    `the ball pool must be sized to MAX_BALLS_EXCITE at boot, got ${g.q("balls.length")}`);
});

check("one in-flight ball becomes ten: same position, identical speed, nine rotations about the incoming vector", () => {
  const g = boot();
  startRun(g, "exciting");
  clearField(g);
  const speed = 480;
  parkBall(g, 0, 500, 400, 0, -speed);
  assert(g.liveCount() === 1, "setup: exactly one in-flight ball");
  g.q("applyCapsule(KIND_MULTIBALL)");
  assert(g.liveCount() === 10,
    `the capture must replace the one ball with ten, live=${g.liveCount()}`);
  assert(g.q("balls.length") === 30, `the pool length must not change, got ${g.q("balls.length")}`);
  const balls = g.ballList().filter((b) => b.active);
  assert(balls.length === 10, "setup: ten active slots");
  // Every ball (parent included) shares the spawn point and speed.
  for (const b of balls) {
    assertClose(b.x, 500, 1e-9, `every ball must spawn at the parent's x, got ${b.x}`);
    assertClose(b.y, 400, 1e-9, `every ball must spawn at the parent's y, got ${b.y}`);
    assertClose(Math.hypot(b.vx, b.vy), speed, 1e-9,
      `every clone must preserve the incoming speed, got ${Math.hypot(b.vx, b.vy)}`);
  }
  // The parent slot keeps its exact vector; the nine clones are the
  // same vector rotated by (j - 4) × MULTIBALL_SPREAD_STEP.
  const parent = g.ballList()[0];
  assert(parent.vx === 0 && parent.vy === -speed,
    "the parent keeps its exact incoming vector");
  const step = g.q("MULTIBALL_SPREAD_STEP");
  assert(typeof step === "number" && step > 0, `MULTIBALL_SPREAD_STEP must be a named positive var, got ${step}`);
  const base = Math.atan2(-speed, 0);
  const angles = balls.map((b) => Math.atan2(b.vy, b.vx));
  for (let j = 0; j < 9; j += 1) {
    const want = base + (j - 4) * step;
    assert(angles.some((a) => Math.abs(a - want) < 1e-9),
      `a clone must carry the incoming vector rotated by ${(j - 4) * step} rad`);
  }
});

check("parked (attached) balls do not fan: 1 in-flight + 1 attached capture yields 11 live, the attached ball untouched and no zero-velocity clones", () => {
  const g = boot();
  startRun(g, "exciting");
  clearField(g);
  parkBall(g, 0, 500, 400, 0, -480); // in-flight parent
  g.q("balls[1].active = true; balls[1].attached = true; balls[1].x = 480; balls[1].y = 560; balls[1].vx = 0; balls[1].vy = 0;");
  assert(g.liveCount() === 2, "setup: one in-flight, one attached");
  g.q("applyCapsule(KIND_MULTIBALL)");
  assert(g.liveCount() === 11,
    `the fan must cover only the in-flight parent (10) plus the untouched attached ball (1), live=${g.liveCount()}`);
  const attached = g.ballList().find((b) => b.active && b.attached);
  assert(attached && attached.x === 480 && attached.vx === 0 && attached.vy === 0,
    "the attached ball must remain parked with zero velocity");
  for (const b of g.ballList()) {
    if (!b.active || b.attached) continue;
    assert(Math.hypot(b.vx, b.vy) > 0, "no clone may spawn with a zero velocity vector (rotating a parked ball is degenerate)");
  }
});

check("three in-flight balls fill the board to the 30-ball cap; the pool never grows", () => {
  const g = boot();
  startRun(g, "exciting");
  clearField(g);
  parkBall(g, 0, 400, 300, 0, -400);
  parkBall(g, 1, 500, 350, -200, -346);
  parkBall(g, 2, 600, 400, 200, -346);
  assert(g.liveCount() === 3, "setup: three in-flight balls");
  g.q("applyCapsule(KIND_MULTIBALL)");
  assert(g.liveCount() === 30,
    `three balls × ten must land exactly on the 30-ball cap, live=${g.liveCount()}`);
  assert(g.q("balls.length") === 30, `the pool length must not change, got ${g.q("balls.length")}`);
});

check("four in-flight balls: excess spawns are skipped in deterministic pool order under a pinned random", () => {
  const fixture = (g) => {
    startRun(g, "exciting");
    clearField(g);
    for (let s = 0; s < 4; s += 1) parkBall(g, s, 300 + s * 100, 300, 0, -400);
    g.q("random = () => 0.37;"); // pinned: the capture itself must stay deterministic
    g.q("applyCapsule(KIND_MULTIBALL)");
  };
  const g1 = boot();
  fixture(g1);
  assert(g1.liveCount() === 30,
    `the cap must hold with four parents, live=${g1.liveCount()}`);
  // Parents fan in pool order with a per-spawn cap check: parent 0
  // and 1 reach their full fan (10 each), parent 2 gets eight of its
  // nine clones (the ninth would exceed 30), parent 3 is skipped
  // entirely — the deterministic skip order the ticket names.
  const countAt = (g, x) => g.ballList().filter((b) => b.active && Math.abs(b.x - x) < 1).length;
  assert(countAt(g1, 300) === 10 && countAt(g1, 400) === 10,
    `parents 0-1 must each reach ten (got ${countAt(g1, 300)}, ${countAt(g1, 400)})`);
  assert(countAt(g1, 500) === 9,
    `parent 2's ninth clone must be skipped at the cap (got ${countAt(g1, 500)} at x=500)`);
  assert(countAt(g1, 600) === 1,
    `parent 3's excess spawns must be skipped (got ${countAt(g1, 600)} balls at x=600)`);
  // A second, identically-fixed boot must reproduce the exact same
  // field: determinism under the pinned random hook.
  const g2 = boot();
  fixture(g2);
  const field = (g) => JSON.stringify(
    g.ballList().filter((b) => b.active)
      .sort((a, b) => a.i - b.i)
      .map((b) => [b.x, b.y, b.vx, b.vy]));
  assert(field(g1) === field(g2),
    "two identically-pinned boots must produce byte-identical multiball fields");
});

// ================================================================
// Criterion 4: BLAST — 30/89/91 px boundary, no chaining, fixed
// bricks anchor without breaking, normal bounce
// ================================================================
check("a caught blast capsule arms blastUntil = catch time + BLAST_DURATION_S; BLAST_RADIUS_PX is the named var 90", () => {
  const g = boot();
  startRun(g, "exciting");
  const D = g.q("BLAST_DURATION_S");
  assert(typeof D === "number" && D > 0, `BLAST_DURATION_S must be a named positive var, got ${D}`);
  assert(g.q("BLAST_RADIUS_PX") === 90,
    `BLAST_RADIUS_PX must be the named var 90, got ${g.q("BLAST_RADIUS_PX")}`);
  clearField(g);
  const t0 = g.simTime();
  g.q("applyCapsule(KIND_BLAST)");
  assert(g.q("blastUntil") === t0 + D,
    `the catch must arm the expiry at catch time + full duration (${t0 + D}), got ${g.q("blastUntil")}`);
  // Console retune: the NEXT arm honours the new value.
  g.q("BLAST_DURATION_S = 2; blastUntil = -1");
  const t1 = g.simTime();
  g.q("applyCapsule(KIND_BLAST)");
  assert(g.q("blastUntil") === t1 + 2,
    `a re-caught capsule must honour the retuned duration (${t1 + 2}), got ${g.q("blastUntil")}`);
});

check("bricks at 30/89 px from the impact die, the 91 px brick survives; each death scores; the ball bounces normally", () => {
  const g = boot();
  startRun(g, "exciting");
  clearField(g);
  // Slab H on the ball's line; three companions on the impact row
  // (the ball's contact point) at 30 / 89 / 91 px.
  placeBrick(g, 0, 500, 320, 24, 20);        // the hit brick
  placeBrick(g, 1, 530, 338, 24, 20);        // 30 px
  placeBrick(g, 2, 589, 338, 24, 20);        // 89 px
  placeBrick(g, 3, 591, 338, 24, 20);        // 91 px
  parkBall(g, 0, 500, 360, 0, -100);
  g.q("random = () => 0.99"); // no capsule distracts the fixture
  g.q("applyCapsule(KIND_BLAST)");
  for (let i = 0; i < 120; i += 1) {
    g.tick(1);
    if (g.ballList()[0].vy > 0) break; // the slab hit has bounced
  }
  assert(!brickAlive(g, 0), "the hit brick must be destroyed");
  assert(!brickAlive(g, 1), "the 30 px brick must be destroyed by the blast");
  assert(!brickAlive(g, 2), "the 89 px brick (inside the 90 radius) must be destroyed by the blast");
  assert(brickAlive(g, 3), "the 91 px brick (outside the radius) must survive");
  const pts = g.q("POINTS_BRICK_C");
  assert(g.score() === 3 * pts,
    `every blast death must be scored individually (3 × ${pts} = ${3 * pts}), score is ${g.score()}`);
  const b = g.ballList()[0];
  assert(b.vy === 100, `the ball must bounce normally at its incoming speed, vy=${b.vy}`);
  assertClose(b.y, 320 + 10 + g.q("BALL_RADIUS"), 2,
    "the ball is pinned to the brick face like any ordinary hit");
});

check("destructions do not re-trigger blasts: a brick inside a destroyed neighbour's radius is scored, not chained", () => {
  const g = boot();
  startRun(g, "exciting");
  clearField(g);
  placeBrick(g, 0, 500, 320, 24, 20); // the hit brick H
  placeBrick(g, 1, 545, 338, 24, 20); // P: 45 px from the impact (blast-killed)
  placeBrick(g, 2, 596, 338, 24, 20); // Q: 96 px from the impact, 51 px from P
  parkBall(g, 0, 500, 360, 0, -100);
  g.q("random = () => 0.99");
  g.q("applyCapsule(KIND_BLAST)");
  for (let i = 0; i < 120; i += 1) {
    g.tick(1);
    if (g.ballList()[0].vy > 0) break;
  }
  assert(!brickAlive(g, 0) && !brickAlive(g, 1), "H and P must be blast-destroyed");
  assert(brickAlive(g, 2),
    "Q is outside the impact radius and must NOT die by chaining from P's destruction");
  const pts = g.q("POINTS_BRICK_C");
  assert(g.score() === 2 * pts,
    `only H and P are scored (${2 * pts}), score is ${g.score()}`);
});

check("a fixed brick at the impact centre anchors the blast without breaking; nearby breakables still die", () => {
  const g = boot();
  startRun(g, "exciting");
  clearField(g);
  placeBrick(g, 0, 500, 320, 24, 20, true); // fixed slab on the line
  placeBrick(g, 1, 530, 338, 24, 20);        // breakable, 30 px out
  parkBall(g, 0, 500, 360, 0, -100);
  g.q("random = () => 0.99");
  g.q("applyCapsule(KIND_BLAST)");
  for (let i = 0; i < 120; i += 1) {
    g.tick(1);
    if (g.ballList()[0].vy > 0) break;
  }
  assert(brickAlive(g, 0), "the fixed brick must survive the blast it anchors");
  assert(!brickAlive(g, 1), "the 30 px breakable must be destroyed by the anchored blast");
  const b = g.ballList()[0];
  assert(b.vy === 100, `the ball must bounce off the fixed brick normally, vy=${b.vy}`);
});

// ================================================================
// Criterion 5: durations are named, retunable vars (done above);
// every new capture gets a small distinct blip through the existing
// synth path, with the mute/volume plumbing honoured
// ================================================================
check("each new capsule kind schedules its own named blip recipe, distinct from the legacy catch blip and from each other", () => {
  const g = boot();
  startRun(g, "exciting");
  const names = ["SFX_CATCH_INVULNERABLE", "SFX_CATCH_MULTIBALL", "SFX_CATCH_BLAST"];
  const waves = g.q("[WAVE_SINE, WAVE_SQUARE, WAVE_NOISE]");
  for (const name of names) {
    const r = g.q(name);
    assert(r && waves.includes(r.wave), `${name} must be a named recipe on a named wave, got ${JSON.stringify(r)}`);
    assert(Number.isFinite(r.freq) && r.freq > 0, `${name}.freq must be a positive frequency, got ${r && r.freq}`);
    assert(Number.isFinite(r.dur) && r.dur > 0 && r.dur < 0.5, `${name}.dur must be a small positive duration, got ${r && r.dur}`);
  }
  // Route captures through a recording stand-in for scheduleSound
  // (the mute plumbing lives on the MASTER_BUS, which the real
  // scheduler reads per event — routing is what this test pins).
  g.q("scheduled = []; scheduleSound = function (r) { scheduled.push(r); };");
  const route = (kind) => {
    g.q("scheduled.length = 0");
    g.q(`applyCapsule(${kind})`);
    return g.q("scheduled.slice()"); // copy: later routes truncate the live array
  };
  const legacy = route("KIND_EXPAND");
  assert(legacy.length === 1, "a legacy capture must schedule exactly one blip");
  assert(legacy[0] === g.q("SFX_POWERUP_CATCH"), "legacy kinds keep the shared catch blip");
  const got = {
    inv: route("KIND_INVULNERABLE"),
    mb: route("KIND_MULTIBALL"),
    bl: route("KIND_BLAST"),
  };
  assert(got.inv.length === 1 && got.mb.length === 1 && got.bl.length === 1,
    "each new capture must schedule exactly one blip");
  const all = [g.q("SFX_POWERUP_CATCH"), got.inv[0], got.mb[0], got.bl[0]];
  assert(all[1] === g.q("SFX_CATCH_INVULNERABLE"), "the invulnerable capture routes to its named recipe");
  assert(all[2] === g.q("SFX_CATCH_MULTIBALL"), "the multiball capture routes to its named recipe");
  assert(all[3] === g.q("SFX_CATCH_BLAST"), "the blast capture routes to its named recipe");
  const sig = (r) => `${r.wave}:${r.freq}`;
  const sigs = all.map(sig);
  assert(new Set(sigs).size === 4,
    `all four capture blips must be acoustically distinct, got ${JSON.stringify(sigs)}`);
});

check("the mute plumbing is honoured: a muted master still receives the new blips, at a zero bus level", () => {
  const g = boot();
  startRun(g, "exciting");
  assert(g.q("MASTER_GAIN") > 0, "setup: the bus starts unmuted");
  g.q("applySoundSettings(true, 100)"); // mute wins over volume
  assert(g.q("MASTER_GAIN") === 0, `mute must zero the master bus level, got ${g.q("MASTER_GAIN")}`);
  g.q("scheduled = []; scheduleSound = function (r) { scheduled.push(r); };");
  g.q("applyCapsule(KIND_BLAST)");
  assert(g.q("scheduled.length") === 1,
    "the blast blip must still be routed through the synth path while muted");
  g.q("applySoundSettings(false, 100)");
  assert(g.q("MASTER_GAIN") === g.q("SOUND_BASE"), "unmuting restores the nominal bus level");
});

// ================================================================
// Criterion 6: pool identity invariants survive an exciting storm
// ================================================================
check("storm: multiball-to-cap plus a blast window leaves every pool length exactly as booted", () => {
  const g = boot();
  startRun(g, "exciting");
  clearField(g);
  const before = {
    balls: g.q("balls.length"),
    caps: g.q("capsules.length"),
    bricks: g.q("bricks.length"),
  };
  assert(before.balls === 30 && before.caps === 4 && before.bricks === 50,
    `setup: booted pools must be 30/4/50, got ${JSON.stringify(before)}`);
  for (let s = 0; s < 4; s += 1) parkBall(g, s, 300 + s * 100, 300, 0, -400);
  g.q("random = () => 0.99"); // the storm stays free of capsules
  g.q("applyCapsule(KIND_MULTIBALL)");
  assert(g.liveCount() === 30, "setup: the board is at the cap");
  g.q("applyCapsule(KIND_BLAST)");
  g.tick(300); // let the thirty balls fly (some fall, some bounce)
  const after = {
    balls: g.q("balls.length"),
    caps: g.q("capsules.length"),
    bricks: g.q("bricks.length"),
  };
  assert(JSON.stringify(after) === JSON.stringify(before),
    `every pool length must survive the storm, before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  assert(g.q("MAX_BALLS") === 5, "the classic MAX_BALLS cap constant is untouched");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
