#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html paddle control, ball launch, wall/paddle
// bounces, lives and game over (ticket #21)
//
// Same harness style as tests/bricks-scaffold.test.mjs: runs the
// REAL <script> from bricks.html in a sandboxed vm context with
// stubbed window/document/canvas/DOM elements that record event
// listeners and child nodes. Frames are driven through the captured
// requestAnimationFrame callback; keyboard, pointer, launch and
// restart are dispatched into the registered listeners. No network,
// no external services.
//
// Run: node tests/bricks-paddle.test.mjs
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
// child nodes (lives icons are appended/removed in the real game).
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
    "screen-gameover": makeEl("screen-gameover"),
    "btn-restart": makeEl("btn-restart"),
    "gameover-final": makeEl("gameover-final"),
    "hud-score": makeEl("hud-score"),
    "hud-level": makeEl("hud-level"),
    "hud-high": makeEl("hud-high"),
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
    for (let i = 0; i < n; i++) {
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
    win: sandbox.window,
    q,
    tick,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    lives: () => q("typeof lives === 'undefined' ? NaN : lives"),
    paddleX: () => q("typeof paddle === 'undefined' ? NaN : paddle.x"),
    ball: () =>
      q("typeof ball === 'undefined' ? null : ({ x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy, attached: ball.attached })"),
    serveY: () =>
      q("canvas.height - PADDLE_BOTTOM_GAP - PADDLE_HEIGHT - BALL_RADIUS"),
    lifeIcons: () => els.lives.children.length,
    key(type, code) {
      fireWin(type, { code, preventDefault() {} });
    },
    blur() {
      fireWin("blur", { type: "blur" });
    },
    mouseMove(clientX) {
      canvas.dispatch("mousemove", { clientX });
    },
    touchDrag(clientX) {
      canvas.dispatch("touchmove", {
        touches: [{ clientX }],
        preventDefault() {},
      });
    },
    canvasClick() {
      canvas.dispatch("click", { type: "click" });
    },
    canvasTap() {
      canvas.dispatch("touchend", { type: "touchend", preventDefault() {} });
    },
    resize() {
      fireWin("resize", { type: "resize" });
    },
    // Teleport a flying ball past the bottom edge; one tick drops it.
    dropBall() {
      q(
        "ball.attached = false; ball.vx = 0; ball.vy = 300;\n" +
          "ball.x = paddle.x; ball.y = canvas.height + 50;"
      );
      tick(1);
    },
  };
}

const start = (g) => {
  g.els["btn-start"].click();
  g.tick(1);
};

// Park a flying ball one frame above the paddle top, dropping
// vertically (vx = 0) at the paddle-relative offset the game itself
// normalises: rel is a fraction of the half width, exactly as the
// bounce handler computes it (-1 = left rim, -0.75 = left-quarter
// centre = offset -0.375·PADDLE_WIDTH, 0 = centre, 0.75 = right
// quarter, 1 = right rim). Vertical approach keeps the contact point
// exactly where the fixture places the ball.
function incomingHit(g, rel) {
  g.q(
    "paddle.x = canvas.width / 2;\n" +
      "ball.attached = false;\n" +
      "ball.x = paddle.x + (PADDLE_WIDTH / 2) * " + rel + ";\n" +
      "ball.y = (canvas.height - PADDLE_BOTTOM_GAP - PADDLE_HEIGHT) - BALL_RADIUS - 5;\n" +
      "ball.vx = 0; ball.vy = 400;"
  );
}

const IN_SPEED = 400;

// ================================================================
// Criterion: keyboard — ArrowLeft/ArrowRight, KeyA/KeyD keydown moves
// the paddle, keyup stops it, x stays clamped within the canvas
// ================================================================
check("keyboard: ArrowLeft and KeyA keydown move the paddle left, keyup stops it", () => {
  for (const code of ["ArrowLeft", "KeyA"]) {
    const g = boot(960, 600);
    start(g);
    const x0 = g.paddleX();
    g.key("keydown", code);
    g.tick(3);
    const x1 = g.paddleX();
    assert(x1 < x0, `${code} must move the paddle left (${x0} -> ${x1})`);
    g.key("keyup", code);
    g.tick(5);
    assert(g.paddleX() === x1,
      `${code} must stop moving the paddle on keyup (moved from ${x1} to ${g.paddleX()})`);
  }
});

check("keyboard: ArrowRight and KeyD keydown move the paddle right, keyup stops it", () => {
  for (const code of ["ArrowRight", "KeyD"]) {
    const g = boot(960, 600);
    start(g);
    const x0 = g.paddleX();
    g.key("keydown", code);
    g.tick(3);
    const x1 = g.paddleX();
    assert(x1 > x0, `${code} must move the paddle right (${x0} -> ${x1})`);
    g.key("keyup", code);
    g.tick(5);
    assert(g.paddleX() === x1,
      `${code} must stop moving the paddle on keyup (moved from ${x1} to ${g.paddleX()})`);
  }
});

check("keyboard: a held key presses the paddle to the canvas edge and no further", () => {
  const W = (g) => g.q("canvas.width");
  const half = (g) => g.q("PADDLE_WIDTH / 2");
  const right = boot(960, 600);
  start(right);
  right.key("keydown", "ArrowRight");
  right.tick(600);
  assertClose(right.paddleX(), W(right) - half(right), 1e-9,
    `the right-held paddle must clamp to the right edge, got ${right.paddleX()}`);
  right.key("keyup", "ArrowRight");
  right.key("keydown", "ArrowLeft");
  right.tick(600);
  assertClose(right.paddleX(), half(right), 1e-9,
    `the left-held paddle must clamp to the left edge, got ${right.paddleX()}`);
  right.key("keyup", "ArrowLeft");
});

// ================================================================
// Review lock-in: a blurred window drops its keyups, so the held-key
// sets must be cleared with it — the paddle cannot glide on ghosts.
// ================================================================
check("a window blur clears the held keys so the paddle cannot glide on ghosts", () => {
  const g = boot(960, 600);
  start(g);
  g.key("keydown", "ArrowLeft");
  g.tick(3);
  const x1 = g.paddleX();
  g.blur(); // focus left: the keyup for ArrowLeft never arrives
  g.tick(5);
  assert(g.paddleX() === x1,
    `blur must clear the held keys; the paddle glided from ${x1} to ${g.paddleX()}`);
});

// ================================================================
// Review fix: releasing one of two held same-direction keys must
// keep the paddle moving (per-direction held-key counters)
// ================================================================
check("releasing one of two held same-direction keys keeps the paddle moving; releasing all stops it", () => {
  for (const [a, b, sign] of [["ArrowLeft", "KeyA", -1], ["ArrowRight", "KeyD", 1]]) {
    const g = boot(960, 600);
    start(g);
    g.key("keydown", a);
    g.key("keydown", b);
    g.tick(3);
    const x1 = g.paddleX();
    g.key("keyup", a); // first of the two same-direction keys released
    g.tick(3);
    const x2 = g.paddleX();
    assert(
      (x2 - x1) * sign > 0,
      `${a}+${b} held: releasing ${a} must keep the paddle moving ${sign < 0 ? "left" : "right"} ` +
      `(${x1} -> ${x2}), it stopped`
    );
    g.key("keyup", b);
    g.tick(5);
    assert(g.paddleX() === x2,
      `releasing all held keys must stop the paddle (moved from ${x2} to ${g.paddleX()})`);
  }
});

check("auto-repeat keydowns of one held key do not change the paddle speed", () => {
  const g = boot(960, 600);
  start(g);
  g.key("keydown", "ArrowLeft");
  g.tick(3);
  const x1 = g.paddleX();
  g.key("keydown", "ArrowLeft"); // browser auto-repeat re-dispatches
  g.key("keydown", "ArrowLeft");
  g.tick(3);
  const x2 = g.paddleX();
  const distRepeat = x1 - x2; // distance in the 3 frames after repeats
  const distRef = (g.q("PADDLE_SPEED") / 60) * 3; // 3 frames at 60 fps
  assertClose(distRepeat, distRef, distRef * 0.01,
    `auto-repeat must not alter the travel per 3 frames: got ${distRepeat}, want ${distRef}`);
});

// ================================================================
// Criterion: pointer — mousemove / touchmove set the paddle x to the
// cursor's transformed x (within 1 px, including the responsive scale)
// ================================================================
check("a dispatched mousemove over the canvas sets the paddle x to the transformed cursor x (within 1 px)", () => {
  const g = boot(960, 600); // canvas is 1920 wide internally (scale 2)
  start(g);
  g.mouseMove(100);
  const want = (100 / 960) * g.canvas.width; // 200
  assertClose(g.paddleX(), want, 1,
    `mousemove clientX 100 must land the paddle at ${want} px, got ${g.paddleX()}`);
});

check("mousemove honours the responsive scale after a viewport resize", () => {
  const g = boot(960, 600);
  start(g);
  g.win.innerWidth = 480;
  g.win.innerHeight = 800;
  g.resize();
  g.tick(1); // deferred rescale
  assert(g.canvas.width === 960 && g.canvas.height === 1600,
    `the canvas must rescale to 960x1600, got ${g.canvas.width}x${g.canvas.height}`);
  g.mouseMove(50);
  const want = (50 / 480) * g.canvas.width; // 100
  assertClose(g.paddleX(), want, 1,
    `post-resize mousemove clientX 50 must land the paddle at ${want} px, got ${g.paddleX()}`);
});

check("a dispatched touchmove drag sets the paddle x the same way (within 1 px)", () => {
  const g = boot(960, 600);
  start(g);
  g.touchDrag(300);
  const want = (300 / 960) * g.canvas.width; // 600
  assertClose(g.paddleX(), want, 1,
    `touchmove clientX 300 must land the paddle at ${want} px, got ${g.paddleX()}`);
});

check("pointer positions beyond the canvas clamp the paddle inside the field", () => {
  const g = boot(960, 600);
  start(g);
  g.mouseMove(-5000);
  assertClose(g.paddleX(), g.q("PADDLE_WIDTH / 2"), 1e-9,
    `a far-left pointer must clamp the paddle to the left edge, got ${g.paddleX()}`);
  g.mouseMove(50000);
  assertClose(g.paddleX(), g.q("canvas.width - PADDLE_WIDTH / 2"), 1e-9,
    `a far-right pointer must clamp the paddle to the right edge, got ${g.paddleX()}`);
});

check("a mousemove before the game starts also moves the paddle (serve aiming)", () => {
  const g = boot(960, 600);
  g.mouseMove(100); // state "start"
  const want = (100 / 960) * g.canvas.width;
  assertClose(g.paddleX(), want, 1,
    `pointer tracking must work on the start screen too, got ${g.paddleX()}`);
});

// ================================================================
// Criterion: the ball spawns attached to the paddle centre and only
// moves while attached; a click/tap launches it upward at the named
// serve speed
// ================================================================
check("a fresh run serves a ball attached to the paddle centre", () => {
  const g = boot(960, 600);
  start(g);
  const b = g.ball();
  assert(b.attached === true, `the served ball must be attached, got ${JSON.stringify(b)}`);
  assert(b.x === g.paddleX(), `the ball must ride the paddle centre, got x=${b.x} vs ${g.paddleX()}`);
  assertClose(b.y, g.serveY(), 1e-9, `the ball must rest on the paddle top, got y=${b.y}`);
});

check("an attached ball only moves by following the paddle (vx/vy stay zero)", () => {
  const g = boot(960, 600);
  start(g);
  const b0 = g.ball();
  g.key("keydown", "ArrowLeft");
  g.tick(4);
  const b1 = g.ball();
  assert(b1.x !== b0.x, `the attached ball must follow the moving paddle, x stayed ${b0.x}`);
  assert(b1.x === g.paddleX(), `the attached ball must track the paddle centre, got x=${b1.x} vs ${g.paddleX()}`);
  assert(b1.vx === 0 && b1.vy === 0,
    `an attached ball must have no velocity of its own, got vx=${b1.vx} vy=${b1.vy}`);
  assertClose(b1.y, g.serveY(), 1e-9, `the attached ball must stay on the paddle top, got y=${b1.y}`);
});

check("a dispatched canvas click launches the attached ball upward at BALL_SERVE_SPEED", () => {
  const g = boot(960, 600);
  start(g);
  const serveSpeed = g.q("BALL_SERVE_SPEED");
  g.canvasClick();
  const b = g.ball();
  assert(b.attached === false, "the click must detach the ball");
  assert(b.vy < 0, `the launched ball must move upward, vy=${b.vy}`);
  assertClose(Math.hypot(b.vx, b.vy), serveSpeed, serveSpeed * 0.01,
    `the launch speed must be the named serve speed (${serveSpeed}), got ${Math.hypot(b.vx, b.vy)}`);
});

check("a dispatched canvas tap (touchend) also launches the attached ball", () => {
  const g = boot(960, 600);
  start(g);
  g.canvasTap();
  const b = g.ball();
  assert(b.attached === false, "the tap must detach the ball");
  assert(b.vy < 0, `the launched ball must move upward, vy=${b.vy}`);
});

check("a click on an already-launched ball does nothing (no re-launch)", () => {
  const g = boot(960, 600);
  start(g);
  g.canvasClick();
  g.tick(10);
  const b0 = g.ball();
  g.canvasClick();
  const b1 = g.ball();
  assert(b1.vx === b0.vx && b1.vy === b0.vy,
    `a second click must not re-launch the flying ball, velocity changed to (${b1.vx}, ${b1.vy})`);
});

// ================================================================
// Criterion: paddle bounce angle is position-dependent and preserves
// speed within 1%
// ================================================================
check("identical incoming hit at the paddle's left quarter comes out leftward with larger |vx| than a centre hit", () => {
  const left = boot(960, 600);
  start(left);
  incomingHit(left, -0.75); // left-quarter centre (offset -0.375·W)
  assert(
    left.ball().x === left.q("paddle.x - PADDLE_WIDTH * 0.375"),
    `the fixture must sit at the true left quarter (offset -0.375·W), x=${left.ball().x}`
  );
  left.tick(1);
  const bl = left.ball();
  assert(bl.attached === false, "the ball must still be in flight after the bounce");
  assert(bl.vx < 0, `a left-quarter hit must send the ball left, vx=${bl.vx}`);
  const centre = boot(960, 600);
  start(centre);
  incomingHit(centre, 0);
  centre.tick(1);
  const bc = centre.ball();
  assert(Math.abs(bc.vx) < 1, `a centre hit must send the ball straight up, vx=${bc.vx}`);
  assert(Math.abs(bl.vx) > Math.abs(bc.vx),
    `the left-quarter |vx| (${Math.abs(bl.vx)}) must exceed the centre |vx| (${Math.abs(bc.vx)})`);
});

check("an identical incoming hit at the right quarter comes out rightward", () => {
  const g = boot(960, 600);
  start(g);
  incomingHit(g, 0.75); // right-quarter centre (offset +0.375·W)
  g.tick(1);
  const b = g.ball();
  assert(b.vx > 0, `a right-quarter hit must send the ball right, vx=${b.vx}`);
  assert(b.vy < 0, `the bounce must kick the ball back up, vy=${b.vy}`);
});

check("the paddle bounce preserves the incoming speed within 1%", () => {
  for (const rel of [-0.75, 0, 0.75]) {
    const g = boot(960, 600);
    start(g);
    incomingHit(g, rel);
    g.tick(1);
    const b = g.ball();
    assertClose(Math.hypot(b.vx, b.vy), IN_SPEED, IN_SPEED * 0.01,
      `the bounce at offset ${rel} must preserve speed ${IN_SPEED}, got ${Math.hypot(b.vx, b.vy)}`);
    assert(b.y <= g.serveY() + 1e-6,
      `the ball must be pushed out above the paddle, y=${b.y} (serveY=${g.serveY()})`);
  }
});

// ================================================================
// Criterion: wall bounces preserve speed within 1% per reflection and
// never leave the field (600-frame seeded soak)
// ================================================================
function wallReflection(place, axis, expectSign) {
  const g = boot(960, 600);
  start(g);
  g.q(place);
  const s0 = g.q("Math.hypot(ball.vx, ball.vy)");
  g.tick(1);
  const b = g.ball();
  assert(b[`${axis}`] * expectSign > 0,
    `the ${axis} velocity must reflect to ${expectSign > 0 ? "positive" : "negative"}, got ${b[axis]}`);
  assertClose(Math.hypot(b.vx, b.vy), s0, s0 * 0.01,
    `the wall reflection must preserve speed ${s0}, got ${Math.hypot(b.vx, b.vy)}`);
  return g;
}

check("the ball reflects off the right wall in the field, preserving speed within 1%", () => {
  const g = wallReflection(
    "ball.attached = false; ball.x = canvas.width - BALL_RADIUS - 3; ball.y = 500; ball.vx = 300; ball.vy = 120;",
    "vx", -1);
  assert(g.ball().x <= g.q("canvas.width - BALL_RADIUS") + 1e-6,
    `the ball must not pass the right edge, x=${g.ball().x}`);
});

check("the ball reflects off the left wall in the field, preserving speed within 1%", () => {
  const g = wallReflection(
    "ball.attached = false; ball.x = BALL_RADIUS + 3; ball.y = 500; ball.vx = -300; ball.vy = 120;",
    "vx", 1);
  assert(g.ball().x >= g.q("BALL_RADIUS") - 1e-6,
    `the ball must not pass the left edge, x=${g.ball().x}`);
});

check("the ball reflects off the top wall in the field, preserving speed within 1%", () => {
  const g = wallReflection(
    "ball.attached = false; ball.x = 700; ball.y = BALL_RADIUS + 3; ball.vx = 100; ball.vy = -300;",
    "vy", 1);
  assert(g.ball().y >= g.q("BALL_RADIUS") - 1e-6,
    `the ball must not pass the top edge, y=${g.ball().y}`);
});

check("soak: over 600 seeded frames the ball never leaves the field and its speed stays within 1%", () => {
  const g = boot(960, 600);
  start(g);
  const W = g.q("canvas.width");
  const R = g.q("BALL_RADIUS");
  g.q("ball.attached = false; ball.x = 300; ball.y = 250; ball.vx = 500; ball.vy = -310;");
  const s0 = Math.hypot(500, 310);
  let touchedTop = false;
  let touchedRight = false;
  for (let f = 0; f < 600; f += 1) {
    g.q("paddle.x = ball.x;"); // omniscient catcher: the ball never falls
    g.tick(1);
    const b = g.ball();
    assert(b.x >= R - 1e-6 && b.x <= W - R + 1e-6,
      `frame ${f}: the ball left the field horizontally, x=${b.x}`);
    assert(b.y >= R - 1e-6, `frame ${f}: the ball left the field upward, y=${b.y}`);
    assert(b.y - R <= g.q("canvas.height"),
      `frame ${f}: the ball fell out of the field, y=${b.y}`);
    assertClose(Math.hypot(b.vx, b.vy), s0, s0 * 0.01,
      `frame ${f}: the speed drifted from ${s0}, got ${Math.hypot(b.vx, b.vy)}`);
    if (b.y <= R + 1e-6) touchedTop = true;
    if (b.x >= W - R - 1e-6) touchedRight = true;
  }
  assert(touchedTop && touchedRight,
    `the soak must actually reflect off the top and right walls, got top=${touchedTop} right=${touchedRight}`);
  assert(g.lives() === 3, `the soak must not lose any lives, lives=${g.lives()}`);
});

// ================================================================
// Criterion: falling below the bottom edge drops exactly one life
// (PLAYER_LIVES = 3) and serves a fresh ball; at 0 lives the game
// enters "gameover" with the overlay and a working Try Again
// ================================================================
check("PLAYER_LIVES is the named constant 3, and a fresh run shows 3 life icons in #lives", () => {
  const g = boot(960, 600);
  assert(g.q("PLAYER_LIVES") === 3, `PLAYER_LIVES must equal 3, got ${g.q("PLAYER_LIVES")}`);
  start(g);
  assert(g.lives() === 3, `a fresh run must hold 3 lives, got ${g.lives()}`);
  assert(g.lifeIcons() === 3, `#lives must hold exactly 3 icons, got ${g.lifeIcons()}`);
});

check("a ball below the bottom edge decrements lives by exactly 1 and serves a fresh attached ball", () => {
  const g = boot(960, 600);
  start(g);
  g.dropBall();
  assert(g.lives() === 2, `one drop must cost exactly one life, lives=${g.lives()}`);
  assert(g.lifeIcons() === 2, `#lives must hold exactly 2 icons after one drop, got ${g.lifeIcons()}`);
  const b = g.ball();
  assert(b.attached === true, `a fresh ball must be served attached, got ${JSON.stringify(b)}`);
  assert(b.vx === 0 && b.vy === 0, `the fresh ball must be at rest, got vx=${b.vx} vy=${b.vy}`);
  assert(b.x === g.paddleX(), `the fresh ball must ride the paddle centre, x=${b.x}`);
  assertClose(b.y, g.serveY(), 1e-9, `the fresh ball must rest on the paddle top, y=${b.y}`);
  g.tick(10);
  assert(g.lives() === 2, `the attached ball must not cost further lives, lives=${g.lives()}`);
});

check("#lives contains exactly `lives` children after each lost life", () => {
  const g = boot(960, 600);
  start(g);
  assert(g.lifeIcons() === g.lives(), "icons must track lives after the fresh serve");
  g.dropBall();
  assert(g.lives() === 2 && g.lifeIcons() === 2,
    `after the 1st drop: lives=${g.lives()} icons=${g.lifeIcons()}, want 2/2`);
  g.dropBall();
  assert(g.lives() === 1 && g.lifeIcons() === 1,
    `after the 2nd drop: lives=${g.lives()} icons=${g.lifeIcons()}, want 1/1`);
});

check("when lives reach 0 the game enters 'gameover' with the overlay and a Try Again button", () => {
  const g = boot(960, 600);
  start(g);
  g.dropBall();
  g.dropBall();
  g.dropBall();
  assert(g.lives() === 0, `lives must reach 0, got ${g.lives()}`);
  assert(g.state() === "gameover", `the game must be in "gameover", state=${g.state()}`);
  assert(g.els["screen-gameover"].style.display === "flex",
    `the game-over overlay must be visible, display=${JSON.stringify(g.els["screen-gameover"].style.display)}`);
  assert(g.els["screen-start"].style.display === "none",
    `the start overlay must be hidden at game over`);
  assert(g.lifeIcons() === 0, `#lives must hold 0 icons at game over, got ${g.lifeIcons()}`);
  assert(
    /<button\b[^>]*id="btn-restart"[^>]*>\s*try again\s*<\/button>/i.test(html),
    "the game-over overlay markup must carry a Try Again <button id=btn-restart>"
  );
});

check("clicking Try Again restarts a fresh run: lives 3, score 0, 'playing', no live ball or leftovers", () => {
  const g = boot(960, 600);
  start(g);
  g.q("score = 120;");
  g.dropBall();
  g.dropBall();
  g.dropBall();
  assert(g.state() === "gameover", "setup must end on game over");
  g.els["btn-restart"].click();
  assert(g.state() === "playing", `restart must enter "playing", state=${g.state()}`);
  assert(g.lives() === 3, `restart must restore 3 lives, got ${g.lives()}`);
  assert(g.q("score") === 0, `restart must reset the score, got ${g.q("score")}`);
  assert(g.els["screen-gameover"].style.display === "none",
    `the game-over overlay must hide after restart, display=${JSON.stringify(g.els["screen-gameover"].style.display)}`);
  assert(g.lifeIcons() === 3, `#lives must hold 3 icons after restart, got ${g.lifeIcons()}`);
  const b = g.ball();
  assert(b.attached === true && b.vx === 0 && b.vy === 0,
    `restart must leave no live (flying) ball from the previous run, got ${JSON.stringify(b)}`);
  assert(b.x === g.paddleX() && b.y === g.serveY(),
    `restart must serve a fresh attached ball, got (${b.x}, ${b.y})`);
});

check("the game-over overlay is hidden on boot and throughout play", () => {
  const g = boot(960, 600);
  assert(g.els["screen-gameover"].style.display === "none",
    `the game-over overlay must be hidden on boot, display=${JSON.stringify(g.els["screen-gameover"].style.display)}`);
  start(g);
  g.tick(20);
  assert(g.els["screen-gameover"].style.display === "none",
    `the game-over overlay must stay hidden while playing`);
});

// ================================================================
// Review round 2: Start Game is gated on the start screen, for
// symmetry with the Try Again gate on the game-over screen.
// ================================================================
check("a Start Game click only works from the start screen (symmetry with the gated restart)", () => {
  const g = boot(960, 600);
  start(g);
  g.q("score = 7;");
  g.els["btn-start"].click();
  assert(g.state() === "playing" && g.q("score") === 7,
    `a stray Start click mid-run must be a no-op, state=${g.state()} score=${g.q("score")}`);
  g.dropBall();
  g.dropBall();
  g.dropBall();
  assert(g.state() === "gameover", "setup must end on game over");
  g.els["btn-start"].click();
  g.els["btn-start"].click();
  assert(g.state() === "gameover",
    `Start clicks on the game-over screen must not restart the run, state=${g.state()}`);
  assert(g.lives() === 0, `Start clicks on game over must not touch the lives, lives=${g.lives()}`);
  g.els["btn-restart"].click();
  assert(g.state() === "playing" && g.lives() === 3,
    `Try Again must still be the working restart path, state=${g.state()} lives=${g.lives()}`);
});

check("a stray Try Again click during a live run is a no-op", () => {
  const g = boot(960, 600);
  start(g);
  g.q("score = 5;");
  g.els["btn-restart"].click();
  assert(g.state() === "playing", `stray restart click must not change the state, state=${g.state()}`);
  assert(g.q("score") === 5, `stray restart click must not reset the score, got ${g.q("score")}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
