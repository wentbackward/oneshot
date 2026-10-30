#!/usr/bin/env node
// ================================================================
// Unit tests — laser subsystem (ticket #3)
//
// Runs the REAL <script> from asteroids.html inside a sandboxed
// vm context with a stubbed window/document/canvas, drives frames
// through the captured requestAnimationFrame callback, and asserts
// on observable game state. No network, no external services.
//
// Run: node tests/lasers.test.mjs
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

// Boot a fresh copy of the game with a canvas of the given size.
// A very large canvas is used where a test counts total shots fired
// (so no laser ever leaves the screen and gets recycled mid-test).
function boot(width = 960, height = 600) {
  let rafCallback = null;
  const listeners = {};
  const ctxCalls = [];
  const ctxProps = new Map(); // records style/property sets so they don't churn the proxy
  const ctxStub = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        return (..._args) => ctxCalls.push(String(prop));
      },
      set(_t, prop, value) {
        ctxProps.set(prop, value);
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
  // Ticket #8: dismiss the start screen so this suite drives the
  // running simulation (Enter starts play).
  for (const cb of listeners["keydown"] ?? []) cb({ code: "Enter", preventDefault() {} });

  let nowMs = 0;
  const FRAME_MS = 1000 / 60;
  function tick(ms = FRAME_MS) {
    nowMs += ms;
    rafCallback(nowMs);
  }
  const keydownFlag = { prevented: false };
  function key(code, down) {
    for (const cb of listeners[down ? "keydown" : "keyup"] ?? []) {
      cb({
        code,
        preventDefault() {
          if (code === "Space") keydownFlag.prevented = true;
        },
      });
    }
  }
  const q = (expr) => vm.runInContext(expr, context);
  return {
    tick,
    key,
    fire: (type) => {
      for (const cb of listeners[type] ?? []) cb({});
    },
    q,
    keydownFlag,
    ctxCalls,
    activeSlots: () => q("[...laserPool.slots].filter((s) => s.active)"),
    activeCount: () =>
      q("laserPool.slots.reduce((n, s) => n + (s.active ? 1 : 0), 0)"),
  };
}

// ================================================================
// CRITERION 2a: LASER_COOLDOWN_MS exists and defaults to 150
// ================================================================
check("LASER_COOLDOWN_MS is a named constant defaulting to 150", () => {
  const g = boot();
  const value = g.q("typeof LASER_COOLDOWN_MS === 'number' ? LASER_COOLDOWN_MS : NaN");
  assertClose(value, 150, 0, "default LASER_COOLDOWN_MS must be 150");
});

// ================================================================
// CRITERION 1: Space fires one laser from the nose along the heading
// ================================================================
check("pressing Space fires exactly one laser from the ship's nose along its heading", () => {
  const g = boot(); // ship starts centred, heading = -PI/2 (up), at rest
  g.key("Space", true);
  assert(g.keydownFlag.prevented, "Space keydown must be preventDefaulted (no page scroll)");
  g.tick(); // frame 1 (dt=0 bootstrap, shot released)
  g.tick(); // frame 2 (one 60fps step of motion)
  const n = g.activeCount();
  assert(n === 1, `exactly one laser after one shot, got ${n}`);
  const [L] = g.activeSlots();
  const ship = g.q("({ x: ship.x, y: ship.y })");
  const expectedDist = g.q("SHIP_RADIUS + LASER_LENGTH / 2 + LASER_SPEED * (1000/60) / 1000");
  const dist = Math.hypot(L.x - ship.x, L.y - ship.y);
  assertClose(L.x, ship.x, 0.5, "laser stays on the ship's heading axis (no drift sideways)");
  assertClose(dist, expectedDist, 0.5, "laser spawns at the nose and advances one frame along the heading");
  assert(L.y < ship.y, "laser is in front of (above) an upward-heading ship");
  const yBefore = g.activeSlots()[0].y;
  g.tick();
  const yAfter = g.activeSlots()[0].y;
  assert(yAfter < yBefore, "beam moves up and toward off-screen while the ship holds still");
});

check("no laser is fired unless Space is held", () => {
  const g = boot();
  g.tick();
  g.key("ArrowUp", true); // moving alone must not fire
  for (let i = 0; i < 60; i++) g.tick();
  assert(g.activeCount() === 0, `held movement without Space must not fire, got ${g.activeCount()} lasers`);
});

// ================================================================
// CRITERION 2b: raising the constant to 2000 caps fire at 1 per 2 s
// ================================================================
check("setting LASER_COOLDOWN_MS to 2000 limits sustained fire to at most one laser per 2 s", () => {
  const g = boot(100000, 100000); // giant canvas: lasers never recycle during the test
  g.q("LASER_COOLDOWN_MS = 2000");
  g.key("Space", true);
  // ~1.9 s of held fire: a compliant implementation fires exactly once.
  for (let i = 0; i < 114; i++) g.tick();
  const n = g.activeCount();
  assert(n >= 1, `firing must still work at a 2 s cooldown, got ${n} lasers`);
  assert(n <= 1, `at most one laser per 2 s, got ${n} in 1.9 s`);
});

// ================================================================
// CRITERION 3: sustained fire >= 5 lasers/s at the default constant
// ================================================================
check("sustained fire at the default 150 ms cooldown sustains at least 5 lasers per second", () => {
  const g = boot(100000, 100000);
  g.key("Space", true);
  for (let i = 0; i < 60; i++) g.tick(); // 1 s of held fire
  const n = g.activeCount();
  assert(n >= 5, `expected at least 5 lasers in 1 s, got ${n}`);
  assert(n <= 10, `cooldown must still gate fire at the default, got ${n} in 1 s`);
});

// ================================================================
// CRITERION 4: off-screen removal + fixed pre-allocated pool,
// recycling the same slot objects (no per-shot allocation)
// ================================================================
check("lasers deactivate once off-screen and are recycled from the pre-allocated pool", () => {
  const g = boot(200, 200); // small screen: an upward laser clears the top edge in < 0.2 s
  const size0 = g.q("laserPool.slots.length");
  assertClose(size0, g.q("LASER_POOL_SIZE"), 0, "pool is pre-allocated at boot to LASER_POOL_SIZE");
  const slotIds = g.q("[...laserPool.slots]"); // same object references as the game's slots
  g.key("Space", true);
  let sawActive = false;
  let maxActive = 0;
  let s0WasActive = false;
  let s0Recycled = false; // slot 0 toggled active -> inactive -> active
  const seenSlots = new Set();
  for (let i = 0; i < 180; i++) {
    g.tick(); // 3 s of sustained fire aimed at the top edge
    const n = g.activeCount();
    sawActive = sawActive || n > 0;
    maxActive = Math.max(maxActive, n);
    for (const s of g.activeSlots()) seenSlots.add(s);
    const s0 = g.q("laserPool.slots[0].active");
    s0WasActive = s0WasActive || s0;
    s0Recycled = s0Recycled || (s0WasActive && !s0);
  }
  assert(sawActive, "lasers actually fired during the sustained burst");
  assert(maxActive <= size0, `active lasers never exceed the pool (${maxActive} > ${size0})`);
  assert(
    seenSlots.size > 0 && [...seenSlots].every((s) => slotIds.includes(s)),
    "every fired laser occupies a pre-existing slot object (recycled, never newly allocated)"
  );
  assert(s0Recycled, "the same pre-allocated slot object is reused across shots");
  assertClose(g.q("laserPool.slots.length"), size0, 0, "pool size never grows while firing");
});

check("pool exhaustion never allocates: firing waits for a free slot", () => {
  const g = boot(200, 200);
  g.q("LASER_SPEED = 0"); // pathological console tune: lasers never leave, pool saturates
  g.q("LASER_COOLDOWN_MS = 50"); // fast cadence so 4 s comfortably overfills the 32-slot pool
  const size0 = g.q("laserPool.slots.length");
  g.key("Space", true);
  for (let i = 0; i < 240; i++) g.tick(); // 4 s >> pool capacity at 50 ms cadence
  const n = g.activeCount();
  assertClose(n, g.q("LASER_POOL_SIZE"), 0, "saturated pool holds exactly LASER_POOL_SIZE lasers, no overflow objects");
  assertClose(g.q("laserPool.slots.length"), size0, 0, "exhausted pool does not grow or crash");
});

// ================================================================
// #2-1 (should-fix): losing focus clears the pressed-keys set — a
// movement key held while the tab loses focus (alt-tab) must not
// keep pushing the ship once focus returns
// ================================================================
check("window blur clears the pressed-keys set: a held W after an alt-tab leaves the ship stationary", () => {
  const g = boot();
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0"); // empty field: thrust is the only input
  g.key("KeyW", true);
  for (let i = 0; i < 30; i++) g.tick(); // ~0.5 s of thrust (this suite's tick(ms) is ONE frame of length ms)
  assert(g.q("ship.vy") < -1, "precondition: held W gives the ship real upward speed");
  g.fire("blur"); // focus loss (alt-tab): held keys no longer reach the game
  assert(g.q("keys.size") === 0, "blur must clear the pressed-keys set");
  // Friction snaps the ship to rest; afterwards it must stay put.
  let rest = null;
  for (let i = 0; i < 120; i++) {
    g.tick();
    if (g.q("ship.vx") === 0 && g.q("ship.vy") === 0) {
      rest = g.q("({ x: ship.x, y: ship.y })");
      break;
    }
  }
  assert(rest, "friction must bring the ship to rest once the keys are cleared");
  for (let i = 0; i < 120; i++) g.tick(); // 2 s with no reachable input
  const p = g.q("({ x: ship.x, y: ship.y })");
  assert(p.x === rest.x && p.y === rest.y,
    `ship must remain stationary after the held key was dropped (drifted to ${p.x},${p.y} from ${rest.x},${rest.y} — ghost thrust)`);
});

// ================================================================
// #3-2 (should-fix): tryFire finds a free slot with a plain indexed
// loop — no .find closure allocated per shot
// ================================================================
check("tryFire scans the laser pool by index (no per-shot closure allocation)", () => {
  assert(!gameSource.includes("laserPool.slots.find"),
    "tryFire must not locate a free slot with .find (a closure per shot in the hot path)");
  // And the scan must still find a free slot: sustained fire keeps working.
  const g = boot(100000, 100000);
  g.key("Space", true);
  for (let i = 0; i < 60; i++) g.tick();
  assert(g.activeCount() >= 5, `indexed scan must still recycle slots (fired ${g.activeCount()} lasers in 1 s)`);
});

// ================================================================
// #3-3 (should-fix): render() skips the laser beginPath/stroke when
// no lasers are active (an empty path is pure waste at 60 fps)
// ================================================================
check("render begins no laser path with an empty pool, and exactly one batched path with lasers live", () => {
  const g = boot(960, 600);
  g.q("ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0; DRONE_GROWTH = 0"); // only the ship draws
  g.tick(); // bootstrap frame (dt = 0)
  g.ctxCalls.length = 0;
  g.tick();
  const emptyPaths = g.ctxCalls.filter((c) => c === "beginPath").length;
  assert(emptyPaths === 1,
    `with no active lasers only the ship path may be begun, got ${emptyPaths} beginPath calls`);
  // One active laser -> exactly one more (batched) path.
  g.q("laserPool.slots[0].active = true; laserPool.slots[0].x = 480; laserPool.slots[0].y = 100; laserPool.slots[0].dx = 0; laserPool.slots[0].dy = -1;");
  g.ctxCalls.length = 0;
  g.tick();
  const livePaths = g.ctxCalls.filter((c) => c === "beginPath").length;
  assert(livePaths === 2,
    `one active laser must add exactly one batched path, got ${livePaths} beginPath calls`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
