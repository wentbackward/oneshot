#!/usr/bin/env node
// ================================================================
// Unit tests — dropped food & pellet physics (ticket #121, PRD §3):
//  - the PURE pellet integrator sinks a pellet with drag: y strictly
//    increases over 300 fixed steps, the sink speed asymptotes at
//    (and never exceeds) the named PELLET_TERMINAL_V, and a
//    horizontal current drifts x within a bounded band (zero in
//    still water);
//  - the world API dropFood() spawns at the cursor, rejects
//    non-finite coordinates and caps at the named PELLET_MAX;
//  - fish sensing: a tetra inside PELLET_SENSE_RADIUS homes on a
//    pellet — the tetra→pellet distance strictly decreases, the
//    pellet is consumed on contact (count drops by exactly 1); a
//    tetra OUTSIDE the radius does not alter its course (the
//    trajectory stays byte-identical to a pellet-free twin world);
//  - competition: several in-sense tetras consume ONE pellet exactly
//    once (a double-consume in one step would drop the count by 2,
//    which is impossible by construction and pinned here).
//
// Harness: stock node with flag-free .ts type-stripping imports the
// real src/sim sources; every world is seeded (no network, no
// wall-clock dependence).
//
// Run: node tests/fishtank-pellets.test.mjs
// ================================================================
import { stepPellet } from "../src/sim/pellets.ts";
import { World } from "../src/sim/world.ts";
import {
  AMBIENT_CURRENT_X,
  FIXED_DT,
  PELLET_DRAG,
  PELLET_EAT_RADIUS,
  PELLET_MAX,
  PELLET_SENSE_RADIUS,
  PELLET_TERMINAL_V,
  TANK_HEIGHT,
  TANK_WIDTH,
} from "../src/sim/constants.ts";

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

// ================================================================
// Criterion: pellets sink with drag — y strictly increases over
// 300 fixed steps
// ================================================================
check("pellet integrator: a pellet's y strictly increases at every one of 300 fixed steps", () => {
  const p = { x: TANK_WIDTH / 2, y: 200, vx: 0, vy: 0 };
  for (let i = 0; i < 300; i++) {
    const before = p.y;
    stepPellet(p, FIXED_DT, 0);
    assert(p.y > before,
      `step ${i + 1}: pellet y must strictly increase (stayed at ${before})`);
  }
});

// ================================================================
// Criterion: terminal velocity — the sink speed approaches, and
// never exceeds, the named PELLET_TERMINAL_V
// ================================================================
check("pellet integrator: after 300 steps the sink speed is at (not past) PELLET_TERMINAL_V", () => {
  const p = { x: TANK_WIDTH / 2, y: 200, vx: 0, vy: 0 };
  for (let i = 0; i < 300; i++) stepPellet(p, FIXED_DT, 0);
  assert(p.vy <= PELLET_TERMINAL_V + 1e-9,
    `terminal velocity must not exceed PELLET_TERMINAL_V (${PELLET_TERMINAL_V}), got ${p.vy}`);
  assert(p.vy >= PELLET_TERMINAL_V * 0.99,
    `5 s of settling must actually REACH the terminal regime (>= 99% of ${PELLET_TERMINAL_V}), got ${p.vy}`);
});

// ================================================================
// Criterion: a horizontal current shifts x within a bounded band —
// the drift converges to a bounded terminal, never runs away
// ================================================================
check("pellet integrator: a horizontal current drifts x forward, bounded by (current/drag)·t over 300 steps", () => {
  const x0 = 400;
  const p = { x: x0, y: 200, vx: 0, vy: 0 };
  for (let i = 0; i < 300; i++) stepPellet(p, FIXED_DT, AMBIENT_CURRENT_X);
  const dx = p.x - x0;
  const bound = (AMBIENT_CURRENT_X / PELLET_DRAG) * (300 * FIXED_DT);
  assert(dx > 0, `the current must carry the pellet downstream, got Δx=${dx}`);
  assert(dx <= bound + 1e-9,
    `drift must stay inside the bounded band (<= ${bound}), got Δx=${dx}`);
});

check("pellet integrator: still water (zero current) drifts a pellet not at all horizontally", () => {
  const p = { x: 400, y: 200, vx: 0, vy: 0 };
  for (let i = 0; i < 300; i++) stepPellet(p, FIXED_DT, 0);
  assert(p.x === 400, `with zero current the pellet x must not move, got ${p.x}`);
});

// ================================================================
// Criterion (supporting): World.dropFood — spawns at the cursor,
// rejects non-finite, caps at PELLET_MAX
// ================================================================
check("dropFood: spawns at the cursor, rejects non-finite coordinates, caps at PELLET_MAX", () => {
  const w = new World({ seed: 5, population: 1, predator: false });
  const p = w.dropFood(321.7, 240.2);
  assert(p !== null, "a dropFood inside the tank must spawn");
  assert(p.x === 321.7 && p.y === 240.2,
    `the pellet must land exactly at the cursor (${p.x}, ${p.y})`);
  assert(w.dropFood(Number.NaN, 100) === null, "a NaN x must be rejected");
  assert(w.dropFood(100, -Infinity) === null, "an infinite y must be rejected");
  for (let i = 0; i < PELLET_MAX + 3; i++) {
    w.dropFood(1 + (i % 40), 1 + (i % 7)); // scatter, ignore rejections
  }
  assert(w.pellets.length === PELLET_MAX,
    `the pellet count must stay exactly at PELLET_MAX (${PELLET_MAX}), got ${w.pellets.length}`);
  assert(w.dropFood(100, 100) === null, "a dropFood past the cap must return null");
});

// ================================================================
// Criterion: a tetra inside PELLET_SENSE_RADIUS homes on the
// pellet — distance strictly decreases, consumed on contact, the
// count drops by exactly 1
// ================================================================
check("sensing: a tetra inside PELLET_SENSE_RADIUS homes on a pellet — distance strictly decreases and the pellet is eaten (1 → 0)", () => {
  const w = new World({ seed: 11, population: 1, predator: false });
  const t = w.agents[0];
  // Open water, pellet directly ABOVE the tetra (it sinks toward
  // the fish — no wall, no school, no rock in the scenario).
  t.x = 800; t.y = 520; t.vx = 0; t.vy = -40; t.heading = -Math.PI / 2; t.torque = 0;
  const p = w.dropFood(800, 440);
  assert(p !== null && Math.hypot(p.x - t.x, p.y - t.y) <= PELLET_SENSE_RADIUS,
    "test setup: the pellet must be inside the sense radius");
  let prev = Infinity;
  let consumedAt = -1;
  for (let i = 0; i < 120; i++) {
    w.step(FIXED_DT);
    if (w.pellets.length === 0) { consumedAt = i + 1; break; }
    const d = Math.hypot(t.x - p.x, t.y - p.y);
    assert(d < prev - 1e-9,
      `step ${i + 1}: tetra→pellet distance must strictly decrease (${prev} -> ${d})`);
    prev = d;
  }
  assert(consumedAt > 0, "the pellet must be consumed within 120 steps");
  assert(w.pellets.length === 0,
    `exactly one pellet must be consumed (1 → 0), got ${w.pellets.length} left`);
});

// ================================================================
// Criterion: a tetra OUTSIDE PELLET_SENSE_RADIUS does not alter
// course — its trajectory stays byte-identical to a pellet-free
// twin world
// ================================================================
check("sensing: a pellet outside PELLET_SENSE_RADIUS alters the tetra's course not at all (byte-identical twin)", () => {
  const a = new World({ seed: 17, population: 1, predator: false });
  const b = new World({ seed: 17, population: 1, predator: false });
  const far = a.dropFood(20, 20);
  assert(far !== null, "test setup: pellet spawned");
  const d = Math.hypot(a.agents[0].x - far.x, a.agents[0].y - far.y);
  assert(d > PELLET_SENSE_RADIUS,
    `test setup: the pellet must sit OUTSIDE the sense radius (d=${d})`);
  for (let i = 0; i < 120; i++) { a.step(FIXED_DT); b.step(FIXED_DT); }
  const tetraLines = (w) =>
    w.serializeState().split("\n").slice(0, 1 + w.agents.length).join("\n");
  assert(tetraLines(a) === tetraLines(b),
    "a pellet outside the sense radius must leave the tetra trajectory byte-identical");
});

// ================================================================
// Criterion (competition): several in-sense tetras eat ONE pellet
// exactly once — the count transitions 1 → 0 a single time
// ================================================================
check("competition: in-sense tetras consume a single pellet exactly once", () => {
  const w = new World({ seed: 23, population: 12, predator: false });
  w.dropFood(TANK_WIDTH / 2, TANK_HEIGHT / 2); // the school spawns around the centre
  let transitions = 0;
  let count = w.pellets.length;
  assert(count === 1, "test setup: one pellet in the tank");
  for (let i = 0; i < 120 && count > 0; i++) {
    w.step(FIXED_DT);
    if (w.pellets.length !== count) transitions += 1;
    count = w.pellets.length;
  }
  assert(count === 0, "the school must eat the pellet within 120 steps");
  assert(transitions === 1,
    `a single pellet may be consumed exactly ONCE (1 → 0), saw ${transitions} transitions`);
});

check("contact boundary: the eat radius is the named PELLET_EAT_RADIUS and is reachable", () => {
  assert(Number.isFinite(PELLET_EAT_RADIUS) && PELLET_EAT_RADIUS > 0,
    "PELLET_EAT_RADIUS must be a positive finite constant");
  assert(PELLET_EAT_RADIUS < PELLET_SENSE_RADIUS,
    "the eat radius must sit inside the sense radius");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
