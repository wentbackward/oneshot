#!/usr/bin/env node
// ================================================================
// VM-boot draw-recording tests — fishtank atmosphere (ticket #125,
// PRD §3 "Atmospheric Rendering"): the lighting cycle, caustic
// shafts, bubble column and parallax substrate are proven from the
// REAL committed bundle the way a user experiences them.
//
// Harness: the bundled <script> from fishtank.html boots in a
// sandboxed node:vm context whose 2d context RECORDS drawing
// events (kind + selected arguments) into a flat per-boot log,
// opt-in per event kind so each check pays only for what it
// audits. Frames are driven through the captured requestAnimation-
// Frame callback at a fixed 17 ms interval (just above 60 fps), so
// every frame consumes exactly one FIXED_DT sim step (world.time is
// the ground truth).
// No network, no browser.
//
// Draw order per frame (src/render/renderer.ts owns it, the parsers
// below rely on it): ambient backdrop -> substrate far -> substrate
// near -> caustic shafts (5, each inside save/translate/restore) ->
// surface ripples -> tetra spines -> bubble column. The backdrop's
// gradient therefore always emits a frame's FIRST two 'stop'
// events: its (surface, depth) pair IS the scene ambient.
//
// Requires `npm ci` first (like every build-dependent check).
//
// Run: node tests/fishtank-atmosphere.test.mjs
// ================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  CYCLE_DURATION,
  DAY_DURATION,
  DUSK_DURATION,
  NIGHT_DURATION,
  LIGHT_DAY,
  LIGHT_DUSK,
  LIGHT_NIGHT,
  lightPhaseAt,
} from "../src/render/lighting.ts";
import { FIXED_DT } from "../src/sim/constants.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "fishtank.html"), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("no <script> block found in fishtank.html");
const gameSource = scriptMatch[1];

/** Wall-clock interval between driven frames in ms. Deliberately
 *  a touch FASTER than 60 fps (17 ms > 1/60 s): every frame
 *  consumes EXACTLY one FIXED_DT sim step and the leftover acc
 *  stays constant, so frame k renders at exactly k fixed steps of
 *  sim time — no floating-point drift from 1000/60 ms arithmetic. */
const FRAME_MS = 17;

// ---------- tiny test harness (house style) ----------
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

// ---------- vm stubs with a recording 2d context ----------

// A 2d-context stub: whitelisted drawing methods are recorded into
// state.events as { kind, args } events, but ONLY for kinds enabled
// at boot (opt-in keeps the 1000-frame checks fast); every property
// set (fillStyle, lineWidth, ...) is absorbed. Calls to methods NOT
// in the whitelist come back undefined and throw — that is the
// signal to extend the stub deliberately. Factory methods
// (gradients) return working stand-ins so addColorStop colours are
// captured too.
const ARG_METHODS = [
  "arc", "ellipse", "translate", "scale", "rotate", "setTransform",
  "moveTo", "lineTo", "rect", "quadraticCurveTo", "bezierCurveTo",
  "fillText", "strokeText", "drawImage",
];
const PLAIN_METHODS = [
  "clearRect", "fillRect", "strokeRect", "closePath", "beginPath",
  "fill", "stroke", "save", "restore",
];

function makeRecordingCtx(state) {
  const gradient = () => ({ addColorStop: (pos, color) => state.emit("stop", { pos, color }) });
  const target = {
    canvas: state.canvas,
    createLinearGradient: () => { state.emit("gradient"); return gradient(); },
    createRadialGradient: () => { state.emit("gradient"); return gradient(); },
    createPattern: () => { state.emit("pattern"); return {}; },
    createImageBitmap: () => { state.emit("imageBitmap"); return Promise.resolve({}); },
    measureText: () => ({ width: 0 }),
  };
  for (const m of ARG_METHODS) {
    target[m] = (...args) => state.emit(m, args.slice(0, 8));
  }
  for (const m of PLAIN_METHODS) target[m] = () => state.emit(m);
  return new Proxy(target, {
    get(t, prop) {
      if (prop === Symbol.toPrimitive) return undefined;
      return t[prop];
    },
    set() {
      return true; // absorb fillStyle / strokeStyle / lineWidth writes
    },
  });
}

function makeCanvas(state) {
  let ctx;
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: (kind) => {
      assert(kind === "2d", `only the 2d context is supported, got ${kind}`);
      return ctx;
    },
  };
  ctx = makeRecordingCtx(state, canvas);
  return canvas;
}

// Boot the REAL bundled script from the committed fishtank.html,
// enabling the named event kinds on the recording context.
function boot(width, height, enabledKinds) {
  const state = {
    events: [],
    enabled: new Set(enabledKinds),
    emit(kind, args) {
      if (!this.enabled.has(kind)) return;
      this.events.push(args === undefined ? kind : { kind, args });
    },
    canvas: null,
  };
  const canvas = makeCanvas(state);
  state.canvas = canvas;
  let rafCb = null;
  let rafSeq = 0;
  const win = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    addEventListener: () => {},
    requestAnimationFrame: (cb) => {
      rafCb = cb;
      return ++rafSeq;
    },
  };
  const sandbox = {
    window: win,
    document: { getElementById: (id) => (id === "game" ? canvas : null) },
  };
  vm.createContext(sandbox);
  vm.runInContext(gameSource, sandbox);

  function frameAt(ms) {
    const cb = rafCb;
    if (typeof cb !== "function") throw new Error("the rAF loop stopped scheduling frames");
    rafCb = null;
    cb(ms);
  }
  return {
    state,
    frameAt,
    tick: (n, fromMs) => {
      let now = fromMs ?? 0;
      for (let i = 0; i < n; i++) {
        now += FRAME_MS;
        frameAt(now);
      }
    },
    /** Drive n frames at the SAME timestamp: elapsed 0 s, so the
     *  world takes ZERO steps — the harness-level stand-in for a
     *  paused sim. */
    frozenFrames: (n, atMs) => {
      for (let i = 0; i < n; i++) frameAt(atMs);
    },
    q: (expr) => vm.runInContext(expr, sandbox),
  };
}

/** The frame's ambient = its FIRST two 'stop' events (the backdrop
 *  gradient, emitted before any other geometry — see the draw order
 *  banner up top). */
function ambientPair(state, fromIdx) {
  const stops = [];
  for (const ev of state.events.slice(fromIdx)) {
    if (ev.kind === "stop") stops.push(ev.args.color);
    if (stops.length === 2) return stops;
  }
  throw new Error("frame carried fewer than two gradient stops — no ambient backdrop was painted");
}

const PALETTE_BY_STOPS = [
  [LIGHT_DAY.surface, LIGHT_DAY.depth, "LIGHT_DAY"],
  [LIGHT_DUSK.surface, LIGHT_DUSK.depth, "LIGHT_DUSK"],
  [LIGHT_NIGHT.surface, LIGHT_NIGHT.depth, "LIGHT_NIGHT"],
];
function paletteName(surface, depth) {
  for (const [s, d, name] of PALETTE_BY_STOPS) {
    if (s === surface && d === depth) return name;
  }
  throw new Error(`unknown ambient pair (${surface}, ${depth}) — the scene left the three named palettes`);
}

// ================================================================
// AC1: over one full lighting cycle the scene ambient passes
// through EXACTLY THREE distinct named palettes (LIGHT_DAY,
// LIGHT_DUSK, LIGHT_NIGHT) in order, each holding its named
// duration of SIM TIME (+/- 1 step)
// ================================================================
check("AC1: over one full cycle the ambient walks LIGHT_DAY -> LIGHT_DUSK -> LIGHT_NIGHT in order, each phase held for its named sim-time duration (+/- 1 step)", () => {
  for (const [label, duration] of [
    ["DAY", DAY_DURATION], ["DUSK", DUSK_DURATION], ["NIGHT", NIGHT_DURATION],
  ]) {
    assert(Number.isFinite(duration) && duration > 0, `${label}_DURATION must be positive, got ${duration}`);
    assert(Number.isInteger(duration / FIXED_DT),
      `${label}_DURATION (${duration}s) must be an exact multiple of FIXED_DT so phase boundaries land on step boundaries`);
  }
  // The 17 ms wall interval is NOT commensurate with FIXED_DT, so a
  // given frame takes 0, 1 or 2 fixed steps (the app's accumulator
  // working as designed). The audit is therefore against SIM time
  // (the ground truth the cycle is defined on): every frame's
  // recorded ambient must equal the palette holding at the world
  // clock it rendered at, and each phase must begin within one step
  // of its named sim-time boundary.
  const g = boot(640, 360, ["stop"]);
  const rows = []; // { t, name } per rendered frame
  const record = (fromIdx) => {
    const [surface, depth] = ambientPair(g.state, fromIdx);
    rows.push({ t: g.q("FISH_TANK_WORLD.time"), name: paletteName(surface, depth) });
  };
  g.frameAt(0); // frame 0: t = 0, the cycle's opening
  record(0);
  let frames = 1;
  while (rows[rows.length - 1].t < CYCLE_DURATION + 1 && frames < 8000) {
    const fromIdx = g.state.events.length;
    g.tick(1, (frames - 1) * FRAME_MS);
    record(fromIdx);
    frames += 1;
  }

  // Clock hygiene: sim time only moves forward, at most 2 steps per frame.
  for (let k = 1; k < rows.length; k++) {
    assert(rows[k].t >= rows[k - 1].t, `sim time must not move backwards (frame ${k})`);
    assert(rows[k].t - rows[k - 1].t <= 2 * FIXED_DT + 1e-9,
      `a single frame may take at most 2 fixed steps (frame ${k} jumped ${rows[k].t - rows[k - 1].t}s)`);
  }
  assert(rows[rows.length - 1].t >= CYCLE_DURATION + 1,
    `the run must lap the whole ${CYCLE_DURATION}s cycle, reached only t = ${rows[rows.length - 1].t}s`);

  // (a) exactly the three named palettes, all seen.
  const seen = [...new Set(rows.map((r) => r.name))].sort();
  assert(JSON.stringify(seen) === JSON.stringify(["LIGHT_DAY", "LIGHT_DUSK", "LIGHT_NIGHT"]),
    `the ambient must visit exactly the three named palettes, saw ${JSON.stringify(seen)}`);

  // (b) every frame's ambient equals the palette holding at ITS
  //     rendered sim time — sim-time driven, not wall-clock driven.
  for (const [k, row] of rows.entries()) {
    const expected = lightPhaseAt(row.t).palette.name;
    assert(row.name === expected,
      `at t = ${row.t}s (frame ${k}) the ambient is ${row.name} but the cycle says ${expected}`);
  }

  // (c) each later phase begins within one step of its named sim-time boundary.
  const firstOf = (name) => rows.find((r) => r.name === name);
  const duskStart = DAY_DURATION;
  const nightStart = DAY_DURATION + DUSK_DURATION;
  const d = firstOf("LIGHT_DUSK");
  const n = firstOf("LIGHT_NIGHT");
  assert(Math.abs(d.t - duskStart) <= FIXED_DT * (1 + 1e-9),
    `LIGHT_DUSK must begin at t = ${duskStart}s (+/- 1 step), first DUSK ambient at t = ${d.t}s`);
  assert(Math.abs(n.t - nightStart) <= FIXED_DT * (1 + 1e-9),
    `LIGHT_NIGHT must begin at t = ${nightStart}s (+/- 1 step), first NIGHT ambient at t = ${n.t}s`);

  // (d) the walk only ADVANCES before the wrap (no re-entry), and
  //     the lap back to LIGHT_DAY lands within one step of t = CYCLE_DURATION.
  const order = ["LIGHT_DAY", "LIGHT_DUSK", "LIGHT_NIGHT"];
  const rank = (name) => order.indexOf(name);
  const firstLapIdx = rows.findIndex((r) => r.t >= CYCLE_DURATION);
  for (let k = 1; k < firstLapIdx; k++) {
    assert(rank(rows[k].name) >= rank(rows[k - 1].name),
      `the cycle may only advance (frame ${k}: ${rows[k - 1].name} -> ${rows[k].name}) before the wrap`);
  }
  assert(firstLapIdx !== -1, "no frame rendered at or past t = CYCLE_DURATION");
  const firstDayAfterLap = rows.find((r) => r.t >= CYCLE_DURATION && r.name === "LIGHT_DAY");
  assert(firstDayAfterLap !== undefined,
    "the ambient never returned to LIGHT_DAY after the cycle lap");
  assert(Math.abs(firstDayAfterLap.t - CYCLE_DURATION) <= FIXED_DT * (1 + 1e-9),
    `the wrap to LIGHT_DAY must land at t = ${CYCLE_DURATION}s (+/- 1 step), first post-lap DAY at t = ${firstDayAfterLap.t}s`);
});

check("AC1: pausing the sim (zero steps) freezes the lighting phase and its ambient fills", () => {
  const g = boot(640, 360, ["stop"]);
  g.frameAt(0);
  const intoDuskSteps = Math.round((DAY_DURATION + DUSK_DURATION / 2) / FIXED_DT); // ~ t = 52.5 s
  g.tick(intoDuskSteps, 0);
  const tBefore = g.q("FISH_TANK_WORLD.time");
  assert(tBefore > DAY_DURATION + 1 && tBefore < DAY_DURATION + DUSK_DURATION - 1,
    `test setup: sim must have reached mid-DUSK, it reached t = ${tBefore}s`);

  // The latest frame's ambient = the last two 'stop' events recorded.
  const stopColors = g.state.events.filter((ev) => ev.kind === "stop").map((ev) => ev.args.color);
  const before = stopColors.slice(-2);
  assert(stopColors.length >= 2, "test setup: no ambient backdrop was painted");
  assert(paletteName(before[0], before[1]) === "LIGHT_DUSK",
    `mid-cycle ambient should be LIGHT_DUSK, got ${paletteName(before[0], before[1])}`);

  const frozenTs = intoDuskSteps * FRAME_MS;
  for (let i = 0; i < 60; i++) {
    const si = g.state.events.length;
    g.frozenFrames(1, frozenTs);
    const amb = ambientPair(g.state, si);
    assert(amb[0] === before[0] && amb[1] === before[1],
      `frozen frame ${i}: ambient drifted (${amb[0]}, ${amb[1]}) vs (${before[0]}, ${before[1]}) — the phase did not freeze`);
  }
  const tAfter = g.q("FISH_TANK_WORLD.time");
  assert(tAfter === tBefore,
    `a paused sim must take zero steps (time ${tBefore} -> ${tAfter})`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
