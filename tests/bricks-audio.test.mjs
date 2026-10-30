#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html synthesized Web Audio SFX (ticket #27)
//
// Runs the REAL <script> from bricks.html in a sandboxed vm context
// (same harness style as the other bricks-*.test.mjs suites), with a
// recording AudioContext stub that captures the oscillator / buffer-
// source / filter / gain graph, every scheduled gain automation
// event and every source start/stop time.
//
// Criteria covered:
//  1. AudioContext is constructed only on the first user gesture
//     (click or keydown) — exactly once; with no AudioContext stub
//     at all the full game loop runs silently with no exceptions.
//  2. Each required event (paddle bounce, brick break, power-up
//     catch, game over) schedules a sound via its named recipe:
//     waveform constants (sine/square/noise) plus frequency and
//     duration constants, asserted on the stub graph.
//  3. Every recipe routes through the single master gain bus: all
//     envelope gains connect to the one GainNode wired to
//     destination, and reassigning MASTER_GAIN = 0 makes every
//     subsequently scheduled envelope terminate at 0.
//  4. No external refs, no `new Image(`/`new Worker(` in bricks.html
//     (mirrors the dev-loop gate checks — no audio assets).
//
// Run: node tests/bricks-audio.test.mjs
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
    throw new Error(`${msg} (got ${actual}, want ${expected} ± ${tol})`);
  }
}

// A DOM element stub (same shape the sibling suites use).
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

// ---------- recording AudioContext stub ----------
// Nodes record their connections (dest) and, for audio sources,
// start/stop times; gain nodes record every automation event as
// [value, time] in schedule order. The destination object lets the
// tests find the single bus gain wired to it.
function makeAudioGraph() {
  const rec = {
    constructions: 0,
    oscillators: [],
    bufferSources: [],
    filters: [],
    gains: [],
    buffers: [],
  };
  const destination = { kind: "destination" };
  const ctx = {
    destination,
    currentTime: 0,
    sampleRate: 44100,
    createOscillator() {
      const n = {
        kind: "oscillator",
        type: "",
        frequency: { value: 0 },
        dest: [],
        startTimes: [],
        stopTimes: [],
      };
      n.connect = (d) => n.dest.push(d);
      n.start = (t) => n.startTimes.push(t);
      n.stop = (t) => n.stopTimes.push(t);
      rec.oscillators.push(n);
      return n;
    },
    createBufferSource() {
      const n = {
        kind: "bufferSource",
        buffer: null,
        dest: [],
        startTimes: [],
        stopTimes: [],
      };
      n.connect = (d) => n.dest.push(d);
      n.start = (t) => n.startTimes.push(t);
      n.stop = (t) => n.stopTimes.push(t);
      rec.bufferSources.push(n);
      return n;
    },
    createBiquadFilter() {
      const n = { kind: "filter", type: "", frequency: { value: 0 }, dest: [] };
      n.connect = (d) => n.dest.push(d);
      rec.filters.push(n);
      return n;
    },
    createGain() {
      const n = { kind: "gain", events: [], dest: [] };
      n.gain = {
        value: 1,
        setValueAtTime(v, t) {
          n.events.push([v, t]);
        },
        linearRampToValueAtTime(v, t) {
          n.events.push([v, t]);
        },
      };
      n.connect = (d) => n.dest.push(d);
      rec.gains.push(n);
      return n;
    },
    createBuffer(channels, length, sampleRate) {
      const b = {
        kind: "buffer",
        channels,
        length,
        sampleRate,
        data: new Float32Array(length),
      };
      b.getChannelData = () => b.data;
      rec.buffers.push(b);
      return b;
    },
  };
  const ctor = function () {
    rec.constructions += 1;
    return ctx;
  };
  return { rec, ctx, destination, ctor };
}

// Gains whose gain param was automated are sound envelopes; the bus
// gain never schedules automations.
const envelopes = (g) => g.audio.rec.gains.filter((n) => n.events.length > 0);
// Bus gains: gain nodes wired to the context destination.
const busGains = (g) =>
  g.audio.rec.gains.filter((n) => n.dest.includes(g.audio.destination));
// Count of scheduled sound components (sources + envelopes).
const soundParts = (g) =>
  g.audio.rec.oscillators.length +
  g.audio.rec.bufferSources.length +
  envelopes(g).length;

// ---------- boot ----------
// Boot a fresh copy of the game. With `audio: true` the sandbox's
// window carries the recording AudioContext stub; otherwise the
// platform simply has no Web Audio (the silent-degradation path).
function boot(width = 960, height = 600, opts = {}) {
  const audio = opts.audio ? makeAudioGraph() : null;
  const canvas = {
    width: 0,
    height: 0,
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
    game: canvas,
    "screen-start": makeEl("screen-start"),
    "btn-start": makeEl("btn-start"),
    "screen-gameover": makeEl("screen-gameover"),
    "btn-restart": makeEl("btn-restart"),
    "gameover-final": makeEl("gameover-final"),
    "hud-score": makeEl("hud-score"),
    "hud-level": makeEl("hud-level"),
    "hud-high": makeEl("hud-high"),
    lives: makeEl("lives"),
  };
  const winListeners = {};
  let rafCb = null;
  let rafId = 0;
  const sandbox = {
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {
      innerWidth: width,
      innerHeight: height,
      AudioContext: audio ? audio.ctor : undefined,
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

  let nowMs = 0;
  const FRAME_MS = 1000 / 60;
  function tick(n = 1) {
    for (let i = 0; i < n; i += 1) {
      nowMs += FRAME_MS;
      rafCb(nowMs);
    }
  }
  const fireWin = (type, ev) => {
    for (const cb of winListeners[type] ?? []) cb(ev);
  };
  const q = (expr) => vm.runInContext(expr, context);
  return {
    els,
    canvas,
    win: sandbox.window,
    audio,
    q,
    tick,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    lives: () => q("typeof lives === 'undefined' ? NaN : lives"),
    paddleX: () => q("typeof paddle === 'undefined' ? NaN : paddle.x"),
    capsActive: () =>
      q("typeof capsules === 'undefined' ? -1 : capsules.reduce((n, c) => n + (c.active ? 1 : 0), 0)"),
    brickAt(row, col) {
      const cols = q("BRICK_COLS");
      return q(`(() => {
        const t = bricks[${row * cols + col}];
        return { active: t.active, tier: t.tier, x: t.x, y: t.y, w: t.w, h: t.h };
      })()`);
    },
    key(type, code) {
      fireWin(type, { code, preventDefault() {} });
    },
    mouseMove(clientX) {
      canvas.dispatch("mousemove", { clientX });
    },
    canvasClick() {
      canvas.dispatch("click", { type: "click" });
    },
    canvasTap() {
      canvas.dispatch("touchend", { type: "touchend", preventDefault() {} });
    },
    // Drop the serve ball below the bottom edge; one tick costs a
    // life (game over at 0 lives).
    dropBall() {
      q(
        "balls[0].attached = false; balls[0].vx = 0; balls[0].vy = 300;\n" +
          "balls[0].x = paddle.x; balls[0].y = canvas.height + 50;"
      );
      tick(1);
    },
  };
}

const start = (g) => {
  g.els["btn-start"].click();
  g.tick(1);
};

// Park a flying ball one frame above the paddle top, falling straight
// down (vx = 0) at the paddle centre — the classic single-tick bounce.
// The ball is re-parked attached afterwards so later fixtures never
// inherit a stray flying ball.
function bouncePaddle(g) {
  g.q(
    "paddle.x = canvas.width / 2;\n" +
      "balls[0].attached = false;\n" +
      "balls[0].x = paddle.x;\n" +
      "balls[0].y = (canvas.height - PADDLE_BOTTOM_GAP - PADDLE_HEIGHT) - BALL_RADIUS - 5;\n" +
      "balls[0].vx = 0; balls[0].vy = 400;"
  );
  g.tick(1);
  assert(g.q("balls[0].vy") < 0,
    "fixture: the ball must actually have bounced off the paddle (vy flipped up)");
  g.q(
    "balls[0].attached = true; balls[0].vx = 0; balls[0].vy = 0;\n" +
      "balls[0].x = paddle.x; balls[0].y = paddleTop() - BALL_RADIUS;"
  );
}

// Kill one brick through the game's own destroyBrick path.
function killBrick(g, row, col) {
  g.q(`destroyBrick(${row * g.q("BRICK_COLS") + col})`);
}

// Force a drop, aim the paddle under it, drive frames until the
// capsule is caught (applyCapsule runs on the catching frame).
function catchCapsule(g, row, col, maxFrames = 600) {
  const b = g.brickAt(row, col);
  g.q(`paddle.x = ${b.x + b.w / 2}`);
  g.q(`random = () => ${g.q("POWERUP_DROP_RATE") / 2}; 1`); // every roll drops
  killBrick(g, row, col);
  assert(g.capsActive() === 1, `setup: the kill must release one capsule, active=${g.capsActive()}`);
  for (let i = 0; i < maxFrames && g.capsActive() === 1; i += 1) g.tick(1);
  assert(g.capsActive() === 0, "the capsule must be caught by the aimed paddle");
}

// Drive a run to game over: three dropped balls.
function toGameOver(g) {
  for (let i = 0; i < 3 && g.state() !== "gameover"; i += 1) g.dropBall();
  assert(g.state() === "gameover", `setup: the run must end on game over, state=${g.state()}`);
}

// ================================================================
// Criterion 1: the AudioContext is constructed only on the first
// user gesture (click or keydown) — exactly once — and platforms
// without Web Audio run the full loop silently with no exceptions
// ================================================================
check("without an AudioContext stub the full game loop runs silently with no exceptions and never constructs a context", () => {
  const g = boot(960, 600); // no window.AudioContext in the sandbox
  assert(g.audio === null, "setup: this boot must not carry an audio stub");
  assert(
    g.q("(typeof audioCtx === 'undefined' || audioCtx === null) && (typeof MASTER_BUS === 'undefined' || MASTER_BUS === null)"),
    "setup: no audio context or bus exists before any audio runs"
  );
  start(g); // click gesture on a platform with no Web Audio
  g.key("keydown", "ArrowRight"); // keydown gesture, same platform
  g.tick(30);
  bouncePaddle(g); // paddle bounce: silent no-op
  killBrick(g, 0, 3); // brick break: silent no-op
  catchCapsule(g, 4, 5); // power-up catch: silent no-op
  toGameOver(g); // game over: silent no-op
  g.els["btn-restart"].click();
  g.tick(120); // restart and keep looping
  assert(g.state() === "playing" && g.lives() === 3,
    `the restarted run must be healthy, state=${g.state()} lives=${g.lives()}`);
  assert(
    g.q("(typeof audioCtx === 'undefined' || audioCtx === null) && (typeof MASTER_BUS === 'undefined' || MASTER_BUS === null)"),
    "the whole loop must stay on the silent-degradation path"
  );
});

check("with a stubbed AudioContext, boot and frames alone never construct one (no gesture yet)", () => {
  const g = boot(960, 600, { audio: true });
  assert(g.q("typeof MASTER_GAIN === 'number'"), "setup: MASTER_GAIN must be a named numeric var");
  assert(g.q("MASTER_GAIN") === 1, `the master volume must default to 1, got ${g.q("MASTER_GAIN")}`);
  g.tick(30);
  assert(g.audio.rec.constructions === 0,
    `before any user gesture the constructor must not run, constructions=${g.audio.rec.constructions}`);
});

check("a keydown is the first gesture: the constructor is called exactly once, and later gestures reuse the context", () => {
  const g = boot(960, 600, { audio: true });
  g.key("keydown", "ArrowRight");
  assert(g.audio.rec.constructions === 1,
    `the first keydown must construct the context, constructions=${g.audio.rec.constructions}`);
  g.key("keydown", "ArrowLeft");
  g.key("keyup", "ArrowRight");
  g.canvasClick();
  g.canvasTap();
  g.mouseMove(400);
  g.els["btn-start"].click();
  g.tick(10);
  assert(g.audio.rec.constructions === 1,
    `later gestures must never re-construct the context, constructions=${g.audio.rec.constructions}`);
});

check("a click is the first gesture: the constructor is called exactly once, and a later keydown reuses the context", () => {
  const g = boot(960, 600, { audio: true });
  g.canvasClick();
  assert(g.audio.rec.constructions === 1,
    `the first click must construct the context, constructions=${g.audio.rec.constructions}`);
  g.key("keydown", "ArrowLeft");
  g.els["btn-start"].click();
  g.els["btn-restart"].click(); // stray click on the wrong screen: still a gesture, still once
  assert(g.audio.rec.constructions === 1,
    `later keydowns and clicks must never re-construct the context, constructions=${g.audio.rec.constructions}`);
});

// ================================================================
// Criterion 2: each required event schedules its named recipe —
// waveform (sine/square/noise), frequency and duration constants —
// asserted on the stub graph
// ================================================================
check("recipes are named constants: every required event has a recipe whose wave is one of the named waveform constants", () => {
  const g = boot(960, 600, { audio: true });
  const waves = g.q("[WAVE_SINE, WAVE_SQUARE, WAVE_NOISE]");
  assert(JSON.stringify(waves) === JSON.stringify(["sine", "square", "noise"]),
    `the named waveform constants must be the three required sources, got ${JSON.stringify(waves)}`);
  const names = ["SFX_PADDLE_BOUNCE", "SFX_BRICK_BREAK", "SFX_POWERUP_CATCH", "SFX_GAME_OVER"];
  for (const name of names) {
    const r = g.q(name);
    assert(r && waves.includes(r.wave),
      `${name}.wave must be a named waveform constant, got ${r && r.wave}`);
    assert(Number.isFinite(r.freq) && r.freq > 0,
      `${name}.freq must be a positive frequency constant, got ${r && r.freq}`);
    assert(Number.isFinite(r.dur) && r.dur > 0,
      `${name}.dur must be a positive duration constant, got ${r && r.dur}`);
    assert(Number.isFinite(g.q("SFX_ATTACK_SECONDS")) && g.q("SFX_ATTACK_SECONDS") < r.dur,
      `the named attack must be shorter than ${name}.dur`);
  }
});

check("a paddle bounce schedules the paddle recipe: a sine oscillator at SFX_PADDLE_BOUNCE.freq, sounding for exactly SFX_PADDLE_BOUNCE.dur", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const os = g.audio.rec.oscillators.length;
  bouncePaddle(g);
  assert(g.audio.rec.oscillators.length === os + 1,
    `a paddle bounce must create exactly one oscillator, created ${g.audio.rec.oscillators.length - os}`);
  const r = g.q("SFX_PADDLE_BOUNCE");
  const osc = g.audio.rec.oscillators[os];
  assert(osc.type === "sine" && osc.type === g.q("WAVE_SINE") && r.wave === g.q("WAVE_SINE"),
    `the paddle recipe must be the named sine wave, scheduled type=${osc.type}`);
  assert(osc.frequency.value === r.freq,
    `the oscillator must sound the recipe frequency ${r.freq} Hz, got ${osc.frequency.value}`);
  assert(osc.startTimes.length === 1 && osc.stopTimes.length === 1,
    `the source must be started and stopped once, start=${JSON.stringify(osc.startTimes)} stop=${JSON.stringify(osc.stopTimes)}`);
  assertClose(osc.stopTimes[0] - osc.startTimes[0], r.dur, 1e-9,
    `the sound must last exactly the recipe duration ${r.dur}s`);
});

check("a brick break schedules the brick recipe: the shared noise buffer (no oscillator) through the recipe-frequency lowpass, sounding for exactly SFX_BRICK_BREAK.dur", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const bs = g.audio.rec.bufferSources.length;
  killBrick(g, 1, 2);
  assert(g.audio.rec.bufferSources.length === bs + 1,
    `a brick break must start exactly one buffer source, created ${g.audio.rec.bufferSources.length - bs}`);
  assert(g.audio.rec.oscillators.length === 0,
    "a brick break must not use an oscillator");
  const r = g.q("SFX_BRICK_BREAK");
  assert(r.wave === g.q("WAVE_NOISE"), `the brick recipe must be the named noise wave, got ${r.wave}`);
  const src = g.audio.rec.bufferSources[bs];
  assert(src.buffer === g.q("noiseBuffer"),
    "the buffer source must play the game's prebuilt noise buffer");
  const buf = g.audio.rec.buffers[0];
  assert(buf && buf.channels === 1 &&
      buf.length === Math.floor(g.q("SFX_NOISE_BUFFER_SECONDS") * 44100),
    "the noise buffer must be the named-length mono buffer built once at init");
  assert(buf.data.some((v) => v !== 0), "the noise buffer must contain generated noise, not silence");
  assertClose(src.stopTimes[0] - src.startTimes[0], r.dur, 1e-9,
    `the noise burst must last exactly the recipe duration ${r.dur}s`);
  const filt = g.audio.rec.filters[g.audio.rec.filters.length - 1];
  assert(filt && filt.type === "lowpass" && filt.frequency.value === r.freq,
    `the noise must pass a lowpass filter at the recipe frequency ${r.freq} Hz, got ${JSON.stringify(filt && { type: filt.type, freq: filt.frequency.value })}`);
  assert(src.dest.length === 1 && src.dest[0] === filt,
    "the buffer source must feed only the filter");
  assert(filt.dest.length === 1 && filt.dest[0].kind === "gain",
    "the filter must feed only the sound's envelope gain");
});

check("a power-up catch schedules the power-up recipe: a square oscillator at SFX_POWERUP_CATCH.freq, sounding for exactly SFX_POWERUP_CATCH.dur", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const os = g.audio.rec.oscillators.length;
  catchCapsule(g, 4, 5);
  assert(g.audio.rec.oscillators.length === os + 1,
    `a catch must create exactly one oscillator, created ${g.audio.rec.oscillators.length - os}`);
  const r = g.q("SFX_POWERUP_CATCH");
  const osc = g.audio.rec.oscillators[os];
  assert(osc.type === "square" && r.wave === g.q("WAVE_SQUARE"),
    `the power-up recipe must be the named square wave, scheduled type=${osc.type}`);
  assert(osc.frequency.value === r.freq,
    `the oscillator must sound the recipe frequency ${r.freq} Hz, got ${osc.frequency.value}`);
  assertClose(osc.stopTimes[0] - osc.startTimes[0], r.dur, 1e-9,
    `the sound must last exactly the recipe duration ${r.dur}s`);
});

check("game over schedules the game-over recipe: a sine oscillator at SFX_GAME_OVER.freq, sounding for exactly SFX_GAME_OVER.dur — the longest of the four", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const os = g.audio.rec.oscillators.length;
  toGameOver(g);
  assert(g.audio.rec.oscillators.length === os + 1,
    `game over must create exactly one oscillator, created ${g.audio.rec.oscillators.length - os}`);
  const r = g.q("SFX_GAME_OVER");
  const osc = g.audio.rec.oscillators[os];
  assert(osc.type === "sine" && r.wave === g.q("WAVE_SINE"),
    `the game-over recipe must be the named sine wave, scheduled type=${osc.type}`);
  assert(osc.frequency.value === r.freq,
    `the oscillator must sound the recipe frequency ${r.freq} Hz, got ${osc.frequency.value}`);
  assertClose(osc.stopTimes[0] - osc.startTimes[0], r.dur, 1e-9,
    `the sound must last exactly the recipe duration ${r.dur}s`);
  const durs = g.q("[SFX_PADDLE_BOUNCE.dur, SFX_BRICK_BREAK.dur, SFX_POWERUP_CATCH.dur, SFX_GAME_OVER.dur]");
  assert(durs.every((d) => d <= r.dur) && durs.some((d) => d < r.dur),
    `SFX_GAME_OVER.dur must be the longest recipe duration, got ${JSON.stringify(durs)}`);
});

check("an envelope is shaped by the named attack constant: 0 -> SFX_PEAK * MASTER_GAIN -> 0, terminating at the recipe duration", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const before = envelopes(g).length;
  bouncePaddle(g);
  assert(envelopes(g).length === before + 1, "the bounce must create exactly one envelope gain");
  const env = envelopes(g)[before];
  const r = g.q("SFX_PADDLE_BOUNCE");
  const atk = g.q("SFX_ATTACK_SECONDS");
  assert(env.events.length === 3,
    `the envelope must schedule exactly three automation events, got ${JSON.stringify(env.events)}`);
  assert(env.events[0][0] === 0, `the envelope must start at 0, got ${JSON.stringify(env.events[0])}`);
  assertClose(env.events[1][0], g.q("SFX_PEAK") * g.q("MASTER_GAIN"), 1e-9,
    `the peak must be the named SFX_PEAK scaled by MASTER_GAIN`);
  assertClose(env.events[1][1] - env.events[0][1], atk, 1e-9,
    `the peak must land at start + SFX_ATTACK_SECONDS`);
  assert(env.events[2][0] === 0, `the envelope must terminate at 0, got ${JSON.stringify(env.events[2])}`);
  assertClose(env.events[2][1] - env.events[0][1], r.dur, 1e-9,
    `the termination must land at the recipe duration ${r.dur}s`);
});

check("events outside the required set schedule no sound: a wall reflection and a non-fatal ball loss stay silent", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const n0 = soundParts(g);
  // Right-wall reflection in the field:
  g.q(
    "balls[0].attached = false; balls[0].x = canvas.width - BALL_RADIUS - 3; balls[0].y = 500; balls[0].vx = 300; balls[0].vy = 120;"
  );
  g.tick(1);
  assert(g.q("balls[0].vx") < 0, "setup: the wall reflection must have flipped vx");
  assert(soundParts(g) === n0,
    `a wall reflection must schedule no sound, scheduled ${soundParts(g) - n0} nodes`);
  // Ball loss while lives remain (fresh attached serve, no game over):
  g.dropBall();
  assert(g.lives() === 2, `setup: one life must remain, lives=${g.lives()}`);
  assert(soundParts(g) === n0,
    `a non-fatal ball loss must schedule no sound, scheduled ${soundParts(g) - n0} nodes`);
});

// ================================================================
// Criterion 3: every recipe routes through the single master gain
// bus — the one GainNode wired to destination — and reassigning
// MASTER_GAIN = 0 mutes every subsequently scheduled envelope
// ================================================================
check("every envelope gain connects to the one master bus gain, and the bus is the only node wired to destination", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  bouncePaddle(g);
  killBrick(g, 2, 4);
  catchCapsule(g, 3, 4);
  const envs = envelopes(g);
  assert(envs.length === 3, `three events must yield three envelopes, got ${envs.length}`);
  const bus = busGains(g);
  assert(bus.length === 1,
    `exactly one gain node may be wired to destination (the bus), got ${bus.length}`);
  for (const e of envs) {
    assert(e.dest.length === 1 && e.dest[0] === bus[0],
      "every envelope gain must connect to the single bus gain, and to nothing else");
  }
  assert(bus[0].dest.length === 1 && bus[0].dest[0] === g.audio.destination,
    "the bus must be wired only to the context destination");
  for (const n of [...g.audio.rec.oscillators, ...g.audio.rec.bufferSources, ...g.audio.rec.filters]) {
    assert(!n.dest.includes(g.audio.destination),
      "sources and filters must never bypass the bus to destination");
  }
  assert(bus[0].events.length === 0, "the bus must not carry sound envelopes of its own");
});

check("reassigning MASTER_GAIN = 0 silences every subsequently scheduled envelope (peak and terminus at 0), leaving earlier envelopes untouched", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  bouncePaddle(g); // a pre-mute sound
  const pre = envelopes(g)[0];
  assert(pre.events[1][0] > 0, `setup: the pre-mute envelope must have a nonzero peak, got ${pre.events[1][0]}`);
  g.q("MASTER_GAIN = 0");
  const n0 = soundParts(g);
  bouncePaddle(g);
  killBrick(g, 0, 0);
  catchCapsule(g, 4, 9);
  assert(soundParts(g) - n0 > 0, "setup: the post-mute events must still schedule sounds");
  const post = envelopes(g).slice(1);
  assert(post.length === 3, `three post-mute events must yield three envelopes, got ${post.length}`);
  for (const e of post) {
    assert(e.events.every(([v]) => v === 0),
      `a post-mute envelope must be silent: every automation value is 0, got ${JSON.stringify(e.events)}`);
  }
  assert(pre.events[1][0] > 0,
    "the pre-mute envelope must keep its original peak (muting affects only subsequent sounds)");
});

// ================================================================
// Criterion 4: no audio assets — no Image/Worker constructors, no
// external src/href refs (mirrors the dev-loop gate checks)
// ================================================================
check("bricks.html introduces no `new Image(` / `new Worker(` constructors and no external src/href refs", () => {
  const ctorHits = html.match(/\bnew\s+(Image|Worker)\(/gi) ?? [];
  assert(ctorHits.length === 0,
    `bricks.html must contain no new Image()/new Worker() constructors, found ${ctorHits.length}`);
  const extHits = html.match(/(src|href)=/g) ?? [];
  assert(extHits.length === 0,
    `bricks.html must contain no external src=/href= refs, found ${extHits.length}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
