#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html fixed-aspect stage fit: the CSS stage
// size must GROW with a large viewport (the old "cap at 1:1" is
// dropped, ticket #101) while still downscaling on small viewports,
// always aspect-preserving (letterbox, no stretching), with the
// backing store (logical resolution) unchanged.
//
// Same harness style as the sibling bricks-*.test.mjs suites: the
// REAL <script> from bricks.html runs in a sandboxed vm context
// with stubbed window/document/localStorage/requestAnimationFrame
// and DOM element stubs. No network, no external services, no wall
// clock or sleeps. window.innerWidth/innerHeight are driven
// deterministically and the game's own resize listener + one frame
// tick apply the deferred refit, exactly like the browser does.
//
// Coverage against the ticket's acceptance criteria:
//   AC(a) — on a LARGE virtual viewport the fit is > 1 and the CSS
//           w/h grow proportionally to the stage aspect; the
//           backing store stays GAME_W*CANVAS_SCALE
//   AC(b) — on a SMALL viewport the fit is < 1 and it shrinks
//   AC(c) — the CSS width/height ratio ALWAYS equals GAME_W/GAME_H
//           (aspect preserved) across a sweep of viewport sizes,
//           including the native-size boundary
//   AC(d) — no distortion: fit is the MIN of the two axes, so the
//           tighter axis fills the viewport and the other fits
//           within it
//   verify — the rect-based pointer mapping (setPaddleX) still lands
//           the paddle centre under the cursor when the stage is
//           upscaled
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

// Mirrors the game's named constants (checked live against the
// booted game below as well, so a drift fails both sides).
const CLASSIC_W = 960;
const CLASSIC_H = 600;
const SCALE = 2;

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

// A DOM element stub: records styles, text, listeners and classes.
function makeEl(id) {
  const el = {
    id,
    style: {},
    textContent: "",
    className: "",
    children: [],
    listeners: {},
    addEventListener(type, cb) {
      (this.listeners[type] ??= []).push(cb);
    },
    click() {
      for (const cb of this.listeners["click"] ?? []) cb({ type: "click" });
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
  };
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

// Boot a fresh copy of the game at the given (virtual) viewport size.
function boot(viewW, viewH) {
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    // Placeholder pre-fit rect (viewport-sized). The pointer-mapping
    // test re-sets this to the fitted CSS size after g.viewport(), which
    // is what models the real browser layout.
    rect: { left: 0, top: 0, width: viewW, height: viewH },
    getBoundingClientRect: () => canvas.rect,
    listeners: {},
    getContext: () => makeCtx(),
    addEventListener(type, cb) {
      (this.listeners[type] ??= []).push(cb);
    },
  };
  const els = {
    "game": canvas,
    "screen-start": makeEl("screen-start"),
    "btn-start": makeEl("btn-start"),
    "difficulty-easy": makeEl("difficulty-easy"),
    "difficulty-normal": makeEl("difficulty-normal"),
    "difficulty-hard": makeEl("difficulty-hard"),
    "theme-classic": makeEl("theme-classic"),
    "theme-neon": makeEl("theme-neon"),
    "theme-minimal": makeEl("theme-minimal"),
    "mode-classic": makeEl("mode-classic"),
    "mode-exciting": makeEl("mode-exciting"),
    "mode-alleyway": makeEl("mode-alleyway"),
    "fastfwd-off": makeEl("fastfwd-off"),
    "fastfwd-1-5": makeEl("fastfwd-1-5"),
    "fastfwd-2-0": makeEl("fastfwd-2-0"),
    "fastfwd-3-0": makeEl("fastfwd-3-0"),
    "btn-mute": makeEl("btn-mute"),
    "sound-volume": makeEl("sound-volume"),
    "ball-speed": makeEl("ball-speed"),
    "ball-speed-label": makeEl("ball-speed-label"),
    "ball-speed-value": makeEl("ball-speed-value"),
    "screen-gameover": makeEl("screen-gameover"),
    "btn-restart": makeEl("btn-restart"),
    "btn-menu": makeEl("btn-menu"),
    "screen-pause": makeEl("screen-pause"),
    "btn-resume": makeEl("btn-resume"),
    "gameover-final": makeEl("gameover-final"),
    "hud-score": makeEl("hud-score"),
    "hud-level": makeEl("hud-level"),
    "hiscore": makeEl("hiscore"),
    "lives": makeEl("lives"),
    "btn-reset-hiscore": makeEl("btn-reset-hiscore"),
    "btn-fullscreen": makeEl("btn-fullscreen"),
    "leaderboard-start": makeEl("leaderboard-start"),
    "capsule-legend": makeEl("capsule-legend"),
    "leaderboard-gameover": makeEl("leaderboard-gameover"),
  };
  const winListeners = {};
  let rafCb = null;
  let rafId = 0;
  const win = {
    innerWidth: viewW,
    innerHeight: viewH,
    addEventListener: (type, cb) => {
      (winListeners[type] ??= []).push(cb);
    },
  };
  const sandbox = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    window: win,
    document: {
      getElementById: (id) => els[id] ?? null,
      createElement: (tag) => makeEl(tag),
      addEventListener: () => {}, // ticket #113: fullscreenchange registers on document at boot
    },
    requestAnimationFrame: (cb) => {
      rafCb = cb;
      return ++rafId;
    },
  };
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
  const q = (expr) => vm.runInContext(expr, context);

  return {
    els,
    canvas,
    q,
    tick,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    start() {
      els["btn-start"].click();
      tick(1);
    },
    // Drive the virtual viewport deterministically: change the
    // window metrics, fire the game's own "resize" listener (which
    // defers the refit), then run one frame so the deferred
    // resizeCanvas() applies — the browser's exact sequence.
    viewport(w, h) {
      win.innerWidth = w;
      win.innerHeight = h;
      for (const cb of winListeners["resize"] ?? []) cb({ type: "resize" });
      tick(1);
    },
    winEvent(type, ev) {
      for (const cb of winListeners[type] ?? []) cb(ev);
    },
    // Parse the CSS px pair off the canvas style.
    css() {
      const parse = (v) => parseInt(v, 10);
      return { w: parse(canvas.style.width), h: parse(canvas.style.height) };
    },
  };
}

// fit the game itself would pick for a viewport (dropped cap):
// min of the two axes, no 1:1 clamp.
function expectedFit(viewW, viewH) {
  return Math.min(viewW / CLASSIC_W, viewH / CLASSIC_H);
}

// ================================================================
// AC(a): large virtual viewport — fit > 1, CSS grows
// proportionally to the stage aspect, backing store unchanged
// ================================================================
check("large viewport: fit > 1 and the CSS stage upscales proportionally (2560x1440 -> 2304x1440)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  assert(g.state() === "playing", `setup: run started, state=${g.state()}`);
  g.viewport(2560, 1440);
  const css = g.css();
  const fit = expectedFit(2560, 1440); // min(2560/960, 1440/600) = 2.4
  assert(fit > 1, `setup: chosen viewport must yield fit > 1, got ${fit}`);
  assert(css.w === Math.round(CLASSIC_W * fit),
    `CSS width must grow to round(960 * ${fit}) = ${Math.round(CLASSIC_W * fit)} px, got ${css.w}`);
  assert(css.h === Math.round(CLASSIC_H * fit),
    `CSS height must grow to round(600 * ${fit}) = ${Math.round(CLASSIC_H * fit)} px, got ${css.h}`);
  assert(css.w > CLASSIC_W && css.h > CLASSIC_H,
    `the stage must be LARGER than native on a large monitor (got ${css.w}x${css.h})`);
  assert(g.q("canvas.width") === CLASSIC_W * SCALE,
    `the backing store must stay at the native logical resolution ${CLASSIC_W * SCALE}, got ${g.q("canvas.width")}`);
  assert(g.q("canvas.height") === CLASSIC_H * SCALE,
    `the backing store must stay at the native logical resolution ${CLASSIC_H * SCALE}, got ${g.q("canvas.height")}`);
});

check("large viewport: growth stays proportional to the stage aspect (1920x2400 tall monitor, width axis binds)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  g.viewport(1920, 2400);
  const css = g.css();
  const fit = expectedFit(1920, 2400); // min(2, 4) = 2
  assert(fit > 1, `setup: chosen viewport must yield fit > 1, got ${fit}`);
  assert(css.w === Math.round(CLASSIC_W * fit),
    `CSS width must be ${Math.round(CLASSIC_W * fit)} px at fit ${fit}, got ${css.w}`);
  assert(css.h === Math.round(CLASSIC_H * fit),
    `CSS height must be ${Math.round(CLASSIC_H * fit)} px at fit ${fit}, got ${css.h}`);
});

// ================================================================
// AC(b): small viewport — fit < 1, the stage shrinks
// ================================================================
check("small viewport: fit < 1 and the CSS stage shrinks (400x300 -> 400x250)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  g.viewport(400, 300);
  const css = g.css();
  const fit = expectedFit(400, 300); // min(400/960, 0.5) = 0.41667
  assert(fit < 1, `setup: chosen viewport must yield fit < 1, got ${fit}`);
  assert(css.w === Math.round(CLASSIC_W * fit),
    `CSS width must shrink to ${Math.round(CLASSIC_W * fit)} px, got ${css.w}`);
  assert(css.h === Math.round(CLASSIC_H * fit),
    `CSS height must shrink to ${Math.round(CLASSIC_H * fit)} px, got ${css.h}`);
  assert(css.w < CLASSIC_W && css.h < CLASSIC_H,
    `the stage must be SMALLER than native on a small viewport (got ${css.w}x${css.h})`);
});

// ================================================================
// AC(c): the CSS width/height ratio always equals GAME_W/GAME_H
// across a sweep of viewport sizes (incl. the native boundary)
// ================================================================
check("aspect sweep: the CSS ratio always equals GAME_W/GAME_H across 12 viewport sizes (no stretching)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  const aspect = CLASSIC_W / CLASSIC_H; // 16:10
  const viewports = [
    [960, 600],     // exactly native (the old cap boundary)
    [1920, 1080],   // 1.8x classic
    [2560, 1440],   // large 16:9
    [1280, 720],    // 0.75x
    [640, 400],     // exactly 2/3 native
    [300, 800],     // extreme tall-narrow (mobile portrait)
    [1000, 300],    // extreme wide-short (ultrawide strip)
    [100, 100],     // tiny square
    [777, 1023],    // odd prime-ish sizes
    [4800, 2700],   // very large 16:9
    [960, 400],     // exact-width, short
    [400, 600],     // short-wide
  ];
  for (const [vw, vh] of viewports) {
    g.viewport(vw, vh);
    const css = g.css();
    assert(Number.isInteger(css.w) && css.w > 0 && Number.isInteger(css.h) && css.h > 0,
      `viewport ${vw}x${vh}: CSS size must be positive integer px, got ${css.w}x${css.h}`);
    const relErr = Math.abs(css.w / css.h - aspect) / aspect;
    assert(relErr < 0.01,
      `viewport ${vw}x${vh}: CSS ratio ${css.w}/${css.h}=${(css.w / css.h).toFixed(4)} must stay within 1% of the stage aspect ${aspect}`);
    // Property anchor (formula-independent): the TIGHTER axis fills the
    // viewport and the looser axis fits within it. A symmetric/averaging
    // regression would leave both axes short and fail this.
    const tightWidth = vw / CLASSIC_W <= vh / CLASSIC_H;
    if (tightWidth) {
      assert(Math.abs(css.w - vw) <= 1, `viewport ${vw}x${vh}: width-binding axis must fill the viewport, css.w=${css.w} vs vw=${vw}`);
      assert(css.h <= vh + 1, `viewport ${vw}x${vh}: height must fit within the viewport, css.h=${css.h} vs vh=${vh}`);
    } else {
      assert(Math.abs(css.h - vh) <= 1, `viewport ${vw}x${vh}: height-binding axis must fill the viewport, css.h=${css.h} vs vh=${vh}`);
      assert(css.w <= vw + 1, `viewport ${vw}x${vh}: width must fit within the viewport, css.w=${css.w} vs vw=${vw}`);
    }
  }
});

check("native boundary: a viewport of exactly the stage size yields CSS 960x600 (fit == 1, no upscaling at the boundary)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  g.viewport(CLASSIC_W, CLASSIC_H);
  const css = g.css();
  assert(css.w === CLASSIC_W && css.h === CLASSIC_H,
    `at the native viewport the CSS size must be exactly ${CLASSIC_W}x${CLASSIC_H}, got ${css.w}x${css.h}`);
});

// ================================================================
// AC(d): no distortion — fit is the min of the two axes
// ================================================================
check("wide-short viewport: the HEIGHT axis binds (1920x400 -> 640x400, width fits within the viewport)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  g.viewport(1920, 400);
  const css = g.css();
  const fit = expectedFit(1920, 400); // min(2, 0.6667) — height binds
  assert(css.h === 400,
    `the tight (height) axis must fill the viewport exactly, got ${css.h}`);
  assert(css.w === Math.round(CLASSIC_W * fit),
    `the loose (width) axis must letterbox inside the viewport: ${Math.round(CLASSIC_W * fit)}, got ${css.w}`);
  assert(css.w <= 1920, `width must never exceed the viewport, got ${css.w}`);
});

check("tall-narrow viewport: the WIDTH axis binds (400x1200 -> 400x250, height fits within the viewport)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  g.viewport(400, 1200);
  const css = g.css();
  const fit = expectedFit(400, 1200); // min(0.41667, 2) — width binds
  assert(css.w === 400,
    `the tight (width) axis must fill the viewport exactly, got ${css.w}`);
  assert(css.h === Math.round(CLASSIC_H * fit),
    `the loose (height) axis must letterbox inside the viewport: ${Math.round(CLASSIC_H * fit)}, got ${css.h}`);
  assert(css.h <= 1200, `height must never exceed the viewport, got ${css.h}`);
});

// ================================================================
// Verify: the rect-based pointer mapping still lands the paddle
// centre under the cursor when the stage is upscaled
// ================================================================
check("upscaled stage: mousemove maps through getBoundingClientRect (centre cursor -> paddle centre)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  assert(g.state() === "playing", `setup: run started, state=${g.state()}`);
  g.viewport(2560, 1440);
  const css = g.css();
  // Simulate the browser re-laying-out: the canvas rect tracks the
  // CSS size, centred in the letterboxed viewport.
  const left = (2560 - css.w) / 2;
  g.canvas.rect = { left, top: (1440 - css.h) / 2, width: css.w, height: css.h };
  assert(g.canvas.rect.width > CLASSIC_W,
    `setup: the rect must reflect the upscaled CSS size, got ${g.canvas.rect.width}`);
  g.winEvent("mousemove", { clientX: left + css.w / 2 });
  assert(g.q("paddle.x") === g.q("canvas.width") / 2,
    `a cursor at the CSS centre must put the paddle at the stage centre: want ${g.q("canvas.width") / 2}, got ${g.q("paddle.x")}`);
});

check("upscaled stage: a cursor at the right CSS edge hugs the right wall (clamped, not oversteered)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  g.viewport(2560, 1440);
  const css = g.css();
  const left = (2560 - css.w) / 2;
  g.canvas.rect = { left, top: 0, width: css.w, height: css.h };
  g.winEvent("mousemove", { clientX: left + css.w });
  const half = g.q("paddleW") / 2;
  assert(g.q("paddle.x") === g.q("canvas.width") - half,
    `the right-edge cursor must clamp the paddle to the right wall: want ${g.q("canvas.width") - half}, got ${g.q("paddle.x")}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
