#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html level layouts: LEVEL_PATTERNS table,
// fixed (unbreakable) bricks, tunnel guarantee and level cycling
// (ticket #43)
//
// Same harness style as tests/bricks-grid.test.mjs: runs the REAL
// <script> from bricks.html in a sandboxed vm context with stubbed
// window/document/canvas/DOM elements. Levels are forced
// console-style (`level = k + 1; spawnLevel()`) exactly as the
// ticket's acceptance criteria prescribe; clears go through the
// game's own destroyBrick() (the console path). No network, no
// external services.
//
// Run: node tests/bricks-level-layouts.test.mjs
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
  // Pin the game's mutable `random` hook above every drop rate so
  // the destroyBrick kill paths never roll a capsule: the suite is
  // byte-for-byte reproducible (review #43 round 1).
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
    win: sandbox.window,
    q,
    tick,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    level: () => q("typeof level === 'undefined' ? NaN : level"),
    score: () => q("typeof score === 'undefined' ? NaN : score"),
    paddleX: () => q("typeof paddle === 'undefined' ? NaN : paddle.x"),
    ball: () =>
      q("typeof balls === 'undefined' ? null : ({ x: balls[0].x, y: balls[0].y, vx: balls[0].vx, vy: balls[0].vy, attached: balls[0].attached })"),
    // Brick field accessors
    poolLen: () => q("typeof bricks === 'undefined' ? -1 : bricks.length"),
    poolIsSameArray: () => q("bricks === __poolRef"),
    bricksLeft: () => q("typeof bricksLeft === 'undefined' ? -1 : bricksLeft"),
    activeCount: () =>
      q("typeof bricks === 'undefined' ? -1 : bricks.reduce((n, b) => n + (b.active ? 1 : 0), 0)"),
    grid: () => q("typeof BRICK_ROWS === 'undefined' ? -1 : BRICK_ROWS * BRICK_COLS"),
    patterns: () => q("typeof LEVEL_PATTERNS === 'undefined' ? null : LEVEL_PATTERNS.map((rows) => rows.slice())"),
    tierFixed: () => q("typeof TIER_FIXED === 'undefined' ? NaN : TIER_FIXED"),
    // Per-cell [active, tier, unbreakable] in pool order (row-major).
    brickMap: () => q("bricks.map((b) => [b.active ? 1 : 0, b.tier, b.unbreakable ? 1 : 0])"),
    brickAt(row, col) {
      const cols = q("BRICK_COLS");
      return q(`(() => {
        const t = bricks[${row * cols + col}];
        return { active: t.active, tier: t.tier, unbreakable: t.unbreakable === true, x: t.x, y: t.y, w: t.w, h: t.h };
      })()`);
    },
    fixedActiveCount: () =>
      q("typeof bricks === 'undefined' ? -1 : bricks.reduce((n, b) => n + (b.active && b.unbreakable ? 1 : 0), 0)"),
    capsActive: () =>
      q("typeof capsules === 'undefined' ? -1 : capsules.reduce((n, c) => n + (c.active ? 1 : 0), 0)"),
  };
}

const start = (g) => {
  g.els["btn-start"].click();
  g.tick(1);
};

// Force `level = k` and re-spawn into the pool (the ticket's exact
// forcing mechanism; k is 1-based).
const forceLevel = (g, k) => g.q(`level = ${k}; spawnLevel(); 1`);

// Expected per-cell [active, tier, unbreakable] for a pattern table:
// '.' = dormant cell (tier ignored on comparison), 'A'/'B'/'C' = the
// matching BRICK_TIERS index, 'X' = the fixed (unbreakable) tier.
const LETTER_TIER = { A: 0, B: 1, C: 2 };
function expectedMap(pattern, tierFixed) {
  const m = [];
  for (let r = 0; r < pattern.length; r += 1) {
    for (let c = 0; c < pattern[r].length; c += 1) {
      const ch = pattern[r][c];
      if (ch === ".") m.push([0, "any", 0]);
      else if (ch === "X") m.push([1, tierFixed, 1]);
      else m.push([1, LETTER_TIER[ch], 0]);
    }
  }
  return m;
}
function assertMapMatches(g, pattern, label) {
  const got = g.brickMap();
  const want = expectedMap(pattern, g.tierFixed());
  assert(got.length === want.length,
    `${label}: the pool must hold one cell per pattern cell, ${got.length} vs ${want.length}`);
  for (let i = 0; i < want.length; i += 1) {
    const [wAct, wTier, wUnb] = want[i];
    const [aAct, aTier, aUnb] = got[i];
    if (aAct !== wAct || aUnb !== wUnb) {
      throw new Error(`${label}: cell ${i} is (active=${aAct}, unbreakable=${aUnb}), pattern wants (active=${wAct}, unbreakable=${wUnb})`);
    }
    if (wTier !== "any" && aTier !== wTier) {
      throw new Error(`${label}: cell ${i} has tier ${aTier}, pattern wants tier ${wTier}`);
    }
  }
}
// Count of pattern cells that occupy a brick (non '.').
const occupiedCount = (pattern) => pattern.join("").replace(/\./g, "").length;
// Count of pattern cells that are BREAKABLE bricks (non '.', non 'X').
const breakableCount = (pattern) => pattern.join("").replace(/[.\X]/g, "").length;

// Destroy every breakable brick through the game's own destroyBrick
// path until the board is won (fixed bricks survive by design).
function clearBoard(g) {
  const ok = g.q(`(function () {
    var startLevel = level;
    for (var guard = 0; guard < 400; guard += 1) {
      if (level !== startLevel) return true; // win fired: the board advanced
      var k = -1;
      for (var i = 0; i < bricks.length; i += 1) {
        if (bricks[i].active && !bricks[i].unbreakable) { k = i; break; }
      }
      if (k < 0) return false; // nothing breakable left but no win: inconsistent
      destroyBrick(k);
    }
    return false; // guard exhausted
  })()`);
  assert(ok === true, "the board must be clearable of every breakable brick");
}

// ================================================================
// Criterion 1 setup: LEVEL_PATTERNS is a table of at least four
// DISTINCT BRICK_ROWS × BRICK_COLS row-string grids over
// '.'/A/B/C/X, each playable (at least one breakable cell)
// ================================================================
check("LEVEL_PATTERNS is a table of at least four distinct BRICK_ROWS x BRICK_COLS grids over '.'/A/B/C/X", () => {
  const g = boot(960, 600);
  const patterns = g.patterns();
  assert(Array.isArray(patterns) && patterns.length >= 4,
    `LEVEL_PATTERNS must be an array of at least 4 grids, got ${JSON.stringify(patterns ? patterns.length : patterns)}`);
  const rows = g.q("BRICK_ROWS");
  const cols = g.q("BRICK_COLS");
  const seen = new Set();
  for (let k = 0; k < patterns.length; k += 1) {
    const p = patterns[k];
    assert(Array.isArray(p) && p.length === rows,
      `pattern ${k} must have exactly BRICK_ROWS (${rows}) rows, got ${p && p.length}`);
    for (let r = 0; r < p.length; r += 1) {
      assert(typeof p[r] === "string" && p[r].length === cols,
        `pattern ${k} row ${r} must be a string of BRICK_COLS (${cols}) chars, got ${JSON.stringify(p[r])}`);
      for (const ch of p[r]) {
        assert(".ABCX".includes(ch),
          `pattern ${k} row ${r} has an illegal cell ${JSON.stringify(ch)} (allowed: . A B C X)`);
      }
    }
    const key = p.join("|");
    assert(!seen.has(key), `pattern ${k} duplicates an earlier grid — the table needs distinct layouts`);
    seen.add(key);
    assert(breakableCount(p) > 0, `pattern ${k} must contain at least one breakable brick`);
  }
});

// ================================================================
// Criterion 1: for each index k in 0..len-1, force level = k+1 and
// spawnLevel(): the per-cell (active, tier, unbreakable) map matches
// LEVEL_PATTERNS[k] cell-for-cell, bricksLeft = count of non-X
// non-'.' cells, the pool stays fixed-size
// ================================================================
// Bind the cell-for-cell sweep to the table's ACTUAL length (a
// fifth pattern must not be silently skipped by the validation):
// fetch it once up front from a throwaway boot.
const patternCount = boot(960, 600).patterns().length;
for (let k = 0; k < patternCount; k += 1) {
  check(`level ${k + 1}: spawnLevel() reproduces LEVEL_PATTERNS[${k}] cell-for-cell (active, tier, unbreakable) with bricksLeft = breakable count`, () => {
    const g = boot(960, 600);
    start(g);
    const patterns = g.patterns();
    const want = patterns[k];
    forceLevel(g, k + 1);
    assertMapMatches(g, want, `pattern ${k} at level ${k + 1}`);
    const breakable = breakableCount(want);
    assert(g.bricksLeft() === breakable,
      `bricksLeft must count breakable bricks only (${breakable}), got ${g.bricksLeft()}`);
    assert(g.activeCount() === occupiedCount(want),
      `active cells must equal the pattern's occupied cells (${occupiedCount(want)}), got ${g.activeCount()}`);
    assert(g.poolLen() === g.grid(),
      `the pool must stay BRICK_ROWS*BRICK_COLS for pattern ${k}, got ${g.poolLen()}`);
  });
}

// ================================================================
// Fixed tier: a fourth BRICK_TIERS entry with COLOR_BRICK_FIXED,
// 0 points and unbreakable: true, distinguishable from the
// colour tiers
// ================================================================
check("the fixed tier is a named BRICK_TIERS entry: COLOR_BRICK_FIXED, 0 points, unbreakable, a distinct colour", () => {
  const g = boot(960, 600);
  const tiers = g.q("BRICK_TIERS.map((t) => ({ color: t.color, points: t.points, unbreakable: t.unbreakable === true }))");
  const tf = g.tierFixed();
  assert(Number.isInteger(tf) && tf >= 0 && tf < tiers.length,
    `TIER_FIXED must index BRICK_TIERS, got ${tf} of ${tiers.length}`);
  const fixed = tiers[tf];
  assert(fixed.unbreakable === true, `the TIER_FIXED entry must set unbreakable: true, got ${JSON.stringify(fixed)}`);
  assert(fixed.points === 0, `the fixed tier must be worth 0 points, got ${fixed.points}`);
  const colorFixed = g.q("typeof COLOR_BRICK_FIXED === 'undefined' ? null : COLOR_BRICK_FIXED");
  assert(typeof colorFixed === "string" && colorFixed.startsWith("#"),
    `COLOR_BRICK_FIXED must be a named hex colour, got ${JSON.stringify(colorFixed)}`);
  assert(fixed.color === colorFixed,
    `the fixed tier's colour must BE COLOR_BRICK_FIXED (${colorFixed}), got ${fixed.color}`);
  assert(new Set(tiers.map((t) => t.color)).size === tiers.length,
    "every tier colour (incl. the fixed one) must be distinct");
});

// Find a pattern + an X cell with a clear shaft straight below it
// (every cell underneath it in the column is '.'), so a ball can be
// driven at the fixed brick from below. Deterministic: first match
// in table order.
function findFixedStrikeTarget(patterns) {
  for (let k = 0; k < patterns.length; k += 1) {
    const p = patterns[k];
    for (let r = 0; r < p.length; r += 1) {
      for (let c = 0; c < p[r].length; c += 1) {
        if (p[r][c] !== "X") continue;
        let clear = true;
        for (let rr = r + 1; rr < p.length; rr += 1) {
          if (p[rr][c] !== ".") { clear = false; break; }
        }
        if (clear) return { k, row: r, col: c };
      }
    }
  }
  return null;
}

// ================================================================
// Criterion 2: fixed-brick physics — a ball driven at an X cell
// reflects; the brick stays active, score/bricksLeft are
// unchanged, and no capsule rolls
// ================================================================
check("a ball striking a fixed brick reflects: brick stays active, score and bricksLeft unchanged, no capsule drops", () => {
  const g = boot(960, 600);
  start(g);
  const patterns = g.patterns();
  const t = findFixedStrikeTarget(patterns);
  assert(t, "setup: at least one pattern must offer an X cell with a clear shaft below it");
  forceLevel(g, t.k + 1);
  const brick = g.brickAt(t.row, t.col);
  assert(brick.active && brick.unbreakable,
    `setup: the target (${t.row},${t.col}) must be an active fixed brick, got ${JSON.stringify(brick)}`);
  const leftBefore = g.bricksLeft();
  const activeBefore = g.activeCount();
  g.q(`balls[0].attached = false;
       balls[0].x = ${brick.x + brick.w / 2};
       balls[0].y = ${brick.y + brick.h} + BALL_RADIUS + 9;
       balls[0].vx = 0; balls[0].vy = -300;`);
  let struck = false;
  for (let f = 0; f < 12; f += 1) {
    g.tick(1);
    if (g.ball().vy > 0) { struck = true; break; }
  }
  assert(struck, "the ball must reflect off the fixed brick within 12 frames");
  const after = g.brickAt(t.row, t.col);
  assert(after.active === true, "the fixed brick must SURVIVE the strike");
  assert(after.unbreakable === true, "the fixed brick must keep its unbreakable flag");
  assert(after.tier === g.tierFixed(), "the fixed brick must keep the fixed tier");
  assert(g.score() === 0, `a fixed brick must credit no points, score=${g.score()}`);
  assert(g.bricksLeft() === leftBefore,
    `bricksLeft must not move on a fixed-brick hit, ${leftBefore} -> ${g.bricksLeft()}`);
  assert(g.activeCount() === activeBefore,
    `no brick may be destroyed, active=${activeBefore} -> ${g.activeCount()}`);
  assert(g.capsActive() === 0, `a fixed brick must release no capsule, active=${g.capsActive()}`);
  const n = g.ball();
  assert(n.attached === false, "the ball must still be in flight");
  assertClose(n.y, brick.y + brick.h + g.q("BALL_RADIUS") + g.q("BRICK_PIN_EPS"), 1e-9,
    "the ball must be pinned to the fixed brick's underside");
});

check("destroyBrick() is a no-op on a fixed brick: no deactivation, no score, no bricksLeft change", () => {
  const g = boot(960, 600);
  start(g);
  const t = findFixedStrikeTarget(g.patterns());
  assert(t, "setup: a fixed brick with a clear shaft must exist");
  forceLevel(g, t.k + 1);
  const idx = t.row * g.q("BRICK_COLS") + t.col;
  const leftBefore = g.bricksLeft();
  g.q(`destroyBrick(${idx})`);
  const after = g.brickAt(t.row, t.col);
  assert(after.active === true, "the console kill path must not deactivate a fixed brick");
  assert(g.score() === 0, `the console kill path must credit nothing, score=${g.score()}`);
  assert(g.bricksLeft() === leftBefore,
    `the console kill path must not touch bricksLeft, ${leftBefore} -> ${g.bricksLeft()}`);
});

// ================================================================
// Criterion 3: win-with-fixed-bricks — clearing only the breakable
// cells (console path) fires advanceLevel while fixed bricks
// remain active
// ================================================================
check("winning with fixed bricks present: the last breakable kill advances the level while fixed bricks stay active", () => {
  const g = boot(960, 600);
  start(g);
  const patterns = g.patterns();
  const t = findFixedStrikeTarget(g.patterns());
  assert(t, "setup: a pattern with fixed bricks must exist");
  const want = patterns[t.k];
  forceLevel(g, t.k + 1);
  const lvl = g.level();
  const fixed = g.fixedActiveCount();
  assert(fixed > 0, `setup: the level must carry ${fixed} fixed bricks, got ${fixed}`);
  // Drain everything but the final breakable brick, then deliver the
  // winning kill through the shared console path.
  const last = g.q(`(function () {
    for (var i = 0; i < bricks.length && bricksLeft > 1; i += 1) {
      if (bricks[i].active && !bricks[i].unbreakable) destroyBrick(i);
    }
    for (var j = 0; j < bricks.length; j += 1) {
      if (bricks[j].active && !bricks[j].unbreakable) return j;
    }
    return -1;
  })()`);
  assert(last >= 0, "setup: exactly one breakable brick must survive");
  assert(g.fixedActiveCount() === fixed,
    `fixed bricks must never be destroyed, ${fixed} -> ${g.fixedActiveCount()}`);
  g.q(`destroyBrick(${last})`);
  assert(g.level() === lvl + 1, `advanceLevel must fire on the last breakable kill, ${lvl} -> ${g.level()}`);
  assert(g.state() === "playing", `the run must continue after the win, state=${g.state()}`);
  assert(g.ball().attached === true, "the winning serve must be a fresh attached ball");
  assertMapMatches(g, patterns[(g.level() - 1) % patterns.length],
    `level ${g.level()}'s respawn`);
  assert(g.bricksLeft() === breakableCount(patterns[0]),
    `the respawn must count the new pattern's breakable bricks, got ${g.bricksLeft()}`);
});

// ================================================================
// Criterion 4: tunnel guarantee — at least one pattern contains two
// adjacent columns with zero breakable cells in every row below the
// topmost occupied row (the pattern's min occupied row), i.e. a
// vertical channel the ball is guided through to the pocket behind
// the top wall
// ================================================================
check("tunnel guarantee: at least one pattern offers two adjacent columns clear of breakable bricks below the topmost occupied row", () => {
  const g = boot(960, 600);
  const patterns = g.patterns();
  assert(Array.isArray(patterns) && patterns.length > 0, "LEVEL_PATTERNS must exist");
  const hits = [];
  for (let k = 0; k < patterns.length; k += 1) {
    const p = patterns[k];
    const cols = p[0].length;
    let topRow = -1;
    for (let r = 0; r < p.length; r += 1) {
      if (p[r].split("").some((ch) => ch !== ".")) { topRow = r; break; }
    }
    assert(topRow >= 0, `pattern ${k} must be non-empty`);
    for (let c = 0; c + 1 < cols; c += 1) {
      let clear = true;
      for (let r = topRow + 1; r < p.length; r += 1) {
        const a = p[r][c];
        const b = p[r][c + 1];
        if ((a === "A" || a === "B" || a === "C") || (b === "A" || b === "B" || b === "C")) { clear = false; break; }
      }
      if (clear) hits.push(`pattern ${k}, columns ${c}-${c + 1}`);
    }
  }
  assert(hits.length >= 1,
    `at least one pattern must guide the ball down a two-column tunnel, found none`);
  console.log(`       (tunnel found at: ${hits.join("; ")})`);
});

// ================================================================
// Criterion 5: level cycle — clearing the board twice from level 3
// walks the table and returns the level-1 pattern: level k uses
// LEVEL_PATTERNS[(k - 1) % LEVEL_PATTERNS.length]
// ================================================================
check("level cycle: clearing the board twice from level 3 returns the level-1 pattern ((level - 1) % len)", () => {
  const g = boot(960, 600);
  start(g);
  const patterns = g.patterns();
  forceLevel(g, 3);
  assert(g.level() === 3, "setup: level forced to 3");
  assertMapMatches(g, patterns[(3 - 1) % patterns.length], "level 3 spawn");
  clearBoard(g); // -> level 4
  assert(g.level() === 4, `the first clear must raise the level to 4, got ${g.level()}`);
  assertMapMatches(g, patterns[(4 - 1) % patterns.length], "level 4 spawn");
  clearBoard(g); // -> level 5
  assert(g.level() === 5, `the second clear must raise the level to 5, got ${g.level()}`);
  assertMapMatches(g, patterns[0], "level 5 spawn");
  assertMapMatches(g, patterns[(5 - 1) % patterns.length], "(level - 1) % len at level 5");
});

// ================================================================
// Criterion 6 support: the brick pool stays fixed-size — the SAME
// array object is re-used in place for every pattern spawn
// ================================================================
check("the brick pool is the same fixed-size array across every pattern spawn (no per-level allocation)", () => {
  const g = boot(960, 600);
  start(g);
  const patterns = g.patterns();
  const len0 = g.poolLen();
  assert(len0 === g.grid(), `setup: the pool must start at BRICK_ROWS*BRICK_COLS (${g.grid()}), got ${len0}`);
  g.q("__poolRef = bricks; 1");
  for (let k = 1; k <= patterns.length; k += 1) {
    forceLevel(g, k);
    assert(g.poolLen() === len0,
      `the pool length must stay ${len0} after pattern ${k - 1} spawn, got ${g.poolLen()}`);
    assert(g.poolIsSameArray() === true,
      `spawnLevel must mutate the original pool in place, not allocate a new array (level ${k})`);
  }
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
