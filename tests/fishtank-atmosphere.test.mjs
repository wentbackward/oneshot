#!/usr/bin/env node
// ================================================================
// VM-boot draw-recording tests — fishtank atmosphere (ticket #125,
// PRD §3 "Atmospheric Rendering"): the lighting cycle, caustic
// shafts, bubble column and parallax substrate are proven from the
// REAL committed bundle the way a user experiences them.
//
// REWRITTEN FOR TICKET #139 (the ticket's known test consequence):
// the scene now carries EMBEDDED ART (the #137 placeholder set) —
// background, caustics tile, gravel band, pebble/kelp/fish/bubble
// sprites — so the OLD audits on per-frame ARC OP COUNTS and
// "no drawImage anywhere" no longer describe the render. The new
// render contract this file pins instead:
//   - every frame's BITMAP draws are exactly the documented art
//     slots in the renderer's draw order: 1 background · gravel
//     band · caustics-tile grid · (placed scenery) · one body
//     sprite per live swimmer · the BUBBLE_POOL_SIZE pooled
//     bubbles LAST (nothing bitmap-drawing follows them);
//   - the caustics-tile grid is seamless AND ANIMATED: it scrolls
//     proportionally to sim time (the AC2 linearity intent, now
//     for the tile's recorded positions);
//   - the bubble pool recycles its slots (stable per-slot sprite
//     sizes) and wobbles sinusoidally (recorded drawImage
//     CENTERS, replacing the old arc positions — same invariant).
// The layers that stay vector (backdrop, substrate, caustic
// SHIFTS) keep their ORIGINAL audits unchanged.
//
// Harness: the bundled <script> from fishtank.html boots in a
// sandboxed node:vm context whose 2d context RECORDS drawing
// events (kind + selected arguments) into a flat per-boot log,
// opt-in per event kind so each check pays only for what it
// audits. Frames are driven through the captured requestAnimation-
// Frame callback at a fixed 17 ms interval (a hair SLOWER than 60
// fps), so most frames consume one FIXED_DT sim step and an
// occasional frame consumes two (the app's accumulator catching
// up) — those 2-step frames are what the AC1/AC2 pins rely on, and
// world.time is the ground truth everywhere below. The sandbox
// carries a stubbed SYNCHRONOUS createImageBitmap/atob pair (the
// fake bitmap reads its slot's real dimensions from the PNG IHDR),
// so the decode path runs and the art slots draw. No network, no
// browser.
//
// Draw order per frame (src/render/renderer.ts owns it, the
// parsers below rely on it): ambient backdrop -> background
// texture -> substrate far -> substrate near -> gravel texture ->
// caustic shafts (5, each inside save/translate/restore) ->
// caustics-tile grid -> surface ripples -> kelp -> rocks -> angel
// bodies -> tetra bodies -> predator body -> pellets -> bubble
// column -> shockwaves. The backdrop's gradient therefore always
// emits a frame's FIRST two 'stop' events: its (surface, depth)
// pair IS the scene ambient.
//
// Requires `npm ci` first (like every build-dependent check).
//
// Run: node tests/fishtank-atmosphere.test.mjs
// =================================================================
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
import {
  CAUSTIC_SHAFTS,
  CAUSTIC_SWEEP_SPEED,
  CAUSTICS_TILE_CELL,
  CAUSTICS_TILE_DRIFT,
} from "../src/render/caustics.ts";
import { GRAVEL_TEXTURE_BAND } from "../src/render/renderer.ts";
import { BUBBLE_MARGIN, BUBBLE_POOL_SIZE, BUBBLE_WOBBLE_AMP } from "../src/render/bubbles.ts";
import {
  SUBSTRATE_GRAVEL_COUNT,
  SUBSTRATE_DECOR_ROCKS,
  SUBSTRATE_KELP_TUFTS,
  SUBSTRATE_FAR_DRIFT,
  SUBSTRATE_NEAR_DRIFT,
} from "../src/render/substrate.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "fishtank.html"), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("no <script> block found in fishtank.html");
const gameSource = scriptMatch[1];

// The manifest is DATA (declared slot geometry), not source: the
// gravel-band count below derives from the tile's dimensions.
const MANIFEST = JSON.parse(readFileSync(path.join(root, "assets", "fishtank", "manifest.json"), "utf8"));
const SLOT = {};
for (const entry of MANIFEST.entries) SLOT[entry.name] = entry;

/** Wall-clock interval between driven frames in ms. Deliberately a
 *  touch SLOWER than 60 fps (17 ms > 16.67 ms = 1/60 s): each frame
 *  takes at least one FIXED_DT step, and the leftover ~0.33 ms
 *  accumulates until an occasional frame takes two steps — the
 *  fixed-step accumulator working as designed. Sim time (not frame
 *  count) is the ground truth in every audit below. */
const FRAME_MS = 17;

// ---------- tiny test harness (house style, ordered async-aware) ----------
// Decoder boots settle their decodes on the microtask queue (the
// boot's real Promise chain), so checks are awaited IN ORDER by
// runAll — output stays sequential and deterministic.
let passed = 0;
let failed = 0;
const queue = [];
function check(name, fn) {
  queue.push([name, fn]);
}
async function runAll() {
  for (const [name, fn] of queue) {
    try {
      await fn();
      passed += 1;
      console.log(`ok   - ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${name}\n       ${err.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Flush the isolate's microtask queue (the vm's Promise settles
 *  land there): the decode chain finishes and the loop registers
 *  before the first frame is driven. */
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
async function boot(width, height, enabledKinds) {
  const state = {
    events: [],
    enabled: new Set(enabledKinds),
    emit(kind, args) {
      if (!this.enabled.has(kind)) return;
      this.events.push({ kind, args });
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
    // Ticket #139: the art path runs in this suite — the stubbed
    // decode reads the slot's REAL dimensions from the PNG IHDR
    // (big-endian uint32 widths at byte 16, heights at 20, read
    // per-byte: this toolchain's V8 build has no typed-array
    // byte-access methods). The boot hands over a Blob where the
    // sandbox carries one (Node ≥ 24 vm contexts do), else a raw
    // ArrayBuffer — the stub reads the bytes either way (only a
    // Blob exposes arrayBuffer()). Settles as a real Promise;
    // boot() flushes the microtask queue before returning, so the
    // loop is registered by the time the first frame is driven.
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    createImageBitmap: async (buf) => {
      const bytes = new Uint8Array(typeof buf.arrayBuffer === "function" ? await buf.arrayBuffer() : buf);
      const dim = (at) => bytes[at] * 16777216 + bytes[at + 1] * 65536 + bytes[at + 2] * 256 + bytes[at + 3];
      return { fakeBitmap: true, width: dim(16), height: dim(20) };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(gameSource, sandbox);
  await flushMicrotasks(); // decodes settle, the loop registers

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
check("AC1: over one full cycle the ambient walks LIGHT_DAY -> LIGHT_DUSK -> LIGHT_NIGHT in order, each phase held for its named sim-time duration (+/- 1 step)", async () => {
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
  const g = await boot(640, 360, ["stop"]);
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

check("AC1: pausing the sim (zero steps) freezes the lighting phase and its ambient fills", async () => {
  const g = await boot(640, 360, ["stop"]);
  g.frameAt(0);
  const intoDuskSteps = Math.round((DAY_DURATION + DUSK_DURATION / 2) / FIXED_DT); // ~ t = 52.5 s
  g.tick(intoDuskSteps - 1, 0);
  const beforeIdx = g.state.events.length;
  g.tick(1, (intoDuskSteps - 1) * FRAME_MS); // one auditable last frame
  const tBefore = g.q("FISH_TANK_WORLD.time");
  assert(tBefore > DAY_DURATION + 1 && tBefore < DAY_DURATION + DUSK_DURATION - 1,
    `test setup: sim must have reached mid-DUSK, it reached t = ${tBefore}s`);

  // The latest frame's ambient = its FIRST two stops (the backdrop
  // gradient is always emitted before any caustic or other stop).
  const before = ambientPair(g.state, beforeIdx);
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

// ================================================================
// AC2: caustic light shafts — every frame issues the shaft
// GRADIENT draws (backdrop + one per shaft, two stops each, and
// each shaft is placed by its own recorded translate), and the
// shaft phase advances PROPORTIONALLY TO SIM TIME: two frames two
// fixed steps apart advance the phase by exactly twice one
// step's increment (recorded translate parameters)
// ================================================================
/** Split the boot's event log into per-frame slices (one slice per
 *  rendered frame; frameAt(0) is slice 0). */
function framesOf(g) {
  // The caller records the slice boundaries as it drives frames; a
  // boot that only tick()'d keeps its own `marks`.
  const marks = g.marks ?? [];
  const out = [];
  for (let k = 0; k + 1 < marks.length; k++) {
    out.push(g.state.events.slice(marks[k], marks[k + 1]));
  }
  return out;
}

/** The recorded shaft translate for shaft k of one frame's event
 *  slice: the 'translate' event sitting immediately BEFORE the
 *  (k+1)-th 'gradient' of the frame (k = 0..4; gradient 0 is the
 *  backdrop — it carries no translate, so the k-th shaft's translate
 *  fronts its own gradient). Throws if the structure the renderer
 *  promises is not there. */
function shaftTranslate(slice, k) {
  const grads = [];
  for (const ev of slice) if (ev.kind === "gradient") grads.push(ev);
  if (grads.length < CAUSTIC_SHAFTS + 1) {
    throw new Error(`frame carries only ${grads.length} gradients — the shafts did not issue gradient draws`);
  }
  const idx = slice.indexOf(grads[k + 1]);
  const place = slice[idx - 1];
  if (place?.kind !== "translate") {
    throw new Error(`shaft ${k} is not placed by its own translate (found ${JSON.stringify(place)})`);
  }
  return place.args[0]; // translate(x, y)
}

check("AC2: every frame issues the caustic shaft gradient draws, each placed by its own translate", async () => {
  assert(CAUSTIC_SHAFTS >= 2, `test setup: expected several shafts, got ${CAUSTIC_SHAFTS}`);
  const g = await boot(800, 600, ["gradient", "stop", "translate"]);
  g.marks = [0];
  g.frameAt(0);
  g.marks.push(g.state.events.length);
  for (let f = 1; f <= 5; f++) {
    g.tick(1, (f - 1) * FRAME_MS);
    g.marks.push(g.state.events.length);
  }
  for (const [f, slice] of framesOf(g).entries()) {
    const grads = slice.filter((ev) => ev.kind === "gradient").length;
    const stops = slice.filter((ev) => ev.kind === "stop").length;
    assert(grads === CAUSTIC_SHAFTS + 1,
      `frame ${f}: expected 1 backdrop + ${CAUSTIC_SHAFTS} shaft gradients, got ${grads}`);
    assert(stops === grads * 2,
      `frame ${f}: every gradient must carry exactly two stops, got ${stops} for ${grads}`);
    for (let k = 0; k < CAUSTIC_SHAFTS; k++) {
      const x = shaftTranslate(slice, k); // throws if the structure is off
      assert(Number.isFinite(x), `frame ${f} shaft ${k}: translate x went non-finite (${x})`);
    }
    // The shafts are tinted by the ACTIVE lighting palette (t=0.. is LIGHT_DAY).
    const shaftStops = slice.filter((ev) => ev.kind === "stop").slice(2);
    assert(shaftStops.every((ev) => ev.args.color.startsWith(`rgba(${LIGHT_DAY.causticRgb}, `)),
      `frame ${f}: a shaft gradient stop is not tinted by the active palette (${LIGHT_DAY.name})`);
  }
});

check("AC2 (review should-fix): the sawtooth sweep wrap is masked — a shaft at the wrap paints at zero alpha, the fade only attenuates, and mid-sweep the shaft reaches its caustic base alpha", async () => {
  const g = await boot(800, 600, ["gradient", "stop"]);
  const parseAlpha = (color) => Number(color.slice(color.lastIndexOf(", ") + 2, -1));
  const firstShaftStop = (slice, k) => {
    const grads = [];
    for (const ev of slice) if (ev.kind === "gradient") grads.push(ev);
    const stop = slice[slice.indexOf(grads[k + 1]) + 1];
    assert(stop?.kind === "stop", `shaft ${k}'s gradient carries no first stop`);
    return stop.args.color;
  };
  // 300 frames (~5.1 s of sim, all within LIGHT_DAY): spans shaft 0
  // from its wrap (t = 0) into its fully-open mid-sweep (the fade
  // window ends at t = 5 s).
  const slices = [];
  g.frameAt(0);
  slices.push(g.state.events.slice(0));
  for (let f = 1; f < 300; f++) {
    const from = g.state.events.length;
    g.tick(1, (f - 1) * FRAME_MS);
    slices.push(g.state.events.slice(from));
  }
  // (a) At t = 0 shaft 0 sits exactly on its sweep wrap: masked to
  //     zero alpha (before the fix it painted at full caustic base
  //     alpha and then snapped 120 px laterally).
  assert(parseAlpha(firstShaftStop(slices[0], 0)) === 0,
    `shaft 0 at its sweep wrap must paint at zero alpha, got ${firstShaftStop(slices[0], 0)}`);
  // (b) The fade only ATTENUATES: no shaft's alpha ever leaves
  //     [0, base + pulse] over the whole window (slack covers FP
  //     addition plus the toFixed(4) rounding of the recorded stop).
  const ceiling = LIGHT_DAY.causticBaseAlpha + LIGHT_DAY.causticPulseAlpha;
  for (let f = 0; f < slices.length; f++) {
    for (let k = 0; k < CAUSTIC_SHAFTS; k++) {
      const a = parseAlpha(firstShaftStop(slices[f], k));
      assert(a >= -1e-9 && a <= ceiling + 1e-4,
        `frame ${f} shaft ${k}: alpha ${a} escaped [0, ${ceiling}] — the wrap fade amplified the shaft`);
    }
  }
  // (c) And the mask opens again: past its fade window (t >= 5 s)
  //     shaft 0 reaches its full caustic base alpha mid-sweep.
  let peak = 0;
  for (const sl of slices) peak = Math.max(peak, parseAlpha(firstShaftStop(sl, 0)));
  assert(peak >= LIGHT_DAY.causticBaseAlpha,
    `shaft 0 peaked at alpha ${peak} < caustic base ${LIGHT_DAY.causticBaseAlpha} — the fade never fully reopened mid-sweep`);
});

check("AC2: the shaft phase advances proportionally to sim time — a 2 x FIXED_DT gap advances exactly twice one step's increment", async () => {
  const g = await boot(800, 600, ["gradient", "translate"]);
  const EPS = 1e-9;
  const drive = () => {
    const from = g.state.events.length;
    g.tick(1, frames.length * FRAME_MS);
    const slice = g.state.events.slice(from);
    const xs = [];
    for (let k = 0; k < CAUSTIC_SHAFTS; k++) xs.push(shaftTranslate(slice, k));
    frames.push({ t: g.q("FISH_TANK_WORLD.time"), xs });
  };
  const frames = [];
  g.frameAt(0);
  {
    const xs = [];
    for (let k = 0; k < CAUSTIC_SHAFTS; k++) xs.push(shaftTranslate(g.state.events, k));
    frames.push({ t: 0, xs });
  }
  // Pinned inside a wrap interval: the ~3.4 s window ends ~0.6 s
  // before the first shaft's sweep wrap (shaft 4's, at t = 4 s), so
  // no recorded gap can straddle the sawtooth reset.
  for (let f = 0; f < 200; f++) drive();

  // Every adjacent frame pair moved an integral number of fixed
  // steps, and the phase increment was LINEAR in that gap: exactly
  // SWEEP_SPEED x dt for every one-step and every two-step frame.
  let oneStep = null;
  let twoStep = null;
  for (let k = 1; k < frames.length; k++) {
    const dt = frames[k].t - frames[k - 1].t;
    if (!(Math.abs(dt - FIXED_DT) <= EPS || Math.abs(dt - 2 * FIXED_DT) <= EPS)) {
      throw new Error(`frame ${k} moved ${dt}s of sim time — expected whole fixed steps`);
    }
    const expected = CAUSTIC_SWEEP_SPEED * dt;
    for (let s = 0; s < CAUSTIC_SHAFTS; s++) {
      const d = frames[k].xs[s] - frames[k - 1].xs[s];
      assert(Math.abs(d - expected) <= EPS,
        `shaft ${s}: a ${dt}s gap must advance the phase by ${expected}px (SWEEP_SPEED x dt), recorded ${d}px`);
    }
    if (Math.abs(dt - FIXED_DT) <= EPS) oneStep = frames[k].xs[0] - frames[k - 1].xs[0];
    else twoStep = frames[k].xs[0] - frames[k - 1].xs[0];
  }
  assert(oneStep !== null && twoStep !== null,
    "the 200-frame drive must include at least one one-step and one two-step frame");
  assert(Math.abs(twoStep - 2 * oneStep) <= EPS,
    `two frames 2 x FIXED_DT apart must advance the phase by exactly twice one step's increment (2 x ${oneStep}px = ${2 * oneStep}px, recorded ${twoStep}px)`);
});

check("AC2: pausing the sim freezes the shaft phase (the sweep is sim-time driven, not wall-clock driven)", async () => {
  const g = await boot(800, 600, ["gradient", "translate"]);
  g.frameAt(0);
  g.tick(5, 0);
  const from = g.state.events.length;
  g.tick(1, 5 * FRAME_MS);
  const live = [];
  for (let k = 0; k < CAUSTIC_SHAFTS; k++) live.push(shaftTranslate(g.state.events.slice(from), k));
  const tBefore = g.q("FISH_TANK_WORLD.time");
  for (let i = 0; i < 20; i++) {
    const f = g.state.events.length;
    g.frozenFrames(1, 6 * FRAME_MS);
    const slice = g.state.events.slice(f);
    for (let k = 0; k < CAUSTIC_SHAFTS; k++) {
      assert(shaftTranslate(slice, k) === live[k],
        `frozen frame ${i}: shaft ${k} translate drifted — the phase is not driven by sim time`);
    }
  }
  assert(g.q("FISH_TANK_WORLD.time") === tBefore, "a paused sim must take zero steps");
});

// ================================================================
// AC3 (REWRITTEN, ticket #139): bubbles — a POOL-BASED emitter
// (pool size named) recycles its slots without allocation, every
// frame releases exactly BUBBLE_POOL_SIZE bubble SPRITES with
// stable per-slot size across 1001 frames, and each rising bubble
// wobbles SINUSOIDALLY in x: >= 1 full wobble period per rise,
// amplitude within the named BUBBLE_WOBBLE_AMP (all from the
// recorded drawImage CENTERS — the slots moved from stroked arcs
// to sprites; the geometric invariant is unchanged)
// ================================================================

check("AC3: the bubble pool recycles without spawning — every one of 1001 frames releases exactly BUBBLE_POOL_SIZE bubble sprites with stable per-slot size", async () => {
  assert(Number.isInteger(BUBBLE_POOL_SIZE) && BUBBLE_POOL_SIZE > 0,
    `BUBBLE_POOL_SIZE must be a named positive integer, got ${BUBBLE_POOL_SIZE}`);
  const g = await boot(800, 600, ["drawImage"]);
  const widths = new Array(BUBBLE_POOL_SIZE).fill(null);
  for (let f = 0; f <= 1000; f++) {
    const from = g.state.events.length;
    if (f === 0) g.frameAt(0);
    else g.tick(1, (f - 1) * FRAME_MS);
    // Bubble sprites are the frame's LAST BUBBLE_POOL_SIZE bitmap
    // draws: nothing bitmap-drawing follows the column (pellets
    // and shockwaves stay vector). The swimmers' body sprites
    // precede them, in draw order.
    const di = g.state.events.slice(from).filter((ev) => ev.kind === "drawImage");
    const live = g.q("FISH_TANK_WORLD.agents.length") + g.q("FISH_TANK_WORLD.angels.length") + (g.q("FISH_TANK_WORLD.predator !== null") ? 1 : 0);
    assert(Number.isInteger(live) && live >= 0,
      `frame ${f}: live swimmer count came back ${live}, not a non-negative integer`);
    assert(di.length >= live + BUBBLE_POOL_SIZE,
      `frame ${f}: expected at least ${live} body sprites + ${BUBBLE_POOL_SIZE} pooled bubble sprites, got ${di.length} bitmap draws`);
    const bubbles = di.slice(-BUBBLE_POOL_SIZE);
    for (let i = 0; i < BUBBLE_POOL_SIZE; i++) {
      const [, dx, dy, dw, dh] = bubbles[i].args;
      assert(Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dw) && Number.isFinite(dh) && dw > 0 && dh > 0,
        `frame ${f} bubble ${i}: sprite draw went non-finite/non-positive (${dx}, ${dy}, ${dw}, ${dh})`);
      if (widths[i] === null) widths[i] = dw;
      else if (dw !== widths[i]) {
        throw new Error(`frame ${f} bubble ${i}: width changed ${widths[i]} -> ${dw} — the pool spawned new bubbles instead of recycling slots`);
      }
    }
  }
});

check("AC3: rising bubbles wobble sinusoidally in x — >= 1 full wobble period per rise, amplitude within BUBBLE_WOBBLE_AMP (recorded sprite centers)", async () => {
  const H = 600;
  const g = await boot(800, H, ["drawImage"]);
  const FRAMES = 2000; // ~34 s of sim: every pool slot completes >= 2 full rises
  const lanes = new Array(BUBBLE_POOL_SIZE).fill(null).map(() => []);
  for (let f = 0; f < FRAMES; f++) {
    const from = g.state.events.length;
    if (f === 0) g.frameAt(0);
    else g.tick(1, (f - 1) * FRAME_MS);
    const di = g.state.events.slice(from).filter((ev) => ev.kind === "drawImage");
    // The pooled bubbles trail in slot order (the last
    // BUBBLE_POOL_SIZE bitmap draws of the frame — see the
    // pool-recycle check above).
    const bubbles = di.slice(-BUBBLE_POOL_SIZE);
    assert(bubbles.length === BUBBLE_POOL_SIZE, `frame ${f}: the column released ${bubbles.length} sprites, not ${BUBBLE_POOL_SIZE}`);
    for (let i = 0; i < BUBBLE_POOL_SIZE; i++) {
      const [, dx, dy, dw, dh] = bubbles[i].args;
      lanes[i].push([dx + dw / 2, dy + dh / 2]); // sprite CENTER = the bubble's position
    }
  }
  const column = H + BUBBLE_MARGIN * 2; // the center's y travel: from +BUBBLE_MARGIN below to -BUBBLE_MARGIN above the tank
  for (let i = 0; i < BUBBLE_POOL_SIZE; i++) {
    const samples = lanes[i];
    // Longest monotone-rising run = one (near-)full ascent: y only
    // decreases while a bubble climbs; its wrap back to the bottom
    // breaks monotonicity.
    let best = { start: 0, end: 0 };
    let s = 0;
    for (let k = 1; k < samples.length; k++) {
      if (samples[k][1] <= samples[k - 1][1] + 1e-6) {
        if (k - s > best.end - best.start) best = { start: s, end: k };
      } else {
        s = k;
      }
    }
    const run = samples.slice(best.start, best.end + 1);
    const risen = run[0][1] - run[run.length - 1][1];
    assert(risen >= column * 0.9,
      `bubble ${i}: longest rising run only climbed ${risen}px of the ${column}px column — no full ascent was recorded`);
    const xs = run.map((a) => a[0]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const center = (minX + maxX) / 2;
    const halfRange = (maxX - minX) / 2;
    // Amplitude: the recorded excursion around the lane center is
    // the named wobble amplitude, neither larger nor meaningfully
    // smaller (60 fps samples >= 3 full periods per ascent).
    assert(halfRange <= BUBBLE_WOBBLE_AMP * 1.02 + 1e-6,
      `bubble ${i}: wobble amplitude ${halfRange}px exceeds BUBBLE_WOBBLE_AMP (${BUBBLE_WOBBLE_AMP}px)`);
    assert(halfRange >= BUBBLE_WOBBLE_AMP * 0.97,
      `bubble ${i}: recorded wobble only reached ${halfRange}px of BUBBLE_WOBBLE_AMP (${BUBBLE_WOBBLE_AMP}px) — no full period sampled`);
    // A full sinusoidal period crosses the lane center at least
    // twice; the three-period design lands on six.
    let crossings = 0;
    let prev = Math.sign(xs[0] - center);
    for (let k = 1; k < xs.length; k++) {
      const cur = Math.sign(xs[k] - center);
      if (prev !== 0 && cur !== 0 && cur !== prev) crossings += 1;
      if (cur !== 0) prev = cur;
    }
    assert(crossings >= 2,
      `bubble ${i}: only ${crossings} lane-center crossings in a full ascent — fewer than one wobble period per rise`);
    // And over the ENTIRE recording the bubble never leaves the
    // named amplitude band around its lane center.
    for (const [x] of samples) {
      assert(Math.abs(x - center) <= BUBBLE_WOBBLE_AMP * 1.05,
        `bubble ${i}: x = ${x} drifted ${Math.abs(x - center)}px from its lane — beyond BUBBLE_WOBBLE_AMP`);
    }
  }
});

// ================================================================
// AC4 (REWRITTEN, ticket #139): the scene is NO LONGER 100%
// procedural — it carries the #137/#139 embedded art set. The new
// render contract: every frame's bitmap draws are EXACTLY the
// documented art slots (1 background + gravel band + caustics-tile
// grid + one body sprite per live swimmer + the pooled bubbles)
// — no slot missing, no undrawn extras — and the caustics-tile
// grid scrolls proportionally to sim time (the AC2 linearity
// intent, now applied to the tile's recorded positions). The
// procedural-substrate audit above (named draw counts + parallax
// drift rates) stays as written: those layers remain vector.
// ================================================================

/** The frame's expected bitmap-draw count at 800×600 (the
 *  boot's viewport in this file): the constants mirror
 *  src/render/renderer.ts's overlay math. */
const VIEW_W = 800;
const VIEW_H = 600;
const GRAVEL_DRAWS = Math.ceil(VIEW_W / (VIEW_H * GRAVEL_TEXTURE_BAND * (SLOT["gravel-tile"].width / SLOT["gravel-tile"].height)));
const CAUSTICS_ROWS = Math.floor(VIEW_H / CAUSTICS_TILE_CELL) + 2;
const CAUSTICS_COLS = Math.floor(VIEW_W / CAUSTICS_TILE_CELL) + 2;
const CAUSTICS_DRAWS = CAUSTICS_ROWS * CAUSTICS_COLS;

check("AC4: every frame's bitmap draws are exactly the documented art slots — 1 background + gravel band + caustics-tile grid + one body sprite per live swimmer + the pooled bubbles (nothing missing, nothing extra)", async () => {
  const g = await boot(VIEW_W, VIEW_H, ["drawImage"]);
  const FRAMES = 120;
  for (let f = 0; f < FRAMES; f++) {
    const from = g.state.events.length;
    if (f === 0) g.frameAt(0);
    else g.tick(1, (f - 1) * FRAME_MS);
    const di = g.state.events.slice(from).filter((ev) => ev.kind === "drawImage");
    const live = g.q("FISH_TANK_WORLD.agents.length") + g.q("FISH_TANK_WORLD.angels.length") + (g.q("FISH_TANK_WORLD.predator !== null") ? 1 : 0);
    const expected = 1 + GRAVEL_DRAWS + CAUSTICS_DRAWS + live + BUBBLE_POOL_SIZE;
    assert(di.length === expected,
      `frame ${f}: expected ${expected} bitmap draws (1 bg + ${GRAVEL_DRAWS} gravel + ${CAUSTICS_DRAWS} caustics-tile + ${live} bodies + ${BUBBLE_POOL_SIZE} bubbles), got ${di.length}`);
  }
});

check("AC4: the caustics-tile grid is seamless-animated — its scroll phase advances PROPORTIONALLY TO SIM TIME (a 2 x FIXED_DT gap advances exactly twice one step's increment), recorded from the tile positions", async () => {
  assert(CAUSTICS_TILE_DRIFT > 0, "test setup: the tile must scroll");
  const EPS = 1e-9;
  const g = await boot(VIEW_W, VIEW_H, ["drawImage"]);
  // Tile (1, 0) — the second column of the grid — sits at
  // CAUSTICS_TILE_CELL - offset(t); the recorded x is the phase.
  const tileX = (slice) => slice.filter((ev) => ev.kind === "drawImage")
    [1 + GRAVEL_DRAWS + CAUSTICS_ROWS].args[1];
  const frames = [];
  g.frameAt(0);
  frames.push({ t: 0, x: tileX(g.state.events) });
  for (let f = 0; f < 200; f++) {
    const from = g.state.events.length;
    g.tick(1, (f + 1) * FRAME_MS);
    frames.push({ t: g.q("FISH_TANK_WORLD.time"), x: tileX(g.state.events.slice(from)) });
  }
  // The ~3.4 s window ends far short of the tile's wrap period
  // (CAUSTICS_TILE_CELL / CAUSTICS_TILE_DRIFT), so no recorded
  // gap can straddle the seamless reset.
  for (let k = 1; k < frames.length; k++) {
    const dt = frames[k].t - frames[k - 1].t;
    if (!(Math.abs(dt - FIXED_DT) <= EPS || Math.abs(dt - 2 * FIXED_DT) <= EPS)) {
      throw new Error(`frame ${k} moved ${dt}s of sim time — expected whole fixed steps`);
    }
    const expected = -CAUSTICS_TILE_DRIFT * dt; // the grid scrolls against the +x axis
    const d = frames[k].x - frames[k - 1].x;
    assert(Math.abs(d - expected) <= EPS,
      `caustics tile: a ${dt}s gap must advance the scroll by ${expected}px (DRIFT x dt), recorded ${d}px`);
  }
});

check("AC4: gravel and top-decor parallax layers render every frame with their named draw counts, and the near layer drifts faster than the far layer", async () => {
  assert(Number.isInteger(SUBSTRATE_GRAVEL_COUNT) && SUBSTRATE_GRAVEL_COUNT > 0, "gravel count must be a named positive constant");
  assert(
    SUBSTRATE_DECOR_ROCKS + SUBSTRATE_KELP_TUFTS >= 2 && SUBSTRATE_GRAVEL_COUNT >= 2,
    "at least two procedurally drawn substrate layers are required (gravel + decor)"
  );
  assert(SUBSTRATE_NEAR_DRIFT > SUBSTRATE_FAR_DRIFT > 0,
    `parallax requires the NEAR layer to drift faster (near ${SUBSTRATE_NEAR_DRIFT} <= far ${SUBSTRATE_FAR_DRIFT})`);
  const g = await boot(800, 600, ["translate", "ellipse", "beginPath", "fill", "stroke"]);
  const FRAMES = 120;
  const frames = [];
  for (let f = 0; f < FRAMES; f++) {
    const from = g.state.events.length;
    if (f === 0) g.frameAt(0);
    else g.tick(1, (f - 1) * FRAME_MS);
    frames.push(g.state.events.slice(from));
  }
  const EPS = 1e-9;
  for (const [f, slice] of frames.entries()) {
    // Draw order (renderer.ts): the TWO substrate translates come
    // before the caustic shaft translates. Everything between
    // translate #1 and #2 is the far (gravel) layer; between #2
    // and #3 the near (decor) layer. Each element is painted twice
    // (tile-doubled, tile width = viewport) for a seamless wrap.
    const trans = slice.filter((ev) => ev.kind === "translate");
    assert(trans.length >= 3, `frame ${f}: expected the 2 substrate translates + 5 caustic translates, got ${trans.length}`);
    const farIdx = slice.indexOf(trans[0]);
    const nearIdx = slice.indexOf(trans[1]);
    const causticIdx = slice.indexOf(trans[2]);
    assert(farIdx < nearIdx && nearIdx < causticIdx, `frame ${f}: substrate layers are not drawn before the caustics`);
    const farSlice = slice.slice(farIdx, nearIdx);
    const nearSlice = slice.slice(nearIdx, causticIdx);
    const count = (arr, kind) => arr.filter((ev) => ev.kind === kind).length;
    assert(count(farSlice, "ellipse") === 2 * SUBSTRATE_GRAVEL_COUNT && count(farSlice, "beginPath") === 2 * SUBSTRATE_GRAVEL_COUNT && count(farSlice, "fill") === 2 * SUBSTRATE_GRAVEL_COUNT,
      `frame ${f}: far layer must draw ${2 * SUBSTRATE_GRAVEL_COUNT} tile-doubled gravel ellipses, got ${count(farSlice, "ellipse")}`);
    const nearBegin = 2 * (SUBSTRATE_DECOR_ROCKS + SUBSTRATE_KELP_TUFTS);
    assert(count(nearSlice, "ellipse") === 2 * SUBSTRATE_DECOR_ROCKS && count(nearSlice, "fill") === 2 * SUBSTRATE_DECOR_ROCKS,
      `frame ${f}: near layer must draw ${2 * SUBSTRATE_DECOR_ROCKS} tile-doubled decor rocks, got ${count(nearSlice, "ellipse")}`);
    assert(count(nearSlice, "beginPath") === nearBegin && count(nearSlice, "stroke") === 2 * SUBSTRATE_KELP_TUFTS,
      `frame ${f}: near layer must draw ${SUBSTRATE_KELP_TUFTS} tiled kelp tufts, got ${count(nearSlice, "stroke")} kelp strokes`);
  }
  // Parallax rates: audit the drifts on a fresh boot so the sim-
  // time bookkeeping stays local.
  const h = await boot(800, 600, ["translate"]);
  const drift = [];
  const collect = (fromIdx) => {
    const pair = h.state.events.slice(fromIdx).filter((ev) => ev.kind === "translate");
    drift.push({ t: h.q("FISH_TANK_WORLD.time"), far: pair[0]?.args[0] ?? NaN, near: pair[1]?.args[0] ?? NaN });
  };
  // Pinned inside a wrap interval: the ~2 s audit window ends far
  // short of the near layer's tile wrap (~266 s at 800 px / 3.0 px/s),
  // so no recorded drift gap can straddle a reset.
  h.frameAt(0);
  collect(0);
  for (let f = 1; f < FRAMES; f++) {
    const start = h.state.events.length;
    h.tick(1, (f - 1) * FRAME_MS);
    collect(start);
  }
  const ratio = SUBSTRATE_NEAR_DRIFT / SUBSTRATE_FAR_DRIFT;
  for (let f = 1; f < drift.length; f++) {
    const dt = drift[f].t - drift[f - 1].t;
    const df = drift[f].far - drift[f - 1].far;
    const dn = drift[f].near - drift[f - 1].near;
    assert(Math.abs(df - SUBSTRATE_FAR_DRIFT * dt) <= EPS,
      `frame ${f}: far layer drifted ${df}px over ${dt}s — not SUBSTRATE_FAR_DRIFT x dt`);
    assert(Math.abs(dn - SUBSTRATE_NEAR_DRIFT * dt) <= EPS,
      `frame ${f}: near layer drifted ${dn}px over ${dt}s — not SUBSTRATE_NEAR_DRIFT x dt`);
    assert(Math.abs(dn - ratio * df) <= EPS,
      `frame ${f}: parallax ratio broke — near drift ${dn}px vs ${ratio} x far drift ${df}px`);
  }
});

// ---------- run ----------
runAll();
