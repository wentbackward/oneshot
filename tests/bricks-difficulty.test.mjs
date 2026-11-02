#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html start-screen difficulty selector
// (ticket #44: three named presets, persisted in localStorage,
// applied per run)
//
// Same harness style as the sibling bricks-*.test.mjs suites: the
// REAL <script> from bricks.html runs in a sandboxed vm context
// with stubbed window/document/localStorage/requestAnimationFrame
// and DOM element stubs. The storage stub is RECORDING (backed by a
// plain object, logs every getItem/setItem) so a "reload" can
// re-boot onto the same backing store and exact writes are
// assertable. Static-HTML criteria are checked straight against
// the bricks.html source. Like every sibling suite, `random` is
// pinned at boot so a capsule can never drop by chance mid-test;
// the drop-rate tests re-pin it deliberately. No network, no
// external services.
//
// Run: node tests/bricks-difficulty.test.mjs
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
// compares the game's DIFFICULTY_KEY against this literal, so a
// rename in the game would fail both sides consistently.
const KEY = "brickbreaker.difficulty";

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

// A DOM element stub: records styles, text, listeners and classes.
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
    "lives": makeEl("lives"),
    "btn-reset-hiscore": makeEl("btn-reset-hiscore"),
    "leaderboard-start": makeEl("leaderboard-start"),
    "leaderboard-gameover": makeEl("leaderboard-gameover"),
  };
  const winListeners = {};
  let rafCb = null;
  let rafId = 0;
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
  // Pin the mutable random hook (like every sibling suite):
  // random() => 1 makes `random() >= dropRate` always true, so a
  // destroyed brick can never release an unplanned capsule.
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
    canvas,
    els,
    q,
    tick,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    store,
    storage,
  };
}

// The three option button stubs for a booted game, keyed by preset.
const opts = (g) => ({
  easy: g.els["difficulty-easy"],
  normal: g.els["difficulty-normal"],
  hard: g.els["difficulty-hard"],
});
const isMarked = (el) => el.className.includes("selected");

// The raw #screen-start section source, for the static-HTML checks.
const startSection = (() => {
  const m = html.match(/<section class="screen" id="screen-start">([\s\S]*?)<\/section>/);
  if (!m) throw new Error("#screen-start section not found in bricks.html");
  return m[1];
})();

// ================================================================
// Criterion 1 (static HTML): three nodes in #screen-start share a
// data-difficulty attribute with values easy|normal|hard, one
// (normal) marked selected by default
// ================================================================
check("the start screen contains exactly three nodes with data-difficulty, values easy|normal|hard (one each)", () => {
  const values = [...startSection.matchAll(/data-difficulty="([^"]*)"/g)].map((m) => m[1]);
  assert(values.length === 3,
    `#screen-start must hold exactly 3 data-difficulty nodes, found ${values.length}: ${JSON.stringify(values)}`);
  const sorted = [...values].sort();
  assert(JSON.stringify(sorted) === JSON.stringify(["easy", "hard", "normal"]),
    `the three values must be easy, normal, hard (once each), got ${JSON.stringify(values)}`);
});

check("the static default-selection mark sits on the normal node only", () => {
  const tags = [...startSection.matchAll(/<button\b[^>]*data-difficulty="([^"]*)"[^>]*>/g)];
  assert(tags.length === 3, `expected 3 option buttons, found ${tags.length}`);
  for (const t of tags) {
    const name = t[1];
    const marked = /class="[^"]*\bselected\b[^"]*"/.test(t[0]);
    if (name === "normal") {
      assert(marked, `the normal button must be marked selected in the static markup, got: ${t[0]}`);
    } else {
      assert(!marked, `the ${name} button must not be pre-marked selected, got: ${t[0]}`);
    }
  }
});

check("the file gains no external references", () => {
  const ext = (html.match(/(src|href)=/g) ?? []).length;
  assert(ext === 0, `bricks.html must stay self-contained (0 src/href), found ${ext}`);
});

// ================================================================
// Criterion 2 (table): DIFFICULTY maps each preset to at least
// serveSpeed, paddleWidth, dropRate; normal preserves the legacy
// tuning
// ================================================================
check("DIFFICULTY maps easy/normal/hard to numeric serveSpeed, paddleWidth and dropRate", () => {
  const g = boot(960, 600);
  const table = g.q("DIFFICULTY");
  assert(table && typeof table === "object", "DIFFICULTY must be a module-level table");
  for (const name of ["easy", "normal", "hard"]) {
    const row = table[name];
    assert(row && typeof row === "object", `DIFFICULTY.${name} must exist`);
    for (const knob of ["serveSpeed", "paddleWidth", "dropRate"]) {
      const v = row[knob];
      assert(typeof v === "number" && Number.isFinite(v) && v > 0,
        `DIFFICULTY.${name}.${knob} must be a positive number, got ${JSON.stringify(v)}`);
    }
  }
});

check("the normal preset preserves the legacy tuning (480 px/s serve, 120 px paddle, 0.25 drop)", () => {
  const g = boot(960, 600);
  const row = g.q("DIFFICULTY.normal");
  assert(row.serveSpeed === g.q("BALL_SERVE_SPEED"),
    `normal.serveSpeed must be the legacy ${g.q("BALL_SERVE_SPEED")}, got ${row.serveSpeed}`);
  assert(row.paddleWidth === g.q("BASE_PADDLE_W"),
    `normal.paddleWidth must be the legacy ${g.q("BASE_PADDLE_W")}, got ${row.paddleWidth}`);
  assert(row.dropRate === g.q("POWERUP_DROP_RATE"),
    `normal.dropRate must be the legacy ${g.q("POWERUP_DROP_RATE")}, got ${row.dropRate}`);
});

// ================================================================
// Criterion 2 (vm snapshot): beginRun() copies the SELECTED preset
// onto the run; the module-level constants stay untouched
// ================================================================
check("a run started on hard snapshots serveSpeed/paddleW from the hard preset and leaves BALL_SERVE_SPEED/BASE_PADDLE_W untouched", () => {
  const g = boot(960, 600, { [KEY]: '"hard"' });
  g.els["btn-start"].click();
  assert(g.state() === "playing", `the start button must begin the run, state is ${g.state()}`);
  const preset = g.q("DIFFICULTY.hard");
  assert(g.q("serveSpeed") === preset.serveSpeed,
    `run serveSpeed must be the hard preset's ${preset.serveSpeed}, got ${g.q("serveSpeed")}`);
  assert(g.q("paddleW") === preset.paddleWidth,
    `run paddleW must be the hard preset's ${preset.paddleWidth}, got ${g.q("paddleW")}`);
  assert(g.q("BALL_SERVE_SPEED") === 480,
    `BALL_SERVE_SPEED must stay 480, got ${g.q("BALL_SERVE_SPEED")}`);
  assert(g.q("BASE_PADDLE_W") === 120,
    `BASE_PADDLE_W must stay 120, got ${g.q("BASE_PADDLE_W")}`);
});

check("a run started on easy snapshots the easy preset's knobs", () => {
  const g = boot(960, 600, { [KEY]: '"easy"' });
  g.els["btn-start"].click();
  const preset = g.q("DIFFICULTY.easy");
  assert(g.q("serveSpeed") === preset.serveSpeed,
    `run serveSpeed must be the easy preset's ${preset.serveSpeed}, got ${g.q("serveSpeed")}`);
  assert(g.q("paddleW") === preset.paddleWidth,
    `run paddleW must be the easy preset's ${preset.paddleWidth}, got ${g.q("paddleW")}`);
});

check("a run started on the default (normal) reproduces the legacy values", () => {
  const g = boot(960, 600);
  g.els["btn-start"].click();
  assert(g.q("serveSpeed") === 480, `default-run serveSpeed must stay 480, got ${g.q("serveSpeed")}`);
  assert(g.q("paddleW") === 120, `default-run paddleW must stay 120, got ${g.q("paddleW")}`);
  assert(g.q("dropRate") === 0.25, `default-run dropRate must stay 0.25, got ${g.q("dropRate")}`);
});

// ================================================================
// Boot-time selection: default, persisted restore, corruption
// fallback, named key constant
// ================================================================
check("a fresh boot (no stored value) selects normal and marks only the normal button", () => {
  const g = boot(960, 600);
  assert(g.q("selectedDifficulty") === "normal",
    `no stored value must mean the normal preset, got ${g.q("selectedDifficulty")}`);
  const o = opts(g);
  assert(isMarked(o.normal) && !isMarked(o.easy) && !isMarked(o.hard),
    `only the normal button may be marked, easy=${o.easy.className} normal=${o.normal.className} hard=${o.hard.className}`);
});

check("a seeded 'hard' selection is restored at boot and only the hard button is marked", () => {
  const g = boot(960, 600, { [KEY]: '"hard"' });
  assert(g.q("selectedDifficulty") === "hard",
    `the stored hard choice must load at boot, got ${g.q("selectedDifficulty")}`);
  const o = opts(g);
  assert(isMarked(o.hard) && !isMarked(o.normal) && !isMarked(o.easy),
    `only the hard button may be marked, easy=${o.easy.className} normal=${o.normal.className} hard=${o.hard.className}`);
});

check("a stored value from another build ('banana') falls back to normal at boot", () => {
  const g = boot(960, 600, { [KEY]: '"banana"' });
  assert(g.q("selectedDifficulty") === "normal",
    `an unknown preset name must fall back to normal, got ${g.q("selectedDifficulty")}`);
});

check("corrupt stored JSON falls back to normal without breaking boot", () => {
  const g = boot(960, 600, { [KEY]: "{not json" });
  assert(g.state() === "start", `boot must survive corrupt storage, state is ${g.state()}`);
  assert(g.q("selectedDifficulty") === "normal",
    `corrupt JSON must fall back to normal, got ${g.q("selectedDifficulty")}`);
});

check("a stored non-string ('123') falls back to normal at boot", () => {
  const g = boot(960, 600, { [KEY]: "123" });
  assert(g.q("selectedDifficulty") === "normal",
    `a non-string stored value must fall back to normal, got ${g.q("selectedDifficulty")}`);
});

check("the selection loads via the named key constant (DIFFICULTY_KEY) at boot", () => {
  const g = boot(960, 600, { [KEY]: '"easy"' });
  const key = g.q("typeof DIFFICULTY_KEY === 'undefined' ? null : DIFFICULTY_KEY");
  assert(typeof key === "string" && key.length > 0,
    `DIFFICULTY_KEY must be a non-empty string constant, got ${JSON.stringify(key)}`);
  assert(key === KEY, `the game's key drifted from the documented key, got ${JSON.stringify(key)}`);
  assert(g.storage.reads.includes(KEY),
    `boot must read ${KEY} from localStorage, reads were ${JSON.stringify(g.storage.reads)}`);
});

// ================================================================
// Criterion 3 (persistence): change writes JSON to the named key;
// a simulated reload (fresh boot, seeded storage) restores it
// ================================================================
check("clicking an option writes the choice as JSON to brickbreaker.difficulty and marks it selected", () => {
  const g = boot(960, 600);
  const o = opts(g);
  o.hard.click();
  assert(g.q("selectedDifficulty") === "hard",
    `the click must switch the run preset to hard, got ${g.q("selectedDifficulty")}`);
  assert(g.storage.writes.length === 1,
    `exactly one setItem must fire, writes were ${JSON.stringify(g.storage.writes)}`);
  const [wKey, wValue] = g.storage.writes[0];
  assert(wKey === KEY, `the write must target ${KEY}, got ${JSON.stringify(wKey)}`);
  const parsed = JSON.parse(wValue); // throws if not valid JSON
  assert(parsed === "hard", `the written value must be the JSON string "hard", got ${JSON.stringify(wValue)}`);
  assert(isMarked(o.hard) && !isMarked(o.normal),
    `the hard button must gain the selection mark and normal lose it, normal=${o.normal.className}`);
});

check("re-clicking the already-selected option changes nothing and performs no write", () => {
  const g = boot(960, 600);
  const o = opts(g);
  o.hard.click();
  o.hard.click();
  assert(g.storage.writes.length === 1,
    `re-selecting the active preset must not rewrite storage, writes were ${JSON.stringify(g.storage.writes)}`);
  assert(g.q("selectedDifficulty") === "hard",
    `the selection must remain hard, got ${g.q("selectedDifficulty")}`);
});

check("a change to a third preset overwrites the previous value with exactly one write per change", () => {
  const g = boot(960, 600, { [KEY]: '"normal"' });
  const o = opts(g);
  o.easy.click();
  o.hard.click();
  assert(g.storage.writes.length === 2,
    `two changes must produce exactly two writes, got ${g.storage.writes.length}: ${JSON.stringify(g.storage.writes)}`);
  assert(JSON.stringify(g.storage.writes) === JSON.stringify([[KEY, '"easy"'], [KEY, '"hard"']]),
    `the writes must be the new choice in order, got ${JSON.stringify(g.storage.writes)}`);
});

check("after a simulated reload (fresh vm sandbox, same backing store) the chosen preset is re-selected and re-marked", () => {
  const before = boot(960, 600);
  opts(before).easy.click();
  assert(before.store[KEY] === '"easy"',
    `the first session must persist "easy", got ${JSON.stringify(before.store[KEY])}`);

  // The "refresh": a brand-new sandbox booted onto the SAME backing
  // store the first session wrote into.
  const after = boot(960, 600, before.store);
  assert(after !== before, "the reload must be a distinct vm sandbox");
  assert(after.q("selectedDifficulty") === "easy",
    `the reloaded session must restore easy, got ${after.q("selectedDifficulty")}`);
  const o = opts(after);
  assert(isMarked(o.easy) && !isMarked(o.normal) && !isMarked(o.hard),
    `the reload must re-mark only the easy button, normal=${o.normal.className} hard=${o.hard.className}`);
});

// ================================================================
// Criterion 4 (observable drop-rate effect): with the pinned
// `random` hook, a run on hard rolls against DIFFICULTY.hard.dropRate
// — below the threshold a capsule drops, at/above it does not
// ================================================================
check("on hard, a pinned roll just below DIFFICULTY.hard.dropRate drops a capsule and a roll just above does not", () => {
  const g = boot(960, 600, { [KEY]: '"hard"' });
  g.els["btn-start"].click();
  const r = g.q("DIFFICULTY.hard.dropRate");
  assert(typeof r === "number" && r > 0 && r < 1, `hard.dropRate must be a probability, got ${r}`);
  const below = Math.max(0, r - 0.05);
  const above = Math.min(0.999, r + 0.05);
  const activeCapsules = () => g.q("capsules.filter(function (c) { return c.active; }).length");

  g.q(`random = () => ${below};`);
  g.q("destroyBrick(0)");
  assert(activeCapsules() === 1,
    `a roll of ${below} < ${r} must release exactly one capsule, got ${activeCapsules()}`);

  g.q(`random = () => ${above};`);
  g.q("destroyBrick(1)");
  assert(activeCapsules() === 1,
    `a roll of ${above} >= ${r} must release no capsule, got ${activeCapsules()} active`);
});

check("on easy, a roll between the normal and easy thresholds drops (the per-run knob, not the legacy constant)", () => {
  const g = boot(960, 600, { [KEY]: '"easy"' });
  g.els["btn-start"].click();
  const easyR = g.q("DIFFICULTY.easy.dropRate");
  const legacy = g.q("POWERUP_DROP_RATE");
  assert(easyR > legacy,
    `the easy preset must roll friendlier than the legacy rate (${easyR} > ${legacy})`);
  // A roll in (legacy, easyR): the OLD constant code would not drop,
  // the per-run snapshot must.
  const between = (legacy + easyR) / 2;
  g.q(`random = () => ${between};`);
  g.q("destroyBrick(0)");
  const active = g.q("capsules.filter(function (c) { return c.active; }).length");
  assert(active === 1,
    `a roll of ${between} (>= legacy ${legacy}, < easy ${easyR}) must drop on easy, got ${active} active`);
});

check("each destroyed brick rolls the run's snapshot: dropRate itself is copied from the selected preset in beginRun", () => {
  const g = boot(960, 600, { [KEY]: '"hard"' });
  assert(g.q("dropRate") === g.q("DIFFICULTY.normal.dropRate"),
    `before a run dropRate is the default-preset rate, got ${g.q("dropRate")}`);
  g.els["btn-start"].click();
  assert(g.q("dropRate") === g.q("DIFFICULTY.hard.dropRate"),
    `beginRun must snapshot the hard preset's dropRate, got ${g.q("dropRate")}`);
});

// ================================================================
// Regression guard: the expand power-up must widen from the RUN'S
// base width (difficulty) and relax back to it — never the raw
// BASE_PADDLE_W constant
// ================================================================
check("an expand capsule on hard widens from the run base width and relaxes back to it (not BASE_PADDLE_W)", () => {
  const g = boot(960, 600, { [KEY]: '"hard"' });
  g.els["btn-start"].click();
  const base = g.q("DIFFICULTY.hard.paddleWidth");
  g.q("applyCapsule(KIND_EXPAND)");
  const widened = g.q("paddleW");
  const expected = base * g.q("PADDLE_EXPAND_FACTOR");
  assert(Math.abs(widened - expected) < 1e-9,
    `the widen must be run-base × factor (${expected}), got ${widened}`);
  assert(widened !== g.q("BASE_PADDLE_W"),
    `the widened width must not collapse to the raw constant, got ${widened}`);
  g.q("simTime += PADDLE_EXPAND_DURATION_S + 1;"); // step past the full window
  g.tick(1);
  assert(g.q("paddleW") === base,
    `the widen must expire back to the run's base width (${base}), got ${g.q("paddleW")}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
