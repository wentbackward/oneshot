#!/usr/bin/env node
// ================================================================
// Unit tests — ticket #138: the bricks placeholder art slots are
// wired into the render path and are legible per state. Boots the
// committed bricks.html in a vm sandbox with a STUBBED
// createImageBitmap that tags every decoded bitmap with its
// manifest name (byte-matched against the embedded payload), so
// every recorded drawImage is attributable to a slot. The ctx is a
// recording proxy that captures drawImage/fillRect/stroke together
// with the live globalAlpha and fillStyle at call time.
//
// Behaviours pinned (acceptance-criterion → test):
//   AC1 attract:        the start-screen frame paints the cached bg bitmap
//   AC1 live classic:   skin / paddle / ball bitmaps render in play
//   AC1 second mode:    the same slots render in an EXCITING run
//   AC1 damage states:  a 3-hp brick renders THREE distinct states
//   AC3 tier material:  the four tiers read as distinct fills, skins
//                       only on the multi-hit A/B tiers
//   AC1/AC3 power-ups:  each icon kind overlays a DISTINCT sheet frame
//   AC1 game over:      the game-over frame still paints bg + board
//   AC1 ball trail:     a launched ball wears 3 ghosts behind its
//                       velocity; a parked serve wears none
//   AC2 theme gate:     neon drops every slot to the procedural paint,
//                       classic restores the bitmaps (no stale pointers)
//   AC1/AC2 debris:     a kill bursts pooled shard sprites that expire,
//                       the pool never grows, and a fresh run drains it
//   AC2 boot-only:      60 frames of live play add ZERO re-decodes
//
// No network. Hermetic: node + vm only.
//
// Run: node tests/bricks-art.test.mjs
// ================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const BRICKS_HTML = readFileSync(path.join(ROOT, "bricks.html"), "utf8");
const GAME_SOURCE = BRICKS_HTML.match(/<script>([\s\S]*?)<\/script>/)[1];

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
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The one payload the game ships: name -> raw bytes. */
const PAYLOAD = (() => {
  const globalName = "window.__BRICKS_ASSETS__";
  const begin = BRICKS_HTML.indexOf("//__BRICKS_ASSETS_BEGIN__");
  const end = BRICKS_HTML.indexOf("//__BRICKS_ASSETS_END__");
  const line = BRICKS_HTML.slice(begin, end).split("\n").find((l) => l.startsWith(`${globalName} = `));
  if (!line) throw new Error("payload block not found");
  const entries = JSON.parse(line.slice(globalName.length + 3, -1));
  const map = new Map();
  for (const e of entries) map.set(e.name, Buffer.from(e.d, "base64"));
  return map;
})();
const PAYLOAD_NAMES = PAYLOAD.size;

// ----------------------------------------------------------------
// Recording harness
// ----------------------------------------------------------------
function makeEl() {
  const el = {
    id: "", style: {}, textContent: "", className: "", children: [], listeners: {},
    addEventListener(type, cb) { (this.listeners[type] ??= []).push(cb); },
    click() { for (const cb of this.listeners["click"] ?? []) cb({ type: "click" }); },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { el.children.splice(el.children.indexOf(c), 1); return c; },
  };
  Object.defineProperty(el, "firstChild", { get: () => (el.children.length ? el.children[0] : null) });
  return el;
}
function bootArt() {
  const events = []; // { t, args, alpha, style }
  const state = { fillStyle: "", strokeStyle: "", globalAlpha: 1 };
  const recorded = new Set(["drawImage", "fillRect", "stroke"]);
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === "symbol") return undefined;
      if (recorded.has(prop)) {
        return (...args) => events.push({ t: prop, args, alpha: state.globalAlpha, style: state.fillStyle });
      }
      return () => {};
    },
    set(_t, prop, value) { state[prop] = value; return true; },
  });
  const canvas = {
    width: 0, height: 0, style: {},
    rect: { left: 0, top: 0, width: 960, height: 600 },
    listeners: {},
    getContext: () => ctx,
    getBoundingClientRect: () => canvas.rect,
    addEventListener(type, cb) { (canvas.listeners[type] ??= []).push(cb); },
  };
  const els = { game: canvas };
  for (const id of [
    "screen-start", "btn-start", "capsule-legend",
    "difficulty-easy", "difficulty-normal", "difficulty-hard",
    "theme-classic", "theme-neon", "theme-minimal",
    "mode-classic", "mode-exciting", "mode-alleyway",
    "fastfwd-off", "fastfwd-1-5", "fastfwd-2-0", "fastfwd-3-0",
    "btn-mute", "sound-volume", "ball-speed", "ball-speed-label", "ball-speed-value",
    "screen-gameover", "btn-restart", "btn-menu", "screen-pause", "btn-resume",
    "gameover-final", "hud-score", "hud-level", "hiscore", "lives",
    "btn-reset-hiscore", "btn-fullscreen", "leaderboard-start", "leaderboard-gameover",
  ]) els[id] = makeEl();

  const decodes = [];
  const decoder = (buf) => {
    const u8 = Buffer.from(buf);
    for (const [name, bytes] of PAYLOAD) {
      if (bytes.equals(u8)) { decodes.push(name); return Promise.resolve({ bitmapName: name }); }
    }
    return Promise.reject(new Error(`stub decoder: unknown payload (${u8.length} bytes)`));
  };
  let rafCb = null;
  const sandbox = {
    localStorage: { getItem: () => null, setItem: () => {} },
    window: { innerWidth: 960, innerHeight: 600, addEventListener: () => {}, createImageBitmap: decoder },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    document: {
      getElementById: (id) => els[id] ?? null,
      createElement: (tag) => makeEl(),
      addEventListener: () => {},
    },
    requestAnimationFrame: (cb) => { rafCb = cb; return 1; },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(GAME_SOURCE, context);
  return {
    events, decodes,
    tick: (ms = 1000 / 60) => { const cb = rafCb; rafCb = cb; cb && cb(ms); },
    /** Run draw() and return ONLY this frame's recorded events. */
    frame: () => { events.length = 0; vm.runInContext("draw()", context); return events.slice(); },
    q: (expr) => vm.runInContext(expr, context),
    ready: async () => { await flush(); },
  };
}

/** Events per slot: filter by decoded bitmap name. */
const withBitmap = (frame, name) =>
  frame.filter((ev) => ev.t === "drawImage" && ev.args[0]?.bitmapName === name);

// ================================================================
// AC1 — attract screen
// ================================================================
await check("AC1: the start-screen (attract) frame paints the cached arena background bitmap", async () => {
  const g = bootArt();
  await g.ready();
  g.tick(); // first frame, gameState "start"
  assert(withBitmap(g.events, "bg").length === 1, "the attract frame must drawImage the bg bitmap exactly once");
  assert(withBitmap(g.events, "brick-skin-a").length === 0, "no brick skin may leak into the attract frame");
});

// ================================================================
// AC1/AC2 — live classic play + boot-only decodes
// ================================================================
await check("AC1/AC2: live classic play draws the brick-skin, paddle and ball slots, and 60 frames add ZERO re-decodes", async () => {
  const g = bootArt();
  await g.ready();
  assert(g.decodes.length === PAYLOAD_NAMES, `boot must decode every slot exactly once (${g.decodes.length}/${PAYLOAD_NAMES})`);
  g.q("startGame()");
  const f = g.frame();
  assert(withBitmap(f, "brick-skin-a").length > 0, "a tier-A brick must wear its material skin (level 1 opens with an A row)");
  assert(withBitmap(f, "brick-skin-b").length > 0, "a tier-B brick must wear its material skin");
  assert(withBitmap(f, "paddle").length === 1, "the paddle must draw its cached skin exactly once per frame");
  assert(withBitmap(f, "ball").length >= 1, "the parked serve ball must draw its cached sprite");
  for (let i = 0; i < 60; i += 1) g.tick();
  assert(g.decodes.length === PAYLOAD_NAMES, "sixty live frames must not decode anything — the bitmap table is boot-cached");
});

// ================================================================
// AC1 — a second mode
// ================================================================
await check("AC1: an EXCITING run (second mode) renders the same art slots live", async () => {
  const g = bootArt();
  await g.ready();
  g.q('selectMode("exciting")');
  g.q("startGame()");
  const f = g.frame();
  assert(withBitmap(f, "brick-skin-a").length > 0, "exciting play must draw the brick skins");
  assert(withBitmap(f, "paddle").length === 1, "exciting play must draw the paddle skin");
  assert(withBitmap(f, "ball").length >= 1, "exciting play must draw the ball sprite");
});

// ================================================================
// AC1/AC3 — brick damage states
// ================================================================
await check("AC1/AC3: a 3-hp brick renders THREE distinct damage states (fill stage, skin fade, one crack per hit)", async () => {
  const g = bootArt();
  await g.ready();
  g.q("startGame()");
  const idx = g.q("bricks.findIndex((b) => b.active && b.tier === 0)");
  assert(idx >= 0, "the board must carry an active tier-A brick");
  const rect = g.q(`[bricks[${idx}].x, bricks[${idx}].y]`);
  const samples = [];
  for (let d = 0; d < 3; d += 1) {
    g.events.length = 0;
    g.q(`bricks[${idx}].hp = ${3 - d}; draw();`);
    const frame = g.events;
    const skin = withBitmap(frame, "brick-skin-a").filter((ev) => ev.args[1] === rect[0] && ev.args[2] === rect[1]);
    const fill = frame.find((ev) => ev.t === "fillRect" && ev.args[0] === rect[0] && ev.args[1] === rect[1]);
    const strokes = frame.filter((ev) => ev.t === "stroke").length;
    samples.push({ d, alphas: skin.map((s) => s.alpha), fillStyle: fill?.style, cracks: strokes - 2 });
  }
  for (let i = 0; i < 3; i += 1) {
    for (let j = i + 1; j < 3; j += 1) {
      assert(samples[i].fillStyle !== samples[j].fillStyle,
        `stage ${samples[i].d} and ${samples[j].d} must use distinct fill shades (${samples[i].fillStyle})`);
      assert(Math.abs(samples[i].alphas[0] - samples[j].alphas[0]) > 1e-6,
        `stage ${samples[i].d} and ${samples[j].d} must fade the skin to distinct opacities`);
    }
  }
  assert(JSON.stringify(samples.map((s) => s.cracks)) === JSON.stringify([0, 1, 2]),
    `each hit must add exactly one crack line, got [${samples.map((s) => s.cracks)}]`);
});

// ================================================================
// AC3 — tier material legibility
// ================================================================
await check("AC3: the four tiers read as distinct materials — distinct base fills, skins only on multi-hit A/B", async () => {
  const g = bootArt();
  await g.ready();
  g.q("startGame()");
  const f = g.frame();
  const fills = [];
  for (let tier = 0; tier < 4; tier += 1) {
    const i = g.q(`bricks.findIndex((b) => b.active && b.tier === ${tier})`);
    assert(i >= 0, `level 1 must carry an active tier-${tier} brick`);
    const rect = g.q(`[bricks[${i}].x, bricks[${i}].y]`);
    const fill = f.find((ev) => ev.t === "fillRect" && ev.args[0] === rect[0] && ev.args[1] === rect[1]);
    fills.push(fill?.style);
    const skinned = f.filter((ev) => ev.t === "drawImage" && ev.args[0]?.bitmapName?.startsWith("brick-skin") && ev.args[1] === rect[0] && ev.args[2] === rect[1]);
    if (tier < 2) assert(skinned.length === 1, `tier ${tier} must wear exactly one skin bitmap`);
    else assert(skinned.length === 0, `tier ${tier} must stay a bare themed fill (no placeholder skin)`);
  }
  assert(new Set(fills).size === 4, `the four tier fills must be pairwise distinct, got ${fills}`);
});

// ================================================================
// AC1/AC3 — power-up icon legibility
// ================================================================
await check("AC1/AC3: each icon-bearing kind overlays a DISTINCT power-ups sheet frame; life/multiball stay plain capsules", async () => {
  const g = bootArt();
  await g.ready();
  g.q("startGame()");
  const seenFrames = new Set();
  for (let kind = 0; kind < 8; kind += 1) {
    g.events.length = 0;
    g.q(`capsules[0].active = true; capsules[0].kind = ${kind}; capsules[0].x = 480; capsules[0].y = 300; draw();`);
    const frame = g.events;
    const icons = withBitmap(frame, "powerups");
    const base = frame.find((ev) => ev.t === "fillRect" && ev.args[0] === 468 && ev.args[1] === 300 && ev.args[2] === 24 && ev.args[3] === 14);
    assert(base, `kind ${kind}: the themed capsule fill must still render under the icon`);
    if (kind === 3 || kind === 6) {
      assert(icons.length === 0, `kind ${kind} (no glyph in the 6-frame set) must stay a plain fill`);
    } else {
      assert(icons.length === 1, `kind ${kind} must overlay exactly one icon frame`);
      const sx = icons[0].args[1];
      assert(sx % 16 === 0 && sx >= 0 && sx < 96, `kind ${kind}: the frame origin must be a 16px-aligned sheet column, got sx=${sx}`);
      seenFrames.add(sx);
    }
  }
  assert(seenFrames.size === 6, `the six icon kinds must map to six DISTINCT frames, got ${[...seenFrames]}`);
});

// ================================================================
// AC1 — game over
// ================================================================
await check("AC1: the game-over frame still paints the background and the frozen board", async () => {
  const g = bootArt();
  await g.ready();
  g.q("startGame()");
  g.q("loseLife()"); g.q("loseLife()"); g.q("loseLife()");
  assert(g.q("gameState") === "gameover", "three lost lives must end the run");
  const f = g.frame();
  assert(withBitmap(f, "bg").length === 1, "the game-over frame must paint the arena background");
  assert(f.some((ev) => ev.t === "fillRect"), "the frozen board must still paint brick fills");
});

// ================================================================
// AC1 — ball trail
// ================================================================
await check("AC1: a launched ball wears three trail ghosts behind its velocity; a parked serve wears none", async () => {
  const g = bootArt();
  await g.ready();
  g.q("startGame()");
  assert(withBitmap(g.frame(), "ball-trail").length === 0, "an attached (parked) serve must not wear a trail");
  g.q("launchAttachedBalls()");
  g.tick();
  const trails = withBitmap(g.events, "ball-trail");
  assert(trails.length === 3, `the live ball must wear exactly three ghosts, got ${trails.length}`);
  const center = g.q("[balls[0].x, balls[0].y]");
  const dists = trails.map((ev) => {
    const cx = ev.args[1] + ev.args[3] / 2;
    const cy = ev.args[2] + ev.args[4] / 2;
    return Math.hypot(cx - center[0], cy - center[1]);
  }).sort((a, b) => a - b);
  assert(dists.every((d) => d > 0) && dists[0] < dists[1] && dists[1] < dists[2],
    `the ghosts must fan out behind the ball at increasing distances, got ${dists}`);
});

// ================================================================
// AC2 — theme gate (no stale pointers)
// ================================================================
await check("AC2: switching to neon drops EVERY slot to the procedural paint, and classic restores the bitmaps", async () => {
  const g = bootArt();
  await g.ready();
  g.q("startGame()");
  assert(withBitmap(g.frame(), "bg").length === 1, "classic must paint the bitmap background first");
  g.q('selectTheme("neon")');
  const neon = g.frame();
  assert(neon.filter((ev) => ev.t === "drawImage").length === 0,
    "neon is flat-palette: no placeholder bitmap may draw under it");
  assert(neon.some((ev) => ev.t === "fillRect"), "the neon fallback must paint the procedural fills");
  g.q('selectTheme("classic")');
  assert(withBitmap(g.frame(), "bg").length === 1, "returning to classic must restore the cached bitmaps");
});

// ================================================================
// AC1/AC2 — debris burst
// ================================================================
await check("AC1/AC2: a destroyed brick bursts pooled debris sprites that expire, the pool can never grow, and a fresh run drains it", async () => {
  const g = bootArt();
  await g.ready();
  g.q("startGame()");
  const i = g.q("bricks.findIndex((b) => b.active && !b.unbreakable)");
  g.q(`destroyBrick(${i})`);
  let f = g.frame();
  const shards1 = withBitmap(f, "debris-1").length + withBitmap(f, "debris-2").length;
  assert(shards1 >= 1 && shards1 <= 4, `one kill must burst a handful of pooled shards, got ${shards1}`);

  // Flood: 20 instant kills (80 spawn attempts) must saturate, never exceed, the pool.
  g.q(`for (let j = 0; j < 20; j += 1) { const k = bricks.findIndex((b) => b.active && !b.unbreakable); if (k >= 0) destroyBrick(k); }`);
  f = g.frame();
  const active = g.q("debris.filter((d) => d.active).length");
  const drawn = withBitmap(f, "debris-1").length + withBitmap(f, "debris-2").length;
  assert(active <= 32, `the debris pool must never hold more than its fixed 32 shards, got ${active}`);
  assert(drawn === active, "every live shard must render from the cache exactly once");

  g.q("update(0.6)"); // past the shards' lifetime
  f = g.frame();
  assert(withBitmap(f, "debris-1").length + withBitmap(f, "debris-2").length === 0, "expired shards must stop rendering");

  g.q("beginRun()");
  assert(g.q("debris.filter((d) => d.active).length") === 0, "a fresh run must drain the debris pool");
});

// ----------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
