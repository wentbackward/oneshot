#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html wall-bounce cue (ticket #96)
//
// Runs the REAL <script> from bricks.html in a sandboxed vm context
// (same harness style as tests/bricks-audio.test.mjs), with a
// recording AudioContext stub. Drives controlled balls at the TOP,
// LEFT and RIGHT walls and counts scheduled events.
//
// Criteria covered:
//  1. SFX_WALL_BOUNCE is a named recipe on the existing recipe /
//     scheduleSound system: a named waveform, a short duration
//     (<= 0.06 s), quieter than a brick pop (own peak below
//     SFX_PEAK), and distinct from the brick chip/pop pitches.
//  2. The cue is scheduled exactly when a ball reflects off the
//     TOP, LEFT or RIGHT wall — each reflection schedules exactly
//     one blip of the recipe (wave / freq / duration asserted on
//     the stub graph), and the envelope peaks at the recipe's own
//     (restrained) peak, not SFX_PEAK.
//  3. Paddle and brick contacts do NOT schedule the wall cue:
//     paddle bounces and brick chip/destruction schedule their own
//     cues only.
//  4. The cue honours mute + volume through the same single bus as
//     every other recipe (mute -> bus gain 0, unmute + volume 50
//     -> SOUND_BASE x 0.5), and scheduling still occurs while muted
//     (silence is the bus, not skipped scheduling).
//  5. No new allocation in the hot path: the recipe object is
//     reused in place — repeated bounces create one oscillator and
//     one envelope each, never buffer sources or extra nodes, and
//     a corner hit (two reflections in one call) schedules exactly
//     two blips.
//
// Run: node tests/bricks-wallbounce.test.mjs
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
// Same recording contract as tests/bricks-audio.test.mjs: nodes
// record their connections; sources record start/stop times; gain
// nodes record every automation event.
function makeAudioGraph(opts = {}) {
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
    state: opts.suspended ? "suspended" : "running",
    resume() {
      ctx.state = "running";
      return { then() { return this; }, catch(fn) { return this; } };
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
function boot(width = 960, height = 600, opts = {}) {
  const audio = opts.audio ? makeAudioGraph(opts) : null;
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
    game: canvas,
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
    key(type, code) {
      fireWin(type, { code, preventDefault() {} });
    },
    canvasClick() {
      canvas.dispatch("click", { type: "click" });
    },
  };
}

const start = (g) => {
  g.els["btn-start"].click();
  g.tick(1);
};

// Move the volume slider the way the browser would: set the DOM
// value, then fire the "input" event.
function setVolume(g, v) {
  const el = g.els["sound-volume"];
  el.value = String(v);
  for (const cb of el.listeners["input"] ?? []) cb({ type: "input" });
}

// Park the serve ball attached (velocity zero) so later fixtures
// never inherit a stray flying ball.
function repark(g) {
  g.q(
    "balls[0].attached = true; balls[0].vx = 0; balls[0].vy = 0;\n" +
      "balls[0].x = paddle.x; balls[0].y = paddleTop() - BALL_RADIUS;"
  );
}

// Drive the ball horizontally into the named side wall (left/right)
// from just inside it, with zero vertical velocity — one guaranteed
// reflection, no brick/paddle involvement (y=500 sits clear of both
// the brick field and the paddle face). Returns the new vx.
function driveIntoSideWall(g, side) {
  const x0 =
    side === "right"
      ? "canvas.width - BALL_RADIUS - 3"
      : "BALL_RADIUS + 3";
  const v0 = side === "right" ? 300 : -300;
  g.q(
    `balls[0].attached = false;\n` +
      `balls[0].x = ${x0}; balls[0].y = 500;\n` +
      `balls[0].vx = ${v0}; balls[0].vy = 0;`
  );
  g.tick(1);
  return g.q("balls[0].vx");
}
// Drive the ball straight up into the TOP wall from the empty band
// between the wall and the brick field (bricks start at
// BRICK_TOP_MARGIN). One reflection, no brick/paddle involvement.
function driveIntoTopWall(g) {
  g.q(
    "balls[0].attached = false;\n" +
      "balls[0].x = canvas.width / 2;\n" +
      "balls[0].y = 40;\n" +
      "balls[0].vx = 0; balls[0].vy = -3000;"
  );
  g.tick(1);
  return g.q("balls[0].vy");
}

// Park a flying ball one frame above the paddle top, falling straight
// down (vx = 0) at the paddle centre — the classic single-tick
// paddle bounce.
function bouncePaddle(g) {
  g.q(
    "paddle.x = canvas.width / 2;\n" +
      "balls[0].attached = false;\n" +
      "balls[0].x = paddle.x;\n" +
      "balls[0].y = (canvas.height - PADDLE_BOTTOM_GAP - PADDLE_HEIGHT) - BALL_RADIUS - 5;\n" +
      "balls[0].vx = 0; balls[0].vy = 400;"
  );
  g.tick(1);
  assert(
    g.q("balls[0].vy") < 0,
    "fixture: the ball must actually have bounced off the paddle (vy flipped up)"
  );
  repark(g);
}

// ================================================================
// Criterion 1: SFX_WALL_BOUNCE is a named recipe, restrained and
// distinct from the brick chip/pop
// ================================================================
check("SFX_WALL_BOUNCE is a named recipe with a named wave, a short (<= 0.06 s) duration and positive frequency", () => {
  const g = boot(960, 600, { audio: true });
  const r = g.q("SFX_WALL_BOUNCE");
  assert(r !== null && typeof r === "object",
    "SFX_WALL_BOUNCE must be a named recipe object on the game's recipe system");
  const waves = g.q("[WAVE_SINE, WAVE_SQUARE, WAVE_NOISE]");
  assert(waves.includes(r.wave),
    `SFX_WALL_BOUNCE.wave must be a named waveform constant, got ${r.wave}`);
  assert(Number.isFinite(r.freq) && r.freq > 0,
    `SFX_WALL_BOUNCE.freq must be a positive named frequency, got ${r.freq}`);
  assert(Number.isFinite(r.dur) && r.dur > 0 && r.dur <= 0.06,
    `SFX_WALL_BOUNCE.dur must be a short positive duration (<= 0.06 s), got ${r.dur}`);
});

check("the wall cue is restrained: its envelope peak is a named value strictly below SFX_PEAK (quieter than a brick pop)", () => {
  const g = boot(960, 600, { audio: true });
  const peak = g.q("SFX_WALL_BOUNCE_PEAK");
  assert(Number.isFinite(peak) && peak > 0,
    "SFX_WALL_BOUNCE_PEAK must be a named positive constant (console-retunable)");
  assert(peak < g.q("SFX_PEAK"),
    `the wall cue peak (${peak}) must be strictly below SFX_PEAK (${g.q("SFX_PEAK")}) so rapid rattle stays quiet`);
  const r = g.q("SFX_WALL_BOUNCE");
  assert(r.peak === peak,
    "the recipe must carry its own peak via the named SFX_WALL_BOUNCE_PEAK");
});

check("the wall cue is distinct from the brick chip and the destruction pop: different frequency, not the pop's noise wave", () => {
  const g = boot(960, 600, { audio: true });
  const r = g.q("SFX_WALL_BOUNCE");
  assert(r.freq !== g.q("SFX_BRICK_BREAK.freq"),
    `the wall cue (${r.freq} Hz) must not share the destruction pop's frequency`);
  assert(r.wave !== g.q("WAVE_NOISE"),
    "the wall cue must not be the pop's noise wave");
  const chipFreqs = g.q("SFX_BRICK_CHIP_FREQ");
  for (let hp = 1; hp < chipFreqs.length; hp += 1) {
    assert(r.freq !== chipFreqs[hp],
      `the wall cue (${r.freq} Hz) must not share the tier-${hp} chip pitch (${chipFreqs[hp]} Hz)`);
  }
});

// ================================================================
// Criterion 2: the cue is scheduled exactly when a ball reflects
// off the TOP, LEFT or RIGHT wall — one blip per reflection, at the
// recipe's wave/freq/duration, peaking at the recipe's own peak
// ================================================================
check("a RIGHT-wall reflection schedules exactly one blip of SFX_WALL_BOUNCE (wave, freq, duration)", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const os0 = g.audio.rec.oscillators.length;
  const bs0 = g.audio.rec.bufferSources.length;
  const vx = driveIntoSideWall(g, "right");
  assert(vx < 0, `setup: the ball must have reflected off the right wall (moving left), vx=${vx}`);
  const r = g.q("SFX_WALL_BOUNCE");
  assert(g.audio.rec.oscillators.length === os0 + 1,
    `a right-wall reflection must schedule exactly one oscillator blip, created ${g.audio.rec.oscillators.length - os0}`);
  assert(g.audio.rec.bufferSources.length === bs0,
    "a wall reflection must not involve the noise buffer source");
  const osc = g.audio.rec.oscillators[os0];
  assert(osc.type === r.wave,
    `the blip must sound the recipe wave ${r.wave}, got ${osc.type}`);
  assert(osc.frequency.value === r.freq,
    `the blip must sound the recipe frequency ${r.freq} Hz, got ${osc.frequency.value}`);
  assert(osc.startTimes.length === 1 && osc.stopTimes.length === 1,
    "the blip source must be started and stopped exactly once");
  assertClose(osc.stopTimes[0] - osc.startTimes[0], r.dur, 1e-9,
    `the blip must last exactly the recipe duration ${r.dur}s`);
  repark(g);
});

check("a LEFT-wall reflection schedules exactly one blip of SFX_WALL_BOUNCE", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const os0 = g.audio.rec.oscillators.length;
  const vx = driveIntoSideWall(g, "left");
  assert(vx > 0, `setup: the ball must have reflected off the left wall (moving right), vx=${vx}`);
  const r = g.q("SFX_WALL_BOUNCE");
  assert(g.audio.rec.oscillators.length === os0 + 1,
    `a left-wall reflection must schedule exactly one oscillator blip, created ${g.audio.rec.oscillators.length - os0}`);
  const osc = g.audio.rec.oscillators[os0];
  assert(osc.type === r.wave && osc.frequency.value === r.freq,
    `the blip must be the recipe (wave ${r.wave}, ${r.freq} Hz), got type=${osc.type} freq=${osc.frequency.value}`);
  repark(g);
});

check("a TOP-wall reflection schedules exactly one blip of SFX_WALL_BOUNCE", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const os0 = g.audio.rec.oscillators.length;
  const vy = driveIntoTopWall(g);
  assert(vy > 0, `setup: the ball must have reflected off the top wall, vy=${vy}`);
  const r = g.q("SFX_WALL_BOUNCE");
  assert(g.audio.rec.oscillators.length === os0 + 1,
    `a top-wall reflection must schedule exactly one oscillator blip, created ${g.audio.rec.oscillators.length - os0}`);
  const osc = g.audio.rec.oscillators[os0];
  assert(osc.type === r.wave && osc.frequency.value === r.freq,
    `the blip must be the recipe (wave ${r.wave}, ${r.freq} Hz), got type=${osc.type} freq=${osc.frequency.value}`);
  repark(g);
});

check("the wall blip's envelope peaks at SFX_WALL_BOUNCE_PEAK (the restrained level), decays to the named floor, and connects to the single bus", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const e0 = envelopes(g).length;
  driveIntoSideWall(g, "right");
  repark(g);
  assert(envelopes(g).length === e0 + 1,
    `the wall blip must schedule exactly one envelope gain, created ${envelopes(g).length - e0}`);
  const env = envelopes(g)[e0];
  assert(env.events.length === 2,
    `the envelope must schedule exactly two automation events, got ${JSON.stringify(env.events)}`);
  assertClose(env.events[0][0], g.q("SFX_WALL_BOUNCE_PEAK"), 1e-9,
    `the envelope must peak at the recipe's own SFX_WALL_BOUNCE_PEAK, got ${env.events[0][0]}`);
  assertClose(env.events[1][0], g.q("SFX_DECAY_FLOOR"), 1e-9,
    "the envelope must decay to the named floor");
  const [bus] = busGains(g);
  assert(env.dest.length === 1 && env.dest[0] === bus,
    "the wall blip's envelope must connect to the single master bus, like every other recipe");
});

check("a pinned ball resting against a wall stays silent: no re-triggered blips while it rolls along the wall", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  // One clean reflection...
  driveIntoSideWall(g, "right");
  repark(g);
  const n0 = soundParts(g);
  // ...then drive the ball AGAIN from just inside the same wall:
  // another real reflection, exactly one more blip.
  driveIntoSideWall(g, "right");
  assert(soundParts(g) - n0 === 2,
    `each real reflection must schedule exactly one blip (source + envelope = 2 nodes), created ${soundParts(g) - n0}`);
  // A ball parked EXACTLY on the wall with zero outward velocity
  // must not rattle: no new sound over ten idle frames.
  g.q(
    "balls[0].attached = false;\n" +
      "balls[0].x = BALL_RADIUS; balls[0].y = 500;\n" +
      "balls[0].vx = 0; balls[0].vy = 0;"
  );
  const m0 = soundParts(g);
  g.tick(10);
  assert(soundParts(g) === m0,
    `a ball resting on the wall must not re-trigger the cue, created ${soundParts(g) - m0} nodes`);
  repark(g);
});

// ================================================================
// Criterion 3: paddle and brick contacts do NOT schedule the wall
// cue — they keep their own cues only
// ================================================================
check("a paddle bounce schedules the paddle recipe only — never the wall cue", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const os0 = g.audio.rec.oscillators.length;
  const bs0 = g.audio.rec.bufferSources.length;
  bouncePaddle(g);
  const wall = g.q("SFX_WALL_BOUNCE");
  const paddle = g.q("SFX_PADDLE_BOUNCE");
  assert(g.audio.rec.oscillators.length === os0 + 1,
    `a paddle bounce must schedule exactly one oscillator (its own cue), created ${g.audio.rec.oscillators.length - os0}`);
  assert(g.audio.rec.bufferSources.length === bs0,
    "a paddle bounce must not schedule any other cue");
  const osc = g.audio.rec.oscillators[os0];
  assert(osc.type === paddle.wave && osc.frequency.value === paddle.freq,
    `the paddle cue must be the paddle recipe (wave ${paddle.wave}, ${paddle.freq} Hz), got type=${osc.type} freq=${osc.frequency.value}`);
  assert(!(osc.type === wall.wave && osc.frequency.value === wall.freq),
    "the paddle bounce must never schedule the wall cue");
});

check("a non-lethal brick chip schedules the chip recipe only — never the wall cue", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const os0 = g.audio.rec.oscillators.length;
  const bs0 = g.audio.rec.bufferSources.length;
  const chipFreqs = g.q("SFX_BRICK_CHIP_FREQ");
  g.q(`
    const b = bricks[0];
    balls[0].attached = true;
    balls[0].x = b.x + b.w / 2;
    balls[0].y = b.y + b.h / 2;
    balls[0].vx = 0; balls[0].vy = 0;
    collideBricks(balls[0]);
    1`);
  assert(g.q("bricks[0].active") && g.q("bricks[0].hp") === 2,
    "setup: the hit must land non-lethally on the 3-hp brick");
  assert(g.audio.rec.oscillators.length === os0 + 1,
    `a non-lethal hit must schedule exactly one oscillator (the chip), created ${g.audio.rec.oscillators.length - os0}`);
  assert(g.audio.rec.bufferSources.length === bs0,
    "a non-lethal hit must not schedule the destruction pop");
  const osc = g.audio.rec.oscillators[os0];
  assert(osc.frequency.value === chipFreqs[3],
    `the chip must sound the tier-3 pitch ${chipFreqs[3]} Hz, got ${osc.frequency.value}`);
  assert(g.audio.rec.oscillators.length - os0 === 1,
    "the chip hit must not additionally schedule a wall cue");
});

check("a brick destruction schedules the pop only — never the wall cue", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  g.q("random = () => 1; 1"); // no unplanned capsule
  const os0 = g.audio.rec.oscillators.length;
  const bs0 = g.audio.rec.bufferSources.length;
  g.q("destroyBrick(2)");
  assert(g.audio.rec.bufferSources.length === bs0 + 1,
    "destruction must schedule the noise pop");
  assert(g.audio.rec.oscillators.length === os0,
    `destruction must schedule no wall cue (no extra oscillator), created ${g.audio.rec.oscillators.length - os0}`);
});

// ================================================================
// Criterion 4: mute + volume honour — the cue routes through the
// same single bus as every other recipe
// ================================================================
check("with mute ON the wall cue still schedules (silence is the bus) at bus gain 0; unmuting at volume 50 plays it at SOUND_BASE x 0.5", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  g.els["btn-mute"].click(); // mute ON
  const e0 = envelopes(g).length;
  driveIntoSideWall(g, "left");
  repark(g);
  assert(envelopes(g).length === e0 + 1,
    "a muted wall bounce must still schedule its envelope (silence is the bus, not skipped scheduling)");
  const [bus] = busGains(g);
  assert(bus !== undefined, "setup: the bus must exist after a scheduled sound");
  assertClose(bus.gain.value, 0, 0,
    `with mute ON the wall cue must schedule at bus gain 0, got ${bus.gain.value}`);
  g.els["btn-mute"].click(); // mute OFF
  setVolume(g, 50);
  driveIntoSideWall(g, "right");
  repark(g);
  assertClose(bus.gain.value, g.q("SOUND_BASE") * 0.5, 1e-9,
    `after unmuting at volume 50 the wall cue must play at SOUND_BASE x 0.5, got ${bus.gain.value}`);
});

// ================================================================
// Criterion 5: no new allocation in the hot path — the shared
// recipe is reused in place; two reflections (corner) schedule
// exactly two blips and nothing else
// ================================================================
check("repeated wall bounces reuse the shared recipe: each adds exactly one oscillator and one envelope, no buffer sources, no filters", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const os0 = g.audio.rec.oscillators.length;
  const bs0 = g.audio.rec.bufferSources.length;
  const f0 = g.audio.rec.filters.length;
  const r = g.q("SFX_WALL_BOUNCE");
  driveIntoSideWall(g, "left");
  repark(g);
  driveIntoSideWall(g, "right");
  repark(g);
  assert(g.audio.rec.oscillators.length === os0 + 2,
    `two wall bounces must create exactly two blip oscillators (shared recipe, no per-bounce allocation), created ${g.audio.rec.oscillators.length - os0}`);
  assert(g.audio.rec.bufferSources.length === bs0,
    "wall bounces must never allocate buffer sources");
  assert(g.audio.rec.filters.length === f0,
    "wall bounces must never allocate filters");
  for (let i = os0; i < os0 + 2; i += 1) {
    const osc = g.audio.rec.oscillators[i];
    assert(osc.type === r.wave && osc.frequency.value === r.freq,
      `both blips must reuse the same recipe values, got type=${osc.type} freq=${osc.frequency.value}`);
  }
});

check("a corner hit (left + top reflected in one pass) schedules exactly two blips — one per reflection", () => {
  const g = boot(960, 600, { audio: true });
  start(g);
  const os0 = g.audio.rec.oscillators.length;
  const bs0 = g.audio.rec.bufferSources.length;
  // Diagonal from just inside the top-left corner: the ball crosses
  // both the left edge and the top edge inside this one frame (it is
  // closer to both edges than one frame's per-axis travel).
  g.q(
    "balls[0].attached = false;\n" +
      "balls[0].x = BALL_RADIUS + 4; balls[0].y = BALL_RADIUS + 4;\n" +
      "balls[0].vx = -1000; balls[0].vy = -1000;"
  );
  g.tick(1);
  assert(g.q("balls[0].vx") > 0 && g.q("balls[0].vy") > 0,
    "setup: the ball must have reflected off BOTH walls (vx and vy flipped)");
  const r = g.q("SFX_WALL_BOUNCE");
  assert(g.audio.rec.oscillators.length === os0 + 2,
    `two reflections must schedule exactly two blips, created ${g.audio.rec.oscillators.length - os0}`);
  assert(g.audio.rec.bufferSources.length === bs0,
    "the corner hit must not schedule any other cue");
  for (let i = os0; i < os0 + 2; i += 1) {
    const osc = g.audio.rec.oscillators[i];
    assert(osc.type === r.wave && osc.frequency.value === r.freq,
      `each corner blip must be the wall recipe, got type=${osc.type} freq=${osc.frequency.value}`);
  }
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
