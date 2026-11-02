#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html multi-hit brick durability (ticket #42)
// and per-hit visual wear: shade ramp + crack (ticket #71)
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
//   AC3 — (superseded by #71: the old dim branch is gone; damage now
//         renders via the precomputed per-hit shade ramp + crack
//         overlay — see the CRITERION 3 block below)
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
// Ticket #71 — per-hit visual wear (replaces the single two-state
// "dimmed" fill with a per-damage-stage ramp + crack overlay):
//   W1  — per-tier wear ramp: a precomputed table of one fill per
//         remaining hp (ramp[0] = base colour, each later stage a
//         distinct darker shade, adjacent stages >= ~15% relative
//         lightness step); the fixed tier's ramp is its base colour.
//   W2  — driven 3-hp brick: full -> 2hp -> 1hp paints three
//         distinct fills, each exactly its tier ramp stage,
//         monotonically darkening.
//   W3  — crack overlay: absent at full hp, one polyline at 2hp,
//         two at 1hp on a 3-hp brick.
//   W4  — crack determinism: same brick index -> same crack across
//         frames and across respawned boards; deepening keeps the
//         stage-1 polyline untouched; other indices draw others.
//   W5  — 1-hp bricks' fill never changes before destruction; the
//         fixed brick renders the bare undamaged path (base colour
//         fill, no crack strokes).
//   W6  — pool identity invariant over repeated damage/respawn
//         cycles; the wear draw paths allocate nothing per frame.
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
  // Pin the game's mutable `random` hook ABOVE POWERUP_DROP_RATE so
  // lethal hits never roll a capsule: the suite isolates durability
  // and the capsule path is provably inert (strict determinism).
  vm.runInContext("random = () => 1 - 1e-9", context);

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
    patterns: () => q("LEVEL_PATTERNS.map((p) => p.slice())"),
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

// The crack strokes recorded inside a brick's rect: the ordered
// "op:x,y" sequence of its moveTo/lineTo points plus the polyline
// count (each polyline opens with one moveTo). Cracks are drawn
// wholly inside the brick rect, and the grid gaps keep neighbouring
// rects disjoint, so rect containment isolates a brick's strokes.
function crackSeq(g, b) {
  const ops = g.draw.filter(
    (d) =>
      (d.op === "moveTo" || d.op === "lineTo") &&
      d.args[0] >= b.x - 1e-6 && d.args[0] <= b.x + b.w + 1e-6 &&
      d.args[1] >= b.y - 1e-6 && d.args[1] <= b.y + b.h + 1e-6
  );
  return {
    seq: ops.map((d) => `${d.op}:${d.args[0]},${d.args[1]}`).join("|"),
    lines: ops.filter((d) => d.op === "moveTo").length,
  };
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
  assert(g.q("HP_BRICK_A") === 3 && g.q("HP_BRICK_B") === 2 && g.q("HP_BRICK_C") === 1,
    `the chosen durability curve is A=3, B=2, C=1, got ${JSON.stringify(want)}`);
  assert(hps.length >= 3, `the three breakable tiers must each carry an hp, got ${JSON.stringify(hps)}`);
  for (let t = 0; t < 3; t += 1) {
    assert(hps[t] === want[t] && want[t] >= 1,
      `tier ${"ABC"[t]} must carry hp = HP_BRICK_${"ABC"[t]} (${want[t]}), got ${hps[t]}`);
  }
  assert(hps[0] > 1, "the top tier must be multi-hit");
  assert(hps[2] === 1, "the base tier must stay one-hit");
  // The optional fourth row is the unbreakable fixed tier (ticket #43):
  // hp 0, no points, flagged — it can never be charged.
  if (hps.length > 3) {
    assert(hps[3] === 0 && g.q("BRICK_TIERS[3].unbreakable") === true,
      `a fourth tier row must be the zero-hp unbreakable fixed tier, got ${JSON.stringify(hps[3])}`);
    assert(g.q("BRICK_TIERS[3].points") === 0, "the fixed tier must credit no points");
  }
  const colors = g.q("BRICK_TIERS.map((t) => t.color)");
  const points = g.q("BRICK_TIERS.map((t) => t.points)");
  assert(
    colors.slice(0, 3).join() === [g.q("COLOR_BRICK_A"), g.q("COLOR_BRICK_B"), g.q("COLOR_BRICK_C")].join(),
    "the tier colours must be unchanged"
  );
  assert(
    points.slice(0, 3).join() === "30,20,10",
    `the tier points must be unchanged (30,20,10), got ${JSON.stringify(points)}`
  );
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
// Ticket #71 — per-hit visual wear: the single two-state "dimmed"
// fill becomes a per-damage-stage shade ramp plus a deterministic
// crack overlay. Replaces the former AC3 checks, which pinned the
// old single-dark-variant mechanism.
// ================================================================
check("wear ramp: each breakable tier carries a precomputed ramp of hp fills — base colour first, every later stage a distinct darker shade with a >=15% relative step; the fixed tier's ramp is its single base colour", () => {
  const g = boot(960, 600); // no frame driven: the table must exist at module load
  for (let t = 0; t < 3; t += 1) {
    const tier = g.q(`BRICK_TIERS[${t}]`);
    const ramp = g.q(`BRICK_TIERS[${t}].ramp`);
    assert(Array.isArray(ramp), `tier ${"ABC"[t]} must carry a precomputed ramp table`);
    assert(ramp.length === tier.hp,
      `tier ${"ABC"[t]}'s ramp must hold one fill per remaining hp, got ${ramp.length} want ${tier.hp}`);
    assert(ramp[0] === tier.color, `the ramp's first stage must be the tier's base colour`);
    const sums = ramp.map(rgbSum);
    for (let d = 0; d < ramp.length; d += 1) {
      for (let e = 0; e < ramp.length; e += 1) {
        if (d !== e) assert(ramp[d] !== ramp[e],
          `stages ${d} and ${e} of tier ${"ABC"[t]} must be distinct fills, got ${ramp[d]}/${ramp[e]}`);
      }
      if (d > 0) {
        assert(sums[d] < sums[d - 1],
          `stage ${d} of tier ${"ABC"[t]} must be darker than stage ${d - 1}`);
        const step = (sums[d - 1] - sums[d]) / sums[d - 1];
        assert(step >= 0.15,
          `stages ${d - 1} -> ${d} of tier ${"ABC"[t]} must differ by >=~15% relative lightness, got ${step.toFixed(3)}`);
      }
    }
  }
  const fixed = g.q("BRICK_TIERS[3]");
  assert(Array.isArray(fixed.ramp) && fixed.ramp.length === 1 && fixed.ramp[0] === fixed.color,
    "the unbreakable tier's ramp must be its single base colour (it cannot be damaged)");
});

check("wear floor holds under EVERY theme: each theme's rebuilt ramp keeps distinct, >=15%-stepped stages for all breakable tiers", () => {
  const g = boot(960, 600);
  for (const name of g.q("Object.keys(THEMES)")) {
    g.q(`applyTheme(${JSON.stringify(name)})`); // rebuilds the ramps from the row's tier colours
    for (let t = 0; t < 3; t += 1) {
      const ramp = g.q(`BRICK_TIERS[${t}].ramp`);
      const sums = ramp.map(rgbSum);
      for (let d = 1; d < ramp.length; d += 1) {
        for (let e = 0; e < ramp.length; e += 1) {
          if (d !== e) assert(ramp[d] !== ramp[e],
            `${name}: stages ${d} and ${e} of tier ${"ABC"[t]} must be distinct`);
        }
        const step = (sums[d - 1] - sums[d]) / sums[d - 1];
        assert(step >= 0.15,
          `${name}: stages ${d - 1} -> ${d} of tier ${"ABC"[t]} must differ by >=~15% relative lightness, got ${step.toFixed(3)}`);
      }
    }
  }
});

check("crack table: CRACK_POINTS holds one fixed path per pool index — CRACK_LINES_MAX polylines of three normalised points each, reproducible from the brick index alone", () => {
  const g = boot(960, 600);
  const grid = g.grid();
  const rows = g.q("CRACK_POINTS");
  assert(rows.length === grid, `the crack table must cover the whole pool, got ${rows.length} want ${grid}`);
  const per = g.q("CRACK_LINES_MAX * CRACK_POINTS_PER");
  for (let i = 0; i < grid; i += 1) {
    const r = rows[i];
    assert(r.length === per, `index ${i} must carry ${per} numbers, got ${r.length}`);
    for (const v of r) {
      assert(Number.isFinite(v) && v >= 0 && v <= 1, `index ${i} carries an out-of-range normalised point ${v}`);
    }
  }
  const before = JSON.stringify(rows);
  g.q("buildCrackPoints()"); // rebuild from scratch
  assert(JSON.stringify(g.q("CRACK_POINTS")) === before,
    "rebuilding the crack table must reproduce it exactly from the brick indices");
});

check("driven 3-hp brick: full -> 2hp -> 1hp paints three distinct fills, each exactly its documented tier ramp stage, monotonically darkening", () => {
  const g = boot(960, 600);
  start(g);
  const b0 = g.brickAt(3, 0);
  assert(b0.tier === 0 && b0.hp === 3, "setup: a three-hit brick at full hp");
  const fills = [];
  for (let hp = 3; hp >= 1; hp -= 1) {
    renderPass(g);
    const b = g.brickAt(3, 0);
    assert(b.active === true && b.hp === hp, `stage setup: the brick must be standing at hp ${hp}`);
    const f = rectFill(g, b);
    assert(f, `the hp-${hp} brick must be painted`);
    fills.push(f.fillStyle);
    if (hp > 1) {
      sidePark(g, 3, 0);
      assert(g.q("collideBricks(balls[0])") === true, "the side contact must register");
      g.tick(1); // frame boundary releases the per-frame damage charge
    }
  }
  const ramp = g.q("BRICK_TIERS[0].ramp");
  fills.forEach((s, d) => assert(s === ramp[d],
    `damage stage ${d} must paint ramp[${d}] = ${ramp[d]}, got ${s}`));
  assert(new Set(fills).size === 3, `the three stages must be three distinct fills, got ${JSON.stringify(fills)}`);
  const sums = fills.map(rgbSum);
  assert(sums[0] > sums[1] && sums[1] > sums[2],
    `the fills must monotonically darken with damage, got sums ${JSON.stringify(sums)}`);
});

check("crack overlay: absent at full hp, one polyline at 2hp, two at 1hp on a 3-hp brick", () => {
  const g = boot(960, 600);
  start(g);
  renderPass(g);
  assert(crackSeq(g, g.brickAt(3, 0)).lines === 0, "a full-hp brick must show no crack");
  sidePark(g, 3, 0);
  g.q("collideBricks(balls[0])");
  g.tick(1);
  assert(g.brickAt(3, 0).hp === 2, "setup: the brick is at hp 2");
  renderPass(g);
  const at2 = crackSeq(g, g.brickAt(3, 0));
  assert(at2.lines === 1, `at hp 2 exactly one crack polyline must be stroked, got ${at2.lines}`);
  assert(at2.seq.startsWith("moveTo:"), "each crack polyline must open with a moveTo");
  sidePark(g, 3, 0);
  g.q("collideBricks(balls[0])");
  g.tick(1);
  assert(g.brickAt(3, 0).hp === 1, "setup: the brick is at hp 1");
  renderPass(g);
  assert(crackSeq(g, g.brickAt(3, 0)).lines === 2,
    `at hp 1 two crack polylines must be stroked, got ${crackSeq(g, g.brickAt(3, 0)).lines}`);
});

check("crack is deterministic per brick index: identical across frames, a respawned board replays the same crack, and deepening keeps the stage-1 polyline untouched", () => {
  const g = boot(960, 600);
  start(g);
  const hit = () => {
    sidePark(g, 3, 0);
    g.q("collideBricks(balls[0])");
    g.tick(1);
  };
  hit(); // -> hp 2 (dmg 1)
  renderPass(g);
  const s1 = crackSeq(g, g.brickAt(3, 0));
  renderPass(g);
  const s2 = crackSeq(g, g.brickAt(3, 0));
  assert(s1.seq !== "" && s1.seq === s2.seq,
    "the same damaged brick must stroke the same crack on every frame");
  hit(); // -> hp 1 (dmg 2)
  renderPass(g);
  const s3 = crackSeq(g, g.brickAt(3, 0));
  assert(s3.seq.indexOf(s1.seq) === 0,
    "the deepened crack must keep the stage-1 polyline untouched (prefix stability)");
  g.q("spawnLevel()"); // respawn the board into the same pool
  assert(g.brickAt(3, 0).hp === 3, "setup: the respawned brick is full again");
  hit(); // same index back to dmg 1
  renderPass(g);
  assert(crackSeq(g, g.brickAt(3, 0)).seq === s1.seq,
    "a respawned brick must inherit the identical crack for its index");
  g.q("bricks[1].hp = BRICK_TIERS[0].hp - 1"); // (0,1): another tier-A brick at the same stage
  renderPass(g);
  const s5 = crackSeq(g, g.brickAt(0, 1));
  assert(s5.lines === 1 && s5.seq !== "",
    "the second brick must carry one crack polyline at the same stage");
  assert(s5.seq !== s1.seq, "different brick indices must not share the same crack path");
});

check("single-hit brick: its fill never changes before destruction (always the base tier colour, no crack ops)", () => {
  const g = boot(960, 600);
  start(g);
  const c = g.brickAt(2, 5); // tier C: one-hit
  assert(c.tier === 2 && c.hp === 1, "setup: a one-hit brick at full hp");
  for (let i = 0; i < 3; i += 1) {
    renderPass(g);
    assert(rectFill(g, g.brickAt(2, 5)).fillStyle === g.q("BRICK_TIERS[2].color"),
      `pass ${i}: a live one-hit brick must paint exactly the base tier colour`);
    assert(crackSeq(g, g.brickAt(2, 5)).lines === 0,
      `pass ${i}: a one-hit brick must show no crack while it stands`);
    g.tick(1); // ordinary frames must not alter the fill either
  }
  parkUnder(g, 2, 5);
  g.tick(1);
  assert(g.brickAt(2, 5).active === false, "the one-hit brick dies on its first hit");
});

check("fixed brick: renders the bare undamaged path — exactly one base-colour fillRect, no crack strokes", () => {
  const g = boot(960, 600);
  start(g);
  const idx = 4 * g.q("BRICK_COLS") + 9; // (4,9)
  g.q(`destroyBrick(${idx})`);
  const basePts = g.q("BRICK_TIERS[1].points");
  assert(g.score() === basePts, "setup: the isolating kill credits its tier once");
  g.q(`(function () {
    var f = bricks[${idx}];
    f.active = true; f.tier = 3; f.hp = 0; f.unbreakable = true;
  })()`);
  renderPass(g);
  const f = g.brickAt(4, 9);
  const fill = rectFill(g, f);
  assert(fill, "the fixed brick must be painted");
  assert(fill.fillStyle === g.q("BRICK_TIERS[3].color"),
    `the fixed brick must paint its base tier colour, got ${fill.fillStyle}`);
  const rects = g.draw.filter((d) => d.op === "fillRect" &&
    Math.abs(d.args[0] - f.x) < 1e-6 && Math.abs(d.args[1] - f.y) < 1e-6 &&
    Math.abs(d.args[2] - f.w) < 1e-6);
  assert(rects.length === 1, `exactly one fillRect may cover the fixed brick, got ${rects.length}`);
  const lineOps = g.draw.filter((d) => d.op === "moveTo" || d.op === "lineTo");
  assert(lineOps.every((d) =>
      d.args[0] < f.x - 1e-6 || d.args[0] > f.x + f.w + 1e-6 ||
      d.args[1] < f.y - 1e-6 || d.args[1] > f.y + f.h + 1e-6),
    "no crack polyline point may land inside the fixed brick's rect");
});

check("pool identity over repeated damage/respawn cycles: the bricks array and every entry keep their identity; the wear draw paths allocate nothing per frame", () => {
  const g = boot(960, 600);
  start(g);
  const shape = () => g.q("bricks.map((b) => Object.keys(b).sort().join('|')).join(';')");
  const keys0 = shape();
  g.q("__pool = bricks; __entries = bricks.slice(0)");
  for (let cycle = 0; cycle < 4; cycle += 1) {
    sidePark(g, 3, 0); // tier A (survives dmg 1)
    assert(g.q("collideBricks(balls[0])") === true, `cycle ${cycle}: the A contact must register`);
    g.tick(1);
    sidePark(g, 4, 2); // tier B (survives dmg 1)
    assert(g.q("collideBricks(balls[0])") === true, `cycle ${cycle}: the B contact must register`);
    g.tick(1);
    renderPass(g); // exercise the ramp indexing and the crack strokes
    g.q("spawnLevel()"); // respawn the board into the same pool
    assert(g.q("__pool === bricks"), `cycle ${cycle}: the bricks array itself must not be reallocated`);
    assert(g.q("bricks.every((b, i) => b === __entries[i])"),
      `cycle ${cycle}: every pool entry must keep its identity`);
  }
  assert(shape() === keys0, "pool entries must keep their exact field set across cycles");
  const noLit = (fn) => !/=\s*[{[]/.test(fn) && !/\bnew\b/.test(fn);
  assert(noLit(g.q("drawBricks.toString()")), "drawBricks must allocate no per-frame objects");
  assert(noLit(g.q("drawBrickCracks.toString()")), "drawBrickCracks must allocate no per-frame objects");
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
    // The survivor must be BREAKABLE: a fixed brick would make the
    // caller's final kill a no-op and stall the level (ticket #43).
    for (i = 0; i < bricks.length; i += 1) if (bricks[i].active && !bricks[i].unbreakable) return i;
    return -1;
  })()`);
}

check("mid-run A brick destroyed + board cleared: the new board's A bricks spawn at full hp", () => {
  const g = boot(960, 600);
  start(g);
  g.q("destroyBrick(0)"); // a mid-run kill of the top-row A brick
  assert(g.brickAt(0, 0).active === false, "setup: the A brick must be gone");
  const last = clearAllButLast(g);
  assert(last >= 0, "setup: exactly one brick must survive");
  g.q(`destroyBrick(${last})`); // level cleared
  // Pattern-aware (ticket #43): the cleared level-1 board advances to
  // level 2 = LEVEL_PATTERNS[1] (gated fort), whose occupancy — not
  // the full grid — is the refill invariant.
  const occ2 = g.patterns()[1].join("").replace(/\./g, "").length;
  assert(g.activeCount() === occ2,
    `the new board must match level 2's pattern, active=${g.activeCount()} want ${occ2}`);
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
