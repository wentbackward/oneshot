#!/usr/bin/env node
// ================================================================
// Unit tests — fishtank.html scaffold: TS source tree, build
// pipeline, generated self-contained HTML (ticket #117)
//
// Harness: same style as tests/bricks-scaffold.test.mjs. The REAL
// bundled <script> from the committed fishtank.html boots in a
// sandboxed node:vm context with stubbed window/document/canvas;
// frames are driven through the captured requestAnimationFrame
// callback. Build-pipeline checks spawn the real
// scripts/build-fishtank.mjs (committed-tree freshness plus a
// pristine tmp-copy rebuild + one-byte src tamper). The erasable-
// syntax rule is proven by import()-walking every src/**/*.ts
// under stock node with no flags.
//
// Requires `npm ci` first (node_modules hosts esbuild + typescript)
// — the gate order makes npm ci the FIRST check so a clean worktree
// always has the locked toolchain before any test/build/typecheck.
// No network, no external services.
//
// Run: node tests/fishtank-scaffold.test.mjs
// ================================================================
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(root, "fishtank.html");
const html = readFileSync(htmlPath, "utf8"); // RED before the scaffold: ENOENT
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("no <script> block found in fishtank.html");
const gameSource = scriptMatch[1];

// ---------- tiny test harness ----------
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

// ---------- vm stubs ----------

// A 2d-context stub: whitelisted drawing methods are counted,
// factory methods (gradients) return usable stand-ins, every
// property write (fillStyle, globalAlpha, ...) is accepted.
// A call to a method NOT in the whitelist throws — that is the
// signal to extend the stub deliberately.
function makeCountingCtx(counts, canvas) {
  const gradient = { addColorStop: () => {} };
  const target = {
    canvas,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => ({}),
    measureText: () => ({ width: 0 }),
  };
  for (const m of [
    "clearRect", "fillRect", "strokeRect",
    "beginPath", "closePath", "moveTo", "lineTo", "rect",
    "arc", "ellipse", "quadraticCurveTo", "bezierCurveTo",
    "fill", "stroke", "fillText", "strokeText",
    "save", "restore", "translate", "scale", "rotate", "setTransform",
    "drawImage",
  ]) {
    target[m] = () => {};
  }
  return new Proxy(target, {
    get(t, prop) {
      if (prop === Symbol.toPrimitive) return undefined;
      const value = t[prop];
      if (typeof value === "function") {
        return (...args) => {
          counts.drawCalls += 1;
          return value(...args);
        };
      }
      return value;
    },
    set() {
      return true;
    },
  });
}

// A canvas element stub that hands out ONE counting 2d context.
function makeCanvas(counts) {
  // The context is created AFTER the canvas object exists so it is
  // born with a real `canvas` back-reference (no null-patch-up).
  let ctx;
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    listeners: {},
    getContext: (kind) => {
      assert(kind === "2d", `only the 2d context is supported, got ${kind}`);
      return ctx;
    },
  };
  ctx = makeCountingCtx(counts, canvas);
  return canvas;
}

// Boot a fresh copy of the scaffold on a width×height viewport.
function boot(width, height) {
  const counts = { drawCalls: 0 };
  const canvas = makeCanvas(counts);
  let rafCb = null;
  let rafSeq = 0;
  const winListeners = {};
  const win = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    addEventListener: (type, cb) => {
      (winListeners[type] ??= []).push(cb);
    },
    requestAnimationFrame: (cb) => {
      rafCb = cb;
      return ++rafSeq;
    },
  };
  const sandbox = {
    window: win,
    document: {
      getElementById: (id) => (id === "game" ? canvas : null),
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(gameSource, context);

  function frameAt(ms) {
    const cb = rafCb;
    if (typeof cb !== "function") {
      throw new Error("the rAF loop stopped scheduling frames");
    }
    rafCb = null;
    cb(ms);
  }
  function tick(n, fromMs) {
    let now = fromMs ?? 0;
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      frameAt(now);
    }
  }
  const q = (expr) => vm.runInContext(expr, context);
  return {
    canvas,
    win,
    counts,
    frameAt,
    tick,
    resize: () => {
      for (const cb of winListeners["resize"] ?? []) cb({ type: "resize" });
    },
    q,
    fixedDt: () => q("typeof FIXED_DT === 'undefined' ? NaN : FIXED_DT"),
    worldTime: () => q("typeof FISH_TANK_WORLD === 'undefined' ? NaN : FISH_TANK_WORLD.time"),
  };
}

// ---------- spawn helpers for the build pipeline ----------

function runIn(cwd, argv) {
  try {
    const output = execFileSync(process.execPath, argv, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, output };
  } catch (err) {
    return {
      code: typeof err.status === "number" ? err.status : 1,
      output: `${err.stdout ?? ""}\n${err.stderr ?? ""}`,
    };
  }
}

// A pristine sibling copy of everything the builder reads — including
// package.json and tsconfig.json, both of which influence esbuild's
// output bytes (module classification, strict-mode injection) —
// sharing the real node_modules (symlink) so no npm ci is needed in-tests.
function pristineCopy() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "fishtank-117-"));
  try {
    mkdirSync(path.join(tmp, "scripts"), { recursive: true });
    cpSync(path.join(root, "src"), path.join(tmp, "src"), { recursive: true });
    copyFileSync(path.join(root, "scripts", "build-fishtank.mjs"), path.join(tmp, "scripts", "build-fishtank.mjs"));
    copyFileSync(htmlPath, path.join(tmp, "fishtank.html"));
    copyFileSync(path.join(root, "package.json"), path.join(tmp, "package.json"));
    copyFileSync(path.join(root, "tsconfig.json"), path.join(tmp, "tsconfig.json"));
    symlinkSync(path.join(root, "node_modules"), path.join(tmp, "node_modules"), "dir");
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return tmp;
}

const builder = (cwd, ...args) => runIn(cwd, [path.join(cwd, "scripts", "build-fishtank.mjs"), ...args]);

// ================================================================
// Criterion: src/ tree exists — sim/, render/, ui/ populated,
// single entry point src/fishtank-main.ts
// ================================================================
check("src/ ships populated sim/, render/ and ui/ directories plus the single entry point", () => {
  for (const dir of ["sim", "render", "ui"]) {
    const dirPath = path.join(root, "src", dir);
    const entries = readdirSync(dirPath, { recursive: true, withFileTypes: true });
    const tsFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".ts"));
    assert(tsFiles.length > 0, `src/${dir}/ must contain at least one .ts module`);
  }
  assert(
    readFileSync(path.join(root, "src", "fishtank-main.ts"), "utf8").length > 0,
    "src/fishtank-main.ts must exist and be non-empty (the single entry point)"
  );
});

// ================================================================
// Criterion: every src/**/*.ts imports under stock node with no
// flags — the erasable-only syntax rule
// ================================================================
function walkTs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(p, out);
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

await checkAsync("every src/**/*.ts imports cleanly under stock node with no flags", async () => {
  const files = walkTs(path.join(root, "src")).sort();
  assert(files.length >= 5, `expected a real module tree, found only ${files.length} .ts files`);
  for (const file of files) {
    try {
      await import(pathToFileURL(file).href);
    } catch (err) {
      assert(false, `import() of ${path.relative(root, file)} threw: ${err.message}`);
    }
  }
});

// ================================================================
// Criterion: the committed fishtank.html boots and the rAF loop
// runs >= 30 frames without error, >= 1 draw call per frame
// ================================================================
check("FIXED_DT is a named constant equal to 1/60, visible via a vm query", () => {
  const g = boot(800, 600);
  assert(Object.is(g.fixedDt(), 1 / 60), `FIXED_DT must be exactly 1/60, got ${g.fixedDt()}`);
});

check("the rAF loop survives >= 30 consecutive frames and keeps scheduling", () => {
  const g = boot(800, 600);
  assert(g.worldTime() === 0, `a freshly booted world clock must read 0, got ${g.worldTime()}`);
  g.frameAt(0); // first frame: no prior timestamp, dt 0
  g.tick(39, 0); // 39 further frames at 60 Hz stamps
  assert(g.worldTime() > 0, `the world clock must advance while frames flow, got ${g.worldTime()}`);
});

check("every frame performs at least one draw call on the 2d context", () => {
  const g = boot(800, 600);
  for (let frame = 1; frame <= 30; frame++) {
    const base = g.counts.drawCalls;
    g.tick(1, frame > 1 ? (frame * 1000) / 60 : 0);
    assert(
      g.counts.drawCalls > base,
      `frame ${frame} made no draw calls (ctx untouched this frame)`
    );
  }
});

// ================================================================
// Criterion: fixed-timestep stepping — two rAF callbacks 1/30 s
// apart advance the world clock by exactly 2 * FIXED_DT
// ================================================================
check("the first frame (no prior timestamp) does not advance the world clock", () => {
  const g = boot(800, 600);
  g.frameAt(0);
  assert(g.worldTime() === 0, `dt must be 0 on the first frame, clock is ${g.worldTime()}`);
});

check("two rAF callbacks 1/30 s apart advance the world clock by exactly 2 * FIXED_DT", () => {
  const g = boot(800, 600);
  g.frameAt(0); // dt 0, clock stays 0
  g.frameAt(1000 / 30); // one 1/30 s gap: must consume exactly two fixed steps
  const expected = 2 * g.fixedDt();
  assert(
    g.worldTime() === expected,
    `the world clock must be exactly 2*FIXED_DT (${expected}), got ${g.worldTime()}`
  );
  assert(
    g.q("FISH_TANK_WORLD.acc") === 0,
    `a 1/30 s gap is exactly two steps: the accumulator must be drained to 0, got ${g.q("FISH_TANK_WORLD.acc")}`
  );
});

check("a second consecutive 1/30 s gap lands the clock on exactly 4 * FIXED_DT (no leftover skew)", () => {
  const g = boot(800, 600);
  g.frameAt(0);
  g.frameAt(1000 / 30);
  g.frameAt((2 * 1000) / 30);
  assert(
    g.worldTime() === 4 * g.fixedDt(),
    `after two 1/30 s gaps the clock must be exactly 4*FIXED_DT, got ${g.worldTime()}`
  );
});

// ================================================================
// Criterion: the page shell — doctype, canvas, inlined style,
// self-contained (mirrors the gate greps; hub back link exempt)
// ================================================================
check("fishtank.html opens with a doctype and carries a <canvas> and an inlined <style>", () => {
  assert(/^<!doctype html>/i.test(html.trim()), "fishtank.html must start with <!doctype html>");
  assert(/<canvas[\s>]/.test(html), "fishtank.html must carry a <canvas> element");
  assert(/<style>[\s\S]*<\/style>/.test(html), "fishtank.html must carry an inlined <style> block");
});

check("the page is self-contained: no external src=/href= references (hub back link exempt)", () => {
  const noHub = html.replace(/href=["']index\.html["']/g, "");
  assert(!/(src|href)=/.test(noHub), "fishtank.html must not reference any external resource (the hub back link is exempt)");
});

// ================================================================
// Criterion: ui — a resize event refits the canvas backing store
// ================================================================
check("a window resize event refits the canvas backing store to the new viewport", () => {
  const g = boot(800, 600);
  assert(g.canvas.width === 800 && g.canvas.height === 600,
    `boot must size the canvas to the 800x600 viewport, got ${g.canvas.width}x${g.canvas.height}`);
  g.win.innerWidth = 1024;
  g.win.innerHeight = 700;
  g.resize();
  assert(g.canvas.width === 1024 && g.canvas.height === 700,
    `the resize must refit the canvas to 1024x700, got ${g.canvas.width}x${g.canvas.height}`);
});

// ================================================================
// Criterion: build pipeline — npm-ci-able, byte-deterministic
// regeneration, --check freshness (tamper one char to prove it)
// ================================================================
check("--check exits 0 on the committed tree (fishtank.html is fresh)", () => {
  const r = builder(root, "--check");
  assert(r.code === 0, `--check must exit 0 on the committed tree, got ${r.code}:\n${r.output}`);
});

check("rebuilding from pristine sources reproduces fishtank.html byte for byte", () => {
  const tmp = pristineCopy();
  try {
    const r = builder(tmp);
    assert(r.code === 0, `the build must succeed, got ${r.code}:\n${r.output}`);
    const rebuilt = readFileSync(path.join(tmp, "fishtank.html"));
    const committed = readFileSync(htmlPath);
    assert(rebuilt.equals(committed),
      `the rebuilt fishtank.html must be byte-identical to the committed one (${rebuilt.byteLength} vs ${committed.byteLength} bytes)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

check("tampering src/ by one character makes --check exit non-zero", () => {
  const tmp = pristineCopy();
  try {
    const target = path.join(tmp, "src", "sim", "constants.ts");
    const original = readFileSync(target, "utf8");
    const tampered = original.replace("1 / 60", "1 / 61");
    assert(tampered !== original, "test setup: the FIXED_DT literal must appear in src/sim/constants.ts");
    writeFileSync(target, tampered);
    const r = builder(tmp, "--check");
    assert(r.code !== 0, `--check must fail after a one-char src/ tamper, got 0:\n${r.output}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

check("package.json declares an explicit supported Node engines floor", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const floor = pkg.engines && pkg.engines.node;
  const m = typeof floor === "string" && floor.match(/^>=(\d+)\.(\d+)(\.\d+)?$/);
  assert(m, `package.json must declare an explicit ">=M.m(.p)" node engines floor, got ${JSON.stringify(floor)}`);
  const [maj, min] = process.versions.node.split(".").map(Number);
  assert(maj > Number(m[1]) || (maj === Number(m[1]) && min >= Number(m[2])),
    `this runtime (node ${process.versions.node}) must satisfy the declared floor ${floor}`);
});

// ================================================================
// Criterion: npm run typecheck — strict tsc --noEmit over src/
// ================================================================
check("tsc --noEmit (strict, src-scoped) exits 0", () => {
  const r = runIn(root, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit"]);
  assert(r.code === 0, `typecheck must pass, got ${r.code}:\n${r.output}`);
});

// ================================================================
// Criterion: .devloop.json gate wiring — fishtank checks
// present, with npm ci ordered before the fresh/typecheck checks
// ================================================================
check(".devloop.json pins the fishtank gate (size, doctype, canvas, rAF, self-containment, npm ci, --check, typecheck)", () => {
  const cfg = JSON.parse(readFileSync(path.join(root, ".devloop.json"), "utf8"));
  const checks = Array.isArray(cfg.checks) ? cfg.checks : [];
  const ft = checks.filter((c) => c.includes("fishtank.html"));
  assert(ft.length >= 4, `.devloop.json needs several fishtank.html checks, found ${ft.length}`);
  assert(ft.some((c) => /test -s fishtank\.html/.test(c)), "missing: test -s fishtank.html");
  assert(ft.some((c) => /<!doctype html>/i.test(c)), "missing: doctype check on fishtank.html");
  assert(ft.some((c) => /<canvas/.test(c)), "missing: <canvas check on fishtank.html");
  assert(ft.some((c) => /requestAnimationFrame/.test(c)), "missing: requestAnimationFrame check on fishtank.html");
  assert(
    ft.some((c) => /\(src\|href\)/.test(c) && /index\.html/.test(c)),
    "missing: zero src=/href= check (with the href=\"index.html\" exemption) on fishtank.html"
  );
  assert(checks.some((c) => /^npm ci\b/.test(c.trim())), "missing: npm ci gate check");
  const buildIdx = checks.findIndex((c) => /node scripts\/build-fishtank\.mjs --check/.test(c));
  assert(buildIdx >= 0, "missing: node scripts/build-fishtank.mjs --check gate check");
  const tcIdx = checks.findIndex((c) => /npm run typecheck/.test(c));
  assert(tcIdx >= 0, "missing: npm run typecheck gate check");
  const ciIdx = checks.findIndex((c) => /^npm ci\b/.test(c.trim()));
  assert(ciIdx === 0,
    `npm ci must be the FIRST .devloop.json check so a clean worktree installs the locked toolchain before any test/build/typecheck command, found at index ${ciIdx}`);
  assert(ciIdx < buildIdx, "npm ci must run BEFORE the build-freshness check");
  assert(ciIdx < tcIdx, "npm ci must run BEFORE the typecheck");
  const loopIdx = checks.findIndex((c) => /for f in tests\/\*\.test\.mjs/.test(c));
  assert(loopIdx >= 0 && ciIdx < loopIdx, "npm ci must run BEFORE the test loop");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
