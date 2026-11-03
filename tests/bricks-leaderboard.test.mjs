#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html high-score reset button and local
// top-five leaderboard (ticket #48)
//
// Same harness style as tests/bricks-hiscore.test.mjs: runs the
// REAL <script> from bricks.html in a sandboxed vm context with
// stubbed window/document/localStorage/requestAnimationFrame and
// DOM element stubs. This suite's storage stub is RECORDING and
// also implements removeItem (the reset control's path). Each boot
// pins the game's mutable `random` hook so a capsule can never
// drop by chance mid-test. Runs are finished through the REAL
// loseLife() triple (the same path a ball drop drives). No
// network, no external services.
//
// Documented rules asserted below (also in docs/DECISIONS.md):
//  - a final score is recorded iff it is an integer > 0, and the
//    list has room (< 5 entries) or the score strictly beats the
//    list's lowest entry — a tie with the lowest of a FULL list
//    never displaces it;
//  - while the list has room, duplicates are kept;
//  - an empty list renders as one placeholder row on BOTH screens;
//  - the reset control clears BOTH persistence keys at once.
//
// Run: node tests/bricks-leaderboard.test.mjs
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

// The persistence keys the suite seeds and asserts against. Mirror
// the game's named constants; the "named key constant" checks below
// compare the game's constants against these literals, so a rename
// in the game would fail both sides consistently.
const HS_KEY = "brickbreaker.highScore";
const LB_KEY = "brickbreaker.leaderboard";
const EMPTY_ROW_TEXT = "no scores yet";

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
// child nodes (the game rebuilds leaderboard rows in place).
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
// initialStore seeds the backing object of the recording
// localStorage stub; pass a previous boot's `store` to simulate a
// page reload onto the same origin's storage.
function boot(width, height, initialStore = {}) {
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
    "game": canvas,
    "screen-start": makeEl("screen-start"),
    "btn-start": makeEl("btn-start"),
    "capsule-legend": makeEl("capsule-legend"),
    "difficulty-easy": makeEl("difficulty-easy"),
    "difficulty-normal": makeEl("difficulty-normal"),
    "difficulty-hard": makeEl("difficulty-hard"),
    "theme-classic": makeEl("theme-classic"),
    "theme-neon": makeEl("theme-neon"),
    "theme-minimal": makeEl("theme-minimal"),
    "mode-classic": makeEl("mode-classic"),
    "mode-exciting": makeEl("mode-exciting"),
    "mode-alleyway": makeEl("mode-alleyway"),
    "fastfwd-off": makeEl("fastfwd-off"),
    "fastfwd-1-5": makeEl("fastfwd-1-5"),
    "fastfwd-2-0": makeEl("fastfwd-2-0"),
    "fastfwd-3-0": makeEl("fastfwd-3-0"),
    "btn-reset-hiscore": makeEl("btn-reset-hiscore"),
    "btn-fullscreen": makeEl("btn-fullscreen"),
    "btn-mute": makeEl("btn-mute"),
    "sound-volume": makeEl("sound-volume"),
    "ball-speed": makeEl("ball-speed"),
    "ball-speed-label": makeEl("ball-speed-label"),
    "ball-speed-value": makeEl("ball-speed-value"),
    "leaderboard-start": makeEl("leaderboard-start"),
    "screen-gameover": makeEl("screen-gameover"),
    "btn-restart": makeEl("btn-restart"),
    "btn-menu": makeEl("btn-menu"),
    "leaderboard-gameover": makeEl("leaderboard-gameover"),
    "screen-pause": makeEl("screen-pause"),
    "btn-resume": makeEl("btn-resume"),
    "gameover-final": makeEl("gameover-final"),
    "hud-score": makeEl("hud-score"),
    "hud-level": makeEl("hud-level"),
    "hiscore": makeEl("hiscore"),
    "lives": makeEl("lives"),
  };
  const winListeners = {};
  let rafCb = null;
  let rafId = 0;
  // Recording storage: a plain object is the backing store (the
  // stand-in for the browser's localStorage partition), and every
  // accessor call is logged with its key for exact-write asserts.
  const store = Object.assign(Object.create(null), initialStore);
  const storage = {
    reads: [],
    writes: [],
    removes: [],
    getItem(key) {
      storage.reads.push(String(key));
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      storage.writes.push([String(key), String(value)]);
      store[key] = String(value);
    },
    removeItem(key) {
      storage.removes.push(String(key));
      delete store[key];
    },
  };
  const sandbox = {
    localStorage: storage,
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
      addEventListener: () => {}, // ticket #113: fullscreenchange registers on document at boot
    },
    requestAnimationFrame: (cb) => {
      rafCb = cb;
      return ++rafId;
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);
  // Pin the mutable random hook (like every sibling suite):
  // random() => 1 makes a destroyed brick always drop a capsule;
  // this suite never destroys bricks, the pin just keeps the game
  // deterministic in case a future run does.
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
  // Drive ONE full run to game over with a forced final score:
  // (re)start from the current menu state, pin the score, then
  // spend all three lives through the real loseLife() path —
  // the same entry point a final ball drop takes.
  function finishRun(finalScore) {
    const menuBtn =
      q("gameState") === "gameover" ? els["btn-restart"] : els["btn-start"];
    menuBtn.click();
    q(`score = ${finalScore};`);
    // One frame so syncScore promotes the forced score to the
    // high score exactly as the real frame loop would.
    tick(1);
    q(
      "loseLife(); loseLife(); loseLife();"
    );
  }
  // The ranked row texts a container currently renders.
  const rows = (containerEl) =>
    containerEl.children.map((c) => c.textContent);
  return {
    canvas,
    els,
    q,
    tick,
    finishRun,
    rows,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    store,
    storage,
  };
}

// ================================================================
// Criterion 4 (part): DOM shape — one leaderboard container per
// screen, and the file stays free of external references
// ================================================================
check("the HTML has exactly one leaderboard container on the start screen and one on the game-over screen", () => {
  const startSection = html.match(
    /<section[^>]*id="screen-start">[\s\S]*?<\/section>/
  )[0];
  const overSection = html.match(
    /<section[^>]*id="screen-gameover">[\s\S]*?<\/section>/
  )[0];
  const startHits = startSection.match(/class="leaderboard"/g) ?? [];
  const overHits = overSection.match(/class="leaderboard"/g) ?? [];
  assert(startHits.length === 1,
    `the start screen must carry exactly one .leaderboard container, got ${startHits.length}`);
  assert(overHits.length === 1,
    `the game-over screen must carry exactly one .leaderboard container, got ${overHits.length}`);
  const resetButtons = (html.match(/id="btn-reset-hiscore"/g) ?? []).length;
  assert(resetButtons === 1,
    `exactly one reset-high-score button expected, got ${resetButtons}`);
});

check("the game stays free of external src/href references", () => {
  const extRefs = html.match(/(src|href)=/g) ?? [];
  assert(extRefs.length === 0,
    `bricks.html must not reference external resources, found ${extRefs.length} src/href attributes`);
});

// ================================================================
// Criterion 4 (part): empty-rendering — a fresh storage partition
// shows a single placeholder row on BOTH screens
// ================================================================
check("booting with an empty storage partition renders one placeholder row on BOTH leaderboard containers", () => {
  const g = boot(960, 600);
  g.tick(1);
  const startRows = g.rows(g.els["leaderboard-start"]);
  const overRows = g.rows(g.els["leaderboard-gameover"]);
  assert(startRows.length === 1 && startRows[0] === EMPTY_ROW_TEXT,
    `the start-screen leaderboard must render exactly one placeholder row "${EMPTY_ROW_TEXT}", got ${JSON.stringify(startRows)}`);
  assert(overRows.length === 1 && overRows[0] === EMPTY_ROW_TEXT,
    `the game-over-screen leaderboard must render exactly one placeholder row "${EMPTY_ROW_TEXT}", got ${JSON.stringify(overRows)}`);
});

check("the named key constant LEADERBOARD_KEY equals 'brickbreaker.leaderboard' and is read at boot", () => {
  const g = boot(960, 600, { [LB_KEY]: "[300, 250, 100]" });
  const key = g.q("typeof LEADERBOARD_KEY === 'undefined' ? null : LEADERBOARD_KEY");
  assert(typeof key === "string" && key.length > 0,
    `LEADERBOARD_KEY must be a non-empty string constant, got ${JSON.stringify(key)}`);
  assert(key === LB_KEY, `the game's key drifted from the documented key, got ${JSON.stringify(key)}`);
  assert(g.storage.reads.includes(LB_KEY),
    `boot must read ${LB_KEY} from localStorage, reads were ${JSON.stringify(g.storage.reads)}`);
});

// ================================================================
// Criterion 4 (part): a stored valid list renders ranked,
// descending rows on both screens, and survives a reload
// ================================================================
check("a stored [300, 250, 100] renders three ranked rows on both containers at boot", () => {
  const g = boot(960, 600, { [LB_KEY]: "[300, 250, 100]" });
  g.tick(1);
  const want = ["1. 300", "2. 250", "3. 100"];
  const startRows = g.rows(g.els["leaderboard-start"]);
  const overRows = g.rows(g.els["leaderboard-gameover"]);
  assert(JSON.stringify(startRows) === JSON.stringify(want),
    `the start screen must render ${JSON.stringify(want)}, got ${JSON.stringify(startRows)}`);
  assert(JSON.stringify(overRows) === JSON.stringify(want),
    `the game-over screen must render ${JSON.stringify(want)}, got ${JSON.stringify(overRows)}`);
});

check("a stored list survives a simulated reload (fresh vm sandbox, same backing store)", () => {
  const before = boot(960, 600);
  before.finishRun(120);
  assert(before.state() === "gameover", `the run must end at game over, state is ${before.state()}`);
  assert(before.store[LB_KEY] === "[120]",
    `the first session must persist "[120]", got ${JSON.stringify(before.store[LB_KEY])}`);
  const after = boot(960, 600, before.store);
  after.tick(1);
  assert(after !== before, "the reload must be a distinct vm sandbox");
  assert(after.q("JSON.stringify(leaderboard)") === "[120]",
    `the reloaded session must load [120], got ${after.q("JSON.stringify(leaderboard)")}`);
  const overRows = after.rows(after.els["leaderboard-gameover"]);
  assert(JSON.stringify(overRows) === JSON.stringify(["1. 120"]),
    `the reloaded game-over container must render 1. 120, got ${JSON.stringify(overRows)}`);
  assert(after.state() === "start",
    `the reload must land on the start screen, state is ${after.state()}`);
});

// ================================================================
// Defensive loading: corrupt or invalid stored values fall back to
// an empty list; out-of-order values are normalised to descending
// ================================================================
check("corrupt stored leaderboard JSON boots with an empty list (placeholder rows, no crash)", () => {
  const g = boot(960, 600, { [LB_KEY]: "{not json" });
  g.tick(1);
  assert(g.q("JSON.stringify(leaderboard)") === "[]",
    `corrupt storage must load an empty list, got ${g.q("JSON.stringify(leaderboard)")}`);
  assert(g.rows(g.els["leaderboard-start"]).join() === EMPTY_ROW_TEXT,
    `corrupt storage must render the placeholder, got ${JSON.stringify(g.rows(g.els["leaderboard-start"]))}`);
  assert(g.state() === "start", `the corrupt value must not break boot, state is ${g.state()}`);
});

check("stored non-integer or non-positive entries invalidate the whole list", () => {
  for (const bad of ['[300, "two"]', "[300, 2.5]", "[300, 0]", "[300, null]"]) {
    const g = boot(960, 600, { [LB_KEY]: bad });
    g.tick(1);
    assert(g.q("JSON.stringify(leaderboard)") === "[]",
      `stored ${bad} must load an empty list, got ${g.q("JSON.stringify(leaderboard)")}`);
  }
});

check("a stored out-of-order list is normalised to descending order at load", () => {
  const g = boot(960, 600, { [LB_KEY]: "[100, 300, 250]" });
  g.tick(1);
  assert(g.q("JSON.stringify(leaderboard)") === "[300,250,100]",
    `an out-of-order store must load normalised, got ${g.q("JSON.stringify(leaderboard)")}`);
});

// ================================================================
// Criterion 2: enterGameOver() inserts the final score iff it is
// > 0 and qualifies — the ticket's vm check: forced scores
// 100 / 300 / 250 in three runs store exactly [300, 250, 100]
// ================================================================
check("forced final scores 100, 300, 250 in three runs persist exactly [300, 250, 100]", () => {
  const g = boot(960, 600);
  g.finishRun(100);
  assert(g.state() === "gameover", `run 1 must reach game over, state is ${g.state()}`);
  assert(g.store[LB_KEY] === "[100]",
    `after run 1 the store must hold "[100]", got ${JSON.stringify(g.store[LB_KEY])}`);
  g.finishRun(300);
  assert(g.store[LB_KEY] === "[300,100]",
    `after run 2 the store must hold "[300,100]", got ${JSON.stringify(g.store[LB_KEY])}`);
  g.finishRun(250);
  assert(g.state() === "gameover", `run 3 must reach game over, state is ${g.state()}`);
  assert(g.store[LB_KEY] === "[300,250,100]",
    `after run 3 the store must hold "[300,250,100]", got ${JSON.stringify(g.store[LB_KEY])}`);
});

check("a run's qualifying final score is visible in the game-over leaderboard the moment the screen opens", () => {
  const g = boot(960, 600, { [LB_KEY]: "[300, 250]" });
  g.finishRun(100);
  const overRows = g.rows(g.els["leaderboard-gameover"]);
  assert(JSON.stringify(overRows) === JSON.stringify(["1. 300", "2. 250", "3. 100"]),
    `the game-over screen must show the updated list immediately, got ${JSON.stringify(overRows)}`);
});

check("a run that ends with score 0 records nothing: no leaderboard write, placeholder stays", () => {
  const g = boot(960, 600, { [LB_KEY]: "[300]" });
  g.finishRun(0);
  assert(g.state() === "gameover", `the zero run must still reach game over, state is ${g.state()}`);
  const lbWrites = g.storage.writes.filter(([k]) => k === LB_KEY);
  assert(lbWrites.length === 0,
    `a score of 0 must not touch the leaderboard key, writes were ${JSON.stringify(lbWrites)}`);
  assert(g.store[LB_KEY] === "[300]",
    `the stored list must be untouched, got ${JSON.stringify(g.store[LB_KEY])}`);
});

// ================================================================
// Criterion 3: top-five truncation, boundary tie, duplicates
// ================================================================
check("six qualifying runs leave exactly the five highest scores, descending", () => {
  const g = boot(960, 600);
  for (const s of [200, 400, 100, 300, 500, 150]) g.finishRun(s);
  assert(g.state() === "gameover", `the sixth run must reach game over, state is ${g.state()}`);
  assert(g.store[LB_KEY] === "[500,400,300,200,150]",
    `six runs must leave the five highest descending, got ${JSON.stringify(g.store[LB_KEY])}`);
  assert(g.q("leaderboard.length") === 5,
    `the in-memory list must hold exactly five entries, got ${g.q("leaderboard.length")}`);
});

check("a full list rejects a score that ties its lowest entry (strict-greater boundary rule)", () => {
  const g = boot(960, 600, { [LB_KEY]: "[400, 300, 250, 150, 100]" });
  g.finishRun(100);
  // No qualifying insertion means no write: the backing store must
  // still hold the original seeded string byte for byte.
  assert(g.store[LB_KEY] === "[400, 300, 250, 150, 100]",
    `a tie with the lowest entry of a full list must not displace it (no write), got ${JSON.stringify(g.store[LB_KEY])}`);
});

check("duplicates are kept while the list has room", () => {
  const g = boot(960, 600, { [LB_KEY]: "[300]" });
  g.finishRun(300);
  assert(g.store[LB_KEY] === "[300,300]",
    `an equal score with room must be kept, got ${JSON.stringify(g.store[LB_KEY])}`);
});

// ================================================================
// Criteria 1 and 5: the reset control — one click deletes BOTH
// keys, zeroes the in-memory high score, refreshes #hiscore and
// both leaderboards; a fresh qualifying run re-persists afterwards
// ================================================================
check("clicking the reset button deletes BOTH keys, zeroes highScore, and refreshes #hiscore to 0 and both leaderboards to the placeholder", () => {
  const g = boot(960, 600, {
    [HS_KEY]: "600",
    [LB_KEY]: "[300, 250, 100]",
  });
  g.tick(1);
  g.els["btn-reset-hiscore"].click();
  assert(g.q("highScore") === 0,
    `the in-memory high score must be 0 after the click, got ${g.q("highScore")}`);
  assert(g.els["hiscore"].textContent === "0",
    `#hiscore must read 0 after the click, got ${JSON.stringify(g.els["hiscore"].textContent)}`);
  assert(g.storage.getItem(HS_KEY) === null,
    `${HS_KEY} must be gone from storage, getItem returned ${JSON.stringify(g.storage.getItem(HS_KEY))}`);
  assert(g.storage.getItem(LB_KEY) === null,
    `${LB_KEY} must be gone from storage, getItem returned ${JSON.stringify(g.storage.getItem(LB_KEY))}`);
  assert(g.q("JSON.stringify(leaderboard)") === "[]",
    `the in-memory leaderboard must be empty, got ${g.q("JSON.stringify(leaderboard)")}`);
  assert(g.rows(g.els["leaderboard-start"]).join() === EMPTY_ROW_TEXT,
    `the start-screen leaderboard must re-render the placeholder, got ${JSON.stringify(g.rows(g.els["leaderboard-start"]))}`);
  assert(g.rows(g.els["leaderboard-gameover"]).join() === EMPTY_ROW_TEXT,
    `the game-over-screen leaderboard must re-render the placeholder, got ${JSON.stringify(g.rows(g.els["leaderboard-gameover"]))}`);
});

check("a stray reset dispatch outside the start screen is a no-op (house-style state gate)", () => {
  const g = boot(960, 600, {
    [HS_KEY]: "600",
    [LB_KEY]: "[300, 250, 100]",
  });
  g.els["btn-start"].click();
  g.tick(1); // into 'playing'
  g.els["btn-reset-hiscore"].click();
  assert(g.q("highScore") === 600,
    `the in-memory high score must survive an out-of-state reset, got ${g.q("highScore")}`);
  assert(g.storage.getItem(HS_KEY) === "600",
    `${HS_KEY} must survive an out-of-state reset, got ${JSON.stringify(g.storage.getItem(HS_KEY))}`);
  assert(g.storage.getItem(LB_KEY) === "[300, 250, 100]",
    `${LB_KEY} must survive an out-of-state reset, got ${JSON.stringify(g.storage.getItem(LB_KEY))}`);
});

check("a fresh qualifying run after a reset re-persists a new high score and a new leaderboard record", () => {
  const g = boot(960, 600, {
    [HS_KEY]: "600",
    [LB_KEY]: "[300, 250, 100]",
  });
  g.tick(1);
  g.els["btn-reset-hiscore"].click();
  g.finishRun(120);
  assert(g.state() === "gameover", `the fresh run must reach game over, state is ${g.state()}`);
  assert(g.q("highScore") === 120,
    `the in-memory high score must rise to 120, got ${g.q("highScore")}`);
  assert(g.storage.getItem(HS_KEY) === "120",
    `the high score must be re-persisted as 120, got ${JSON.stringify(g.storage.getItem(HS_KEY))}`);
  assert(g.store[LB_KEY] === "[120]",
    `the leaderboard must hold exactly the fresh record "[120]", got ${JSON.stringify(g.store[LB_KEY])}`);
});

check("a sub-record run after a reset leaves both keys absent (nothing to re-persist)", () => {
  const g = boot(960, 600, {
    [HS_KEY]: "600",
    [LB_KEY]: "[300]",
  });
  g.tick(1);
  g.els["btn-reset-hiscore"].click();
  g.finishRun(0);
  assert(g.storage.getItem(HS_KEY) === null,
    `a zero-score run must not re-persist the high score, got ${JSON.stringify(g.storage.getItem(HS_KEY))}`);
  assert(g.storage.getItem(LB_KEY) === null,
    `a zero-score run must not re-persist the leaderboard, got ${JSON.stringify(g.storage.getItem(LB_KEY))}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
