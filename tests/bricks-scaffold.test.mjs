#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html scaffold: shell, fixed-aspect stage,
// start screen (ticket #28, ticket #39)
//
// The playfield is a fixed GAME_W×GAME_H (16:10) logical stage whose
// backing store never follows the viewport; the visible size is the
// largest 16:10 rectangle fitting the viewport (letterbox fit, capped
// at the native stage size so large monitors never upscale it),
// written as CSS px and centered by CSS.
//
// Same harness style as tests/screens.test.mjs (campaign 1): runs
// the REAL <script> from bricks.html in a sandboxed vm context with
// stubbed window/document/localStorage/requestAnimationFrame and
// DOM element stubs that record styles, text and event listeners.
// Frames are driven through the captured requestAnimationFrame
// callback. No network, no external services.
//
// Run: node tests/bricks-scaffold.test.mjs
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

// A DOM element stub: records style writes, text, listeners and
// child nodes (lives icons are appended/removed by the game).
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
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      return child;
    },
  };
  Object.defineProperty(el, "firstChild", {
    enumerable: true,
    get: () => (el.children.length > 0 ? el.children[0] : null),
  });
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

// A canvas element stub: records CSS style writes (the stage
// letterbox fit) and answers getBoundingClientRect() from a mutable
// rect object defaulting to a stage filling the boot viewport.
function makeCanvas(width, height) {
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    rect: { left: 0, top: 0, width, height },
    listeners: {},
    getContext: () => makeCtx(),
    getBoundingClientRect: () => canvas.rect,
    addEventListener(type, cb) {
      (this.listeners[type] ??= []).push(cb);
    },
    dispatch(type, ev) {
      for (const cb of this.listeners[type] ?? []) cb(ev);
    },
  };
  return canvas;
}

// Boot a fresh copy of the scaffold on a width×height viewport.
// storedHigh optionally seeds the localStorage high-score value;
// throwingStorage replaces the stub with one whose accessors throw
// (blocked / quota-exhausted storage).
function boot(width, height, storedHigh = null, throwingStorage = false) {
  const canvas = makeCanvas(width, height);
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
    "mode-alleyway": makeEl("mode-alleyway"),    "btn-mute": makeEl("btn-mute"),
    "sound-volume": makeEl("sound-volume"),
    "ball-speed": makeEl("ball-speed"),
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
    "leaderboard-start": makeEl("leaderboard-start"),
    "leaderboard-gameover": makeEl("leaderboard-gameover"),
  };
  const winListeners = {};
  let rafCb = null;
  let rafId = 0;
  const sandbox = {
    localStorage: throwingStorage
      ? {
          getItem: () => {
            throw new Error("SecurityError: access to storage denied");
          },
          setItem: () => {
            throw new Error("QuotaExceededError: storage unavailable");
          },
        }
      : {
          getItem: () => storedHigh,
          setItem: (_key, value) => {
            storedHigh = String(value);
          },
        },
    window: {
      innerWidth: width,
      innerHeight: height,
      addEventListener: (type, cb) => {
        (winListeners[type] ??= []).push(cb);
      },
    },
    document: {
      getElementById: (id) => els[id] ?? null,
      createElement: (tag) => makeEl(tag),
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
    for (let i = 0; i < n; i++) {
      nowMs += FRAME_MS;
      rafCb(nowMs);
    }
  }
  function resize() {
    for (const cb of winListeners["resize"] ?? []) cb({ type: "resize" });
  }
  const q = (expr) => vm.runInContext(expr, context);
  return {
    canvas,
    els,
    win: sandbox.window,
    q,
    tick,
    frameAt: (ms) => rafCb(ms),
    resize,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    storedHigh: () => storedHigh,
  };
}

// The fixed stage in internal canvas px, and the largest 16:10 CSS
// size (integer px) that fits a vw×vh viewport, capped at the native
// stage size (fit, never upscale) — the letterbox fit the resize pass
// must write.
const backing = (g) => ({
  width: g.q("GAME_W") * g.q("CANVAS_SCALE"),
  height: g.q("GAME_H") * g.q("CANVAS_SCALE"),
});
const fitted = (g, vw, vh) => {
  const scale = Math.min(vw / g.q("GAME_W"), vh / g.q("GAME_H"), 1);
  return {
    width: Math.round(g.q("GAME_W") * scale),
    height: Math.round(g.q("GAME_H") * scale),
  };
};

// ================================================================
// Criterion: the stage is fixed-aspect — named GAME_W/GAME_H
// constants define a 16:10 logical stage
// ================================================================
check("GAME_W and GAME_H exist as addressable globals defining a 16:10 stage (960x600)", () => {
  const g = boot(960, 600);
  const gw = g.q("typeof GAME_W === 'undefined' ? NaN : GAME_W");
  const gh = g.q("typeof GAME_H === 'undefined' ? NaN : GAME_H");
  assert(gw === 960 && gh === 600, `GAME_W/GAME_H must be 960/600, got ${gw}/${gh}`);
  assert(gw / gh === 16 / 10, `the stage aspect must be 16:10, got ${gw / gh}`);
});

// ================================================================
// Criterion: initial gameState "start", start overlay visible,
// Start CTA button present
// ================================================================
check("boot lands on gameState 'start' with the start overlay visible", () => {
  const g = boot(960, 600);
  assert(g.state() === "start", `initial gameState must be "start", got ${g.state()}`);
  assert(g.els["screen-start"].style.display === "flex",
    `the start overlay must be visible on boot, display=${JSON.stringify(g.els["screen-start"].style.display)}`);
});

check("the start screen ships a Start CTA button wired to a click handler", () => {
  const g = boot(960, 600);
  const btn = g.els["btn-start"];
  assert((btn.listeners["click"] ?? []).length === 1,
    `the Start CTA must register exactly one click handler, got ${btn.listeners["click"]?.length}`);
  // The markup itself labels the button as a Start action.
  assert(/<button\b[^>]*id="btn-start"[^>]*>\s*start[^<]*\s*<\/button>/i.test(html),
    "the <button id=btn-start> markup must carry a Start label");
});

// ================================================================
// Criterion: clicking Start -> gameState "playing", overlay hidden
// ================================================================
check("clicking the Start button switches to 'playing' and hides the overlay", () => {
  const g = boot(960, 600);
  g.tick(2);
  g.els["btn-start"].click();
  assert(g.state() === "playing", `the Start click must enter "playing", state is ${g.state()}`);
  assert(g.els["screen-start"].style.display === "none",
    `the start overlay must be hidden after Start, display=${JSON.stringify(g.els["screen-start"].style.display)}`);
  g.tick(30);
  assert(g.state() === "playing", `the game must stay in "playing" after the rAF loop runs, state is ${g.state()}`);
});

check("a second Start click during play is a no-op (cannot reset a run)", () => {
  const g = boot(960, 600);
  g.els["btn-start"].click();
  g.q("score = 7; level = 3;");
  g.els["btn-start"].click();
  assert(g.state() === "playing", `repeat Start click must not change the state, state is ${g.state()}`);
  assert(g.q("score") === 7, `repeat Start click must not reset the score, got ${g.q("score")}`);
  assert(g.q("level") === 3, `repeat Start click must not reset the level, got ${g.q("level")}`);
});

// ================================================================
// Criterion: backing store is viewport-independent — set once to
// GAME_W×CANVAS_SCALE × GAME_H×CANVAS_SCALE, never tracked
// ================================================================
check("boot sets the backing store to GAME_W×CANVAS_SCALE × GAME_H×CANVAS_SCALE at any viewport", () => {
  for (const [w, h] of [[1920, 1080], [960, 600], [375, 667]]) {
    const g = boot(w, h);
    const want = backing(g);
    assert(g.canvas.width === want.width && g.canvas.height === want.height,
      `at a ${w}x${h} viewport the canvas must be ${want.width}x${want.height}, got ${g.canvas.width}x${g.canvas.height}`);
  }
});

check("shrinking the viewport from 1920×1080 to 320×568 leaves the backing store unchanged after a frame", () => {
  const g = boot(1920, 1080);
  const store = backing(g);
  assert(g.canvas.width === store.width && g.canvas.height === store.height,
    `boot must land on ${store.width}x${store.height}, got ${g.canvas.width}x${g.canvas.height}`);
  g.win.innerWidth = 320;
  g.win.innerHeight = 568;
  g.resize();
  g.tick(1); // the deferred refit runs
  assert(g.canvas.width === store.width && g.canvas.height === store.height,
    `the backing store must stay ${store.width}x${store.height} after the resize, got ${g.canvas.width}x${g.canvas.height}`);
});

// ================================================================
// Criterion: letterboxing — the visible size is the largest 16:10
// rectangle fitting the viewport (fit, not stretch), capped at the
// native stage size, written as CSS px on the next frame after the
// resize event
// ================================================================
check("on boot the letterbox CSS size is capped at the native stage on a 1920×1080 viewport (960px × 600px)", () => {
  const g = boot(1920, 1080);
  const want = fitted(g, 1920, 1080);
  assert(want.width === 960 && want.height === 600,
    `the 1920×1080 viewport must cap the fit at the native 960×600 stage, expected ${want.width}×${want.height}`);
  assert(g.canvas.style.width === `${want.width}px` && g.canvas.style.height === `${want.height}px`,
    `the recorded CSS size must be ${want.width}px × ${want.height}px (never upscaled past native), got ${g.canvas.style.width} × ${g.canvas.style.height}`);
});

check("after shrinking to a 320×568 viewport the letterbox is 320px × 200px (tolerance 1px) and never exceeds the viewport", () => {
  const g = boot(1920, 1080);
  g.win.innerWidth = 320;
  g.win.innerHeight = 568;
  g.resize();
  g.tick(1);
  const want = fitted(g, 320, 568);
  const gotW = parseFloat(g.canvas.style.width);
  const gotH = parseFloat(g.canvas.style.height);
  assert(Math.abs(gotW - want.width) <= 1 && Math.abs(gotH - want.height) <= 1,
    `the letterbox must be ${want.width}px × ${want.height}px (±1px), got ${g.canvas.style.width} × ${g.canvas.style.height}`);
  assert(gotW <= 320 + 1e-9 && gotH <= 568 + 1e-9,
    `the stage must fit inside the 320×568 viewport, got ${gotW} × ${gotH}`);
  assert(Math.abs(gotW / gotH - 16 / 10) < 0.01,
    `the visible stage must keep the 16:10 aspect, got ${gotW / gotH}`);
});

check("a resize event updates the letterbox fit on the NEXT frame (deferred, not mid-event)", () => {
  const g = boot(1920, 1080); // capped: 960px × 600px
  assert(g.canvas.style.width === "960px" && g.canvas.style.height === "600px",
    `the capped boot fit must be 960px × 600px, got ${g.canvas.style.width} × ${g.canvas.style.height}`);
  g.win.innerWidth = 800;
  g.win.innerHeight = 500;
  g.resize();
  assert(g.canvas.style.width === "960px" && g.canvas.style.height === "600px",
    `resize must not refit mid-event (got ${g.canvas.style.width} × ${g.canvas.style.height})`);
  g.tick(1);
  const want = fitted(g, 800, 500);
  assert(g.canvas.style.width === `${want.width}px` && g.canvas.style.height === `${want.height}px`,
    `the next frame must refit to ${want.width}px × ${want.height}px, got ${g.canvas.style.width} × ${g.canvas.style.height}`);
});

check("a resize during live play updates only the letterbox fit, leaving the backing store alone", () => {
  const g = boot(960, 600);
  g.els["btn-start"].click();
  const store = backing(g);
  g.win.innerWidth = 480;
  g.win.innerHeight = 800;
  g.resize();
  g.tick(1);
  assert(g.canvas.width === store.width && g.canvas.height === store.height,
    `play-mode resize must keep the backing store at ${store.width}x${store.height}, got ${g.canvas.width}x${g.canvas.height}`);
  const want = fitted(g, 480, 800);
  assert(g.canvas.style.width === `${want.width}px` && g.canvas.style.height === `${want.height}px`,
    `play-mode resize must refit to ${want.width}px × ${want.height}px, got ${g.canvas.style.width} × ${g.canvas.style.height}`);
});

check("a burst of resize events collapses to one letterbox fit per frame", () => {
  const g = boot(1920, 1080); // capped: 960px × 600px
  g.win.innerWidth = 768;
  g.win.innerHeight = 480;
  g.resize();
  g.resize();
  g.resize();
  g.tick(1);
  const want = fitted(g, 768, 480);
  assert(g.canvas.style.width === `${want.width}px` && g.canvas.style.height === `${want.height}px`,
    `duplicate resize events must converge on ${want.width}px × ${want.height}px, got ${g.canvas.style.width} × ${g.canvas.style.height}`);
});

// ================================================================
// Criterion: during play, a resize never re-runs layoutBricks —
// the world geometry (and the serve ball) is byte-identical
// ================================================================
const FIELD_SNAPSHOT =
  "JSON.stringify({" +
  "w: canvas.width, h: canvas.height," +
  "bricks: bricks.map(function (b) { return [b.x, b.y, b.w, b.h]; })," +
  "ball: [balls[0].x, balls[0].y, balls[0].vx, balls[0].vy]}" +
  ")";

check("a resize mid-'playing' leaves every brick and the serve ball byte-identical (no layoutBricks re-run)", () => {
  const g = boot(960, 600);
  g.els["btn-start"].click(); // state 'playing': bricks laid out, ball at rest on the paddle
  const before = g.q(FIELD_SNAPSHOT);
  g.win.innerWidth = 320;
  g.win.innerHeight = 568;
  g.resize();
  g.tick(1); // the deferred pass must run — and change only the CSS size
  assert(!(g.canvas.style.width === "960px" && g.canvas.style.height === "600px"),
    `the resize must have been processed (CSS refit), style is still ${g.canvas.style.width} × ${g.canvas.style.height}`);
  const after = g.q(FIELD_SNAPSHOT);
  assert(before === after,
    `the field must be byte-identical after a mid-play resize;\n before: ${before}\n after:  ${after}`);
});

// ================================================================
// Criterion: <style> locks the body to overflow:hidden so the page
// never scrolls
// ================================================================
check("<style> sets overflow: hidden on the body so the page never scrolls", () => {
  const style = html.match(/<style>([\s\S]*?)<\/style>/);
  assert(style, "bricks.html must contain a <style> block");
  assert(/(?:html\s*,\s*)?body[^{]*\{[^}]*overflow:\s*hidden/s.test(style[1]),
    "the body rule in <style> must set overflow: hidden");
});

// ================================================================
// Criterion: named constants addressable as vm-queryable globals —
// the canvas internal-resolution scale factor and the retro font
// ================================================================
check("CANVAS_SCALE exists as an addressable global scale factor (> 0)", () => {
  const g = boot(960, 600);
  const s = g.q("typeof CANVAS_SCALE === 'undefined' ? NaN : CANVAS_SCALE");
  assert(Number.isFinite(s) && s > 0, `CANVAS_SCALE must be a positive number, got ${s}`);
});

check("UI_FONT exists as an addressable global equal to 'monospace'", () => {
  const g = boot(960, 600);
  assert(g.q("typeof UI_FONT === 'undefined' ? null : UI_FONT") === "monospace",
    `UI_FONT must be "monospace", got ${JSON.stringify(g.q("UI_FONT"))}`);
});

// ================================================================
// Review round 2: storage guards use optional catch bindings
// (no unused catch parameter)
// ================================================================
check("storage guards use bare optional catch bindings (no unused catch parameter)", () => {
  // try/catch statement bindings only: the dot guard means a Promise
  // method call (.catch(handler)) is not a catch binding and is
  // carved out (ticket #27 swallows resume() rejections this way).
  assert(!/(^|[^.\w])catch\s*\(/.test(gameSource),
    "unused catch parameters (e.g. 'catch (err)') must be bare 'catch {' bindings");
  assert(
    (gameSource.match(/catch\s*\{/g) ?? []).length >= 2,
    `both storage guards must keep their bare catch blocks, got ${(gameSource.match(/catch\s*\{/g) ?? []).length}`);
});

// ================================================================
// Review round 2: a record overtakes inside update(dt) must persist
// on the SAME frame (syncScore runs after update)
// ================================================================
check("a record overtaken inside update(dt) persists to localStorage on the same frame", () => {
  const g = boot(960, 600, "100");
  g.els["btn-start"].click();
  // Stand in for the real gameplay update: it scores past the stored
  // high score mid-frame.
  g.q("update = function (dt) { score = 250; }");
  g.tick(1);
  assert(g.q("highScore") === 250, `highScore must rise in-frame, got ${g.q("highScore")}`);
  assert(g.storedHigh() === "250",
    `the overtake made inside update must be written on the same frame, got ${JSON.stringify(g.storedHigh())}`);
});

// ================================================================
// Review round 2: dt is floored at 0 (timestamp rewind) alongside
// the existing MAX_FRAME_SECONDS clamp
// ================================================================
check("a backwards rAF timestamp yields a zeroed dt, and huge gaps stay clamped to MAX_FRAME_SECONDS", () => {
  const g = boot(960, 600);
  g.els["btn-start"].click();
  g.q("dts = []; update = function (dt) { dts.push(dt); }");
  g.frameAt(16.7);   // first frame: dt 0 (no previous timestamp)
  g.frameAt(33.4);   // nominal frame
  g.frameAt(10);     // timestamp rewind: naive dt would be negative
  g.frameAt(10_000); // giant gap: naive dt ~10 seconds
  const dts = g.q("dts.slice()");
  assert(dts.length === 4, `four frames must reach update, got ${dts.length}`);
  assert(dts.every((dt) => dt >= 0), `every dt must be >= 0 (floored), got ${JSON.stringify(dts)}`);
  assert(dts.every((dt) => dt <= g.q("MAX_FRAME_SECONDS") + 1e-9),
    `every dt must stay clamped to MAX_FRAME_SECONDS, got ${JSON.stringify(dts)}`);
  assert(dts[2] === 0, `the rewound frame must receive dt 0, got ${dts[2]}`);
  assert(g.state() === "playing", `the loop must survive the anomalies, state is ${g.state()}`);
});

// ================================================================
// Supporting: high score loads from / persists to the stubbed
// localStorage
// ================================================================
check("a stored high score loads from localStorage and shows in the HUD", () => {
  const g = boot(960, 600, "1234");
  g.tick(1);
  assert(g.q("highScore") === 1234, `highScore must load 1234, got ${g.q("highScore")}`);
  assert(g.els["hiscore"].textContent === "1234",
    `the HUD must show the high score, got ${JSON.stringify(g.els["hiscore"].textContent)}`);
});

check("a corrupt stored high score degrades to 0", () => {
  const g = boot(960, 600, "not-a-number");
  assert(g.q("highScore") === 0, `a non-numeric high score must degrade to 0, got ${g.q("highScore")}`);
});

check("a live score that beats the stored high score persists to localStorage", () => {
  const g = boot(960, 600, "100");
  g.els["btn-start"].click();
  g.q("score = 250");
  g.tick(1);
  assert(g.q("highScore") === 250, `highScore must rise to 250, got ${g.q("highScore")}`);
  assert(g.storedHigh() === "250", `localStorage must hold "250", got ${JSON.stringify(g.storedHigh())}`);
});

check("an unremarkable score does not rewrite the stored high score", () => {
  const g = boot(960, 600, "900");
  g.els["btn-start"].click();
  g.q("score = 40");
  g.tick(1);
  assert(g.q("highScore") === 900, `highScore must stay 900, got ${g.q("highScore")}`);
  assert(g.storedHigh() === "900", `localStorage must stay "900", got ${JSON.stringify(g.storedHigh())}`);
});

// ================================================================
// Supporting: a blocked localStorage (throwing accessors) never
// breaks the game
// ================================================================
check("booting with a throwing localStorage degrades to high score 0 on the start screen", () => {
  const g = boot(960, 600, null, true);
  assert(g.q("highScore") === 0, `highScore must degrade to 0, got ${g.q("highScore")}`);
  assert(g.state() === "start", `the game must still boot to "start", state is ${g.state()}`);
  assert(g.els["screen-start"].style.display === "flex",
    "the start overlay must still be visible with blocked storage");
  g.tick(2);
  assert(g.state() === "start", `the loop must keep running, state is ${g.state()}`);
});

check("a throwing setItem never crashes the loop when the live score rises", () => {
  const g = boot(960, 600, null, true);
  g.els["btn-start"].click();
  g.q("score = 300");
  g.tick(1);
  assert(g.q("highScore") === 300, `highScore must still rise in-session, got ${g.q("highScore")}`);
  assert(g.state() === "playing", `the loop must survive the write failure, state is ${g.state()}`);
  g.tick(30);
  assert(g.state() === "playing", `frames must keep flowing after the write failure, state is ${g.state()}`);
});

// ================================================================
// Supporting: the page is self-contained (mirrors the gate grep)
// ================================================================
check("the page is self-contained: no external src=/href= references", () => {
  assert(!/(src|href)=/.test(html), "bricks.html must not reference any external resource");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
