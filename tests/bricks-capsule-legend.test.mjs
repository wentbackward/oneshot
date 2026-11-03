#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html start-screen capsule legend (ticket #99)
//
// Same harness style as the sibling bricks-* suites: runs the REAL
// <script> from bricks.html in a sandboxed vm context with stubbed
// window/document/localStorage/requestAnimationFrame and DOM element
// stubs that record styles and children. The legend must be a static,
// deterministic listing: one row per capsule kind, all eight kinds
// regardless of the selected mode, each row's label/blurb taken from
// CAPSULE_LEGEND and its swatch coloured with the kind's in-game
// capsule colour.
//
// No network, no external services, no randomness (the legend is
// static per kind set).
//
// Run: node tests/bricks-capsule-legend.test.mjs
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
const startSectionMatch = html.match(
  /<section class="screen" id="screen-start">[\s\S]*?<\/section>/
);
if (!startSectionMatch) throw new Error("no #screen-start section found in bricks.html");
const startSection = startSectionMatch[0];

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
// child nodes (the legend renderer appends rows/swatches here).
function makeEl(id) {
  const styleTarget = {};
  const el = {
    id,
    style: new Proxy(styleTarget, {
      get(_t, prop) {
        return _t[prop];
      },
      set(_t, prop, value) {
        _t[prop] = value;
        el.styleWrites.push([prop, value]);
        return true;
      },
    }),
    styleWrites: [],
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
  };
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
function boot(width, height) {
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
    "screen-pause": makeEl("screen-pause"),
    "screen-gameover": makeEl("screen-gameover"),
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
    "btn-mute": makeEl("btn-mute"),
    "sound-volume": makeEl("sound-volume"),
    "ball-speed": makeEl("ball-speed"),
    "ball-speed-label": makeEl("ball-speed-label"),
    "ball-speed-value": makeEl("ball-speed-value"),
    "btn-resume": makeEl("btn-resume"),
    "btn-restart": makeEl("btn-restart"),
    "btn-menu": makeEl("btn-menu"),
    "gameover-final": makeEl("gameover-final"),
    "hud-score": makeEl("hud-score"),
    "hud-level": makeEl("hud-level"),
    "hiscore": makeEl("hiscore"),
    "lives": makeEl("lives"),
    "btn-reset-hiscore": makeEl("btn-reset-hiscore"),
    "btn-fullscreen": makeEl("btn-fullscreen"),
    "btn-fullscreen": makeEl("btn-fullscreen"),
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
      addEventListener: () => {}, // ticket #113: fullscreenchange registers on document at boot
      addEventListener: () => {}, // ticket #113: fullscreenchange registers on document at boot
    },
    requestAnimationFrame: (cb) => {
      rafCb = cb;
      return ++rafId;
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);

  const q = (expr) => vm.runInContext(expr, context);
  return { canvas, els, q };
}

// ================================================================
// Criterion 1: the start screen ships the legend container
// #capsule-legend, below the existing controls/leaderboard area
// ================================================================
check("the #screen-start markup contains the #capsule-legend container", () => {
  assert(
    /id="capsule-legend"/.test(startSection),
    "the #screen-start section must contain an element with id=\"capsule-legend\""
  );
});

check("the legend container sits BELOW the leaderboard/controls area in the start markup", () => {
  const legendPos = startSection.search(/id="capsule-legend"/);
  const leaderboardPos = startSection.search(/id="leaderboard-start"/);
  assert(leaderboardPos >= 0, "precondition: the start section has the leaderboard area");
  assert(legendPos > leaderboardPos,
    `the legend must come after the leaderboard area (legend at ${legendPos}, leaderboard at ${leaderboardPos})`);
});

check("booting the game finds the legend container by id", () => {
  const g = boot(960, 600);
  assert(g.els["capsule-legend"] !== null,
    "the harness must stub #capsule-legend (standing harness diamond)");
  assert(g.q("typeof capsuleLegendEl !== 'undefined' && capsuleLegendEl !== null"),
    "the game must resolve the #capsule-legend container at boot");
});

// ================================================================
// Criterion 2: the CAPSULE_LEGEND data table covers ALL eight kinds
// (both classic and exciting-only), one entry per kind, in kind order
// ================================================================
check("CAPSULE_LEGEND exists and has exactly one entry per kind (8)", () => {
  const g = boot(960, 600);
  assert(g.q("typeof CAPSULE_LEGEND !== 'undefined'"),
    "the game must define a CAPSULE_LEGEND data table");
  const len = g.q("CAPSULE_LEGEND.length");
  assert(len === 8, `the legend table must cover all 8 kinds, has ${len} entries`);
});

check("CAPSULE_LEGEND kinds are exactly 0..7 in order (no dupes, none missing)", () => {
  const g = boot(960, 600);
  assert(g.q("typeof CAPSULE_LEGEND !== 'undefined'"),
    "precondition: CAPSULE_LEGEND is defined");
  const kinds = g.q("JSON.stringify(CAPSULE_LEGEND.map(function (e) { return e.kind; }))");
  assert(kinds === "[0,1,2,3,4,5,6,7]",
    `the table must enumerate every kind exactly once in order, got ${kinds}`);
});

check("CAPSULE_LEGEND labels are all distinct", () => {
  const g = boot(960, 600);
  assert(g.q("typeof CAPSULE_LEGEND !== 'undefined'"),
    "precondition: CAPSULE_LEGEND is defined");
  const unique = g.q(
    "new Set(CAPSULE_LEGEND.map(function (e) { return e.label; })).size"
  );
  assert(unique === 8, `every label must be unique, got ${unique} distinct of 8`);
});

check("CAPSULE_LEGEND swatch colours reuse the per-kind in-game capsule colours", () => {
  const g = boot(960, 600);
  assert(g.q("typeof CAPSULE_LEGEND !== 'undefined'"),
    "precondition: CAPSULE_LEGEND is defined");
  const mismatched = g.q(
    "CAPSULE_LEGEND.filter(function (e) { return e.color !== CAPSULE_DRAW_COLORS[e.kind]; }).length"
  );
  assert(mismatched === 0,
    `every legend colour must equal the kind's draw colour, ${mismatched} mismatched`);
});

// ================================================================
// Criterion 3: the rendered legend has one row per kind (8 rows),
// and each row's label text and blurb match its CAPSULE_LEGEND entry
// ================================================================
check("the rendered legend holds exactly one row per kind (8 rows)", () => {
  const g = boot(960, 600);
  const rows = g.els["capsule-legend"].children;
  assert(rows.length === 8,
    `the legend container must hold 8 rows, holds ${rows.length}`);
});

check("each row renders label, blurb and a swatch matching CAPSULE_LEGEND[i]", () => {
  const g = boot(960, 600);
  assert(g.q("typeof CAPSULE_LEGEND !== 'undefined'"),
    "precondition: CAPSULE_LEGEND is defined");
  const rows = g.els["capsule-legend"].children;
  for (let i = 0; i < 8; i += 1) {
    const row = rows[i];
    assert(row !== undefined, `missing row ${i}`);
    assert(row.children.length >= 3,
      `row ${i} must carry a swatch, a label and a blurb node, has ${row.children.length}`);
    const swatchBg = row.children[0].style.background ?? row.children[0].style.backgroundColor;
    const label = g.q(`CAPSULE_LEGEND[${i}].label`);
    const blurb = g.q(`CAPSULE_LEGEND[${i}].blurb`);
    const color = g.q(`CAPSULE_LEGEND[${i}].color`);
    assert(swatchBg === color,
      `row ${i} (${label}) swatch must be the kind's colour ${color}, got ${JSON.stringify(swatchBg)}`);
    assert(row.children[1].textContent === label,
      `row ${i} label must read ${JSON.stringify(label)}, got ${JSON.stringify(row.children[1].textContent)}`);
    assert(row.children[2].textContent === blurb,
      `row ${i} blurb must read ${JSON.stringify(blurb)}, got ${JSON.stringify(row.children[2].textContent)}`);
  }
});

check("two boots render bit-identical legends (static, no randomness)", () => {
  const a = boot(960, 600);
  const b = boot(960, 600);
  const dump = (g) =>
    JSON.stringify(
      g.els["capsule-legend"].children.map((row) =>
        row.children.map((child) => child.textContent)
      )
    );
  assert(dump(a) === dump(b) && dump(a) !== "[]",
    `legend renders must be identical between boots, got ${dump(a)} vs ${dump(b)}`);
});

// ================================================================
// Criterion 4: the legend lists all 8 kinds regardless of mode —
// selecting Classic/Exciting/Alleyway on the start screen must not
// filter, reorder or rebuild the legend
// ================================================================
check("selecting Exciting or Alleyway leaves all 8 legend rows untouched", () => {
  const g = boot(960, 600);
  const legend = g.els["capsule-legend"];
  const before = JSON.stringify(
    legend.children.map((row) =>
      row.children.map((child) => child.textContent)
    )
  );
  g.els["mode-exciting"].click();
  g.els["mode-alleyway"].click();
  g.els["mode-classic"].click();
  const after = JSON.stringify(
    legend.children.map((row) =>
      row.children.map((child) => child.textContent)
    )
  );
  assert(legend.children.length === 8,
    `the legend must still hold all 8 rows after mode switches, has ${legend.children.length}`);
  assert(after === before,
    `mode selection must not alter the legend, before=${before} after=${after}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
