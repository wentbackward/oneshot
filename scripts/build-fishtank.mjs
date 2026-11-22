#!/usr/bin/env node
// ================================================================
// Build pipeline for fishtank.html (ticket #117).
//
// Bundles src/fishtank-main.ts (pinned esbuild, IIFE, non-minified
// so the shipped artifact stays readable) and inlines the result
// plus the page <style> into fishtank.html at the repo root.
//
// Deterministic: same sources + same pinned tool versions produce
// byte-identical output, so the committed fishtank.html IS the
// build artifact and must always be regeneratable.
//
//   node scripts/build-fishtank.mjs           -> (re)write fishtank.html
//   node scripts/build-fishtank.mjs --check   -> exit 0 iff the committed
//                                                fishtank.html is fresh
// ================================================================
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "src", "fishtank-main.ts");
const OUTPUT = path.join(ROOT, "fishtank.html");

function bundleJs() {
  const result = buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    absWorkingDir: ROOT, // path comments in the bundle stay root-relative no matter who invokes the build
    write: false,
    minify: false,
    legalComments: "none",
    logLevel: "silent",
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error("esbuild produced no output");
  return file.text;
}

const STYLE = `
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; overflow: hidden; background: #06121e; }
#game { display: block; width: 100vw; height: 100vh; }

/* Click-region note: the nav box (buttons + gaps) sits over the
   canvas in the top-left corner. In place modes a first click there
   must not plant scenery hidden behind the toolbar — the buttons
   swallow their own clicks, and Toolbar's click-region guard
   (src/ui/toolbar.ts) drops any canvas click that lands inside
   this box. Restyles that widen/narrow the box need no JS change. */
#toolbar { position: fixed; top: 10px; left: 10px; z-index: 10; display: flex; gap: 6px; font: 10px/1 monospace; letter-spacing: .15em; }
#toolbar button { color: #5a6b7d; background: rgba(5, 7, 15, .72); border: 1px solid #1c2430; border-radius: 6px; padding: 5px 9px; cursor: pointer; }
#toolbar button:hover { color: #e8f2fb; border-color: #5a6b7d; }
#toolbar button.selected { color: #7fe3ff; border-color: #3d8bb0; }
`.trim();

function renderPage(js) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fish Tank</title>
<style>
${STYLE}
</style>
</head>
<body>
<canvas id="game"></canvas>
<!-- Tank toolbar: static markup (PRD §3 tools — Drop Food, Tap
     Glass, Place/Remove), wired at boot by src/ui/toolbar.ts. The
     vm suites boot this file with a document stub; every id lookup
     is null-guarded there, so the static buttons never break a
     headless boot. -->
<nav id="toolbar" aria-label="tank tools">
<button id="tool-drop-food" type="button">DROP FOOD</button>
<button id="tool-tap-glass" type="button">TAP GLASS</button>
<button id="tool-place-rock" class="selected" type="button">PLACE ROCK</button>
<button id="tool-place-kelp" type="button">PLACE KELP</button>
<button id="tool-remove" type="button">REMOVE</button>
</nav>
<!-- One-shot hub back link: static markup only, no JS (the vm suites
     boot this file — anything queried at boot needs a stub, so keep
     it inert, matching the other cabinets). -->
<style>
  #hub-back { position: fixed; right: 10px; bottom: 10px; z-index: 10; font: 10px/1 monospace; letter-spacing: .15em; color: #5a6b7d; text-decoration: none; padding: 4px 7px; border: 1px solid #1c2430; border-radius: 6px; background: rgba(5, 7, 15, .72); }
  #hub-back:hover { color: #e8f2fb; border-color: #5a6b7d; }
</style>
<a id="hub-back" href="index.html">&larr; ONE-SHOT</a>
<script>
${js}
</script>
</body>
</html>
`;
}

const args = process.argv.slice(2);
if (args.length > 1 || (args[0] !== undefined && args[0] !== "--check")) {
  console.error("usage: node scripts/build-fishtank.mjs [--check]");
  process.exit(2);
}

const generated = renderPage(bundleJs());

if (args[0] === "--check") {
  let committed = "";
  try {
    committed = readFileSync(OUTPUT, "utf8");
  } catch {
    console.error(`stale: ${path.relative(ROOT, OUTPUT)} is missing (run: node scripts/build-fishtank.mjs)`);
    process.exit(1);
  }
  if (committed === generated) {
    console.log(`${path.relative(ROOT, OUTPUT)} is fresh (${Buffer.byteLength(generated)} bytes)`);
    process.exit(0);
  }
  console.error(`stale: ${path.relative(ROOT, OUTPUT)} differs from a fresh build of src/ (run: node scripts/build-fishtank.mjs)`);
  process.exit(1);
}

writeFileSync(OUTPUT, generated);
console.log(`wrote ${path.relative(ROOT, OUTPUT)} (${Buffer.byteLength(generated)} bytes)`);
