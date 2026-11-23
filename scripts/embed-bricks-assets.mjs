#!/usr/bin/env node
// ================================================================
// Bricks asset embedding (ticket #137, asset contract in
// docs/DECISIONS.md). Bricks has no build step — the committed
// bricks.html IS the source AND the artifact. This script is the
// minimal deterministic mechanism the ticket's option (b): it
// (re)writes the marker-delimited payload block at the top of the
// main <script> with the sorted-manifest-order base64 embed of
// assets/bricks/, and --check proves the committed block is fresh
// (the staleness/integrity twin of build-fishtank.mjs --check).
//
//   node scripts/embed-bricks-assets.mjs           -> rewrite block
//   node scripts/embed-bricks-assets.mjs --check   -> exit 0 iff fresh
//
// The block is a single-line JSON assignment (no newlines inside),
// so the gate greps and every vm-boot harness keep seeing one
// ordinary <script> — the committed file stays valid,
// self-contained and playable when opened directly.
// ================================================================
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ROOT, assetPayloadJson } from "./lib/assets.mjs";

const OUTPUT = path.join(ROOT, "bricks.html");
const GAME = "bricks";

/** The exact block the game ships between the markers. */
function blockFor(payloadJson) {
  return [
    `//__BRICKS_ASSETS_BEGIN__`,
    `// Ticket #137 asset contract: deterministic base64 embed of`,
    `// assets/bricks (sorted manifest order). Regenerate with:`,
    `//   node scripts/embed-bricks-assets.mjs`,
    `window.__BRICKS_ASSETS__ = ${payloadJson};`,
    `//__BRICKS_ASSETS_END__`,
  ].join("\n");
}

/** Locate the existing block (start..end offsets, inclusive of the
 *  marker lines). Throws when missing, duplicated or mangled. */
function locateBlock(html) {
  const beginMark = "//__BRICKS_ASSETS_BEGIN__";
  const endMark = "//__BRICKS_ASSETS_END__";
  const begin = html.indexOf(beginMark);
  const end = html.indexOf(endMark);
  if (begin === -1 || end === -1) throw new Error("marker pair is missing — bricks.html was never embedded");
  if (html.indexOf(beginMark, begin + beginMark.length) !== -1 || html.indexOf(endMark, end + endMark.length) !== -1) {
    throw new Error("duplicate markers — the payload block must appear exactly once");
  }
  const blockStart = html.lastIndexOf("\n", begin - 1) + 1; // whole line
  const blockEnd = html.indexOf("\n", end + endMark.length); // exclusive
  return { blockStart, blockEnd: blockEnd === -1 ? html.length : blockEnd };
}

const args = process.argv.slice(2);
if (args.length > 1 || (args[0] !== undefined && args[0] !== "--check")) {
  console.error("usage: node scripts/embed-bricks-assets.mjs [--check]");
  process.exit(2);
}

const html = readFileSync(OUTPUT, "utf8");
const freshBlock = blockFor(assetPayloadJson(GAME));

if (args[0] === "--check") {
  let loc;
  try {
    loc = locateBlock(html);
  } catch (err) {
    console.error(`stale: ${err.message}`);
    process.exit(1);
  }
  const committed = html.slice(loc.blockStart, loc.blockEnd).replace(/\n$/, "");
  if (committed === freshBlock) {
    console.log(`bricks.html asset block is fresh (${freshBlock.length} bytes of payload block)`);
    process.exit(0);
  }
  console.error(`stale: the committed bricks.html asset block differs from a fresh embed of assets/bricks (run: node scripts/embed-bricks-assets.mjs)`);
  process.exit(1);
}

let out;
if (html.includes("//__BRICKS_ASSETS_BEGIN__")) {
  const loc = locateBlock(html);
  // blockEnd sits on the newline that closes the block (or EOF), so
  // splicing freshBlock directly in keeps the file byte-stable.
  out = html.slice(0, loc.blockStart) + freshBlock + html.slice(loc.blockEnd);
} else {
  // First-ever embed: insert the block right after the "use strict"
  // directive, keeping the header comment above it untouched.
  const idx = html.indexOf('"use strict";');
  if (idx === -1) {
    console.error("cannot locate the \"use strict\" directive for the initial embed");
    process.exit(1);
  }
  const after = html.indexOf("\n", idx) + 1;
  out = html.slice(0, after) + freshBlock + "\n" + html.slice(after);
}
writeFileSync(OUTPUT, out);
console.log(`wrote ${path.relative(ROOT, OUTPUT)} (${Buffer.byteLength(out)} bytes, asset block ${freshBlock.length} bytes)`);
