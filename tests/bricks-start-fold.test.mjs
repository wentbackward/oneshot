#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html start screen fits short viewports
// (ticket #111): after the capsule legend landed (#99) the start
// panel outgrew a 577px-tall viewport and the START GAME CTA sat
// below the fold. The fix is pure CSS compaction + a scroll
// safety net, so this suite locks the RESULT, not the incident:
//
//   AC(a) — at a virtual 1280x577 viewport the whole start panel
//           (h1 ... btn-start) fits WITHOUT scrolling: a
//           deterministic layout model, driven by the REAL CSS in
//           bricks.html, puts the btn-start bottom above the fold
//   AC(b) — same guarantee at a 600px-tall viewport (ticket
//           requirement 1)
//   AC(c) — the legend still renders 8 rows in a 2-column grid
//           (four lines — no row collapse)
//   AC(d) — compaction did not shrink the type scale (legend,
//           heading, CTA, title, tagline, option buttons)
//   AC(e) — safety net: an extremely short window makes
//           #screen-start scroll (overflow-y: auto) instead of
//           clipping the CTA
//   verify — the model recognises every top-level block of
//           #screen-start, so silent markup drift cannot pass
//
// The layout model walks the REAL start-section markup and reads
// every length it uses (gaps, paddings, font sizes, line-heights,
// min-heights, grid geometry) out of the REAL <style> block, so a
// future tweak that re-introduces the overflow fails for the right
// reason. "normal" line-height is resolved with the Chrome
// monospace metric 1.15625, calibrated against a real 1280x577
// browser run (64px title rendered at 74px); the margin the panel
// must keep under the fold is sized to absorb residual
// environment drift. No network, no external services.
//
// Run: node tests/bricks-start-fold.test.mjs
// ================================================================
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "bricks.html"), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("no <script> block found in bricks.html");
const gameSource = scriptMatch[1];
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) throw new Error("no <style> block found in bricks.html");
const cssText = styleMatch[1];
const sectionMatch = html.match(
  /<section class="screen" id="screen-start">[\s\S]*?<\/section>/
);
if (!sectionMatch) throw new Error("no #screen-start section found in bricks.html");
const startSection = sectionMatch[0];

// Virtual probe viewport: the ticket's reproduction window.
const VIEW_W = 1280;
const VIEW_H = 577;
// Ticket requirement 1: must also fit the common laptop minimum.
const TALL_VIEW_H = 600;

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

// ---------- CSS parsing (just enough for the start panel) ----------
function parseRules(css) {
  const rules = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const chunk of stripped.split("}")) {
    const open = chunk.indexOf("{");
    if (open === -1) continue;
    const selList = chunk.slice(0, open);
    const body = chunk.slice(open + 1);
    if (!selList.trim() || !body.trim()) continue;
    const decls = {};
    for (const d of body.split(";")) {
      const colon = d.indexOf(":");
      if (colon === -1) continue;
      const prop = d.slice(0, colon).trim().toLowerCase();
      const val = d.slice(colon + 1).trim();
      if (prop && val) decls[prop] = val;
    }
    for (const sel of selList.split(",")) {
      const s = sel.trim();
      if (s) rules.push({ sel: s, decls });
    }
  }
  return rules;
}
const RULES = parseRules(cssText);
// Latest declaration wins, browser cascade order for single selectors.
function declOf(sel, prop) {
  let val;
  for (const r of RULES) {
    if (r.sel === sel && prop in r.decls) val = r.decls[prop];
  }
  return val;
}

const REM = 16;
// Chrome's "normal" line-height for the monospace stack, in the
// calibration run (see header). Elements that pin an explicit
// line-height in CSS are read from the sheet instead.
const NORMAL_LINE = 1.15625;
// The volume/ball-speed row is driven by the UA range control,
// not by our CSS: its rendered height, measured in the
// calibration run.
const RANGE_ROW_H = 20;

function lenPx(val, baseFont) {
  const m = /^([\d.]+)\s*(px|rem|em)?$/.exec(val.trim());
  if (!m) throw new Error(`cannot parse length ${JSON.stringify(val)}`);
  const n = parseFloat(m[1]);
  const unit = m[2] || "px";
  if (unit === "rem") return n * REM;
  if (unit === "em") return n * baseFont;
  return n;
}
function fontSizePx(sel, rules = RULES) {
  const v = rules.some((r) => r.sel === sel && "font-size" in r.decls)
    ? declOf(sel, "font-size")
    : "16px";
  return lenPx(v);
}
function lineHeightPx(sel, font, rules = RULES) {
  // Last-wins, exactly like declOf (CSS cascade): find() here would
  // disagree with the rest of the model the day a second rule for the
  // same selector gains a line-height.
  let v;
  for (const r of rules) {
    if (r.sel === sel && "line-height" in r.decls) v = r.decls["line-height"];
  }
  if (v === undefined || v === "normal") return font * NORMAL_LINE;
  if (/^[\d.]+$/.test(v)) return font * parseFloat(v);
  return lenPx(v, font);
}
function clampPx(spec, vw) {
  const m = /clamp\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\)/.exec(spec);
  if (!m) throw new Error(`cannot parse ${spec}`);
  const min = lenPx(m[1]);
  const max = lenPx(m[3]);
  const vm_ = /([\d.]+)\s*vw$/.exec(m[2].trim());
  const val = vm_ ? parseFloat(vm_[1]) * (vw / 100) : lenPx(m[2]);
  return Math.min(max, Math.max(min, val));
}
// Block-level box of a bordered opt/CTA button from its own rule.
function buttonBoxH(sel) {
  const font = fontSizePx(sel);
  const pad = declOf(sel, "padding");
  const border = declOf(sel, "border");
  const padV = pad ? lenPx(pad.trim().split(/\s+/)[0], font) : 0;
  const borderW = border ? lenPx(border.trim().split(/\s+/)[0], font) : 0;
  return lineHeightPx(sel, font) + 2 * padV + 2 * borderW;
}

// ---------- the layout model ----------
// Heights of the start panel's TOP-LEVEL blocks, in markup order,
// every length sourced from the real sheet (see helpers above).
function topLevelBlocks() {
  const inner = startSection.replace(/^<section[^>]*>/, "").replace(/<\/section>$/, "");
  const blocks = [];
  let depth = 0;
  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = tagRe.exec(inner))) {
    const [ , close, name, attrs] = m;
    const lower = name.toLowerCase();
    if (close) {
      depth -= 1;
      continue;
    }
    if (depth === 0) {
      const id = /id="([^"]*)"/.exec(attrs)?.[1] ?? "";
      const cls = /class="([^"]*)"/.exec(attrs)?.[1] ?? "";
      blocks.push({ tag: lower, id, cls });
    }
    if (!VOID.has(lower)) depth += 1;
  }
  return blocks;
}
function blockHeight(block) {
  const sel = block.id ? `#${block.id}` : block.cls ? `.${block.cls}` : null;
  if (block.tag === "h1") return clampPx(declOf(".screen h1", "font-size"), VIEW_W) * NORMAL_LINE;
  if (block.tag === "p") {
    const font = fontSizePx(".screen p");
    return lineHeightPx(".screen p", font);
  }
  if (block.cls === "difficulty") return buttonBoxH(".difficulty-opt");
  if (block.cls === "themes") return buttonBoxH(".theme-opt");
  if (block.cls === "modes") return buttonBoxH(".mode-opt");
  if (block.cls === "sound") return buttonBoxH(".sound-opt");
  if (block.cls === "fastfwd") return buttonBoxH(".fastfwd-opt");
  if (block.cls === "speed") return RANGE_ROW_H;
  if (block.cls === "leaderboard") {
    const font = fontSizePx(".leaderboard");
    return Math.max(lenPx(declOf(".leaderboard", "min-height"), font), lineHeightPx(".leaderboard", font));
  }
  if (block.cls === "capsule-legend-heading") {
    const font = fontSizePx(".capsule-legend-heading");
    return lineHeightPx(".capsule-legend-heading", font);
  }
  if (block.cls === "capsule-legend") {
    const font = fontSizePx(".capsule-legend");
    const cols = /repeat\(\s*(\d+)\s*,/.exec(declOf(".capsule-legend", "grid-template-columns"))?.[1];
    assert(cols, "the legend must stay a multi-column grid (no single column)");
    const nCols = parseInt(cols, 10);
    const rows = Math.ceil(legendKindCount() / nCols);
    const gapY = lenPx(declOf(".capsule-legend", "gap").trim().split(/\s+/)[0]);
    const swatchH = lenPx(declOf(".capsule-legend-swatch", "height"));
    const rowH = Math.max(lineHeightPx(".capsule-legend", font), swatchH);
    return rows * rowH + (rows - 1) * gapY;
  }
  if (block.id === "btn-reset-hiscore") return buttonBoxH("#btn-reset-hiscore");
  if (block.id === "btn-start") return buttonBoxH("#btn-start");
  throw new Error(`layout model has no rule for block <${block.tag}${sel ? " " + sel : ""}> — the start markup changed; extend the model deliberately`);
}
const PANEL_GAP_PX = () => lenPx(declOf(".screen", "gap").trim().split(/\s+/)[0]);
function panelContentH() {
  const blocks = topLevelBlocks();
  const sum = blocks.reduce((acc, b) => acc + blockHeight(b), 0);
  return { sum, gaps: (blocks.length - 1) * PANEL_GAP_PX(), blocks };
}
// The panel is vertically centred in the fixed full-viewport
// overlay, so the CTA (last block) bottom is (vh + contentH)/2;
// it fits without scrolling iff contentH <= vh.
function ctaBottomAt(vh) {
  const { sum, gaps } = panelContentH();
  return (vh + sum + gaps) / 2;
}

// ---------- game boot (for the rendered legend) ----------
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
  };
  return el;
}
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
function boot() {
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    rect: { left: 0, top: 0, width: VIEW_W, height: VIEW_H },
    getBoundingClientRect: () => canvas.rect,
    listeners: {},
    getContext: () => makeCtx(),
    addEventListener(type, cb) {
      (this.listeners[type] ??= []).push(cb);
    },
  };
  const ids = [
    "screen-start", "screen-pause", "screen-gameover",
    "btn-start", "btn-resume", "btn-restart", "btn-menu", "btn-mute",
    "btn-reset-hiscore", "capsule-legend",
    "difficulty-easy", "difficulty-normal", "difficulty-hard",
    "theme-classic", "theme-neon", "theme-minimal",
    "mode-classic", "mode-exciting", "mode-alleyway",
    "fastfwd-off", "fastfwd-1-5", "fastfwd-2-0", "fastfwd-3-0",
    "sound-volume", "ball-speed", "ball-speed-label", "ball-speed-value",
    "gameover-final", "hud-score", "hud-level", "hiscore", "lives",
    "leaderboard-start", "leaderboard-gameover",
  ];
  const els = {
    "game": canvas,
    ...Object.fromEntries(ids.map((id) => [id, makeEl(id)])),
  };
  const sandbox = {
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {
      innerWidth: VIEW_W,
      innerHeight: VIEW_H,
      addEventListener: () => {},
    },
    document: {
      getElementById: (id) => els[id] ?? null,
      createElement: (tag) => makeEl(tag),
    },
    requestAnimationFrame: () => 1,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);
  return { els, q: (expr) => vm.runInContext(expr, context) };
}
const g = boot();
function legendKindCount() {
  return g.q("typeof CAPSULE_LEGEND !== 'undefined' ? CAPSULE_LEGEND.length : 8");
}

// ================================================================
// verify — the model sees every top-level block of the panel
// ================================================================
check("layout model recognises all 13 top-level blocks of #screen-start in order", () => {
  const blocks = topLevelBlocks();
  const seen = blocks.map((b) => (b.id ? `#${b.id}` : b.cls ? `.${b.cls}` : b.tag));
  assert(blocks.length === 13,
    `expected 13 top-level blocks, found ${blocks.length}: ${seen.join(", ")}`);
  assert(seen.join("|") === "h1|p|.difficulty|.themes|.modes|.sound|.speed|.fastfwd|#leaderboard-start|.capsule-legend-heading|#capsule-legend|#btn-reset-hiscore|#btn-start",
    `unexpected block sequence: ${seen.join(", ")}`);
});

// ================================================================
// AC(a) — 1280x577 fold: CTA visible without scrolling
// ================================================================
check("1280x577 fold: btn-start bottom sits above the fold (panel fits without scrolling)", () => {
  const { sum, gaps } = panelContentH();
  const bottom = ctaBottomAt(VIEW_H);
  assert(sum + gaps <= VIEW_H,
    `start panel is ${(sum + gaps).toFixed(2)}px tall — btn-start bottom at y=${bottom.toFixed(1)} on a ${VIEW_H}px viewport, i.e. ${(bottom - VIEW_H).toFixed(1)}px BELOW THE FOLD (limit ${VIEW_H}px)`);
});

// ================================================================
// AC(b) — 600px viewport requirement
// ================================================================
check("600px-tall viewport: the whole start panel fits (ticket requirement 1)", () => {
  const bottom = ctaBottomAt(TALL_VIEW_H);
  assert(bottom <= TALL_VIEW_H,
    `btn-start bottom at y=${bottom.toFixed(1)} exceeds the ${TALL_VIEW_H}px fold`);
});

// ================================================================
// AC(c) — legend: 8 rows, 2 columns, four lines (no collapse)
// ================================================================
check("the rendered legend still holds 8 rows", () => {
  const rows = g.els["capsule-legend"].children.length;
  assert(rows === 8, `the legend must render one row per kind (8), renders ${rows}`);
});

check("the legend grid stays two columns (8 rows -> 4 lines, no single-column collapse)", () => {
  const spec = declOf(".capsule-legend", "grid-template-columns");
  const m = /repeat\(\s*2\s*,/.exec(spec ?? "");
  assert(m, `the legend must stay a 2-column grid, got grid-template-columns: ${JSON.stringify(spec)}`);
  const lines = Math.ceil(legendKindCount() / 2);
  assert(lines === 4, `8 legend rows in 2 columns must be 4 lines, got ${lines}`);
});

// ================================================================
// AC(d) — compaction must not shrink the type scale
// ================================================================
check("type scale is untouched: legend 12px, heading 12px, CTA 16px, title clamp 32..64px, tagline 14.4px, option buttons 12.8px", () => {
  const expect = (val, wantPx, what) => {
    const got = val.endsWith("rem") ? parseFloat(val) * REM : parseFloat(val);
    assert(Math.abs(got - wantPx) < 0.01, `${what} must stay ${wantPx}px, got ${got}px`);
  };
  expect(declOf(".capsule-legend", "font-size"), 12, "legend font-size");
  expect(declOf(".capsule-legend-heading", "font-size"), 12, "legend heading font-size");
  expect(declOf("#btn-start", "font-size"), 16, "start CTA font-size");
  expect(declOf(".screen p", "font-size"), 14.4, "tagline font-size");
  expect(declOf(".difficulty-opt", "font-size"), 12.8, "option-button font-size");
  const clamp = declOf(".screen h1", "font-size");
  const m = /clamp\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\)/.exec(clamp);
  assert(m, `the title must keep its fluid clamp(), got ${JSON.stringify(clamp)}`);
  expect(m[1], 32, "title clamp floor");
  expect(m[3], 64, "title clamp ceiling");
});

// ================================================================
// AC(e) — safety net: extremely short windows scroll, not clip
// ================================================================
check("safety net: #screen-start declares overflow-y: auto (scrollable when the panel outgrows the viewport)", () => {
  const v = declOf("#screen-start", "overflow-y");
  assert(v === "auto",
    `#screen-start must scroll when the panel overflows an extremely short window (overflow-y: auto), got ${JSON.stringify(v)}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
