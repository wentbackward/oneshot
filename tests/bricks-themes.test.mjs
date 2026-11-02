#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html selectable retro theme variants
// (ticket #46: classic / neon / minimal, chosen on the start
// screen and persisted under brickbreaker.theme)
//
// Same harness style as the sibling bricks-*.test.mjs suites: the
// REAL <script> from bricks.html runs in a sandboxed vm context
// with stubbed window/document/localStorage/requestAnimationFrame
// and DOM element stubs. Two additions for this ticket: the
// document stub carries a documentElement with a RECORDING
// setProperty (so CSS custom-property writes are assertable), and
// the three start-screen theme option buttons are stubbed. The
// storage stub is recording too, so a "reload" can re-boot onto
// the same backing store. `random` is pinned at boot like every
// sibling suite, so the theme-invariance smoke run is fully
// deterministic. No network, no external services.
//
// Run: node tests/bricks-themes.test.mjs
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
// compares the game's THEME_KEY against this literal, so a rename
// in the game would fail both sides consistently.
const KEY = "brickbreaker.theme";
const NAMES = ["classic", "neon", "minimal"];
const HEX = /^#[0-9a-f]{6}$/i;

// Local copy of the game's damage-dimming rule (BRICK_DARK_FACTOR),
// used to recompute the expected tier `dark` values after an apply.
function darkenHex(hex, factor) {
  let out = "#";
  for (let i = 1; i < hex.length; i += 2) {
    out += Math.round(parseInt(hex.slice(i, i + 2), 16) * factor)
      .toString(16).padStart(2, "0");
  }
  return out;
}

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
    "btn-mute": makeEl("btn-mute"),
    "sound-volume": makeEl("sound-volume"),
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
  // Recording documentElement: setProperty calls land in `props` in
  // call order, so a selection change is assertable as an exact
  // ordered triple.
  const rootStyle = {
    props: [],
    setProperty(name, value) {
      this.props.push([String(name), String(value)]);
    },
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
      documentElement: { style: rootStyle },
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
    rootStyle,
  };
}

// The three theme option button stubs for a booted game, keyed by
// theme name.
const opts = (g) => ({
  classic: g.els["theme-classic"],
  neon: g.els["theme-neon"],
  minimal: g.els["theme-minimal"],
});
const isMarked = (el) => el.className.includes("selected");

// The raw #screen-start section source, for the static-HTML checks.
const startSection = (() => {
  const m = html.match(/<section class="screen" id="screen-start">([\s\S]*?)<\/section>/);
  if (!m) throw new Error("#screen-start section not found in bricks.html");
  return m[1];
})();

// ================================================================
// Criterion 1 (static/vm): THEMES has exactly the keys classic,
// neon, minimal, each defining the CSS triple and the canvas
// palette
// ================================================================
check("THEMES is a table with exactly the keys classic, neon and minimal", () => {
  const g = boot(960, 600);
  const table = g.q("typeof THEMES === 'undefined' ? null : THEMES");
  assert(table && typeof table === "object", "THEMES must be a module-level table");
  const keys = Object.keys(table).sort();
  assert(JSON.stringify(keys) === JSON.stringify(["classic", "minimal", "neon"]),
    `THEMES must have exactly the keys classic/neon/minimal, got ${JSON.stringify(keys)}`);
});

check("every THEMES row defines the CSS triple and the full canvas palette", () => {
  const g = boot(960, 600);
  const table = g.q("THEMES");
  for (const name of NAMES) {
    const row = table[name];
    assert(row && typeof row === "object", `THEMES.${name} must exist`);
    for (const prop of ["bg", "accent", "ink"]) {
      assert(HEX.test(row.css?.[prop] ?? ""),
        `THEMES.${name}.css.${prop} must be a #rrggbb hex, got ${JSON.stringify(row.css?.[prop])}`);
    }
    for (const prop of ["bg", "paddle", "ball"]) {
      assert(HEX.test(row.palette?.[prop] ?? ""),
        `THEMES.${name}.palette.${prop} must be a #rrggbb hex, got ${JSON.stringify(row.palette?.[prop])}`);
    }
    const bricks = row.palette?.bricks;
    assert(Array.isArray(bricks) && bricks.length === 4,
      `THEMES.${name}.palette.bricks must hold the four tier colours, got ${JSON.stringify(bricks)}`);
    bricks.forEach((c, i) => assert(HEX.test(c),
      `THEMES.${name}.palette.bricks[${i}] must be a #rrggbb hex, got ${JSON.stringify(c)}`));
  }
});

check("the classic row is the legacy look (matches the module-load palette constants)", () => {
  const g = boot(960, 600);
  const row = g.q("THEMES.classic");
  assert(row.css.bg === g.q("COLOR_BG"),
    `classic css bg must be the legacy COLOR_BG, got ${row.css.bg}`);
  assert(row.css.accent === g.q("COLOR_PADDLE"),
    `classic css accent must be the legacy accent #5cf2b0 (COLOR_PADDLE), got ${row.css.accent}`);
  assert(row.css.ink === "#9fb4c7",
    `classic css ink must be the legacy :root --ink #9fb4c7, got ${row.css.ink}`);
  assert(row.palette.bg === g.q("COLOR_BG") &&
         row.palette.paddle === g.q("COLOR_PADDLE") &&
         row.palette.ball === g.q("COLOR_BALL"),
    `classic palette mirrors must be the legacy constants, got ${JSON.stringify(row.palette)}`);
  const expect = [g.q("COLOR_BRICK_A"), g.q("COLOR_BRICK_B"), g.q("COLOR_BRICK_C"), g.q("COLOR_BRICK_FIXED")];
  assert(JSON.stringify(row.palette.bricks) === JSON.stringify(expect),
    `classic palette.bricks must be the legacy tier colours in A/B/C/fixed order, got ${JSON.stringify(row.palette.bricks)}`);
});

// ================================================================
// Criterion 2 (static HTML): three data-theme selectors on the
// start screen, classic selected by default
// ================================================================
check("the start screen contains exactly three nodes with data-theme, values classic|neon|minimal (one each)", () => {
  const values = [...startSection.matchAll(/data-theme="([^"]*)"/g)].map((m) => m[1]);
  assert(values.length === 3,
    `#screen-start must hold exactly 3 data-theme nodes, found ${values.length}: ${JSON.stringify(values)}`);
  assert(JSON.stringify([...values].sort()) === JSON.stringify(["classic", "minimal", "neon"]),
    `the three values must be classic, neon, minimal (once each), got ${JSON.stringify(values)}`);
});

check("the static default-selection mark sits on the classic node only", () => {
  const tags = [...startSection.matchAll(/<button\b[^>]*data-theme="([^"]*)"[^>]*>/g)];
  assert(tags.length === 3, `expected 3 theme option buttons, found ${tags.length}`);
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

// ================================================================
// Boot application: the default (classic) skin is applied to BOTH
// the document root's custom properties and the canvas palette
// mirrors before the first frame
// ================================================================
check("a fresh boot (no stored value) selects classic and records the classic CSS triple on the document root", () => {
  const g = boot(960, 600);
  assert(g.q("typeof selectedTheme === 'undefined' ? null : selectedTheme") === "classic",
    `no stored value must mean the classic theme, got ${g.q("selectedTheme")}`);
  const o = opts(g);
  assert(isMarked(o.classic) && !isMarked(o.neon) && !isMarked(o.minimal),
    `only the classic button may be marked, neon=${o.neon.className} minimal=${o.minimal.className}`);
  const row = g.q("THEMES.classic");
  const expect = [["--bg", row.css.bg], ["--accent", row.css.accent], ["--ink", row.css.ink]];
  assert(JSON.stringify(g.rootStyle.props) === JSON.stringify(expect),
    `boot must write the classic CSS triple to the document root, got ${JSON.stringify(g.rootStyle.props)}`);
});

// ================================================================
// Criterion 2 (vm): a selection change updates the CSS custom
// properties AND the canvas palette vars in one pass
// ================================================================
check("clicking neon applies the neon CSS triple (exact recorded setProperty calls) and the neon canvas palette in one pass", () => {
  const g = boot(960, 600);
  const before = g.rootStyle.props.length;
  opts(g).neon.click();
  const row = g.q("THEMES.neon");
  const written = g.rootStyle.props.slice(before);
  const expect = [["--bg", row.css.bg], ["--accent", row.css.accent], ["--ink", row.css.ink]];
  assert(JSON.stringify(written) === JSON.stringify(expect),
    `the click must write exactly the neon CSS triple in order, got ${JSON.stringify(written)}`);
  // Canvas palette mirrors, read straight from the running context —
  // the draw pass keeps reading these same vars, so no re-boot is
  // involved: this is the "one pass" the criterion locks in.
  assert(g.q("COLOR_BG") === row.palette.bg,
    `COLOR_BG must be the neon bg ${row.palette.bg}, got ${g.q("COLOR_BG")}`);
  assert(g.q("COLOR_PADDLE") === row.palette.paddle,
    `COLOR_PADDLE must be the neon paddle ${row.palette.paddle}, got ${g.q("COLOR_PADDLE")}`);
  assert(g.q("COLOR_BALL") === row.palette.ball,
    `COLOR_BALL must be the neon ball ${row.palette.ball}, got ${g.q("COLOR_BALL")}`);
  const tiers = g.q("BRICK_TIERS");
  row.palette.bricks.forEach((color, i) => {
    assert(tiers[i].color === color,
      `BRICK_TIERS[${i}].color must be the neon tier colour ${color}, got ${tiers[i].color}`);
    assert(tiers[i].dark === darkenHex(color, g.q("BRICK_DARK_FACTOR")),
      `BRICK_TIERS[${i}].dark must be the dimmed neon colour, got ${tiers[i].dark}`);
  });
  const o = opts(g);
  assert(isMarked(o.neon) && !isMarked(o.classic) && !isMarked(o.minimal),
    `only the neon button may be marked after the click, classic=${o.classic.className} minimal=${o.minimal.className}`);
});

check("clicking minimal afterwards replaces the palette: the old (neon) values are gone from the mirrors", () => {
  const g = boot(960, 600);
  opts(g).neon.click();
  opts(g).minimal.click();
  const row = g.q("THEMES.minimal");
  const o = opts(g);
  assert(isMarked(o.minimal) && !isMarked(o.neon) && !isMarked(o.classic),
    `only the minimal button may be marked, neon=${o.neon.className} classic=${o.classic.className}`);
  assert(g.q("COLOR_BG") === row.palette.bg &&
         g.q("COLOR_PADDLE") === row.palette.paddle &&
         g.q("COLOR_BALL") === row.palette.ball,
    `the canvas mirrors must hold the minimal palette, got bg=${g.q("COLOR_BG")} paddle=${g.q("COLOR_PADDLE")}`);
  assert(JSON.stringify(g.q("BRICK_TIERS.map(function (t) { return t.color; })")) ===
         JSON.stringify(row.palette.bricks),
    `the brick tier colours must be the minimal row, got ${JSON.stringify(g.q("BRICK_TIERS.map(function (t) { return t.color; })"))}`);
  const lastThree = g.rootStyle.props.slice(-3);
  assert(JSON.stringify(lastThree) ===
         JSON.stringify([["--bg", row.css.bg], ["--accent", row.css.accent], ["--ink", row.css.ink]]),
    `the last recorded triple must be the minimal CSS values, got ${JSON.stringify(lastThree)}`);
});

// ================================================================
// Criterion 3 (persistence): choice stored as JSON under
// brickbreaker.theme; a simulated reload restores it
// ================================================================
check("clicking a theme writes the choice as JSON to brickbreaker.theme", () => {
  const g = boot(960, 600);
  opts(g).neon.click();
  assert(g.q("selectedTheme") === "neon",
    `the click must switch the theme to neon, got ${g.q("selectedTheme")}`);
  assert(g.storage.writes.length === 1,
    `exactly one setItem must fire, writes were ${JSON.stringify(g.storage.writes)}`);
  const [wKey, wValue] = g.storage.writes[0];
  assert(wKey === KEY, `the write must target ${KEY}, got ${JSON.stringify(wKey)}`);
  const parsed = JSON.parse(wValue); // throws if not valid JSON
  assert(parsed === "neon", `the written value must be the JSON string "neon", got ${JSON.stringify(wValue)}`);
});

check("re-clicking the already-selected theme changes nothing and performs no write", () => {
  const g = boot(960, 600);
  opts(g).neon.click();
  opts(g).neon.click();
  assert(g.storage.writes.length === 1,
    `re-selecting the active theme must not rewrite storage, writes were ${JSON.stringify(g.storage.writes)}`);
  assert(g.q("selectedTheme") === "neon",
    `the selection must remain neon, got ${g.q("selectedTheme")}`);
});

check("a change to a third theme overwrites the previous value with exactly one write per change", () => {
  const g = boot(960, 600);
  opts(g).neon.click();
  opts(g).minimal.click();
  assert(g.storage.writes.length === 2,
    `two changes must produce exactly two writes, got ${g.storage.writes.length}: ${JSON.stringify(g.storage.writes)}`);
  assert(JSON.stringify(g.storage.writes) === JSON.stringify([[KEY, '"neon"'], [KEY, '"minimal"']]),
    `the writes must be the new choice in order, got ${JSON.stringify(g.storage.writes)}`);
});

check("a seeded 'neon' selection is restored at boot: the neon accent lands on BOTH --accent (recorded write) and COLOR_PADDLE (global read)", () => {
  const g = boot(960, 600, { [KEY]: '"neon"' });
  assert(g.q("selectedTheme") === "neon",
    `the stored neon choice must load at boot, got ${g.q("selectedTheme")}`);
  const row = g.q("THEMES.neon");
  const writtenAccent = g.rootStyle.props.find(([n]) => n === "--accent");
  assert(writtenAccent && writtenAccent[1] === row.css.accent,
    `boot must have written --accent = ${row.css.accent} to the document root, got ${JSON.stringify(g.rootStyle.props)}`);
  assert(g.q("COLOR_PADDLE") === row.palette.paddle,
    `COLOR_PADDLE must be the neon paddle ${row.palette.paddle}, got ${g.q("COLOR_PADDLE")}`);
  const o = opts(g);
  assert(isMarked(o.neon) && !isMarked(o.classic) && !isMarked(o.minimal),
    `only the neon button may be marked, classic=${o.classic.className} minimal=${o.minimal.className}`);
});

check("after a simulated reload (fresh vm sandbox, same backing store) the chosen theme is re-selected, re-marked and re-applied", () => {
  const before = boot(960, 600);
  opts(before).minimal.click();
  assert(before.store[KEY] === '"minimal"',
    `the first session must persist "minimal", got ${JSON.stringify(before.store[KEY])}`);

  // The "refresh": a brand-new sandbox booted onto the SAME backing
  // store the first session wrote into.
  const after = boot(960, 600, before.store);
  assert(after !== before, "the reload must be a distinct vm sandbox");
  assert(after.q("selectedTheme") === "minimal",
    `the reloaded session must restore minimal, got ${after.q("selectedTheme")}`);
  const o = opts(after);
  assert(isMarked(o.minimal) && !isMarked(o.classic) && !isMarked(o.neon),
    `the reload must re-mark only the minimal button, classic=${o.classic.className} neon=${o.neon.className}`);
  assert(after.q("COLOR_BG") === after.q("THEMES.minimal.palette.bg"),
    `the reload must re-apply the minimal canvas palette, got ${after.q("COLOR_BG")}`);
});

// ================================================================
// Boot-time selection edge cases: fallbacks, named key constant
// ================================================================
check("a stored value from another build ('banana') falls back to classic at boot", () => {
  const g = boot(960, 600, { [KEY]: '"banana"' });
  assert(g.q("selectedTheme") === "classic",
    `an unknown theme name must fall back to classic, got ${g.q("selectedTheme")}`);
});

check("corrupt stored JSON falls back to classic without breaking boot", () => {
  const g = boot(960, 600, { [KEY]: "{not json" });
  assert(g.state() === "start", `boot must survive corrupt storage, state is ${g.state()}`);
  assert(g.q("selectedTheme") === "classic",
    `corrupt JSON must fall back to classic, got ${g.q("selectedTheme")}`);
});

check("a stored non-string ('123') falls back to classic at boot", () => {
  const g = boot(960, 600, { [KEY]: "123" });
  assert(g.q("selectedTheme") === "classic",
    `a non-string stored value must fall back to classic, got ${g.q("selectedTheme")}`);
});

check("the selection loads via the named key constant (THEME_KEY) at boot", () => {
  const g = boot(960, 600, { [KEY]: '"neon"' });
  const key = g.q("typeof THEME_KEY === 'undefined' ? null : THEME_KEY");
  assert(typeof key === "string" && key.length > 0,
    `THEME_KEY must be a non-empty string constant, got ${JSON.stringify(key)}`);
  assert(key === KEY, `the game's key drifted from the documented key, got ${JSON.stringify(key)}`);
  assert(g.storage.reads.includes(KEY),
    `boot must read ${KEY} from localStorage, reads were ${JSON.stringify(g.storage.reads)}`);
});

// ================================================================
// Criterion 4 (theme invariance): a pinned-random smoke run
// produces identical score/level/lives sequences under each of the
// three themes. The run is scripted (clear level 1, then drop the
// serve ball three times for game over) so it is fully
// deterministic; `random` stays pinned so no capsule can ever
// alter the score.
// ================================================================
function smokeRun(theme) {
  const g = boot(960, 600, { [KEY]: JSON.stringify(theme) });
  g.els["btn-start"].click();
  assert(g.state() === "playing",
    `${theme}: the start button must begin the run, state is ${g.state()}`);
  // Level 1's pattern is the solid 50-brick wall: kill every brick
  // in pool order — the last one advances the run to level 2.
  for (let i = 0; i < 50; i += 1) g.q(`destroyBrick(${i})`);
  assert(g.q("level") === 2, `${theme}: clearing level 1 must raise the level to 2, got ${g.q("level")}`);
  g.tick(3); // a few live frames: physics under the (per-theme) palette
  // Drop the serve ball below the field three times → three lost
  // lives → game over. Detaching first: an attached ball is
  // re-parked onto the paddle every frame.
  for (let n = 0; n < 3; n += 1) {
    g.q("balls[0].attached = false; balls[0].vx = 0; balls[0].vy = 0; balls[0].y = canvas.height + 100;");
    g.tick(1);
  }
  assert(g.state() === "gameover",
    `${theme}: three drops must end in game over, state is ${g.state()}`);
  return [
    g.els["hud-score"].textContent,
    g.els["hud-level"].textContent,
    g.els["gameover-final"].textContent,
  ];
}

check("the pinned-random smoke run yields identical HUD score/level/final text under classic, neon and minimal", () => {
  const runs = {};
  for (const theme of NAMES) runs[theme] = smokeRun(theme);
  for (const theme of NAMES.slice(1)) {
    assert(JSON.stringify(runs[theme]) === JSON.stringify(runs.classic),
      `${theme} diverges from classic: ${JSON.stringify(runs[theme])} vs ${JSON.stringify(runs.classic)}`);
  }
});

check("the smoke run actually played: level-1 clearance scores 1100 and the final screen reports it", () => {
  const [score, level, final] = smokeRun("classic");
  // Rows A(30) B(20) C(10) A(30) B(20), ten bricks each = 1100.
  assert(score === "1100", `level-1 clearance must score 1100, got ${score}`);
  assert(level === "2", `the run must end on level 2, got ${level}`);
  assert(final === "Final score 1100", `the final screen must report 1100, got ${final}`);
});

// ================================================================
// Self-containment
// ================================================================
check("the file gains no external references", () => {
  const ext = (html.match(/(src|href)=/g) ?? []).length;
  assert(ext === 0, `bricks.html must stay self-contained (0 src/href), found ${ext}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
