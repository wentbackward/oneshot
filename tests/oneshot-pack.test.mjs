#!/usr/bin/env node
// ================================================================
// Unit tests — the deployable one-shot package (hub + packager)
//
// This repo doubles as its own distribution: index.html (the hub)
// and the game files in the repo root ARE the deployable artifacts.
// scripts/package-oneshot.sh bundles them under a single `oneshot/`
// folder so the demo can be dropped into any static host (e.g. a
// WordPress site) at any mount depth.
//
// Criteria covered:
//  1. The hub is a self-contained page: valid doctype, no <script>,
//     no external references (the repo-wide "one file, no deps"
//     rule), and it links BOTH games by bare relative hrefs.
//  2. Every game links back to the hub (relative `index.html`), and
//     the back link is inert: plain markup, no boot-time JS queries
//     (the vm suites boot the game files — a queried id would need
//     a stub, which is what keeps this a two-line addition).
//  3. The packager runs green: it emits dist/oneshot.zip whose
//     members are EXACTLY oneshot/{index,bricks,asteroids}.html,
//     each byte-identical to the repo copy (sha256 compared).
//  4. The archive is deterministic: two consecutive builds produce
//     byte-identical zips (pinned ZipInfo timestamps).
//
// Hermetic: no network, no wall clock; the only external process is
// python3 (std-lib zipfile), which the packager itself depends on.
// Run: node tests/oneshot-pack.test.mjs
// ================================================================
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

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
// Read the zip back via python3 (node has no built-in zip reader):
// returns [{ name, sha }] for every member.
function zipManifest(zipPath) {
  const py = `
import sys, zipfile, hashlib
zf = zipfile.ZipFile(sys.argv[1])
for i in sorted(zf.infolist(), key=lambda i: i.filename):
    print(i.filename, hashlib.sha256(zf.read(i.filename)).hexdigest())
`;
  const out = execFileSync("python3", ["-c", py, zipPath], { encoding: "utf8" });
  return out.trim().split("\n").map((ln) => {
    const [name, hex] = ln.split(" ");
    return { name, sha: hex };
  });
}

const GAMES = ["bricks.html", "asteroids.html"];

// ================================================================
// 1. The hub: self-contained, links both games relatively
// ================================================================
check("hub: doctype, pure-CSS (no <script>), zero external references", () => {
  const idx = read("index.html");
  assert(/^<!doctype html>/i.test(idx.trim()), "index.html must start with a doctype");
  assert(!/<script[\s>]/i.test(idx), "the hub must not contain any <script> — pure CSS, no JS to break");
  const ext = idx.match(/(?:src|href)\s*=\s*["'][^"']*["']/gi) || [];
  for (const ref of ext) {
    const url = /["']([^"']+)["']/.exec(ref)[1];
    assert(!/^(?:https?:)?\/\//i.test(url) && !url.startsWith("//"),
      `external reference found in the hub: ${url}`);
    assert(!/\.(css|js|png|jpg|svg|woff2?)(["'#]|$)/i.test(url),
      `asset reference found in the hub: ${url} — the hub must be one self-contained file`);
  }
});

check("hub: links BOTH games by bare relative hrefs (works at any mount depth)", () => {
  const idx = read("index.html");
  for (const game of GAMES) {
    assert(new RegExp(`href=["']${game.replace(".", "\\.")}["']`).test(idx),
      `hub must link ${game} with a bare relative href`);
  }
});

// ================================================================
// 2. Back links: inert relative markup in every game
// ================================================================
for (const game of GAMES) {
  check(`${game}: links back to the hub with a relative index.html href`, () => {
    const src = read(game);
    assert(/href=["']index\.html["']/.test(src),
      `${game} must carry the back link to index.html`);
  });
}

// ================================================================
// 3+4. The packager: exact members, byte-identical content, deterministic
// ================================================================
function buildZip() {
  execFileSync("bash", [path.join(root, "scripts/package-oneshot.sh")], { encoding: "utf8" });
  const zipPath = path.join(root, "dist", "oneshot.zip");
  assert(existsSync(zipPath), "dist/oneshot.zip must exist after running the packager");
  return zipPath;
}

check("packager: zip members are EXACTLY oneshot/{index,bricks,asteroids}.html, byte-identical to the repo", () => {
  const zipPath = buildZip();
  const manifest = zipManifest(zipPath);
  const expected = ["asteroids.html", "bricks.html", "index.html"].map((g) => "oneshot/" + g);
  const got = manifest.map((m) => m.name);
  assert(JSON.stringify(got) === JSON.stringify(expected),
    `zip members must be exactly ${expected.join(", ")} in that order, got [${got.join(", ")}]`);
  for (const m of manifest) {
    const repoFile = read(m.name.replace(/^oneshot\//, ""));
    assert(sha(repoFile) === m.sha,
      `${m.name} in the zip must be byte-identical to the repo copy`);
  }
});

check("packager: deterministic — two consecutive builds are byte-identical", () => {
  const zipPath = buildZip();
  const first = sha(readFileSync(zipPath));
  buildZip();
  const second = sha(readFileSync(zipPath));
  assert(first === second,
    `consecutive builds must produce identical archives, got ${first.slice(0, 12)} vs ${second.slice(0, 12)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
