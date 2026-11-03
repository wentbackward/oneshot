#!/usr/bin/env node
// ================================================================
// Unit tests — native full screen mode (ticket #114)
//
// Same harness style as tests/waves.test.mjs: runs the REAL
// <script> from asteroids.html in a sandboxed vm context with
// stubbed window/document/canvas, drives frames through the
// captured requestAnimationFrame callback, and dispatches real
// keydown events through the captured window listener.
//
// The document stub models the Fullscreen API: `requestFullscreen`
// on document and body, `exitFullscreen`, and a mutable
// `fullscreenElement` — the source of truth the game must read.
// "Unsupported API" boots omit the API entirely, mirroring a
// browser without Fullscreen support.
//
// Run: node tests/asteroids-fullscreen.test.mjs
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

// Boot a fresh copy of the game with a canvas of the given size.
// `apiMode` selects the Fullscreen API the document stub offers:
//   "full"     — supported: body.requestFullscreen / document.exitFullscreen
//   "reject"   — supported but denied: requestFullscreen/exitFullscreen
//                return REJECTED promises (permission denial path)
//   "missing"  — unsupported: neither the API nor document.body exists
function boot(width = 960, height = 600, apiMode = "full") {
  let rafCallback = null;
  const winListeners = {};
  const docListeners = {};
  const ops = []; // ordered ctx ops: { text } for fillText, { font } for ctx.font sets
  const ctxStub = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        if (prop === "fillText") return (text) => ops.push({ text: String(text) });
        return (..._args) => { /* drawing call: nothing to assert on */ };
      },
      set(_t, prop, value) {
        if (prop === "font") ops.push({ font: String(value) });
        return true;
      },
    }
  );
  const canvasStub = { width, height, getContext: () => ctxStub };

  // Fullscreen API call log: `bodyArg` keeps the ELEMENT passed to
  // body.requestFullscreen so the target assertion runs IN-CONTEXT
  // (cross-realm === would be unreliable from the host).
  const fsLog = { bodyRequests: 0, docExits: 0 };
  const bodyStub = {};
  const docStub = {
    getElementById: (id) => (id === "game" ? canvasStub : null),
    addEventListener: (type, cb) => {
      (docListeners[type] ??= []).push(cb);
    },
  };
  if (apiMode !== "missing") {
    docStub.fullscreenElement = null;
    docStub.body = bodyStub;
    docStub.requestFullscreen = () => Promise.resolve();
    docStub.exitFullscreen = () => {
      fsLog.docExits += 1;
      return Promise.resolve();
    };
    bodyStub.requestFullscreen = (...args) => {
      fsLog.bodyRequests += 1;
      fsLog.lastArgs = args;
      return apiMode === "reject"
        ? Promise.reject(new Error("permission denied"))
        : Promise.resolve();
    };
  }

  const sandbox = {
    window: {
      innerWidth: width,
      innerHeight: height,
      addEventListener: (type, cb) => {
        (winListeners[type] ??= []).push(cb);
      },
    },
    document: docStub,
    requestAnimationFrame: (cb) => {
      rafCallback = cb;
      return 1;
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);

  let nowMs = 0;
  const FRAME_MS = 1000 / 60;
  function tick(n = 1) {
    for (let i = 0; i < n; i++) {
      nowMs += FRAME_MS;
      rafCallback(nowMs);
    }
  }
  const q = (expr) => vm.runInContext(expr, context);
  function press(code, { repeat = false } = {}) {
    for (const cb of winListeners["keydown"] ?? []) cb({ code, repeat, preventDefault() {} });
  }
  function release(code) {
    for (const cb of winListeners["keyup"] ?? []) cb({ code, preventDefault() {} });
  }
  // The browser moves the virtual viewport and flips
  // document.fullscreenElement BEFORE firing fullscreenchange —
  // model that order: the caller sets the viewport + element, then
  // fires.
  function setViewport(w, h) {
    q(`window.innerWidth = ${w}; window.innerHeight = ${h}`);
  }
  function setFullscreenElement(on) {
    q(`document.fullscreenElement = ${on ? "document.body" : "null"}`);
  }
  function fireFullscreenChange() {
    for (const cb of docListeners["fullscreenchange"] ?? []) cb({});
  }

  return {
    tick,
    q,
    press,
    release,
    setViewport,
    setFullscreenElement,
    fireFullscreenChange,
    ctxTexts: () => ops.filter((o) => o.text !== undefined).map((o) => o.text),
    // The font in force for a given fillText: the nearest ctx.font
    // set immediately preceding that text in the draw order.
    fontOfText: (text) => {
      const idx = ops.findIndex((o) => o.text === text);
      if (idx === -1) return undefined; // text never drawn
      // The font in force for a line is the nearest earlier
      // ctx.font set (font persists until re-set).
      for (let j = idx - 1; j >= 0; j--) {
        if ("font" in ops[j]) return ops[j].font;
      }
      return null;
    },
    fsLog,
    fsLog,
    hasFsChangeListener: () => (docListeners["fullscreenchange"] ?? []).length > 0,
    gameState: () => q("gameState"),
    canvasSize: () => q("[canvas.width, canvas.height]"),
    liveLasers: () => q("laserPool.slots.reduce((n, s) => n + (s.active ? 1 : 0), 0)"),
    pressedKeys: () => q("keys.size"),
  };
}

// ================================================================
// Criterion: fullscreenchange listener drives resize() — entering
// full screen resizes the canvas to the (new) viewport; exiting
// resizes it back
// ================================================================
check("the game listens for fullscreenchange on document at boot", () => {
  const g = boot();
  assert(g.hasFsChangeListener(), "a fullscreenchange listener must be registered on document at boot");
});

check("entering full screen (viewport grew): resize() ran and the canvas follows the new viewport", () => {
  const g = boot(960, 600);
  assert(g.canvasSize()[0] === 960 && g.canvasSize()[1] === 600,
    "the canvas must boot at the initial 960x600 viewport");
  // The browser grows the virtual viewport when it enters full
  // screen — and does NOT necessarily fire a window "resize" event.
  g.setViewport(1280, 800);
  g.setFullscreenElement(true);
  g.fireFullscreenChange();
  const [w, h] = g.canvasSize();
  assert(w === 1280 && h === 800,
    `after fullscreenchange (element set, viewport 1280x800) the canvas must be 1280x800, got ${w}x${h}`);
});

check("exiting full screen (viewport restored): resize() ran and the canvas returns to window size", () => {
  const g = boot(960, 600);
  g.setViewport(1280, 800);
  g.setFullscreenElement(true);
  g.fireFullscreenChange(); // in
  let [w, h] = g.canvasSize();
  assert(w === 1280 && h === 800,
    `precondition: while in full screen the canvas must follow the 1280x800 viewport, got ${w}x${h}`);
  g.setViewport(960, 600);
  g.setFullscreenElement(false);
  g.fireFullscreenChange(); // out
  [w, h] = g.canvasSize();
  assert(w === 960 && h === 600,
    `after fullscreenchange (null) the canvas must return to the 960x600 window size, got ${w}x${h}`);
});

// ================================================================
// Criterion: toggleFullscreen() targets document.body, reads
// document.fullscreenElement as the source of truth, and swallows
// promise rejections (a permission denial must never throw into a
// user gesture)
// ================================================================
check("toggleFullscreen() requests full screen on document.body (element argument recorded)", () => {
  const g = boot();
  g.q("toggleFullscreen()");
  // Only document.body carries a requestFullscreen stub in this
  // sandbox, so a recorded body request proves the game targeted
  // document.body (no separate element-identity assertion possible
  // without a circular one).
  assert(g.fsLog.bodyRequests === 1, `first toggle must call document.body.requestFullscreen once, got ${g.fsLog.bodyRequests}`);
  assert(g.fsLog.lastArgs.length === 0, "requestFullscreen must be called with no options argument");
  assert(g.fsLog.docExits === 0, "the first toggle must not call exitFullscreen");
});

check("second toggle while fullscreenElement is set calls exitFullscreen (not another request)", () => {
  const g = boot();
  g.q("toggleFullscreen()"); // enter
  g.setFullscreenElement(true); // the browser flips the source of truth
  g.q("toggleFullscreen()"); // toggle back
  assert(g.fsLog.bodyRequests === 1, `only the first toggle may request full screen, got ${g.fsLog.bodyRequests} requests`);
  assert(g.fsLog.docExits === 1, `the second toggle must call document.exitFullscreen once, got ${g.fsLog.docExits}`);
});

check("a rejected requestFullscreen promise (permission denial) never throws into the gesture", () => {
  const g = boot(960, 600, "reject");
  let threw = null;
  try {
    g.q("toggleFullscreen()");
  } catch (err) {
    threw = err;
  }
  assert(threw === null, `toggleFullscreen must not surface a rejection, got: ${threw && threw.message}`);
  // The rejection is swallowed: give microtasks room to settle, then
  // confirm the game is still alive and still ticks.
  g.tick(3);
  assert(g.gameState() === "start", "the game must keep running after a denied full screen request");
});

// ================================================================
// Criterion: unsupported API — boot without requestFullscreen must
// be a silent no-op: no throw, the game boots and starts normally
// ================================================================
check("boot without the Fullscreen API: toggle is a silent no-op and the game boots and starts", () => {
  const g = boot(960, 600, "missing");
  let threw = null;
  try {
    g.q("toggleFullscreen()");
  } catch (err) {
    threw = err;
  }
  assert(threw === null, `without requestFullscreen, toggleFullscreen must be a silent no-op, got: ${threw && threw.message}`);
  g.tick(5);
  assert(g.gameState() === "start", "the game must boot to the start screen without the API");
  g.press("Enter");
  g.tick(5);
  assert(g.gameState() === "playing", "the game must start normally with Enter even without the API");
});

// ================================================================
// Criterion: the F key toggles full screen in ANY game state, is
// checked before the gameplay key path (never swallowed as input),
// and only the press EDGE counts (held-F auto-repeat is ignored)
// ================================================================
check("F keydown on the start screen toggles both ways and does NOT start the game", () => {
  const g = boot();
  g.press("KeyF");
  assert(g.fsLog.bodyRequests === 1 && g.fsLog.docExits === 0, "F on the start screen must request full screen");
  assert(g.gameState() === "start", "F must never start the game (Enter's job)");
  g.setFullscreenElement(true);
  g.press("KeyF");
  assert(g.fsLog.bodyRequests === 1 && g.fsLog.docExits === 1, "F again while full screen must exit, not re-request");
  assert(g.gameState() === "start", "the start screen must hold steady across an F round-trip");
});

check("F keydown while playing toggles both ways and F is never swallowed as a movement/fire input", () => {
  const g = boot();
  g.press("Enter");
  assert(g.gameState() === "playing", "precondition: the game is running");
  // F must not be a bound gameplay code at all:
  assert(!g.q("KEY_CODES.includes(\"KeyF\")"), "KeyF must not be part of the gameplay key set");
  g.press("KeyF");
  assert(g.fsLog.bodyRequests === 1, "F while playing must request full screen");
  assert(g.pressedKeys() === 0, `F must not be latched into the keys set (got ${g.pressedKeys()} pressed keys)`);
  assert(g.liveLasers() === 0, "F must not fire a laser");
  g.setFullscreenElement(true);
  g.press("KeyF");
  assert(g.fsLog.docExits === 1, "F again while playing and full screen must exit");
  assert(g.gameState() === "playing", "a full-screen round-trip must never interrupt play");
});

check("F keydown on the game-over screen toggles and does NOT restart the game", () => {
  const g = boot();
  g.press("Enter");
  g.q("gameState = \"gameover\""); // land on the game-over screen (F's job is unrelated to how we got here)
  g.press("KeyF");
  assert(g.fsLog.bodyRequests === 1, "F on the game-over screen must request full screen");
  assert(g.gameState() === "gameover", "F must not restart the game (Enter/R's job)");
  g.setFullscreenElement(true);
  g.press("KeyF");
  assert(g.fsLog.docExits === 1, "F again on the game-over screen must exit");
});

check("browser auto-repeat of a HELD F does not flap the toggle (only the press edge counts)", () => {
  const g = boot();
  g.press("KeyF");
  assert(g.fsLog.bodyRequests === 1, "the press edge must request full screen");
  g.press("KeyF", { repeat: true });
  g.press("KeyF", { repeat: true });
  assert(g.fsLog.bodyRequests === 1 && g.fsLog.docExits === 0,
    `held-F auto-repeat must be ignored, got ${g.fsLog.bodyRequests} requests / ${g.fsLog.docExits} exits`);
});

// ================================================================
// Criterion: the start screen lists the F key next to the controls
// (canvas-drawn, matching the existing prompt style — no new DOM)
// ================================================================
check("the start screen draws a full-screen hint naming the F key, in the same style as the other control lines", () => {
  const g = boot();
  g.tick(3); // a couple of rendered start-screen frames
  const texts = g.ctxTexts();
  const hint = texts.find((t) => /full\s*screen/i.test(t));
  assert(hint !== undefined,
    `the start screen must draw a line mentioning full screen, drew ${JSON.stringify([...new Set(texts)])}`);
  assert(/\bF\b/.test(hint), `the full-screen hint must name the F key, got "${hint}"`);
  // Style parity with the other control lines ("ARROWS / WASD  MOVE",
  // "SPACE  FIRE"): drawn in the same secondary font (UI_HUD_PX).
  const hudFont = g.q("`${UI_HUD_PX}px ${UI_FONT}`");
  assert(g.fontOfText(hint) === hudFont,
    `the full-screen hint must use the control-lines font (${hudFont}), got ${g.fontOfText(hint)}`);
  // No new DOM for the hint: the page still exposes only the canvas.
  assert(g.q("document.getElementById(\"game\") === canvas"), "the hint must be canvas-drawn (no new DOM element)");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
