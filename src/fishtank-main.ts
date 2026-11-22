// ================================================================
// fishtank entry point: wires sim + render + ui together and owns
// the requestAnimationFrame loop. Auto-boots only in a browser-like
// context (window + document present) so stock node can import this
// module unchanged — the erasable-syntax rule lets tests import
// every src/**/*.ts directly.
// ================================================================

import {
  FIXED_DT,
  KELP_MAX,
  MAX_FRAME_DELTA,
  ROCK_COLLIDE_PAD,
  ROCK_MAX,
  ROCK_RADIUS,
  TETRA_COUNT,
} from "./sim/constants.ts";
import { World } from "./sim/world.ts";
import { Renderer } from "./render/renderer.ts";
import { Stage } from "./ui/stage.ts";
import { Toolbar } from "./ui/toolbar.ts";

/** Wire everything up and start the frame loop; returns the live
 *  world. */
function initFishtank(win: Window, doc: Document): World {
  const canvasEl = doc.getElementById("game");
  if (!canvasEl) throw new Error("fishtank: the #game element is missing");
  const stage = Stage.attach(canvasEl as HTMLCanvasElement, win);
  const world = new World();
  const renderer = new Renderer();
  const toolbar = new Toolbar(world, () => ({
    // CSS (layout) dims — the space the click listener's
    // coordinates arrive in — NOT the device-px backing store.
    width: stage.cssWidth,
    height: stage.cssHeight,
  })).attach(doc, canvasEl as HTMLCanvasElement);
  exposeTestSeam(world, toolbar);

  let lastTs: number | null = null;
  const frame = (ts: number): void => {
    // First frame has no prior timestamp (dt 0); afterwards clamp
    // the gap: floored at 0 (timestamp rewind) and capped at
    // MAX_FRAME_DELTA (tab switch / long pause).
    const elapsed = lastTs === null ? 0 : (ts - lastTs) / 1000;
    lastTs = ts;
    world.advance(clampDelta(elapsed));
    renderer.render(stage.ctx, stage.width, stage.height, world);
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
 *  tetra-render.test.mjs and tests/fishtank-placement.test.mjs
 *  run the bundled IIFE in node:vm and query these globals; an
 *  IIFE exposes no module exports, so the fixed-step constant,
 *  the default population, the placement-tool constants, the live
 *  world and the live toolbar are published on globalThis at
 *  boot. */
function exposeTestSeam(world: World, toolbar: Toolbar): void {
  const seam = globalThis as unknown as Record<string, unknown>;
  seam.FIXED_DT = FIXED_DT;
  seam.TETRA_COUNT = TETRA_COUNT;
  seam.FISH_TANK_WORLD = world;
  seam.FISH_TANK_TOOLBAR = toolbar;
  seam.ROCK_MAX = ROCK_MAX;
  seam.ROCK_RADIUS = ROCK_RADIUS;
  seam.ROCK_COLLIDE_PAD = ROCK_COLLIDE_PAD;
  seam.KELP_MAX = KELP_MAX;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  initFishtank(window, document);
}

export { initFishtank };
