#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html secret level-skip keys Shift+L /
// Shift+K (ticket #77)
//
// Same harness style as tests/bricks-level-layouts.test.mjs: runs
// the REAL <script> from bricks.html in a sandboxed vm context with
// stubbed window/document/canvas/ctx. Levels are advanced the
// ticket's prescribed way (real clears through destroyBrick, or
// console forcing where a specific level is required); the secret
// keys themselves are exercised ONLY through edge-dispatched window
// keydown events with the shiftKey flag, exactly as the game sees
// them. No network, no external services.
//
// The keys are deliberately absent from all UI copy; this suite is
// one of the two sanctioned records (docs/DECISIONS.md is the
// other).
//
// Run: node tests/bricks-secret-skip.test.mjs
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
    value: "100", // sliders (volume, ball-speed) boot-read .value
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
  // Pin the game's mutable `random` hook above every drop rate so
  // destroyBrick kill paths never roll a capsule: the suite is
  // byte-for-byte reproducible.
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
    q,
    tick,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    level: () => q("typeof level === 'undefined' ? NaN : level"),
    score: () => q("typeof score === 'undefined' ? NaN : score"),
    lives: () => q("typeof lives === 'undefined' ? NaN : lives"),
    serveSpeed: () => q("typeof serveSpeed === 'undefined' ? NaN : serveSpeed"),
    multUntil: () => q("typeof multUntil === 'undefined' ? NaN : multUntil"),
    paddleX: () => q("typeof paddle === 'undefined' ? NaN : paddle.x"),
    // Every ball as {active, attached, x, y, vx, vy} (slot order).
    ballList: () =>
      q("typeof balls === 'undefined' ? null : balls.map((b) => ({ active: b.active, attached: b.attached, x: b.x, y: b.y, vx: b.vx, vy: b.vy }))"),
    activeBallCount: () => q("typeof balls === 'undefined' ? -1 : balls.filter((b) => b.active).length"),
    // Brick field accessors
    poolLen: () => q("typeof bricks === 'undefined' ? -1 : bricks.length"),
    bricksLeft: () => q("typeof bricksLeft === 'undefined' ? -1 : bricksLeft"),
    activeCount: () =>
      q("typeof bricks === 'undefined' ? -1 : bricks.reduce((n, b) => n + (b.active ? 1 : 0), 0)"),
    grid: () => q("typeof BRICK_ROWS === 'undefined' ? -1 : BRICK_ROWS * BRICK_COLS"),
    patterns: () => q("typeof LEVEL_PATTERNS === 'undefined' ? null : LEVEL_PATTERNS.map((rows) => rows.slice())"),
    // Per-cell [active, tier, hp, unbreakable] in pool order (row-major).
    brickMap: () => q("bricks.map((b) => [b.active ? 1 : 0, b.tier, b.hp, b.unbreakable ? 1 : 0])"),
    // True iff every active breakable brick sits at full tier hp and
    // carries no stale per-frame damage charge (a "pristine" board).
    boardPristine: () =>
      q("bricks.every((b) => !b.active || b.charged === false || b.unbreakable || b.hp === BRICK_TIERS[b.tier].hp)"),
    // Edge-dispatch one key event into the window listeners with the
    // exact shape the game consumes (code + shiftKey; auto-repeat is
    // modelled by a second keydown with no keyup in between).
    key(type, code, opts = {}) {
      for (const cb of winListeners[type] ?? [])
        cb({ type, code, shiftKey: !!opts.shiftKey, preventDefault() {} });
    },
  };
}

const start = (g) => {
  g.els["btn-start"].click();
  g.tick(1);
};

// Force `level = k` (1-based) AND the serve speed the run would have
// reached clearing its way there: run base × growth^(k−1), capped —
// console-style forcing, as the sibling level suite prescribes.
const forceLevel = (g, k) =>
  g.q(`level = ${k};
       serveSpeed = Math.min(DIFFICULTY[selectedDifficulty].serveSpeed * Math.pow(LEVEL_SPEED_GROWTH, ${k} - 1), MAX_BALL_SPEED);
       spawnLevel(); serveBall(); syncHud(); 1`);

// The run's level-1 serve base for the active preset.
const runBase = (g) => g.q("DIFFICULTY[selectedDifficulty].serveSpeed");

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

// Expected per-cell [active, tier, hp, unbreakable] for a PRISTINE
// spawn of a pattern table: '.' = dormant, letters = full tier hp,
// 'X' = the fixed tier (hp 0 by table definition).
const LETTER_TIER = { A: 0, B: 1, C: 2 };
function expectedPristineMap(pattern, g) {
  const tiers = g.q("BRICK_TIERS.map((t) => t.hp)");
  const tf = g.q("TIER_FIXED");
  const m = [];
  for (const row of pattern) {
    for (const ch of row) {
      if (ch === ".") m.push([0, "any", "any", 0]);
      else if (ch === "X") m.push([1, tf, tiers[tf], 1]);
      else m.push([1, LETTER_TIER[ch], tiers[LETTER_TIER[ch]], 0]);
    }
  }
  return m;
}
function assertMapMatches(g, pattern, label) {
  const got = g.brickMap();
  const want = expectedPristineMap(pattern, g);
  assert(got.length === want.length,
    `${label}: the pool must hold one cell per pattern cell, ${got.length} vs ${want.length}`);
  for (let i = 0; i < want.length; i += 1) {
    const [wAct, wTier, wHp, wUnb] = want[i];
    const [aAct, aTier, aHp, aUnb] = got[i];
    if (aAct !== wAct || aUnb !== wUnb) {
      throw new Error(`${label}: cell ${i} is (active=${aAct}, unbreakable=${aUnb}), pattern wants (active=${wAct}, unbreakable=${wUnb})`);
    }
    if (wTier !== "any" && aTier !== wTier) {
      throw new Error(`${label}: cell ${i} has tier ${aTier}, pattern wants tier ${wTier}`);
    }
    if (wHp !== "any" && aHp !== wHp) {
      throw new Error(`${label}: cell ${i} has hp ${aHp}, pattern wants hp ${wHp}`);
    }
  }
}
const breakableCount = (pattern) => pattern.join("").replace(/[.\X]/g, "").length;
const occupiedCount = (pattern) => pattern.join("").replace(/\./g, "").length;
// The legitimate capped serve speed for a 1-based level under the
// ticket's recompute formula: base × growth^(level−1), capped.
const legitimateSpeed = (g, lvl) =>
  g.q(`Math.min(DIFFICULTY[selectedDifficulty].serveSpeed * Math.pow(LEVEL_SPEED_GROWTH, ${lvl} - 1), MAX_BALL_SPEED)`);

// ================================================================
// Criterion 1: driven to level 2 mid-run, Shift+L advances exactly
// as a clear would: level 3 pattern laid out, serve speed = base ×
// growth^2 formula-verified against a genuine two-clear run, one
// attached ball, score and lives unchanged
// ================================================================
check("mid-run at level 2, Shift+L lays out the level 3 pattern and grows the serve speed exactly as the clear progression does (base × growth², capped)", () => {
  const g = boot(960, 600);
  start(g);
  clearBoard(g); // genuine clear: level 1 -> 2
  assert(g.level() === 2, `setup: a genuine clear must put the run at level 2, got ${g.level()}`);
  const base = g.q("BALL_SERVE_SPEED");
  const growth = g.q("LEVEL_SPEED_GROWTH");
  const cap = g.q("MAX_BALL_SPEED");
  const patterns = g.patterns();
  const scoreBefore = g.score();
  const livesBefore = g.lives();
  assert(scoreBefore > 0, `setup: a mid-run run must carry real points, score=${scoreBefore}`);

  g.key("keydown", "KeyL", { shiftKey: true });
  g.key("keyup", "KeyL");
  g.tick(2);

  assert(g.state() === "playing", `the run must keep playing after the skip, state=${g.state()}`);
  assert(g.level() === 3, `level must rise by exactly 1, ${g.level()}`);
  const want = Math.min(base * Math.pow(growth, 2), cap);
  assert(g.serveSpeed() === want,
    `serve speed must be base × growth² exactly (${want}), got ${g.serveSpeed()}`);
  // Formula-verification against the EXISTING clear-progression
  // semantics: a control boot that genuinely clears level 2 must
  // arrive at the very same speed.
  const ctrl = boot(960, 600);
  start(ctrl);
  clearBoard(ctrl); // -> 2
  clearBoard(ctrl); // -> 3
  assert(ctrl.level() === 3, `setup: the control run must reach level 3, got ${ctrl.level()}`);
  assert(ctrl.serveSpeed() === g.serveSpeed(),
    `the skip must grow the speed exactly like the real clear progression, skip=${g.serveSpeed()} clear=${ctrl.serveSpeed()}`);
  // Layout respawned for level 3, pristine, into the same pool.
  assertMapMatches(g, patterns[(3 - 1) % patterns.length], "level 3 respawn after Shift+L");
  assert(g.bricksLeft() === breakableCount(patterns[2]),
    `bricksLeft must count the new pattern's breakables, got ${g.bricksLeft()}`);
  assert(g.activeCount() === occupiedCount(patterns[2]),
    `the respawn must occupy exactly the pattern's cells, got ${g.activeCount()}`);
  assert(g.poolLen() === g.grid(), "the pool must stay fixed-size");
  // Ball back to a single served/attached state.
  assert(g.activeBallCount() === 1, `exactly one ball may be live, got ${g.activeBallCount()}`);
  const b0 = g.ballList()[0];
  assert(b0.attached === true, "the sole ball must be attached");
  assert(b0.vx === 0 && b0.vy === 0, "the sole ball must be at rest");
  assert(b0.x === g.paddleX(), "the sole ball must ride the paddle centre");
  assert(g.score() === scoreBefore, `score must be untouched, ${scoreBefore} -> ${g.score()}`);
  assert(g.lives() === livesBefore, `lives must be untouched, ${livesBefore} -> ${g.lives()}`);
  assert(g.els["hud-level"].textContent === "3", `the HUD level readout must follow, got ${JSON.stringify(g.els["hud-level"].textContent)}`);
});

check("Shift+L honours the same MAX_BALL_SPEED cap as the clear progression: a capped level stays capped", () => {
  const g = boot(960, 600);
  start(g);
  forceLevel(g, 10); // level 10 is exactly the capping level
  assert(g.serveSpeed() === g.q("MAX_BALL_SPEED"),
    `setup: level 10 must already be at the cap, got ${g.serveSpeed()}`);
  g.key("keydown", "KeyL", { shiftKey: true });
  g.key("keyup", "KeyL");
  assert(g.level() === 11, `level must rise, got ${g.level()}`);
  assert(g.serveSpeed() === g.q("MAX_BALL_SPEED"),
    `the skip must never exceed the cap, got ${g.serveSpeed()}`);
  // The control: a genuine clear at the cap produces the same speed.
  const ctrl = boot(960, 600);
  start(ctrl);
  forceLevel(ctrl, 10);
  clearBoard(ctrl);
  assert(ctrl.serveSpeed() === g.serveSpeed(),
    `capped skip must equal the capped clear progression, skip=${g.serveSpeed()} clear=${ctrl.serveSpeed()}`);
});

// ================================================================
// Criterion 2: from level 2, Shift+K goes back to level 1 PRISTINE
// with the recompute (base) speed; at level 1 Shift+K is a no-op
// ================================================================
check("from level 2, Shift+K respawns level 1 pristine at exactly the base serve speed", () => {
  const g = boot(960, 600);
  start(g);
  clearBoard(g); // genuine clear: level 1 -> 2
  assert(g.level() === 2, `setup: level 2, got ${g.level()}`);
  const scoreBefore = g.score();
  const livesBefore = g.lives();
  const patterns = g.patterns();

  g.key("keydown", "KeyK", { shiftKey: true });
  g.key("keyup", "KeyK");
  g.tick(2);

  assert(g.level() === 1, `level must drop by exactly 1, got ${g.level()}`);
  assert(g.serveSpeed() === runBase(g),
    `serve speed must be the level-1 base (${runBase(g)}), got ${g.serveSpeed()}`);
  assertMapMatches(g, patterns[0], "level 1 respawn after Shift+K");
  assert(g.boardPristine(), "every respawned brick must sit at full tier hp");
  assert(g.bricksLeft() === breakableCount(patterns[0]),
    `bricksLeft must recount the pristine board, got ${g.bricksLeft()}`);
  assert(g.activeBallCount() === 1 && g.ballList()[0].attached === true,
    "the sole ball must be served attached");
  assert(g.score() === scoreBefore, `score must be untouched, ${scoreBefore} -> ${g.score()}`);
  assert(g.lives() === livesBefore, `lives must be untouched, ${livesBefore} -> ${g.lives()}`);
});

check("at level 1, Shift+K is a complete no-op: level, speed, board and ball untouched", () => {
  const g = boot(960, 600);
  start(g);
  const before = g.brickMap();
  const ballBefore = g.ballList()[0];
  g.key("keydown", "KeyK", { shiftKey: true });
  g.key("keyup", "KeyK");
  g.tick(2);
  assert(g.level() === 1, `level must floor at 1, got ${g.level()}`);
  assert(g.serveSpeed() === runBase(g), `speed must stay at the base, got ${g.serveSpeed()}`);
  assert(JSON.stringify(g.brickMap()) === JSON.stringify(before), "the board must be untouched");
  assert(JSON.stringify(g.ballList()[0]) === JSON.stringify(ballBefore), "the ball must be untouched");
  assert(g.state() === "playing", `state must stay playing, got ${g.state()}`);
});

check("Shift+K recomputes the level's OWN legitimate speed (base × growth^(target−1), capped), not a delta off the drifted run speed", () => {
  const g = boot(960, 600);
  start(g);
  clearBoard(g); // -> 2
  clearBoard(g); // -> 3 (speed base × growth², and level 3 is mid-board intact)
  assert(g.level() === 3, `setup: level 3, got ${g.level()}`);
  // Damage level 3 so the board is demonstrably NOT pristine.
  const victim = g.q(`(function () { for (var i = 0; i < bricks.length; i += 1) { if (bricks[i].active && !bricks[i].unbreakable) { destroyBrick(i); return i; } } return -1; })()`);
  assert(victim >= 0, "setup: level 3 must still carry breakable bricks");
  assert(g.brickMap()[victim][0] === 0, "setup: the victim must be destroyed");
  assert(g.multUntil() === -1, "setup: no multiplier window armed (fresh run)");
  const multBefore = g.multUntil();

  g.key("keydown", "KeyK", { shiftKey: true });
  g.key("keyup", "KeyK");
  assert(g.level() === 2, `back to level 2, got ${g.level()}`);
  const base = runBase(g);
  const growth = g.q("LEVEL_SPEED_GROWTH");
  // base × growth² divided backwards would be a DELTA and can differ
  // in the low bits from a straight recompute; demand the exact
  // product.
  const want = base * growth;
  assert(g.serveSpeed() === want,
    `the level-2 speed must be the legitimate base × growth exactly (${want}), got ${g.serveSpeed()}`);

  // Return forward: level 3 must come back PRISTINE (the damaged
  // board does not survive the round trip) and at its legitimate
  // speed.
  g.key("keydown", "KeyL", { shiftKey: true });
  g.key("keyup", "KeyL");
  assert(g.level() === 3, `forward again to level 3, got ${g.level()}`);
  const patterns = g.patterns();
  assertMapMatches(g, patterns[2], "level 3 re-respawn after the round trip");
  assert(g.boardPristine(), "the round-tripped board must be pristine (previous damage discarded)");
  assert(g.serveSpeed() === legitimateSpeed(g, 3),
    `the round trip must end at the legitimate level-3 speed, got ${g.serveSpeed()}`);
  assert(g.multUntil() === multBefore,
    `the multiplier window must be left to its natural expiry state, ${multBefore} -> ${g.multUntil()}`);
});

check("the back-step recompute uses the RUN's preset base (easy), not the raw BALL_SERVE_SPEED constant", () => {
  const g = boot(960, 600);
  g.els["difficulty-easy"].click();
  start(g);
  assert(runBase(g) === g.q("DIFFICULTY.easy.serveSpeed"), "setup: easy preset selected");
  assert(runBase(g) !== g.q("BALL_SERVE_SPEED"), "setup: the easy base must differ from the legacy constant");
  clearBoard(g); // -> 2
  assert(g.serveSpeed() === g.q("DIFFICULTY.easy.serveSpeed") * g.q("LEVEL_SPEED_GROWTH"),
    `setup: level 2 runs on the grown easy base, got ${g.serveSpeed()}`);
  g.key("keydown", "KeyK", { shiftKey: true });
  g.key("keyup", "KeyK");
  assert(g.serveSpeed() === g.q("DIFFICULTY.easy.serveSpeed"),
    `back to level 1 must recompute from the easy base (${g.q("DIFFICULTY.easy.serveSpeed")}), got ${g.serveSpeed()}`);
});

check("the back-step recompute applies the cap like the forward progression (high forced level, capped)", () => {
  const g = boot(960, 600);
  start(g);
  forceLevel(g, 11); // past the cap (level 10 already sits at it)
  assert(g.serveSpeed() === g.q("MAX_BALL_SPEED"), "setup: level 11 must be capped");
  g.key("keydown", "KeyK", { shiftKey: true });
  g.key("keyup", "KeyK");
  assert(g.level() === 10, `back to level 10, got ${g.level()}`);
  assert(g.serveSpeed() === legitimateSpeed(g, 10),
    `the recompute must cap, got ${g.serveSpeed()}`);
});

// ================================================================
// Criterion 3: the keys are honoured ONLY in "playing" — start,
// paused and game over each ignore them (asserted per state)
// ================================================================
function assertIgnored(g, label) {
  const lvl = g.level();
  const spd = g.serveSpeed();
  const board = JSON.stringify(g.brickMap());
  const ball = JSON.stringify(g.ballList());
  const score = g.score();
  const lives = g.lives();
  const st = g.state();
  g.key("keydown", "KeyL", { shiftKey: true });
  g.key("keyup", "KeyL");
  g.key("keydown", "KeyK", { shiftKey: true });
  g.key("keyup", "KeyK");
  g.tick(2);
  assert(g.state() === st, `${label}: state must stay ${st}, got ${g.state()}`);
  assert(g.level() === lvl, `${label}: level must not move, ${lvl} -> ${g.level()}`);
  assert(g.serveSpeed() === spd, `${label}: speed must not move, ${spd} -> ${g.serveSpeed()}`);
  assert(JSON.stringify(g.brickMap()) === board, `${label}: the board must be untouched`);
  assert(JSON.stringify(g.ballList()) === ball, `${label}: the balls must be untouched`);
  assert(g.score() === score, `${label}: score must not move`);
  assert(g.lives() === lives, `${label}: lives must not move`);
}

check("start screen: Shift+L and Shift+K are ignored", () => {
  const g = boot(960, 600);
  assert(g.state() === "start", "setup: booted to the start screen");
  assertIgnored(g, "start");
});

check("paused: Shift+L and Shift+K are ignored", () => {
  const g = boot(960, 600);
  start(g);
  clearBoard(g); // a real level-2 run to pause
  g.key("keydown", "Escape");
  assert(g.state() === "paused", `setup: Escape must pause, got ${g.state()}`);
  assertIgnored(g, "paused");
});

check("game over: Shift+L and Shift+K are ignored", () => {
  const g = boot(960, 600);
  start(g);
  g.q("lives = 1; loseLife(); 1"); // the last life goes -> game over
  assert(g.state() === "gameover", `setup: the run must be at game over, got ${g.state()}`);
  assertIgnored(g, "game over");
});

// ================================================================
// Criterion 4: nothing in the UI (markup text, DOM copy, help
// screens) mentions the secret keys — assert their absence from
// everything outside the <script> implementation
// ================================================================
check("no UI copy or DOM text mentions the secret keys (Shift / level-skip) anywhere outside the script", () => {
  // Strip the implementation: only the markup (head + body text and
  // attributes the player can read) may be scanned.
  const markup = html
    .replace(/<script>[\s\S]*?<\/script>/, "")
    .replace(/<style>[\s\S]*?<\/style>/, "");
  const lower = markup.toLowerCase();
  assert(!lower.includes("shift"), `the markup must never spell "shift", found in: ${markup.slice(Math.max(0, lower.indexOf("shift") - 60), lower.indexOf("shift") + 40)}`);
  assert(!/level[\s_-]*skip/i.test(markup), "the markup must never call these level skips");
  assert(!/skip[\s_-]*level/i.test(markup), "the markup must never call these level skips (word order 2)");
  // Nor may any runtime-written DOM text mention them: the game's
  // only dynamic text sources are HUD/leaderboard copies.
  const g = boot(960, 600);
  for (const [id, el] of Object.entries(g.els)) {
    if (el.id === "game" || typeof el.textContent !== "string") continue;
    assert(!/shift/i.test(el.textContent), `#${id} text must not mention the keys`);
  }
  // The implementation itself must not print or echo anything
  // either (no console.* chatter about the keys).
  assert(!/console\.\w+\([\s\S]{0,80}(shift|skiplvl|skip_level)/i.test(gameSource),
    "the script must stay silent about the keys");
});

// ================================================================
// Criterion 5: deterministic key-combo handling with no leakage —
// releasing Shift BEFORE L must not trigger; a plain (unshifted)
// L/K is a no-op; auto-repeat is edge-gated to one step per press
// ================================================================
check("leak check: press-and-release Shift first, THEN press L with Shift down=false must not skip", () => {
  const g = boot(960, 600);
  start(g);
  clearBoard(g); // level 2, so a leaked press would show
  assert(g.level() === 2, "setup: level 2");
  g.key("keydown", "ShiftLeft", { shiftKey: true });
  g.key("keyup", "ShiftLeft", { shiftKey: false });
  g.key("keydown", "KeyL", { shiftKey: false }); // Shift already released
  g.key("keyup", "KeyL");
  g.tick(2);
  assert(g.level() === 2, `the released-Shift press must NOT skip, level=${g.level()}`);
  assert(g.serveSpeed() === g.q("BALL_SERVE_SPEED") * g.q("LEVEL_SPEED_GROWTH"),
    "the speed must not move on a leaked press");
  // A subsequent clean Shift+L press still works (no latched state).
  g.key("keydown", "KeyL", { shiftKey: true });
  g.key("keyup", "KeyL");
  assert(g.level() === 3, `after the non-trigger, a real press must still work, level=${g.level()}`);
});

check("unsupported ordering is pinned: letter held FIRST, then Shift arrives must not trigger (no retro-shift)", () => {
  const g = boot(960, 600);
  start(g);
  clearBoard(g);
  assert(g.level() === 2, "setup: level 2");
  const spd = g.serveSpeed();
  // Plain L held (shiftKey false at its press edge — the game's only
  // chance to see it), then Shift arrives over the held letter:
  // the combo is browser-delivery-dependent, and we pin that the
  // game treats it as a no-op rather than retro-activating.
  g.key("keydown", "KeyL", { shiftKey: false });
  g.key("keydown", "ShiftLeft", { shiftKey: true });
  g.tick(2);
  assert(g.level() === 2, `letter-then-Shift must NOT skip, level=${g.level()}`);
  assert(g.serveSpeed() === spd, "the speed must not move on letter-then-Shift");
  g.key("keyup", "ShiftLeft", { shiftKey: false });
  g.key("keyup", "KeyL");
  // The next clean press still works (nothing latched by the odd order).
  g.key("keydown", "KeyL", { shiftKey: true });
  g.key("keyup", "KeyL");
  assert(g.level() === 3, `a clean press after the odd ordering must still work, level=${g.level()}`);
});

check("plain L and plain K (no Shift) are no-ops even mid-run", () => {
  const g = boot(960, 600);
  start(g);
  clearBoard(g); // level 2
  const spd = g.serveSpeed();
  g.key("keydown", "KeyL");
  g.key("keyup", "KeyL");
  g.key("keydown", "KeyK");
  g.key("keyup", "KeyK");
  g.tick(2);
  assert(g.level() === 2, `plain L/K must not move the level, got ${g.level()}`);
  assert(g.serveSpeed() === spd, "plain L/K must not move the speed");
  assert(g.activeBallCount() === 1 && g.ballList()[0].attached === true,
    "plain L/K must not re-serve");
});

check("auto-repeat is edge-gated: holding Shift+L and receiving repeat keydowns advances exactly once", () => {
  const g = boot(960, 600);
  start(g);
  clearBoard(g); // level 2
  g.key("keydown", "KeyL", { shiftKey: true });
  g.key("keydown", "KeyL", { shiftKey: true }); // browser auto-repeat
  g.key("keydown", "KeyL", { shiftKey: true });
  assert(g.level() === 3, `one physical press must advance exactly one level, got ${g.level()}`);
  g.key("keyup", "KeyL");
  // Re-pressing (fresh edge) advances again.
  g.key("keydown", "KeyL", { shiftKey: true });
  g.key("keyup", "KeyL");
  assert(g.level() === 4, `a fresh press must advance again, got ${g.level()}`);
});

check("auto-repeat is edge-gated the other way: repeat Shift+K holds at the floor without erroring", () => {
  const g = boot(960, 600);
  start(g);
  g.key("keydown", "KeyK", { shiftKey: true });
  g.key("keydown", "KeyK", { shiftKey: true }); // repeat at the floor
  g.key("keyup", "KeyK");
  assert(g.level() === 1, "the floor must hold, level must be 1");
  assert(g.serveSpeed() === g.q("BALL_SERVE_SPEED"), "the speed must stay at the base");
});

check("the full round trip is deterministic: two boots, identical input, identical state", () => {
  const drive = (g) => {
    start(g);
    clearBoard(g); // -> 2
    g.key("keydown", "KeyL", { shiftKey: true }); // -> 3
    g.key("keyup", "KeyL");
    g.q(`for (var i = 0; i < bricks.length && bricksLeft > 2; i += 1) { if (bricks[i].active && !bricks[i].unbreakable) destroyBrick(i); } 1`);
    g.key("keydown", "KeyK", { shiftKey: true }); // -> 2
    g.key("keyup", "KeyK");
    return {
      level: g.level(),
      speed: g.serveSpeed(),
      score: g.score(),
      lives: g.lives(),
      board: JSON.stringify(g.brickMap()),
      balls: JSON.stringify(g.ballList()),
    };
  };
  const a = drive(boot(960, 600));
  const b = drive(boot(960, 600));
  assert(a.speed === b.speed && a.level === b.level && a.score === b.score && a.lives === b.lives,
    `scalar state must be byte-identical across boots: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  assert(a.board === b.board && a.balls === b.balls, "the board and ball state must be byte-identical across boots");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
