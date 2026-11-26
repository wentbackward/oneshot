// ================================================================
// Asset contract helpers (ticket #137; the normative contract
// lives in docs/DECISIONS.md). Shared by the placeholder
// generator, the embed scripts, the build, and the test suites:
//
//   - loadGameAssets(game): reads + VALIDATES assets/<game>/
//     manifest.json and its files. Entries come back sorted by
//     name (the stable manifest order the contract requires).
//   - assetPayloadJson(game): the deterministic single-line JSON
//     payload the games embed. Pure function of the tree: sorted
//     entries, fixed key order, reproducible base64.
//   - named size budgets (asserted by tests/assets-integrity):
//     MAX_RAW_ASSET_BYTES_PER_GAME, MAX_SHIPPED_HTML_BYTES.
// ================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root: this file lives at scripts/lib/.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Named size budgets (asset contract §4). Revisitable: raising
// them is a DECISIONS.md entry, not a silent retune.
export const MAX_RAW_ASSET_BYTES_PER_GAME = 1024 * 1024; // 1 MiB of raw assets per game
export const MAX_SHIPPED_HTML_BYTES = 1572864; // 1.5 MiB per shipped HTML file

export const GAMES = ["bricks", "fishtank"];

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const ALPHA_MODES = new Set(["opaque", "alpha"]);
const CATEGORIES = new Set(["background", "tile", "texture", "sprite", "icon-set"]);

/** Read + validate assets/<game>/. Throws a descriptive Error on
 *  ANY contract violation (bad name, missing file, dimension
 *  mismatch, missing license line, ...). Returns
 *  { dir, entries, rawBytes } with entries sorted by name; each
 *  entry ALSO carries `bytes` — the buffer of exactly the read the
 *  validation saw. Every asset file is read ONCE per call: the
 *  rawBytes budget and the payload serialization (assetPayloadJson)
 *  both derive from these same buffers, so a tree that mutates
 *  concurrently with this call cannot split the measurement from
 *  the bytes that get embedded. `readAssetFile` is injectable so
 *  the snapshot property is testable without racing a real process. */
export function loadGameAssets(game, root = ROOT, readAssetFile = readFileSync) {
  if (!GAMES.includes(game)) throw new Error(`unknown game "${game}" (expected one of ${GAMES.join(", ")})`);
  const dir = path.join(root, "assets", game);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch (err) {
    throw new Error(`assets/${game}/manifest.json is missing or unreadable: ${err.message}`);
  }
  if (manifest.game !== game) throw new Error(`manifest "game" field is ${JSON.stringify(manifest.game)}, expected "${game}"`);
  const entriesRaw = Array.isArray(manifest.entries) ? manifest.entries : null;
  if (!entriesRaw || entriesRaw.length === 0) throw new Error(`assets/${game}/manifest.json must declare a non-empty "entries" array`);

  const entries = entriesRaw.map((raw) => normalizeEntry(game, dir, raw));
  // Stable manifest order: (set, name) — set first, slot name within.
  // Slot names repeat across the game's sets (every set ships its own
  // "bg", "ball", ...); the pair is the slot's identity (ticket #143).
  entries.sort((a, b) => {
    if (a.set === b.set) return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    return a.set < b.set ? -1 : 1;
  });
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].set === entries[i - 1].set && entries[i].name === entries[i - 1].name) {
      throw new Error(`duplicate slot pair (set ${entries[i].set}, name ${entries[i].name})`);
    }
  }
  // A slot's file is claimed by exactly one slot pair: sharing it
  // would double-count the raw budget and blur the pair's identity.
  const fileOwners = new Map();
  for (const e of entries) {
    if (fileOwners.has(e.file)) {
      throw new Error(`slot file ${e.file} is claimed by more than one (set, name) slot pair`);
    }
    fileOwners.set(e.file, e);
  }
  let rawBytes = 0;
  for (const e of entries) {
    // The ONE read per file: budget and payload must agree on these
    // bytes (see the function doc).
    const bytes = readAssetFile(path.join(dir, e.file));
    e.bytes = bytes;
    rawBytes += bytes.length;
  }
  return { dir, entries, rawBytes };
}

function normalizeEntry(game, dir, raw) {
  const fail = (msg) => { throw new Error(`assets/${game}: ${msg}`); };
  if (typeof raw?.name !== "string" || !NAME_RE.test(raw.name)) fail(`entry name must match ${NAME_RE}, got ${JSON.stringify(raw?.name)}`);
  const name = raw.name;
  const field = (key) => {
    const v = raw[key];
    if (v === undefined) fail(`${name}: missing required field "${key}"`);
    return v;
  };
  const int = (key) => {
    const v = field(key);
    if (!Number.isInteger(v) || v <= 0) fail(`${name}: "${key}" must be a positive integer, got ${JSON.stringify(v)}`);
    return v;
  };
  const set = field("set");
  if (typeof set !== "string" || !NAME_RE.test(set)) fail(`${name}: "set" must match the slot naming rule, got ${JSON.stringify(set)}`);
  const file = field("file");
  if (typeof file !== "string" || !file.endsWith(".png")) fail(`${name}: "file" must be a .png path, got ${JSON.stringify(file)}`);
  const width = int("width");
  const height = int("height");
  const frames = int("frames");
  const frameWidth = int("frameWidth");
  const frameHeight = int("frameHeight");
  if (width !== frameWidth * frames) fail(`${name}: width ${width} ≠ frameWidth ${frameWidth} × frames ${frames}`);
  if (height !== frameHeight) fail(`${name}: height ${height} ≠ frameHeight ${frameHeight}`);
  const alpha = field("alpha");
  if (!ALPHA_MODES.has(alpha)) fail(`${name}: "alpha" must be "opaque" or "alpha", got ${JSON.stringify(alpha)}`);
  const tiling = field("tiling");
  if (typeof tiling !== "boolean") fail(`${name}: "tiling" must be a boolean, got ${JSON.stringify(tiling)}`);
  const placeholder = field("placeholder");
  if (typeof placeholder !== "boolean") fail(`${name}: "placeholder" must be a boolean (the swap-to-final-art flag), got ${JSON.stringify(placeholder)}`);
  const category = field("category");
  if (!CATEGORIES.has(category)) fail(`${name}: "category" must be one of ${[...CATEGORIES].join("/")}, got ${JSON.stringify(category)}`);
  const license = field("license");
  if (typeof license !== "string" || license.trim().length === 0) fail(`${name}: "license" must be a non-empty attribution line`);
  return {
    name, file, set, width, height, frames, frameWidth, frameHeight,
    alpha, tiling, placeholder, category, license,
  };
}

/** The deterministic embedded payload: one line of JSON, entries
 *  in stable (set, name) manifest order, fixed key order (se
 *  leading), base64 of the committed file bytes. Pure function
 *  of the tree — rebuilding from the same tree is byte-identical. */
export function assetPayloadJson(game, root = ROOT, readAssetFile = readFileSync) {
  const { entries } = loadGameAssets(game, root, readAssetFile);
  const items = entries.map((e) => ({
    set: e.set,
    name: e.name,
    w: e.width,
    h: e.height,
    frames: e.frames,
    ph: e.placeholder ? 1 : 0,
    // The SAME buffer loadGameAssets validated and counted toward
    // rawBytes — never a second, later read of the file.
    d: e.bytes.toString("base64"),
  }));
  // Manual serialization: JSON.stringify of an object preserves
  // insertion order, so the fixed key order above IS the wire
  // order; base64 carries no characters needing escaping.
  return JSON.stringify(items);
}

// Re-export the codec for consumers that take a single import.
export { encodePng, decodePng } from "./png.mjs";
