#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html high score persistence across reloads
// (ticket #23, PRD section 4 "Local Storage")
//
// Same harness style as tests/bricks-scaffold.test.mjs: runs the
// REAL <script> from bricks.html in a sandboxed vm context with
// stubbed window/document/localStorage/requestAnimationFrame and
// DOM element stubs. This suite's storage stub is RECORDING: it
// backs a plain object (so a "refresh" can re-boot the game onto the
// same backing store) and logs every getItem/setItem call with its
// key and value, so tests can assert the exact writes performed.
// No network, no external services.
//
// Run: node tests/bricks-hiscore.test.mjs
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

// The persistence key the suite seeds and asserts against. Mirrors
// the game's named constant; the "named key constant" check below
// compares the game's HIGH_SCORE_KEY against this literal, so a
// rename in the game would fail both sides consistently.
const KEY = "brickbreaker.highScore";

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
// child nodes (lives icons are appended/removed by the game).
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
    "screen-gameover": makeEl("screen-gameover"),
    "btn-restart": makeEl("btn-restart"),
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
    getItem(key) {
      storage.reads.push(String(key));
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      storage.writes.push([String(key), String(value)]);
      store[key] = String(value);
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
  // Drop the run's single serve ball below the bottom edge so the
  // REAL lose-life path fires once; the next serve re-arms slot 0.
  function dropBallOnce() {
    vm.runInContext(
      "balls[0].attached = false; balls[0].vx = 0; balls[0].vy = 0;" +
        "balls[0].x = 4; balls[0].y = canvas.height + 10;",
      context
    );
    tick(1);
  }
  const q = (expr) => vm.runInContext(expr, context);
  return {
    canvas,
    els,
    q,
    tick,
    dropBallOnce,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    store,
    storage,
  };
}

// ================================================================
// Criterion 1: the high score is read from localStorage (named key
// constant) at boot; a stored 500 renders 500 in #hiscore
// ================================================================
check("booting with a stored 500 renders 500 in the #hiscore top-bar element", () => {
  const g = boot(960, 600, { [KEY]: "500" });
  g.tick(1);
  assert(g.q("highScore") === 500,
    `highScore must load 500 from the stub, got ${g.q("highScore")}`);
  assert(g.els["hiscore"].textContent === "500",
    `#hiscore must show 500, got ${JSON.stringify(g.els["hiscore"].textContent)}`);
});

check("the high score loads via the named key constant (HIGH_SCORE_KEY) at boot", () => {
  const g = boot(960, 600, { [KEY]: "500" });
  const key = g.q("typeof HIGH_SCORE_KEY === 'undefined' ? null : HIGH_SCORE_KEY");
  assert(typeof key === "string" && key.length > 0,
    `HIGH_SCORE_KEY must be a non-empty string constant, got ${JSON.stringify(key)}`);
  assert(key === KEY, `the game's key drifted from the documented key, got ${JSON.stringify(key)}`);
  assert(g.storage.reads.includes(KEY),
    `boot must read ${KEY} from localStorage, reads were ${JSON.stringify(g.storage.reads)}`);
});

check("an empty storage partition boots with high score 0 shown in #hiscore", () => {
  const g = boot(960, 600);
  g.tick(1);
  assert(g.q("highScore") === 0, `no stored value must mean high score 0, got ${g.q("highScore")}`);
  assert(g.els["hiscore"].textContent === "0",
    `#hiscore must show 0 on a fresh boot, got ${JSON.stringify(g.els["hiscore"].textContent)}`);
});

// ================================================================
// Criterion 2: a run where score reaches 600 over stored 500 writes
// exactly (KEY, JSON 600) once, and #hiscore shows 600
// ================================================================
check("a score reaching 600 over stored 500 performs exactly one setItem of JSON 600 and #hiscore shows 600", () => {
  const g = boot(960, 600, { [KEY]: "500" });
  g.els["btn-start"].click();
  g.q("score = 600");
  g.tick(1);
  assert(g.q("highScore") === 600, `highScore must rise to 600, got ${g.q("highScore")}`);
  assert(g.els["hiscore"].textContent === "600",
    `#hiscore must show 600 during the run, got ${JSON.stringify(g.els["hiscore"].textContent)}`);
  assert(g.storage.writes.length === 1,
    `the overtake must produce exactly one setItem call, got ${g.storage.writes.length}: ${JSON.stringify(g.storage.writes)}`);
  const [wKey, wValue] = g.storage.writes[0];
  assert(wKey === KEY, `the write must target ${KEY}, got ${JSON.stringify(wKey)}`);
  const parsed = JSON.parse(wValue); // throws if not valid JSON
  assert(Number.isInteger(parsed) && parsed === 600,
    `the written value must be the new score as a JSON number 600, got ${JSON.stringify(wValue)}`);
});

// ================================================================
// Criterion 3: a run that does not beat the stored value performs
// no write; on game over the displayed high score equals the
// persisted one
// ================================================================
check("a run that does not beat the stored value makes zero setItem calls and game over shows the persisted high score", () => {
  const g = boot(960, 600, { [KEY]: "500" });
  g.els["btn-start"].click();
  g.q("score = 120");
  // Three real ball drops cost all three lives and enter game over.
  g.dropBallOnce();
  g.dropBallOnce();
  g.dropBallOnce();
  g.tick(1);
  assert(g.state() === "gameover",
    `three ball drops must end the run, state is ${g.state()}`);
  assert(g.storage.writes.length === 0,
    `a sub-record run must write nothing, writes were ${JSON.stringify(g.storage.writes)}`);
  assert(g.store[KEY] === "500",
    `the stored value must remain "500", got ${JSON.stringify(g.store[KEY])}`);
  assert(g.els["hiscore"].textContent === "500",
    `game over must still show the persisted 500, got ${JSON.stringify(g.els["hiscore"].textContent)}`);
});

check("a run that exactly ties the stored value is not an overtake: zero writes", () => {
  const g = boot(960, 600, { [KEY]: "600" });
  g.els["btn-start"].click();
  g.q("score = 600");
  g.tick(1);
  assert(g.q("highScore") === 600, `a tie must leave highScore at 600, got ${g.q("highScore")}`);
  assert(g.storage.writes.length === 0,
    `a tie must not rewrite storage, writes were ${JSON.stringify(g.storage.writes)}`);
});

// ================================================================
// Criterion 4: a fresh boot (new vm sandbox) on the same backing
// store shows the last persisted high score — the refresh-survival
// property
// ================================================================
check("after a reload (fresh vm sandbox, same backing store) the last persisted high score is shown", () => {
  const before = boot(960, 600, { [KEY]: "500" });
  before.els["btn-start"].click();
  before.q("score = 830");
  before.tick(1);
  assert(before.store[KEY] === "830",
    `the first session must persist "830", got ${JSON.stringify(before.store[KEY])}`);

  // The "refresh": a brand-new sandbox booted onto the SAME backing
  // store the first session wrote into.
  const after = boot(960, 600, before.store);
  after.tick(1);
  assert(after !== before, "the reload must be a distinct vm sandbox");
  assert(after.q("highScore") === 830,
    `the reloaded session must load 830, got ${after.q("highScore")}`);
  assert(after.els["hiscore"].textContent === "830",
    `#hiscore must show 830 after the reload, got ${JSON.stringify(after.els["hiscore"].textContent)}`);
  assert(after.state() === "start",
    `the reload must land on the start screen, state is ${after.state()}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
