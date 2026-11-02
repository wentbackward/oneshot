#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html extra ball and sticky paddle power-ups
// (ticket #26)
//
// Same harness style as tests/bricks-powerups.test.mjs: runs the REAL
// <script> from bricks.html in a sandboxed vm context with stubbed
// window/document/canvas/DOM elements. Timing is asserted by driving
// the captured requestAnimationFrame callback and sampling the ball
// pool / paddle / sim clock each frame. Drops are forced
// deterministically by reassigning the game's mutable `random` hook
// with a scripted two-value sequence (drop roll, then kind roll);
// effects are also exercised directly through applyCapsule().
// The two-ball life-loss fixtures are fully deterministic: the brick
// field is cleared, the paddle parked at the far rim, and both balls
// given identical small downward velocities at known heights, so each
// loss lands on a known frame (or, in the same-frame fixture, both
// losses land on ONE frame). No network, no external services.
//
// Run: node tests/bricks-multiball.test.mjs
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
// internal canvas is width×CANVAS_SCALE by height×CANVAS_SCALE.
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
    simTime: () => q("typeof simTime === 'undefined' ? NaN : simTime"),
    paddleX: () => q("typeof paddle === 'undefined' ? NaN : paddle.x"),
    paddleW: () => q("typeof paddleW === 'undefined' ? NaN : paddleW"),
    baseW: () => q("typeof BASE_PADDLE_W === 'undefined' ? NaN : BASE_PADDLE_W"),
    canvasH: () => q("canvas.height"),
    capsActiveInfo: () =>
      q("typeof capsules === 'undefined' ? [] : capsules.filter((c) => c.active).map((c) => ({ kind: c.kind, x: c.x, y: c.y }))"),
    ballList: () =>
      q(
        "typeof balls === 'undefined' ? [] : balls.map((b, i) => ({ i: i, active: b.active, attached: b.attached, x: b.x, y: b.y, vx: b.vx, vy: b.vy }))"
      ),
    liveCount: () =>
      q("typeof balls === 'undefined' ? -1 : balls.reduce((n, b) => n + (b.active ? 1 : 0), 0)"),
    stickyUntil: () => q("typeof stickyUntil === 'undefined' ? NaN : stickyUntil"),
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

// Clear the whole brick field without touching score / drops / levels.
const clearBricks = (g) =>
  g.q("for (var i = 0; i < bricks.length; i += 1) bricks[i].active = false; bricksLeft = 0; 1");

// Pin the game's `random` hook to a two-value sequence — the drop
// roll, then the kind roll — with a never-drop fallback afterwards,
// and aim the paddle at brick (4,8).
function armScriptedDrop(g, kind) {
  const rate = g.q("POWERUP_DROP_RATE");
  assert(
    Number.isFinite(rate) && rate > 0 && rate < 1,
    `POWERUP_DROP_RATE must be a probability in (0,1), got ${rate}`
  );
  const len = g.q("CAPSULE_KINDS.length");
  const b = g.brickAt(4, 8);
  g.q(`random = (function (seq, miss) {
    return function () { return seq.length > 0 ? seq.shift() : miss; };
  })([${rate / 2}, ${(kind + 0.5) / len}], ${Math.min(1 - 1e-9, rate * 1.5)});
     paddle.x = ${b.x + b.w / 2};`);
  g.q("destroyBrick(4 * BRICK_COLS + 8)");
  const info = g.capsActiveInfo();
  assert(info.length === 1, `setup: the kill must release exactly one capsule, got ${info.length}`);
  assert(info[0].kind === kind, `setup: the drop must be kind ${kind}, got ${info[0].kind}`);
  for (let i = 0; i < 600 && g.capsActiveInfo().length === 1; i += 1) g.tick(1);
  assert(g.capsActiveInfo().length === 0, "the capsule must be caught by the aimed paddle");
  return g.simTime(); // sim time of the catching frame (updated before the power-up pass)
}

// ================================================================
// Setup: the two new capsule kinds are enumerated with exhaustive
// colour-table rows
// ================================================================
check("KIND_EXTRA and KIND_STICKY are enumerated in CAPSULE_KINDS with exhaustive CAPSULE_COLORS rows", () => {
  const g = boot(960, 600);
  start(g);
  const kinds = g.q("CAPSULE_KINDS");
  const extra = g.q("KIND_EXTRA");
  const sticky = g.q("KIND_STICKY");
  assert(Number.isInteger(extra) && extra > 0, `KIND_EXTRA must be a named positive int, got ${extra}`);
  assert(Number.isInteger(sticky) && sticky > 0 && sticky !== extra, `KIND_STICKY must be a named distinct int, got ${sticky}`);
  assert(kinds.includes(extra) && kinds.includes(sticky), "both new kinds must be entries of CAPSULE_KINDS");
  const table = g.q("CAPSULE_COLORS");
  assert(Array.isArray(table) && table.length === kinds.length,
    "CAPSULE_COLORS must stay exhaustive: one row per kind, none left over");
  assert(kinds.every((k) => typeof table[k] === "string" && table[k].length > 0),
    "every enumerated kind needs a colour-table row");
  assert(g.q("COLOR_CAPSULE_EXTRA") === table[extra], "the extra kind maps to COLOR_CAPSULE_EXTRA");
  assert(g.q("COLOR_CAPSULE_STICKY") === table[sticky], "the sticky kind maps to COLOR_CAPSULE_STICKY");
});

// ================================================================
// Criterion 1: catching an Extra Ball capsule spawns one additional
// active ball at the paddle; catches accumulate up to the named
// MAX_BALLS cap, beyond which further catches add no ball.
// ================================================================
check("catching an extra capsule spawns one additional active ball at the paddle", () => {
  const g = boot(960, 600);
  start(g);
  assert(g.liveCount() === 1, "setup: one serve ball at the start of the run");
  const before = g.ballList();
  assert(before.filter((b) => b.active).length === 1, "setup: exactly one slot is active");
  g.q("applyCapsule(KIND_EXTRA)");
  const after = g.ballList();
  assert(after.filter((b) => b.active).length === 2,
    `the live-ball count must increase by exactly one, got ${after.filter((b) => b.active).length}`);
  const fresh = after.find((b) => b.active && !before.some((o) => o.i === b.i && o.active));
  assert(fresh, "a previously-inactive slot must be the spawned ball");
  const pt = g.q("paddleTop()");
  const R = g.q("BALL_RADIUS");
  assert(Math.abs(fresh.x - g.paddleX()) < 1e-9,
    `the new ball must spawn at the paddle's x (${fresh.x} vs ${g.paddleX()})`);
  assert(Math.abs(fresh.y - (pt - R)) < 1e-9,
    `the new ball must spawn at the paddle top face (y ${fresh.y} vs ${pt - R})`);
  assert(fresh.vy === -g.q("serveSpeed") && fresh.vx === 0,
    `the new ball must join active play straight up at the serve speed (vx=${fresh.vx}, vy=${fresh.vy})`);
  assert(!fresh.attached, "the spawned ball is live, not parked on the paddle");
});

check("catching a dropped extra capsule increases the live-ball count by exactly one", () => {
  const g = boot(960, 600);
  start(g);
  assert(g.liveCount() === 1, "setup: one serve ball before the catch");
  const extra = g.q("KIND_EXTRA");
  // The serve ball rides the paddle while attached (it counts as a
  // live ball) so the capsule fall is free of interfering physics.
  armScriptedDrop(g, extra);
  assert(g.liveCount() === 2,
    `a caught extra capsule must raise the live-ball count to 2, got ${g.liveCount()}`);
  assert(g.paddleW() === g.baseW(), "an extra catch must not widen the paddle");
  assert(g.stickyUntil() === -1, "an extra catch must not arm sticky mode");
});

check("extra catches accumulate up to the named MAX_BALLS cap, and catches beyond the cap add no ball", () => {
  const g = boot(960, 600);
  start(g);
  const MAXB = g.q("MAX_BALLS");
  assert(Number.isInteger(MAXB) && MAXB >= 2, `MAX_BALLS must be a named integer >= 2, got ${MAXB}`);
  assert(g.q("MAX_BALLS_EXCITE") > MAXB,
    `MAX_BALLS_EXCITE must exceed the classic cap, got ${g.q("MAX_BALLS_EXCITE")}`);
  assert(g.q("balls.length") === g.q("MAX_BALLS_EXCITE"),
    `the ball pool must be sized to MAX_BALLS_EXCITE at boot (ticket #75), got ${g.q("balls.length")}`);
  for (let k = 1; k <= MAXB + 2; k += 1) {
    g.q("applyCapsule(KIND_EXTRA)");
    const want = Math.min(MAXB, 1 + k);
    assert(g.liveCount() === want,
      `catch ${k}: live count must be min(MAX_BALLS, 1+k) = ${want}, got ${g.liveCount()}`);
    assert(g.q("balls.length") === g.q("MAX_BALLS_EXCITE"),
      `the pool must never grow past its boot size MAX_BALLS_EXCITE, got ${g.q("balls.length")}`);
  }
  assert(g.liveCount() === MAXB,
    `past the cap further catches must add no ball, live=${g.liveCount()}`);
});

// ================================================================
// Criterion 2 (deterministic two-ball fixture): losing one ball while
// >= 2 are live does NOT decrement lives; when the LAST live ball
// falls, lives decrease by exactly 1 and a fresh serve happens.
//
// Fixture: the serve is launched, an extra capsule spawns ball #2,
// the brick field is cleared, the paddle is parked at the far-right
// rim, and both balls are parked mid-field at x=100/140 with equal
// downward velocities. At 120 px/s (2 px/frame on the 1/60 s frame)
// ball #0 (y=430) crosses the loss line at exactly frame 390 and
// ball #1 (y=410) at exactly frame 400 on the 1920×1200 canvas.
// ================================================================
function twoBallFixture(g) {
  start(g);
  g.canvas.dispatch("click"); // launch the serve
  assert(g.ballList().some((b) => b.active && !b.attached), "setup: the serve is in flight");
  g.q("applyCapsule(KIND_EXTRA)");
  assert(g.liveCount() === 2, "setup: the fixture has two live balls");
  clearBricks(g);
  g.q(`paddle.x = 1860;
       for (var j = 0; j < balls.length; j += 1) balls[j].attached = false;
       balls[0].x = 100; balls[0].y = 430; balls[0].vx = 0; balls[0].vy = 120;
       balls[1].x = 140; balls[1].y = 410; balls[1].vx = 0; balls[1].vy = 120;`);
}

check("losing one ball while two are live does NOT decrement lives (deterministic two-ball fixture)", () => {
  const g = boot(960, 600);
  twoBallFixture(g);
  assert(g.lives() === g.q("PLAYER_LIVES"), "setup: the run starts with full lives");
  g.tick(390); // frame 390: ball #0 crosses the loss line
  const list = g.ballList();
  const dead = list.find((b) => b.i === 0);
  const alive = list.find((b) => b.i === 1);
  assert(dead && !dead.active, "setup: ball #0 has fallen off the bottom edge");
  assert(alive && alive.active, "setup: ball #1 is still in play");
  assert(g.lives() === g.q("PLAYER_LIVES"),
    `losing one of two live balls must not touch lives, got ${g.lives()}`);
  assert(g.liveCount() === 1, `one live ball must remain, got ${g.liveCount()}`);
  assert(!alive.attached, "the surviving ball keeps flying — no premature re-serve");
  assert(g.state() === "playing", `the run must continue, state=${g.state()}`);
});

check("when the last live ball falls, lives decrease by exactly 1 and a fresh serve happens (deterministic two-ball fixture)", () => {
  const g = boot(960, 600);
  twoBallFixture(g);
  const startLives = g.lives();
  g.tick(390);
  assert(g.lives() === startLives, "setup: the first loss costs nothing while a ball remains");
  g.tick(10); // frame 400: ball #1 crosses the loss line
  assert(g.liveCount() === 1, `the fresh serve leaves exactly one live ball, got ${g.liveCount()}`);
  const served = g.ballList().find((b) => b.active);
  assert(served.attached, "the fresh serve must park an attached ball on the paddle");
  assert(Math.abs(served.x - g.paddleX()) < 1e-9, "the served ball rides the paddle centre");
  assert(Math.abs(served.y - (g.q("paddleTop()") - g.q("BALL_RADIUS"))) < 1e-9,
    "the served ball sits on the paddle top face");
  assert(g.lives() === startLives - 1,
    `the last-ball loss must cost exactly one life, got ${g.lives()} (was ${startLives})`);
  assert(g.state() === "playing", `the run must continue, state=${g.state()}`);
});

// Same-frame variant of the fixture: both balls sit at the SAME height,
// so both cross the loss line during the very same updateBalls() pass.
// The pool-order loop deactivates ball #0 first (a ball still lives,
// no life is spent), then ball #1 (last live ball → exactly ONE
// loseLife() call, ONE fresh serve). No double life loss, no double
// serve, no stale slot 0.
function twoBallSameFrameFixture(g) {
  start(g);
  g.canvas.dispatch("click"); // launch the serve
  g.q("applyCapsule(KIND_EXTRA)");
  assert(g.liveCount() === 2, "setup: the fixture has two live balls");
  clearBricks(g);
  g.q(`paddle.x = 1860;
       for (var j = 0; j < balls.length; j += 1) balls[j].attached = false;
       balls[0].x = 100; balls[0].y = 430; balls[0].vx = 0; balls[0].vy = 120;
       balls[1].x = 140; balls[1].y = 430; balls[1].vx = 0; balls[1].vy = 120;`);
}

check("a same-frame double drop loses exactly one life and produces exactly one fresh serve",
  () => {
    const g = boot(960, 600);
    twoBallSameFrameFixture(g);
    const startLives = g.lives();
    g.tick(390); // frame 390: BOTH balls cross the loss line in one updateBalls() pass
    assert(g.liveCount() === 1, `the fresh serve must leave exactly one live ball, got ${g.liveCount()}`);
    const list = g.ballList();
    const served = list.find((b) => b.active);
    assert(list.filter((b) => b.active).length === 1, "exactly one slot may be active after the double drop");
    assert(served.i === 0, "the fresh serve must occupy the slot 0 rest pose");
    assert(served.attached, "the fresh serve must park an attached ball on the paddle");
    assert(Math.abs(served.x - g.paddleX()) < 1e-9, "the served ball rides the paddle centre");
    assert(Math.abs(served.y - (g.q("paddleTop()") - g.q("BALL_RADIUS"))) < 1e-9,
      "the served ball sits on the paddle top face");
    assert(served.vx === 0 && served.vy === 0, "the parked serve ball holds still awaiting the click");
    assert(g.lives() === startLives - 1,
      `the double drop must cost exactly one life in total, got ${g.lives()} (was ${startLives})`);
    assert(g.state() === "playing", `the run must continue, state=${g.state()}`);
  });

// ================================================================
// Criterion 3: catching a Sticky capsule activates sticky mode for
// STICKY_DURATION_S of simulation time — the next ball to touch the
// paddle attaches and follows the paddle, a click/tap launches it
// with the position-dependent angle logic, and after the duration
// elapses a subsequent contact reflects instead of catching. Both
// boundaries asserted by driving frames and sampling state.
// ================================================================
check("catching a sticky capsule arms sticky mode for exactly STICKY_DURATION_S of simulation time", () => {
  const g = boot(960, 600);
  start(g);
  const D = g.q("STICKY_DURATION_S");
  assert(typeof D === "number" && D > 0, `STICKY_DURATION_S must be a named positive duration, got ${D}`);
  assert(g.stickyUntil() === -1, "setup: no sticky mode armed at run start");
  const t0 = g.simTime();
  g.q("applyCapsule(KIND_STICKY)");
  assert(g.stickyUntil() === t0 + D,
    `the catch must arm the expiry at catch time + full duration (${t0 + D}), got ${g.stickyUntil()}`);
  assert(g.paddleW() === g.baseW(), "a sticky catch must not widen the paddle");
  assert(g.liveCount() === 1, "a sticky catch must not change the ball count");
});

check("catching a dropped sticky capsule arms sticky mode on the catching frame", () => {
  const g = boot(960, 600);
  start(g);
  const D = g.q("STICKY_DURATION_S");
  const tEnd = armScriptedDrop(g, g.q("KIND_STICKY"));
  // The helper returns the sim time of the catching frame itself: the
  // frame loop increments simTime before the power-up update runs, so
  // the capsule is observed inactive at the very frame that caught it.
  assertClose(g.stickyUntil(), tEnd + D, 1e-9,
    "the dropped sticky capsule must arm the expiry at catch time + full duration");
  assert(g.paddleW() === g.baseW(), "the sticky catch must not widen the paddle");
  assert(g.liveCount() === 1, "the sticky catch must not change the ball count");
});

check("while sticky, the next ball to touch the paddle attaches at its contact offset and follows paddle movement", () => {
  const g = boot(960, 600);
  start(g);
  clearBricks(g);
  g.q("applyCapsule(KIND_STICKY)");
  g.q(`paddle.x = 500;
       balls[0].x = 520; balls[0].y = 800; balls[0].vx = 0; balls[0].vy = 300; balls[0].attached = false;`);
  let guard = 0;
  while (!g.ballList().find((b) => b.i === 0).attached && guard < 300) {
    g.tick(1);
    guard += 1;
  }
  const b0 = g.ballList().find((b) => b.i === 0);
  assert(b0.attached, "the descending ball must attach to the sticky paddle");
  assert(Math.abs(b0.x - (500 + 20)) < 1e-9,
    `the ball must attach at its contact offset (+20 from the paddle centre, x=${b0.x})`);
  assert(Math.abs(b0.y - (g.q("paddleTop()") - g.q("BALL_RADIUS"))) < 1e-9,
    "the attached ball sits on the paddle top face");
  assert(b0.vx === 0 && b0.vy === 0, "the attached ball holds still — its motion is paddle-driven");
  g.q("paddle.x = 700");
  g.tick(1);
  const followed = g.ballList().find((b) => b.i === 0);
  assert(followed.attached, "the ball stays attached after the paddle moves");
  assert(Math.abs(followed.x - 720) < 1e-9,
    `the attached ball must follow the paddle keeping its offset (x=${followed.x}, want 720)`);
  assert(Math.abs(followed.y - (g.q("paddleTop()") - g.q("BALL_RADIUS"))) < 1e-9,
    "the attached ball keeps riding the paddle top face");
});

check("a click launches the attached ball with the position-dependent angle logic at the serve speed", () => {
  const g = boot(960, 600);
  start(g);
  clearBricks(g);
  g.q("applyCapsule(KIND_STICKY)");
  g.q(`paddle.x = 500;
       balls[0].x = 520; balls[0].y = 800; balls[0].vx = 0; balls[0].vy = 300; balls[0].attached = false;`);
  let guard = 0;
  while (!g.ballList().find((b) => b.i === 0).attached && guard < 300) {
    g.tick(1);
    guard += 1;
  }
  assert(g.ballList().find((b) => b.i === 0).attached, "setup: the ball is attached");
  // Draw 0.5 is the launch jitter's zero-crossing, so this test keeps
  // pinning the pure position-angle law; the jitter itself is covered
  // by tests/bricks-serve-jitter.test.mjs.
  g.q("random = function () { return 0.5; };");
  g.canvas.dispatch("click");
  const b0 = g.ballList().find((b) => b.i === 0);
  assert(!b0.attached, "the click must detach the ball");
  const speed = g.q("serveSpeed");
  const rel = 20 / (g.q("paddleW") / 2); // contact offset +20 over the half width
  const angle = rel * g.q("MAX_PADDLE_BOUNCE_ANGLE");
  assertClose(b0.vx, speed * Math.sin(angle), 1e-9, "vx must follow the position-dependent angle logic");
  assertClose(b0.vy, -speed * Math.cos(angle), 1e-9, "vy must follow the position-dependent angle logic");
  assertClose(Math.hypot(b0.vx, b0.vy), speed, 1e-9, "the launch speed is exactly the serve speed");
  assert(b0.vy < 0, "the launched ball must leave the paddle upward");
});

check("once the sticky duration elapses, a subsequent paddle contact reflects the ball instead of catching it", () => {
  const g = boot(960, 600);
  start(g);
  clearBricks(g);
  g.q("applyCapsule(KIND_STICKY)");
  // Ball descends slowly from y=200: it reaches the paddle top face
  // at ~13.6 s, well after the 6 s sticky arm has expired.
  g.q(`paddle.x = 100;
       balls[0].x = 100; balls[0].y = 200; balls[0].vx = 0; balls[0].vy = 70; balls[0].attached = false;`);
  let bounced = false;
  let guard = 0;
  while (!bounced && guard < 1200) {
    g.tick(1);
    guard += 1;
    const b0 = g.ballList().find((b) => b.i === 0);
    if (b0.vy < 0) bounced = true;
  }
  assert(g.simTime() > g.q("STICKY_DURATION_S"), `setup: the sticky arm must be long expired (sim=${g.simTime()})`);
  assert(bounced, "the ball must reflect off the paddle after the sticky window");
  const b0 = g.ballList().find((b) => b.i === 0);
  assert(!b0.attached, "the ball must NOT attach once the sticky duration has elapsed");
  assert(b0.vy < 0, "the reflected ball leaves the paddle upward");
  assertClose(Math.abs(b0.vy), 70, 1e-9, "the reflection preserves the incoming speed");
  assert(b0.y <= g.q("paddleTop()") - g.q("BALL_RADIUS") + 1e-9,
    "the ball is pushed out above the paddle, not left inside it");
  g.tick(10);
  const after = g.ballList().find((b) => b.i === 0);
  assert(after.vy < 0 && !after.attached,
    "the ball keeps flying free after the late reflection — no delayed catch");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
