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
//  5. (ticket #72) Non-lethal hits on multi-hit bricks schedule a chip
//     blip on the master bus whose pitch descends with the brick's hp
//     at hit (3-hp brick: tier-3 pitch, then the lower tier-2 pitch);
//     the fatal hit schedules only the destruction pop, never a chip.
//     1-hp bricks and fixed bricks schedule no chip at all; mute/volume
//     honours apply to chips through the same bus as every other recipe.
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
function makeAudioGraph(opts = {}) {
  const rec = {
    constructions: 0,
    resumeCalls: 0,
    resumeCatches: 0,
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
    state: opts.suspended ? "suspended" : "running",
    // resume() resolves asynchronously like the real API; callers
    // must swallow rejection with a .catch handler (review fix #3).
    resume() {
      rec.resumeCalls += 1;
      ctx.state = "running";
      return {
        then() {
          return this;
        },
        catch(fn) {
          if (typeof fn === "function") rec.resumeCatches += 1;
          return this;
        },
      };
    },
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
      const n = { kind: "gain", events: [], dest: [], lastValue: 1 };
      n.gain = {
        value: 1,
        setValueAtTime(v, t) {
          n.lastValue = v;
          n.events.push([v, t]);
        },
        linearRampToValueAtTime(v, t) {
          n.events.push([v, t]);
        },
        // Exponential ramps only ever span positive values: the real
        // API rejects a non-positive target, and a non-positive start
        // leaves the parameter undefined (-inf). Enforce both so the
        // suites catch unclamped recipes (review fix #1).
        exponentialRampToValueAtTime(v, t) {
          if (!(v > 0) || !Number.isFinite(v))
            throw new RangeError(
              `exponentialRampToValueAtTime: target must be positive and finite, got ${v}`
            );
          if (!(n.lastValue > 0))
            throw new RangeError(
              `exponentialRampToValueAtTime: ramp start must be positive, got ${n.lastValue}`
            );
          n.lastValue = v;
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
  const audio = opts.audio ? makeAudioGraph(opts) : null;
  const canvas = {
    width: 0,
    height: 0,
    // Records CSS style writes (stage letterbox fit) and answers
    // getBoundingClientRect() with a rect filling the boot viewport.
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
    game: canvas,
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
    "ball-speed": makeEl("ball-speed"),
    "screen-gameover": makeEl("screen-gameover"),
    "btn-restart": makeEl("btn-restart"),
    "btn-menu": makeEl("btn-menu"),
    "screen-pause": makeEl("screen-pause"),
    "btn-resume": makeEl("btn-resume"),
    "gameover-final": makeEl("gameover-final"),
    "hud-score": makeEl("hud-score"),
    "hud-level": makeEl("hud-level"),
    "hiscore": makeEl("hiscore"),
    lives: makeEl("lives"),
    "btn-reset-hiscore": makeEl("btn-reset-hiscore"),
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
    },
    requestAnimationFrame: (cb) => {
      rafCb = cb;
      return ++rafId;
    },
  };
  if (audio) sandbox.AudioContext = audio.ctor;
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
        return { active: t.active, tier: t.tier, hp: t.hp, x: t.x, y: t.y, w: t.w, h: t.h };
      })()`);
    },
    key(type, code) {
      fireWin(type, { code, preventDefault() {} });
    },
    mouseMove(clientX) {
      // ticket #40: pointer tracking is window-level.
      fireWin("mousemove", { clientX });
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

// Route one direct hit through the game's own collideBricks(): park
// the serve ball on the brick's centre, call collideBricks once, then
// clear the per-frame charge (update() normally clears it at frame
// end) and re-park the ball so repeat hits work. Returns the brick's
// state after the hit.
function chipHit(g, row, col) {
  const b = g.brickAt(row, col);
  assert(b.active, `setup: brick (${row},${col}) must be active`);
  g.q(`
    balls[0].attached = true;
    balls[0].x = ${b.x + b.w / 2};
    balls[0].y = ${b.y + b.h / 2};
    balls[0].vx = 0; balls[0].vy = 0;
    collideBricks(balls[0]);
    bricks[${row * g.q("BRICK_COLS") + col}].charged = false;
    balls[0].attached = true;
    balls[0].vx = 0; balls[0].vy = 0;
    1`
  );
  return g.brickAt(row, col);
}

// Move the volume slider the way the browser would: set the DOM
// value, then fire the "input" event.
function setVolume(g, v) {
  const el = g.els["sound-volume"];
  el.value = String(v);
  for (const cb of el.listeners["input"] ?? []) cb({ type: "input" });
}

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
  g.q("random = () => 1; 1"); // no unplanned capsule before the forced catch
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
  assert(g.q("MASTER_GAIN") === 0.2, `the master bus level must default to 0.2, got ${g.q("MASTER_GAIN")}`);
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
  }
  assert(Number.isFinite(g.q("SFX_PEAK")) && g.q("SFX_PEAK") > 0,
    "SFX_PEAK must be a positive named constant");
  const floor = g.q("SFX_DECAY_FLOOR");
  assert(Number.isFinite(floor) && floor > 0 && floor < 0.01,
    `SFX_DECAY_FLOOR must be a small positive named constant, got ${floor}`);
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
      buf.length === Math.max(1, Math.ceil(g.q("SFX_NOISE_BUFFER_SECONDS") * 44100)),
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

check("an envelope peaks at SFX_PEAK and decays to the named floor at the recipe duration", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const before = envelopes(g).length;
  bouncePaddle(g);
  assert(envelopes(g).length === before + 1, "the bounce must create exactly one envelope gain");
  const env = envelopes(g)[before];
  const r = g.q("SFX_PADDLE_BOUNCE");
  assert(env.events.length === 2,
    `the envelope must schedule exactly two automation events, got ${JSON.stringify(env.events)}`);
  assertClose(env.events[0][0], g.q("SFX_PEAK"), 1e-9,
    `the envelope must peak at the named SFX_PEAK`);
  assertClose(env.events[1][0], g.q("SFX_DECAY_FLOOR"), 1e-9,
    `the envelope must decay to the named SFX_DECAY_FLOOR`);
  assertClose(env.events[1][1] - env.events[0][1], r.dur, 1e-9,
    `the decay must land at the recipe duration ${r.dur}s`);
});

check("SFX_DECAY_FLOOR = 0 no longer throws: the exponential-ramp target is clamped to a positive floor (1e-4)", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  g.q("SFX_DECAY_FLOOR = 0"); // the console can zero the named constant
  let threw = null;
  try {
    bouncePaddle(g);
  } catch (err) {
    threw = err;
  }
  assert(threw === null,
    `scheduling with SFX_DECAY_FLOOR = 0 must not throw, threw ${threw && threw.message}`);
  const env = envelopes(g).slice(-1)[0];
  assertClose(env.events[env.events.length - 1][0], 1e-4, 1e-12,
    `the decay target must clamp to 1e-4, got ${JSON.stringify(env.events)}`);
});

check("SFX_PEAK = 0 no longer throws: the ramp start at schedule time is clamped to a positive floor (1e-4)", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  g.q("SFX_PEAK = 0"); // the console can zero the named constant
  let threw = null;
  try {
    bouncePaddle(g);
  } catch (err) {
    threw = err;
  }
  assert(threw === null,
    `scheduling with SFX_PEAK = 0 must not throw, threw ${threw && threw.message}`);
  const env = envelopes(g).slice(-1)[0];
  assertClose(env.events[0][0], 1e-4, 1e-12,
    `the ramp start at schedule time must clamp to 1e-4, got ${JSON.stringify(env.events)}`);
  assertClose(env.events[0][1], 0, 1e-12,
    "the clamped start must be set at the schedule time (t0)");
});

check("every audioCtx.resume() Promise gets a bare .catch: a rejecting resume() can never escape as an unhandled rejection", () => {
  const g = boot(960, 600, { audio: true, suspended: true });
  assert(g.audio.ctx.state === "suspended", "setup: the stub must start suspended");
  g.key("keydown", "ArrowRight"); // first gesture: constructs and resumes
  assert(g.audio.rec.resumeCalls >= 1,
    `the suspended context must be resumed on the first gesture, calls=${g.audio.rec.resumeCalls}`);
  assert(g.audio.rec.resumeCatches === g.audio.rec.resumeCalls,
    `every resume() call must attach a .catch handler, calls=${g.audio.rec.resumeCalls} catches=${g.audio.rec.resumeCatches}`);
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
  g.q("random = () => 1; 1"); // the intermediate kill must not release a capsule
  killBrick(g, 2, 4);
  catchCapsule(g, 3, 4);
  const envs = envelopes(g);
  // Four scheduled sounds for three visible events: the catch fixture
  // also destroys a brick, so two breaks land on the graph.
  assert(envs.length === 4, `the fixture must yield four envelopes, got ${envs.length}`);
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

check("reassigning MASTER_GAIN = 0 zeroes the bus for every subsequent schedule: the envelopes run into the zeroed bus and decay to the named floor", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  bouncePaddle(g); // a pre-mute sound
  const [bus] = busGains(g);
  assert(bus !== undefined, "setup: the bus must exist after the first sound");
  assertClose(bus.gain.value, g.q("MASTER_GAIN"), 0,
    `the bus must carry MASTER_GAIN after a scheduled sound, got ${bus.gain.value}`);
  g.q("MASTER_GAIN = 0");
  const n0 = soundParts(g);
  bouncePaddle(g);
  g.q("random = () => 1; 1"); // the intermediate kill must not release a capsule
  killBrick(g, 0, 0);
  catchCapsule(g, 4, 9);
  assert(soundParts(g) - n0 > 0, "setup: the post-mute events must still schedule sounds");
  assertClose(bus.gain.value, 0, 0,
    `with MASTER_GAIN = 0 the bus must carry zero gain for the subsequent sounds, got ${bus.gain.value}`);
  const post = envelopes(g).slice(1);
  // Four post-mute sounds: bounce, break, break, catch — the catch
  // fixture also destroys a brick.
  assert(post.length === 4, `the post-mute events must yield four envelopes, got ${post.length}`);
  for (const e of post) {
    // The envelope keeps its named shape (the mute is the bus), but
    // it is silenced: peak x 0 bus = 0, decay floor x 0 = 0.
    assertClose(e.events[e.events.length - 1][0], g.q("SFX_DECAY_FLOOR"), 1e-9,
      `a post-mute envelope must decay to the named floor, got ${JSON.stringify(e.events)}`);
    // Pinned interpretation (review fix #2): "terminates at 0" means
    // the audible level — envelope terminus x bus gain = exactly 0.
    assert(e.events[e.events.length - 1][0] * bus.gain.value === 0,
      `post-mute terminus x bus gain must be exactly 0, got ${e.events[e.events.length - 1][0]} x ${bus.gain.value}`);
  }
  const pre = envelopes(g)[0];
  assertClose(pre.events[0][0], g.q("SFX_PEAK"), 1e-9,
    "the pre-mute envelope must keep its original peak");
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

// ================================================================
// Criterion 5 (ticket #72): audible chip cue on non-lethal multi-hit
// brick hits — pitch descends as the brick weakens, the fatal hit
// keeps the destruction pop, 1-hp/fixed bricks never chip, and the
// master bus (mute + volume) honours chips exactly like every
// other recipe
// ================================================================
check("the chip recipe is a named recipe and the pitch table is named, strictly descending with hp, all below the destruction pop", () => {
  const g = boot(960, 600, { audio: true });
  const r = g.q("SFX_BRICK_CHIP");
  assert(r && r.wave === g.q("WAVE_SINE"),
    `SFX_BRICK_CHIP.wave must be the named sine wave, got ${r && r.wave}`);
  assert(Number.isFinite(r.dur) && r.dur > 0 && r.dur < g.q("SFX_BRICK_BREAK.dur"),
    `SFX_BRICK_CHIP.dur must be a short positive duration (a blip, shorter than the pop), got ${r && r.dur}`);
  const freqs = g.q("SFX_BRICK_CHIP_FREQ");
  assert(Array.isArray(freqs) && freqs.length >= 4,
    `SFX_BRICK_CHIP_FREQ must be a named table indexed by hp (at least [0, 1, 2, 3]), got ${JSON.stringify(freqs)}`);
  for (let hp = 1; hp < freqs.length; hp += 1) {
    assert(Number.isFinite(freqs[hp]) && freqs[hp] > 0,
      `SFX_BRICK_CHIP_FREQ[${hp}] must be a positive frequency, got ${freqs[hp]}`);
    if (hp > 1) {
      assert(freqs[hp] > freqs[hp - 1],
        `the pitch must climb with hp so a weakening brick descends: tier-${hp} (${freqs[hp]}) must be higher than tier-${hp - 1} (${freqs[hp - 1]})`);
    }
    assert(freqs[hp] < g.q("SFX_BRICK_BREAK.freq"),
      `tier-${hp} chip (${freqs[hp]} Hz) must sit below the destruction pop (${g.q("SFX_BRICK_BREAK.freq")} Hz)`);
  }
});

check("non-lethal hits on a 3-hp brick chip: first hit at the tier-3 pitch, second at the lower tier-2 pitch; the fatal hit schedules the destruction pop and no chip", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  g.q("random = () => 1; 1"); // the fatal kill must not release a capsule
  const b0 = g.brickAt(0, 0);
  assert(b0.tier === 0 && g.q(`bricks[0].hp`) === 3,
    `setup: row 0 of level 1 must be a 3-hp tier, got tier=${b0.tier} hp=${g.q("bricks[0].hp")}`);
  const freqs = g.q("SFX_BRICK_CHIP_FREQ");
  const os0 = g.audio.rec.oscillators.length;
  const bs0 = g.audio.rec.bufferSources.length;
  // Hit 1: 3 hp -> 2 hp, non-lethal, tier-3 chip
  const after1 = chipHit(g, 0, 0);
  assert(after1.active && after1.hp === 2, `hit 1 must leave the brick alive at hp 2, hp=${after1.hp} active=${after1.active}`);
  assert(g.audio.rec.oscillators.length === os0 + 1, `a non-lethal hit must schedule exactly one chip oscillator, got ${g.audio.rec.oscillators.length - os0}`);
  assert(g.audio.rec.bufferSources.length === bs0,
    `a non-lethal hit must not schedule the destruction pop, created ${g.audio.rec.bufferSources.length - bs0} buffer sources`);
  const chip1 = g.audio.rec.oscillators[os0];
  assert(chip1.type === g.q("WAVE_SINE"), `the chip must be the named sine wave, got ${chip1.type}`);
  assert(chip1.frequency.value === freqs[3],
    `the first chip (3-hp brick) must sound the tier-3 pitch ${freqs[3]} Hz, got ${chip1.frequency.value}`);
  assertClose(chip1.stopTimes[0] - chip1.startTimes[0], g.q("SFX_BRICK_CHIP.dur"), 1e-9,
    `the chip must last exactly SFX_BRICK_CHIP.dur`);
  // Hit 2: 2 hp -> 1 hp, non-lethal, tier-2 chip (lower)
  const os1 = g.audio.rec.oscillators.length;
  const after2 = chipHit(g, 0, 0);
  assert(after2.active && after2.hp === 1, `hit 2 must leave the brick alive at hp 1, hp=${after2.hp}`);
  assert(g.audio.rec.oscillators.length === os1 + 1, "hit 2 must schedule exactly one chip oscillator");
  assert(g.audio.rec.bufferSources.length === bs0, "hit 2 must not schedule the destruction pop");
  const chip2 = g.audio.rec.oscillators[os1];
  assert(chip2.frequency.value === freqs[2],
    `the second chip (2-hp brick) must sound the tier-2 pitch ${freqs[2]} Hz, got ${chip2.frequency.value}`);
  assert(chip2.frequency.value < chip1.frequency.value,
    `the brick must weaken audibly: the tier-2 pitch (${chip2.frequency.value}) must be lower than the tier-3 pitch (${chip1.frequency.value})`);
  // Hit 3: 1 hp -> 0 hp, fatal: the destruction pop, no chip
  const os2 = g.audio.rec.oscillators.length;
  const after3 = chipHit(g, 0, 0);
  assert(!after3.active, `hit 3 must destroy the brick, active=${after3.active}`);
  assert(g.audio.rec.bufferSources.length === bs0 + 1,
    `the fatal hit must schedule the destruction pop (one buffer source), created ${g.audio.rec.bufferSources.length - bs0 - 1}`);
  assert(g.audio.rec.oscillators.length === os2,
    `the fatal hit must schedule NO chip, created ${g.audio.rec.oscillators.length - os2} extra oscillators`);
});

check("a 1-hp brick schedules only the destruction sound on its hit — no chip, no oscillator", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  g.q("random = () => 1; 1"); // the kill must not release a capsule
  const b0 = g.brickAt(2, 0);
  assert(b0.tier === 2 && g.q(`bricks[${2 * g.q("BRICK_COLS")}].hp`) === 1,
    `setup: row 2 of level 1 must be a 1-hp tier, got tier=${b0.tier} hp=${g.q(`bricks[${2 * g.q("BRICK_COLS")}].hp`)}`);
  const os0 = g.audio.rec.oscillators.length;
  const bs0 = g.audio.rec.bufferSources.length;
  const after = chipHit(g, 2, 0);
  assert(!after.active, `the 1-hp brick must die on its first hit, active=${after.active}`);
  assert(g.audio.rec.bufferSources.length === bs0 + 1,
    "the hit must schedule the destruction pop");
  assert(g.audio.rec.oscillators.length === os0,
    `a 1-hp brick must never chip, created ${g.audio.rec.oscillators.length - os0} extra oscillators`);
});

check("a fixed (unbreakable) brick stays silent: no chip, no pop, no hp or charge change", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const idx = 0 * g.q("BRICK_COLS") + 1; // row 0, col 1: a 3-hp brick
  g.q(`bricks[${idx}].unbreakable = true; bricks[${idx}].hp = 9; 1`); // console-marked fixed
  const n0 = soundParts(g);
  const after = chipHit(g, 0, 1);
  assert(after.active && after.hp === 9,
    `a fixed brick must survive every hit with hp intact, hp=${after.hp} active=${after.active}`);
  assert(g.q(`bricks[${idx}].charged`) === false,
    "a fixed brick must never spend a damage charge");
  assert(soundParts(g) === n0,
    `a hit on a fixed brick must schedule no sound, scheduled ${soundParts(g) - n0} nodes`);
});

check("mute ON drives the chip through the bus at gain 0; unmuting at volume 50 plays the chip at SOUND_BASE x 0.5", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  g.els["btn-mute"].click(); // mute ON
  g.q("random = () => 1; 1"); // no capsule from any eventual kill
  const e0 = envelopes(g).length;
  const b = chipHit(g, 0, 0); // non-lethal: the chip still schedules...
  assert(b.active && b.hp === 2, "setup: the chip hit must land on the 3-hp brick");
  assert(envelopes(g).length === e0 + 1,
    "a muted chip must still schedule its envelope (silence is the bus, not skipped scheduling)");
  const [bus] = busGains(g);
  assert(bus !== undefined, "setup: the bus must exist after a scheduled sound");
  assertClose(bus.gain.value, 0, 0,
    `with mute ON the chip must schedule at bus gain 0, got ${bus.gain.value}`);
  g.els["btn-mute"].click(); // mute OFF
  setVolume(g, 50);
  chipHit(g, 0, 0);
  assertClose(bus.gain.value, g.q("SOUND_BASE") * 0.5, 1e-9,
    `after unmuting at volume 50 the chip must play at SOUND_BASE x 0.5, got ${bus.gain.value}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
