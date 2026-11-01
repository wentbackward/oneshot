#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html multi-hit brick durability (ticket #42)
//
// Same harness style as tests/bricks-grid.test.mjs: runs the REAL
// <script> from bricks.html in a sandboxed vm context with stubbed
// window/document/canvas/DOM elements. Unlike the grid harness the
// canvas 2d context here RECORDS fillStyle/fillRect calls so the
// damage-rendering criterion can be asserted behaviourally, not
// only by grepping the source. Frames are driven through the
// captured requestAnimationFrame callback; strikes park the ball
// console-style and run a single real frame so each contact costs
// exactly one hit. No network, no external services.
//
// Acceptance criteria covered:
//   AC1 — non-lethal hit on an hp>1 brick: one frame decrements hp
//         by exactly 1; brick stays active, no score, no capsule,
//         bricksLeft unchanged, ball reflected.
//   AC2 — second (lethal) hit: brick deactivated, score credited
//         with exactly BRICK_TIERS[tier].points once, bricksLeft
//         decremented once.
//   AC3 — damage renders distinctly: drawBricks carries a branch
//         keyed on `b.hp < BRICK_TIERS[b.tier].hp` (source +
//         behaviour); one-hit bricks render exactly as before.
//   AC4 — spawnLevel()/beginRun() reset every pool entry's hp from
//         the tier table (mid-run A brick destroyed, board cleared,
//         new board at full hp).
//   AC5 — `node tests/bricks-*.test.mjs` exits 0 with no allocation
//         churn: pool length and entry shape stay invariant across
//         repeated hits; the hit path allocates no objects.
//   REGRESSION (review round 1) — seam scrape: two same-frame
//         contacts on an hp-2 brick charge exactly once (per-frame
//         damage cap); BOTH bricks end the frame at hp 1, alive,
//         and die only on a subsequent (next-frame) contact.
//
// Run: node tests/bricks-durability.test.mjs
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

// A DOM element stub: records style writes, text, listeners.
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

// A canvas 2d context stub that RECORDS every method call along
// with the fillStyle in force at call time (property writes are
// kept, so later reads see the current value).
function makeCtx(record) {
  const store = {};
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === "symbol") return store[prop];
        if (prop in store) return store[prop];
        return (...args) =>
          record.push({ op: String(prop), args, fillStyle: store.fillStyle });
      },
      set(_t, prop, value) {
        store[prop] = value;
        return true;
      },
    }
  );
}

// Boot a fresh copy of the game on a width×height viewport.
function boot(width = 960, height = 600) {
  const draw = [];
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    rect: { left: 0, top: 0, width, height },
    getBoundingClientRect: () => canvas.rect,
    listeners: {},
    getContext: () => makeCtx(draw),
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
    draw,
    q,
    tick,
    ball: () =>
      q("({ x: balls[0].x, y: balls[0].y, vx: balls[0].vx, vy: balls[0].vy, attached: balls[0].attached })"),
    score: () => q("score"),
    poolLen: () => q("bricks.length"),
    bricksLeft: () => q("bricksLeft"),
    activeCount: () =>
      q("bricks.reduce((n, b) => n + (b.active ? 1 : 0), 0)"),
    grid: () => q("BRICK_ROWS * BRICK_COLS"),
    brickAt(row, col) {
      const cols = q("BRICK_COLS");
      return q(`(() => {
        const t = bricks[${row * cols + col}];
        return { active: t.active, tier: t.tier, hp: t.hp, x: t.x, y: t.y, w: t.w, h: t.h };
      })()`);
    },
  };
}

const start = (g) => {
  g.els["btn-start"].click();
  g.tick(1); // warms lastFrameTime; this frame's dt is 0
};

// Park the ball just under a bottom-row brick, 2 px clear of its
// underside, rising straight at 480 px/s: one real frame travels
// 8 px, so the contact lands inside exactly that frame. Returns the
// brick's pool index. Only the bottom row has open space beneath it.
function parkUnder(g, row, col) {
  const cols = g.q("BRICK_COLS");
  const idx = row * cols + col;
  const b = g.brickAt(row, col);
  g.q(`balls[0].attached = false;
       balls[0].x = ${b.x + b.w / 2};
       balls[0].y = ${b.y + b.h} + BALL_RADIUS + 2;
       balls[0].vx = 0; balls[0].vy = -480;`);
  return idx;
}

// One parked rising strike = exactly one hit: park, run the single
// frame in which the contact lands, return the struck brick's state.
function strike(g, row, col) {
  parkUnder(g, row, col);
  g.tick(1);
  return g.brickAt(row, col);
}

// Park the ball 0.5 px into the left face of a leftmost-column
// brick, moving right, and call collideBricks() console-style: a
// frame-independent, deterministic side hit. Returns the pool index.
function sidePark(g, row, col) {
  const cols = g.q("BRICK_COLS");
  const idx = row * cols + col;
  const b = g.brickAt(row, col);
  g.q(`balls[0].attached = false;
       balls[0].x = ${b.x} - BALL_RADIUS + 0.5;
       balls[0].y = ${b.y + b.h / 2};
       balls[0].vx = 250; balls[0].vy = 0;`);
  return idx;
}

// Find the recorded fillRect for a brick's rect within a draw pass.
function rectFill(g, b) {
  return g.draw.find(
    (d) =>
      d.op === "fillRect" &&
      Math.abs(d.args[0] - b.x) < 1e-6 &&
      Math.abs(d.args[1] - b.y) < 1e-6 &&
      Math.abs(d.args[2] - b.w) < 1e-6
  );
}

function renderPass(g) {
  g.draw.length = 0;
  g.q("draw()");
}

// Parse "#rrggbb" to a channel sum so "darker" is checkable.
const rgbSum = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not an #rrggbb colour: ${hex}`);
  return (
    parseInt(m[1].slice(0, 2), 16) +
    parseInt(m[1].slice(2, 4), 16) +
    parseInt(m[1].slice(4, 6), 16)
  );
};

// ================================================================
// Tier table + pool: each BRICK_TIERS row carries an hp field
// (A=3, B=2, C=1 via named constants; colours and points kept), and
// spawnLevel() stores the tier's hp on every pool entry without
// resizing the pool
// ================================================================
check("BRICK_TIERS rows carry an hp field: A=3, B=2, C=1 via named constants, colours and points kept", () => {
  const g = boot(960, 600);
  start(g);
  const hps = g.q("BRICK_TIERS.map((t) => t.hp)");
  const want = [g.q("HP_BRICK_A"), g.q("HP_BRICK_B"), g.q("HP_BRICK_C")];
  assert(hps.length === 3, `the three tiers must each have an hp, got ${JSON.stringify(hps)}`);
  for (let t = 0; t < 3; t += 1) {
    assert(Number.isInteger(want[t]) && want[t] >= 1,
      `HP_BRICK_${"ABC"[t]} must be a positive integer, got ${want[t]}`);
    assert(hps[t] === want[t],
      `tier ${"ABC"[t]} must carry hp = HP_BRICK_${"ABC"[t]} (${want[t]}), got ${hps[t]}`);
  }
  assert(g.q("HP_BRICK_A") === 3 && g.q("HP_BRICK_B") === 2 && g.q("HP_BRICK_C") === 1,
    `the chosen durability curve is A=3, B=2, C=1, got ${JSON.stringify(want)}`);
  assert(hps[0] > 1, "the top tier must be multi-hit");
  assert(hps[2] === 1, "the base tier must stay one-hit");
  const colors = g.q("BRICK_TIERS.map((t) => t.color)");
  const points = g.q("BRICK_TIERS.map((t) => t.points)");
  assert(colors.join() === [g.q("COLOR_BRICK_A"), g.q("COLOR_BRICK_B"), g.q("COLOR_BRICK_C")].join(),
    "the tier colours must be unchanged");
  assert(points.join() === "30,20,10",
    `the tier points must be unchanged (30,20,10), got ${JSON.stringify(points)}`);
});

check("spawnLevel stores the tier's hp on every pool entry without resizing the pool", () => {
  const g = boot(960, 600);
  start(g);
  const grid = g.grid();
  assert(g.poolLen() === grid, `setup: pool equals the grid, got ${g.poolLen()}`);
  const bad = g.q("bricks.filter((b) => b.active && (typeof b.hp !== 'number' || b.hp !== BRICK_TIERS[b.tier].hp)).length");
  assert(bad === 0, `every live brick must start at its tier's full hp, ${bad} do not`);
  assert(g.activeCount() === grid, "the whole grid must be live");
  assert(g.bricksLeft() === grid, "bricksLeft must equal the grid");
});

// ================================================================
// AC1: one frame against a known hp>1 brick decrements hp by
// exactly 1 — brick still active, score unchanged, no capsule
// activated, bricksLeft unchanged, ball reflected
// ================================================================
check("non-lethal hit: one frame against a two-hit brick decrements hp by exactly 1, scores nothing, drops nothing, keeps bricksLeft", () => {
  const g = boot(960, 600);
  start(g);
  const grid = g.grid();
  const b0 = g.brickAt(4, 2); // level-1 row 4 is tier B (two hits)
  assert(b0.tier === 1, `setup: bottom row must be the two-hit tier, got tier ${b0.tier}`);
  assert(b0.hp === 2, `setup: the struck brick must start at hp 2, got ${b0.hp}`);
  const bottom = b0.y + b0.h;

  parkUnder(g, 4, 2);
  g.tick(1); // the single frame in which the contact lands

  const b1 = g.brickAt(4, 2);
  assert(b1.active === true, "the non-lethally struck brick must still be active");
  assert(b1.hp === 1, `hp must be decremented by exactly 1 (2 -> 1), got ${b1.hp}`);
  assert(g.score() === 0, `a non-lethal hit must score nothing, score=${g.score()}`);
  assert(g.bricksLeft() === grid,
    `a non-lethal hit must not decrement bricksLeft, got ${g.bricksLeft()} want ${grid}`);
  assert(g.activeCount() === grid, `no brick may be destroyed, active=${g.activeCount()}`);
  assert(g.q("capsules.every((c) => !c.active)") === true,
    "a non-lethal hit must activate no capsule");
  const n = g.ball();
  assert(n.attached === false, "the ball must still be in flight");
  assert(n.vy > 0, `the ball must reflect back down off the brick's underside, vy=${n.vy}`);
  assert(Math.abs(n.y - (bottom + g.q("BALL_RADIUS"))) < 1e-5,
    `the ball must be pinned to the brick's underside, y=${n.y} want ${bottom + g.q("BALL_RADIUS")}`);
  assert(g.brickAt(4, 1).active && g.brickAt(4, 3).active,
    "neighbour bricks must survive");
});

// ================================================================
// AC2: the second (lethal) hit on the same brick deactivates it,
// credits exactly BRICK_TIERS[tier].points once, decrements
// bricksLeft once
// ================================================================
check("lethal hit: the second strike destroys the brick and credits its tier's points exactly once", () => {
  const g = boot(960, 600);
  start(g);
  const grid = g.grid();
  strike(g, 4, 5); // first: non-lethal
  assert(g.score() === 0, "the non-lethal first strike must credit nothing");
  assert(g.brickAt(4, 5).active === true, "setup: the brick must still be standing");
  strike(g, 4, 5); // second: lethal
  const b = g.brickAt(4, 5);
  assert(b.active === false, "the lethally struck brick must be deactivated");
  assert(b.hp === 0, `the lethal hit must take hp from 1 to exactly 0, got ${b.hp}`);
  const points = g.q("BRICK_TIERS[1].points");
  assert(g.score() === points,
    `the score must rise by exactly the tier's points (${points}) once, got ${g.score()}`);
  assert(g.bricksLeft() === grid - 1,
    `bricksLeft must be decremented exactly once, got ${g.bricksLeft()} want ${grid - 1}`);
  assert(g.activeCount() === grid - 1,
    `exactly one brick may be destroyed, active=${g.activeCount()} want ${grid - 1}`);
  assert(g.els["hud-score"].textContent === String(points),
    `#hud-score must read ${points}, got ${JSON.stringify(g.els["hud-score"].textContent)}`);
  const n = g.ball();
  assert(n.vy > 0, `the lethal hit must reflect the ball, vy=${n.vy}`);
  assert(g.brickAt(4, 4).active && g.brickAt(4, 6).active,
    "neighbour bricks must survive");
});

// ================================================================
// Tier-A brick: exactly HP_BRICK_A side strikes, each reflecting
// normally; the score is credited once, on the final strike
// ================================================================
check("a three-hit tier-A brick takes exactly three side strikes, one score credit only on the final one", () => {
  const g = boot(960, 600);
  start(g);
  const grid = g.grid();
  const b0 = g.brickAt(3, 0); // level-1 row 3 is tier A (three hits), leftmost column
  assert(b0.tier === 0, `setup: row 3 must be the three-hit tier, got tier ${b0.tier}`);
  const r = g.q("BALL_RADIUS");
  for (let hit = 1; hit <= 3; hit += 1) {
    sidePark(g, 3, 0);
    const h = g.q("collideBricks(balls[0])");
    assert(h === true, `strike ${hit}: the overlapping side contact must register`);
    const b = g.brickAt(3, 0);
    const n = g.ball();
    assert(n.vx === -250, `strike ${hit}: the side hit must reflect horizontally, vx=${n.vx}`);
    assert(n.vy === 0, `strike ${hit}: vy must stay untouched, got ${n.vy}`);
    assert(Math.abs(n.x - (b0.x - r)) < 1e-5,
      `strike ${hit}: the ball must be pinned to the brick's left face, x=${n.x} want ${b0.x - r}`);
    if (hit < 3) {
      assert(b.active === true, `strike ${hit}: a non-lethal strike must leave the brick active`);
      assert(b.hp === 3 - hit, `strike ${hit}: hp must be ${3 - hit}, got ${b.hp}`);
      assert(g.score() === 0, `strike ${hit}: a non-lethal strike must credit nothing`);
    } else {
      assert(b.active === false, "strike 3: the brick must be destroyed");
      assert(b.hp === 0, `strike 3: hp must reach exactly 0, got ${b.hp}`);
      assert(g.score() === g.q("BRICK_TIERS[0].points"),
        `strike 3: exactly the tier's points may be credited, got ${g.score()}`);
      assert(g.bricksLeft() === grid - 1,
        `strike 3: bricksLeft must fall by exactly 1, got ${g.bricksLeft()}`);
    }
    // Frame boundary: the per-brick, per-frame damage cap charges
    // at most one hp per brick per frame, so distinct strikes must
    // land in distinct frames.
    g.tick(1);
  }
  assert(g.activeCount() === grid - 1,
    `exactly one brick may be gone, active=${g.activeCount()} want ${grid - 1}`);
  assert(g.brickAt(2, 0).active && g.brickAt(4, 0).active && g.brickAt(3, 1).active,
    "neighbours (rows above/below and the seam) must survive");
});

// ================================================================
// AC3: damage renders distinctly. (a) drawBricks carries a branch
// keyed on `b.hp < BRICK_TIERS[b.tier].hp` (grep-able in the real
// source); (b) behaviourally, a damaged brick paints its tier's
// darkened fill while full-hp bricks — including every one-hit
// brick — paint the tier colour exactly as before
// ================================================================
check("drawBricks contains the grep-able damage branch keyed on b.hp < BRICK_TIERS[b.tier].hp", () => {
  const g = boot(960, 600);
  start(g);
  const src = g.q("drawBricks.toString()");
  assert(src.includes("b.hp < BRICK_TIERS[b.tier].hp"),
    "drawBricks must branch on `b.hp < BRICK_TIERS[b.tier].hp`");
  const darks = g.q("BRICK_TIERS.map((t) => t.dark)");
  darks.forEach((d, i) => {
    const c = g.q(`BRICK_TIERS[${i}].color`);
    assert(typeof d === "string" && d !== c,
      `tier ${"ABC"[i]} needs a distinct damaged fill, got ${JSON.stringify(d)} vs ${c}`);
    assert(rgbSum(d) < rgbSum(c),
      `tier ${"ABC"[i]}'s damaged fill must be darker, ${d} vs ${c}`);
  });
});

check("damaged bricks render darkened; full-hp and one-hit bricks render the tier colour unchanged", () => {
  const g = boot(960, 600);
  start(g);

  // Baseline pass: everything full.
  renderPass(g);
  const c = g.brickAt(2, 5); // tier C: one-hit, always at full hp
  const bFull = g.brickAt(4, 1); // tier B, undamaged
  const fillC0 = rectFill(g, c);
  const fillB0 = rectFill(g, bFull);
  assert(fillC0 && fillB0, "the draw pass must paint the sampled bricks");
  assert(fillC0.fillStyle === g.q("BRICK_TIERS[2].color"),
    `a one-hit brick must render its tier colour, got ${fillC0.fillStyle}`);
  assert(fillB0.fillStyle === g.q("BRICK_TIERS[1].color"),
    `a full-hp two-hit brick must render its tier colour, got ${fillB0.fillStyle}`);

  // Damage (4,2) non-lethally, then repaint.
  strike(g, 4, 2);
  assert(g.brickAt(4, 2).active === true && g.brickAt(4, 2).hp === 1,
    "setup: (4,2) must be damaged and standing");
  renderPass(g);
  const dmg = g.brickAt(4, 2);
  const fillD = rectFill(g, dmg);
  assert(fillD, "the damaged brick must still be painted");
  assert(fillD.fillStyle === g.q("BRICK_TIERS[1].dark"),
    `the damaged brick must paint its tier's darkened fill, got ${fillD.fillStyle} want ${g.q("BRICK_TIERS[1].dark")}`);
  const nb = g.brickAt(4, 1);
  assert(rectFill(g, nb).fillStyle === g.q("BRICK_TIERS[1].color"),
    "an undamaged neighbour must keep the tier colour");
  const cAfter = g.brickAt(2, 5);
  assert(rectFill(g, cAfter).fillStyle === g.q("BRICK_TIERS[2].color"),
    "one-hit bricks must render exactly as before");
});

// ================================================================
// AC4: spawnLevel()/beginRun() reset every pool entry's hp from
// the tier table — a mid-run A brick is destroyed, the board
// cleared, and the new board's A bricks come up at full hp
// ================================================================
function clearAllButLast(g) {
  return g.q(`(function () {
    var i;
    for (i = 0; i < bricks.length && bricksLeft > 1; i += 1) {
      if (bricks[i].active) destroyBrick(i);
    }
    for (i = 0; i < bricks.length; i += 1) if (bricks[i].active) return i;
    return -1;
  })()`);
}

check("mid-run A brick destroyed + board cleared: the new board's A bricks spawn at full hp", () => {
  const g = boot(960, 600);
  start(g);
  const grid = g.grid();
  g.q("destroyBrick(0)"); // a mid-run kill of the top-row A brick
  assert(g.brickAt(0, 0).active === false, "setup: the A brick must be gone");
  const last = clearAllButLast(g);
  assert(last >= 0, "setup: exactly one brick must survive");
  g.q(`destroyBrick(${last})`); // level cleared
  assert(g.activeCount() === grid, `the new board must refill the grid, active=${g.activeCount()}`);
  const bad = g.q("bricks.filter((b) => b.active && (typeof b.hp !== 'number' || b.hp !== BRICK_TIERS[b.tier].hp)).length");
  assert(bad === 0, `every brick on the new board must be at full hp, ${bad} are not`);
  const aBad = g.q(
    "bricks.filter((b) => b.active && b.tier === 0 && (typeof b.hp !== 'number' || b.hp !== BRICK_TIERS[0].hp)).length"
  );
  assert(aBad === 0, "the new board's A bricks in particular must be at full hp");
  assert(g.q("BRICK_TIERS[0].hp") > 1, "sanity: the A tier is multi-hit");
});

check("spawnLevel() and beginRun() reset every pool entry's hp from the tier table", () => {
  const g = boot(960, 600);
  start(g);
  g.q("destroyBrick(0)");
  sidePark(g, 3, 0); // damage a second A brick without killing it
  g.q("collideBricks(balls[0])");
  assert(g.brickAt(3, 0).hp === g.q("BRICK_TIERS[0].hp") - 1,
    "setup: a damaged-but-standing A brick must exist");

  g.q("spawnLevel()");
  let bad = g.q("bricks.filter((b) => (typeof b.hp !== 'number' || b.hp !== BRICK_TIERS[b.tier].hp)).length");
  assert(bad === 0, `spawnLevel must restore full hp on every entry, ${bad} are not`);
  assert(g.bricksLeft() === g.grid(), "spawnLevel must recount bricksLeft");

  g.q("destroyBrick(3)");
  g.q("beginRun()");
  bad = g.q("bricks.filter((b) => (typeof b.hp !== 'number' || b.hp !== BRICK_TIERS[b.tier].hp)).length");
  assert(bad === 0, `beginRun must restore full hp on every entry, ${bad} are not`);
  assert(g.score() === 0, "beginRun must reset the score");
});

// ================================================================
// AC5 support: no allocation churn — the pool keeps its length and
// its entries keep their exact field set across repeated hits, and
// the hit/render paths allocate no per-hit objects (no object or
// array literals, no constructors in the bodies)
// ================================================================
check("repeated hits allocate nothing: pool length and entry field set are invariant", () => {
  const g = boot(960, 600);
  start(g);
  const shape = () => g.q("bricks.map((b) => Object.keys(b).sort().join('|')).join(';')");
  const len0 = g.poolLen();
  const keys0 = shape();
  let hits = 0;
  while (g.brickAt(3, 0).active) {
    sidePark(g, 3, 0);
    assert(g.q("collideBricks(balls[0])") === true, "setup: the side contact must register");
    hits += 1;
    // Frame boundary: same-frame re-contacts charge no further hp
    // (per-brick, per-frame damage cap).
    g.tick(1);
    if (hits > 10) throw new Error("fixture: the brick refused to die");
  }
  assert(hits === g.q("HP_BRICK_A"),
    `exactly the tier's hp strikes may have landed, got ${hits}`);
  assert(g.poolLen() === len0, `the pool must keep its length, ${len0} -> ${g.poolLen()}`);
  assert(shape() === keys0, "pool entries must keep their exact field set");
  const noLit = (fn) => !/=\s*[{\[]/.test(fn) && !/\bnew\b/.test(fn);
  assert(noLit(g.q("collideBricks.toString()")),
    "collideBricks must allocate no per-hit objects");
  assert(noLit(g.q("drawBricks.toString()")),
    "drawBricks must allocate no per-hit objects");
});

// ================================================================
// REGRESSION (review round 1): a brick must pay at most ONE hp per
// frame. The seam-scrape fixture parks the ball overlapping the
// left face of a brick and resolves the overlap, TWICE in a row
// with no frame boundary between the resolutions — the exact shape
// of the sub-step drain loop re-contacting the brick it just
// resolved. Against hp-2 (tier B) bricks both scrape pairs must end
// the frame with the brick standing at hp 1; only a subsequent
// contact, in a later frame, may finish it.
// ================================================================
function scrape(g, row, col) {
  sidePark(g, row, col);
  const h = g.q("collideBricks(balls[0])");
  return h;
}

check("seam scrape: two same-frame contacts on hp-2 bricks charge exactly once — both end the frame at hp 1, dying on a subsequent contact", () => {
  const g = boot(960, 600);
  start(g);
  const grid = g.grid();
  const r = g.q("BALL_RADIUS");
  // Isolate two bottom-row tier-B (hp 2) bricks: a left-face park
  // would co-overlap the left seam neighbour (ball wider than the
  // gap), and pool order would charge THAT brick instead.
  const mid = 4 * g.q("BRICK_COLS") + 1;
  g.q(`destroyBrick(${mid})`);
  const setupPoints = g.q("BRICK_TIERS[1].points");
  assert(g.score() === setupPoints, "setup: the isolating kill credits once");
  for (const col of [0, 2]) {
    const b0 = g.brickAt(4, col);
    assert(b0.tier === 1 && b0.hp === 2,
      `setup: (4,${col}) must be the two-hit tier at hp 2`);
    assert(scrape(g, 4, col) === true, `contact 1 on (4,${col}): must register`);
    // The drain loop resolved the residual overlap of the SAME brick
    // again before the frame ended:
    assert(scrape(g, 4, col) === true, `contact 2 (same frame) on (4,${col}): must still resolve`);
    const b = g.brickAt(4, col);
    const n = g.ball();
    assert(n.vx === -250, `the re-contact must reflect the ball left, vx=${n.vx}`);
    assert(Math.abs(n.x - (b0.x - r)) < 1e-5,
      `the re-contact must pin the ball clear of the left face, x=${n.x} want ~${b0.x - r}`);
  }
  // Frame end: the charge flags clear.
  g.q("balls[0].attached = true"); // ride the paddle: inert during the frame
  g.tick(1);
  for (const col of [0, 2]) {
    const b = g.brickAt(4, col);
    assert(b.active === true,
      `(4,${col}) must survive the double charge and END THE FRAME alive`);
    assert(b.hp === 1,
      `(4,${col}) must end the frame at exactly hp 1 (one charge), got ${b.hp}`);
  }
  assert(g.score() === setupPoints, "no same-frame pair may credit any further points");
  assert(g.bricksLeft() === grid - 1, "bricksLeft must be untouched by the scrape");
  // Subsequent (next-frame) contacts are the lethal ones.
  for (const col of [0, 2]) {
    assert(scrape(g, 4, col) === true, `follow-up contact on (4,${col}): must register`);
    const b = g.brickAt(4, col);
    assert(b.active === false,
      `(4,${col}): a subsequent-frame contact must finish the hp-2 brick`);
    assert(b.hp === 0, `(4,${col}): hp must reach exactly 0, got ${b.hp}`);
  }
  assert(g.score() === 3 * setupPoints,
    `each scraped brick may credit its tier's points exactly once, got ${g.score()}`);
  assert(g.bricksLeft() === grid - 3, `bricksLeft must fall to ${grid - 3}, got ${g.bricksLeft()}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
