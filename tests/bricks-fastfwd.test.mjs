#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html right-mouse fast-forward (ticket #102)
//
// Hold RIGHT MOUSE over the game to warp the simulation by the
// start-screen multiplier (OFF / 1.5x / 2.0x / 3.0x, default 2.0x,
// persisted). A single timeScale multiplies the CLAMPED real frame
// dt into the simulation dt in the frame loop; every gameplay
// system consumes that simDt, and the render still runs once per
// real frame.
//
// Same harness style as the sibling bricks-*.test.mjs suites: the
// REAL <script> from bricks.html runs in a sandboxed vm context
// with stubbed window/document/localStorage/requestAnimationFrame
// and DOM element stubs. This suite additionally needs (a) a
// recorder on the 2d context so the render-frequency assertion can
// count fillRect calls, and (b) a window-event dispatcher so the
// tests can drive mousedown/mouseup/blur/cancel with e.button.
// The harness also sets rmbHeld / fastFwdMult directly, per the
// ticket's determinism requirement. Frames are driven
// deterministically: one tick = one raf callback = one real frame
// of FRAME_MS. No network, no external services.
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
// compares the game's FAST_FWD_KEY against this literal, so a rename
// in the game would fail both sides consistently.
const KEY = "brickbreaker.fastfwd";
// One driven frame: real seconds per tick at 60 fps.
const FRAME_MS = 1000 / 60;
const FRAME_S = FRAME_MS / 1000;

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
// |a - b| small against the magnitude: float drift over dozens of
// accumulated frame dts is ~1e-16, so 1e-9 relative is generous.
function approx(a, b, rel = 1e-9) {
  const ok = Math.abs(a - b) <= Math.max(rel * Math.abs(b), 1e-12);
  return ok;
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

// A canvas 2d context stub that RECORDS method-call counts, so the
// render-frequency assertion can count draw()'s full-stage clear
// (the one fillRect issued with the STAGE dimensions — per-brick
// fills never match) per driven frame (no-op behaviour otherwise;
// every property set is allowed).
function makeCtx(canvas) {
  const counts = new Map();
  const target = {};
  for (const m of ["beginPath", "arc", "fill", "stroke",
    "moveTo", "lineTo", "setLineDash"]) target[m] = () => { counts.set(m, (counts.get(m) ?? 0) + 1); };
  target.fillRect = (x, y, w, h) => {
    counts.set("fillRect", (counts.get("fillRect") ?? 0) + 1);
    if (x === 0 && y === 0 && w === canvas.width && h === canvas.height) {
      counts.set("fullStage", (counts.get("fullStage") ?? 0) + 1);
    }
  };
  return {
    counts,
    ...target,
    fillStyle: "", strokeStyle: "", lineWidth: 0, font: "",
    textAlign: "", textBaseline: "", globalAlpha: 1,
  };
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
    addEventListener(type, cb) {
      (this.listeners[type] ??= []).push(cb);
    },
    dispatch(type, ev) {
      for (const cb of this.listeners[type] ?? []) cb(ev);
    },
  };
  // The context is grafted on AFTER the canvas literal (the full-stage
  // counter closes over the canvas to read its live dimensions).
  canvas.ctx = makeCtx(canvas);
  canvas.getContext = () => canvas.ctx;
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
  function tick(n = 1) {
    for (let i = 0; i < n; i += 1) {
      nowMs += FRAME_MS;
      rafCb(nowMs);
    }
  }
  const q = (expr) => vm.runInContext(expr, context);
  // Drive a window-level DOM event (mousedown/mouseup/blur/cancel).
  const dispatchWin = (type, ev = {}) => {
    for (const cb of winListeners[type] ?? []) cb(ev);
  };
  return {
    canvas,
    els,
    q,
    tick,
    dispatchWin,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    store,
    storage,
  };
}

// The four fast-fwd option button stubs for a booted game, keyed by
// option name (the FAST_FWD_OPTIONS key set).
const opts = (g) => ({
  off: g.els["fastfwd-off"],
  "1.5": g.els["fastfwd-1-5"],
  "2.0": g.els["fastfwd-2-0"],
  "3.0": g.els["fastfwd-3-0"],
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
// Acceptance (static HTML): the FAST FWD row is four nodes in
// #screen-start sharing a data-fastfwd attribute with values
// off|1.5|2.0|3.0, exactly one (2.0, the default) marked selected,
// in the existing data-* single-selected-button style
// ================================================================
check("the start screen contains exactly four data-fastfwd nodes, values off|1.5|2.0|3.0 (one each)", () => {
  const values = [...startSection.matchAll(/data-fastfwd="([^"]*)"/g)].map((m) => m[1]);
  assert(values.length === 4,
    `#screen-start must hold exactly 4 data-fastfwd nodes, found ${values.length}: ${JSON.stringify(values)}`);
  const sorted = [...values].sort();
  assert(JSON.stringify(sorted) === JSON.stringify(["1.5", "2.0", "3.0", "off"]),
    `the four values must be off, 1.5, 2.0 and 3.0 (once each), got ${JSON.stringify(values)}`);
  for (const id of ["fastfwd-off", "fastfwd-1-5", "fastfwd-2-0", "fastfwd-3-0"]) {
    assert(new RegExp(`<button\\b[^>]*id="${id}"`).test(startSection),
      `the option for ${id} must be a button node in #screen-start`);
  }
});

check("the static default-selection mark sits on the 2.0 node only", () => {
  const tags = [...startSection.matchAll(/<button\b[^>]*data-fastfwd="([^"]*)"[^>]*>/g)];
  assert(tags.length === 4, `expected 4 option buttons, found ${tags.length}`);
  for (const t of tags) {
    const name = t[1];
    const marked = /class="[^"]*\bselected\b[^"]*"/.test(t[0]);
    if (name === "2.0") {
      assert(marked, `the 2.0 button must be marked selected in the static markup, got: ${t[0]}`);
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
check("a fresh boot (no stored value) selects 2.0x and marks only the 2.0 button", () => {
  const g = boot(960, 600);
  assert(g.q("selectedFastFwd") === "2.0",
    `no stored value must mean the 2.0x default, got ${g.q("selectedFastFwd")}`);
  assert(g.q("fastFwdMult") === 2,
    `the boot knob must carry the numeric multiplier 2, got ${g.q("fastFwdMult")}`);
  const o = opts(g);
  assert(isMarked(o["2.0"]) && !isMarked(o.off) && !isMarked(o["1.5"]) && !isMarked(o["3.0"]),
    `only the 2.0 button may be marked, got ${JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, el]) => [k, el.className])))}`);
});

check("a seeded '3.0' selection is restored at boot (knob 3) and only the 3.0 button is marked", () => {
  const g = boot(960, 600, { [KEY]: '"3.0"' });
  assert(g.q("selectedFastFwd") === "3.0",
    `the stored 3.0 choice must load at boot, got ${g.q("selectedFastFwd")}`);
  assert(g.q("fastFwdMult") === 3, `the boot knob must be 3, got ${g.q("fastFwdMult")}`);
  const o = opts(g);
  assert(isMarked(o["3.0"]) && !isMarked(o["2.0"]), `only the 3.0 button may be marked, got ${o["3.0"].className}`);
});

check("a stored value from another build ('banana') falls back to the 2.0 default at boot", () => {
  const g = boot(960, 600, { [KEY]: '"banana"' });
  assert(g.q("selectedFastFwd") === "2.0",
    `an unknown option name must fall back to 2.0, got ${g.q("selectedFastFwd")}`);
  assert(g.q("fastFwdMult") === 2, `the knob must be 2 after the fallback, got ${g.q("fastFwdMult")}`);
});

check("corrupt stored JSON falls back to 2.0 without breaking boot", () => {
  const g = boot(960, 600, { [KEY]: "{not json" });
  assert(g.state() === "start", `boot must survive corrupt storage, state is ${g.state()}`);
  assert(g.q("selectedFastFwd") === "2.0",
    `corrupt JSON must fall back to 2.0, got ${g.q("selectedFastFwd")}`);
});

check("a stored non-string ('123') falls back to 2.0 at boot", () => {
  const g = boot(960, 600, { [KEY]: "123" });
  assert(g.q("selectedFastFwd") === "2.0",
    `a non-string stored value must fall back to 2.0, got ${g.q("selectedFastFwd")}`);
});

check("the selection loads via the named key constant (FAST_FWD_KEY) at boot", () => {
  const g = boot(960, 600, { [KEY]: '"3.0"' });
  const key = g.q("typeof FAST_FWD_KEY === 'undefined' ? null : FAST_FWD_KEY");
  assert(typeof key === "string" && key.length > 0,
    `FAST_FWD_KEY must be a non-empty string constant, got ${JSON.stringify(key)}`);
  assert(key === KEY, `the game's key drifted from the documented key, got ${JSON.stringify(key)}`);
  assert(g.storage.reads.includes(KEY),
    `boot must read ${KEY} from localStorage, reads were ${JSON.stringify(g.storage.reads)}`);
});

// ================================================================
// UI behaviour: exactly one button selected at any time; a click
// reselects, marks and persists; re-clicking the active option is
// a no-op; the live knob follows the selection immediately
// ================================================================
check("clicking 3.0x moves the mark and writes exactly one JSON entry to brickbreaker.fastfwd", () => {
  const g = boot(960, 600);
  const o = opts(g);
  o["3.0"].click();
  assert(g.q("selectedFastFwd") === "3.0",
    `the click must switch the selection to 3.0, got ${g.q("selectedFastFwd")}`);
  assert(g.q("fastFwdMult") === 3,
    `the live knob must follow to 3 immediately, got ${g.q("fastFwdMult")}`);
  assert(markedCount(g) === 1, `exactly one option button may be marked, got ${markedCount(g)}`);
  assert(isMarked(o["3.0"]) && !isMarked(o["2.0"]),
    `the 3.0 button must gain the mark and 2.0 lose it, got ${o["2.0"].className}`);
  assert(g.storage.writes.length === 1,
    `exactly one setItem must fire, writes were ${JSON.stringify(g.storage.writes)}`);
  const [wKey, wValue] = g.storage.writes[0];
  assert(wKey === KEY, `the write must target ${KEY}, got ${JSON.stringify(wKey)}`);
  const parsed = JSON.parse(wValue); // throws if not valid JSON
  assert(parsed === "3.0",
    `the written value must be the JSON string "3.0", got ${JSON.stringify(wValue)}`);
});

check("clicking OFF zeroes the live knob (the warp is disarmed by selection)", () => {
  const g = boot(960, 600);
  opts(g).off.click();
  assert(g.q("selectedFastFwd") === "off",
    `the click must select off, got ${g.q("selectedFastFwd")}`);
  assert(g.q("fastFwdMult") === 0, `the live knob must be 0 (OFF), got ${g.q("fastFwdMult")}`);
});

check("clicking back to the 2.0 default returns the mark and overwrites the stored value", () => {
  const g = boot(960, 600, { [KEY]: '"3.0"' });
  opts(g)["2.0"].click();
  assert(g.q("selectedFastFwd") === "2.0",
    `the click must return the selection to 2.0, got ${g.q("selectedFastFwd")}`);
  assert(g.q("fastFwdMult") === 2, `the live knob must be 2, got ${g.q("fastFwdMult")}`);
  assert(markedCount(g) === 1 && isMarked(opts(g)["2.0"]) && !isMarked(opts(g)["3.0"]),
    `the mark must sit on 2.0 alone after the reselect`);
  assert(JSON.stringify(g.storage.writes) === JSON.stringify([[KEY, '"2.0"']]),
    `the reselect must overwrite the stored value, writes were ${JSON.stringify(g.storage.writes)}`);
});

check("re-clicking the already-selected option changes nothing and performs no write", () => {
  const g = boot(960, 600, { [KEY]: '"1.5"' });
  opts(g)["1.5"].click();
  assert(g.storage.writes.length === 0,
    `re-selecting the active option must not rewrite storage, writes were ${JSON.stringify(g.storage.writes)}`);
  assert(g.q("selectedFastFwd") === "1.5",
    `the selection must remain 1.5, got ${g.q("selectedFastFwd")}`);
  assert(g.q("fastFwdMult") === 1.5, `the knob must remain 1.5, got ${g.q("fastFwdMult")}`);
  assert(markedCount(g) === 1, `the mark must stay on 1.5 alone, got ${markedCount(g)}`);
});

// ================================================================
// Warp behaviour (ticket VM test a): with 2.0x held, simTime
// accumulates at 2x the real driven time; on mouseup it releases
// back to 1.0x. Frames are driven deterministically via raf.
// ================================================================
check("holding the right mouse at 2.0x warps simTime to 2x the driven real time; mouseup releases back to 1.0x", () => {
  const g = boot(960, 600);
  g.els["btn-start"].click();
  assert(g.state() === "playing", `the start button must begin the run, state is ${g.state()}`);
  g.tick(2); // let the serve ball ride a couple of unwarp frames

  const before = g.q("simTime");
  g.q("rmbHeld = true;"); // the harness may arm the warp directly
  g.q("fastFwdMult = 2;");
  g.tick(60); // 1.0 s of driven real time
  const afterWarped = g.q("simTime");
  g.q("rmbHeld = false;"); // release (as window mouseup would)
  g.tick(60); // another 1.0 s of driven real time
  const afterReleased = g.q("simTime");

  assert(approx(afterWarped - before, 2.0),
    `while held at 2x, 1.0 s of real time must advance simTime by 2.0 s, got ${afterWarped - before}`);
  assert(approx(afterReleased - afterWarped, 1.0),
    `after release, 1.0 s of real time must advance simTime by exactly 1.0 s, got ${afterReleased - afterWarped}`);
});

check("window mousedown with e.button 2 arms rmbHeld; left/right-adjacent buttons do not", () => {
  const g = boot(960, 600);
  g.dispatchWin("mousedown", { button: 2 });
  assert(g.q("rmbHeld") === true, `button 2 down must arm rmbHeld, got ${g.q("rmbHeld")}`);
  g.dispatchWin("mouseup", { button: 2 });
  assert(g.q("rmbHeld") === false, `button 2 up must disarm rmbHeld, got ${g.q("rmbHeld")}`);
  g.dispatchWin("mousedown", { button: 0 });
  assert(g.q("rmbHeld") === false,
    `a LEFT button press must not arm the warp, got ${g.q("rmbHeld")}`);
  g.dispatchWin("mousedown", { button: 1 });
  assert(g.q("rmbHeld") === false,
    `a MIDDLE button press must not arm the warp, got ${g.q("rmbHeld")}`);
});

check("window mouseup, blur and cancel each clear a stuck rmbHeld", () => {
  const g = boot(960, 600);
  for (const type of ["mouseup", "blur", "cancel"]) {
    g.dispatchWin("mousedown", { button: 2 }); // arm via the real press path
    assert(g.q("rmbHeld") === true, `setup: button 2 down must arm rmbHeld`);
    g.dispatchWin(type, { button: 2 });
    assert(g.q("rmbHeld") === false,
      `a ${type} (button 2) must clear a held right mouse, got ${g.q("rmbHeld")}`);
  }
});

// Warp behaviour (ticket VM test b): OFF (fastFwdMult 0) means no
// speedup even with rmbHeld true.
check("with OFF (fastFwdMult 0), holding the right mouse does not speed the simulation up", () => {
  const g = boot(960, 600);
  g.els["btn-start"].click();
  assert(g.state() === "playing", `the start button must begin the run, state is ${g.state()}`);
  g.tick(2);
  const before = g.q("simTime");
  g.q("rmbHeld = true; fastFwdMult = 0;");
  g.tick(60);
  const after = g.q("simTime");
  assert(approx(after - before, 1.0),
    `OFF must mean exactly 1.0 s of sim time per 1.0 s driven, got ${after - before}`);
});

// Warp behaviour (correctness care): the REAL dt is clamped to
// MAX_FRAME_SECONDS BEFORE the multiplier is applied, so a stalled
// tab plus a held warp produces at most MAX_FRAME_SECONDS * mult of
// sim time in one frame.
check("a stalled frame is clamped BEFORE the scale: one big jump advances simTime by at most MAX_FRAME_SECONDS * mult", () => {
  const g = boot(960, 600);
  g.els["btn-start"].click();
  assert(g.state() === "playing", `the start button must begin the run, state is ${g.state()}`);
  g.tick(2);
  const before = g.q("simTime");
  // Stall the clock 5 s into the past: the next frame's raw dt is
  // huge, and must be clamped to MAX_FRAME_SECONDS first.
  g.q("lastFrameTime = -5000;");
  g.q("rmbHeld = true; fastFwdMult = 3;");
  g.tick(1);
  const after = g.q("simTime");
  const capped = g.q("MAX_FRAME_SECONDS") * 3;
  assert(after - before <= capped + 1e-12,
    `the warped sim step must not exceed the clamped real step × mult (${capped}), got ${after - before}`);
  assert(approx(after - before, capped),
    `the stalled frame must consume the full clamped step × mult (${capped}), got ${after - before}`);
});

// Warp behaviour (correctness care): the render must not
// desynchronise — exactly ONE full-stage clear (draw()'s opening
// wipe) per driven real frame, whether warped or not.
check("the render runs once per REAL frame: full-stage clears grow by one per driven frame, warped or not", () => {
  const g = boot(960, 600);
  g.els["btn-start"].click();
  g.tick(2);
  const flat = () => g.canvas.ctx.counts.get("fullStage");
  g.q("rmbHeld = true; fastFwdMult = 3;");
  const before = flat();
  g.tick(30);
  assert(flat() - before === 30,
    `warped: 30 driven frames must produce exactly 30 full-stage clears, got ${flat() - before}`);
  g.q("rmbHeld = false;");
  const before2 = flat();
  g.tick(30);
  assert(flat() - before2 === 30,
    `unwarped: 30 driven frames must produce exactly 30 full-stage clears, got ${flat() - before2}`);
});

// Warp behaviour (ticket VM test c): the browser context menu is
// prevented over the stage (the canvas).
check("contextmenu over the stage is preventDefault()-ed", () => {
  const g = boot(960, 600);
  let prevented = false;
  g.canvas.dispatch("contextmenu", { preventDefault() { prevented = true; } });
  assert(prevented, `the canvas contextmenu handler must call preventDefault, it did not`);
});

// ================================================================
// Warp correctness (ticket VM test d): the ball integrator
// sub-steps by travel = speed * simDt. Under a 3x warp a
// high-speed ball travels far in one driven frame; the sub-stepping
// (fed the SCALED dt for both travel and the per-substep sdt) must
// still register the brick-face contact — a single giant step would
// skip the 26 px brick face entirely (start position + skip distance
// are chosen so a one-shot step ends with ZERO overlap).
// The target is a brick on the LAST row: the space below it is
// open, so the ball's contact is guaranteed to be THAT brick.
// ================================================================
check("under a 3x warp a high-speed ball still cannot tunnel through a brick face", () => {
  const g = boot(960, 600);
  g.els["btn-start"].click();
  assert(g.state() === "playing", `the start button must begin the run, state is ${g.state()}`);
  g.tick(2);

  const setup = g.q(`(() => {
    // Bottom-row brick (row 4 of level 1: tier B, hp 2): the last
    // row's underside is open field, so this brick is the ball's
    // first and only contact.
    var idx = -1;
    for (var i = 0; i < bricks.length; i += 1) {
      var row = Math.floor(i / BRICK_COLS);
      if (row === BRICK_ROWS - 1 && bricks[i].active && !bricks[i].unbreakable) { idx = i; break; }
    }
    var b = bricks[idx];
    // Repurpose the (attached) serve ball: straight up, centred on
    // the target brick, JUST below its bottom face.
    var ball = balls[0];
    ball.active = true;
    ball.attached = false;
    ball.x = b.x + b.w / 2;
    ball.y = b.y + b.h + BALL_RADIUS + 4;
    // One warped frame must carry the ball THROUGH the brick and
    // beyond its far face: contact window for the centre is
    // h + 2r long, so a one-shot step longer than it lands with
    // zero overlap — invisible to a step-end collision test.
    var travel = b.h + 2 * BALL_RADIUS + 12;
    var simDt = 3 * (${FRAME_S}); // one real frame at 3x
    ball.vx = 0;
    ball.vy = -travel / simDt;
    return JSON.stringify({ idx: idx, bx: b.x, by: b.y, bw: b.w, bh: b.h, hp: b.hp });
  })()`);
  const t = JSON.parse(setup);

  g.q("rmbHeld = true; fastFwdMult = 3;");
  g.tick(1);

  const outcome = g.q(`(() => {
    var b = bricks[${t.idx}];
    var ball = balls[0];
    return JSON.stringify({
      hp: b.active ? b.hp : 0,
      active: b.active,
      ballTop: ball.y - BALL_RADIUS
    });
  })()`);
  const r = JSON.parse(outcome);
  const damaged = !r.active || r.hp < t.hp;
  assert(damaged,
    `the brick must have registered the contact (hp ${t.hp} → ${r.hp}, active ${r.active}) — a tunnelled step skips it entirely`);
  assert(r.ballTop >= t.by + t.bh - 1e-6,
    `a ball striking from below must end below the brick's bottom face (pinned), got ballTop ${r.ballTop} vs face ${t.by + t.bh}`);
});

// The same geometry WITHOUT the warp must behave identically at
// the same speed (the baseline: sub-stepping already held pre-#102
// and must still hold now that the dt it consumes is the simDt).
check("at 1.0x the same high-speed ball registers the brick contact (baseline)", () => {
  const g = boot(960, 600);
  g.els["btn-start"].click();
  g.tick(2);
  const t = JSON.parse(g.q(`(() => {
    var idx = -1;
    for (var i = 0; i < bricks.length; i += 1) {
      var row = Math.floor(i / BRICK_COLS);
      if (row === BRICK_ROWS - 1 && bricks[i].active && !bricks[i].unbreakable) { idx = i; break; }
    }
    var b = bricks[idx];
    var ball = balls[0];
    ball.active = true;
    ball.attached = false;
    ball.x = b.x + b.w / 2;
    ball.y = b.y + b.h + BALL_RADIUS + 4;
    var travel = b.h + 2 * BALL_RADIUS + 12;
    ball.vx = 0;
    ball.vy = -travel / (${FRAME_S}); // one UNwarped frame, same distance
    return JSON.stringify({ idx: idx, by: b.y, bh: b.h, hp: b.hp });
  })()`));
  g.q("rmbHeld = false; fastFwdMult = 0;"); // no warp, knob OFF
  g.tick(1);
  const r = JSON.parse(g.q(`(() => {
    var b = bricks[${t.idx}];
    var ball = balls[0];
    return JSON.stringify({ hp: b.active ? b.hp : 0, active: b.active, ballTop: ball.y - BALL_RADIUS });
  })()`));
  const damaged = !r.active || r.hp < t.hp;
  assert(damaged, `the unwarped fast ball must also register the contact (hp ${t.hp} → ${r.hp})`);
  assert(r.ballTop >= t.by + t.bh - 1e-6,
    `the unwarped ball must end below the brick's bottom face (pinned), got ${r.ballTop} vs ${t.by + t.bh}`);
});

// ================================================================
// Acceptance (persistence): a simulated reload (fresh boot, same
// backing store) round-trips the choice; corrupt value → 2.0
// ================================================================
check("after a simulated reload (fresh vm sandbox, same backing store) the chosen option is re-selected and re-marked", () => {
  const before = boot(960, 600);
  opts(before)["3.0"].click();
  assert(before.store[KEY] === '"3.0"',
    `the first session must persist "3.0", got ${JSON.stringify(before.store[KEY])}`);

  const after = boot(960, 600, before.store);
  assert(after !== before, "the reload must be a distinct vm sandbox");
  assert(after.q("selectedFastFwd") === "3.0",
    `the reloaded session must restore 3.0, got ${after.q("selectedFastFwd")}`);
  assert(after.q("fastFwdMult") === 3,
    `the reloaded session must carry knob 3, got ${after.q("fastFwdMult")}`);
  const o = opts(after);
  assert(isMarked(o["3.0"]) && !isMarked(o["2.0"]),
    `the reload must re-mark only the 3.0 button, got ${o["2.0"].className}`);
});

// ================================================================
// Seam hygiene: the option table the selector walks, and the knob
// the frame loop reads, are module-level named vars (console-
// retunable, per house style)
// ================================================================
check("FAST_FWD_OPTIONS maps each option name to its numeric multiplier; the default row is 2.0 → 2", () => {
  const g = boot(960, 600);
  const table = g.q("FAST_FWD_OPTIONS");
  assert(table && typeof table === "object", "FAST_FWD_OPTIONS must be a module-level table");
  assert(table.off === 0, `the OFF row must be the multiplier 0, got ${table.off}`);
  assert(table["1.5"] === 1.5, `the 1.5 row must be 1.5, got ${table["1.5"]}`);
  assert(table["2.0"] === 2, `the 2.0 row must be 2, got ${table["2.0"]}`);
  assert(table["3.0"] === 3, `the 3.0 row must be 3, got ${table["3.0"]}`);
  assert(g.q("DEFAULT_FAST_FWD") === "2.0",
    `the named default must be "2.0", got ${g.q("DEFAULT_FAST_FWD")}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
