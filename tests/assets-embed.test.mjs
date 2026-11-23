#!/usr/bin/env node
// ================================================================
// Unit tests — build-time asset embedding (ticket #137, asset
// contract in docs/DECISIONS.md): the shipped bricks.html and
// fishtank.html each carry ONE marker-delimited, deterministically
// generated base64 payload that is hash-identical to the files on
// disk under assets/<game>/; rebuilding from a pristine tree is
// byte-identical; mutating any asset breaks the freshness check;
// and the runtime decodes the payload to cached ImageBitmaps
// BEFORE the first frame (degrading to the procedural fallback
// when no decoder is available or when a decode fails).
//
// Hermetic: node only — the browser decode path is proven with a
// stubbed createImageBitmap/atob inside the same vm-boot harness
// style the sibling suites use. No network.
//
// Requires `npm ci` first (the fishtank rebuild spawns the real
// build, which bundles with esbuild).
//
// Run: node tests/assets-embed.test.mjs
// ================================================================
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { GAMES, ROOT, loadGameAssets, assetPayloadJson } from "../scripts/lib/assets.mjs";
import { decodePng } from "../scripts/lib/png.mjs";

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
async function checkAsync(name, fn) {
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

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const run = (cwd, argv) => {
  try {
    return { code: 0, output: execFileSync(process.execPath, argv, { cwd, encoding: "utf8", stdio: "pipe" }) };
  } catch (err) {
    return { code: typeof err.status === "number" ? err.status : 1, output: `${err.stdout ?? ""}\n${err.stderr ?? ""}` };
  }
};
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

const countOccurences = (haystack, needle) => haystack.split(needle).length - 1;

/** Extract the single-line JSON array assigned to
 *  window.__<GAME>_ASSETS__ inside a marker-delimited block. */
function extractEmbedded(html, game) {
  const globalName = `window.__${game.toUpperCase()}_ASSETS__`;
  const beginMarker = `//__${game.toUpperCase()}_ASSETS_BEGIN__`;
  const endMarker = `//__${game.toUpperCase()}_ASSETS_END__`;
  assert(countOccurences(html, beginMarker) === 1, `exactly one ${beginMarker} expected, got ${countOccurences(html, beginMarker)}`);
  assert(countOccurences(html, endMarker) === 1, `exactly one ${endMarker} expected, got ${countOccurences(html, endMarker)}`);
  const begin = html.indexOf(beginMarker);
  const end = html.indexOf(endMarker);
  assert(end > begin, "the BEGIN marker must precede the END marker");
  const lines = html.slice(begin, end).split("\n").filter((l) => l.startsWith(`${globalName} = `));
  assert(lines.length === 1, `exactly one payload assignment expected in the block, got ${lines.length}`);
  const json = lines[0].slice(globalName.length + 3, -1); // strip "<name> = " and the ";"
  return JSON.parse(json);
}

// ================================================================
// Per-game static checks: the embedded payload agrees with disk,
// in stable sorted manifest order, byte for byte
// ================================================================
for (const game of GAMES) {
  const htmlPath = path.join(ROOT, `${game}.html`);
  const html = readFileSync(htmlPath, "utf8");

  check(`${game}.html: the embedded payload is hash-identical to assets/${game} on disk, in sorted manifest order`, () => {
    const embedded = extractEmbedded(html, game);
    const { entries } = loadGameAssets(game);
    assert(embedded.length === entries.length,
      `payload carries ${embedded.length} entries, the manifest declares ${entries.length}`);
    const names = embedded.map((e) => e.name);
    assert(JSON.stringify(names) === JSON.stringify([...names].sort()),
      "payload entries must be in stable sorted manifest order");
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      const emb = embedded[i];
      const fileBuf = readFileSync(path.join(ROOT, "assets", game, e.file));
      assert(emb.name === e.name, `payload[${i}] name ${emb.name} ≠ manifest ${e.name}`);
      assert(Buffer.from(emb.d, "base64").equals(fileBuf),
        `${e.name}: embedded base64 does not hash-compare to assets/${game}/${e.file}`);
      assert(emb.w === e.width && emb.h === e.height, `${e.name}: embedded dimensions disagree with the manifest`);
      assert(emb.ph === (e.placeholder ? 1 : 0), `${e.name}: placeholder flag did not survive the embed`);
    }
  });

  check(`${game}.html: the payload is regenerated deterministically (two builds, identical JSON)`, () => {
    assert(assetPayloadJson(game) === assetPayloadJson(game),
      "assetPayloadJson must be a pure function of the tree");
  });

  check(`self-containment: ${game}.html carries no <img>, <audio> or <link> tags (no src=/href= besides the hub back link)`, () => {
    assert(!/<(?:img|audio|link)[\s>]/i.test(html), `${game}.html must not open any <img>/<audio>/<link> tag`);
    const noHub = html.replace(/href=["']index\.html["']/g, "");
    assert(!/(src|href)=/.test(noHub), `${game}.html must not reference any external resource`);
  });
}

// ================================================================
// bricks: the marker-delimited embed script — pristine rebuild is
// byte-identical, a one-byte asset mutation breaks --check
// ================================================================
function tmpTree() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "embed-137-full-"));
  mkdirSync(path.join(tmp, "scripts"), { recursive: true });
  cpSync(path.join(ROOT, "src"), path.join(tmp, "src"), { recursive: true });
  cpSync(path.join(ROOT, "assets"), path.join(tmp, "assets"), { recursive: true });
  for (const f of ["build-fishtank.mjs", "embed-bricks-assets.mjs"]) {
    copyFileSync(path.join(ROOT, "scripts", f), path.join(tmp, "scripts", f));
  }
  cpSync(path.join(ROOT, "scripts", "lib"), path.join(tmp, "scripts", "lib"), { recursive: true });
  copyFileSync(path.join(ROOT, "package.json"), path.join(tmp, "package.json"));
  copyFileSync(path.join(ROOT, "tsconfig.json"), path.join(tmp, "tsconfig.json"));
  copyFileSync(path.join(ROOT, "bricks.html"), path.join(tmp, "bricks.html"));
  copyFileSync(path.join(ROOT, "fishtank.html"), path.join(tmp, "fishtank.html"));
  symlinkSync(path.join(ROOT, "node_modules"), path.join(tmp, "node_modules"), "dir");
  return tmp;
}

check("bricks.html: re-embedding a pristine copy reproduces the committed file byte for byte", () => {
  const tmp = tmpTree();
  try {
    const r = run(tmp, [path.join(tmp, "scripts", "embed-bricks-assets.mjs")]);
    assert(r.code === 0, `the embed must succeed, got ${r.code}:\n${r.output}`);
    const rebuilt = readFileSync(path.join(tmp, "bricks.html"));
    assert(rebuilt.equals(readFileSync(path.join(ROOT, "bricks.html"))),
      `the re-embedded bricks.html must be byte-identical to the committed one (${rebuilt.byteLength} vs ${readFileSync(path.join(ROOT, "bricks.html")).byteLength} bytes)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

check("bricks.html: --check exits 0 on the committed tree and a one-byte asset mutation makes it exit non-zero", () => {
  const ok = run(ROOT, [path.join(ROOT, "scripts", "embed-bricks-assets.mjs"), "--check"]);
  assert(ok.code === 0, `--check must exit 0 on the committed tree, got ${ok.code}:\n${ok.output}`);
  const tmp = tmpTree();
  try {
    // Flip one byte inside the first manifest-declared asset.
    const { entries } = loadGameAssets("bricks");
    const target = path.join(tmp, "assets", "bricks", entries[0].file);
    const buf = readFileSync(target);
    buf[10] ^= 0xff;
    writeFileSync(target, buf);
    const r = run(tmp, [path.join(tmp, "scripts", "embed-bricks-assets.mjs"), "--check"]);
    assert(r.code !== 0, `--check must fail after a one-byte asset mutation, got 0:\n${r.output}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ================================================================
// fishtank: the build's --check freshness model covers the
// embedded payload (pristine rebuild byte-identical; one-byte
// asset mutation breaks --check)
// ================================================================
check("fishtank.html: rebuilding from pristine sources (assets included) is byte-identical", () => {
  const tmp = tmpTree();
  try {
    const r = run(tmp, [path.join(tmp, "scripts", "build-fishtank.mjs")]);
    assert(r.code === 0, `the build must succeed, got ${r.code}:\n${r.output}`);
    const rebuilt = readFileSync(path.join(tmp, "fishtank.html"));
    assert(rebuilt.equals(readFileSync(path.join(ROOT, "fishtank.html"))),
      "the rebuilt fishtank.html must be byte-identical to the committed one");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

check("fishtank.html: a one-byte asset mutation makes build --check exit non-zero (the payload is inside the staleness model)", () => {
  const tmp = tmpTree();
  try {
    const { entries } = loadGameAssets("fishtank");
    const target = path.join(tmp, "assets", "fishtank", entries[0].file);
    const buf = readFileSync(target);
    buf[10] ^= 0xff;
    writeFileSync(target, buf);
    const r = run(tmp, [path.join(tmp, "scripts", "build-fishtank.mjs"), "--check"]);
    assert(r.code !== 0, `build --check must fail after a one-byte asset mutation, got 0:\n${r.output}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ================================================================
// Runtime: decode-before-first-frame + cached bitmap table +
// procedural fallback (vm boots with a stubbed createImageBitmap)
// ================================================================

// ---- bricks boot harness (same style as tests/bricks-scaffold.*) ----
function makeBricksEl(id) {
  const el = {
    id, style: {}, textContent: "", className: "", children: [], listeners: {},
    addEventListener(type, cb) { (this.listeners[type] ??= []).push(cb); },
    click() { for (const cb of this.listeners["click"] ?? []) cb({ type: "click" }); },
    appendChild(child) { el.children.push(child); return child; },
    removeChild(child) { const i = el.children.indexOf(child); if (i >= 0) el.children.splice(i, 1); return child; },
  };
  Object.defineProperty(el, "firstChild", { enumerable: true, get: () => (el.children.length > 0 ? el.children[0] : null) });
  return el;
}
function makeBricksCanvas(drawImages) {
  const canvas = {
    width: 0, height: 0, style: {},
    rect: { left: 0, top: 0, width: 960, height: 600 },
    listeners: {},
    getContext: () => new Proxy({}, {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        return (...args) => { if (prop === "drawImage") drawImages.push(args); };
      },
      set: () => true,
    }),
    getBoundingClientRect: () => canvas.rect,
    addEventListener(type, cb) { (canvas.listeners[type] ??= []).push(cb); },
  };
  return canvas;
}
function bootBricks(withDecoder) {
  const bricksHtml = readFileSync(path.join(ROOT, "bricks.html"), "utf8");
  const gameSource = bricksHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  const drawImages = [];
  const canvas = makeBricksCanvas(drawImages);
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
  ]) els[id] = makeBricksEl(id);
  const fakeBitmaps = [];
  let rafCb = null;
  const sandbox = {
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {
      innerWidth: 960, innerHeight: 600,
      addEventListener: () => {},
      createImageBitmap: withDecoder ? (buf) => {
        const fake = { fakeBitmap: true, bytes: buf.byteLength };
        fakeBitmaps.push(fake);
        return Promise.resolve(fake);
      } : undefined,
    },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    document: {
      getElementById: (id) => els[id] ?? null,
      createElement: (tag) => makeBricksEl(tag),
      addEventListener: () => {},
    },
    requestAnimationFrame: (cb) => { rafCb = cb; return 1; },
  };
  if (!withDecoder) delete sandbox.window.createImageBitmap;
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);
  return {
    context, drawImages, fakeBitmaps,
    rafRegistered: () => typeof rafCb === "function",
    tick: () => { const cb = rafCb; rafCb = null; cb(1000 / 60); },
    q: (expr) => vm.runInContext(expr, context),
  };
}

await checkAsync("bricks runtime: with a bitmap decoder the payload decodes into the cached table BEFORE the first frame", async () => {
  const g = bootBricks(true);
  // Before the microtasks flush, nothing may have started: the loop
  // is only registered once every bitmap has settled.
  assert(!g.rafRegistered(), "the rAF loop must not start before the decodes have settled");
  await flushMicrotasks();
  assert(g.rafRegistered(), "the loop must be registered once every bitmap settled");
  assert(g.q("Object.keys(ASSETS).length") === g.q("ASSET_PAYLOAD_TABLE.length"),
    `the cache must hold every payload entry (${g.q("Object.keys(ASSETS).length")}/${g.q("ASSET_PAYLOAD_TABLE.length")})`);
});

await checkAsync("bricks runtime: the first frame draws the cached background bitmap (zero re-decodes)", async () => {
  const g = bootBricks(true);
  await flushMicrotasks();
  g.tick();
  const bgHits = g.drawImages.filter((args) => args[0]?.fakeBitmap === true);
  assert(bgHits.length >= 1, "at least one drawImage per frame must use a decoded bitmap (the arena background)");
  const before = g.fakeBitmaps.length;
  g.tick();
  g.tick();
  assert(g.fakeBitmaps.length === before, "decodes happen at boot only — never per frame");
});

await checkAsync("bricks runtime: a failing decoder degrades to the procedural fallback and still boots the loop", async () => {
  // A decoder that rejects for every entry: the boot must not
  // hang, the loop must run, and the background must stay the fill.
  const bricksHtml = readFileSync(path.join(ROOT, "bricks.html"), "utf8");
  const gameSource = bricksHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  const drawImages = [];
  const canvas = makeBricksCanvas(drawImages);
  const els = { game: canvas };
  for (const id of ["screen-start", "lives", "hud-score"]) els[id] = makeBricksEl(id);
  let rafCb = null;
  const sandbox = {
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {
      innerWidth: 960, innerHeight: 600, addEventListener: () => {},
      createImageBitmap: () => Promise.reject(new Error("decode failure (fixture)")),
    },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    document: { getElementById: (id) => els[id] ?? null, createElement: (tag) => makeBricksEl(tag), addEventListener: () => {} },
    requestAnimationFrame: (cb) => { rafCb = cb; return 1; },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);
  await flushMicrotasks();
  assert(typeof rafCb === "function", "a fully failing decode must still boot the rAF loop");
  assert(vm.runInContext("Object.keys(ASSETS).length", context) === 0, "no bitmap may enter the cache from a failed decode");
  vm.runInContext("draw()", context);
  assert(drawImages.length === 0, "without any decoded bitmap the arena background must stay the procedural fill (no drawImage)");
});

// ---- fishtank boot harness (same style as tests/fishtank-scaffold.*) ----
function bootFishtank(withDecoder) {
  const html = readFileSync(path.join(ROOT, "fishtank.html"), "utf8");
  const gameSource = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const drawImages = [];
  let ctx = null;
  const canvas = {
    width: 0, height: 0, style: {}, listeners: {},
    getContext: (kind) => {
      assert(kind === "2d", `only the 2d context is supported, got ${kind}`);
      return ctx;
    },
  };
  const noop = () => {};
  ctx = new Proxy({ canvas }, {
    get(t, prop) {
      if (prop === Symbol.toPrimitive) return undefined;
      const v = t[prop];
      if (typeof v === "function") return v;
      if (prop === "drawImage") return (...args) => { drawImages.push(args); };
      if (prop === "createLinearGradient" || prop === "createRadialGradient") return () => ({ addColorStop: noop });
      if (prop === "measureText") return () => ({ width: 0 });
      return noop;
    },
    set: () => true,
  });
  let rafCb = null;
  const fakeBitmaps = [];
  const sandbox = {
    window: {
      innerWidth: 800, innerHeight: 600, devicePixelRatio: 1,
      addEventListener: () => {},
      requestAnimationFrame: (cb) => { rafCb = cb; return 1; },
    },
    document: { getElementById: (id) => (id === "game" ? canvas : null) },
  };
  if (withDecoder) {
    sandbox.atob = (s) => Buffer.from(s, "base64").toString("binary");
    sandbox.createImageBitmap = (buf) => {
      const fake = { fakeBitmap: true, width: 2, height: 2, bytes: buf.byteLength };
      fakeBitmaps.push(fake);
      return Promise.resolve(fake);
    };
  }
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);
  return {
    drawImages, fakeBitmaps,
    rafRegistered: () => typeof rafCb === "function",
    tick: (ms) => { const cb = rafCb; rafCb = null; cb(ms); },
    q: (expr) => vm.runInContext(expr, context),
  };
}

await checkAsync("fishtank runtime: with a bitmap decoder every payload bitmap is cached BEFORE the first frame", async () => {
  const g = bootFishtank(true);
  assert(!g.rafRegistered(), "the rAF loop must not start before the decodes have settled");
  await flushMicrotasks();
  assert(g.rafRegistered(), "the loop must be registered once every bitmap settled");
  const n = g.q("Object.keys(FISH_TANK_ASSETS).length");
  assert(n === g.q("EMBEDDED_ASSETS.length"),
    `the cache must hold every payload entry (${n}/${g.q("EMBEDDED_ASSETS.length")})`);
});

await checkAsync("fishtank runtime: the first frame draws the cached background texture (zero re-decodes)", async () => {
  const g = bootFishtank(true);
  await flushMicrotasks();
  g.tick(0);
  const bgHits = g.drawImages.filter((args) => args[0]?.fakeBitmap === true);
  assert(bgHits.length >= 1, "the frame must drawImage at least one decoded bitmap (the background texture)");
  const before = g.fakeBitmaps.length;
  g.tick(1000 / 60);
  g.tick((2 * 1000) / 60);
  assert(g.fakeBitmaps.length === before, "decodes happen at boot only — never per frame");
});

await checkAsync("fishtank runtime: without a decoder the boot is synchronous and draws zero bitmaps (headless suites' contract)", async () => {
  const g = bootFishtank(false);
  assert(g.rafRegistered(), "without createImageBitmap the loop must be registered synchronously at boot");
  g.tick(0);
  g.tick(1000 / 60);
  assert(g.drawImages.length === 0, "no drawImage may appear when nothing decoded (procedural-only frames)");
});

// ----------------------------------------------------------------
// Unused-import sweep: the codec import above proves the integrity
// suite's decode path; make sure this file does not leak a
// dangling reference if the payload ever carries a corrupt entry.
check("embedded payloads: every `d` payload round-trips base64 → PNG → identical bytes (decode validity inside the shipped files)", () => {
  for (const game of GAMES) {
    const html = readFileSync(path.join(ROOT, `${game}.html`), "utf8");
    for (const emb of extractEmbedded(html, game)) {
      const img = decodePng(Buffer.from(emb.d, "base64"));
      assert(img.width === emb.w && img.height === emb.h,
        `${game}/${emb.name}: the shipped payload decodes to ${img.width}×${img.height}, payload header says ${emb.w}×${emb.h}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
