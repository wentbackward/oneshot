#!/usr/bin/env node
// ================================================================
// Unit tests — procedural Web Audio sound effects (ticket #9)
//
// Same harness style as tests/screens.test.mjs: runs the REAL
// <script> from asteroids.html in a sandboxed vm context with stubbed
// window/document/canvas. The audio criterion is verified with a
// recording FAKE AudioContext injected as a sandbox global: it
// mirrors the Web Audio node graph (oscillators, gain envelopes,
// biquad filters, buffer sources, the destination) well enough that
// every scheduled SFX is inspectable — its waveform source
// (square osc vs. baked white-noise buffer), its pitch/filter
// parameters, its decay length, and its routing through the single
// master gain node. No network, no external services, no real audio.
//
// Run: node tests/sfx.test.mjs
// ================================================================
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "asteroids.html"), "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error("no <script> block found in asteroids.html");
const gameSource = match[1];

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
function assertClose(actual, expected, tol, msg) {
  const diff = Math.abs(actual - expected);
  if (!Number.isFinite(diff) || diff > tol) {
    throw new Error(`${msg} (got ${actual}, want ~${expected})`);
  }
}

// ---------- recording fake AudioContext ----------
// Records every node it creates plus each connection, and every
// parameter automation (setValueAtTime / exponentialRampToValueAtTime),
// so tests can assert on what the game would have made the speakers do.
// currentTime is pinned to 0, so scheduled stop/start deltas ARE the
// SFX durations.
class Param {
  constructor(initial = 0) {
    this.value = initial;
    this.events = []; // { kind: "set"|"exp"|"lin", value }
  }
  setValueAtTime(v) {
    this.events.push({ kind: "set", value: v });
    this.value = v;
  }
  linearRampToValueAtTime(v) {
    this.events.push({ kind: "lin", value: v });
  }
  exponentialRampToValueAtTime(v) {
    this.events.push({ kind: "exp", value: v });
    this.value = v;
  }
}
class ANode {
  constructor(kind, rec) {
    this.kind = kind;
    this.connections = [];
    this.startedAt = null;
    this.stoppedAt = null;
    rec.nodes.push(this);
  }
  connect(target) {
    this.connections.push(target);
    return target;
  }
  start(t) {
    this.startedAt = t;
  }
  stop(t) {
    this.stoppedAt = t;
  }
  duration() {
    return this.stoppedAt - this.startedAt;
  }
}
function makeFakeAudioContextClass(rec) {
  return class {
    constructor() {
      rec.instances.push(this);
      this.rec = rec;
      this.state = "suspended";
      this.sampleRate = 44100;
      this.currentTime = 0;
      this.destination = { kind: "destination" };
    }
    resume() {
      this.state = "running";
      this.rec.resumes.push(this);
      return Promise.resolve();
    }
    createGain() {
      const n = new ANode("gain", this.rec);
      n.gain = new Param(0);
      return n;
    }
    createOscillator() {
      const n = new ANode("osc", this.rec);
      n.type = "sine";
      n.frequency = new Param(440);
      return n;
    }
    createBiquadFilter() {
      const n = new ANode("filter", this.rec);
      n.type = "lowpass";
      n.frequency = new Param(0);
      n.Q = new Param(1);
      return n;
    }
    createBufferSource() {
      const n = new ANode("buffersource", this.rec);
      n.buffer = null;
      return n;
    }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      const buf = {
        channels,
        length,
        sampleRate: rate,
        data,
        getChannelData: () => data,
      };
      this.rec.buffers.push(buf);
      return buf;
    }
  };
}

// Boot a fresh copy of the game on a 960x600 canvas, parked on its
// start screen (like the screens suite). By default a recording fake
// AudioContext is injected as the sandbox global `AudioContext`;
// { audio: false } omits it entirely, modelling a browser without Web
// Audio (and the vm's own missing-global reality).
function boot({ audio = true } = {}) {
  const width = 960;
  const height = 600;
  const rec = { instances: [], resumes: [], nodes: [], buffers: [] };
  let rafCallback = null;
  const listeners = {};
  const ctxTexts = [];
  const ctxStub = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        if (prop === "fillText") return (text) => ctxTexts.push(String(text));
        return (..._args) => {};
      },
      set(_t, prop, value) {
        return true;
      },
    }
  );
  const canvasStub = { width, height, getContext: () => ctxStub };
  const sandbox = {
    window: {
      innerWidth: width,
      innerHeight: height,
      addEventListener: (type, cb) => {
        (listeners[type] ??= []).push(cb);
      },
    },
    document: { getElementById: (id) => (id === "game" ? canvasStub : null) },
    requestAnimationFrame: (cb) => {
      rafCallback = cb;
      return 1;
    },
  };
  if (audio) sandbox.AudioContext = makeFakeAudioContextClass(rec);
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);

  let nowMs = 0;
  const FRAME_MS = 1000 / 60;
  function tick(n = 1) {
    for (let i = 0; i < n; i++) {
      nowMs += FRAME_MS;
      rafCallback(nowMs);
    }
  }
  function press(code) {
    for (const cb of listeners["keydown"] ?? []) {
      cb({ code, preventDefault() {} });
    }
  }
  function release(code) {
    for (const cb of listeners["keyup"] ?? []) {
      cb({ code, preventDefault() {} });
    }
  }
  const q = (expr) => vm.runInContext(expr, context);
  return {
    tick,
    press,
    release,
    q,
    rec,
    ctxTexts,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    score: () => q("score"),
    hp: () => q("hp"),
    ship: () => q("({ x: ship.x, y: ship.y })"),
    placeAst: (x, y, r = 20) =>
      q(`(() => { const s = asteroids.slots.find((a) => !a.active);
        if (!s) throw new Error("no free asteroid slot for fixture");
        s.active = true; s.x = ${x}; s.y = ${y}; s.r = ${r};
        s.vx = 0; s.vy = 0; s.rot = 0; s.spin = 0; s.entry = -1;
        s.shape.length = 6; return true; })()`),
    placeDrone: (x, y) =>
      q(`(() => { const s = drones.slots.find((d) => !d.active);
        if (!s) throw new Error("no free drone slot for fixture");
        s.active = true; s.x = ${x}; s.y = ${y}; s.heading = 0;
        return true; })()`),
  };
}

// Suppress all auto-spawning (same trick as the other suites).
function suppressSpawns(g) {
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0");
}

// Tick until `fn()` is true or the frame budget runs out.
function waitUntil(g, fn, frames = 300, what) {
  for (let i = 0; i < frames; i++) {
    if (fn()) return i;
    g.tick();
  }
  throw new Error(`timed out after ${frames} frames waiting for: ${what}`);
}

// The single master gain node: the only node wired to the destination.
function masterOf(g) {
  const ac = g.rec.instances[0];
  const wired = g.rec.nodes.filter((n) => n.connections.includes(ac.destination));
  return wired[0];
}
// Scheduled shoot blips (oscillators) and noise bursts (buffer sources).
const shoots = (rec) => rec.nodes.filter((n) => n.kind === "osc");
const bursts = (rec) => rec.nodes.filter((n) => n.kind === "buffersource");

// For each scheduled noise burst, its envelope gain (the node that
// feeds the master bus). Declared above its first use below.
function burstEndpoints(g) {
  return bursts(g.rec).map((src) => {
    const filter = src.connections[0];
    return filter.connections[0];
  });
}

// A noise burst must be: the baked noise buffer -> lowpass filter at
// the preset cutoff -> envelope gain at the preset level and decay
// -> the single master gain. Returns the burst's envelope gain node.
function assertNoiseBurst(g, src, cutoffName, levelName, durName) {
  const m = masterOf(g);
  assert(src.startedAt !== null && src.stoppedAt !== null,
    `the noise burst must be scheduled (start/stop), got start=${src.startedAt} stop=${src.stoppedAt}`);
  assert(src.buffer !== null && g.rec.buffers.includes(src.buffer),
    "the burst must play from the baked noise buffer");
  const filter = src.connections[0];
  assert(filter && filter.kind === "filter", "the burst must pass through a biquad filter");
  assert(filter.type === "lowpass", `the burst filter must be a lowpass, got ${filter.type}`);
  assertClose(filter.frequency.value, g.q(cutoffName), 0,
    `the burst lowpass cutoff must be ${cutoffName}`);
  const env = filter.connections[0];
  assert(env && env.kind === "gain", "the burst envelope must be a gain node after the filter");
  assert(env.connections[0] === m,
    "the burst envelope must route into the single master gain node");
  assert(env.gain.events[0]?.kind === "set", "the envelope must open with a set level");
  assertClose(env.gain.events[0].value, g.q(levelName), 0, `the burst level must be ${levelName}`);
  assertClose(src.duration(), g.q(durName), 1e-9, `the burst decay must be ${durName}`);
  return env;
}

// ================================================================
// Criterion 1: Web Audio based, fully procedural — the source
// references the AudioContext API and contains no audio files or
// media loaders whatsoever
// ================================================================
check("asteroids.html references AudioContext and ships no audio files or media loaders", () => {
  assert(html.includes("AudioContext"),
    "asteroids.html must use the Web Audio API (AudioContext)");
  const loaders = html.match(/new Audio\(|\.mp3|\.wav|\.ogg|\.m4a/gi) ?? [];
  assert(loaders.length === 0,
    `no audio files or loaders may appear in asteroids.html, found ${JSON.stringify(loaders)}`);
});

// #9-1 (should-fix): the noise buffer is baked through the injectable
// `var random`, like every other randomized value in the game
check("the baked noise buffer comes from the injectable random, not raw Math.random", () => {
  const g = boot();
  g.q("random = () => 0.25"); // constant source: every baked sample must be 0.25*2-1 = -0.5
  g.press("Enter"); // first gesture: context creation + buffer bake
  const buf = g.rec.buffers[0];
  assert(buf, "the first gesture must bake the noise buffer");
  assert(buf.data.length > 0, "the baked buffer must not be empty");
  for (const v of buf.data) {
    assert(v === 0.25 * 2 - 1,
      `every baked sample must come from random() (constant 0.25 -> -0.5), got ${v} — raw Math.random?`);
  }
});

// ================================================================
// Criterion 3: the AudioContext is created (and resumed) only after
// the first user gesture — never on fresh page load
// ================================================================
check("a fresh page load (many rendered frames, no input) constructs no AudioContext", () => {
  const g = boot();
  g.tick(180); // 3 s of idle render on the start screen
  assert(g.rec.instances.length === 0,
    `no AudioContext may exist before any user gesture, got ${g.rec.instances.length}`);
});

check("the very first keydown (even a non-game key) creates and resumes exactly one AudioContext", () => {
  const g = boot();
  g.press("KeyP"); // not even a gameplay key — a gesture is a gesture
  assert(g.rec.instances.length === 1,
    `the first keydown must construct exactly one AudioContext, got ${g.rec.instances.length}`);
  assert(g.rec.resumes.length >= 1, "the context must be resumed on the gesture");
  assert(g.rec.instances[0].state === "running",
    `after the first keydown the context state must be "running", got ${g.rec.instances[0].state}`);
  g.press("Enter");
  g.press("Space");
  assert(g.rec.instances.length === 1,
    "later gestures must reuse the context, never construct another");
});

check("a suspended context is resumed on the next keydown", () => {
  const g = boot();
  g.press("Enter");
  const ac = g.rec.instances[0];
  assert(ac.state === "running", "precondition: running after the first gesture");
  ac.state = "suspended"; // e.g. the browser muted it out of politeness
  g.press("KeyM");
  assert(ac.state === "running",
    "the next keydown must resume a suspended context back to running");
  assert(g.rec.resumes.length >= 2, "the resume must be re-requested");
  assert(g.rec.instances.length === 1, "resuming must not construct a second context");
});

// ================================================================
// Robustness: environments without Web Audio degrade to silence
// (also the reality of the other six vm suites)
// ================================================================
check("with no AudioContext available the game boots, fires and takes damage without error", () => {
  const g = boot({ audio: false });
  g.press("Enter");
  assert(g.state() === "playing", "the game must start without Web Audio");
  suppressSpawns(g);
  g.press("Space");
  g.tick(3);
  g.release("Space"); // shooting must not throw
  g.placeAst(480, 275); // a rock 25 px away overlaps the hull
  g.tick(5);
  assertClose(g.hp(), g.q("PLAYER_MAX_HP") - 1, 0, "hull damage must still work without Web Audio");
});

check("before the first gesture, invoking the SFX generators is a silent no-op", () => {
  const g = boot();
  g.q("playShoot(); playAsteroidKill(); playDroneKill(); playPlayerHit();");
  assert(g.rec.instances.length === 0, "no AudioContext may be created without a gesture");
  assert(g.rec.nodes.length === 0, "no audio node may be scheduled without a gesture");
});

// ================================================================
// Criterion 2 (shoot): a short square-wave blip, pitch falling,
// routed through the master bus
// ================================================================
check("shoot plays a short square-wave blip with a falling pitch, routed through the master gain", () => {
  const g = boot();
  g.press("Enter");
  suppressSpawns(g);
  g.press("Space");
  g.tick(3); // well under the 150 ms cooldown: exactly one shot
  g.release("Space");
  const os = shoots(g.rec);
  assert(os.length === 1, `one shot must schedule exactly one oscillator, got ${os.length}`);
  const o = os[0];
  assert(o.type === "square", `the shoot waveform must be a square wave, got ${o.type}`);
  assert(o.frequency.events[0]?.kind === "set" &&
    o.frequency.events[0].value === g.q("SFX_SHOOT_FROM_HZ"),
    `the blip must open at SFX_SHOOT_FROM_HZ (${g.q("SFX_SHOOT_FROM_HZ")})`);
  assert(o.frequency.events[1]?.kind === "exp" &&
    o.frequency.events[1].value === g.q("SFX_SHOOT_TO_HZ"),
    `the blip must pitch down to SFX_SHOOT_TO_HZ (${g.q("SFX_SHOOT_TO_HZ")})`);
  assertClose(o.duration(), g.q("SFX_SHOOT_S"), 1e-9, "the blip length must be SFX_SHOOT_S");
  assert(o.duration() <= 0.1, `the blip must be short, got ${o.duration()} s`);
  const env = o.connections[0];
  assert(env && env.kind === "gain" && env.connections[0] === masterOf(g),
    "the blip must route through an envelope gain into the single master gain");
});

// ================================================================
// Criterion 4: ONE master gain node governs every SFX, levelled by
// the named constant MASTER_GAIN — 0 silences everything
// ================================================================
check("exactly one gain node is wired to the destination and it carries MASTER_GAIN", () => {
  const g = boot();
  g.press("Enter");
  const ac = g.rec.instances[0];
  const wired = g.rec.nodes.filter((n) => n.connections.includes(ac.destination));
  assert(wired.length === 1,
    `exactly one node may wire to the destination (the master bus), got ${wired.length}`);
  assert(wired[0].kind === "gain", "the master bus must be a GainNode");
  assertClose(wired[0].gain.value, g.q("MASTER_GAIN"), 0,
    `the master gain must carry MASTER_GAIN (${g.q("MASTER_GAIN")})`);
});

check("MASTER_GAIN = 0 silences every SFX: shoot and all three noise presets still route through the zeroed bus", () => {
  const g = boot();
  g.press("Enter");
  g.q("MASTER_GAIN = 0");
  g.q("playShoot(); playAsteroidKill(); playDroneKill(); playPlayerHit();");
  const m = masterOf(g);
  assertClose(m.gain.value, 0, 0, "with MASTER_GAIN = 0 the master bus must carry zero gain");
  assert(shoots(g.rec).length === 1, "the shoot must still be scheduled (through the silent bus)");
  assert(bursts(g.rec).length === 3, "all three noise presets must still be scheduled");
  const endpoints = [
    shoots(g.rec)[0].connections[0],
    ...burstEndpoints(g),
  ];
  for (const env of endpoints) {
    assert(env.connections[0] === m,
      "no SFX may bypass the master gain node — silence at 0 must mean total silence");
  }
});

// ================================================================
// Criterion 2 (asteroid kill): noise-burst based, asteroid preset
// ================================================================
check("an asteroid laser kill plays a low-passed white-noise burst with the asteroid preset", () => {
  const g = boot();
  g.press("Enter");
  suppressSpawns(g);
  g.placeAst(480, 40); // parked straight ahead
  g.press("Space");
  g.tick(2);
  g.release("Space");
  waitUntil(g, () => g.score() === g.q("SCORE_PER_ASTEROID"), 120,
    "the straight-ahead laser kill");
  const bs = bursts(g.rec);
  assert(bs.length === 1, `one asteroid kill must schedule exactly one noise burst, got ${bs.length}`);
  assertNoiseBurst(g, bs[0], "SFX_ASTEROID_KILL_HZ", "SFX_ASTEROID_KILL_LEVEL", "SFX_ASTEROID_KILL_S");
  // The buffer really is baked white noise, once.
  const baked = g.rec.buffers.find((b) => b === bs[0].buffer);
  assert(baked, "the kill burst must come from the pre-baked noise buffer");
  assert(baked.length >= Math.round(g.q("audioCtx.sampleRate * SFX_NOISE_S") * 0.999),
    "the noise buffer must be long enough for the longest preset decay");
  assert(baked.data.some((v) => v !== 0), "the noise buffer must contain real (nonzero) noise");
});

// ================================================================
// Criterion 2 (drone kill): noise-burst based, drone preset
// ================================================================
check("a drone laser kill plays a low-passed white-noise burst with the drone preset", () => {
  const g = boot();
  g.press("Enter");
  suppressSpawns(g);
  g.q("DRONE_SPEED = 0"); // park the chaser: it must not drift off the beam line
  g.placeDrone(480, 40); // parked straight ahead
  g.press("Space");
  g.tick(2);
  g.release("Space");
  waitUntil(g, () => g.score() === g.q("SCORE_PER_DRONE"), 120,
    "the straight-ahead drone laser kill");
  const bs = bursts(g.rec);
  assert(bs.length === 1, `one drone kill must schedule exactly one noise burst, got ${bs.length}`);
  assertNoiseBurst(g, bs[0], "SFX_DRONE_KILL_HZ", "SFX_DRONE_KILL_LEVEL", "SFX_DRONE_KILL_S");
});

// ================================================================
// Criterion 2 (player hit): noise-burst based, hit preset; a hull
// hit alone produces no shoot blip
// ================================================================
check("a hull hit plays a low-passed white-noise burst with the player-hit preset (and no blip)", () => {
  const g = boot();
  g.press("Enter");
  suppressSpawns(g);
  g.placeAst(480, 275); // 25 px from the ship centre: overlapping
  g.tick(3);
  assertClose(g.hp(), g.q("PLAYER_MAX_HP") - 1, 0, "precondition: the hull took exactly one hit");
  assert(shoots(g.rec).length === 0, "no shoot blip may fire without Space being pressed");
  const bs = bursts(g.rec);
  assert(bs.length === 1, `one hull hit must schedule exactly one noise burst, got ${bs.length}`);
  assertNoiseBurst(g, bs[0], "SFX_PLAYER_HIT_HZ", "SFX_PLAYER_HIT_LEVEL", "SFX_PLAYER_HIT_S");
});

// ================================================================
// Criterion 2 (distinguishability): the shoot is the only
// oscillator-based sound (square blip) while all three impact
// sounds are noise bursts; the three noise presets are pairwise
// distinct in cutoff or decay
// ================================================================
check("the four SFX are four distinct synth recipes (square blip vs three different noise presets)", () => {
  const g = boot();
  // Structural: shoot is the only generator that uses an oscillator.
  assert(g.q("typeof playShoot") === "function");
  for (const fn of ["playShoot", "playAsteroidKill", "playDroneKill", "playPlayerHit"]) {
    assert(g.q(`typeof ${fn}`) === "function", `the ${fn} generator must exist`);
  }
  // The three noise presets must be pairwise distinguishable.
  const presets = [
    ["SFX_ASTEROID_KILL_HZ", "SFX_ASTEROID_KILL_S"],
    ["SFX_DRONE_KILL_HZ", "SFX_DRONE_KILL_S"],
    ["SFX_PLAYER_HIT_HZ", "SFX_PLAYER_HIT_S"],
  ];
  for (let i = 0; i < presets.length; i++) {
    for (let j = i + 1; j < presets.length; j++) {
      const [fh, fd] = presets[i];
      const [gh, gd] = presets[j];
      assert(g.q(fh) !== g.q(gh) || g.q(fd) !== g.q(gd),
        `${fh}/${fd} and ${gh}/${gd} must differ in cutoff or decay to be audible as different sounds`);
    }
  }
  // Behavioural: one of each, all distinct, through the master bus.
  g.press("Enter");
  suppressSpawns(g);
  g.q("playShoot(); playAsteroidKill(); playDroneKill(); playPlayerHit();");
  assert(shoots(g.rec).length === 1, "exactly one oscillator (the shoot) must be scheduled");
  assert(shoots(g.rec)[0].type === "square", "the shoot must be the square blip");
  assert(bursts(g.rec).length === 3, "exactly three noise bursts must be scheduled");
  const cutoffs = burstEndpoints(g)
    .map((env) => {
      const src = bursts(g.rec).find((s) => s.connections[0].connections[0] === env);
      return src.connections[0].frequency.value;
    });
  assert(new Set(cutoffs).size === 3,
    `the three noise bursts must use three distinct cutoffs, got ${JSON.stringify(cutoffs)}`);
  // The baked buffer is created exactly once, not per burst.
  assert(g.rec.buffers.length === 1,
    `the noise buffer must be pre-baked once, got ${g.rec.buffers.length} buffers`);
});

// ================================================================
// Gate: the named constant this criterion hangs off is present
// (mirrors the .devloop.json gate grep)
// ================================================================
check("MASTER_GAIN is a named, console-reassignable constant in the game source", () => {
  const g = boot();
  g.press("Enter");
  const before = g.q("MASTER_GAIN");
  assert(typeof before === "number" && before > 0,
    `MASTER_GAIN must be a positive named constant, got ${before}`);
  g.q("MASTER_GAIN = 0");
  assertClose(g.q("MASTER_GAIN"), 0, 0, "MASTER_GAIN must be reassignable from the console");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
