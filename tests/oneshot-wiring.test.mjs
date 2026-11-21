#!/usr/bin/env node
// ================================================================
// Unit tests — fishtank wired into the shipped surface (ticket #118)
//
// The deployable root files are pinned in four places that must
// agree with each other, and the deploy workflow must run the same
// TypeScript/build contracts as the local dev-loop gate:
//
//   1. Dockerfile — the single COPY line ships all four root files.
//   2. .devloop.json — the gate's Dockerfile grep pins the EXACT
//      COPY line, and the hub gate check links all three games.
//   3. scripts/package-oneshot.sh — the FILES array is exactly the
//      four root artifacts (no more, no fewer).
//   4. .github/workflows/deploy.yml — Node.js 24 (native erasable-
//      TypeScript imports), npm ci, npm run typecheck and
//      `node scripts/build-fishtank.mjs --check` all run BEFORE
//      the full suite loop, so a clean GitHub Actions runner
//      installs and checks the pinned toolchain before any test
//      executes.
//   5. Docs — the README products table and the AGENTS.md
//      distribution section list fishtank.html alongside the
//      other root deployables.
//
// Hermetic: node + file reads only; no network, no builds.
// Run: node tests/oneshot-wiring.test.mjs
// ================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

// Order is normative: it is the order the Dockerfile COPY line and
// the gate grep both use.
const ARTIFACTS = ["index.html", "bricks.html", "asteroids.html", "fishtank.html"];
const GAMES = ["bricks.html", "asteroids.html", "fishtank.html"];
const COPY_LINE = `COPY ${ARTIFACTS.join(" ")} /srv/`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

const dockerfile = read("Dockerfile");
const gate = JSON.parse(read(".devloop.json"));
const packager = read("scripts/package-oneshot.sh");
const workflow = read(".github/workflows/deploy.yml");
const hub = read("index.html");

// ================================================================
// 1. Dockerfile: one COPY line, all four root files
// ================================================================
check("dockerfile: the single /srv/ COPY instruction ships all four root artifacts", () => {
  const srvCopies = dockerfile.match(/^COPY.*\/srv\/\s*$/gm) || [];
  assert(srvCopies.length === 1, `exactly one /srv/ COPY line expected, found ${srvCopies.length}`);
  assert(srvCopies[0].trim() === COPY_LINE,
    `COPY line must be "${COPY_LINE}", got "${srvCopies[0].trim()}"`);
});

// ================================================================
// 2. Gate (.devloop.json): pins the Dockerfile line, links the hub
// ================================================================
check("gate: the Dockerfile grep pins the exact COPY line the Dockerfile carries", () => {
  const pin = (gate.checks || []).find((c) => c.includes("COPY") && c.includes("Dockerfile"));
  assert(typeof pin === "string", ".devloop.json must pin the Dockerfile COPY line");
  const m = /grep -q '(.+)' Dockerfile/.exec(pin);
  assert(m, `gate pin must be a grep of the COPY line, got: ${pin}`);
  assert(m[1] === COPY_LINE, `gate pins "${m[1]}" but the Dockerfile carries "${COPY_LINE}"`);
  assert(dockerfile.includes(COPY_LINE), "the pinned COPY line must appear verbatim in the Dockerfile");
});

check("gate: the hub check links all three games in index.html", () => {
  const hubCheck = (gate.checks || []).find((c) => c.includes("grep -q 'href=") && c.includes("index.html"));
  assert(typeof hubCheck === "string", ".devloop.json must carry a hub link check");
  for (const game of GAMES) {
    assert(hubCheck.includes(`href="${game}"`),
      `hub gate check must assert href="${game}": ${hubCheck}`);
  }
});

// ================================================================
// 3. Packager: FILES is exactly the four root artifacts
// ================================================================
check("packager: the FILES array is exactly the four root artifacts", () => {
  const m = /FILES=\(([^)]*)\)/.exec(packager);
  assert(m, "package-oneshot.sh must define a FILES=(...) array");
  const files = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert(JSON.stringify([...files].sort()) === JSON.stringify([...ARTIFACTS].sort()),
    `FILES must be exactly [${ARTIFACTS.join(", ")}], got [${files.join(", ")}]`);
});

// ================================================================
// 4. CI: Node 24 + pinned toolchain checked BEFORE the suite loop
// ================================================================
check("ci: the suite job pins Node.js 24 (not the old Node 20)", () => {
  assert(/^\s*node-version:\s*24\s*$/m.test(workflow), "deploy.yml must pin node-version: 24");
  assert(!/node-version:\s*2\d/.test(workflow.replace(/node-version:\s*24/g, "")),
    "no stray non-24 node-version pin may remain in deploy.yml");
});

check("ci: npm ci, typecheck and build --check run in order BEFORE the suite loop", () => {
  const lines = workflow.split("\n").map((l) => l.trim());
  const at = (needle) => lines.findIndex((l) => l === needle);
  const positions = {
    "npm ci": at("run: npm ci"),
    "npm run typecheck": at("run: npm run typecheck"),
    "build --check": at("run: node scripts/build-fishtank.mjs --check"),
    "suite loop": lines.findIndex((l) => l.startsWith("for f in tests/*.test.mjs")),
  };
  for (const [step, i] of Object.entries(positions)) {
    assert(i > -1, `deploy.yml is missing the "${step}" step (looked for an exact \`run:\` line)`);
  }
  const order = Object.values(positions);
  assert(order.every((v, i) => i === 0 || v > order[i - 1]),
    `steps must run in order npm ci → typecheck → build --check → suite loop, got indices [${order.join(", ")}]`);
});

// ================================================================
// 5. Hub + docs: the fishtank joins the visible catalog
// ================================================================
check("hub: the fishtank card carries its own accent variable, distinct from the others", () => {
  assert(/href=["']fishtank\.html["']/.test(hub), "hub must link fishtank.html by bare relative href");
  const accent = (name) =>
    new RegExp(`--accent-${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(hub)?.[1];
  const fishtank = accent("fishtank");
  assert(fishtank, "hub must define --accent-fishtank for the new cabinet card");
  for (const other of ["bricks", "asteroids"]) {
    const theirs = accent(other);
    assert(theirs, `hub lost --accent-${other} while adding the fishtank card`);
    assert(fishtank.toLowerCase() !== theirs.toLowerCase(),
      `--accent-fishtank must be distinct from --accent-${other} (both are ${fishtank})`);
  }
});

check("docs: README products table gains a fishtank.html row", () => {
  const readme = read("README.md");
  assert(/^\|[^\n]*\[`fishtank\.html`\]\(fishtank\.html\)\s*\|\s*$/m.test(readme),
    "README products table must gain a row linking [`fishtank.html`](fishtank.html)");
});

check("docs: AGENTS.md distribution section lists fishtank.html among the root deployables", () => {
  const agents = read("AGENTS.md");
  const start = agents.indexOf("## Distribution");
  assert(start > -1, "AGENTS.md must keep its Distribution section");
  const next = agents.indexOf("\n## ", start + 1);
  const section = agents.slice(start, next === -1 ? undefined : next);
  assert(section.includes("`fishtank.html`"),
    "the distribution paragraph must list fishtank.html alongside the other root files");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
