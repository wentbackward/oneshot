#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html sound toggle + volume slider (ticket #47)
//
// Runs the REAL <script> from bricks.html in a sandboxed vm context
// (same harness style as the sibling bricks-*.test.mjs suites), with
// the recording AudioContext stub and a seedable localStorage stub
// so a "reload" is a fresh boot against persisted settings.
//
// Criteria covered:
//  1. The start screen carries a mute toggle button (#btn-mute) and
//     a volume range input (#sound-volume, 0-100) in the static DOM.
//  2. Effective master = muted ? 0 : SOUND_BASE x volume/100, asserted
//     on the stubbed bus gain after scheduling a sound: mute ON -> 0,
//     mute OFF -> SOUND_BASE, slider 50 -> SOUND_BASE x 0.5 (float tol).
//  3. Settings persist as JSON { muted, volume } under
//     "brickbreaker.sound"; a simulated reload with seeded storage
//     restores both the control states and the effective level at the
//     first gesture-built context. Corrupt/invalid stored values fall
//     back to the defaults (unmuted, 100).
//  4. A persisted mute state does not block ensureAudio() gesture
//     building: the first gesture still constructs the context,
//     silently (bus gain 0).
//
// Run: node tests/bricks-sound.test.mjs
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
    throw new Error(`${msg} (got ${actual}, want ${expected} \u00b1 ${tol})`);
  }
}

// A DOM element stub (same shape the sibling suites use), extended
// with a `value` property and a dispatch() helper for the range
// input's "input" events.
function makeEl(id) {
  const el = {
    id,
    style: {},
    textContent: "",
    className: "",
    value: "",
    children: [],
    listeners: {},
    addEventListener(type, cb) {
      (this.listeners[type] ??= []).push(cb);
    },
    click() {
      for (const cb of this.listeners["click"] ?? []) cb({ type: "click" });
    },
    dispatch(type, ev) {
      for (const cb of this.listeners[type] ?? []) cb(ev ?? { type });
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
// Same shape as the audio suite's stub: gain nodes record their
// connections and every automation event; the destination object lets
// the tests find the single bus gain wired to it.
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
    state: "running",
    resume() {
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
      const n = { kind: "bufferSource", buffer: null, dest: [], startTimes: [], stopTimes: [] };
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
            throw new RangeError(`exponentialRampToValueAtTime: bad target ${v}`);
          if (!(n.lastValue > 0))
            throw new RangeError(`exponentialRampToValueAtTime: bad start ${n.lastValue}`);
          n.lastValue = v;
          n.events.push([v, t]);
        },
      };
      n.connect = (d) => n.dest.push(d);
      rec.gains.push(n);
      return n;
    },
    createBuffer(channels, length, sampleRate) {
      const b = { kind: "buffer", channels, length, sampleRate, data: new Float32Array(length) };
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

// Bus gains: gain nodes wired to the context destination.
const busGains = (g) =>
  g.audio.rec.gains.filter((n) => n.dest.includes(g.audio.destination));
// Gains whose gain param was automated are sound envelopes.
const envelopes = (g) => g.audio.rec.gains.filter((n) => n.events.length > 0);

// ---------- boot ----------
// Boot a fresh copy of the game. `audio: true` installs the recording
// AudioContext stub; `storage` seeds the localStorage stub (keys are
// raw strings, as a real browser serializes them), so a later boot
// against the same seed is a simulated reload.
function boot(width = 960, height = 600, opts = {}) {
  const audio = opts.audio ? makeAudioGraph() : null;
  const store = Object.assign({}, opts.storage ?? {});
  const writes = []; // [key, value] in order, for write-count assertions
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
    "difficulty-easy": makeEl("difficulty-easy"),
    "difficulty-normal": makeEl("difficulty-normal"),
    "difficulty-hard": makeEl("difficulty-hard"),
    "theme-classic": makeEl("theme-classic"),
    "theme-neon": makeEl("theme-neon"),
    "theme-minimal": makeEl("theme-minimal"),
    "btn-mute": makeEl("btn-mute"),
    "sound-volume": makeEl("sound-volume"),
    "screen-gameover": makeEl("screen-gameover"),
    "btn-restart": makeEl("btn-restart"),
    "screen-pause": makeEl("screen-pause"),
    "btn-resume": makeEl("btn-resume"),
    "gameover-final": makeEl("gameover-final"),
    "hud-score": makeEl("hud-score"),
    "hud-level": makeEl("hud-level"),
    "hiscore": makeEl("hiscore"),
    lives: makeEl("lives"),
  };
  const winListeners = {};
  let rafCb = null;
  let rafId = 0;
  const sandbox = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = v;
        writes.push([k, v]);
      },
    },
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
    audio,
    q,
    tick,
    storage: { snapshot: (k) => (k in store ? store[k] : null), writes },
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    key(type, code) {
      fireWin(type, { code, preventDefault() {} });
    },
    canvasClick() {
      canvas.dispatch("click", { type: "click" });
    },
    // Toggle the mute button.
    muteToggle() {
      els["btn-mute"].click();
    },
    // Move the volume slider: set the DOM value the way the browser
    // would, then fire the "input" event.
    setVolume(v) {
      els["sound-volume"].value = String(v);
      els["sound-volume"].dispatch("input", { type: "input" });
    },
  };
}

const start = (g) => {
  g.els["btn-start"].click();
  g.tick(1);
};

// One paddle bounce = exactly one scheduled sound on the bus.
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

const TOL = 1e-9; // float tolerance for gain products

// ================================================================
// Criterion 1: the start screen carries the mute toggle button and
// the volume range input in the static DOM
// ================================================================
check("the static DOM carries a mute toggle #btn-mute and a volume range input #sound-volume (0-100) on the start screen", () => {
  const startIdx = html.indexOf('id="screen-start"');
  const endIdx = html.indexOf('id="screen-gameover"');
  assert(startIdx > 0 && endIdx > startIdx, "setup: the start screen section must exist");
  const startHtml = html.slice(startIdx, endIdx);
  const muteBtn = startHtml.match(/<button[^>]*id="btn-mute"[^>]*type="button"[^>]*>/);
  assert(muteBtn !== null,
    'the start screen must carry a <button id="btn-mute" type="button">');
  const slider = startHtml.match(/<input[^>]*id="sound-volume"[^>]*>/);
  assert(slider !== null, 'the start screen must carry an <input id="sound-volume">');
  const tag = slider[0];
  assert(/ type="range" /.test(tag), `#sound-volume must be a range input, got ${tag}`);
  assert(/ min="0" /.test(tag), `#sound-volume must start at 0, got ${tag}`);
  assert(/ max="100" /.test(tag), `#sound-volume must end at 100, got ${tag}`);
});

// ================================================================
// Criterion 2: effective master = muted ? 0 : SOUND_BASE x volume/100,
// read back on the stubbed bus gain after one scheduled sound
// ================================================================
check("defaults: SOUND_BASE equals the legacy 0.2 master level and a fresh boot plays at full volume (bus gain SOUND_BASE)", () => {
  const g = boot(960, 600, { audio: true });
  assert(g.q("typeof SOUND_BASE === 'number'"), "setup: SOUND_BASE must be a named numeric var");
  assertClose(g.q("SOUND_BASE"), 0.2, TOL,
    `SOUND_BASE must default to the legacy 0.2 master level, got ${g.q("SOUND_BASE")}`);
  g.key("keydown", "ArrowRight"); // first gesture: builds the context
  assert(g.audio.rec.constructions === 1, "setup: the first gesture must build the context");
  start(g);
  bouncePaddle(g);
  const [bus] = busGains(g);
  assert(bus !== undefined, "setup: the bus must exist after a scheduled sound");
  assertClose(bus.gain.value, g.q("SOUND_BASE"), TOL,
    `the bus must play at SOUND_BASE when unmuted at volume 100, got ${bus.gain.value}`);
});

check("toggling mute ON schedules sounds at bus gain 0, and toggling OFF restores the bus to SOUND_BASE", () => {
  const g = boot(960, 600, { audio: true });
  g.key("keydown", "ArrowRight"); // first gesture
  start(g);
  const [bus] = busGains(g);
  g.muteToggle(); // mute ON
  const e0 = envelopes(g).length;
  bouncePaddle(g);
  assert(envelopes(g).length === e0 + 1,
    "a muted bounce must still schedule its envelope (silence is the bus, not skipped scheduling)");
  assertClose(bus.gain.value, 0, 0,
    `with mute ON the bus gain must be exactly 0, got ${bus.gain.value}`);
  g.muteToggle(); // mute OFF
  bouncePaddle(g);
  assertClose(bus.gain.value, g.q("SOUND_BASE"), TOL,
    `with mute OFF the bus gain must be SOUND_BASE, got ${bus.gain.value}`);
});

check("setting the volume slider to 50 plays at SOUND_BASE x 0.5 (float tolerance); the bounds 0 and 100 behave exactly", () => {
  const g = boot(960, 600, { audio: true });
  g.key("keydown", "ArrowRight"); // first gesture
  start(g);
  const [bus] = busGains(g);
  g.setVolume(50);
  bouncePaddle(g);
  assertClose(bus.gain.value, g.q("SOUND_BASE") * 0.5, TOL,
    `at volume 50 the bus gain must be SOUND_BASE x 0.5, got ${bus.gain.value}`);
  g.setVolume(0);
  bouncePaddle(g);
  assertClose(bus.gain.value, 0, 0,
    `at volume 0 the bus gain must be exactly 0, got ${bus.gain.value}`);
  g.setVolume(100);
  bouncePaddle(g);
  assertClose(bus.gain.value, g.q("SOUND_BASE"), TOL,
    `at volume 100 the bus gain must be SOUND_BASE, got ${bus.gain.value}`);
});

check("mute dominates volume: with mute ON, moving the slider away from 0 stays silent until unmuted", () => {
  const g = boot(960, 600, { audio: true });
  g.key("keydown", "ArrowRight"); // first gesture
  start(g);
  const [bus] = busGains(g);
  g.muteToggle(); // mute ON
  g.setVolume(50);
  bouncePaddle(g);
  assertClose(bus.gain.value, 0, 0,
    `muted at any volume the bus gain must be exactly 0, got ${bus.gain.value}`);
  g.muteToggle(); // unmute: the slider position must now count
  bouncePaddle(g);
  assertClose(bus.gain.value, g.q("SOUND_BASE") * 0.5, TOL,
    `after unmuting at volume 50 the bus gain must be SOUND_BASE x 0.5, got ${bus.gain.value}`);
});

check("an out-of-range slider value (programmatic) is clamped into [0, 100]", () => {
  const g = boot(960, 600, { audio: true });
  g.key("keydown", "ArrowRight"); // first gesture
  start(g);
  const [bus] = busGains(g);
  g.setVolume(150);
  assert(g.q("soundVolume") === 100,
    `a value of 150 must clamp to 100, got ${g.q("soundVolume")}`);
  g.setVolume(-5);
  assert(g.q("soundVolume") === 0,
    `a value of -5 must clamp to 0, got ${g.q("soundVolume")}`);
  bouncePaddle(g);
  assertClose(bus.gain.value, 0, 0,
    `the clamped floor volume must drive the bus to exactly 0, got ${bus.gain.value}`);
});

// ================================================================
// Criterion 3: persistence as JSON { muted, volume } under
// "brickbreaker.sound"; reload restores control states and the
// effective level; corrupt/invalid values fall back to defaults
// ================================================================
check("toggling mute or moving the slider persists JSON { muted, volume } under brickbreaker.sound", () => {
  const g = boot(960, 600, { audio: true });
  g.key("keydown", "ArrowRight"); // first gesture
  g.muteToggle();
  g.setVolume(60);
  const raw = g.storage.snapshot("brickbreaker.sound");
  assert(raw !== null, "settings must be written to the brickbreaker.sound key");
  const parsed = JSON.parse(raw);
  assert(parsed.muted === true, `muted must persist as true, got ${parsed.muted}`);
  assert(parsed.volume === 60, `volume must persist as 60, got ${parsed.volume}`);
  assert(Object.keys(parsed).sort().join(",") === "muted,volume",
    `the payload must be exactly { muted, volume }, got ${Object.keys(parsed).join(",")}`);
  g.muteToggle();
  assert(JSON.parse(g.storage.snapshot("brickbreaker.sound")).muted === false,
    "unmuting must persist muted: false");
});

check("re-applying the same setting makes no redundant storage write", () => {
  const g = boot(960, 600, { audio: true });
  g.key("keydown", "ArrowRight"); // first gesture
  g.setVolume(50);
  const writesAfterFirst = g.storage.writes.filter(([k]) => k === "brickbreaker.sound").length;
  g.setVolume(50); // identical value again
  const writesAfterRepeat = g.storage.writes.filter(([k]) => k === "brickbreaker.sound").length;
  assert(writesAfterFirst === 1, `the first change must write once, wrote ${writesAfterFirst}`);
  assert(writesAfterRepeat === writesAfterFirst,
    `an unchanged value must not re-write storage, wrote ${writesAfterRepeat - writesAfterFirst} extra time(s)`);
});

check("reload with seeded storage { muted: true, volume: 30 } restores both control states; mute wins (effective level 0) until unmuted, at which point the restored volume applies", () => {
  const g = boot(960, 600, {
    audio: true,
    storage: { "brickbreaker.sound": JSON.stringify({ muted: true, volume: 30 }) },
  });
  assert(g.q("soundMuted") === true, "the reload must restore the muted flag");
  assert(g.q("soundVolume") === 30, "the reload must restore the volume");
  const btn = g.els["btn-mute"];
  assert(btn.className !== "sound-opt",
    `the muted state must be marked on the toggle button (className=${btn.className})`);
  assert(/off/i.test(btn.textContent),
    `the toggle label must read off-state, got "${btn.textContent}"`);
  assert(g.els["sound-volume"].value === "30",
    `the slider must restore to the persisted 30, got ${JSON.stringify(g.els["sound-volume"].value)}`);
  assertClose(g.q("MASTER_GAIN"), 0, 0,
    `before the first gesture the effective level must be 0 (mute wins over volume), got ${g.q("MASTER_GAIN")}`);
  g.key("keydown", "ArrowRight"); // first gesture: builds the context
  start(g);
  bouncePaddle(g);
  const [bus] = busGains(g);
  assertClose(bus.gain.value, 0, 0,
    `the first gesture-built context must stay silent while muted, bus gain ${bus.gain.value}`);
  g.muteToggle(); // unmute: the restored volume must now apply
  bouncePaddle(g);
  assertClose(bus.gain.value, g.q("SOUND_BASE") * 0.3, TOL,
    `after unmuting the bus must play at the restored SOUND_BASE x 0.3, got ${bus.gain.value}`);
});

check("reload with seeded storage { muted: false, volume: 80 } restores an unmuted control state at SOUND_BASE x 0.8", () => {
  const g = boot(960, 600, {
    audio: true,
    storage: { "brickbreaker.sound": JSON.stringify({ muted: false, volume: 80 }) },
  });
  assert(g.q("soundMuted") === false && g.q("soundVolume") === 80,
    "the reload must restore unmuted at volume 80");
  assert(g.els["btn-mute"].className === "sound-opt",
    `an unmuted reload must not carry the muted class, got ${g.els["btn-mute"].className}`);
  assert(g.els["sound-volume"].value === "80",
    `the slider must restore to the persisted 80, got ${JSON.stringify(g.els["sound-volume"].value)}`);
  g.key("keydown", "ArrowRight"); // first gesture
  start(g);
  bouncePaddle(g);
  const [bus] = busGains(g);
  assertClose(bus.gain.value, g.q("SOUND_BASE") * 0.8, TOL,
    `the first gesture-built context must play at SOUND_BASE x 0.8, got ${bus.gain.value}`);
});

check("corrupt stored settings fall back to the defaults (unmuted, volume 100) without breaking boot", () => {
  const g = boot(960, 600, {
    audio: true,
    storage: { "brickbreaker.sound": "{not-json" },
  });
  assert(g.state() === "start", "setup: boot must survive a corrupt payload");
  assert(g.q("soundMuted") === false && g.q("soundVolume") === 100,
    `corrupt settings must fall back to unmuted at volume 100, got muted=${g.q("soundMuted")} volume=${g.q("soundVolume")}`);
  assert(g.els["sound-volume"].value === "100", "the slider must sit at the default 100");
  g.key("keydown", "ArrowRight"); // first gesture still builds
  assert(g.audio.rec.constructions === 1, "a corrupt payload must not block gesture building");
});

check("each invalid field falls back independently: bad volume keeps a valid muted flag and vice versa", () => {
  const cases = [
    [{ muted: true, volume: 150 }, true, 100],   // volume above the ceiling
    [{ muted: true, volume: -1 }, true, 100],     // volume below the floor
    [{ muted: true, volume: 42.5 }, true, 100],   // volume not an integer
    [{ muted: true, volume: "loud" }, true, 100], // volume not a number
    [{ muted: "yes", volume: 40 }, false, 40],    // muted not a boolean
  ];
  for (const [payload, wantMuted, wantVolume] of cases) {
    const g = boot(960, 600, {
      audio: true,
      storage: { "brickbreaker.sound": JSON.stringify(payload) },
    });
    assert(g.q("soundMuted") === wantMuted,
      `payload ${JSON.stringify(payload)} must restore muted=${wantMuted}, got ${g.q("soundMuted")}`);
    assert(g.q("soundVolume") === wantVolume,
      `payload ${JSON.stringify(payload)} must restore volume=${wantVolume}, got ${g.q("soundVolume")}`);
  }
});

check("a non-object stored payload (null) falls back to the defaults", () => {
  const g = boot(960, 600, {
    audio: true,
    storage: { "brickbreaker.sound": "null" },
  });
  assert(g.q("soundMuted") === false && g.q("soundVolume") === 100,
    `a stored null must fall back to the defaults, got muted=${g.q("soundMuted")} volume=${g.q("soundVolume")}`);
});

// ================================================================
// Criterion 4: a muted state never blocks ensureAudio() gesture
// building — the first gesture still constructs the context, quietly
// ================================================================
check("the first gesture with a persisted muted=true still constructs the AudioContext, silently (bus gain 0)", () => {
  const g = boot(960, 600, {
    audio: true,
    storage: { "brickbreaker.sound": JSON.stringify({ muted: true, volume: 100 }) },
  });
  g.key("keydown", "ArrowRight"); // first gesture while muted
  assert(g.audio.rec.constructions === 1,
    `a muted boot must not block the gesture construction, constructions=${g.audio.rec.constructions}`);
  start(g);
  bouncePaddle(g);
  const [bus] = busGains(g);
  assertClose(bus.gain.value, 0, 0,
    `the built context must stay silent while muted, bus gain ${bus.gain.value}`);
  assert(g.state() === "playing", "the game must be playable under a muted boot");
});

check("clicking the mute toggle itself is a user gesture that builds the context once", () => {
  const g = boot(960, 600, { audio: true });
  g.muteToggle(); // first gesture: the toggle click itself
  assert(g.audio.rec.constructions === 1,
    `the first toggle click must construct the context, constructions=${g.audio.rec.constructions}`);
  g.muteToggle();
  g.els["btn-start"].click();
  g.tick(10);
  assert(g.audio.rec.constructions === 1,
    `later gestures must never re-construct the context, constructions=${g.audio.rec.constructions}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
