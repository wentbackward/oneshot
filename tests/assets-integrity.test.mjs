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
      images.set(entry.name, decodePng(readFileSync(path.join(assets.dir, entry.file))));
    }
    loaded.set(game, { assets, images });
  } catch (err) {
    loaded.set(game, { error: err.message });
  }
}

for (const game of GAMES) {
  const L = loaded.get(game);

  check(`manifest: ${game} entries are sorted by name, unique, and carry the full slot contract`, () => {
    assert(L && !L.error, `loading assets/${game} failed: ${L ? L.error : "missing"}`);
    const { entries } = L.assets;
    assert(entries.length > 0, `assets/${game}/manifest.json must declare at least one entry`);
    const names = entries.map((e) => e.name);
    assert(JSON.stringify(names) === JSON.stringify([...names].sort()),
      `manifest entries must be pre-sorted by name, got ${names.join(", ")}`);
    assert(new Set(names).size === names.length, "duplicate asset names are not allowed");
    for (const e of entries) {
      assert(e.file.endsWith(".png"), `${e.name}: file must be a .png, got ${e.file}`);
      assert(typeof e.category === "string" && e.category.length > 0, `${e.name}: category is required`);
      assert(typeof e.license === "string" && e.license.length > 0, `${e.name}: a license/attribution line is required per asset`);
      assert(typeof e.placeholder === "boolean", `${e.name}: placeholder must be a boolean flag`);
    }
  });

  check(`integrity: every ${game} asset decodes as a valid PNG at its manifest dimensions`, () => {
    assert(L && !L.error, `loading assets/${game} failed: ${L ? L.error : "missing"}`);
    for (const e of L.assets.entries) {
      const img = L.images.get(e.name);
      assert(img, `${e.name}: file ${e.file} failed to decode as a PNG`);
      assert(img.width === e.width && img.height === e.height,
        `${e.name}: decoded ${img.width}×${img.height}, manifest declares ${e.width}×${e.height}`);
    }
  });

  check(`integrity: frame-sheet arithmetic holds for every ${game} entry (width = frameWidth × frames, height = frameHeight)`, () => {
    assert(L && !L.error, `loading assets/${game} failed: ${L ? L.error : "missing"}`);
    for (const e of L.assets.entries) {
      assert(e.width === e.frameWidth * e.frames,
        `${e.name}: width ${e.width} ≠ frameWidth ${e.frameWidth} × frames ${e.frames}`);
      assert(e.height === e.frameHeight,
        `${e.name}: height ${e.height} ≠ frameHeight ${e.frameHeight}`);
    }
  });

  check(`integrity: ${game} opacity expectations hold (opaque ⇒ fully alpha-255; alpha ⇒ real transparency present)`, () => {
    assert(L && !L.error, `loading assets/${game} failed: ${L ? L.error : "missing"}`);
    for (const e of L.assets.entries) {
      const img = L.images.get(e.name);
      let opaqueCount = 0;
      let transparentCount = 0;
      for (let i = 3; i < img.rgba.length; i += 4) {
        if (img.rgba[i] === 255) opaqueCount += 1;
        else if (img.rgba[i] < 255) transparentCount += 1;
      }
      if (e.alpha === "opaque") {
        assert(opaqueCount === img.width * img.height,
          `${e.name}: declared opaque but ${img.width * img.height - opaqueCount} pixels are not alpha-255`);
      } else {
        assert(transparentCount > 0 && opaqueCount > 0,
          `${e.name}: declared alpha but the bitmap is ${transparentCount === 0 ? "fully opaque" : "fully transparent"} (no mixed alpha)`);
      }
    }
  });

  check(`integrity: ${game} tiling entries are seamless (wrap edge no sharper than the finest interior step)`, () => {
    assert(L && !L.error, `loading assets/${game} failed: ${L ? L.error : "missing"}`);
    const tiles = L.assets.entries.filter((e) => e.tiling);
    assert(tiles.length > 0, `assets/${game} must declare at least one tiling entry (the ticket requires a tile slot)`);
    for (const e of tiles) {
      const img = L.images.get(e.name);
      const seam = seamGap(img);
      const grain = maxInteriorGap(img);
      assert(seam <= grain,
        `${e.name}: wrap edge discontinuity ${seam} exceeds the largest interior step ${grain} — the tile is not seamless`);
    }
  });

  check(`budget: assets/${game} raw bytes are within the named ${MAX_RAW_ASSET_BYTES_PER_GAME}-byte per-game ceiling`, () => {
    assert(L && !L.error, `loading assets/${game} failed: ${L ? L.error : "missing"}`);
    assert(L.assets.rawBytes <= MAX_RAW_ASSET_BYTES_PER_GAME,
      `raw asset bytes ${L.assets.rawBytes} exceed MAX_RAW_ASSET_BYTES_PER_GAME (${MAX_RAW_ASSET_BYTES_PER_GAME})`);
  });

  check(`attribution: assets/${game}/LICENSE.txt exists and is non-empty (the companion license/attribution file)`, () => {
    assert(L && !L.error, `loading assets/${game} failed: ${L ? L.error : "missing"}`);
    const lic = path.join(L.assets.dir, "LICENSE.txt");
    assert(existsSync(lic), `assets/${game}/LICENSE.txt is missing`);
    assert(readFileSync(lic, "utf8").trim().length > 0, `assets/${game}/LICENSE.txt must be non-empty`);
  });
}

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
