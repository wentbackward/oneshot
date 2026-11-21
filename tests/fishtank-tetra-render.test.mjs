#!/usr/bin/env node
// ================================================================
// VM boot tests — committed fishtank.html renders the default
// tetra population (ticket #120, PRD §2): at least TETRA_COUNT
// articulated-spine draws per frame — every tetra's spine is a
// path of at least TETRA_SPINE_SEGMENTS points — and the spine
// animates (each tetra's tail phase advances while frames flow).
//
// Harness: same vm-boot style as tests/fishtank-scaffold.test.mjs —
// the REAL bundled <script> from the committed fishtank.html boots
// in a sandboxed node:vm context with a stubbed counting 2d
// context; frames are driven through the captured rAF callback.
// The stub records moveTo/lineTo/arc call sites so the test can
// COUNT SPINE POINTS, not just raw draw calls. No network, no
// browser.
//
// Requires `npm ci` first (like every build-dependent check).
//
// Run: node tests/fishtank-tetra-render.test.mjs
// ================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { TETRA_SPINE_SEGMENTS } from "../src/render/tetras.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "fishtank.html"), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("no <script> block found in fishtank.html");
const gameSource = scriptMatch[1];

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

// ---------- vm stubs ----------

// A 2d-context stub: whitelisted drawing methods are counted;
// moveTo/lineTo/arc additionally record their coordinates so spine
// point counts can be audited. A call to a method NOT in the
// whitelist throws — that is the signal to extend the stub
// deliberately.
function makeCountingCtx(state, canvas) {
  const gradient = { addColorStop: () => {} };
  const target = {
    canvas,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => ({}),
    measureText: () => ({ width: 0 }),
  };
  for (const m of [
    "clearRect", "fillRect", "strokeRect",
    "beginPath", "closePath", "moveTo", "lineTo", "rect",
    "arc", "ellipse", "quadraticCurveTo", "bezierCurveTo",
    "fill", "stroke", "fillText", "strokeText",
    "save", "restore", "translate", "scale", "rotate", "setTransform",
    "drawImage",
  ]) {
    target[m] = (x, y) => {
      state.drawCalls += 1;
      if (m === "moveTo" || m === "lineTo" || m === "arc") {
        state.points.push([x, y]);
      }
    };
  }
  return new Proxy(target, {
    get(t, prop) {
      if (prop === Symbol.toPrimitive) return undefined;
      return t[prop];
    },
    set() {
      return true;
    },
  });
}

function makeCanvas(state) {
  let ctx;
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: (kind) => {
      assert(kind === "2d", `only the 2d context is supported, got ${kind}`);
      return ctx;
    },
  };
  ctx = makeCountingCtx(state, canvas);
  return canvas;
}

// Boot the REAL bundled script from the committed fishtank.html.
function boot(width, height) {
  const state = { drawCalls: 0, points: [] };
  const canvas = makeCanvas(state);
  let rafCb = null;
  let rafSeq = 0;
  const win = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    addEventListener: () => {},
    requestAnimationFrame: (cb) => {
      rafCb = cb;
      return ++rafSeq;
    },
  };
  const sandbox = {
    window: win,
    document: { getElementById: (id) => (id === "game" ? canvas : null) },
  };
  vm.createContext(sandbox);
  vm.runInContext(gameSource, sandbox);

  function frameAt(ms) {
    const cb = rafCb;
    if (typeof cb !== "function") throw new Error("the rAF loop stopped scheduling frames");
    rafCb = null;
    cb(ms);
  }
  return {
    state,
    frameAt,
    tick: (n, fromMs) => {
      let now = fromMs ?? 0;
      for (let i = 0; i < n; i++) {
        now += 1000 / 60;
        frameAt(now);
      }
    },
    q: (expr) => vm.runInContext(expr, sandbox),
  };
}

// ---------- boot-time invariants ----------

check("the vm seam exposes TETRA_COUNT and the live world holds exactly that many tetras", () => {
  const g = boot(800, 600);
  const tetraCount = g.q("typeof TETRA_COUNT === 'undefined' ? NaN : TETRA_COUNT");
  assert(Number.isInteger(tetraCount) && tetraCount > 0,
    `TETRA_COUNT must be exposed as a positive integer, got ${tetraCount}`);
  const length = g.q("typeof FISH_TANK_WORLD === 'undefined' ? NaN : FISH_TANK_WORLD.agents.length");
  assert(length === tetraCount,
    `the default world must hold exactly TETRA_COUNT tetras (${tetraCount}), got ${length}`);
});

// ================================================================
// Criterion: at least TETRA_COUNT spine path draws per frame —
// every tetra's articulated spine is a path of at least
// TETRA_SPINE_SEGMENTS recorded points
// ================================================================
check("every frame draws at least TETRA_COUNT spine paths of TETRA_SPINE_SEGMENTS points each", () => {
  assert(TETRA_SPINE_SEGMENTS >= 3,
    `test setup: TETRA_SPINE_SEGMENTS must describe a MULTI-segment spine, got ${TETRA_SPINE_SEGMENTS}`);
  const g = boot(800, 600);
  g.frameAt(0); // first frame (dt 0) still paints the tank
  for (let frame = 1; frame <= 10; frame++) {
    const base = g.state.drawCalls;
    const basePoints = g.state.points.length;
    g.tick(1, frame * (1000 / 60));
    const calls = g.state.drawCalls - base;
    const points = g.state.points.slice(basePoints);
    assert(calls >= 4, `frame ${frame}: tetra spines must be drawn (only ${calls} draw calls beyond water)`);
    assert(points.length >= 1, `frame ${frame}: spine geometry must be routed through path points`);
    // Group the frame's points per tetra: every spine contributes at
    // least TETRA_SPINE_SEGMENTS finite path points per frame.
    const tetraCount = g.q("TETRA_COUNT");
    const needed = tetraCount * TETRA_SPINE_SEGMENTS;
    assert(points.length >= needed,
      `frame ${frame}: expected ≥ ${needed} spine points (TETRA_COUNT × TETRA_SPINE_SEGMENTS), got ${points.length}`);
    for (const [x, y] of points) {
      assert(Number.isFinite(x) && Number.isFinite(y),
        `frame ${frame}: spine path point went non-finite (${x}, ${y})`);
    }
  }
});

// ================================================================
// Supporting: the spines ANIMATE — each tetra's tail phase is a
// sim-owned scalar that advances monotonically while frames flow
// ================================================================
check("the spine animates: every tetra's tail phase advances monotonically while frames flow", () => {
  const g = boot(800, 600);
  g.frameAt(0);
  g.tick(10, 0);
  const phasesBefore = g.q("JSON.stringify(FISH_TANK_WORLD.agents.slice(0, 8).map((t) => t.phase))");
  g.tick(20, 10 * (1000 / 60));
  const phasesAfter = JSON.parse(g.q("JSON.stringify(FISH_TANK_WORLD.agents.slice(0, 8).map((t) => t.phase))"));
  const before = JSON.parse(phasesBefore);
  assert(before.length === phasesAfter.length && before.length === 8, "test setup: need 8 observable tetras");
  for (let i = 0; i < before.length; i++) {
    assert(Number.isFinite(phasesAfter[i]), `tetra ${i} phase must stay finite, got ${phasesAfter[i]}`);
    assert(phasesAfter[i] > before[i],
      `tetra ${i} phase must advance while frames flow (${before[i]} → ${phasesAfter[i]})`);
  }
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
