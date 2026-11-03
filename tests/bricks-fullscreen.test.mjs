#!/usr/bin/env node
// ================================================================
// Unit tests — bricks.html native full screen mode (ticket #113):
// a start-screen toggle button AND the F key drive the Fullscreen
// API on document.body. The single source of truth is
// document.fullscreenElement; the "fullscreenchange" pass syncs
// the button label/state AND enqueues the existing deferred stage
// refit — fullscreen does NOT guarantee a window "resize" event,
// so the refit assertion drives the virtual viewport without ever
// firing the game's window resize listener.
//
// Harness: the REAL <script> from bricks.html runs in a sandboxed
// vm context (sibling-suite style). The document stub carries
// requestFullscreen / exitFullscreen / fullscreenElement, a
// "body" element with its own requestFullscreen, a captured
// document "fullscreenchange" listener, and a CALL LOG so every
// API hit records its target. Viewports are driven
// deterministically like the stage-fit suite. No network, no
// external services, no wall clock or sleeps.
//
// Coverage against the ticket's acceptance criteria:
//   AC(1) — toggle requests fullscreen on document.body (element
//           argument recorded)
//   AC(2) — a second toggle calls exitFullscreen while
//           fullscreenElement is set; the label follows both ways
//   AC(3) — fullscreenchange WITH an element flips the label to
//           "Exit Full Screen" and the deferred refit follows the
//           NEW virtual viewport (CSS size changes on
//           fullscreenchange alone — no resize event fired)
//   AC(4) — fullscreenchange WITH NULL flips the label back and
//           refits
//   AC(5) — KeyF keydown toggles both ways in ANY game state
//   AC(6) — boot on an UNSUPPORTED API: toggle is a silent no-op,
//           nothing throws, the game still plays
//   AC(7) — the start-screen button click also toggles both ways
//   AC(8) — a REJECTED Fullscreen API promise is swallowed and
//           never thrown into a user gesture
//   AC(9) — a HELD F (browser auto-repeat keydowns) never flaps
//           the toggle
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

const CLASSIC_W = 960;
const CLASSIC_H = 600;

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
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

// Boot a fresh copy of the game at the given (virtual) viewport
// size. opts.supportFullscreen === false strips the whole
// Fullscreen API surface from the document stub; opts.enter /
// opts.exit override the promises the API calls settle with.
function boot(viewW, viewH, opts = {}) {
  const fsLog = [];
  const canvas = {
    width: 0,
    height: 0,
    style: {},
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
    "btn-fullscreen": makeEl("btn-fullscreen"),
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
    "leaderboard-start": makeEl("leaderboard-start"),
    "capsule-legend": makeEl("capsule-legend"),
    "leaderboard-gameover": makeEl("leaderboard-gameover"),
  };
  const body = makeEl("body");
  const docListeners = {};
  const doc = {
    body,
    fullscreenElement: null, // single source of truth; tests mutate it
    addEventListener: (type, cb) => {
      (docListeners[type] ??= []).push(cb);
    },
    getElementById: (id) => els[id] ?? null,
    createElement: (tag) => makeEl(tag),
  };
  if (opts.supportFullscreen !== false) {
    const enter = opts.enter ?? (() => Promise.resolve());
    const exit = opts.exit ?? (() => Promise.resolve());
    // The game requests through document.body; the element argument
    // of the hit is recorded for the assertion.
    body.requestFullscreen = () => {
      fsLog.push({ api: "enter", element: body });
      return enter();
    };
    doc.requestFullscreen = () => Promise.resolve();
    doc.exitFullscreen = () => {
      fsLog.push({ api: "exit" });
      return exit();
    };
  }
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
    localStorage: { getItem: () => null, setItem: () => {} },
    window: win,
    document: doc,
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
  const g = {
    els,
    canvas,
    q,
    tick,
    state: () => q("typeof gameState === 'undefined' ? 'undefined' : gameState"),
    start() {
      els["btn-start"].click();
      tick(1);
    },
    winEvent(type, ev) {
      for (const cb of winListeners[type] ?? []) cb(ev);
    },
    css() {
      const parse = (v) => parseInt(v, 10);
      return { w: parse(canvas.style.width), h: parse(canvas.style.height) };
    },
    // ---- full screen plumbing (the browser's side) ----
    fsLog,
    body,
    // The browser changes fullscreenElement AFTER granting or
    // denying a call, THEN fires "fullscreenchange" on document.
    // These helpers model exactly that two-phase sequence.
    dispatchFsChange() {
      for (const cb of docListeners["fullscreenchange"] ?? []) cb({ type: "fullscreenchange" });
    },
    browserGrantsFullscreen() {
      doc.fullscreenElement = body;
      g.dispatchFsChange();
    },
    browserExitsFullscreen() {
      doc.fullscreenElement = null;
      g.dispatchFsChange();
    },
    // Move the virtual viewport WITHOUT firing the game's window
    // "resize" listener — full screen does not guarantee one.
    setViewport(w, h) {
      win.innerWidth = w;
      win.innerHeight = h;
    },
    // Keydown dispatch with a preventDefault that blows up: the
    // ticket says KeyF needs no preventDefault, so calling one
    // would fail the test instead of passing silently.
    keyF(repeat = false) {
      g.winEvent("keydown", {
        code: "KeyF",
        repeat,
        preventDefault() {
          throw new Error("KeyF must not preventDefault");
        },
      });
    },
    label() {
      return els["btn-fullscreen"].textContent;
    },
    fsClass() {
      return els["btn-fullscreen"].className;
    },
  };
  return g;
}

// The fit the game would pick for a viewport (min axis, uncapped).
function expectedFit(viewW, viewH) {
  return Math.min(viewW / CLASSIC_W, viewH / CLASSIC_H);
}

// ================================================================
// Markup: one static toggle button, its own row between the
// FAST FWD row and the leaderboard (ticket placement)
// ================================================================
await check("markup: exactly one #btn-fullscreen button, on its own row below the FAST FWD row and above the leaderboard", () => {
  const count = (html.match(/id="btn-fullscreen"/g) ?? []).length;
  assert(count === 1, `the toggle must be one static button, found ${count}`);
  const iFast = html.indexOf('class="fastfwd"');
  const iFs = html.indexOf('id="btn-fullscreen"');
  const iLb = html.indexOf('id="leaderboard-start"');
  assert(iFast !== -1 && iFs !== -1 && iLb !== -1, "anchor nodes missing");
  assert(iFast < iFs, "the row must sit BELOW the FAST FWD row");
  assert(iFs < iLb, "the row must sit ABOVE the leaderboard");
});

await check("boot: the toggle label reads 'Full Screen' before any full screen session", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  assert(g.label() === "Full Screen",
    `boot label must be "Full Screen", got ${JSON.stringify(g.label())}`);
  assert(g.q("document.fullscreenElement") === null, "setup: not fullscreen at boot");
});

// ================================================================
// AC(1): toggle requests fullscreen on document.body
// ================================================================
await check("AC(1): toggleFullscreen() requests fullscreen on document.body (element argument recorded)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.q("toggleFullscreen()");
  assert(g.fsLog.length === 1, `exactly one API call expected, got ${g.fsLog.length}`);
  assert(g.fsLog[0].api === "enter",
    `first toggle must ENTER, got ${JSON.stringify(g.fsLog[0])}`);
  assert(g.fsLog[0].element === g.body,
    "the request must target document.body");
  assert(g.label() === "Full Screen",
    "the label must NOT flip until the browser fires fullscreenchange");
});

// ================================================================
// AC(2): second toggle exits while fullscreenElement is set
// ================================================================
await check("AC(2): while fullscreenElement is set the next toggle calls exitFullscreen, and the label follows both phases", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.q("toggleFullscreen()");
  g.browserGrantsFullscreen();
  assert(g.label() === "Exit Full Screen",
    `after entering the label must read "Exit Full Screen", got ${JSON.stringify(g.label())}`);
  assert(g.fsClass() === "fs-opt active",
    `entered state must carry the active class, got ${JSON.stringify(g.fsClass())}`);
  g.q("toggleFullscreen()");
  assert(g.fsLog.length === 2, `second toggle must add exactly one call, got ${g.fsLog.length}`);
  assert(g.fsLog[1].api === "exit",
    `second toggle must EXIT while fullscreenElement is set, got ${JSON.stringify(g.fsLog[1])}`);
  g.browserExitsFullscreen();
  assert(g.label() === "Full Screen",
    `after exiting the label must flip back, got ${JSON.stringify(g.label())}`);
  assert(g.fsClass() === "fs-opt",
    `exited state must drop the active class, got ${JSON.stringify(g.fsClass())}`);
});

// ================================================================
// AC(3): fullscreenchange WITH element — label + deferred refit
// ================================================================
await check("AC(3): fullscreenchange (element set) flips the label AND the deferred refit follows the new virtual viewport with NO window resize event", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  assert(g.state() === "playing", `setup: run started, state=${g.state()}`);
  // Move the viewport first — a real full screen switch can resize
  // the window WITHOUT firing "resize" at all.
  g.setViewport(1920, 1080);
  g.tick(1);
  assert(g.css().w === CLASSIC_W && g.css().h === CLASSIC_H,
    "before the fullscreenchange the stale CSS size must hold (no stray refit)");
  g.browserGrantsFullscreen();
  g.tick(1);
  const fit = expectedFit(1920, 1080); // min(2, 1.8) = 1.8
  const css = g.css();
  assert(css.w === Math.round(CLASSIC_W * fit) && css.h === Math.round(CLASSIC_H * fit),
    `the refit must follow the new virtual viewport (want ${Math.round(CLASSIC_W * fit)}x${Math.round(CLASSIC_H * fit)}), got ${css.w}x${css.h}`);
  assert(g.label() === "Exit Full Screen", "label must flip on the fullscreenchange itself");
});

// ================================================================
// AC(4): fullscreenchange WITH null — label back + refit
// ================================================================
await check("AC(4): fullscreenchange (element null) flips the label back and refits to the new virtual viewport", () => {
  const g = boot(1920, 1080);
  g.start();
  g.q("toggleFullscreen()");
  g.browserGrantsFullscreen();
  g.setViewport(800, 500);
  g.browserExitsFullscreen();
  g.tick(1);
  const fit = expectedFit(800, 500); // min(0.8333, 0.8333)
  const css = g.css();
  assert(css.w === Math.round(CLASSIC_W * fit) && css.h === Math.round(CLASSIC_H * fit),
    `exit refit must follow the shrunken viewport (want ${Math.round(CLASSIC_W * fit)}x${Math.round(CLASSIC_H * fit)}), got ${css.w}x${css.h}`);
  assert(g.label() === "Full Screen", "label must flip back on the null fullscreenchange");
});

// ================================================================
// AC(5): KeyF toggles both ways in ANY game state
// ================================================================
await check("AC(5): KeyF enters full screen from the start screen (no preventDefault needed)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  assert(g.state() === "start", "setup: at the start screen");
  g.keyF(); // would throw inside if the game preventDefault'd
  assert(g.fsLog.length === 1 && g.fsLog[0].api === "enter",
    `KeyF at start must enter full screen, got ${JSON.stringify(g.fsLog)}`);
});

await check("AC(5): KeyF enters while playing, then exits while paused (both directions, other game states)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.start();
  g.keyF();
  assert(g.fsLog[0]?.api === "enter", "KeyF while playing must enter");
  g.browserGrantsFullscreen();
  g.winEvent("keydown", { code: "Escape" });
  assert(g.state() === "paused", `setup: paused, state=${g.state()}`);
  g.keyF();
  assert(g.fsLog.length === 2 && g.fsLog[1].api === "exit",
    `KeyF while paused AND fullscreen must exit, got ${JSON.stringify(g.fsLog)}`);
});

// ================================================================
// AC(6): unsupported API boot — silent no-op, no throw, still plays
// ================================================================
await check("AC(6): boot WITHOUT the Fullscreen API — toggle and click are silent no-ops, nothing throws, the game still plays", () => {
  const g = boot(CLASSIC_W, CLASSIC_H, { supportFullscreen: false });
  g.q("toggleFullscreen()"); // must not throw
  g.els["btn-fullscreen"].click(); // must not throw
  g.keyF(); // must not throw
  assert(g.fsLog.length === 0,
    `an unsupported browser must record NO API calls, got ${JSON.stringify(g.fsLog)}`);
  assert(g.label() === "Full Screen", "label must stay at the resting value");
  g.start();
  assert(g.state() === "playing", `setup: run started, state=${g.state()}`);
  assert(g.q("balls[0].active") === true, "the serve ball must be live");
  g.tick(30);
  assert(g.state() === "playing", "thirty frames must run without error");
});

// ================================================================
// AC(7): the button click also toggles
// ================================================================
await check("AC(7): the start-screen button click toggles both ways (enter then exit)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.els["btn-fullscreen"].click();
  assert(g.fsLog.length === 1 && g.fsLog[0].api === "enter",
    `first click must enter, got ${JSON.stringify(g.fsLog)}`);
  g.browserGrantsFullscreen();
  assert(g.label() === "Exit Full Screen", "label must follow the entered state");
  g.els["btn-fullscreen"].click();
  assert(g.fsLog.length === 2 && g.fsLog[1].api === "exit",
    `second click must exit while fullscreen, got ${JSON.stringify(g.fsLog)}`);
  g.browserExitsFullscreen();
  assert(g.label() === "Full Screen", "label must follow the exited state");
});

// ================================================================
// AC(8): a rejected promise never throws into the gesture
// ================================================================
await check("AC(8): a REJECTED requestFullscreen promise is swallowed — no throw, no crash, label untouched", async () => {
  const g = boot(CLASSIC_W, CLASSIC_H, {
    enter: () => Promise.reject(new Error("permission denied")),
  });
  g.q("toggleFullscreen()"); // synchronous: must not throw
  // Let the rejection deliver: if the game never attached .catch,
  // the unhandled rejection would take the process down here.
  await new Promise((resolve) => setImmediate(resolve));
  assert(g.label() === "Full Screen",
    "after a denial the label must stay at the resting value");
});

// ================================================================
// AC(9): held F (auto-repeat) never flaps the toggle
// ================================================================
await check("AC(9): browser auto-repeat of a HELD F does not re-toggle (only the press edge counts)", () => {
  const g = boot(CLASSIC_W, CLASSIC_H);
  g.keyF();
  g.keyF(true); // repeat
  g.keyF(true); // repeat
  assert(g.fsLog.length === 1,
    `auto-repeat must be ignored, got ${JSON.stringify(g.fsLog)}`);
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
