#!/usr/bin/env node
// ================================================================
// Unit tests — spatial hash grid neighbor accuracy (ticket #119,
// PRD §1/§5): a uniform grid with insert/update/remove/query(x, y,
// radius) must return EXACTLY the same neighbour set as brute-force
// distance filtering over the same points.
//
// Harness: stock node with flag-free .ts type-stripping imports the
// real src/sim sources; layouts are generated with the seeded
// mulberry32 from src/sim/rng.ts (no network, no wall-clock
// dependence).
//
// Run: node tests/fishtank-grid.test.mjs
// ================================================================
import {
  SpatialGrid,
} from "../src/sim/spatialGrid.ts";
import { mulberry32 } from "../src/sim/rng.ts";

const TANK_WIDTH = 1600;
const TANK_HEIGHT = 1000;
const CELL = 64;

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

// ---------- helpers ----------

function makePoint(x, y) {
  return { x, y };
}

/** Brute-force neighbour set: every point p with dist(q, p) <= r. */
function bruteNeighbors(points, qx, qy, r) {
  const r2 = r * r;
  return points.filter((p) => {
    const dx = p.x - qx;
    const dy = p.y - qy;
    return dx * dx + dy * dy <= r2;
  });
}

/**
 * Compare two neighbour sets element-for-element as SETS with a ±1e-6
 * coordinate tolerance: quantize each coordinate to 1e-6, sort, compare.
 */
function assertSameNeighborSet(gridSet, bruteSet, label) {
  const key = (p) => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)}`;
  const a = gridSet.map(key).sort();
  const b = bruteSet.map(key).sort();
  assert(
    a.length === b.length,
    `${label}: set sizes differ (grid ${a.length} vs brute ${b.length})`
  );
  for (let i = 0; i < a.length; i++) {
    assert(a[i] === b[i], `${label}: set mismatch at slot ${i} (grid ${a[i]} vs brute ${b[i]})`);
  }
}

/** Insert all points, then verify EVERY point as query centre at radius r. */
function assertQueryMatchesBrute(points, radius, label) {
  const grid = new SpatialGrid(TANK_WIDTH, TANK_HEIGHT, CELL);
  for (const p of points) grid.insert(p);
  let total = 0;
  for (const c of points) {
    total += 1;
    assertQueryCenter(grid, points, c.x, c.y, radius, `${label} [centre ${total}/${points.length}]`);
  }
}

function assertQueryCenter(grid, points, qx, qy, r, label) {
  assertSameNeighborSet(grid.query(qx, qy, r), bruteNeighbors(points, qx, qy, r), label);
}

/** ≥ 5 random 200-point layouts, each with a distinct seeded character. */
function randomLayouts() {
  const layouts = [];
  // 1: uniform scatter, query radius larger than a cell (multi-cell span)
  layouts.push({
    label: "uniform scatter, R=90 (> cell)",
    radius: 90,
    points: (() => {
      const rng = mulberry32(0x5eed + 1);
      return Array.from({ length: 200 }, () => makePoint(rng() * TANK_WIDTH, rng() * TANK_HEIGHT));
    })(),
  });
  // 2: dense cluster inside a single cell (degenerate cell occupancy)
  layouts.push({
    label: "single-cell cluster, R=10 (< cell)",
    radius: 10,
    points: (() => {
      const rng = mulberry32(0x5eed + 2);
      return Array.from({ length: 200 }, () => makePoint(32 + rng() * 16, 96 + rng() * 16));
    })(),
  });
  // 3: points snapped onto cell boundaries + jitter (worst case for
  //    floor() binning: straddles the 3x3 probe edge)
  layouts.push({
    label: "cell-boundary snap, R=70",
    radius: 70,
    points: (() => {
      const rng = mulberry32(0x5eed + 3);
      return Array.from({ length: 200 }, (_, i) => {
        const bx = Math.min(TANK_WIDTH - 1, Math.round((i % 25) * CELL));
        const by = Math.min(TANK_HEIGHT - 1, Math.round(Math.floor(i / 25) * CELL) * CELL);
        return makePoint(bx + (rng() - 0.5) * 4, by + (rng() - 0.5) * 4);
      });
    })(),
  });
  // 4: radius spanning many cells (R >> cellSize — grid must widen its probe)
  layouts.push({
    label: "wide radius R=300 >> cell",
    radius: 300,
    points: (() => {
      const rng = mulberry32(0x5eed + 4);
      return Array.from({ length: 200 }, () => makePoint(rng() * TANK_WIDTH, rng() * TANK_HEIGHT));
    })(),
  });
  // 5: near-identical duplicate positions (set-equality under overlap)
  layouts.push({
    label: "duplicate-coord pile, R=25",
    radius: 25,
    points: (() => {
      const rng = mulberry32(0x5eed + 5);
      return Array.from({ length: 200 }, () => {
        const anchor = Math.floor(rng() * 8) * 200; // 8 anchors → heavy overlap
        return makePoint(anchor + rng() * 12, anchor % 700 + rng() * 12);
      });
    })(),
  });
  for (const l of layouts) assert(l.points.length === 200, "layouts must hold exactly 200 points");
  return layouts;
}

// ================================================================
// Criterion 1: grid API exists — insert/update/remove/query
// ================================================================
check("the grid exposes insert, update, remove and query(x, y, radius)", () => {
  const g = new SpatialGrid(100, 100, 32);
  for (const m of ["insert", "update", "remove", "query"]) {
    assert(typeof g[m] === "function", `SpatialGrid must expose ${m}()`);
  }
});

// ================================================================
// Criterion 2: neighbour accuracy vs brute force — ≥ 5 random
// 200-point layouts, fixed query radius, exact set equality (±1e-6)
// ================================================================
for (const l of randomLayouts()) {
  check(`neighbour set equals brute force on ${l.label}`, () => assertQueryMatchesBrute(l.points, l.radius, l.label));
}

// Query centres need not be entity positions: sweep a few synthetic
// centres (corners, exact cell corners, just outside the domain).
check("synthetic query centres (corners, cell rims, outside domain) match brute force", () => {
  const rng = mulberry32(0x5eed + 6);
  const points = Array.from({ length: 200 }, () => makePoint(rng() * TANK_WIDTH, rng() * TANK_HEIGHT));
  const grid = new SpatialGrid(TANK_WIDTH, TANK_HEIGHT, CELL);
  for (const p of points) grid.insert(p);
  const centres = [
    [0, 0], [TANK_WIDTH, TANK_HEIGHT], [CELL, CELL], [CELL - 1, TANK_HEIGHT - CELL],
    [-30, -30], [TANK_WIDTH + 30, TANK_HEIGHT + 30],
  ];
  for (const [cx, cy] of centres) {
    assertQueryCenter(grid, points, cx, cy, 80, `centre (${cx}, ${cy})`);
  }
});

// A boundary-exact point: a point at exactly distance R from the
// centre is INCLUDED (the documented closed-ball rule, both sides).
check("a point at exactly radius distance is included in the result", () => {
  const pts = [makePoint(0, 0), makePoint(50, 0)]; // second at exactly d=50
  const grid = new SpatialGrid(100, 100, 32);
  for (const p of pts) grid.insert(p);
  const got = grid.query(0, 0, 50);
  assert(got.length === 2, `closed ball: expected both points, got ${got.length}`);
});

// ================================================================
// Criterion 3: update() and remove() keep the index honest
// ================================================================
check("remove() drops the item from every subsequent query", () => {
  const a = makePoint(100, 100);
  const b = makePoint(110, 100);
  const grid = new SpatialGrid(500, 500, 64);
  grid.insert(a);
  grid.insert(b);
  assert(grid.query(100, 100, 20).length === 2, "setup: both items start visible");
  assert(grid.remove(a) === true, "remove of a present item must report true");
  const got = grid.query(100, 100, 20);
  assert(got.length === 1 && got[0] === b, "after remove only b remains in the query");
  assert(grid.remove(a) === false, "removing twice must report false");
  assert(grid.remove(makePoint(999, 999)) === false, "removing a never-inserted item must report false");
});

check("update() relocates a moved item into the correct cell", () => {
  const p = makePoint(10, 10);
  const far = makePoint(480, 480);
  const grid = new SpatialGrid(500, 500, 64);
  grid.insert(p);
  p.x = 480; // mutate position, then tell the grid
  p.y = 480;
  grid.update(p);
  assert(grid.query(480, 480, 5).includes(p), "updated item must be found at its new position");
  assert(!grid.query(10, 10, 5).includes(p), "updated item must no longer be found at its old position");
  assert(grid.query(10, 10, 700).filter((q) => q === p).length === 1, "an updated item must appear exactly once, not in two cells");
  grid.insert(far);
  assertSameNeighborSet(grid.query(480, 480, 5), bruteNeighbors([p, far], 480, 480, 5), "update + full brute");
});

check("an updated item still matches brute force at both radii", () => {
  const rng = mulberry32(0x5eed + 7);
  const points = Array.from({ length: 200 }, () => makePoint(rng() * TANK_WIDTH, rng() * TANK_HEIGHT));
  const grid = new SpatialGrid(TANK_WIDTH, TANK_HEIGHT, CELL);
  for (const p of points) grid.insert(p);
  // Move 40 items to fresh random spots and update each.
  const mover = mulberry32(0x5eed + 8);
  for (let i = 0; i < 40; i++) {
    points[i].x = mover() * TANK_WIDTH;
    points[i].y = mover() * TANK_HEIGHT;
    grid.update(points[i]);
  }
  for (const c of points) {
    assertSameNeighborSet(grid.query(c.x, c.y, 60), bruteNeighbors(points, c.x, c.y, 60), "post-update centre");
  }
});

check("clear() empties the grid (queries return no items)", () => {
  const grid = new SpatialGrid(500, 500, 64);
  for (let i = 0; i < 20; i++) grid.insert(makePoint(i * 20, i * 20));
  grid.clear();
  assert(grid.query(250, 250, 250).length === 0, "clear must drop every item");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
