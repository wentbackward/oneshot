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
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
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
// stdout and stderr are kept APART: the stale-report contract asserts
// on stderr specifically (one line, no stack trace).
const run = (cwd, argv) => {
  try {
    const stdout = execFileSync(process.execPath, argv, { cwd, encoding: "utf8", stdio: "pipe" });
    return { code: 0, stdout, stderr: "", output: `${stdout}\n` };
  } catch (err) {
    const stdout = typeof err.stdout === "string" ? err.stdout : "";
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    return { code: typeof err.status === "number" ? err.status : 1, stdout, stderr, output: `${stdout}\n${stderr}` };
  }
};
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

/** Extract the single-line JSON array assigned to
 *  window.__<GAME>_ASSETS__ inside a marker-delimited block. */
function extractEmbedded(html, game) {
  const globalName = `window.__${game.toUpperCase()}_ASSETS__`;
  const beginMarker = `//__${game.toUpperCase()}_ASSETS_BEGIN__`;
  const endMarker = `//__${game.toUpperCase()}_ASSETS_END__`;
  assert(countOccurrences(html, beginMarker) === 1, `exactly one ${beginMarker} expected, got ${countOccurrences(html, beginMarker)}`);
  assert(countOccurrences(html, endMarker) === 1, `exactly one ${endMarker} expected, got ${countOccurrences(html, endMarker)}`);
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

  check(`${game}.html: the embedded payload is hash-identical to assets/${game} on disk, in stable (set, name) manifest order`, () => {
    const embedded = extractEmbedded(html, game);
    const { entries } = loadGameAssets(game);
    assert(embedded.length === entries.length,
      `payload carries ${embedded.length} entries, the manifest declares ${entries.length}`);
    const keys = embedded.map((e) => `${e.set}:${e.name}`);
    assert(JSON.stringify(keys) === JSON.stringify([...keys].sort()),
      "payload entries must be in stable sorted manifest order (set, then name)");
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      const emb = embedded[i];
      const fileBuf = readFileSync(path.join(ROOT, "assets", game, e.file));
      assert(emb.set === e.set, `payload[${i}] set ${JSON.stringify(emb.set)} ≠ manifest set ${JSON.stringify(e.set)}`);
      assert(emb.name === e.name, `payload[${i}] name ${emb.name} ≠ manifest ${e.name}`);
      assert(Buffer.from(emb.d, "base64").equals(fileBuf),
        `${e.set}/${e.name}: embedded base64 does not hash-compare to assets/${game}/${e.file}`);
      assert(emb.w === e.width && emb.h === e.height, `${e.set}/${e.name}: embedded dimensions disagree with the manifest`);
      assert(emb.frames === e.frames, `${e.set}/${e.name}: embedded frame count disagrees with the manifest`);
      assert(emb.ph === (e.placeholder ? 1 : 0), `${e.set}/${e.name}: placeholder flag did not survive the embed`);
    }
  });

  check(`${game}.html: the payload carries a set name per entry; every manifest (set, name) slot pair is present exactly once`, () => {
    const embedded = extractEmbedded(html, game);
    const { entries } = loadGameAssets(game);
    for (const e of embedded) {
      assert(typeof e.set === "string" && e.set.length > 0,
        `payload entry ${e.name} must carry a non-empty set name`);
    }
    const inPayload = new Set(embedded.map((e) => `${e.set}:${e.name}`));
    assert(inPayload.size === embedded.length, "the payload must not carry the same (set, name) pair twice");
    for (const e of entries) {
      assert(inPayload.has(`${e.set}:${e.name}`), `payload is missing the manifest slot pair ${e.set}:${e.name}`);
    }
    for (const key of inPayload) {
      const [set, name] = key.split(":");
      assert(entries.some((e) => e.set === set && e.name === name), `payload slot pair ${key} has no manifest entry`);
    }
    assert(new Set(embedded.map((e) => e.set)).size > 0, "the payload must declare at least one asset set");
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
  for (const f of ["build-fishtank.mjs", "embed-bricks-assets.mjs", "generate-placeholders.mjs"]) {
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
// Single-snapshot read: the rawBytes budget AND the serialized
// payload must come from the SAME read of every asset file. A tree
// that mutates between a first and a second read must not be able
// to split the measurement from the bytes actually embedded.
// ================================================================
check("assetPayloadJson: the rawBytes budget and the serialized payload come from ONE read per file (a concurrently mutated tree cannot split them)", () => {
  // The reader below emulates a tree mutated right after the first
  // read of each file: a second, later read of the same file returns
  // different bytes. The contract under test is WITHIN a single call:
  // whatever bytes a call measures are the bytes it embeds.
  const fixture = (tag) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), tag));
    const dir = path.join(tmp, "assets", "bricks");
    mkdirSync(dir, { recursive: true });
    const manifest = {
      game: "bricks",
      entries: [{
        name: "solo", file: "solo.png", set: "classic",
        width: 4, height: 4, frames: 1, frameWidth: 4, frameHeight: 4,
        alpha: "opaque", tiling: false, placeholder: true,
        category: "sprite", license: "CC0 (fixture)",
      }],
    };
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(path.join(dir, "solo.png"), Buffer.alloc(8, 0)); // reader below supersedes the on-disk bytes
    return { tmp, png: path.join(dir, "solo.png") };
  };
  const firstRead = Buffer.from([1, 2, 3]); // what the first read of a file sees
  const laterRead = Buffer.from([9, 9, 9, 9]); // what any later read of the same file sees
  const makeReader = (reads) => (p) => {
    const n = (reads.get(p) ?? 0) + 1;
    reads.set(p, n);
    return n === 1 ? firstRead : laterRead;
  };

  // (a) The budget: rawBytes must derive from the bytes the SAME call
  // validated and carried forward on the entries.
  {
    const { tmp, png } = fixture("assets-137-budget-");
    try {
      const reads = new Map();
      const { rawBytes, entries } = loadGameAssets("bricks", tmp, makeReader(reads));
      assert(rawBytes === entries.reduce((s, e) => s + e.bytes.length, 0),
        "rawBytes must be the sum of the very buffers carried on the entries");
      assert(entries[0].bytes.equals(firstRead), "the entry must carry the bytes of the one read");
      assert(reads.get(png) === 1, "loadGameAssets must read each asset file exactly once");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // (b) The payload: a single assetPayloadJson call must embed the
  // bytes of its one read — never the bytes of a second, later read
  // of the same file.
  {
    const { tmp, png } = fixture("assets-137-payload-");
    try {
      const reads = new Map();
      const payload = JSON.parse(assetPayloadJson("bricks", tmp, makeReader(reads)));
      assert(Buffer.from(payload[0].d, "base64").equals(firstRead),
        "the embedded base64 must be the bytes of the call's single read — not a second, later read");
      assert(reads.get(png) === 1, "assetPayloadJson must read each asset file exactly once");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

// ================================================================
// Initial embed (no marker block yet): the insertion point is the
// line AFTER the "use strict" directive. When that line has no
// terminating newline the point is ambiguous and the script must
// refuse — it must never be able to destroy the file it edits.
// ================================================================
function tmpEmbedTree() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "embed-137-init-"));
  mkdirSync(path.join(tmp, "scripts"), { recursive: true });
  cpSync(path.join(ROOT, "assets"), path.join(tmp, "assets"), { recursive: true });
  cpSync(path.join(ROOT, "scripts", "lib"), path.join(tmp, "scripts", "lib"), { recursive: true });
  copyFileSync(path.join(ROOT, "scripts", "embed-bricks-assets.mjs"), path.join(tmp, "scripts", "embed-bricks-assets.mjs"));
  return tmp;
}
const embedScript = (tmp) => path.join(tmp, "scripts", "embed-bricks-assets.mjs");

check("embed-bricks: the initial embed REFUSES (exit 1, file byte-untouched) when the \"use strict\" line lacks a terminating newline", () => {
  const tmp = tmpEmbedTree();
  try {
    // Last line of the file, no trailing newline: without a guard the
    // splice anchor lands at offset 0 and the whole file head is
    // overwritten by the payload block.
    const mangled = '<!doctype html>\n<html><head></head><body>\n<script>\n"use strict";';
    const htmlPath = path.join(tmp, "bricks.html");
    writeFileSync(htmlPath, mangled);
    const r = run(tmp, [embedScript(tmp)]);
    assert(r.code === 1, `an unterminated directive line must be refused with exit 1, got ${r.code}:\n${r.output}`);
    assert(r.stderr.length > 0, "the refusal must carry a diagnostic on stderr");
    assert(readFileSync(htmlPath, "utf8") === mangled,
      "the script must leave the file it cannot safely edit byte-for-byte untouched");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

check("embed-bricks: the initial embed on a well-formed file inserts the block directly below the directive line and stays re-checkable", () => {
  const tmp = tmpEmbedTree();
  try {
    const plain = '<!doctype html>\n<html><head></head><body>\n<script>\n"use strict";\nconst BOOT_MARKER_137 = 1;\n</script>\n</html>\n';
    const htmlPath = path.join(tmp, "bricks.html");
    writeFileSync(htmlPath, plain);
    const r = run(tmp, [embedScript(tmp)]);
    assert(r.code === 0, `the initial embed must succeed on a well-formed file, got ${r.code}:\n${r.output}`);
    const out = readFileSync(htmlPath, "utf8");
    assert(out.startsWith("<!doctype html>\n"), "the file head must survive the initial embed");
    assert(countOccurrences(out, "//__BRICKS_ASSETS_BEGIN__") === 1, "exactly one block after the initial embed");
    const strictIdx = out.indexOf('"use strict";');
    assert(out.slice(strictIdx).startsWith('"use strict";\n//__BRICKS_ASSETS_BEGIN__'),
      "the block must sit directly below the directive line");
    assert(out.includes("const BOOT_MARKER_137 = 1;"), "the pre-existing script body must survive after the inserted block");
    const c = run(tmp, [embedScript(tmp), "--check"]);
    assert(c.code === 0, `the freshly embedded file must pass --check, got ${c.code}:\n${c.output}`);
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
// Placeholder generator: every slot STILL flagged `placeholder: true`
// is a BYTE GOLDEN of scripts/generate-placeholders.mjs — regenerating
// into a fresh, pristine out dir must reproduce the committed bytes for
// the slots the generator OWNS. Slots replaced with approved final art
// (`placeholder: false`, per docs/ASSET-SOURCING.md) must instead DIFFER
// from the generator's output: the swap has to be real, not a silent
// placeholder re-commit. Sets added as final art from day one (ticket
// #143: neon / minimal) are copied file sets, not generator output —
// they must be manifest-declared slots, and are exempt from the
// byte comparison. The generator-owned manifest and LICENSE files keep
// their place in the file set but are free to evolve.
// ================================================================
const listFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
};

check("assets/: the placeholder generator is a byte golden for the slots it owns; final art provably differs from it", () => {
  const tmp = tmpTree();
  const genTmp = mkdtempSync(path.join(os.tmpdir(), "embed-137-gen-"));
  try {
    // The generator writes its full owned asset set into a PRISTINE out
    // dir — that list IS the ownership definition, independent of the
    // committed manifest (which carries more sets than the generator
    // knows about).
    const r = run(ROOT, [path.join(ROOT, "scripts", "generate-placeholders.mjs"), genTmp]);
    assert(r.code === 0, `the generator must succeed against a foreign out dir, got ${r.code}:\n${r.output}`);
    const genFiles = new Set(listFiles(path.join(genTmp, "assets")));
    const rootFiles = listFiles(path.join(ROOT, "assets"));
    const tmpFiles = listFiles(path.join(tmp, "assets"));
    // Running the generator against the COPIED tree must keep the file
    // set byte-stable (it rewrites its owned slots in place only).
    assert(JSON.stringify(rootFiles) === JSON.stringify(tmpFiles),
      `the copied tree has a different file set after in-place regeneration (${rootFiles.length} vs ${tmpFiles.length} files)`);
    // Every committed asset file is either generator-owned or a
    // manifest-declared slot — no orphan bytes may hide in the tree.
    const declared = new Set();
    for (const game of readdirSync(path.join(ROOT, "assets")).sort()) {
      const entries = JSON.parse(readFileSync(path.join(ROOT, "assets", game, "manifest.json"), "utf8"));
      for (const e of entries.entries) declared.add(`${game}/${e.file}`);
      declared.add(`${game}/manifest.json`);
      declared.add(`${game}/LICENSE.txt`);
    }
    for (const rel of rootFiles) {
      assert(genFiles.has(rel) || declared.has(rel),
        `assets/${rel} is neither generator-owned nor a manifest-declared slot`);
    }
    // Content rule, generator-owned PNGs only: placeholder-owned slots
    // must reproduce byte for byte (pins the generator AND the PNG
    // encoder); final-art slots must provably differ from it.
    const manifestByGameFile = {};
    for (const game of readdirSync(path.join(ROOT, "assets")).sort()) {
      const entries = JSON.parse(readFileSync(path.join(ROOT, "assets", game, "manifest.json"), "utf8"));
      manifestByGameFile[game] = {};
      for (const e of entries.entries) manifestByGameFile[game][e.file] = e;
    }
    for (const rel of rootFiles) {
      if (!rel.endsWith(".png") || !genFiles.has(rel)) continue;
      const [game, file] = rel.split("/");
      const committed = readFileSync(path.join(ROOT, "assets", rel));
      const regenerated = readFileSync(path.join(genTmp, "assets", rel));
      const e = manifestByGameFile[game][file];
      if (e.placeholder) {
        assert(committed.equals(regenerated),
          `placeholder assets/${rel} is not byte-identical after regeneration ` +
          `(${committed.byteLength} vs ${regenerated.byteLength} bytes)`);
      } else {
        assert(!committed.equals(regenerated),
          `final-art assets/${rel} is byte-identical to the placeholder generator output — ` +
          `the slot was not actually swapped (placeholder remains)`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(genTmp, { recursive: true, force: true });
  }
});

// ================================================================
// Corrupt asset tree: --check must map a mangled manifest onto the
// one-line `stale:` report (exit 1, stderr exactly one line, no Node
// stack trace) — pinned per script so the catch blocks the scripts
// rely on can never quietly print a raw throw again.
// ================================================================
for (const [game, script] of [
  ["bricks", "embed-bricks-assets.mjs"],
  ["fishtank", "build-fishtank.mjs"],
]) {
  check(`${game}: --check on a corrupt manifest exits 1 with a single one-line stale: report (no stack trace)`, () => {
    const tmp = tmpTree();
    try {
      // Mangle the manifest in place: the tree now violates the
      // contract (unreadable JSON), not merely drifts from the embed.
      const manifest = path.join(tmp, "assets", game, "manifest.json");
      writeFileSync(manifest, "{ oops — not the manifest anymore");
      const r = run(tmp, [path.join(tmp, "scripts", script), "--check"]);
      assert(r.code === 1, `--check must exit 1 on a corrupt manifest, got ${r.code}:\n${r.output}`);
      assert(r.stdout === "", `the stale report must not write to stdout, got: ${JSON.stringify(r.stdout)}`);
      const lines = r.stderr.trim().split("\n");
      assert(lines.length === 1, `stderr must be exactly one line, got ${lines.length}: ${JSON.stringify(r.stderr)}`);
      assert(lines[0].startsWith("stale: "), `the single stderr line must be the stale: report, got: ${JSON.stringify(lines[0])}`);
      assert(!/^\s+at /.test(r.stderr), "stderr must not carry a Node stack trace");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

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
function makeBricksEls(canvas) {
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
  return els;
}
// `decodeSpec` is true (every entry resolves), false (no decoder at
// all), or a function used as createImageBitmap as-is.
// `seedTheme` (optional) seeds the theme persistence key so a boot
// can start on a non-default theme (the loadTheme contract).
function bootBricks(decodeSpec, seedTheme) {
  const bricksHtml = readFileSync(path.join(ROOT, "bricks.html"), "utf8");
  const gameSource = bricksHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  const drawImages = [];
  const canvas = makeBricksCanvas(drawImages);
  const els = makeBricksEls(canvas);
  const fakeBitmaps = [];
  let rafCb = null;
  const decoder = typeof decodeSpec === "function"
    ? decodeSpec
    : decodeSpec
      ? (buf) => {
        const fake = { fakeBitmap: true, bytes: buf.byteLength };
        fakeBitmaps.push(fake);
        return Promise.resolve(fake);
      }
      : undefined;
  const sandbox = {
    localStorage: {
      getItem: (key) => (seedTheme !== undefined && key === "brickbreaker.theme" ? JSON.stringify(seedTheme) : null),
      setItem: () => {},
    },
    window: {
      innerWidth: 960, innerHeight: 600,
      addEventListener: () => {},
      createImageBitmap: decoder,
    },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    document: {
      getElementById: (id) => els[id] ?? null,
      createElement: (tag) => makeBricksEl(tag),
      addEventListener: () => {},
    },
    requestAnimationFrame: (cb) => { rafCb = cb; return 1; },
  };
  if (!decoder) delete sandbox.window.createImageBitmap;
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);
  return {
    context, drawImages, fakeBitmaps,
    rafRegistered: () => typeof rafCb === "function",
    tick: () => { const cb = rafCb; rafCb = null; cb(1000 / 60); },
    q: (expr) => vm.runInContext(expr, context),
  };
}

// Per-set facts of the shipped payload, for the runtime checks below.
const bricksPayload = extractEmbedded(readFileSync(path.join(ROOT, "bricks.html"), "utf8"), "bricks");
const countBricksSet = (set) => bricksPayload.filter((e) => e.set === set).length;
const bricksSetSlots = (set) => new Set(bricksPayload.filter((e) => e.set === set).map((e) => e.name));

await checkAsync("bricks runtime: boot decodes ONLY the active set's entries, and the loop starts once that set has settled", async () => {
  const seen = [];
  const g = bootBricks((buf) => { seen.push(1); return Promise.resolve({ fakeBitmap: true }); });
  // Before the microtasks flush, nothing may have started: the loop
  // is only registered once the ACTIVE set's decodes have settled.
  assert(!g.rafRegistered(), "the rAF loop must not start before the active set's decodes have settled");
  await flushMicrotasks();
  assert(g.rafRegistered(), "the loop must be registered once the active set settled");
  assert(seen.length === countBricksSet("classic"),
    `boot must decode only the default (classic) set's ${countBricksSet("classic")} entries — never every set — got ${seen.length}`);
  assert(g.q("Object.keys(ASSETS).length") === countBricksSet("classic"),
    `the active table must hold the active set's slots (${g.q("Object.keys(ASSETS).length")}/${countBricksSet("classic")})`);
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
  assert(g.fakeBitmaps.length === before, "decodes happen per set on first use only — never per frame");
});

await checkAsync("bricks runtime: a failing decoder degrades to the procedural fallback and still boots the loop", async () => {
  // A decoder that rejects for every entry: the boot must not
  // hang, the loop must run, and the background must stay the fill.
  const bricksHtml = readFileSync(path.join(ROOT, "bricks.html"), "utf8");
  const gameSource = bricksHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  const drawImages = [];
  const canvas = makeBricksCanvas(drawImages);
  const els = makeBricksEls(canvas);
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

await checkAsync("bricks runtime: onReady waits for EVERY entry OF THE ACTIVE SET to settle — a fast rejection must not start the loop while a slow decode is still pending", async () => {
  // The active set's first decode rejects immediately, every other
  // decode of the set resolves ~30ms later (and NOTHING outside the
  // set is handed to the decoder at boot). With a "first rejection
  // settles the batch" boot (e.g. Promise.all) the loop would already
  // be running while the slow entries are still pending; the per-entry
  // settle must wait for all of the set's entries.
  const nEntries = countBricksSet("classic");
  let call = 0;
  const g = bootBricks(() => {
    call += 1;
    if (call === 1) return Promise.reject(new Error("decode failure (fixture)"));
    return new Promise((resolve) => setTimeout(() => resolve({ fakeBitmap: true, slow: true }), 30));
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await sleep(10); // first entry already rejected, the rest still pending
  assert(!g.rafRegistered(), "the loop must not start while any active-set decode is still pending (batch settled on the first rejection)");
  assert(call === nEntries, `boot must hand over exactly the active set's entries (${call}/${nEntries}) — no other set may decode at boot`);
  await sleep(50); // the slow entries have resolved by now
  assert(g.rafRegistered(), "the loop must start once every active-set entry has settled");
  const cached = g.q("Object.keys(ASSETS).length");
  assert(cached === nEntries - 1,
    `the active table must hold every SUCCEEDED entry of the set (${cached}/${nEntries - 1})`);
});

await checkAsync("bricks runtime: a persisted non-default theme boots ITS set", async () => {
  for (const set of ["neon", "minimal"]) {
    const seen = [];
    const g = bootBricks((buf) => { seen.push(1); return Promise.resolve({ fakeBitmap: true }); }, set);
    await flushMicrotasks();
    assert(g.rafRegistered(), `booting on ${set} must register the rAF loop`);
    assert(seen.length === countBricksSet(set),
      `booting on ${set} must decode its ${countBricksSet(set)} entries (and no other set), got ${seen.length}`);
    assert(g.q(`Object.keys(ASSETS_BY_SET["${set}"]).length`) === countBricksSet(set),
      `${set}'s per-set table must hold its own slots`);
  }
});

await checkAsync("bricks runtime: selecting a theme decodes ITS set lazily, exactly once; repeats decode nothing; tables stay per-set", async () => {
  let calls = 0;
  const g = bootBricks((buf) => { calls += 1; return Promise.resolve({ fakeBitmap: true }); });
  await flushMicrotasks();
  assert(calls === countBricksSet("classic"), "boot decodes the classic set only");
  let baseline = calls;
  for (const set of ["neon", "minimal"]) {
    g.q(`selectTheme("${set}")`);
    await flushMicrotasks();
    assert(calls === baseline + countBricksSet(set),
      `selecting ${set} must decode its ${countBricksSet(set)} entries lazily and exactly once, got ${calls - baseline} more`);
    assert(g.q(`Object.keys(ASSETS_BY_SET["${set}"]).length`) === countBricksSet(set),
      `${set}'s table must hold exactly its own slots after the lazy decode`);
    baseline = calls;
  }
  g.q('selectTheme("neon")');
  await flushMicrotasks();
  g.q('selectTheme("classic")');
  await flushMicrotasks();
  assert(calls === baseline, "toggling between already-decoded sets must decode nothing");
  for (const set of ["classic", "neon", "minimal"]) {
    const keys = g.q(`Object.keys(ASSETS_BY_SET["${set}"])`);
    for (const k of keys) {
      assert(bricksSetSlots(set).has(k), `set ${set}'s table must not hold a foreign slot (got ${k})`);
    }
  }
});

await checkAsync("bricks runtime: a fully failing set leaves the procedural fallback AND later sets still decode (per-set isolation)", async () => {
  const failN = countBricksSet("classic");
  let calls = 0;
  const g = bootBricks((buf) => {
    calls += 1;
    return calls <= failN
      ? Promise.reject(new Error("decode failure (fixture)"))
      : Promise.resolve({ fakeBitmap: true });
  });
  await flushMicrotasks();
  assert(g.rafRegistered(), "a fully failing active set must still boot the rAF loop");
  assert(g.q("Object.keys(ASSETS).length") === 0, "no bitmap may enter the failed set's table");
  g.q('selectTheme("minimal")');
  await flushMicrotasks();
  assert(calls === failN + countBricksSet("minimal"), "the later selection must decode its own set's entries");
  assert(g.q('Object.keys(ASSETS_BY_SET["minimal"]).length') === countBricksSet("minimal"),
    "the later set's table must hold its own slots despite the failed sibling");
  g.q("draw()");
  if (countBricksSet("minimal") > 0) {
    assert(g.drawImages.some((a) => a[0]?.fakeBitmap),
      "with the decoded set active the frame must draw its bitmaps (the arena background)");
  } else {
    assert(g.drawImages.length === 0, "a set with no decoded slots must stay fully procedural (no drawImage)");
  }
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

// Regression: the gravel tiling loop (paintGravelTexture) advances x by
// the tile width; on a zero-height canvas the band — and therefore the
// step — is 0 and the loop spun forever, freezing the tab. The boot+
// tick runs in a worker so a regression fails this check on timeout
// instead of hanging the whole suite.
const ZERO_HEIGHT_WORKER = `
const { parentPort } = require("node:worker_threads");
const vm = require("node:vm");
parentPort.once("message", (source) => {
  const drawImages = [];
  // Capped: a spin regression must burn out on the parent's timeout,
  // not grow the worker's heap past its limit first.
  const recordDraw = (...args) => { if (drawImages.length < 1000) drawImages.push(args); };
  const noop = () => {};
  const canvas = { width: 0, height: 0, style: {}, getContext: () => ctx };
  const ctx = new Proxy({ canvas }, {
    get(t, prop) {
      if (prop === Symbol.toPrimitive) return undefined;
      const v = t[prop];
      if (typeof v === "function") return v;
      if (prop === "drawImage") return recordDraw;
      if (prop === "createLinearGradient" || prop === "createRadialGradient") return () => ({ addColorStop: noop });
      if (prop === "measureText") return () => ({ width: 0 });
      return noop;
    },
    set: () => true,
  });
  let rafCb = null;
  const sandbox = {
    window: {
      innerWidth: 800, innerHeight: 600, devicePixelRatio: 1,
      addEventListener: noop,
      requestAnimationFrame: (cb) => { rafCb = cb; return 1; },
    },
    document: { getElementById: (id) => (id === "game" ? canvas : null) },
    atob: (s) => require("node:buffer").Buffer.from(s, "base64").toString("binary"),
    createImageBitmap: () => Promise.resolve({ fakeBitmap: true, width: 2, height: 2 }),
  };
  vm.runInContext(source, vm.createContext(sandbox));
  setTimeout(() => {
    // The decodes must have settled and registered the loop by now.
    if (typeof rafCb !== "function") { parentPort.postMessage("no-loop"); return; }
    // Degenerate backing store AFTER boot (resize never yields 0):
    // the very next frame must still terminate.
    canvas.height = 0;
    rafCb(1000 / 60);
    setTimeout(() => { rafCb((2 * 1000) / 60); parentPort.postMessage("done"); }, 0);
  }, 0);
});
`;

await checkAsync("fishtank runtime: a zero-height frame with the gravel texture cached terminates (no infinite tiling loop)", async () => {
  const html = readFileSync(path.join(ROOT, "fishtank.html"), "utf8");
  const gameSource = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const worker = new Worker(ZERO_HEIGHT_WORKER, { eval: true });
  const outcome = await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeListener("error", onError);
      worker.removeListener("exit", onExit);
      if (!worker.terminated) worker.terminate();
      resolve(result);
    };
    const onError = (err) => finish({ kind: "error", message: err.message });
    const onExit = (code) => finish(code === 0 ? { kind: "no-result" } : { kind: "exit", code });
    const timer = setTimeout(() => finish({ kind: "timeout" }), 10000);
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.once("message", (msg) => finish({ kind: "result", msg }));
    worker.postMessage(gameSource);
  });
  assert(outcome.kind === "result" && outcome.msg === "done",
    outcome.kind === "timeout"
      ? "the zero-height frame never completed — the gravel tiling loop spun forever (tile step 0)"
      : `expected a clean two-frame boot, got ${outcome.kind}${"message" in outcome ? `: ${outcome.message}` : ""}`);
});

// ----------------------------------------------------------------
// Decode validity inside the shipped files: every embedded `d`
// payload must survive base64 → PNG decode and land on exactly the
// dimensions its own payload header declares (truncated/corrupt
// base64 or a header↔pixel mismatch would drop the slot in a
// real browser decode; the codec import doubles as the guard).
check("embedded payloads: every `d` payload round-trips base64 → PNG → the dimensions its payload header declares (decode validity inside the shipped files)", () => {
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
