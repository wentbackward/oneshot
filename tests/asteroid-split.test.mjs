#!/usr/bin/env node
// ================================================================
// Unit tests — tiered asteroids and shot splitting (ticket #51)
//
// Same harness style as tests/asteroids.test.mjs: runs the REAL
// <script> from asteroids.html in a sandboxed vm context with stubbed
// window/document/canvas, drives frames through the captured
// requestAnimationFrame callback, and asserts on observable game
// state. The game's `random` hook is pinned to a fixed mulberry32
// sequence so every kill frame, fragment position and velocity is
// bit-for-bit deterministic.
//
// Conventions used here:
// - one "single shot" = keydown Space, two ticks, keyup Space: the
//   first tick fires the beam (integrated with dt = 0, so it only
//   leaves the nose); the second tick sweeps 277 -> 265.3 px, which
//   crosses the parked fixture for every tier radius (24/12/6).
// - a parked rock at (480, 260) on the default 960x600 boot is
//   crossed by that sweep for every tier radius (24/12/6).
//
// Run: node tests/asteroid-split.test.mjs
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
// Deterministic-RNG factory: SELF-CONTAINED source (no closures) so the
// generated function keeps working inside the vm sandbox. Same
// precedent as tests/asteroids.test.mjs.
function mulberry32Source(seed) {
  return `(() => { let a = ${(seed >>> 0) | 0};
    return () => { a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })()`;
}

function boot(width = 960, height = 600, seed = 11) {
  let rafCallback = null;
  const listeners = {};
  const ctxStub = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        return (..._args) => {};
      },
      set() {
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
  vm.runInContext(`random = ${mulberry32Source(seed)};`, context);
  // Dismiss the start screen so this suite drives the running sim.
  for (const cb of listeners["keydown"] ?? []) cb({ code: "Enter", preventDefault() {} });

  let nowMs = 0;
  const FRAME_MS = 1000 / 60;
  function tick(n = 1) {
    for (let i = 0; i < n; i++) {
      nowMs += FRAME_MS;
      rafCallback(nowMs);
    }
  }
  function key(code, down) {
    for (const cb of listeners[down ? "keydown" : "keyup"] ?? []) {
      cb({ code, preventDefault() {} });
    }
  }
  const q = (expr) => vm.runInContext(expr, context);
  return {
    tick,
    key,
    q,
    activeRocks: () => q("asteroids.slots.filter((a) => a.active)"),
    count: () => q("asteroids.slots.reduce((n, a) => n + (a.active ? 1 : 0), 0)"),
    poolLen: () => q("asteroids.slots.length"),
    score: () => q("score"),
    hp: () => q("hp"),
    clearField: () => q("asteroids.slots.forEach((a) => (a.active = false))"),
    // Reset the fire cooldown and retire any live beam (a leftover sweep
    // from a previous shot would otherwise cross a newly placed fixture
    // before the stage's own single shot).
    armGuns: () => {
      q("lastFireAt = Number.NEGATIVE_INFINITY");
      q("laserPool.slots.forEach((s) => (s.active = false))");
    },
  };
}

// Zero all rosters: only manual fixtures may exist in the field.
function suppressSpawns(g) {
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0");
}

// Manually place a live, parked asteroid: centre (x, y), radius r and
// explicit tier (0 large, 1 medium, 2 small).
function placeAst(g, x, y, r, tier) {
  g.q(`(() => { const s = asteroids.slots.find((a) => !a.active);
    if (!s) throw new Error("no free asteroid slot for fixture");
    s.active = true; s.x = ${x}; s.y = ${y}; s.r = ${r}; s.tier = ${tier};
    s.vx = 0; s.vy = 0; s.rot = 0; s.spin = 0; s.entry = -1;
    s.shape.length = 6;
    for (let v = 0; v < 6; v++) s.shape[v] = 0.9;
    return true; })()`);
}

// The parked fixture's spot: crossed by the frame-1 sweep (23..34.7 px
// above the resting ship at (480,300)) for every tier radius.
const ROCK_X = 480;
const ROCK_Y = 260;

// keydown Space, two ticks, keyup Space: exactly one beam released
// (the bootstrap tick integrates with dt = 0 and only releases the
// beam from the nose; the second tick sweeps 277 -> 265.3 px, which
// crosses the parked fixture for every tier radius), and no
// follow-up shot can fire once Space is released.
function singleShot(g) {
  g.key("Space", true);
  g.tick(2);
  g.key("Space", false);
}

// ================================================================
// Criterion 1 (constants): named, descending size tiers tied by a
// named ratio, and per-size mutable score knobs
// ================================================================
check("size tiers are named, descending, and tied by a named ratio", () => {
  const g = boot();
  const RL = g.q("ASTEROID_R_LARGE");
  const RM = g.q("ASTEROID_R_MEDIUM");
  const RS = g.q("ASTEROID_R_SMALL");
  assert(Number.isFinite(RL) && Number.isFinite(RM) && Number.isFinite(RS),
    "ASTEROID_R_LARGE / ASTEROID_R_MEDIUM / ASTEROID_R_SMALL must all be named numeric constants");
  assert(RL > RM && RM > RS,
    `tiers must descend: LARGE (${RL}) > MEDIUM (${RM}) > SMALL (${RS})`);
  assertClose(RM, RL * g.q("ASTEROID_SIZE_RATIO"), 1e-9,
    "ASTEROID_R_MEDIUM must equal ASTEROID_R_LARGE * ASTEROID_SIZE_RATIO");
  assertClose(RS, RM * g.q("ASTEROID_SIZE_RATIO"), 1e-9,
    "ASTEROID_R_SMALL must equal ASTEROID_R_MEDIUM * ASTEROID_SIZE_RATIO");
  const kids = g.q("ASTEROID_CHILDREN");
  assert(Array.isArray(kids) && kids.length === 3, "ASTEROID_CHILDREN must name the fragment count per tier");
  assertClose(kids[0], 2, 0, "a large rock must shatter into exactly 2 fragments");
  assertClose(kids[1], 2, 0, "a medium rock must shatter into exactly 2 fragments");
  assertClose(kids[2], 0, 0, "a small rock must shatter into nothing");
});

check("per-size scores are named, mutable knobs (SCORE_PER_LARGE / MEDIUM / SMALL)", () => {
  const g = boot();
  for (const name of ["SCORE_PER_LARGE", "SCORE_PER_MEDIUM", "SCORE_PER_SMALL"]) {
    assert(typeof g.q(name) === "number" && g.q(name) > 0,
      `${name} must be a named positive numeric knob`);
  }
  g.q("SCORE_PER_LARGE = 99; SCORE_PER_MEDIUM = 9; SCORE_PER_SMALL = 3");
  assertClose(g.q("SCORE_PER_LARGE"), 99, 0, "SCORE_PER_LARGE must be reassignable (console knob)");
  assertClose(g.q("SCORE_PER_MEDIUM"), 9, 0, "SCORE_PER_MEDIUM must be reassignable (console knob)");
  assertClose(g.q("SCORE_PER_SMALL"), 3, 0, "SCORE_PER_SMALL must be reassignable (console knob)");
});

// ================================================================
// Criterion 2 (spawn): rocks that enter through the edges are LARGE —
// the wave rosters count large rocks, and every edge spawn carries the
// large radius
// ================================================================
check("edge spawns are large rocks (tier 0) with the large radius", () => {
  const g = boot(960, 600);
  suppressSpawns(g);
  // Deterministic candidate: top edge, field-centre x, straight-down
  // heading (jitter 0), mid-band speed — accepted outright.
  g.q(`random = (() => { const r = [0.2, 0.5, 0.5, 0.5]; let i = 0; return () => r[i++ % r.length]; })()`);
  assert(g.q("spawnAsteroid()") === true, "the seeded edge candidate must be accepted");
  const a = g.activeRocks()[0];
  assert(a.tier === 0, `edge spawn must be the large tier (0), got tier ${a.tier}`);
  assertClose(a.r, g.q("ASTEROID_R_LARGE"), 1e-9, "edge spawn must carry the large radius");
  assertClose(a.y, -(g.q("ASTEROID_R_LARGE") + 1), 1e-9, "edge spawn sits just off its spawn edge");
  assertClose(a.x, 480, 1e-9, "the seeded candidate is the field-centre x of the top edge");
  assert(a.vy > 0, "the seeded candidate drifts into the field");
});

// ================================================================
// Criterion 2 (splitting): a large rock shot dead spawns exactly two
// medium rocks at the parent's position, carrying the parent's
// polygon style, with random headings and speeds within the named
// min/max band
// ================================================================
check("shooting a large rock spawns exactly two medium rocks (no more, no less)", () => {
  const g = boot();
  suppressSpawns(g);
  placeAst(g, ROCK_X, ROCK_Y, g.q("ASTEROID_R_LARGE"), 0);
  singleShot(g);
  const rocks = g.activeRocks();
  assert(g.count() === 2, `a destroyed large rock must leave exactly 2 live fragments, got ${g.count()}`);
  for (const a of rocks) {
    assert(a.tier === 1, `fragment must be the medium tier (1), got tier ${a.tier}`);
    assertClose(a.r, g.q("ASTEROID_R_MEDIUM"), 1e-9, "fragment must carry the medium radius");
  }
});

check("fragments spawn at the parent's position (within the parent radius after the kill frame)", () => {
  const g = boot();
  suppressSpawns(g);
  placeAst(g, ROCK_X, ROCK_Y, g.q("ASTEROID_R_LARGE"), 0);
  singleShot(g); // the kill frame: fragments spawn, then drift one frame step
  const rocks = g.activeRocks();
  assert(g.count() === 2, "the large fixture must have split into 2 fragments");
  for (const a of rocks) {
    const d = Math.hypot(a.x - ROCK_X, a.y - ROCK_Y);
    assert(d <= g.q("ASTEROID_R_LARGE") + 1e-9,
      `fragment at (${a.x.toFixed(1)}, ${a.y.toFixed(1)}) must stay within the parent radius of (${ROCK_X}, ${ROCK_Y}), dist ${d.toFixed(1)}`);
  }
});

check("fragments inherit the parent's polygon style", () => {
  const g = boot();
  suppressSpawns(g);
  const parentShape = g.q(`(() => { const s = asteroids.slots.find((a) => !a.active);
    s.active = true; s.x = ${ROCK_X}; s.y = ${ROCK_Y}; s.r = ASTEROID_R_LARGE; s.tier = 0;
    s.vx = 0; s.vy = 0; s.rot = 0; s.spin = 0; s.entry = -1;
    s.shape.length = ASTEROID_VERTS;
    const style = [0.8, 1.0, 0.75, 0.95, 0.85, 1.0, 0.75, 0.9];
    for (let v = 0; v < ASTEROID_VERTS; v++) s.shape[v] = style[v];
    return s.shape.slice(); })()`);
  singleShot(g);
  const rocks = g.activeRocks();
  assert(g.count() === 2, "the large fixture must have split into 2 fragments");
  for (const a of rocks) {
    assert(a.shape.length === parentShape.length, "fragment outline must keep the parent's vertex count");
    for (let v = 0; v < parentShape.length; v++) {
      assertClose(a.shape[v], parentShape[v], 1e-9,
        `fragment outline offset ${v} must copy the parent's style`);
    }
  }
});

check("fragment speeds stay within the named min/max band and never rest", () => {
  const g = boot();
  suppressSpawns(g);
  placeAst(g, ROCK_X, ROCK_Y, g.q("ASTEROID_R_MEDIUM"), 1);
  singleShot(g); // medium -> 2 smalls
  const rocks = g.activeRocks();
  assert(g.count() === 2, "a destroyed medium rock must leave exactly 2 live fragments");
  for (const a of rocks) {
    assert(a.tier === 2, `fragment must be the small tier (2), got tier ${a.tier}`);
    const speed = Math.hypot(a.vx, a.vy);
    assert(speed >= g.q("ASTEROID_SPEED_MIN") - 1e-9 && speed <= g.q("ASTEROID_SPEED_MAX") + 1e-9,
      `fragment speed ${speed.toFixed(1)} must sit within [${g.q("ASTEROID_SPEED_MIN")}, ${g.q("ASTEROID_SPEED_MAX")}]`);
  }
  assert(g.q("typeof ASTEROID_SPEED_MIN === 'number'"), "ASTEROID_SPEED_MIN must be a named numeric knob");
  g.q("ASTEROID_SPEED_MIN = 55"); // mutable per the ticket
  assertClose(g.q("ASTEROID_SPEED_MIN"), 55, 0, "ASTEROID_SPEED_MIN must be reassignable");
});

check("shooting a small rock destroys it and spawns nothing", () => {
  const g = boot();
  suppressSpawns(g);
  const poolBefore = g.poolLen();
  placeAst(g, ROCK_X, ROCK_Y, g.q("ASTEROID_R_SMALL"), 2);
  singleShot(g);
  assert(g.count() === 0, "a destroyed small rock must not spawn fragments");
  assert(g.poolLen() === poolBefore, "the kill must not change the pool's allocated length");
});

check("a fragment cannot be destroyed by the same beam that shattered its parent", () => {
  const g = boot();
  suppressSpawns(g);
  placeAst(g, ROCK_X, ROCK_Y, g.q("ASTEROID_R_LARGE"), 0);
  g.key("Space", true);
  singleShot(g); // the kill frame: the large rock dies, two medium
  // fragments spawn AT ITS POSITION, on the very sweep segment
  // that destroyed it
  assert(g.count() === 2, "the large fixture must have split on the kill frame");
  assertClose(g.score(), g.q("SCORE_PER_LARGE"), 0,
    "the kill frame credits exactly the large score — the shattering beam must not chain-kill its own fragments");
  // Park both fragments at the parent's spot: the shattering beam is
  // still live (LASER_LIFETIME_S) and, within its lifetime, sweeps the
  // full column through the parked fragments — a chain killer would
  // collect them, an immune fragment pair would not.
  g.q(`(() => { for (const a of asteroids.slots) if (a.active) { a.x = ${ROCK_X}; a.y = ${ROCK_Y}; a.vx = 0; a.vy = 0; } })()`);
  g.key("Space", false);
  for (let i = 0; i < 100 && g.count() === 2; i++) g.tick();
  assertClose(g.score(), g.q("SCORE_PER_LARGE"), 0,
    "no later sweep of the shattering beam may chain-kill its own fragments");
  assert(g.count() === 2,
    "the fragments must outlive every sweep of the beam that shattered their parent");
});

// ================================================================
// Criterion 3 (pool discipline): splits reuse the fixed pool in place
// — the pool length is constant across a whole cascade, and a
// saturated pool spawns as many fragments as fit
// ================================================================
check("the asteroid pool length is constant across a full large -> medium -> small cascade", () => {
  const g = boot();
  suppressSpawns(g);
  const poolLen = g.poolLen();
  assert(poolLen >= 8, "the pre-allocated pool must exist");
  placeAst(g, ROCK_X, ROCK_Y, g.q("ASTEROID_R_LARGE"), 0);
  singleShot(g);
  assert(g.poolLen() === poolLen, "splitting a large rock must not resize the pool");
  g.clearField();
  g.armGuns();
  placeAst(g, ROCK_X, ROCK_Y, g.q("ASTEROID_R_MEDIUM"), 1);
  placeAst(g, ROCK_X, ROCK_Y, g.q("ASTEROID_R_MEDIUM"), 1);
  singleShot(g);
  assert(g.poolLen() === poolLen, "splitting both medium rocks must not resize the pool");
  g.clearField();
  g.armGuns();
  for (let i = 0; i < 4; i++) placeAst(g, ROCK_X, ROCK_Y, g.q("ASTEROID_R_SMALL"), 2);
  singleShot(g);
  assert(g.poolLen() === poolLen, "killing all four smalls must not resize the pool");
  assert(g.count() === 0, "smalls do not split: the cascade ends in an empty field");
});

check("a saturated pool spawns as many fragments as fit (documented rule)", () => {
  const g = boot();
  suppressSpawns(g);
  // Occupy 47 of the 48 slots with parked small rocks; the 48th holds
  // the large target. Only ONE slot is free when the target shatters.
  g.q(`(() => {
    const slots = asteroids.slots;
    for (let i = 0; i < ${g.poolLen() - 1}; i++) {
      const s = slots[i];
      s.active = true; s.tier = 2; s.r = ASTEROID_R_SMALL;
      s.x = 30 + (i % 10) * 90; s.y = 30 + Math.floor(i / 10) * 70;
      s.vx = 0; s.vy = 0; s.rot = 0; s.spin = 0; s.entry = -1;
      s.shape.length = ASTEROID_VERTS;
    }
    const target = slots[${g.poolLen() - 1}];
    target.active = true; target.tier = 0; target.r = ASTEROID_R_LARGE;
    target.x = 20; target.y = 560; target.vx = 0; target.vy = 0;
    target.rot = 0; target.spin = 0; target.entry = -1;
    target.shape.length = ASTEROID_VERTS;
    return true; })()`);
  assert(g.count() === g.poolLen(), "precondition: every pool slot is occupied");
  g.q(`shatterAsteroid(asteroids.slots[${g.poolLen() - 1}])`);
  assert(g.count() === g.poolLen(),
    "with one free slot, the shatter must leave the pool exactly full (target out, one fragment in)");
  const frags = g.activeRocks().filter((a) => a.tier === 1);
  assert(frags.length === 1,
    `only as many fragments as fit may spawn: expected 1 medium, got ${frags.length}`);
  assert(g.poolLen() === g.q("ASTEROID_POOL_SIZE"), "saturation must never allocate new slots");
});

// ================================================================
// Criterion 4 (scoring): a full large -> 2 medium -> 4 small cascade
// credits exactly SCORE_PER_LARGE + 2*SCORE_PER_MEDIUM +
// 4*SCORE_PER_SMALL, once per destruction
// ================================================================
function cascadeStage(g, tier, n) {
  for (let i = 0; i < n; i++) {
    const r = g.q(tier === 0 ? "ASTEROID_R_LARGE" : tier === 1 ? "ASTEROID_R_MEDIUM" : "ASTEROID_R_SMALL");
    placeAst(g, ROCK_X, ROCK_Y, r, tier);
  }
  g.armGuns();
  singleShot(g);
}

check("a full large -> 2 medium -> 4 small cascade scores the per-size points exactly once each", () => {
  const g = boot();
  suppressSpawns(g);
  cascadeStage(g, 0, 1);
  assertClose(g.score(), g.q("SCORE_PER_LARGE"), 0,
    "the large destruction must credit exactly SCORE_PER_LARGE");
  g.clearField(); // retire the 2 medium fragments before the next stage
  cascadeStage(g, 1, 2);
  assertClose(g.score(), g.q("SCORE_PER_LARGE") + 2 * g.q("SCORE_PER_MEDIUM"), 0,
    "the two medium destructions must each credit exactly SCORE_PER_MEDIUM");
  g.clearField(); // retire the 4 small fragments before the next stage
  cascadeStage(g, 2, 4);
  const expected = g.q("SCORE_PER_LARGE") + 2 * g.q("SCORE_PER_MEDIUM") + 4 * g.q("SCORE_PER_SMALL");
  assertClose(g.score(), expected, 0,
    "the finished cascade must credit each destruction exactly once (20 + 2x10 + 4x5 by default)");
  assert(g.count() === 0, "smalls do not split: the cascade ends clean");
});

// ================================================================
// Criterion 5 (ship collision): one impact shatters the rock per the
// same tier rule, costs exactly 1 HP, and opens the INVULN_MS window
// (ticket #5 invariants, re-asserted for the tiered world)
// ================================================================
check("a ship impact shatters the rock into its tier's fragments, costs exactly 1 hp, and opens INVULN_MS", () => {
  const g = boot();
  suppressSpawns(g);
  placeAst(g, 480, 275, g.q("ASTEROID_R_LARGE"), 0); // 25 px < R_LARGE + SHIP_RADIUS
  g.tick();
  assertClose(g.hp(), g.q("PLAYER_MAX_HP") - 1, 0, "one impact must cost exactly 1 hp");
  assert(g.count() === 2, "the impact must shatter the large rock into its 2 medium fragments");
  for (const a of g.activeRocks()) {
    assert(a.tier === 1, "impact fragments must be the next tier (medium)");
    const d = Math.hypot(a.x - 480, a.y - 275);
    assert(d <= g.q("ASTEROID_R_LARGE") + 1e-9,
      `impact fragments must spawn at the parent's position (dist ${d.toFixed(1)})`);
  }
  const window = g.q("invulnUntil - gameTime");
  assertClose(window, g.q("INVULN_MS") / 1000, 1e-9,
    "the impact must open exactly the INVULN_MS invulnerability window");
});

check("a ship impact on the smallest tier destroys the rock without fragments", () => {
  const g = boot();
  suppressSpawns(g);
  placeAst(g, 480, 288, g.q("ASTEROID_R_SMALL"), 2); // 12 px < R_SMALL + SHIP_RADIUS
  g.tick();
  assertClose(g.hp(), g.q("PLAYER_MAX_HP") - 1, 0, "one impact must cost exactly 1 hp");
  assert(g.count() === 0, "a smashed small rock must not spawn fragments");
});

// ================================================================
// Criterion 6 (wave completion): a wave completes only when its
// large-rock roster is fully spawned AND no live hazard of ANY tier
// remains — live fragments keep the wave open
// ================================================================
check("live fragments keep the wave open: completion waits for every tier to die", () => {
  const g = boot(960, 600);
  g.q("ASTEROID_BASE = 1; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0; BETWEEN_WAVES_S = 0.2");
  for (let i = 0; i < 300 && g.count() < 1; i++) g.tick();
  assertClose(g.count(), 1, 0, "the single-large roster must spawn");
  // Park the roster rock inside the frame-1 sweep band of a single shot.
  g.q(`(() => { const a = asteroids.slots.find((a) => a.active);
    a.x = ${ROCK_X}; a.y = ${ROCK_Y}; a.vx = 0; a.vy = 0; })()`);
  singleShot(g);
  assertClose(g.count(), 2, 0, "the roster rock must have shattered into 2 fragments");
  g.tick(30); // 0.5 s: far past BETWEEN_WAVES_S, yet fragments are alive
  assertClose(g.q("wave"), 1, 0, "the wave must not advance while fragments are live");
  assert(g.q("inIntermission") === false, "no intermission may start while hazards of any tier remain");
  g.clearField(); // every tier dead -> the wave may finally complete
  for (let i = 0; i < 60 && g.q("wave") !== 2; i++) g.tick();
  assertClose(g.q("wave"), 2, 0, "once no hazard of any tier remains, the wave must advance");
});

check("a zero-sized roster still cannot complete (no wave cycling, re-tested for the tiered world)", () => {
  const g = boot();
  suppressSpawns(g);
  for (let i = 0; i < 600; i++) {
    g.tick();
    assert(g.count() === 0, `no rock of any tier may spawn from a zero roster (frame ${i + 1})`);
  }
  assertClose(g.q("wave"), 1, 0, "an endless empty wave must hold at wave 1");
  assert(g.q("inIntermission") === false, "a zero roster must never trigger an intermission");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
