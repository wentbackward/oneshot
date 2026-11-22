// ================================================================
// fishtank entry point: wires sim + render + ui together and owns
// the requestAnimationFrame loop. Auto-boots only in a browser-like
// context (window + document present) so stock node can import this
// module unchanged — the erasable-syntax rule lets tests import
// every src/**/*.ts directly.
//
// PRD §4 (ticket #126): the loop also owns the SIM SPEED
// (Pause/1x/2x/4x scale the already-clamped frame delta — the
// fixed timestep itself never stretches), feeds the telemetry HUD,
// loads the saved tank layout at boot and auto-saves it after every
// successful placement/removal (src/fishtank-storage.ts owns the
// schema; this file only wires).
// ================================================================

import {
  FIXED_DT,
  KELP_MAX,
  MAX_FRAME_DELTA,
  PELLET_MAX,
  ROCK_COLLIDE_PAD,
  ROCK_MAX,
  ROCK_RADIUS,
  TETRA_COUNT,
} from "./sim/constants.ts";
import { World } from "./sim/world.ts";
import { Renderer } from "./render/renderer.ts";
import { Stage } from "./ui/stage.ts";
import { Toolbar } from "./ui/toolbar.ts";
import { Hud } from "./ui/hud.ts";
import { SimSpeedControls, type SpeedOption } from "./ui/speed.ts";
import {
  STORAGE_KEY,
  loadTank,
  lightingModeOf,
  saveTank,
  type StorageLike,
} from "./fishtank-storage.ts";

/** FPS smoothing (exponential moving average over per-frame rates,
 *  0..1): ≈10 frames to settle, never a per-frame strobe. */
const FPS_EMA_ALPHA = 0.1;

/** Acquire the page's localStorage; a blocked or absent storage
 *  (privacy mode, jsdom-less vm) degrades to null — the sim
 *  proceeds with default layout and no persistence. */
function acquireStorage(win: Window): StorageLike | null {
  try {
    const s = win.localStorage;
    return s === null || s === undefined ? null : s;
  } catch {
    return null;
  }
}

/** Wire everything up and start the frame loop; returns the live
 *  world. */
function initFishtank(win: Window, doc: Document): World {
  const canvasEl = doc.getElementById("game");
  if (!canvasEl) throw new Error("fishtank: the #game element is missing");
  const stage = Stage.attach(canvasEl as HTMLCanvasElement, win);
  const world = new World();
  const storage = acquireStorage(win);
  // PRD §4: restore the saved layout BEFORE the first frame — any
  // corruption degrades to the constructed default tank inside
  // loadTank (it never throws).
  loadTank(world, storage);
  const renderer = new Renderer();
  const toolbar = new Toolbar(world, () => ({
    // CSS (layout) dims — the space the click listener's
    // coordinates arrive in — NOT the device-px backing store.
    width: stage.cssWidth,
    height: stage.cssHeight,
  })).attach(doc, canvasEl as HTMLCanvasElement);
  // PRD §4: a successful placement/removal changes the LAYOUT —
  // persist it. Rejected clicks fire nothing (layout unchanged).
  toolbar.onChanged = () => saveTank(world, storage);
  const hud = new Hud().attach(doc);
  // The loop's speed view (mult 0 = pause). A plain holder keeps
  // the frame closure allocation-free.
  const multRef = { value: 1 as SpeedOption };
  const speed = new SimSpeedControls((mult) => {
    multRef.value = mult;
  }).attach(doc);

  exposeTestSeam(world, toolbar, hud, speed, storage);

  let lastTs: number | null = null;
  let fpsEma = 0; // 0 = unknown (the first frame has no prior timestamp)
  const frame = (ts: number): void => {
    // First frame has no prior timestamp (dt 0); afterwards clamp
    // the gap: floored at 0 (timestamp rewind) and capped at
    // MAX_FRAME_DELTA (tab switch / long pause).
    const elapsed = lastTs === null ? 0 : (ts - lastTs) / 1000;
    lastTs = ts;
    if (elapsed > 0) {
      const instFps = 1 / elapsed;
      fpsEma = fpsEma > 0 ? FPS_EMA_ALPHA * instFps + (1 - FPS_EMA_ALPHA) * fpsEma : instFps;
    }
    // Speed control (PRD §4): the CLAMPED wall delta is multiplied
    // by the sim speed, so a 2x frame feeds exactly 2 × the wall
    // time and the fixed step budget consumes it in whole
    // FIXED_DT quanta (pause feeds 0 — the timestamp still
    // advances, so resuming can never burst).
    world.advance(clampDelta(elapsed) * multRef.value);
    renderer.render(stage.ctx, stage.width, stage.height, world);
    hud.update(world, fpsEma);
    win.requestAnimationFrame(frame);
  };
  win.requestAnimationFrame(frame);
  return world;
}

/** Floor at 0 s, cap at MAX_FRAME_DELTA s. */
function clampDelta(seconds: number): number {
  return Math.min(MAX_FRAME_DELTA, Math.max(0, seconds));
}

/** Test seam: tests/fishtank-scaffold.test.mjs, tests/fishtank-
 *  tetra-render.test.mjs, tests/fishtank-placement.test.mjs,
 *  tests/fishtank-food-toolbar.test.mjs, tests/fishtank-hud.test.mjs,
 *  tests/fishtank-speed.test.mjs and tests/fishtank-save.test.mjs
 *  run the bundled IIFE in node:vm and query these globals; an
 *  IIFE exposes no module exports, so the fixed-step constant, the
 *  default population, the placement- and food-tool constants, the
 *  live world, the live toolbar, the live HUD, the live speed
 *  controls and the storage-bound save/load are published on
 *  globalThis at boot. */
function exposeTestSeam(
  world: World,
  toolbar: Toolbar,
  hud: Hud,
  speed: SimSpeedControls,
  storage: StorageLike | null,
): void {
  const seam = globalThis as unknown as Record<string, unknown>;
  seam.FIXED_DT = FIXED_DT;
  seam.TETRA_COUNT = TETRA_COUNT;
  seam.FISH_TANK_WORLD = world;
  seam.FISH_TANK_TOOLBAR = toolbar;
  seam.ROCK_MAX = ROCK_MAX;
  seam.ROCK_RADIUS = ROCK_RADIUS;
  seam.ROCK_COLLIDE_PAD = ROCK_COLLIDE_PAD;
  seam.KELP_MAX = KELP_MAX;
  seam.PELLET_MAX = PELLET_MAX;
  seam.FISH_TANK_HUD = hud;
  seam.FISH_TANK_SPEED = speed;
  seam.STORAGE_KEY = STORAGE_KEY;
  seam.saveTank = (): void => saveTank(world, storage);
  seam.loadTank = (): void => loadTank(world, storage);
  seam.lightingModeOf = (): string => lightingModeOf(world);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  initFishtank(window, document);
}

export { initFishtank };
