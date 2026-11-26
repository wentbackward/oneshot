#!/usr/bin/env node
// ================================================================
// Unit tests — in-repo image asset integrity (ticket #137, asset
// contract in docs/DECISIONS.md): both placeholder sets under
// assets/<game>/ must decode as valid PNGs, match their manifest
// (dimensions, frame-sheet arithmetic, opacity expectations,
// placeholder flag, license line), be seamless where flagged as
// tiling, and respect the named size budgets.
//
// Decoding is a pure node:zlib PNG reader (scripts/lib/png.mjs) —
// no network, no browser, no native image libraries.
//
// Run: node tests/assets-integrity.test.mjs
// ================================================================
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { GAMES, loadGameAssets, MAX_RAW_ASSET_BYTES_PER_GAME, MAX_SHIPPED_HTML_BYTES, encodePng, decodePng } from "../scripts/lib/assets.mjs";

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

// ----------------------------------------------------------------
// Helpers: decode + edge-continuity audit for the seam check
// ----------------------------------------------------------------

function pixel(rgba, w, x, y) {
  const i = (y * w + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}
const channelDiff = (a, b) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]);

/** Max L1 distance between ANY two horizontally or vertically
 *  adjacent pixels strictly inside the tile — the grain the seam
 *  may legitimately look like. */
function maxInteriorGap(img) {
  const { width: w, height: h, rgba } = img;
  let m = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 1; x < w; x += 1) {
      m = Math.max(m, channelDiff(pixel(rgba, w, x - 1, y), pixel(rgba, w, x, y)));
    }
  }
  for (let y = 1; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      m = Math.max(m, channelDiff(pixel(rgba, w, x, y - 1), pixel(rgba, w, x, y)));
    }
  }
  return m;
}

/** A tile is seamless iff the wrap edge (column W-1 vs column 0,
 *  row H-1 vs row 0) is no sharper than the tile's own finest
 *  interior step — a hard seam would stand out against the
 *  texture it sits in. */
function seamGap(img) {
  const { width: w, height: h, rgba } = img;
  let m = 0;
  for (let y = 0; y < h; y += 1) m = Math.max(m, channelDiff(pixel(rgba, w, 0, y), pixel(rgba, w, w - 1, y)));
  for (let x = 0; x < w; x += 1) m = Math.max(m, channelDiff(pixel(rgba, w, x, 0), pixel(rgba, w, x, h - 1)));
  return m;
}

// ----------------------------------------------------------------
// Load both games up front: a broken manifest is reported once per
// game, and the per-entry checks below run against the decoded set.
// ----------------------------------------------------------------
const loaded = new Map(); // game -> { assets, images }
for (const game of GAMES) {
  try {
    const assets = loadGameAssets(game);
    const images = new Map();
    for (const entry of assets.entries) {
      // Composite key: slot names repeat ACROSS sets of one game
      // (every set ships its own "bg", "ball", ...).
      images.set(`${entry.set}:${entry.name}`, decodePng(readFileSync(path.join(assets.dir, entry.file))));
    }
    loaded.set(game, { assets, images });
  } catch (err) {
    loaded.set(game, { error: err.message });
  }
}

for (const game of GAMES) {
  const L = loaded.get(game);

  check(`manifest: ${game} entries are sorted by (set, name), unique per slot pair, and carry the full slot contract`, () => {
    assert(L && !L.error, `loading assets/${game} failed: ${L ? L.error : "missing"}`);
    const { entries } = L.assets;
    assert(entries.length > 0, `assets/${game}/manifest.json must declare at least one entry`);
    const keys = entries.map((e) => `${e.set}:${e.name}`);
    assert(JSON.stringify(keys) === JSON.stringify([...keys].sort()),
      `manifest entries must be pre-sorted by (set, name), got ${keys.join(", ")}`);
    assert(new Set(keys).size === keys.length, "duplicate (set, name) slot pairs are not allowed");
    for (const e of entries) {
      assert(typeof e.set === "string" && e.set.length > 0, `${e.name}: every entry must declare which set it belongs to`);
      assert(e.file.endsWith(".png"), `${e.set}/${e.name}: file must be a .png, got ${e.file}`);
      assert(typeof e.category === "string" && e.category.length > 0, `${e.set}/${e.name}: category is required`);
      assert(typeof e.license === "string" && e.license.length > 0, `${e.set}/${e.name}: a license/attribution line is required per asset`);
      assert(typeof e.placeholder === "boolean", `${e.set}/${e.name}: placeholder must be a boolean flag`);
    }
  });

  check(`integrity: every ${game} asset decodes as a valid PNG at its manifest dimensions`, () => {
    assert(L && !L.error, `loading assets/${game} failed: ${L ? L.error : "missing"}`);
    for (const e of L.assets.entries) {
      const img = L.images.get(`${e.set}:${e.name}`);
      assert(img, `${e.set}/${e.name}: file ${e.file} failed to decode as a PNG`);
      assert(img.width === e.width && img.height === e.height,
        `${e.set}/${e.name}: decoded ${img.width}×${img.height}, manifest declares ${e.width}×${e.height}`);
    }
  });

  check(`integrity: frame-sheet arithmetic holds for every ${game} entry (width = frameWidth × frames, height = frameHeight)`, () => {
    assert(L && !L.error, `loading assets/${game} failed: ${L ? L.error : "missing"}`);
    for (const e of L.assets.entries) {
      assert(e.width === e.frameWidth * e.frames,
        `${e.set}/${e.name}: width ${e.width} ≠ frameWidth ${e.frameWidth} × frames ${e.frames}`);
      assert(e.height === e.frameHeight,
        `${e.set}/${e.name}: height ${e.height} ≠ frameHeight ${e.frameHeight}`);
    }
  });

  check(`integrity: ${game} opacity expectations hold (opaque ⇒ fully alpha-255; alpha ⇒ a shaped bitmap with transparent regions and painted regions)`, () => {
    assert(L && !L.error, `loading assets/${game} failed: ${L ? L.error : "missing"}`);
    for (const e of L.assets.entries) {
      const img = L.images.get(`${e.set}:${e.name}`);
      let fullyOpaque = 0;
      let fullyTransparent = 0;
      let painted = 0;
      for (let i = 3; i < img.rgba.length; i += 4) {
        if (img.rgba[i] === 255) fullyOpaque += 1;
        else if (img.rgba[i] === 0) fullyTransparent += 1;
        if (img.rgba[i] > 0) painted += 1;
      }
      if (e.alpha === "opaque") {
        assert(fullyOpaque === img.width * img.height,
          `${e.set}/${e.name}: declared opaque but ${img.width * img.height - fullyOpaque} pixels are not alpha-255`);
      } else {
        assert(fullyTransparent > 0 && painted > 0,
          `${e.set}/${e.name}: declared alpha but the bitmap has no ${fullyTransparent === 0 ? "transparent" : "painted"} regions — it is not a shaped sprite`);
      }
    }
  });

  check(`integrity: ${game} tiling entries are seamless (wrap edge no sharper than the finest interior step)`, () => {
    assert(L && !L.error, `loading assets/${game} failed: ${L ? L.error : "missing"}`);
    const tiles = L.assets.entries.filter((e) => e.tiling);
    if (game === "fishtank") {
      // The ticket's fishtank starter set reserves the caustics and
      // substrate tile slots; bricks' set carries no tiles today.
      assert(tiles.length > 0, `assets/fishtank must declare at least one tiling entry (the ticket requires a tile slot)`);
    }
    for (const e of tiles) {
      const img = L.images.get(`${e.set}:${e.name}`);
      const seam = seamGap(img);
      const grain = maxInteriorGap(img);
      assert(seam <= grain,
        `${e.set}/${e.name}: wrap edge discontinuity ${seam} exceeds the largest interior step ${grain} — the tile is not seamless`);
    }
  });

  check(`budget: assets/${game} raw bytes across ALL sets are within the named ${MAX_RAW_ASSET_BYTES_PER_GAME}-byte per-game ceiling`, () => {
    assert(L && !L.error, `loading assets/${game} failed: ${L ? L.error : "missing"}`);
    const sets = [...new Set(L.assets.entries.map((e) => e.set))];
    assert(L.assets.rawBytes <= MAX_RAW_ASSET_BYTES_PER_GAME,
      `raw asset bytes across all ${sets.length} set(s) (${sets.join(", ")}) - ${L.assets.rawBytes} - exceed MAX_RAW_ASSET_BYTES_PER_GAME (${MAX_RAW_ASSET_BYTES_PER_GAME})`);
  });

  check(`attribution: assets/${game}/LICENSE.txt exists and is non-empty (the companion license/attribution file)`, () => {
    assert(L && !L.error, `loading assets/${game} failed: ${L ? L.error : "missing"}`);
    const lic = path.join(L.assets.dir, "LICENSE.txt");
    assert(existsSync(lic), `assets/${game}/LICENSE.txt is missing`);
    assert(readFileSync(lic, "utf8").trim().length > 0, `assets/${game}/LICENSE.txt must be non-empty`);
  });
}

check("seam: the seam assertion is live — a ramp tile that does not wrap trips it (seam gap > max interior gap)", () => {
  // Negative fixture for the tiling-seam check: a 4×1 horizontal ramp
  // (R = 0, 64, 128, 192). Its largest interior step is 64, but the
  // wrap edge jumps 192 → 0 (gap 192), so any honest seam test must
  // reject it. Encoded in-memory with the lib codec and decoded back,
  // this keeps the fixture a real PNG end to end — if the seam math
  // or the tiling assertion were weakened, THIS check fails.
  const w = 4;
  const h = 1;
  const rgba = new Uint8Array(w * h * 4);
  for (let x = 0; x < w; x += 1) rgba[x * 4] = x * 64; // R ramps, other channels 0
  const img = decodePng(encodePng({ width: w, height: h, rgba }));
  const seam = seamGap(img);
  const grain = maxInteriorGap(img);
  assert(seam > grain,
    `the ramp fixture must violate the seam rule (seam ${seam} > max interior ${grain}); if this fails, the tiling-seam assertion no longer rejects non-tiling tiles`);
});

check("budget: every shipped game HTML is within the named per-file size ceiling", () => {
  for (const f of ["bricks.html", "fishtank.html", "asteroids.html", "index.html"]) {
    const size = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", f)).byteLength;
    assert(size <= MAX_SHIPPED_HTML_BYTES,
      `${f} is ${size} bytes, above MAX_SHIPPED_HTML_BYTES (${MAX_SHIPPED_HTML_BYTES})`);
  }
});

check("codec: the lib PNG encoder round-trips through the lib decoder", () => {
  const w = 3;
  const h = 2;
  const rgba = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0,
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  ]);
  const decoded = decodePng(encodePng({ width: w, height: h, rgba }));
  assert(decoded.width === w && decoded.height === h, "round-trip dimensions");
  assert(Buffer.compare(Buffer.from(decoded.rgba), Buffer.from(rgba)) === 0, "round-trip pixels");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
