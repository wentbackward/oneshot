#!/usr/bin/env node
// ================================================================
// Unit tests — Craig Reynolds steering forces (ticket #119,
// PRD §2/§5): six exported forces, each returning a vector whose
// magnitude NEVER exceeds its named clamp constant, plus the two
// behavioural laws the ticket pins: alignment == mean neighbour
// heading (±1e-9), boundary avoidance strictly inward at every wall.
//
// Harness: stock node with flag-free .ts type-stripping imports the
// real src/sim/steering.ts; adversarial fixtures come from the
// seeded mulberry32 in src/sim/rng.ts (no network, no wall-clock
// dependence).
//
// Run: node tests/fishtank-steering.test.mjs
// ================================================================
import * as S from "../src/sim/steering.ts";
import { mulberry32 } from "../src/sim/rng.ts";

const TANK_WIDTH = 1600;
const TANK_HEIGHT = 1000;

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
const mag = (v) => Math.hypot(v.x, v.y);

// ---------- fixtures ----------

function body(x, y, vx, vy) {
  return { x, y, vx, vy };
}

/**
 * Adversarial fixture: seeded chaos. Includes coincident bodies,
 * zero velocities, huge velocities, negative coordinates far outside
 * the tank domain, and duplicate positions — every degeneracy the
 * force maths could choke on. Must never throw, must stay finite,
 * must respect its clamp.
 */
function adversarialBodies(seed, n = 12) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const roll = rng();
    let b;
    if (roll < 0.2) b = body(-5000, -5000, 0, 0);            // far outside, zero speed
    else if (roll < 0.4) b = body(1e6, 1e6, 1e6, 1e6);         // absurd speed
    else if (roll < 0.6) b = body(0, 0, 0, 0);                 // coincident pile
    else b = body(rng() * 5000, rng() * 5000, (rng() - 0.5) * 200, (rng() - 0.5) * 200);
    out.push(b);
  }
  out.push(out[0]); // exact duplicate reference
  return out;
}

/** Assert |force| <= clamp + 1e-9 and the result is finite. */
function assertWithinClamp(force, clamp, label) {
  assert(Number.isFinite(force.x) && Number.isFinite(force.y),
    `${label}: force must be finite, got (${force.x}, ${force.y})`);
  assert(mag(force) <= clamp + 1e-9,
    `${label}: magnitude ${mag(force)} exceeds the named clamp ${clamp}`);
}

// The six named forces and their named clamp constants must exist.
const FORCES = [
  ["separation", "MAX_SEPARATION_FORCE"],
  ["alignment", "MAX_ALIGNMENT_FORCE"],
  ["cohesion", "MAX_COHESION_FORCE"],
  ["boundaryAvoidance", "MAX_BOUNDARY_AVOIDANCE_FORCE"],
  ["obstacleAvoidance", "MAX_OBSTACLE_AVOIDANCE_FORCE"],
  ["seek", "MAX_SEEK_FORCE"],
];

// ================================================================
// Criterion 1: API surface — six forces + named clamp constants,
// every per-force clamp at or under the master MAX_STEERING_FORCE
// ================================================================
check("steering.ts exports all six forces and their named clamp constants", () => {
  assert(typeof S.MAX_STEERING_FORCE === "number" && S.MAX_STEERING_FORCE > 0,
    "MAX_STEERING_FORCE must be a positive named constant");
  for (const [fn, cn] of FORCES) {
    assert(typeof S[fn] === "function", `missing exported force ${fn}()`);
    assert(typeof S[cn] === "number" && S[cn] > 0, `missing positive named clamp ${cn}`);
    assert(S[cn] <= S.MAX_STEERING_FORCE + 1e-12,
      `${cn} (${S[cn]}) must not exceed the master MAX_STEERING_FORCE (${S.MAX_STEERING_FORCE})`);
  }
});

// ================================================================
// Criterion 2: under adversarial fixtures EVERY force's magnitude
// stays at or under its named clamp (and stays finite)
// ================================================================
{
  const self = body(123.4, 56.7, 40, -25);
  const others = adversarialBodies(0xbeef);
  const wallPos = { x: 123.4, y: 56.7 };
  const obstacles = adversarialBodies(0xcafe).map((b) => ({ x: b.x, y: b.y, r: 10 + 50 * Math.abs(Math.sin(b.x)) }));
  const target = { x: 1e6, y: -1e6 };

  check("separation magnitude never exceeds MAX_SEPARATION_FORCE (adversarial)", () => {
    for (let i = 0; i < 25; i++) {
      const foe = mulberry32(1000 + i);
      const neighbours = Array.from({ length: 20 }, () => body(
        foe() * 4000 - 2000, foe() * 4000 - 2000, foe() * 500, foe() * 500));
      assertWithinClamp(S.separation(self, neighbours), S.MAX_SEPARATION_FORCE, `separation batch ${i}`);
    }
    assertWithinClamp(S.separation(self, others), S.MAX_SEPARATION_FORCE, "separation adversarial");
  });

  check("alignment magnitude never exceeds MAX_ALIGNMENT_FORCE (adversarial)", () => {
    for (let i = 0; i < 25; i++) {
      const foe = mulberry32(2000 + i);
      const neighbours = Array.from({ length: 20 }, () => body(0, 0, foe() * 1e6, foe() * 1e6));
      assertWithinClamp(S.alignment(neighbours), S.MAX_ALIGNMENT_FORCE, `alignment batch ${i}`);
    }
    assertWithinClamp(S.alignment(others), S.MAX_ALIGNMENT_FORCE, "alignment adversarial");
  });

  check("cohesion magnitude never exceeds MAX_COHESION_FORCE (adversarial)", () => {
    for (let i = 0; i < 25; i++) {
      const foe = mulberry32(3000 + i);
      const neighbours = Array.from({ length: 20 }, () => body(
        foe() * 4000 - 2000, foe() * 4000 - 2000, 0, 0));
      assertWithinClamp(S.cohesion(self, neighbours), S.MAX_COHESION_FORCE, `cohesion batch ${i}`);
    }
    assertWithinClamp(S.cohesion(self, others), S.MAX_COHESION_FORCE, "cohesion adversarial");
  });

  check("boundary avoidance magnitude never exceeds MAX_BOUNDARY_AVOIDANCE_FORCE (adversarial)", () => {
    const foe = mulberry32(4000);
    for (let i = 0; i < 25; i++) {
      const p = { x: foe() * 6000 - 2000, y: foe() * 6000 - 2000 };
      assertWithinClamp(S.boundaryAvoidance(p, TANK_WIDTH, TANK_HEIGHT),
        S.MAX_BOUNDARY_AVOIDANCE_FORCE, `boundary batch ${i}`);
    }
    assertWithinClamp(S.boundaryAvoidance(wallPos, TANK_WIDTH, TANK_HEIGHT),
      S.MAX_BOUNDARY_AVOIDANCE_FORCE, "boundary adversarial");
  });

  check("obstacle avoidance magnitude never exceeds MAX_OBSTACLE_AVOIDANCE_FORCE (adversarial)", () => {
    assertWithinClamp(S.obstacleAvoidance(self, obstacles),
      S.MAX_OBSTACLE_AVOIDANCE_FORCE, "obstacle adversarial");
    // An obstacle swallows the body: the worst-case overlap.
    const engulf = S.obstacleAvoidance(body(0, 0, 10, 10), [{ x: 0, y: 0, r: 500 }]);
    assertWithinClamp(engulf, S.MAX_OBSTACLE_AVOIDANCE_FORCE, "obstacle engulfment");
  });

  check("seek magnitude never exceeds MAX_SEEK_FORCE (adversarial)", () => {
    assertWithinClamp(S.seek(self, target), S.MAX_SEEK_FORCE, "seek far target");
    const foe = mulberry32(5000);
    for (let i = 0; i < 25; i++) {
      const t = { x: foe() * 1e6 - 5e5, y: foe() * 1e6 - 5e5 };
      assertWithinClamp(S.seek(self, t), S.MAX_SEEK_FORCE, `seek batch ${i}`);
    }
  });
}

// ================================================================
// Criterion 3: alignment EQUALS the mean neighbour-heading
// direction (±1e-9)
// ================================================================
check("alignment equals the mean neighbour-heading direction (±1e-9)", () => {
  const neighbours = [
    body(0, 0, 3, 4),     // unit heading (0.6, 0.8)
    body(0, 0, -4, 0),    // unit heading (-1, 0)
    body(0, 0, 0, 5),     // unit heading (0, 1)
  ];
  const got = S.alignment(neighbours);
  // mean of unit headings: ((0.6 - 1 + 0)/3, (0.8 + 0 + 1)/3)
  const ex = (0.6 - 1 + 0) / 3;
  const ey = (0.8 + 0 + 1) / 3;
  assert(Math.abs(got.x - ex) <= 1e-9, `alignment x: got ${got.x}, want ${ex} (±1e-9)`);
  assert(Math.abs(got.y - ey) <= 1e-9, `alignment y: got ${got.y}, want ${ey} (±1e-9)`);
});

check("alignment scales neither with speed nor with count drift: unequal speeds still average unit headings (±1e-9)", () => {
  const neighbours = [
    body(0, 0, 100, 100), // unit heading (√2/2, √2/2) — big speed must not dominate
    body(0, 0, 1e-4, 0),  // unit heading (1, 0) — tiny speed
  ];
  const got = S.alignment(neighbours);
  const u = Math.SQRT1_2;
  const ex = (u + 1) / 2;
  const ey = u / 2;
  assert(Math.abs(got.x - ex) <= 1e-9, `alignment x: got ${got.x}, want ${ex} (±1e-9)`);
  assert(Math.abs(got.y - ey) <= 1e-9, `alignment y: got ${got.y}, want ${ey} (±1e-9)`);
});

check("alignment is the zero vector for empty and for all-still neighbours", () => {
  const none = S.alignment([]);
  assert(none.x === 0 && none.y === 0, "empty neighbour list must yield (0, 0)");
  const still = S.alignment([body(0, 0, 0, 0), body(5, 5, 0, 0)]);
  assert(still.x === 0 && still.y === 0, "all-still neighbours have no heading: (0, 0)");
});

// ================================================================
// Criterion 4: boundary avoidance points STRICTLY inward from each
// wall (and is silent well inside the margins)
// ================================================================
check("boundary avoidance points strictly inward from the left wall", () => {
  const f = S.boundaryAvoidance({ x: 10, y: TANK_HEIGHT / 2 }, TANK_WIDTH, TANK_HEIGHT);
  assert(f.x > 0, `at the left wall the force must push +x, got x=${f.x}`);
});

check("boundary avoidance points strictly inward from the right wall", () => {
  const f = S.boundaryAvoidance({ x: TANK_WIDTH - 10, y: TANK_HEIGHT / 2 }, TANK_WIDTH, TANK_HEIGHT);
  assert(f.x < 0, `at the right wall the force must push -x, got x=${f.x}`);
});

check("boundary avoidance points strictly inward from the top wall", () => {
  const f = S.boundaryAvoidance({ x: TANK_WIDTH / 2, y: 10 }, TANK_WIDTH, TANK_HEIGHT);
  assert(f.y > 0, `at the top wall (y=0 side) the force must push +y, got y=${f.y}`);
});

check("boundary avoidance points strictly inward from the bottom wall", () => {
  const f = S.boundaryAvoidance({ x: TANK_WIDTH / 2, y: TANK_HEIGHT - 10 }, TANK_WIDTH, TANK_HEIGHT);
  assert(f.y < 0, `at the bottom wall the force must push -y, got y=${f.y}`);
});

check("boundary avoidance strengthens with wall proximity (monotonic in the margin)", () => {
  const near = S.boundaryAvoidance({ x: 5, y: TANK_HEIGHT / 2 }, TANK_WIDTH, TANK_HEIGHT);
  const far = S.boundaryAvoidance({ x: 40, y: TANK_HEIGHT / 2 }, TANK_WIDTH, TANK_HEIGHT);
  assert(near.x > far.x && far.x > 0,
    `closer to the wall must push harder (near ${near.x} vs far ${far.x})`);
});

check("boundary avoidance is exactly zero well inside all margins", () => {
  const f = S.boundaryAvoidance({ x: TANK_WIDTH / 2, y: TANK_HEIGHT / 2 }, TANK_WIDTH, TANK_HEIGHT);
  assert(f.x === 0 && f.y === 0, `deep inside must be (0,0), got (${f.x}, ${f.y})`);
});

// ================================================================
// Criterion 5 (supporting behaviour): the other forces point the
// way they claim to
// ================================================================
check("separation pushes the lone straggler AWAY from its crowd (finite, right direction)", () => {
  const self = body(0, 0, 0, 0);
  const crowd = [body(10, 0, 0, 0), body(12, 4, 0, 0), body(9, -6, 0, 0)];
  const f = S.separation(self, crowd);
  assert(f.x < 0, `separation must point away from the +x crowd (toward -x), got (${f.x}, ${f.y})`);
});

check("separation is the zero vector with no neighbours", () => {
  const f = S.separation(body(1, 2, 3, 4), []);
  assert(f.x === 0 && f.y === 0, "no neighbours → (0, 0)");
});

check("cohesion pulls a straggler TOWARD the crowd centroid", () => {
  const self = body(0, 0, 0, 0);
  const crowd = [body(100, 0, 0, 0), body(100, 40, 0, 0)];
  const f = S.cohesion(self, crowd);
  assert(f.x > 0 && Math.abs(f.y - 20 * (f.x / 100)) < 1e-6,
    `cohesion must aim at the centroid (100, 20), got (${f.x}, ${f.y})`);
});

check("obstacle avoidance steers the body away from a rock in its path", () => {
  const bodyAhead = body(0, 0, 60, 0);
  const rock = { x: 100, y: 0, r: 40 };
  const f = S.obstacleAvoidance(bodyAhead, [rock]);
  const away = { x: 0 - rock.x, y: 0 - rock.y }; // from rock toward body
  assert(f.x * away.x + f.y * away.y > 0,
    `force must have a component away from the rock, got (${f.x}, ${f.y})`);
});

check("obstacle avoidance is the zero vector with no obstacles and beyond the sensing distance", () => {
  assert(S.obstacleAvoidance(body(0, 0, 10, 10), []).x === 0, "no obstacles → (0, 0)");
  const far = S.obstacleAvoidance(body(0, 0, 10, 10), [{ x: 1e6, y: 1e6, r: 10 }]);
  assert(far.x === 0 && far.y === 0, "an obstacle far beyond sensing → (0, 0)");
});

check("seek aims at the target: zero velocity yields a force toward it", () => {
  const f = S.seek(body(0, 0, 0, 0), { x: 0, y: 100 });
  assert(f.y > 0 && f.x === 0, `seek must aim straight at (0, 100), got (${f.x}, ${f.y})`);
});

check("seek is the zero vector when already at the target", () => {
  const f = S.seek(body(7, 9, 12, -5), { x: 7, y: 9 });
  assert(f.x === 0 && f.y === 0, "at the target, desired==velocity leaves nothing to steer");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
