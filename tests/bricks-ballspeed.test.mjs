#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html start-screen ball-speed slider
// (ticket #73: range input 50-150% persisted in localStorage,
// applied per run at begin)
//
// Same harness style as the sibling bricks-*.test.mjs suites: the
// REAL <script> from bricks.html runs in a sandboxed vm context
// with stubbed window/document/localStorage/requestAnimationFrame
// and DOM element stubs. The storage stub is RECORDING (backed by a
// plain object, logs every getItem/setItem) so a "reload" can
// re-boot onto the same backing store and exact writes are
// assertable. Static-HTML criteria are checked straight against
// the bricks.html source. Like every sibling suite, `random` is
// pinned at boot so a capsule can never drop by chance mid-test.
// No network, no external services.
//
// Run: node tests/bricks-ballspeed.test.mjs
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
// compares the game's BALL_SPEED_KEY against this literal, so a
// rename in the game would fail both sides consistently.
const KEY = "brickbreaker.speed";

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

// Drive the #ball-speed slider the way a browser drag would: write
// the element value, then dispatch its input event.
function setSlider(g, v) {
  const el = g.els["ball-speed"];
  el.value = String(v);
  for (const cb of el.listeners["input"] ?? []) cb({ type: "input" });
}
// Fire the double-click gesture on the given element. The stub
// elements do not model the DOM tree; in the real markup the
// readout span sits INSIDE the row label, so a dblclick on it
// bubbles to the label — model that single containment hop.
// The slider is inside the label as well, but the game's handler
// ignores dblclicks whose target is the input (a fine-adjust gesture,
// not a reset), so the driver never needs to model a slider-
// originated dblclick reaching the handler.
const DBLCLICK_PARENTS = { "ball-speed-value": "ball-speed-label" };
function dblClick(g, id) {
  let cur = id;
  while (cur) {
    for (const cb of g.els[cur].listeners["dblclick"] ?? []) cb({ type: "dblclick" });
    cur = DBLCLICK_PARENTS[cur];
  }
}
// Begin a run through the start CTA and launch the serve ball via
// the canvas click path; returns the launch speed (px/s).
function startAndLaunch(g) {
  g.els["btn-start"].click();
  g.canvas.dispatch("click", { type: "click" });
  return Math.hypot(g.q("balls[0].vx"), g.q("balls[0].vy"));
}

// The raw #screen-start section source, for the static-HTML checks.
const startSection = (() => {
  const m = html.match(/<section class="screen" id="screen-start">([\s\S]*?)<\/section>/);
  if (!m) throw new Error("#screen-start section not found in bricks.html");
  return m[1];
})();

// The raw <style> block source, for the structural-CSS checks.
const styleBlock = (() => {
  const m = html.match(/<style>[\s\S]*?<\/style>/);
  if (!m) throw new Error("<style> block not found in bricks.html");
  return m[0];
})();

// The body of one CSS rule for a literal selector (last occurrence).
function cssRule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pat = new RegExp(esc + "\\s*{([^}]*)}", "g");
  let last = null;
  for (const m of styleBlock.matchAll(pat)) last = m[1];
  return last;
}

// ================================================================
// Requirement (static HTML): a range input id="ball-speed",
// min 50, max 150, static default 100, step 5 (ticket #90), lives
// in the start-screen controls; the row carries the live readout
// span and the labelled double-click reset target
// ================================================================
check('the start screen carries <input id="ball-speed" type="range" min="50" max="150" step="5" value="100">', () => {
  const slider = startSection.match(/<input[^>]*id="ball-speed"[^>]*>/);
  assert(slider !== null, 'the start screen must carry an <input id="ball-speed">');
  const tag = slider[0];
  for (const attr of ['type="range"', 'min="50"', 'max="150"', 'step="5"', 'value="100"']) {
    assert(tag.includes(attr),
      `the ball-speed input must declare ${attr}, got: ${tag}`);
  }
});

check("the speed row carries the live readout (#ball-speed-value) next to a labelled reset target (#ball-speed-label)", () => {
  assert(startSection.includes('id="ball-speed-label"'),
    'the speed row label must carry id="ball-speed-label" (the double-click reset target)');
  assert(startSection.includes('id="ball-speed-value"'),
    'the speed row must carry id="ball-speed-value" (the live readout)');
});

check("AC4: the 100% notch is a CSS pseudo-element hook at the mid position, theme-coloured", () => {
  const rule = cssRule(".speed .slider::after");
  assert(rule !== null,
    "the notch must be a ::after pseudo-element on the .speed .slider track wrapper");
  assert(/left:\s*50%/.test(rule),
    `100% is the MID of the 50-150 range, so the notch must anchor at left: 50%; got: ${rule.trim()}`);
  assert(/background:\s*var\(--accent\)/.test(rule),
    `the notch must be theme-coloured through the existing palette vars; got: ${rule.trim()}`);
});

check("the file gains no external references", () => {
  const ext = (html.match(/(src|href)=/g) ?? []).length;
  assert(ext === 0, `bricks.html must stay self-contained (0 src/href), found ${ext}`);
});

// ================================================================
// Boot-time restore: the slider reflects the stored percent
// (AC1 "slider reads 125"); corrupt/absent/out-of-range values
// fall back to the default 100 (AC2)
// ================================================================
check("boot with stored 125: the slider reads 125 and the module state is 125", () => {
  const g = boot(960, 600, { [KEY]: "125" });
  assert(g.els["ball-speed"].value === "125",
    `the slider must restore to the stored 125, got ${JSON.stringify(g.els["ball-speed"].value)}`);
  assert(g.q("ballSpeedPct") === 125,
    `the module state must be 125, got ${g.q("ballSpeedPct")}`);
});

check("a fresh boot (no stored value) sits at the default 100", () => {
  const g = boot(960, 600);
  assert(g.els["ball-speed"].value === "100",
    `the slider must sit at the default 100, got ${JSON.stringify(g.els["ball-speed"].value)}`);
  assert(g.q("ballSpeedPct") === 100,
    `the module state must be 100, got ${g.q("ballSpeedPct")}`);
});

check("corrupt stored JSON falls back to 100 without breaking boot", () => {
  const g = boot(960, 600, { [KEY]: "{not json" });
  assert(g.state() === "start", `boot must survive corrupt storage, state is ${g.state()}`);
  assert(g.els["ball-speed"].value === "100",
    `corrupt JSON must restore the default 100, got ${JSON.stringify(g.els["ball-speed"].value)}`);
});

check("a non-numeric stored value falls back to 100", () => {
  const g = boot(960, 600, { [KEY]: '"fast"' });
  assert(g.q("ballSpeedPct") === 100,
    `a non-integer stored value must fall back to 100, got ${g.q("ballSpeedPct")}`);
});

check("stored values outside [50, 150] (42 and 999) fall back to 100", () => {
  const lo = boot(960, 600, { [KEY]: "42" });
  assert(lo.q("ballSpeedPct") === 100,
    `a stored 42 (below the slider floor) must fall back to 100, got ${lo.q("ballSpeedPct")}`);
  const hi = boot(960, 600, { [KEY]: "999" });
  assert(hi.q("ballSpeedPct") === 100,
    `a stored 999 (above the slider ceiling) must fall back to 100, got ${hi.q("ballSpeedPct")}`);
});

check("the percent loads via the named key constant (BALL_SPEED_KEY) at boot", () => {
  const g = boot(960, 600, { [KEY]: "125" });
  const key = g.q("typeof BALL_SPEED_KEY === 'undefined' ? null : BALL_SPEED_KEY");
  assert(typeof key === "string" && key.length > 0,
    `BALL_SPEED_KEY must be a non-empty string constant, got ${JSON.stringify(key)}`);
  assert(key === KEY, `the game's key drifted from the documented key, got ${JSON.stringify(key)}`);
  assert(g.storage.reads.includes(KEY),
    `boot must read ${KEY} from localStorage, reads were ${JSON.stringify(g.storage.reads)}`);
});

// ================================================================
// AC2 (live readout): the readout element shows the booted value
// (default 100 / stored value — including a hand-stored off-grid
// 123) and tracks input events
// ================================================================
check("boot readout: a fresh boot shows the default 100% in the readout", () => {
  const g = boot(960, 600);
  assert(g.els["ball-speed-value"].textContent === "100%",
    `the readout must show the booted default 100%, got ${JSON.stringify(g.els["ball-speed-value"].textContent)}`);
});

check("boot readout: a stored 125 boots the readout showing 125%", () => {
  const g = boot(960, 600, { [KEY]: "125" });
  assert(g.els["ball-speed-value"].textContent === "125%",
    `the readout must show the stored 125%, got ${JSON.stringify(g.els["ball-speed-value"].textContent)}`);
});

check("the readout tracks input events (125 then 50)", () => {
  const g = boot(960, 600);
  setSlider(g, 125);
  assert(g.els["ball-speed-value"].textContent === "125%",
    `after moving to 125 the readout must show 125%, got ${JSON.stringify(g.els["ball-speed-value"].textContent)}`);
  setSlider(g, 50);
  assert(g.els["ball-speed-value"].textContent === "50%",
    `after moving to 50 the readout must show 50%, got ${JSON.stringify(g.els["ball-speed-value"].textContent)}`);
});

// ================================================================
// AC1 (5% grid): moving the slider only ever lands on multiples
// of 5 — asserted via input events, boundaries included
// ================================================================
check("AC1: grid-aligned input events land exactly on the requested 5% stops (50..150 sweep)", () => {
  const g = boot(960, 600);
  for (let v = 50; v <= 150; v += 5) {
    setSlider(g, v);
    const pct = g.q("ballSpeedPct");
    assert(pct === v, `a grid-aligned move to ${v} must hold ${v}, got ${pct}`);
    assert(pct % 5 === 0, `the state must be a multiple of 5, got ${pct}`);
  }
});

check("AC1: an off-grid input value snaps to the nearest 5% stop (123 -> 125, 88 -> 90)", () => {
  const g = boot(960, 600);
  setSlider(g, 123);
  assert(g.q("ballSpeedPct") === 125,
    `123 must snap to the nearest stop 125, got ${g.q("ballSpeedPct")}`);
  setSlider(g, 88);
  assert(g.q("ballSpeedPct") === 90,
    `88 must snap to the nearest stop 90, got ${g.q("ballSpeedPct")}`);
});

// ================================================================
// Off-grid stored value (requirement): a hand-stored 123 loads and
// the readout shows 123 — the stored value is NOT rewritten until
// the user moves the slider, when the move snaps to the grid
// ================================================================
check("a hand-stored off-grid 123 loads: slider 123, readout 123%, zero boot writes", () => {
  const g = boot(960, 600, { [KEY]: "123" });
  assert(g.els["ball-speed"].value === "123",
    `the slider must restore the hand-stored 123 untouched, got ${JSON.stringify(g.els["ball-speed"].value)}`);
  assert(g.els["ball-speed-value"].textContent === "123%",
    `the readout must show the off-grid 123, got ${JSON.stringify(g.els["ball-speed-value"].textContent)}`);
  assert(g.q("ballSpeedPct") === 123, `the module state must be 123, got ${g.q("ballSpeedPct")}`);
  assert(g.storage.writes.length === 0,
    `boot must not rewrite an off-grid stored value, writes were ${JSON.stringify(g.storage.writes)}`);
});

check("with a hand-stored 123, the first user move snaps to the grid and persists the snapped value", () => {
  const g = boot(960, 600, { [KEY]: "123" });
  setSlider(g, 125); // the user drags to the adjacent stop
  assert(g.q("ballSpeedPct") === 125, `the move must land on 125, got ${g.q("ballSpeedPct")}`);
  assert(g.storage.writes.length === 1,
    `exactly one write must fire, writes were ${JSON.stringify(g.storage.writes)}`);
  assert(JSON.parse(g.storage.writes[0][1]) === 125,
    `the persisted value must be the snapped 125, got ${JSON.stringify(g.storage.writes[0][1])}`);
});

// ================================================================
// AC3 (double-click reset): dblclick on the readout/label resets
// the slider to 100, moves the thumb, updates the readout and
// persists EXACTLY ONE write of 100; an already-100 dblclick is a
// no-op that writes nothing
// ================================================================
check("AC3: double-click on the row label resets to 100 — thumb, readout, single persistence write", () => {
  const g = boot(960, 600, { [KEY]: "125" });
  dblClick(g, "ball-speed-label");
  assert(g.els["ball-speed"].value === "100",
    `the slider thumb must move to 100, got ${JSON.stringify(g.els["ball-speed"].value)}`);
  assert(g.q("ballSpeedPct") === 100, `the module state must be 100, got ${g.q("ballSpeedPct")}`);
  assert(g.els["ball-speed-value"].textContent === "100%",
    `the readout must show 100%, got ${JSON.stringify(g.els["ball-speed-value"].textContent)}`);
  assert(g.storage.writes.length === 1,
    `the reset must perform exactly one persistence write, writes were ${JSON.stringify(g.storage.writes)}`);
  const [wKey, wValue] = g.storage.writes[0];
  assert(wKey === KEY, `the write must target ${KEY}, got ${JSON.stringify(wKey)}`);
  assert(JSON.parse(wValue) === 100, `the write must be the JSON integer 100, got ${JSON.stringify(wValue)}`);
});

check("AC3: the double-click gesture works from the readout span too", () => {
  const g = boot(960, 600, { [KEY]: "50" });
  dblClick(g, "ball-speed-value");
  assert(g.q("ballSpeedPct") === 100 && g.els["ball-speed"].value === "100",
    `dblclick on the readout must reset the slider to 100, got state ${g.q("ballSpeedPct")} / value ${JSON.stringify(g.els["ball-speed"].value)}`);
});

check("a double-click ON THE SLIDER bubbles to the label but must NOT reset (fine-adjust gesture)", () => {
  const g = boot(960, 600, { [KEY]: "125" });
  // Model the real-browser bubble: the label's dblclick handler fires
  // with e.target === the input (the slider sits inside the label).
  for (const cb of g.els["ball-speed-label"].listeners["dblclick"] ?? []) {
    cb({ type: "dblclick", target: g.els["ball-speed"] });
  }
  assert(g.q("ballSpeedPct") === 125 && g.els["ball-speed"].value === "125",
    `a slider-targeted dblclick must not reset, got state ${g.q("ballSpeedPct")} / value ${JSON.stringify(g.els["ball-speed"].value)}`);
  assert(g.storage.writes.length === 0,
    `the swallowed reset must not persist, writes were ${JSON.stringify(g.storage.writes)}`);
});

check("a double-click reset already at 100 performs no write (no-op move invariant)", () => {
  const g = boot(960, 600);
  dblClick(g, "ball-speed-label");
  assert(g.storage.writes.length === 0,
    `an already-100 reset must not rewrite storage, writes were ${JSON.stringify(g.storage.writes)}`);
  assert(g.els["ball-speed-value"].textContent === "100%",
    `the readout must keep showing 100%`);
});

check("a reset write survives a simulated reload (fresh vm sandbox, same backing store)", () => {
  const before = boot(960, 600, { [KEY]: "150" });
  dblClick(before, "ball-speed-label");
  assert(before.store[KEY] === "100",
    `the reset must persist 100, got ${JSON.stringify(before.store[KEY])}`);
  const after = boot(960, 600, before.store);
  assert(after.els["ball-speed"].value === "100" && after.els["ball-speed-value"].textContent === "100%",
    `the reload must restore the reset 100 (slider + readout), got ${JSON.stringify(after.els["ball-speed"].value)} / ${JSON.stringify(after.els["ball-speed-value"].textContent)}`);
});

// ================================================================
// AC1 (scaled run): boot with stored 125 → the new run launches the
// ball at exactly 480×1.25 = 600 px/s and the level ceiling scales
// to 1500×1.25 = 1875
// ================================================================
check("a run begun at 125% launches the ball at exactly 480×1.25 = 600 px/s", () => {
  const g = boot(960, 600, { [KEY]: "125" });
  const speed = startAndLaunch(g);
  assert(speed === 600,
    `the launch speed must be exactly 600 px/s, got ${speed}`);
  assert(g.q("serveSpeed") === 600,
    `the run's serveSpeed must be 600, got ${g.q("serveSpeed")}`);
});

check("a 125% run caps level growth at exactly 1500×1.25 = 1875, never exceeding it", () => {
  const g = boot(960, 600, { [KEY]: "125" });
  g.els["btn-start"].click();
  const seq = g.q("(function () { var out = []; for (var i = 0; i < 20; i += 1) { advanceLevel(); out.push(serveSpeed); } return out; })()");
  for (const v of seq) {
    assert(v <= 1875 + 1e-9, `no grown serve may exceed the scaled ceiling 1875, got ${v}`);
  }
  assert(seq[seq.length - 1] === 1875,
    `growth must converge to the scaled ceiling 1875, got ${seq[seq.length - 1]}`);
});

check("per-level growth keeps the same curve shape: level 2 serve is ×LEVEL_SPEED_GROWTH of level 1 at 125%", () => {
  const g = boot(960, 600, { [KEY]: "125" });
  g.els["btn-start"].click();
  const first = g.q("serveSpeed");
  g.q("advanceLevel()");
  const second = g.q("serveSpeed");
  assert(Math.abs(second - first * g.q("LEVEL_SPEED_GROWTH")) < 1e-9,
    `level 2 must grow level 1 by LEVEL_SPEED_GROWTH (${first} -> ${second})`);
  assert(first < 1875 && second > first,
    `growth below the ceiling must still increase the serve (${first} -> ${second})`);
});

// ================================================================
// AC3 (bounds): the slider extremes map to 240 and 720 px/s
// ================================================================
check("a run begun at the 50% bound launches the ball at exactly 240 px/s", () => {
  const g = boot(960, 600, { [KEY]: "50" });
  const speed = startAndLaunch(g);
  assert(speed === 240, `the launch speed must be exactly 240 px/s, got ${speed}`);
});

check("a run begun at the 150% bound launches the ball at exactly 720 px/s", () => {
  const g = boot(960, 600, { [KEY]: "150" });
  const speed = startAndLaunch(g);
  assert(speed === 720, `the launch speed must be exactly 720 px/s, got ${speed}`);
});

check("a run begun at the default 100% reproduces the legacy 480 px/s launch", () => {
  const g = boot(960, 600);
  const speed = startAndLaunch(g);
  assert(speed === 480, `the default launch must stay exactly 480 px/s, got ${speed}`);
});

// ================================================================
// AC3 (mid-run snapshot): a slider movement during a live run does
// not alter that run's ball speed; the NEXT run picks it up
// ================================================================
check("moving the slider mid-run does not alter the live run's ball speed", () => {
  const g = boot(960, 600);
  const launched = startAndLaunch(g);
  assert(launched === 480, `precondition: the run must launch at 480, got ${launched}`);
  setSlider(g, 150);
  const live = Math.hypot(g.q("balls[0].vx"), g.q("balls[0].vy"));
  assert(live === 480,
    `the live ball must keep flying at 480 while the run owns its snapshot, got ${live}`);
  assert(g.q("serveSpeed") === 480,
    `the live run's serveSpeed must stay 480, got ${g.q("serveSpeed")}`);
});

check("a mid-run slider change takes effect on the NEXT run (the begin-run snapshot)", () => {
  const g = boot(960, 600);
  const first = startAndLaunch(g);
  assert(first === 480, `precondition: the first run launches at 480, got ${first}`);
  setSlider(g, 150); // moved while the run is live
  g.q("quitToMenu()"); // drain the run back to the start screen
  const second = startAndLaunch(g);
  assert(second === 720,
    `the next run must launch at the newly selected 150% (720), got ${second}`);
});

// ================================================================
// AC2 (persistence): slider moves write the int percent to
// brickbreaker.speed; the value survives a simulated reload;
// a no-op move writes nothing; programmatic out-of-range values
// clamp into [50, 150]
// ================================================================
check("moving the slider writes the int percent as JSON to brickbreaker.speed (exactly one write)", () => {
  const g = boot(960, 600);
  setSlider(g, 125);
  assert(g.q("ballSpeedPct") === 125,
    `the module state must follow the slider, got ${g.q("ballSpeedPct")}`);
  assert(g.storage.writes.length === 1,
    `exactly one setItem must fire, writes were ${JSON.stringify(g.storage.writes)}`);
  const [wKey, wValue] = g.storage.writes[0];
  assert(wKey === KEY, `the write must target ${KEY}, got ${JSON.stringify(wKey)}`);
  const parsed = JSON.parse(wValue); // throws if not valid JSON
  assert(Number.isInteger(parsed) && parsed === 125,
    `the written value must be the JSON integer 125, got ${JSON.stringify(wValue)}`);
});

check("re-applying the already-stored percent performs no write", () => {
  const g = boot(960, 600, { [KEY]: "125" });
  setSlider(g, 125);
  assert(g.storage.writes.length === 0,
    `a no-op move must not rewrite storage, writes were ${JSON.stringify(g.storage.writes)}`);
});

check("after a simulated reload (fresh vm sandbox, same backing store) the slider restores the stored percent", () => {
  const before = boot(960, 600);
  setSlider(before, 75);
  assert(before.store[KEY] === "75",
    `the first session must persist 75, got ${JSON.stringify(before.store[KEY])}`);
  const after = boot(960, 600, before.store);
  assert(after !== before, "the reload must be a distinct vm sandbox");
  assert(after.els["ball-speed"].value === "75",
    `the reloaded slider must read 75, got ${JSON.stringify(after.els["ball-speed"].value)}`);
});

check("a programmatic out-of-range slider write clamps into [50, 150]", () => {
  const g = boot(960, 600);
  setSlider(g, 10);
  assert(g.q("ballSpeedPct") === 50,
    `a sub-floor write must clamp to 50, got ${g.q("ballSpeedPct")}`);
  setSlider(g, 999);
  assert(g.q("ballSpeedPct") === 150,
    `an above-ceiling write must clamp to 150, got ${g.q("ballSpeedPct")}`);
});

// ================================================================
// Scales, never replaces: the named var knobs keep their values;
// the same factor scales every difficulty preset's serve
// ================================================================
check("the slider scales the named knobs without replacing them (BALL_SERVE_SPEED/MAX_BALL_SPEED untouched)", () => {
  const g = boot(960, 600, { [KEY]: "125" });
  g.els["btn-start"].click();
  assert(g.q("BALL_SERVE_SPEED") === 480,
    `BALL_SERVE_SPEED must stay 480, got ${g.q("BALL_SERVE_SPEED")}`);
  assert(g.q("MAX_BALL_SPEED") === 1500,
    `MAX_BALL_SPEED must stay 1500, got ${g.q("MAX_BALL_SPEED")}`);
  assert(g.q("serveSpeed") === 600 && g.q("serveCeiling") === 1875,
    `the run must carry the scaled values (600 / 1875), got ${g.q("serveSpeed")} / ${g.q("serveCeiling")}`);
});

check("the same factor scales every difficulty preset's serve (hard at 125% = 700)", () => {
  const g = boot(960, 600, { [KEY]: "125", "brickbreaker.difficulty": '"hard"' });
  g.els["btn-start"].click();
  const hardServe = g.q("DIFFICULTY.hard.serveSpeed");
  assert(g.q("serveSpeed") === hardServe * 1.25,
    `the hard preset's serve must be scaled by the same 1.25 factor (${hardServe * 1.25}), got ${g.q("serveSpeed")}`);
  assert(g.q("serveCeiling") === 1875,
    `the ceiling must scale identically regardless of preset, got ${g.q("serveCeiling")}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
