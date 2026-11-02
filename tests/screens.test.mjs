#!/usr/bin/env node
// ================================================================
// Unit tests — start screen, game over, and restart (ticket #8)
//
// Same harness style as tests/waves.test.mjs: runs the REAL
// <script> from asteroids.html in a sandboxed vm context with stubbed
// window/document/canvas, drives frames through the captured
// requestAnimationFrame callback, dispatches key events into the
// registered listeners, and asserts on observable game state plus
// the recorded canvas text (captured together with the font and
// fill colour in force at draw time, so the retro-styling criterion
// is verifiable per glyph). No network, no external services.
//
// Unlike the other suites, boot() here does NOT dismiss the start
// screen — every suite drives the state machine deliberately.
//
// Run: node tests/screens.test.mjs
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

// Exact strings the screens must draw (retro: upper-case, terse).
const TITLE = "ASTEROID HORIZON";
const START_PROMPT = "PRESS ENTER TO START";
const CONTROL_MOVE = "ARROWS / WASD  MOVE";
const CONTROL_FIRE = "SPACE  FIRE";
const GAME_OVER = "GAME OVER";
const RESTART_PROMPT = "PRESS ENTER OR R TO RESTART";
const finalScore = (n) => `FINAL SCORE ${n}`;

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

// Boot a fresh copy of the game on a 960x600 canvas, sitting on its
// start screen. The ctx stub records every fillText together with the
// font and fill style that were in force when the text was drawn.
function boot() {
  const width = 960;
  const height = 600;
  let rafCallback = null;
  const listeners = {};
  const ctxTexts = [];
  const ctxDraws = []; // { text, font, fill } per fillText
  let ctxFont = "";
  let ctxFill = "";
  const ctxStub = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        if (prop === "fillText") {
          return (text) => {
            ctxTexts.push(String(text));
            ctxDraws.push({ text: String(text), font: ctxFont, fill: ctxFill });
          };
        }
        return (..._args) => {};
      },
      set(_t, prop, value) {
        if (prop === "font") ctxFont = String(value);
        if (prop === "fillStyle") ctxFill = String(value);
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
  // Dispatch a single keydown (edge) into the registered listeners.
  function press(code) {
    for (const cb of listeners["keydown"] ?? []) {
      cb({ code, preventDefault() {} });
    }
  }
  // Dispatch a single keyup.
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
    ctxTexts,
    ctxDraws,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    score: () => q("score"),
    hp: () => q("hp"),
    wave: () => q("wave"),
    ship: () => q("({ x: ship.x, y: ship.y, vx: ship.vx, vy: ship.vy, heading: ship.heading })"),
    hazardCount: () =>
      q("(asteroids.slots.reduce((n, a) => n + (a.active ? 1 : 0), 0) + " +
        "drones.slots.reduce((n, d) => n + (d.active ? 1 : 0), 0))"),
    laserCount: () => q("laserPool.slots.reduce((n, s) => n + (s.active ? 1 : 0), 0)"),
    particleCount: () => q("particlePool.slots.reduce((n, p) => n + (p.active ? 1 : 0), 0)"),
    // Manually place a live, parked asteroid centred at (x, y).
    placeAst: (x, y, r = 20) =>
      q(`(() => { const s = asteroids.slots.find((a) => !a.active);
        if (!s) throw new Error("no free asteroid slot for fixture");
        s.active = true; s.tier = 0; s.x = ${x}; s.y = ${y}; s.r = ${r};
        s.vx = 0; s.vy = 0; s.rot = 0; s.spin = 0; s.entry = -1;
        s.shape.length = 6; return true; })()`),
  };
}

// Suppress all auto-spawning: zero-sized wave rosters spawn nothing,
// and an endless empty wave never completes (no wave cycling).
function suppressSpawns(g) {
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0");
}

// On the default 960x600 boot the ship rests at (480, 300); a parked
// rock with r = 20 centred 25 px away overlaps (25 < 14 + 20).
const HIT_X = 480;
const HIT_Y = 275;

// Take `steps` hull hits (short invuln window) until hp reaches 0 and
// the game hands over to the game-over screen.
function killShip(g, steps = 3) {
  g.q("INVULN_MS = 200");
  for (let i = 0; i < steps; i++) {
    g.placeAst(HIT_X, HIT_Y);
    for (let t = 0; t < 60 && g.hp() > 3 - (i + 1); t++) g.tick();
  }
}

// Tick until `fn()` is true or the frame budget runs out.
function waitUntil(g, fn, frames = 300, what) {
  for (let i = 0; i < frames; i++) {
    if (fn()) return i;
    g.tick();
  }
  throw new Error(`timed out after ${frames} frames waiting for: ${what}`);
}

// ================================================================
// Criterion 1: on page load a start screen shows the title,
// "press Enter to start", and the control list
// ================================================================
check("on load the start screen draws the title, the Enter prompt, and the control list", () => {
  const g = boot();
  g.tick(2);
  assert(g.state() === "start", `boot must land on the start screen, got ${g.state()}`);
  for (const line of [TITLE, START_PROMPT, CONTROL_MOVE, CONTROL_FIRE]) {
    assert(g.ctxTexts.includes(line),
      `start screen must draw ${JSON.stringify(line)}, got ${JSON.stringify([...new Set(g.ctxTexts)])}`);
  }
});

// ================================================================
// Criterion 1 (behaviour): no entities spawn and nothing moves
// until Enter is pressed
// ================================================================
check("until Enter is pressed no entities spawn and nothing moves", () => {
  const g = boot();
  const before = g.ship();
  for (let i = 0; i < 600; i++) {
    g.tick(); // 10 s of idling on the start screen
    assert(g.state() === "start", `the game must stay on the start screen (frame ${i + 1})`);
  }
  assertClose(g.hazardCount(), 0, 0, "no asteroid or drone may spawn on the start screen");
  assertClose(g.laserCount(), 0, 0, "no laser may fire on the start screen");
  assertClose(g.particleCount(), 0, 0, "no particle may exist on the start screen");
  const after = g.ship();
  assert(before.x === after.x && before.y === after.y, "the ship must not move on the start screen");
  assert(before.heading === after.heading, "the ship must not rotate on the start screen");
  assert(after.vx === 0 && after.vy === 0, "the ship must be at rest on the start screen");
  assert(!g.ctxTexts.some((t) => t.startsWith("SCORE ")),
    "the start screen must not draw the in-play HUD score line");
});

check("R on the start screen does not start the game (Enter only)", () => {
  const g = boot();
  g.press("KeyR");
  g.tick(10);
  assert(g.state() === "start", `R must not dismiss the start screen, state is ${g.state()}`);
  assertClose(g.hazardCount(), 0, 0, "no entity may spawn from an R press on the start screen");
});

// ================================================================
// #8-3 (should-fix): NumpadEnter is accepted on the start screen as
// well as Enter (numeric-keyboard players must not be locked out)
// ================================================================
check("NumpadEnter starts play from the start screen just like Enter", () => {
  const g = boot();
  g.press("NumpadEnter");
  assert(g.state() === "playing", `NumpadEnter must start the game, state is ${g.state()}`);
  assertClose(g.wave(), 1, 0, "NumpadEnter must start a fresh wave-1 game");
});

check("NumpadEnter during live play is a no-op (never resets a run)", () => {
  const g = boot();
  g.press("Enter");
  suppressSpawns(g);
  g.q("score = 100; wave = 3;");
  g.press("NumpadEnter");
  g.tick(10);
  assert(g.state() === "playing", `NumpadEnter during play must not change the screen, state is ${g.state()}`);
  assertClose(g.score(), 100, 0, "NumpadEnter during play must not reset the score");
  assertClose(g.wave(), 3, 0, "NumpadEnter during play must not reset the wave");
});

// ================================================================
// Criterion 2: pressing Enter starts play from wave 1, HP
// PLAYER_MAX_HP, score 0
// ================================================================
check("Enter starts play from wave 1, full HP, score 0 — and the simulation is live", () => {
  const g = boot();
  g.press("Enter");
  assert(g.state() === "playing", `Enter must start the game, state is ${g.state()}`);
  assertClose(g.wave(), 1, 0, "a started game must be on wave 1");
  assertClose(g.hp(), g.q("PLAYER_MAX_HP"), 0, "a started game must begin at PLAYER_MAX_HP");
  assertClose(g.score(), 0, 0, "a started game must begin at score 0");
  g.tick(3);
  assert(!g.q("shipDead"), "the ship must be alive at the start of play");
  waitUntil(g, () => g.hazardCount() >= 1, 300,
    "wave 1 to begin spawning hazards once play has started");
});

// ================================================================
// Criterion 3: when HP reaches 0 a game-over overlay shows
// "GAME OVER" and the final score, matching the HUD score at the
// moment of death
// ================================================================
check("at HP 0 the game-over overlay shows GAME OVER and a final score matching the HUD", () => {
  const g = boot();
  g.press("Enter");
  suppressSpawns(g);
  // Earn a real score: one laser kill of a parked rock straight ahead
  // (ship at (480,300) heading up; rock parked at (480,40)). #51: the
  // fixture keeps its default tier (0 large) -> the kill credits the
  // large-rock score, and the dead rock leaves 2 medium fragments. The
  // cooldown is pinned to infinity so the held Space never releases a
  // second beam that could vaporise the fragments of the first kill.
  g.q("LASER_COOLDOWN_MS = 1e9");
  g.placeAst(480, 40);
  g.press("Space");
  waitUntil(g, () => g.score() === g.q("SCORE_PER_LARGE"), 120, "the straight-ahead laser kill to credit SCORE_PER_LARGE");
  g.release("Space"); // stop firing
  // #51: the parked large rock shattered into its 2 medium fragments;
  // they stay immune to the shattering beam, so the field holds exactly 2.
  assertClose(g.hazardCount(), 2, 0, "the laser must have destroyed the parked rock (leaving its 2 fragments)");
  // Now die: three hits (short invuln) bring the hull to 0.
  killShip(g, 3);
  assertClose(g.hp(), 0, 0, "three hits must bring the hull to 0");
  assert(g.state() === "gameover", `hp 0 must hand over to the game-over screen, state is ${g.state()}`);
  g.tick(3);
  assert(g.ctxTexts.includes(GAME_OVER),
    `the game-over screen must draw "GAME OVER", got ${JSON.stringify([...new Set(g.ctxTexts)])}`);
  const killScore = g.q("SCORE_PER_LARGE"); // #51: per-tier scoring replaces the flat 10
  assert(g.ctxTexts.includes(finalScore(killScore)),
    `the game-over screen must draw "FINAL SCORE ${killScore}", got ${JSON.stringify([...new Set(g.ctxTexts)])}`);
  // The final score must equal the HUD score line drawn in the same run.
  const hudScores = g.ctxTexts.filter((t) => t.startsWith("SCORE ")).map((t) => Number(t.slice(6)));
  assert(hudScores.length > 0, "the HUD must have drawn a score line before death");
  assert(hudScores[hudScores.length - 1] === killScore,
    `the HUD score at moment of death must be ${killScore}, got ${hudScores[hudScores.length - 1]}`);
  assertClose(g.q("score"), killScore, 0, "the score variable must be unchanged on the game-over screen");
});

check("the game-over overlay is drawn statically every frame after death", () => {
  const g = boot();
  g.press("Enter");
  suppressSpawns(g);
  killShip(g, 3);
  g.ctxTexts.length = 0;
  g.tick(30);
  const overFrames = g.ctxTexts.filter((t) => t === GAME_OVER).length;
  assert(overFrames === 30, `GAME OVER must be drawn once per frame (30 frames), got ${overFrames}`);
  assert(g.ctxTexts.filter((t) => t.startsWith("FINAL SCORE ")).length === 30,
    "the final score line must be drawn once per frame with it");
});

// ================================================================
// Criterion 4: pressing R (or Enter) on game over restarts cleanly —
// score 0, wave 1, full HP, zero live entities
// ================================================================
function assertCleanRestart(g, label) {
  assert(g.state() === "playing", `${label}: restart must land in play, state is ${g.state()}`);
  assertClose(g.score(), 0, 0, `${label}: score must be 0 after restart`);
  assertClose(g.wave(), 1, 0, `${label}: wave must be 1 after restart`);
  assertClose(g.hp(), g.q("PLAYER_MAX_HP"), 0, `${label}: hull must be full after restart`);
  assertClose(g.hazardCount(), 0, 0, `${label}: zero hazards may survive a restart`);
  assertClose(g.laserCount(), 0, 0, `${label}: zero lasers may survive a restart`);
  assertClose(g.particleCount(), 0, 0, `${label}: zero particles may survive a restart`);
  assert(!g.q("shipDead"), `${label}: the ship must be alive after restart`);
  const s = g.ship();
  assertClose(s.x, 480, 0, `${label}: the ship must restart centred (x)`);
  assertClose(s.y, 300, 0, `${label}: the ship must restart centred (y)`);
  assertClose(s.vx, 0, 0, `${label}: the ship must restart at rest (vx)`);
  assertClose(s.vy, 0, 0, `${label}: the ship must restart at rest (vy)`);
}

check("Enter on game over restarts cleanly: score 0, wave 1, full HP, zero live entities", () => {
  const g = boot();
  g.press("Enter");
  suppressSpawns(g);
  // Leave residue behind: two parked hazards plus the death burst.
  g.placeAst(100, 100);
  g.placeAst(820, 500);
  killShip(g, 3);
  // #51: each of the three death-rocks shatters into 2 medium fragments
  // on impact, so the residue is 2 parked hazards + 3 x 2 fragments.
  assertClose(g.hazardCount(), 2 + 3 * 2, 0, "precondition: two parked hazards and the shatter residue are still in the field");
  assert(g.particleCount() > 0, "precondition: the death burst is still animating");
  g.press("Enter");
  assertCleanRestart(g, "Enter restart");
  g.tick(30);
  assertClose(g.hazardCount(), 0, 0, "the restarted field must stay empty under a zero roster");
  const s = g.ship();
  assertClose(s.x, 480, 0, "the restarted ship must not have drifted");
});

check("R on game over restarts just as cleanly", () => {
  const g = boot();
  g.press("Enter");
  suppressSpawns(g);
  g.placeAst(100, 100);
  killShip(g, 3);
  assert(g.particleCount() > 0, "precondition: the death burst is still animating");
  g.press("KeyR");
  assertCleanRestart(g, "R restart");
});

// ================================================================
// #8-1 (should-fix): startGame() clears the held-key set — a
// movement key still held at the moment of death (its keyup lost to
// a focus blip) must not produce ghost thrust in the fresh run
// ================================================================
check("a movement key still held at the moment of death cannot ghost-thrust the fresh run", () => {
  const g = boot();
  g.press("Enter");
  suppressSpawns(g);
  g.press("KeyD"); // held — and its keyup never arrives (lost to a focus blip)
  killShip(g, 3);
  assert(g.state() === "gameover", "precondition: the ship is dead and the overlay is up");
  g.press("Enter"); // restart while KeyD is still logically held
  assert(g.state() === "playing", "restart must work");
  assert(g.q("keys.size") === 0, "startGame must clear the held-key set");
  const h0 = g.q("ship.heading");
  g.tick(30);
  assertClose(g.q("ship.heading"), h0, 1e-9,
    "a key held at the moment of death must produce no ghost rotation in the fresh run");
  assertClose(g.q("ship.vx"), 0, 0, "…and no ghost velocity");
  assertClose(g.q("ship.vy"), 0, 0, "…or ghost drift");
});

// ================================================================
// Edge: R and Enter during live play are no-ops — they must not
// reset a run in progress
// ================================================================
check("R and Enter during live play do not reset the game", () => {
  const g = boot();
  g.press("Enter");
  suppressSpawns(g);
  g.q("score = 100; wave = 3;"); // stand-in for a run in progress
  g.press("KeyR");
  g.tick(10);
  assert(g.state() === "playing", `R during play must not change the screen, state is ${g.state()}`);
  assertClose(g.score(), 100, 0, "R during play must not reset the score");
  assertClose(g.wave(), 3, 0, "R during play must not reset the wave");
  g.press("Enter");
  g.tick(10);
  assertClose(g.score(), 100, 0, "Enter during play must not reset the score");
  assertClose(g.wave(), 3, 0, "Enter during play must not reset the wave");
});

// ================================================================
// Criterion 5: retro styling — monospace on ALL HUD/overlay text,
// one accent colour used consistently
// ================================================================
check("every HUD/overlay glyph is drawn monospace in the single accent colour", () => {
  const g = boot();
  g.tick(3); // start screen glyphs
  g.press("Enter");
  suppressSpawns(g);
  g.tick(3); // HUD glyphs
  killShip(g, 3);
  g.tick(3); // game-over overlay glyphs
  const accent = g.q("UI_ACCENT");
  assert(typeof accent === "string" && /^#[0-9a-fA-F]{6}$/.test(accent),
    `a single named UI_ACCENT colour must exist, got ${JSON.stringify(accent)}`);
  assert(g.ctxDraws.length > 0, "some text must have been drawn across the three screens");
  for (const d of g.ctxDraws) {
    assert(/monospace/i.test(d.font),
      `text ${JSON.stringify(d.text)} must be drawn with a monospace font, got "${d.font}"`);
    assert(d.fill === accent,
      `text ${JSON.stringify(d.text)} must use the single accent colour ${accent}, got ${d.fill}`);
  }
  // Glyphs from all three screens were actually exercised.
  for (const expected of [TITLE, START_PROMPT, "SCORE 0", GAME_OVER, finalScore(0), RESTART_PROMPT]) {
    assert(g.ctxDraws.some((d) => d.text === expected),
      `the exercise must have drawn ${JSON.stringify(expected)}`);
  }
});

check("asteroids.html declares the retro monospace UI (gate grep) with a single UI accent constant", () => {
  assert(/monospace/i.test(html), "asteroids.html must declare a monospace face for its UI text");
  // #8-2 (should-fix): the ticket wording asks for the retro styling
  // in the STYLE block itself — assert font-family there, not just in
  // the canvas-drawn UI constants below.
  const style = html.match(/<style>([\s\S]*?)<\/style>/);
  assert(style && /font-family:\s*monospace/i.test(style[1]),
    "the <style> block must declare font-family: monospace for the retro page styling");
  const g = boot();
  assert(g.q("UI_FONT") === "monospace", `UI_FONT must be exactly "monospace", got ${JSON.stringify(g.q("UI_FONT"))}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
