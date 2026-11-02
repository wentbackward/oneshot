#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html brick grid, ball collision, scoring,
// levels and win condition (ticket #22)
//
// Same harness style as tests/bricks-paddle.test.mjs: runs the
// REAL <script> from bricks.html in a sandboxed vm context with
// stubbed window/document/canvas/DOM elements that record event
// listeners. Frames are driven through the captured
// requestAnimationFrame callback. Brick clears use the game's own
// destroyBrick() (console-style direct access, as the ticket's
// acceptance criteria prescribe); the tunnelling fixture reassigns
// the ball's velocity console-style and runs a single clamped frame.
// No network, no external services.
//
// Run: node tests/bricks-grid.test.mjs
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
    level: () => q("typeof level === 'undefined' ? NaN : level"),
    score: () => q("typeof score === 'undefined' ? NaN : score"),
    paddleX: () => q("typeof paddle === 'undefined' ? NaN : paddle.x"),
    ball: () =>
      q("typeof balls === 'undefined' ? null : ({ x: balls[0].x, y: balls[0].y, vx: balls[0].vx, vy: balls[0].vy, attached: balls[0].attached })"),
    serveY: () => q("canvas.height - PADDLE_BOTTOM_GAP - PADDLE_HEIGHT - BALL_RADIUS"),
    // Brick field accessors
    poolLen: () => q("typeof bricks === 'undefined' ? -1 : bricks.length"),
    bricksLeft: () => q("typeof bricksLeft === 'undefined' ? -1 : bricksLeft"),
    activeCount: () =>
      q("typeof bricks === 'undefined' ? -1 : bricks.reduce((n, b) => n + (b.active ? 1 : 0), 0)"),
    grid: () => q("typeof BRICK_ROWS === 'undefined' ? -1 : BRICK_ROWS * BRICK_COLS"),
    patterns: () => q("LEVEL_PATTERNS.map((p) => p.slice())"),
    brickAt(row, col) {
      const cols = q("BRICK_COLS");
      return q(`(() => {
        const t = bricks[${row * cols + col}];
        return { active: t.active, tier: t.tier, hp: t.hp, x: t.x, y: t.y, w: t.w, h: t.h };
      })()`);
    },
    canvasClick() {
      canvas.dispatch("click", { type: "click" });
    },
    canvasTap() {
      canvas.dispatch("touchend", { type: "touchend", preventDefault() {} });
    },
  };
}

const start = (g) => {
  g.els["btn-start"].click();
  g.tick(1);
};

// Destroy every active brick except the last one, returning the
// surviving brick's pool index (the win must be triggered by the
// caller, on exactly one final kill). The survivor must be a
// BREAKABLE brick — a fixed brick would make the final kill a
// no-op and stall the level (ticket #43).
function clearAllButLast(g) {
  return g.q(`(function () {
    var i;
    for (i = 0; i < bricks.length && bricksLeft > 1; i += 1) {
      if (bricks[i].active) destroyBrick(i);
    }
    for (i = 0; i < bricks.length; i += 1) if (bricks[i].active && !bricks[i].unbreakable) return i;
    return -1;
  })()`);
}

function winLevel(g) {
  const last = clearAllButLast(g);
  if (last < 0) throw new Error("setup: no surviving brick to finish the level");
  g.q(`destroyBrick(${last})`);
}

// Park a fresh ball just below the brick's underside, rising
// straight at 480 px/s: one frame travels 8 px, so a ball parked
// 2 px below the underside contacts within exactly one frame. The
// ball reflects and falls away after the strike, so one call lands
// exactly ONE hit — a multi-hit brick (ticket #42) needs one parked
// strike per hp point. Only the bottom row has open space beneath
// it, so callers target that row.
function strikeBrick(g, row, col) {
  const cols = g.q("BRICK_COLS");
  const idx = row * cols + col;
  const b = g.brickAt(row, col);
  if (!b.active) return g.brickAt(row, col);
  const hp0 = b.hp;
  g.q(`balls[0].attached = false;
       balls[0].x = ${b.x + b.w / 2};
       balls[0].y = ${b.y + b.h} + BALL_RADIUS + 2;
       balls[0].vx = 0; balls[0].vy = -480;`);
  for (
    let f = 0;
    f < 8 && g.q(`bricks[${idx}].active && bricks[${idx}].hp === ${hp0}`);
    f += 1
  )
    g.tick(1);
  return g.brickAt(row, col);
}

// ================================================================
// Criterion 1: on entering "playing" a grid of BRICK_ROWS ×
// BRICK_COLS bricks is spawned in a fixed-size pool (constant pool
// length across levels), ≥ 3 colours mapped to named per-colour
// point constants; initial count equals BRICK_ROWS * BRICK_COLS
// ================================================================
check("entering 'playing' spawns the full grid: initial active count equals BRICK_ROWS * BRICK_COLS", () => {
  const g = boot(960, 600);
  assert(g.activeCount() === 0,
    `no bricks may be active before the run starts, active=${g.activeCount()}`);
  start(g);
  const grid = g.grid();
  assert(grid > 0, `the grid dimensions must be positive, got ${grid}`);
  assert(g.poolLen() === grid,
    `the pool must hold exactly BRICK_ROWS*BRICK_COLS (${grid}) slots, got ${g.poolLen()}`);
  assert(g.activeCount() === grid,
    `every grid cell must be occupied, active=${g.activeCount()} want ${grid}`);
  assert(g.bricksLeft() === grid,
    `the live-brick counter must agree with the grid, bricksLeft=${g.bricksLeft()}`);
});

check("the brick pool is fixed-size: its length never changes across level transitions", () => {
  const g = boot(960, 600);
  start(g);
  const len0 = g.poolLen();
  assert(len0 === g.grid(), `setup: pool equals the grid, got ${len0}`);
  winLevel(g); // level 2
  assert(g.poolLen() === len0,
    `the pool must not grow or shrink at the level-2 spawn, ${len0} -> ${g.poolLen()}`);
  winLevel(g); // level 3
  assert(g.poolLen() === len0,
    `the pool must still hold ${len0} slots at level 3, got ${g.poolLen()}`);
  // Pattern-aware (ticket #43): level 3 is LEVEL_PATTERNS[2] (checker
  // scatter), not a full grid — its occupancy, not grid size, is the
  // refill invariant.
  const occ3 = g.patterns()[2].join("").replace(/\./g, "").length;
  assert(g.activeCount() === occ3,
    `the level-3 pattern must occupy exactly its own cells, active=${g.activeCount()} want ${occ3}`);
});

check("at least three brick colours map to named per-colour point constants", () => {
  const g = boot(960, 600);
  start(g);
  const tiers = g.q("BRICK_TIERS.map((t) => ({ color: t.color, points: t.points }))");
  assert(tiers.length >= 3, `the grid must use at least three colours, got ${tiers.length}`);
  assert(new Set(tiers.map((t) => t.color)).size === tiers.length,
    "tier colours must be distinct");
  for (const [colorName, pointsName] of [
    ["COLOR_BRICK_A", "POINTS_BRICK_A"],
    ["COLOR_BRICK_B", "POINTS_BRICK_B"],
    ["COLOR_BRICK_C", "POINTS_BRICK_C"],
  ]) {
    const color = g.q(colorName);
    const points = g.q(pointsName);
    assert(Number.isInteger(points) && points > 0,
      `${pointsName} must be a positive integer, got ${points}`);
    const tier = tiers.find((t) => t.color === color);
    assert(tier, `${colorName} (${color}) must back one of the grid tiers`);
    assert(tier.points === points,
      `${colorName} must map to ${pointsName} (${points}), its tier says ${tier.points}`);
  }
  const badTier = g.q("bricks.some((b) => b.tier < 0 || b.tier >= BRICK_TIERS.length)");
  assert(!badTier, "every brick must carry a valid tier index");
});

// ================================================================
// Criterion 2: one hit destroys the brick, adds exactly that
// colour's point value to the score, reflects the ball, and the
// top-bar score element mirrors the exact value
// ================================================================
check("a ball striking a two-hit brick reflects, and destroys only on the final strike", () => {
  const g = boot(960, 600);
  start(g);
  const before = g.activeCount();
  const b = strikeBrick(g, 4, 2);
  assert(b.active === true, "a single strike of a two-hit brick must not destroy it");
  assert(b.hp === g.q("BRICK_TIERS[1].hp") - 1,
    `the non-lethal strike must cost exactly one hp, got ${b.hp}`);
  assert(g.activeCount() === before && g.score() === 0,
    "the non-lethal strike must destroy nothing and credit nothing");
  const n = g.ball();
  assert(n.attached === false, "the ball must still be in flight after the bounce");
  assert(n.vy > 0, `the ball must reflect back down off the brick's underside, vy=${n.vy}`);
  assert(g.brickAt(4, 1).active && g.brickAt(4, 3).active,
    "neighbour bricks must survive the strike");
  const b2 = strikeBrick(g, 4, 2);
  assert(b2.active === false, "the second strike must destroy the brick");
  assert(g.activeCount() === before - 1,
    `exactly one brick may be destroyed in total, active=${g.activeCount()} want ${before - 1}`);
  assert(g.score() === g.q("BRICK_TIERS[1].points"),
    `the score must be credited once, on the lethal strike, got ${g.score()}`);
});

check("destroying a brick adds exactly that colour's point value and mirrors it in the top-bar score element", () => {
  const g = boot(960, 600);
  start(g);
  const tier = g.brickAt(4, 5).tier;
  const points = g.q(`BRICK_TIERS[${tier}].points`);
  assert(g.score() === 0, "setup: score starts at 0");
  strikeBrick(g, 4, 5); // first: non-lethal
  assert(g.score() === 0, "the non-lethal first strike must credit nothing");
  strikeBrick(g, 4, 5); // second: lethal
  assert(g.score() === points,
    `the score must rise by exactly the struck colour's value (${points}) once, got ${g.score()}`);
  assert(g.els["hud-score"].textContent === String(points),
    `#hud-score must read ${points}, got ${JSON.stringify(g.els["hud-score"].textContent)}`);
});

check("score accrues exactly per colour across the grid and the HUD mirrors the running total", () => {
  const g = boot(960, 600);
  start(g);
  const cols = g.q("BRICK_COLS");
  const pts = (row, col) => g.q(`BRICK_TIERS[bricks[${row * cols + col}].tier].points`);
  const tierObj = (row, col) => g.q(`BRICK_TIERS[bricks[${row * cols + col}].tier]`);
  // One physics strike per hp point (ticket #42): the struck bottom
  // brick is two-hit, so it takes two parked strikes; then two direct
  // kills of the two remaining tiers through the same destroyBrick
  // path.
  strikeBrick(g, 4, 5);
  strikeBrick(g, 4, 5);
  const s1 = pts(4, 5);
  g.q("destroyBrick(0)");            // top row, another tier
  g.q(`destroyBrick(${2 * cols + 9})`); // mid row, the third tier
  const tiersSeen = new Set([tierObj(4, 5), tierObj(0, 0), tierObj(2, 9)]);
  assert(tiersSeen.size === 3, `the three kills must cover three different colours, got ${tiersSeen.size}`);
  const want = s1 + pts(0, 0) + pts(2, 9);
  assert(g.score() === want,
    `the running total must be exactly the sum of the struck colours (${want}), got ${g.score()}`);
  assert(g.els["hud-score"].textContent === String(want),
    `#hud-score must mirror ${want}, got ${JSON.stringify(g.els["hud-score"].textContent)}`);
  assert(g.activeCount() === g.grid() - 3,
    `exactly three bricks may be gone, active=${g.activeCount()}`);
});

// ----------------------------------------------------------------
// Axis selection in collideBrick (review should-fix for #22):
// a side hit must reflect horizontally (vx flips, vy untouched,
// ball pinned to the brick face) and a near-corner hit must
// resolve along the single shallowest axis, preserving the
// incoming speed exactly. The fixture parks the ball directly in
// the overlap and calls collideBricks(balls[0]) console-style, so the
// outcome is frame-independent and deterministic. Column 0 is
// used because the brick gap is narrower than the ball radius:
// in an interior column the parked ball would also overlap the
// neighbour.
// ----------------------------------------------------------------
check("side hit: collideBricks reflects horizontally — vx flips, vy untouched, ball pinned to the brick face", () => {
  const g = boot(960, 600);
  start(g);
  const b = g.brickAt(4, 0);
  const r = g.q("BALL_RADIUS");
  g.q(`balls[0].attached = false;
       balls[0].x = ${b.x} - BALL_RADIUS + 0.5;   // 0.5 px into the left face
       balls[0].y = ${b.y + b.h / 2};              // centred on the brick
       balls[0].vx = 250; balls[0].vy = 0;`);
  const hit = g.q("collideBricks(balls[0])");
  assert(hit === true, "the overlapping side contact must register as a hit");
  const n = g.ball();
  assert(n.vx === -250, `vx must flip to exactly -250, got ${n.vx}`);
  assert(n.vy === 0, `vy must stay untouched at 0, got ${n.vy}`);
  assert(Math.abs(n.x - (b.x - r)) < 1e-5,
    `the ball must be pinned to the brick's left face, x=${n.x} want ${b.x - r}`);
  assert(n.y === b.y + b.h / 2, `y must be unchanged, got ${n.y}`);
  const d = g.brickAt(4, 0);
  assert(d.active === true, "the first strike of a two-hit brick is non-lethal");
  assert(d.hp === g.q("BRICK_TIERS[1].hp") - 1,
    `the non-lethal strike must cost exactly one hp, got ${d.hp}`);
  assert(g.score() === 0, "the non-lethal strike must credit nothing");
  // Second strike: a frame boundary must elapse first (the
  // per-brick, per-frame damage cap charges one hp per frame),
  // then re-park the same fixture and destroy for real.
  g.q("update(MAX_FRAME_SECONDS)");
  g.q(`balls[0].attached = false;
       balls[0].x = ${b.x} - BALL_RADIUS + 0.5;
       balls[0].y = ${b.y + b.h / 2};
       balls[0].vx = 250; balls[0].vy = 0;`);
  const hit2 = g.q("collideBricks(balls[0])");
  assert(hit2 === true, "the second side contact must register as a hit");
  assert(g.brickAt(4, 0).active === false, "the second strike must destroy the brick");
  assert(g.score() === g.q("BRICK_TIERS[1].points"),
    `the score must credit the tier's points exactly once, got ${g.score()}`);
  assert(g.activeCount() === g.grid() - 1, "exactly one brick may be destroyed");
  assert(g.brickAt(4, 1).active, "the neighbouring brick must survive");
});

check("near-corner hit: collideBricks resolves the shallowest axis — exactly one axis flips and the speed is preserved", () => {
  const g = boot(960, 600);
  start(g);
  const b = g.brickAt(4, 0); // bottom-left corner of the leftmost brick
  const r = g.q("BALL_RADIUS");
  g.q(`balls[0].attached = false;
       balls[0].x = ${b.x} - BALL_RADIUS + 0.2;   // 0.2 px into the side (shallow)
       balls[0].y = ${b.y + b.h} + BALL_RADIUS - 0.8; // 0.8 px into the bottom (deep)
       balls[0].vx = 200; balls[0].vy = -250;`);
  const speedBefore = Math.hypot(200, -250);
  const yPlaced = g.ball().y;
  const hit = g.q("collideBricks(balls[0])");
  assert(hit === true, "the near-corner contact must register as a hit");
  const n = g.ball();
  assert(Math.abs(n.x - (b.x - r)) < 1e-5,
    `x must be pinned to the shallow (side) face, x=${n.x} want ${b.x - r}`);
  assert(n.y === yPlaced, `y must be unchanged on a side resolution, got ${n.y}`);
  assert(n.vx === -200 && n.vy === -250,
    `exactly one axis may flip (the shallow, horizontal one): got vx=${n.vx} vy=${n.vy}`);
  assertClose(Math.hypot(n.vx, n.vy), speedBefore, 1e-9, "the incoming speed must be preserved");
  const d = g.brickAt(4, 0);
  assert(d.active === true, "the first strike of a two-hit brick is non-lethal");
  assert(d.hp === g.q("BRICK_TIERS[1].hp") - 1,
    `the non-lethal strike must cost exactly one hp, got ${d.hp}`);
  assert(g.score() === 0, "the non-lethal strike must credit nothing");
  // Second strike: a frame boundary must elapse first (the
  // per-brick, per-frame damage cap charges one hp per frame),
  // then re-park the same fixture and destroy for real.
  g.q("update(MAX_FRAME_SECONDS)");
  g.q(`balls[0].attached = false;
       balls[0].x = ${b.x} - BALL_RADIUS + 0.2;
       balls[0].y = ${b.y + b.h} + BALL_RADIUS - 0.8;
       balls[0].vx = 200; balls[0].vy = -250;`);
  const hit2 = g.q("collideBricks(balls[0])");
  assert(hit2 === true, "the second near-corner contact must register as a hit");
  assert(g.brickAt(4, 0).active === false, "the second strike must destroy the brick");
  assert(g.score() === g.q("BRICK_TIERS[1].points"),
    `the score must credit the tier's points exactly once, got ${g.score()}`);
  assert(g.activeCount() === g.grid() - 1, "exactly one brick may be destroyed");
});

// ================================================================
// Review finding 1 (round 2) + ticket #42 round 2: a side hit at
// row centre resolves and pins the ball in the seam (the gap is
// narrower than the ball). With one-hit bricks the drain ended by
// destroying both seam bricks; with multi-hit bricks the seam
// members survive, so the drain must be BOUNDED (ping-pong between
// mutually-exclusive pin faces would otherwise spin forever). The
// lock: the frame terminates with the ball in flight, exactly one
// hp per seam brick, and residual overlap confined to the
// documented seam artifact.
// ================================================================
function liveOverlapCount(g) {
  // Counts active bricks whose rect overlaps the ball, using the
  // same circle-vs-rect test as the game's collideBricks(balls[0]).
  return g.q(`(function () {
    var n = 0;
    for (var i = 0; i < bricks.length; i += 1) {
      var b = bricks[i];
      if (!b.active) continue;
      var ovx = b.w / 2 + BALL_RADIUS - Math.abs(balls[0].x - (b.x + b.w / 2));
      var ovy = b.h / 2 + BALL_RADIUS - Math.abs(balls[0].y - (b.y + b.h / 2));
      if (ovx > 0 && ovy > 0) n += 1;
    }
    return n;
  })()`);
}

check("row-centre side hit: the wedge frame terminates — bounded drain, accounted hp, residual seam overlap ≤ 1", () => {
  const g = boot(960, 600);
  start(g);
  const gap = g.q("BRICK_GAP");
  const r = g.q("BALL_RADIUS");
  assert(r * 2 > gap,
    `fixture precondition: the ball must be wider than the seam (${2 * r} > ${gap})`);
  const frame = g.q("MAX_FRAME_SECONDS");

  // Ball nudged 0.5 px into the left face of a row-centre brick
  // (bottom row, col 5), moving right: the x-resolution pins it to
  // the face, and that pinned position sits in the seam against the
  // col-4 neighbour. Without the drain, the frame ends with the ball
  // overlapping that neighbour.
  const b = g.brickAt(4, 5);
  g.q(`balls[0].attached = false;
       balls[0].x = ${b.x} - BALL_RADIUS + 0.5;
       balls[0].y = ${b.y + b.h / 2};
       balls[0].vx = 250; balls[0].vy = 0;`);
  assert(liveOverlapCount(g) >= 1, "setup: the parked ball must overlap a live brick");

  g.q(`update(${frame})`);

  // Multi-hit tiers change the wedge outcome: the seam bricks no
  // longer die in the wedge frame — each may spend at most one hp
  // (per-brick, per-frame damage cap), and the ball cannot clear
  // both seam faces in a gap narrower than itself, so the drain
  // rescan-caps (MAX_BRICK_RESCANS_PER_SUBSTEP). The regression
  // lock is TERMINATION + accounting: the frame ends, the ball is
  // in flight at full speed, each seam brick lost exactly one hp,
  // nothing else moved, and the residual overlap is the bounded,
  // documented seam artifact (≤ 1 seam-member brick).
  const left = g.brickAt(4, 4);
  const right = g.brickAt(4, 5);
  const hpB = g.q("BRICK_TIERS[1].hp");
  assert(left.active && right.active,
    "the two seam bricks must survive the wedge frame");
  assert(left.hp === hpB - 1,
    `the overlapped seam brick (col 4) must lose exactly one hp, got ${left.hp}`);
  assert(right.hp === hpB - 1,
    `the second seam brick (col 5) must lose exactly one hp, got ${right.hp}`);
  assert(g.brickAt(4, 3).active && g.brickAt(4, 6).active,
    "untouched neighbours must survive");
  assert(g.brickAt(4, 3).hp === hpB && g.brickAt(4, 6).hp === hpB,
    "untouched neighbours must keep full hp");
  assert(g.activeCount() === g.grid(),
    `nothing may be destroyed by the wedge frame, active=${g.activeCount()} want ${g.grid()}`);
  assert(g.score() === 0, "the non-lethal wedge frame must credit nothing");
  const residual = liveOverlapCount(g);
  assert(residual <= 1,
    `at most the one documented seam-artifact overlap may remain, found ${residual}`);
  const n = g.ball();
  assert(n.attached === false, "the ball must still be in flight");
  assert(Math.abs(n.vx) === 250 && n.vy === 0,
    `the ball must keep flying at the incoming speed, got vx=${n.vx} vy=${n.vy}`);
});

// ================================================================
// Criterion 3: no tunnelling — a deterministic fixture at the
// top-level maximum speed; one clamped frame displaces the ball
// farther than the whole brick band, yet the brick is still
// destroyed and the ball reflected. A naive one-step-integration
// implementation skips the target row entirely and fails this.
// ================================================================
check("tunnelling: a ball at the top-level max speed that skips a brick row in one clamped frame still strikes the brick and reflects", () => {
  const g = boot(960, 600);
  start(g);
  const TOP_LEVEL = 10; // level whose serve speed reaches the cap
  const cap = g.q("MAX_BALL_SPEED");
  const topSpeed = Math.min(
    g.q("BALL_SERVE_SPEED") * Math.pow(g.q("LEVEL_SPEED_GROWTH"), TOP_LEVEL - 1),
    cap
  );
  assert(topSpeed === cap,
    `the level-${TOP_LEVEL} speed must be the per-level maximum (the cap ${cap}), got ${topSpeed}`);

  const SEED_ROW = g.q("BRICK_ROWS") - 1; // seed: bottom row, col 5
  const SEED_COL = 5;
  const b = g.brickAt(SEED_ROW, SEED_COL);
  const r = g.q("BALL_RADIUS");
  const frame = g.q("MAX_FRAME_SECONDS");
  const travel = topSpeed * frame;
  assert(travel > b.h + 2 * r,
    `the fixture must truly skip the whole brick band in one clamped frame (travel ${travel}px > ${b.h + 2 * r}px)`);

  // Console-style fixture: ball tangent to the brick's underside,
  // velocity reassigned to the negative maximum per-level speed.
  g.q(`balls[0].attached = false;
       balls[0].x = ${b.x + b.w / 2};
       balls[0].y = ${b.y + b.h} + BALL_RADIUS;
       balls[0].vx = 0; balls[0].vy = -${topSpeed};`);
  g.q(`update(${frame})`);

  assert(g.brickAt(SEED_ROW, SEED_COL).active === true,
    `a single strike of a two-hit brick must not destroy it within the clamped frame`);
  assert(g.brickAt(SEED_ROW, SEED_COL).hp === g.q("BRICK_TIERS[1].hp") - 1,
    `the tunnelling pass must cost the seed brick exactly one hit, hp=${g.brickAt(SEED_ROW, SEED_COL).hp}`);
  const n = g.ball();
  assert(n.vy > 0, `the ball must reflect off the brick, vy=${n.vy}`);
  assert(g.activeCount() === g.grid(),
    `no brick may be destroyed by a single non-lethal strike, active=${g.activeCount()}`);
  assert(g.score() === 0, "the non-lethal strike must credit nothing");
});

// ================================================================
// Criterion 4: destroying every breakable brick increments the
// level by exactly 1, serves a fresh ball on the paddle, spawns
// the next level's layout, and multiplies the serve speed by the
// named LEVEL_SPEED_GROWTH (> 1) — level 2 = level 1 × growth,
// exactly
// ================================================================
check("destroying every breakable brick raises the level by exactly 1 and still credits the last brick", () => {
  const g = boot(960, 600);
  start(g);
  assert(g.level() === 1, "setup: level 1");
  const last = clearAllButLast(g);
  assert(last >= 0, "setup: exactly one brick must survive");
  const lvl = g.level();
  const scoreBefore = g.score();
  const pts = g.q(`BRICK_TIERS[bricks[${last}].tier].points`);
  g.q(`destroyBrick(${last})`);
  assert(g.level() === lvl + 1, `level must rise by exactly 1, ${lvl} -> ${g.level()}`);
  assert(g.score() === scoreBefore + pts,
    `the winning brick must still credit its points, ${scoreBefore} -> ${g.score()}`);
  assert(g.state() === "playing", "the run continues after a win, state=playing");
});

check("a level win serves a fresh ball attached to the paddle", () => {
  const g = boot(960, 600);
  start(g);
  winLevel(g);
  const n = g.ball();
  assert(n.attached === true, `the post-win ball must be served attached, got ${JSON.stringify(n)}`);
  assert(n.vx === 0 && n.vy === 0, `the fresh ball must be at rest, got vx=${n.vx} vy=${n.vy}`);
  assert(n.x === g.paddleX(), `the fresh ball must ride the paddle centre, x=${n.x} vs ${g.paddleX()}`);
  assertClose(n.y, g.serveY(), 1e-9, `the fresh ball must rest on the paddle top, y=${n.y}`);
  g.tick(5);
  assert(g.lives() === 3, `a win must not cost a life, lives=${g.lives()}`);
  assert(g.state() === "playing", `the frozen-state regression: still playing, state=${g.state()}`);
});

check("a level win spawns the next level's layout into the same fixed pool", () => {
  const g = boot(960, 600);
  start(g);
  const tierBefore = g.brickAt(0, 0).tier;
  winLevel(g);
  // Pattern-aware (ticket #43): level 2 is LEVEL_PATTERNS[1] (gated
  // fort) — its occupancy, not the full grid, is the refill invariant.
  const occ2 = g.patterns()[1].join("").replace(/\./g, "").length;
  assert(g.activeCount() === occ2,
    `the new level's pattern must occupy exactly its own cells, active=${g.activeCount()} want ${occ2}`);
  const tierAfter = g.brickAt(0, 0).tier;
  assert(tierAfter !== tierBefore,
    `the next level's layout must differ (top-row tier ${tierBefore} -> ${tierAfter})`);
  assert(g.poolLen() === g.grid(), `...without growing the pool, got ${g.poolLen()}`);
});

check("a level win multiplies the serve speed by LEVEL_SPEED_GROWTH: level 2 equals level 1 x growth, exactly", () => {
  const g = boot(960, 600);
  start(g);
  assert(g.q("serveSpeed") === g.q("BALL_SERVE_SPEED"),
    `level 1 must serve at the base speed, got ${g.q("serveSpeed")}`);
  winLevel(g);
  const grown = g.q("serveSpeed");
  const want = g.q("BALL_SERVE_SPEED") * g.q("LEVEL_SPEED_GROWTH");
  assert(grown === want,
    `the level-2 serve speed must be exactly base x growth (${want}), got ${grown}`);
});

check("launching the level-2 ball flies at exactly level 1 speed x LEVEL_SPEED_GROWTH", () => {
  const g = boot(960, 600);
  start(g);
  winLevel(g);
  g.canvasClick();
  const n = g.ball();
  const want = g.q("BALL_SERVE_SPEED") * g.q("LEVEL_SPEED_GROWTH");
  assert(n.attached === false, "the launch must detach the ball");
  assert(n.vy < 0, `the launch must be upward, vy=${n.vy}`);
  assert(Math.hypot(n.vx, n.vy) === want,
    `the launch speed must be exactly ${want}, got ${Math.hypot(n.vx, n.vy)}`);
});

check("LEVEL_SPEED_GROWTH is a named var above 1; the serve speed caps at MAX_BALL_SPEED from level 10 on", () => {
  const g = boot(960, 600);
  start(g);
  assert(g.q("LEVEL_SPEED_GROWTH") > 1,
    `LEVEL_SPEED_GROWTH must exceed 1, got ${g.q("LEVEL_SPEED_GROWTH")}`);
  const cap = g.q("MAX_BALL_SPEED");
  let s9 = NaN;
  for (let lv = 2; lv <= 10; lv += 1) {
    if (lv === 10) s9 = g.q("serveSpeed"); // still under cap at level 9
    winLevel(g);
    assert(g.level() === lv, `advance ${lv - 1} -> ${lv}, got ${g.level()}`);
  }
  assert(s9 < cap, `level 9 must still be under the cap (${s9} < ${cap})`);
  assert(g.q("serveSpeed") === cap,
    `the level-10 serve speed must be capped exactly at ${cap}, got ${g.q("serveSpeed")}`);
  winLevel(g); // level 11: the cap holds
  assert(g.q("serveSpeed") === cap,
    `beyond the cap the serve speed must hold at ${cap}, got ${g.q("serveSpeed")}`);
});

// ================================================================
// Criterion 5: the level value is shown in the top-bar HUD and
// matches the internal level after each win
// ================================================================
check("the top-bar level readout matches the internal level after each win", () => {
  const g = boot(960, 600);
  start(g);
  assert(g.els["hud-level"].textContent === "1",
    `the HUD must read 1 at run start, got ${JSON.stringify(g.els["hud-level"].textContent)}`);
  winLevel(g);
  assert(g.els["hud-level"].textContent === "2",
    `the HUD must read 2 after the first win, got ${JSON.stringify(g.els["hud-level"].textContent)}`);
  winLevel(g);
  assert(g.els["hud-level"].textContent === String(g.level()),
    `the HUD (${JSON.stringify(g.els["hud-level"].textContent)}) must match the internal level (${g.level()})`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
