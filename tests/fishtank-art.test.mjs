#!/usr/bin/env node
// ================================================================
// VM-boot draw-recording tests — fishtank art slots (ticket #139):
// the placeholder set from assets/fishtank (the #137 embed contract)
// rides the render layer — background, caustics tile, gravel band,
// pebble sprites, kelp-strip quads, bubble sprites, and the
// tetra/angel/predator body sprites on their procedural spines —
// proven from the REAL committed bundle the way a user experiences
// it, with a stubbed synchronous decoder on the recording context.
//
// New render contract (render-only; the sim is untouched):
//   - the frame's bitmap draws (drawImage) are EXACTLY the
//     documented art slots, in the renderer's draw order:
//     1 background · gravel band · caustics-tile grid · (placed
//     kelp quads, placed pebbles) · angel body sprites · tetra
//     body sprites · predator body sprite · pooled bubbles
//     (no other layer draws bitmaps);
//   - a swimmer's body sprite flips horizontally exactly when it
//     travels right (the placeholder art faces LEFT);
//   - the predator now rides a 7-point articulated spine of its
//     own plus its body sprite (its first visual — the sim always
//     owned it, the render layer never drew it);
//   - without a decoder the frame carries ZERO bitmap draws
//     (the pre-#137 procedural contract, unchanged).
// The three-phase TINT is boot-time pixel work (src/render/
// tinting.ts) and is covered here at the unit level (in-memory
// surface); its per-phase appearance is the browser screenshot
// evidence, per the sourcing runbook's regression standard.
//
// No network, no browser.
//
// Requires `npm ci` first (like every build-dependent check).
//
// Run: node tests/fishtank-art.test.mjs
// ================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { TETRA_SPINE_SEGMENTS } from "../src/render/tetras.ts";
import { BUBBLE_POOL_SIZE } from "../src/render/bubbles.ts";
import { CAUSTICS_TILE_CELL } from "../src/render/caustics.ts";
import { GRAVEL_TEXTURE_BAND, predatorTailOmega } from "../src/render/renderer.ts";
import { KELP_SEGMENTS, PREDATOR_PATROL_SPEED, PREDATOR_REST_SPEED, PREDATOR_STALK_SPEED, ROCK_RADIUS, TANK_WIDTH } from "../src/sim/constants.ts";
import { LIGHT_DAY, LIGHT_DUSK, LIGHT_NIGHT } from "../src/render/lighting.ts";
import { PHASE_TINTS, bakeTintVariant } from "../src/render/tinting.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "fishtank.html"), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("no <script> block found in fishtank.html");
const gameSource = scriptMatch[1];

// The manifest is DATA (declared slot geometry), not source: the
// slot dimensions below derive from it, parsed, never grepped.
const MANIFEST = JSON.parse(readFileSync(path.join(root, "assets", "fishtank", "manifest.json"), "utf8"));
const SLOT = {};
for (const entry of MANIFEST.entries) SLOT[entry.name] = entry;

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
    createLinearGradient: () => gradient(),
    createRadialGradient: () => gradient(),
    createPattern: () => ({}),
    createImageBitmap: () => Promise.resolve({}),
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

/** The stubbed decode: the boot hands over base64-derived bytes
 *  — a Blob where the sandbox carries one (Node ≥ 24 vm contexts
 *  do), else a raw ArrayBuffer — and the decoder reads the PNG
 *  IHDR dimensions either way, so the fake bitmap carries the
 *  slot's REAL width/height, which the slot-draw math (gravel
 *  band, sprite aspect) depends on. A genuine Promise settle
 *  (the boot's .then/.catch chain needs it) — boot() flushes the
 *  microtask queue before returning. */
function makeStubDecoder() {
  // PNG IHDR: big-endian uint32 widths at byte 16, heights at 20.
  // Read per-byte: this toolchain's V8 build ships typed arrays
  // without the byte-access methods (no readUInt32BE).
  const pngDim = (u8, at) => u8[at] * 16777216 + u8[at + 1] * 65536 + u8[at + 2] * 256 + u8[at + 3];
  const dims = async (buf) => {
    // Duck-typed: only a Blob exposes arrayBuffer(); an ArrayBuffer
    // (and a Uint8Array view) does not — read the bytes either way.
    const bytes = new Uint8Array(typeof buf.arrayBuffer === "function" ? await buf.arrayBuffer() : buf);
    return { fakeBitmap: true, width: pngDim(bytes, 16), height: pngDim(bytes, 20) };
  };
  return (buf) => Promise.resolve().then(() => dims(buf));
}

async function boot(width, height, enabledKinds, withDecoder = true) {
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
  };
  if (withDecoder) {
    sandbox.atob = (s) => Buffer.from(s, "base64").toString("binary");
    sandbox.createImageBitmap = makeStubDecoder();
  }
  vm.createContext(sandbox);
  vm.runInContext(gameSource, sandbox);
  if (withDecoder) await flushMicrotasks(); // decodes settle, loop registers

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
        now += 17; // a hair slower than 60 fps: 1–2 fixed steps per frame
        frameAt(now);
      }
    },
    q: (expr) => vm.runInContext(expr, sandbox),
    /** Drive one frame and return its recorded event slice. */
    frame: (fromMs) => {
      const from = state.events.length;
      frameAt(fromMs);
      return state.events.slice(from);
    },
  };
}

const W = 800;
const H = 600;

/** The frame's expected bitmap-draw count: 1 background + the
 *  gravel band + the caustics-tile grid + one body sprite per
 *  live swimmer (angels + tetras + the predator when present)
 *  + the pooled bubbles (+ placed-scenery slots, where placed). */
function expectedBitmapDraws(slice) {
  const gravelBand = H * GRAVEL_TEXTURE_BAND * (SLOT["gravel-tile"].width / SLOT["gravel-tile"].height);
  const gravel = Math.ceil(W / gravelBand);
  const caustics = (Math.floor(W / CAUSTICS_TILE_CELL) + 2) * (Math.floor(H / CAUSTICS_TILE_CELL) + 2);
  return { 1: true, gravel, caustics };
}

/** Live swimmers from the world seam: [angels..., tetras..., predator?]. */
function swimmers(g) {
  return JSON.parse(g.q(
    "JSON.stringify([...FISH_TANK_WORLD.angels, ...FISH_TANK_WORLD.agents]" +
    ".map((f) => [f.vx, f.vy]))"
  ));
}
function hasPredator(g) {
  return g.q("FISH_TANK_WORLD.predator !== null");
}

// ================================================================
// AC1: every art slot renders — and nothing else draws bitmaps
// ================================================================

check("headless contract: without a decoder the frame carries zero bitmap draws (the procedural frame is unchanged)", async () => {
  const g = await boot(W, H, ["drawImage"], false); // no decoder: the headless contract
  g.frame(0);
  g.tick(4, 0);
  assert(g.state.events.length === 0,
    `no drawImage may appear when nothing decoded, recorded ${g.state.events.length}`);
});

check("every art slot renders every frame: the frame's bitmap draws are exactly 1 background + gravel band + caustics-tile grid + one body sprite per live swimmer + the pooled bubbles", async () => {
  const g = await boot(W, H, ["drawImage"]);
  const { gravel, caustics } = expectedBitmapDraws();
  assert(gravel > 0 && caustics > 0, "test setup: band/tile counts must be positive");
  for (let f = 0; f < 120; f++) {
    const slice = f === 0 ? g.frame(0) : (() => {
      const from = g.state.events.length;
      g.frameAt(f * 17);
      return g.state.events.slice(from);
    })();
    const di = slice.filter((ev) => ev.kind === "drawImage");
    const live = swimmers(g).length + (hasPredator(g) ? 1 : 0);
    const expected = 1 + gravel + caustics + live + BUBBLE_POOL_SIZE;
    assert(di.length === expected,
      `frame ${f}: expected ${expected} bitmap draws (1 bg + ${gravel} gravel + ${caustics} caustics + ${live} bodies + ${BUBBLE_POOL_SIZE} bubbles), got ${di.length}`);
  }
});

// ================================================================
// AC1: fish ride their spines with sprites — direction via flip
// ================================================================

check("direction via flip: exactly the right-travelling swimmers (vx >= 0; the placeholder art faces LEFT) receive one horizontal mirror per frame", async () => {
  const g = await boot(W, H, ["scale"]);
  let framesSeen = 0;
  let leftSwimFrames = 0;
  for (let f = 0; f < 150; f++) {
    if (f === 0) g.frameAt(0);
    else {
      const from = g.state.events.length;
      g.frameAt(f * 17);
      const scales = g.state.events.slice(from).filter((ev) => ev.kind === "scale");
      const mirrors = scales.filter((ev) => ev.args[0] === -1 && ev.args[1] === 1);
      // Every scale in the frame is EITHER the direction mirror
      // (scale(-1, 1)) OR the sprite's positive uniform draw scale
      // (scale(k, k), k > 0) — nothing else scales anything.
      const foreign = scales.find((ev) => !((ev.args[0] === -1 && ev.args[1] === 1) || (ev.args[0] === ev.args[1] && ev.args[0] > 0)));
      assert(foreign === undefined,
        `frame ${f}: a scale that is neither the mirror nor a uniform draw scale appeared (${JSON.stringify(foreign)})`);
      const right = swimmers(g).filter(([vx]) => vx >= 0).length + (hasPredator(g) && g.q("FISH_TANK_WORLD.predator.vx >= 0") ? 1 : 0);
      assert(mirrors.length === right,
        `frame ${f}: ${mirrors.length} horizontal mirrors but ${right} swimmers travel right (art faces left — every right-traveller must be mirrored, and nothing else)`);
      framesSeen += 1;
      if (right < swimmers(g).length + (hasPredator(g) ? 1 : 0)) leftSwimFrames += 1;
    }
  }
  assert(framesSeen >= 100, "the drive must cover many frames");
  assert(leftSwimFrames >= 1, "the drive must include frames with left-travelling swimmers (the un-mirrored path ran)");
});

// ================================================================
// AC1: the hybrid spine — the predator's first visual
// ================================================================

check("the predator rides its spine: one more 7-point spine path AND one more body sprite than a predator-less world, and both vanish together when the predator is absent", async () => {
  const spinePathCount = (slice) => {
    const paths = [];
    let current = null;
    for (const ev of slice) {
      if (ev.kind === "beginPath") { current = []; paths.push(current); }
      else if (current !== null && (ev.kind === "moveTo" || ev.kind === "lineTo")) current.push(ev.args);
    }
    return paths.filter((pts) => pts.length === TETRA_SPINE_SEGMENTS).length;
  };
  const g = await boot(W, H, ["beginPath", "moveTo", "lineTo", "drawImage"]);
  assert(hasPredator(g), "test setup: the default world owns a predator");
  const withPred = (() => {
    const from = g.state.events.length;
    g.frameAt(0);
    return g.state.events.slice(from);
  })();
  const liveWith = swimmers(g).length + 1;
  assert(spinePathCount(withPred) === liveWith,
    `with the predator: ${spinePathCount(withPred)} ${TETRA_SPINE_SEGMENTS}-point spine paths, expected ${liveWith} (every swimmer AND the predator rides its articulated spine)`);
  assert(withPred.filter((ev) => ev.kind === "drawImage").length ===
         1 + expectedBitmapDraws().gravel + expectedBitmapDraws().caustics + liveWith + BUBBLE_POOL_SIZE,
    "with the predator: the frame carries its body sprite (the total-slot formula holds with live+1)");
  g.q("FISH_TANK_WORLD.setPredatorPresent(false)");
  const from2 = g.state.events.length;
  g.frameAt(17);
  const withoutPred = g.state.events.slice(from2);
  const liveWithout = swimmers(g).length;
  assert(spinePathCount(withoutPred) === liveWithout,
    `without the predator: ${spinePathCount(withoutPred)} spine paths, expected ${liveWithout} (the predator's spine vanished with its body)`);
  const di = withoutPred.filter((ev) => ev.kind === "drawImage");
  assert(di.length === 1 + expectedBitmapDraws().gravel + expectedBitmapDraws().caustics + liveWithout + BUBBLE_POOL_SIZE,
    "without the predator: the frame's body-sprite count dropped by exactly one");
});

// ================================================================
// AC1: placed-scenery slots — pebbles match the collision body,
// kelp quads ride the verlet bones
// ================================================================

check("placed rocks draw pebble sprites at the collision circle's full width (2r) with the sprite's own aspect, alternating the two variants", async () => {
  const g = await boot(W, H, ["drawImage"]);
  const base = (() => {
    const from = g.state.events.length;
    g.frameAt(0);
    return g.state.events.slice(from).filter((ev) => ev.kind === "drawImage").length;
  })();
  const sx = W / TANK_WIDTH;
  g.q("FISH_TANK_WORLD.placeRock(500, 750)");
  for (const [n, variant] of [[1, "pebble-1"], [2, "pebble-2"]]) {
    const from = g.state.events.length;
    if (n === 2) g.q("FISH_TANK_WORLD.placeRock(1100, 750)");
    g.frameAt(n * 17);
    const di = g.state.events.slice(from).filter((ev) => ev.kind === "drawImage");
    assert(di.length === base + n, `after ${n} placed rock(s): expected ${base + n} bitmap draws, got ${di.length}`);
    const fullW = 2 * ROCK_RADIUS * sx;
    const fullH = fullW * (SLOT[variant].height / SLOT[variant].width);
    const pebble = di.find((ev) => Math.abs(ev.args[3] - fullW) < 1e-9 && Math.abs(ev.args[4] - fullH) < 1e-9);
    assert(pebble !== undefined,
      `rock ${n}: no pebble draw at the collision circle's full width ${fullW}×${fullH} (variant ${variant}) among the frame's ${di.length} bitmap draws`);
  }
});

check("placed kelp strands draw exactly KELP_SEGMENTS textured quads each (the verlet bones carry the art; the physics is untouched)", async () => {
  const g = await boot(W, H, ["drawImage"]);
  const base = (() => {
    const from = g.state.events.length;
    g.frameAt(0);
    return g.state.events.slice(from).filter((ev) => ev.kind === "drawImage").length;
  })();
  g.q("FISH_TANK_WORLD.placeKelp(900)");
  const from = g.state.events.length;
  g.frameAt(17);
  const di = g.state.events.slice(from).filter((ev) => ev.kind === "drawImage");
  assert(di.length === base + KELP_SEGMENTS,
    `one placed strand adds exactly ${KELP_SEGMENTS} quads (one per verlet segment), got a delta of ${di.length - base}`);
});

// ================================================================
// AC2 (render-layer half): the art slots stay live across all
// three lighting phases — the per-phase TINTED appearance is the
// browser screenshot evidence (runbook), the unit checks below
// pin the tint math
// ================================================================

check("the art slots keep drawing in DAY, DUSK and NIGHT (phase offset set through the world seam)", async () => {
  const g = await boot(W, H, ["drawImage", "stop"]);
  const { gravel, caustics } = expectedBitmapDraws();
  const ambient = (slice) => {
    const stops = [];
    for (const ev of slice) {
      if (ev.kind === "stop") stops.push(ev.args.color);
      if (stops.length === 2) return stops;
    }
    throw new Error("no ambient pair in the frame");
  };
  const expect = {
    0: [LIGHT_DAY.surface, LIGHT_DAY.depth, "DAY"],
    50: [LIGHT_DUSK.surface, LIGHT_DUSK.depth, "DUSK"],
    65: [LIGHT_NIGHT.surface, LIGHT_NIGHT.depth, "NIGHT"],
  };
  let ms = 0;
  for (const [offset, [surf, depth, label]] of Object.entries(expect)) {
    g.q(`FISH_TANK_WORLD.lightingPhaseOffset = ${offset}`);
    ms += 17;
    const from = g.state.events.length;
    g.frameAt(ms);
    const slice = g.state.events.slice(from);
    const di = slice.filter((ev) => ev.kind === "drawImage");
    const live = swimmers(g).length + (hasPredator(g) ? 1 : 0);
    assert(di.length === 1 + gravel + caustics + live + BUBBLE_POOL_SIZE,
      `${label} phase: the art-slot draw count drifted (${di.length})`);
    const [s0, s1] = ambient(slice);
    assert(s0 === surf && s1 === depth,
      `${label} phase: ambient is (${s0}, ${s1}) but the palette says (${surf}, ${depth})`);
  }
});

// ================================================================
// AC2 (tint math): the three-phase tint is a boot-time multiplicative
// bake; DAY is the identity pass-through; failure degrades to null
// (the slot keeps its neutral art — never a crash)
// ================================================================

check("phase tint table: DAY is the identity (the neutral bitmap IS the day art); DUSK and NIGHT are finite multiplicative tints", () => {
  assert(PHASE_TINTS.LIGHT_DAY === null, "LIGHT_DAY must be the identity pass-through (no bake)");
  for (const name of ["LIGHT_DUSK", "LIGHT_NIGHT"]) {
    const tint = PHASE_TINTS[name];
    assert(tint !== null && tint !== undefined, `${name} must carry a tint`);
    for (const ch of ["r", "g", "b"]) {
      assert(Number.isFinite(tint[ch]) && tint[ch] > 0 && tint[ch] <= 1,
        `${name}.${ch} = ${tint[ch]} — a multiplicative tint must sit in (0, 1]`);
    }
  }
  assert(PHASE_TINTS.LIGHT_DUSK.r >= PHASE_TINTS.LIGHT_NIGHT.r,
    "dusk stays warmer than night (the night wash is the darker, colder one)");
});

/** In-memory bake surface: drawImage is a no-op, getImageData
 *  serves the supplied pixels, putImageData captures the output. */
function memorySurface(data) {
  const out = [];
  return {
    out,
    surface: {
      getContext: () => ({
        drawImage: () => {},
        getImageData: () => ({ data }),
        putImageData: (img) => { out.push(img.data); },
      }),
    },
  };
}

check("bakeTintVariant multiplies every RGB channel by the phase tint and never touches the alpha (transparent sprite parts stay transparent)", () => {
  const inData = new Uint8ClampedArray([200, 100, 50, 128, 9, 199, 0, 255]);
  const mem = memorySurface(inData);
  const out = bakeTintVariant({ width: 2, height: 1 }, PHASE_TINTS.LIGHT_NIGHT, () => mem.surface);
  assert(out === mem.surface, "a healthy surface must come back as the phase variant");
  assert(mem.out.length === 1, "exactly one putImageData per bake");
  const [r, g, b, a] = mem.out[0];
  const t = PHASE_TINTS.LIGHT_NIGHT;
  assert(r === Math.min(255, Math.round(200 * t.r)), `R: 200 × ${t.r} must land on ${Math.round(200 * t.r)}, got ${r}`);
  assert(g === Math.min(255, Math.round(100 * t.g)), `G: 100 × ${t.g} must land on ${Math.round(100 * t.g)}, got ${g}`);
  assert(b === Math.min(255, Math.round(50 * t.b)), `B: 50 × ${t.b} must land on ${Math.round(50 * t.b)}, got ${b}`);
  assert(a === 128, `alpha must be untouched, got ${a}`);
});

check("bakeTintVariant degrades to null — a bitmap without usable dimensions or a missing surface facility both keep the slot on its neutral art (no crash)", () => {
  assert(bakeTintVariant({}, PHASE_TINTS.LIGHT_DUSK, () => { throw new Error("unused"); }) === null,
    "a dimensionless bitmap must return null, not throw");
  assert(bakeTintVariant({ width: 2, height: 1 }, PHASE_TINTS.LIGHT_DUSK, () => null) === null,
    "no surface facility must return null, not throw");
});

// ================================================================
// PRD §2 (review should-fix): the predator's tail undulation
// frequency scales dynamically with swimming speed — the same
// speed-proportional rule the tetras/angels run through
// tailFrequency's speed gain, render-owned because the predator's
// sim state is frozen by this ticket.
// ================================================================

check("predator tail omega scales with swimming speed: zero at rest, strictly increasing, patrol-speed baseline kept, stalk beats harder", () => {
  assert(predatorTailOmega(0) === 0,
    "a stationary predator must idle at zero rad/s, like tailFrequency(0, 0) — not beat at a constant");
  const ladder = [PREDATOR_REST_SPEED, 150, PREDATOR_PATROL_SPEED, PREDATOR_STALK_SPEED, 600];
  for (let i = 1; i < ladder.length; i++) {
    assert(predatorTailOmega(ladder[i]) > predatorTailOmega(ladder[i - 1]),
      `omega must be strictly increasing in speed (regression it prevents: a CONSTANT tail omega):
       ${ladder[i - 1]} u/s → ${ladder[i]} u/s gave equal/less omega`);
  }
  const atPatrol = predatorTailOmega(PREDATOR_PATROL_SPEED);
  assert(atPatrol >= 5 && atPatrol <= 9,
    `the cruise (patrol-speed) baseline must stay in its tuned band [5, 9] rad/s, got ${atPatrol}`);
});

// ---------- run ----------
runAll();
