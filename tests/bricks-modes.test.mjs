#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html start-screen CLASSIC/EXCITING mode
// selector scaffold with drop-rate economy (ticket #74)
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
// compares the game's MODE_KEY against this literal, so a rename in
// the game would fail both sides consistently.
const KEY = "brickbreaker.mode";
// Mirrors the game's named EXCITING_DROP_FACTOR var (checked live
// against the booted game below as well).
const EXCITING_DROP_FACTOR_LITERAL = 2.0;

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

// The two mode option button stubs for a booted game, keyed by mode.
const opts = (g) => ({
  classic: g.els["mode-classic"],
  exciting: g.els["mode-exciting"],
  alleyway: g.els["mode-alleyway"],
});
const isMarked = (el) => el.className.includes("selected");
const markedCount = (g) => Object.values(opts(g)).filter(isMarked).length;

// The raw #screen-start section source, for the static-HTML checks.
const startSection = (() => {
  const m = html.match(/<section class="screen" id="screen-start">([\s\S]*?)<\/section>/);
  if (!m) throw new Error("#screen-start section not found in bricks.html");
  return m[1];
})();

// ================================================================
// Acceptance 1 + 4 (static HTML): three nodes in #screen-start
// share a data-mode attribute with values classic|exciting|alleyway,
// exactly one (classic) marked selected by default
// ================================================================
check("the start screen contains exactly three data-mode nodes, values classic|exciting|alleyway (one each)", () => {
  const values = [...startSection.matchAll(/data-mode="([^"]*)"/g)].map((m) => m[1]);
  assert(values.length === 3,
    `#screen-start must hold exactly 3 data-mode nodes, found ${values.length}: ${JSON.stringify(values)}`);
  const sorted = [...values].sort();
  assert(JSON.stringify(sorted) === JSON.stringify(["alleyway", "classic", "exciting"]),
    `the three values must be classic, exciting and alleyway (once each), got ${JSON.stringify(values)}`);
  const alleywayBtn = startSection.match(/<button\b[^>]*id="mode-alleyway"[^>]*>/);
  assert(alleywayBtn, "the third option node must be the #mode-alleyway button");
});

check("the static default-selection mark sits on the classic node only", () => {
  const tags = [...startSection.matchAll(/<button\b[^>]*data-mode="([^"]*)"[^>]*>/g)];
  assert(tags.length === 3, `expected 3 option buttons, found ${tags.length}`);
  for (const t of tags) {
    const name = t[1];
    const marked = /class="[^"]*\bselected\b[^"]*"/.test(t[0]);
    if (name === "classic") {
      assert(marked, `the classic button must be marked selected in the static markup, got: ${t[0]}`);
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
// Boot-time selection: default, persisted restore, corruption
// fallback, named key constant
// ================================================================
check("a fresh boot (no stored value) selects classic and marks only the classic button", () => {
  const g = boot(960, 600);
  assert(g.q("selectedMode") === "classic",
    `no stored value must mean the classic mode, got ${g.q("selectedMode")}`);
  const o = opts(g);
  assert(isMarked(o.classic) && !isMarked(o.exciting),
    `only the classic button may be marked, classic=${o.classic.className} exciting=${o.exciting.className}`);
});

check("a seeded 'exciting' selection is restored at boot and only the exciting button is marked", () => {
  const g = boot(960, 600, { [KEY]: '"exciting"' });
  assert(g.q("selectedMode") === "exciting",
    `the stored exciting choice must load at boot, got ${g.q("selectedMode")}`);
  const o = opts(g);
  assert(isMarked(o.exciting) && !isMarked(o.classic),
    `only the exciting button may be marked, classic=${o.classic.className}`);
});

check("a stored value from another build ('banana') falls back to classic at boot", () => {
  const g = boot(960, 600, { [KEY]: '"banana"' });
  assert(g.q("selectedMode") === "classic",
    `an unknown mode name must fall back to classic, got ${g.q("selectedMode")}`);
});

check("corrupt stored JSON falls back to classic without breaking boot", () => {
  const g = boot(960, 600, { [KEY]: "{not json" });
  assert(g.state() === "start", `boot must survive corrupt storage, state is ${g.state()}`);
  assert(g.q("selectedMode") === "classic",
    `corrupt JSON must fall back to classic, got ${g.q("selectedMode")}`);
});

check("a stored non-string ('123') falls back to classic at boot", () => {
  const g = boot(960, 600, { [KEY]: "123" });
  assert(g.q("selectedMode") === "classic",
    `a non-string stored value must fall back to classic, got ${g.q("selectedMode")}`);
});

check("the selection loads via the named key constant (MODE_KEY) at boot", () => {
  const g = boot(960, 600, { [KEY]: '"exciting"' });
  const key = g.q("typeof MODE_KEY === 'undefined' ? null : MODE_KEY");
  assert(typeof key === "string" && key.length > 0,
    `MODE_KEY must be a non-empty string constant, got ${JSON.stringify(key)}`);
  assert(key === KEY, `the game's key drifted from the documented key, got ${JSON.stringify(key)}`);
  assert(g.storage.reads.includes(KEY),
    `boot must read ${KEY} from localStorage, reads were ${JSON.stringify(g.storage.reads)}`);
});

// ================================================================
// Acceptance 4 (UI behaviour): exactly one mode button selected at
// any time; clicking the other reselects, the mark follows
// ================================================================
check("clicking exciting moves the mark to it and writes exactly one JSON entry to brickbreaker.mode", () => {
  const g = boot(960, 600);
  const o = opts(g);
  o.exciting.click();
  assert(g.q("selectedMode") === "exciting",
    `the click must switch the mode to exciting, got ${g.q("selectedMode")}`);
  assert(markedCount(g) === 1, `exactly one mode button may be marked, got ${markedCount(g)}`);
  assert(isMarked(o.exciting) && !isMarked(o.classic),
    `the exciting button must gain the mark and classic lose it, classic=${o.classic.className}`);
  assert(g.storage.writes.length === 1,
    `exactly one setItem must fire, writes were ${JSON.stringify(g.storage.writes)}`);
  const [wKey, wValue] = g.storage.writes[0];
  assert(wKey === KEY, `the write must target ${KEY}, got ${JSON.stringify(wKey)}`);
  const parsed = JSON.parse(wValue); // throws if not valid JSON
  assert(parsed === "exciting",
    `the written value must be the JSON string "exciting", got ${JSON.stringify(wValue)}`);
});

check("clicking back to classic reselects it: the mark returns and the write overwrites", () => {
  const g = boot(960, 600, { [KEY]: '"exciting"' });
  const o = opts(g);
  o.classic.click();
  assert(g.q("selectedMode") === "classic",
    `the click must switch the mode back to classic, got ${g.q("selectedMode")}`);
  assert(markedCount(g) === 1 && isMarked(o.classic) && !isMarked(o.exciting),
    `the mark must sit on classic alone after the reselect, exciting=${o.exciting.className}`);
  assert(JSON.stringify(g.storage.writes) === JSON.stringify([[KEY, '"classic"']]),
    `the reselect must overwrite the stored value, writes were ${JSON.stringify(g.storage.writes)}`);
});

check("re-clicking the already-selected mode changes nothing and performs no write", () => {
  const g = boot(960, 600, { [KEY]: '"exciting"' });
  const o = opts(g);
  o.exciting.click();
  assert(g.storage.writes.length === 0,
    `re-selecting the active mode must not rewrite storage, writes were ${JSON.stringify(g.storage.writes)}`);
  assert(g.q("selectedMode") === "exciting",
    `the selection must remain exciting, got ${g.q("selectedMode")}`);
  assert(markedCount(g) === 1, `the mark must stay on exciting alone, got ${markedCount(g)}`);
});

// ================================================================
// Acceptance 3 (persistence): a simulated reload (fresh boot, same
// backing store) round-trips the choice; corrupt value → classic
// ================================================================
check("after a simulated reload (fresh vm sandbox, same backing store) the chosen mode is re-selected and re-marked", () => {
  const before = boot(960, 600);
  opts(before).exciting.click();
  assert(before.store[KEY] === '"exciting"',
    `the first session must persist "exciting", got ${JSON.stringify(before.store[KEY])}`);

  // The "refresh": a brand-new sandbox booted onto the SAME backing
  // store the first session wrote into.
  const after = boot(960, 600, before.store);
  assert(after !== before, "the reload must be a distinct vm sandbox");
  assert(after.q("selectedMode") === "exciting",
    `the reloaded session must restore exciting, got ${after.q("selectedMode")}`);
  const o = opts(after);
  assert(isMarked(o.exciting) && !isMarked(o.classic),
    `the reload must re-mark only the exciting button, classic=${o.classic.className}`);
});

// ================================================================
// Structure (follow-up seam): one named mode-state table the
// follow-up tickets can branch on; the selector iterates a button
// list that admits a third entry cleanly (alleyway)
// ================================================================
check("EXCITING_DROP_FACTOR is the named tunable 2.0 and MODES maps classic → 1.0, exciting → the factor, alleyway → 1.0", () => {
  const g = boot(960, 600);
  const factor = g.q("EXCITING_DROP_FACTOR");
  assert(factor === 2.0, `EXCITING_DROP_FACTOR must be 2.0, got ${JSON.stringify(factor)}`);
  const table = g.q("MODES");
  assert(table && typeof table === "object", "MODES must be a module-level table");
  for (const name of Object.keys(table)) {
    assert(name === "classic" || name === "exciting" || name === "alleyway",
      `unexpected MODES row '${name}' — the table exposes classic/exciting/alleyway only, got ${Object.keys(table)}`);
  }
  assert(table.classic.dropFactor === 1.0,
    `the classic row must multiply the drop rate by exactly 1.0, got ${JSON.stringify(table.classic.dropFactor)}`);
  assert(table.exciting.dropFactor === EXCITING_DROP_FACTOR_LITERAL,
    `the exciting row must multiply by EXCITING_DROP_FACTOR (2.0), got ${JSON.stringify(table.exciting.dropFactor)}`);
  assert(table.alleyway.dropFactor === 1.0,
    `the alleyway row must keep the classic drop-rate economy (×1.0), got ${JSON.stringify(table.alleyway.dropFactor)}`);
});

check("modeButtons lists one [element, name] pair per MODES key — the seam a third button (alleyway) plugs into", () => {
  const g = boot(960, 600);
  const pairs = g.q("modeButtons");
  assert(Array.isArray(pairs), "modeButtons must be a module-level button list");
  const names = pairs.map((p) => p[1]);
  const keys = g.q("Object.keys(MODES)");
  assert(JSON.stringify(names) === JSON.stringify(keys),
    `modeButtons names must cover every MODES key once (in row order), got ${JSON.stringify(names)} vs ${JSON.stringify(keys)}`);
  for (const p of pairs) {
    assert(p[0] && typeof p[0].addEventListener === "function",
      `every modeButtons entry needs a bound element stub, got ${JSON.stringify(names)}`);
  }
});

// ================================================================
// Acceptance 1 (economy): boot with stored 'exciting' → beginRun
// snapshots mode "exciting" and a forced drop roll uses
// POWERUP_DROP_RATE × EXCITING_DROP_FACTOR (pinned `random` + count)
// ================================================================
check("with stored 'exciting', beginRun snapshots runMode 'exciting' and dropRate = POWERUP_DROP_RATE × EXCITING_DROP_FACTOR", () => {
  const g = boot(960, 600, { [KEY]: '"exciting"' });
  g.els["btn-start"].click();
  assert(g.state() === "playing", `the start button must begin the run, state is ${g.state()}`);
  assert(g.q("runMode") === "exciting",
    `beginRun must snapshot the selected mode onto the run, runMode is ${g.q("runMode")}`);
  const expected = g.q("POWERUP_DROP_RATE") * g.q("EXCITING_DROP_FACTOR");
  assert(g.q("dropRate") === expected,
    `the run's dropRate must be the preset rate × factor (${expected}), got ${g.q("dropRate")}`);
  assert(expected === 0.5, `sanity: normal × 2.0 is 0.5, got ${expected}`);
});

check("on exciting, a pinned roll between the classic rate and the factored rate drops a capsule the legacy code would not", () => {
  const g = boot(960, 600, { [KEY]: '"exciting"' });
  g.els["btn-start"].click();
  const classic = g.q("POWERUP_DROP_RATE");
  const excited = g.q("POWERUP_DROP_RATE") * g.q("EXCITING_DROP_FACTOR");
  const between = (classic + excited) / 2; // 0.375: ≥ classic, < excited
  const activeCapsules = () => g.q("capsules.filter(function (c) { return c.active; }).length");

  const idx = firstAliveBrick(g);
  g.q(`random = () => ${between};`);
  g.q(`destroyBrick(${idx})`);
  assert(activeCapsules() === 1,
    `a roll of ${between} (< ${excited}) must drop one capsule on exciting, got ${activeCapsules()} active`);
});

check("on exciting, pinned rolls below the factored rate fill the fixed pool (4) and the fifth vanishes without allocating", () => {
  const g = boot(960, 600, { [KEY]: '"exciting"' });
  g.els["btn-start"].click();
  const poolSize = g.q("CAPSULE_POOL_SIZE");
  assert(poolSize === 4, `sanity: the pool holds 4 capsules, got ${poolSize}`);
  const roll = 0.49; // < 0.5 (factored rate), >= 0.25 (classic)
  g.q(`random = () => ${roll};`);
  const idxs = aliveBricks(g, poolSize);
  for (const idx of idxs) g.q(`destroyBrick(${idx})`);
  assert(g.q("capsules.filter(function (c) { return c.active; }).length") === poolSize,
    `${poolSize} successful rolls must yield exactly ${poolSize} active capsules, got ${g.q("capsules.filter(function (c) { return c.active; }).length")}`);

  g.q(`destroyBrick(${firstAliveBrickExcluding(g, idxs)})`);
  assert(g.q("capsules.length") === poolSize,
    `a drop on a full pool must not allocate, capsules.length is ${g.q("capsules.length")}`);
});

// ================================================================
// Acceptance 2 (regression): a classic run's drop rate is UNCHANGED
// (×1.0) — snapshot exact and roll behaviour identical to legacy
// ================================================================
check("a classic run snapshots dropRate exactly at the legacy preset rate (×1.0)", () => {
  const g = boot(960, 600);
  g.els["btn-start"].click();
  assert(g.q("runMode") === "classic",
    `the default run must be classic, runMode is ${g.q("runMode")}`);
  assert(g.q("dropRate") === g.q("POWERUP_DROP_RATE"),
    `the classic run's dropRate must be the preset rate itself, got ${g.q("dropRate")} vs ${g.q("POWERUP_DROP_RATE")}`);
});

check("on classic, a pinned roll at 0.4 (≥ 0.25) releases no capsule — the legacy threshold is untouched", () => {
  const g = boot(960, 600);
  g.els["btn-start"].click();
  const idx = firstAliveBrick(g);
  g.q("random = () => 0.4;");
  g.q(`destroyBrick(${idx})`);
  assert(g.q("capsules.filter(function (c) { return c.active; }).length") === 0,
    `a roll of 0.4 (>= ${g.q("POWERUP_DROP_RATE")}) must not drop on classic`);
});

// ================================================================
// Snapshot semantics: mid-run clicks apply to the NEXT run only
// ================================================================
check("a mid-run click to exciting leaves the live classic run's dropRate untouched, and the next run adopts it", () => {
  const g = boot(960, 600);
  g.els["btn-start"].click();
  assert(g.q("dropRate") === g.q("POWERUP_DROP_RATE"),
    `the live run starts at the classic rate, got ${g.q("dropRate")}`);
  opts(g).exciting.click();
  assert(g.q("selectedMode") === "exciting",
    `the mid-run click must reselect the choice, got ${g.q("selectedMode")}`);
  assert(g.q("dropRate") === g.q("POWERUP_DROP_RATE"),
    `the LIVE run's snapshot must not change mid-run, got ${g.q("dropRate")}`);
  g.q("quitToMenu()");
  g.els["btn-start"].click();
  assert(g.q("runMode") === "exciting",
    `the next run must adopt exciting, runMode is ${g.q("runMode")}`);
  assert(g.q("dropRate") === g.q("POWERUP_DROP_RATE") * g.q("EXCITING_DROP_FACTOR"),
    `the next run must roll at the factored rate, got ${g.q("dropRate")}`);
});

// ---------- brick helpers (drive the game's own destroyBrick) ----------
// Indices of the first n alive bricks in pool order (the test never
// destroys more than a handful, so no level ever clears mid-check).
function aliveBricks(g, n) {
  return g.q(`(() => {
    const out = [];
    for (var i = 0; i < bricks.length && out.length < ${n}; i += 1) {
      if (bricks[i].active) out.push(i);
    }
    return out;
  })()`);
}
function firstAliveBrick(g) {
  const a = aliveBricks(g, 1);
  assert(a.length === 1, `setup: the level needs at least one alive brick, found ${a.length}`);
  return a[0];
}
function firstAliveBrickExcluding(g, used) {
  const lit = used.join(", ");
  const a = g.q(`(() => {
    const used = [${lit}];
    for (var i = 0; i < bricks.length; i += 1) {
      if (bricks[i].active && used.indexOf(i) < 0) return i;
    }
    return -1;
  })()`);
  assert(a >= 0, `setup: the level needs a sixth alive brick outside ${used}, got ${a}`);
  return a;
}

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
