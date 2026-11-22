#!/usr/bin/env node
// ================================================================
// Unit tests — tank save/load with schema-validated JSON
// (ticket #126, PRD §4/§5): the layout (rock positions/radii,
// kelp anchors, species counts, lighting mode) round-trips through
// localStorage field for field on a fresh world; the payload
// carries a numeric schemaVersion; and ANY corruption — bad JSON,
// wrong shape, wrong types, unrecognized schemaVersion — loads to
// the full default tank without throwing (the campaign-2
// throwing-storage boot precedent).
//
// Harness: two layers, house style.
//  (1) Stock node with flag-free .ts type-stripping imports the
//      real src modules for validator/round-trip unit checks.
//  (2) The real bundled <script> from the committed fishtank.html
//      boots in a sandboxed node:vm context whose window carries a
//      Map-backed localStorage STUB that captures every write —
//      that stub is the only "storage" this test ever talks to.
// No network, no external services.
//
// Run: node tests/fishtank-save.test.mjs
// ================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  SAVE_SCHEMA_VERSION,
  STORAGE_KEY,
  applyLayout,
  captureLayout,
  lightingModeOf,
  validateSave,
} from "../src/fishtank-storage.ts";
import { World } from "../src/sim/world.ts";
import { DAY_DURATION, DUSK_DURATION } from "../src/render/lighting.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "fishtank.html"), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("no <script> block found in fishtank.html");
const gameSource = scriptMatch[1];

// ---------- tiny test harness (house style) ----------
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

// ---------- vm stubs ----------

function makeEl(id) {
  const el = {
    id,
    listeners: {},
    classes: new Set(),
    textContent: "",
    attrs: {},
    setAttribute: function (name, value) { this.attrs[name] = value; },
    addEventListener: function (type, cb) {
      (this.listeners[type] ??= []).push(cb);
    },
  };
  el.classList = {
    add: (c) => el.classes.add(c),
    remove: (c) => el.classes.delete(c),
    contains: (c) => el.classes.has(c),
  };
  return el;
}

function makeCtx() {
  const gradient = { addColorStop: () => {} };
  const target = {
    canvas: null,
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
      const value = t[prop];
      return typeof value === "function" ? (...args) => value(...args) : value;
    },
    set() {
      return true;
    },
  });
}

const ALL_IDS = [
  "hud", "hud-toggle", "hud-panel", "hud-fps",
  "hud-count-tetra", "hud-count-predator", "hud-grid",
  "speed-pause", "speed-1x", "speed-2x", "speed-4x",
  "tool-place-rock", "tool-place-kelp", "tool-remove",
];

/** Map-backed localStorage stub that captures every write. */
function makeStorage(preloads = {}, throwing = false) {
  const s = {
    map: new Map(Object.entries(preloads)),
    writes: [],
    getItem(key) {
      if (throwing) throw new Error("Storage access denied (SecurityError stand-in)");
      return s.map.has(key) ? s.map.get(key) : null;
    },
    setItem(key, value) {
      if (throwing) throw new Error("Storage access denied (SecurityError stand-in)");
      s.writes.push([String(key), String(value)]);
      s.map.set(String(key), String(value));
    },
    removeItem(key) {
      s.map.delete(key);
    },
  };
  return s;
}

function boot(width, height, storage) {
  const els = new Map();
  for (const id of ALL_IDS) els.set(id, makeEl(id));
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    listeners: {},
    addEventListener: function (type, cb) {
      (this.listeners[type] ??= []).push(cb);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    getContext: () => makeCtx(),
  };
  let rafCb = null;
  let rafSeq = 0;
  const win = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    localStorage: storage,
    addEventListener: () => {},
    requestAnimationFrame: (cb) => {
      rafCb = cb;
      return ++rafSeq;
    },
  };
  const sandbox = {
    window: win,
    document: {
      getElementById: (id) =>
        id === "game" ? canvas : els.get(id) ?? null,
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
  return {
    els,
    canvas,
    q: (expr) => vm.runInContext(expr, context),
    frameAt,
    tick(n) {
      for (let i = 1; i <= n; i++) frameAt(i * (1000 / 60));
    },
    clickButton(id) {
      const el = els.get(id);
      assert(el !== undefined, `no stub element for #${id}`);
      const cbs = el.listeners["click"];
      assert(cbs && cbs.length >= 1, `the ${id} button listener must be wired at boot`);
      cbs[cbs.length - 1]({});
    },
    clickCanvas(clientX, clientY) {
      const cbs = canvas.listeners["click"];
      assert(cbs && cbs.length >= 1, "the canvas click listener must be wired at boot");
      cbs[cbs.length - 1]({ clientX, clientY });
    },
  };
}

// The app maps tank units → canvas px by a plain stretch (800×600
// canvas over the 1600×1000 tank).
const W = 800;
const H = 600;
const toTankX = (px) => (px / W) * 1600;
const toTankY = (py) => (py / H) * 1000;

// A boot is a "full default tank" when the saved layout is ignored.
function assertDefaultTank(g) {
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 0,
    `corrupt storage must load the default tank (no rocks), got ${g.q("FISH_TANK_WORLD.rocks.length")}`);
  assert(g.q("FISH_TANK_WORLD.kelp.length") === 0,
    `corrupt storage must load the default tank (no kelp), got ${g.q("FISH_TANK_WORLD.kelp.length")}`);
  assert(g.q("FISH_TANK_WORLD.agents.length") === 80,
    `corrupt storage must load the default population (80 tetras), got ${g.q("FISH_TANK_WORLD.agents.length")}`);
  assert(g.q("FISH_TANK_WORLD.predator") !== null,
    "corrupt storage must load the default tank (predator present)");
  assert(g.q("FISH_TANK_WORLD.lightingPhaseOffset") === 0,
    `corrupt storage must leave the lighting phase at its default offset, got ${g.q("FISH_TANK_WORLD.lightingPhaseOffset")}`);
  assert(g.q("lightingModeOf()") === "LIGHT_DAY",
    `corrupt storage must hold the default lighting mode, got ${g.q("lightingModeOf()")}`);
}

// ================================================================
// Layer 1 — validator (schema validation)
// ================================================================
check("validateSave accepts a well-formed schemaVersion-1 payload (normalized copy)", () => {
  const payload = {
    schemaVersion: SAVE_SCHEMA_VERSION,
    rocks: [{ x: 300, y: 200, r: 40 }],
    kelp: [{ x: 500 }],
    species: { tetra: 64, predator: 0 },
    lighting: { mode: "LIGHT_DUSK" },
  };
  const ok = validateSave(payload);
  assert(ok !== null, "a well-formed payload must validate");
  assert(ok.schemaVersion === SAVE_SCHEMA_VERSION, "normalized copy keeps the schema version");
  assert(JSON.stringify(ok) === JSON.stringify(payload), "validation must not alter a clean payload's data");
});

check("validateSave rejects unrecognized schemaVersions (and non-numeric ones)", () => {
  const base = {
    rocks: [],
    kelp: [],
    species: { tetra: 80, predator: 1 },
    lighting: { mode: "LIGHT_DAY" },
  };
  for (const version of [0, 2, 99, "1", 1.5, null, undefined]) {
    const v = validateSave({ schemaVersion: version, ...base });
    assert(v === null, `schemaVersion ${JSON.stringify(version)} must be rejected`);
  }
});

check("validateSave rejects non-object payloads", () => {
  for (const raw of [null, undefined, 42, "hello", true, [1, 2], NaN]) {
    assert(validateSave(raw) === null, `payload ${JSON.stringify(raw) ?? String(raw)} must be rejected`);
  }
});

check("validateSave rejects wrong-shaped payloads (missing keys, wrong types)", () => {
  const clean = {
    schemaVersion: SAVE_SCHEMA_VERSION,
    rocks: [],
    kelp: [],
    species: { tetra: 80, predator: 1 },
    lighting: { mode: "LIGHT_DAY" },
  };
  const cases = [
    ["missing rocks", { ...clean, rocks: undefined }],
    ["missing kelp", { ...clean, kelp: undefined }],
    ["missing species", { ...clean, species: undefined }],
    ["missing lighting", { ...clean, lighting: undefined }],
    ["rocks not an array", { ...clean, rocks: "nope" }],
    ["rock not an object", { ...clean, rocks: [42] }],
    ["rock missing r", { ...clean, rocks: [{ x: 1, y: 2 }] }],
    ["rock non-finite coord", { ...clean, rocks: [{ x: NaN, y: 2, r: 40 }] }],
    ["rock negative radius", { ...clean, rocks: [{ x: 100, y: 100, r: -1 }] }],
    ["rock not fully in tank", { ...clean, rocks: [{ x: 10, y: 100, r: 40 }] }],
    ["kelp not an array", { ...clean, kelp: {} }],
    ["kelp entry wrong type", { ...clean, kelp: ["500"] }],
    ["kelp anchor non-finite", { ...clean, kelp: [{ x: Infinity }] }],
    ["kelp anchor negative (-5000)", { ...clean, kelp: [{ x: -5000 }] }],
    ["kelp anchor beyond tank width (9999)", { ...clean, kelp: [{ x: 9999 }] }],
    ["kelp anchor fractionally beyond width (1600.5)", { ...clean, kelp: [{ x: 1600.5 }] }],
    ["kelp over the cap (33)", { ...clean, kelp: Array.from({ length: 33 }, (_, i) => ({ x: i * 10 })) }],
    ["rocks over the cap (25)", { ...clean, rocks: Array.from({ length: 25 }, (_, i) => ({ x: 100 + i, y: 100, r: 1 })) }],
    ["species not an object", { ...clean, species: "80" }],
    ["tetra count a string", { ...clean, species: { tetra: "64", predator: 1 } }],
    ["tetra count negative", { ...clean, species: { tetra: -1, predator: 1 } }],
    ["tetra count fractional", { ...clean, species: { tetra: 10.5, predator: 1 } }],
    ["tetra count non-finite", { ...clean, species: { tetra: NaN, predator: 1 } }],
    ["tetra count above the load cap (2001)", { ...clean, species: { tetra: 2001, predator: 1 } }],
    ["predator neither 0 nor 1", { ...clean, species: { tetra: 80, predator: 2 } }],
    ["predator a boolean", { ...clean, species: { tetra: 80, predator: true } }],
    ["lighting not an object", { ...clean, lighting: "LIGHT_DAY" }],
    ["unknown lighting mode", { ...clean, lighting: { mode: "LIGHT_NOON" } }],
    ["lighting mode wrong type", { ...clean, lighting: { mode: 1 } }],
  ];
  for (const [name, payload] of cases) {
    assert(validateSave(payload) === null, `${name} must be rejected`);
  }
});

check("validateSave accepts kelp anchors on the tank boundary (x = 0 and x = TANK_WIDTH)", () => {
  const clean = {
    schemaVersion: SAVE_SCHEMA_VERSION,
    rocks: [],
    species: { tetra: 80, predator: 1 },
    lighting: { mode: "LIGHT_DAY" },
  };
  for (const x of [0, 1600]) {
    const v = validateSave({ ...clean, kelp: [{ x }] });
    assert(v !== null, `kelp anchor x=${x} sits on the substrate boundary and must validate`);
  }
});

check("captureLayout snapshots the live world: schema version, species counts, lighting mode", () => {
  const w = new World({ seed: 3 });
  const save = captureLayout(w);
  assert(save.schemaVersion === SAVE_SCHEMA_VERSION, "the payload carries the numeric schema version");
  assert(typeof save.schemaVersion === "number", "the schema version is a number");
  assert(save.rocks.length === 0 && save.kelp.length === 0, "a fresh world saves an empty layout");
  assert(save.species.tetra === w.agents.length && save.species.tetra === 80, "tetra count equals the live pool");
  assert(save.species.predator === 1, "a default world saves predator 1");
  assert(save.lighting.mode === "LIGHT_DAY", "a t=0 world holds LIGHT_DAY");
});

// ================================================================
// Layer 1 — round trip: capture → apply on a FRESH world,
// field for field
// ================================================================
check("save/load round-trip reproduces rocks, kelp anchors, species counts and lighting mode field for field on a fresh world", () => {
  const a = new World({ seed: 7 });
  a.placeRock(300, 200);
  a.placeRock(900, 700);
  a.placeRock(150, 150);
  a.placeKelp(500);
  a.placeKelp(1200);
  a.setTetraCount(64);
  a.setPredatorPresent(false);
  a.lightingPhaseOffset = DAY_DURATION; // holds LIGHT_DUSK at t = 0
  const captured = captureLayout(a);
  const save = validateSave(captured);
  assert(save !== null, "the captured layout of a live world must be valid");
  assert(save.lighting.mode === "LIGHT_DUSK", `setup: offset ${a.lightingPhaseOffset} must hold LIGHT_DUSK`);

  const b = new World({ seed: 7 });
  applyLayout(b, save);
  // Rocks: positions AND radii, in order.
  assert(b.rocks.length === 3, `round-trip must restore all 3 rocks, got ${b.rocks.length}`);
  for (let i = 0; i < 3; i++) {
    assert(b.rocks[i].x === a.rocks[i].x && b.rocks[i].y === a.rocks[i].y && b.rocks[i].r === a.rocks[i].r,
      `rock ${i} must round-trip x/y/r field for field, got (${b.rocks[i].x},${b.rocks[i].y},${b.rocks[i].r}) vs (${a.rocks[i].x},${a.rocks[i].y},${a.rocks[i].r})`);
  }
  // Kelp: anchors, in order.
  assert(b.kelp.length === 2, `round-trip must restore both kelp strands, got ${b.kelp.length}`);
  assert(b.kelp[0].anchorX === 500 && b.kelp[1].anchorX === 1200,
    `kelp anchors must round-trip, got [${b.kelp[0].anchorX}, ${b.kelp[1].anchorX}]`);
  // Species counts.
  assert(b.agents.length === 64, `tetra count must round-trip (64), got ${b.agents.length}`);
  assert(b.predator === null, "predator-absent must round-trip");
  // Lighting mode: the restored world holds the SAME mode.
  assert(lightingModeOf(b) === "LIGHT_DUSK", `lighting mode must round-trip, got ${lightingModeOf(b)}`);
});

check("round-trip holds each lighting mode (DAY, DUSK, NIGHT) at the restored world", () => {
  const modes = [
    ["LIGHT_DAY", 0],
    ["LIGHT_DUSK", DAY_DURATION],
    ["LIGHT_NIGHT", DAY_DURATION + DUSK_DURATION],
  ];
  for (const [mode, offset] of modes) {
    const a = new World({ seed: 21 });
    a.placeKelp(700);
    a.lightingPhaseOffset = offset; // hold `mode` at t = 0
    assert(lightingModeOf(a) === mode, `setup: offset ${offset} must hold ${mode}`);
    const save = validateSave(captureLayout(a));
    assert(save !== null, `the ${mode} capture must validate`);
    assert(save.lighting.mode === mode, `the ${mode} capture must record ${mode}`);
    const b = new World({ seed: 21 });
    applyLayout(b, save);
    assert(lightingModeOf(b) === mode, `the restored world must hold ${mode}, got ${lightingModeOf(b)}`);
    assert(b.kelp.length === 1 && b.kelp[0].anchorX === 700, "the co-saved kelp anchor must load too");
  }
});

check("round-trip of a grown school is deterministic: two fresh worlds applying the same save replay identically", () => {
  const a = new World({ seed: 11 });
  a.setTetraCount(150); // grow the school past its spawn size
  a.setPredatorPresent(true);
  const save = validateSave(captureLayout(a));
  assert(save !== null, "the captured layout must be valid");
  const b1 = new World({ seed: 11 });
  const b2 = new World({ seed: 11 });
  applyLayout(b1, save);
  applyLayout(b2, save);
  for (let i = 0; i < 10; i++) {
    b1.step(1 / 60);
    b2.step(1 / 60);
  }
  assert(b1.serializeState() === b2.serializeState(),
    "two fresh worlds loading the same layout must replay byte-identically");
});

// ================================================================
// Layer 2 — the vm suite: localStorage stub capturing the JSON
// ================================================================
check("saveTank writes schema-versioned layout JSON to the named localStorage key", () => {
  const storage = makeStorage();
  const g = boot(W, H, storage);
  g.frameAt(0);
  assert(g.q("STORAGE_KEY") === STORAGE_KEY, "the seam's storage key must match the module constant");
  g.q("saveTank()");
  assert(storage.writes.length === 1, `saveTank must write exactly once, wrote ${storage.writes.length}`);
  const [key, raw] = storage.writes[0];
  assert(key === STORAGE_KEY, `the write must land on the named key, got ${key}`);
  const json = JSON.parse(raw);
  assert(json.schemaVersion === SAVE_SCHEMA_VERSION, "the stored JSON carries the numeric schema version");
  assert(json.rocks.length === 0 && json.kelp.length === 0, "a fresh tank saves an empty layout");
  assert(json.species.tetra === 80 && json.species.predator === 1, "the fresh tank saves 80 tetras and the predator");
  assert(json.lighting.mode === "LIGHT_DAY", "a t=0 tank saves LIGHT_DAY");
});

check("vm round-trip: saveTank on one boot, boot a FRESH world from the captured JSON — layout restored field for field", () => {
  const capture = makeStorage();
  const a = boot(W, H, capture);
  a.frameAt(0);
  a.q(`FISH_TANK_WORLD.placeRock(${toTankX(150)}, ${toTankY(120)})`);
  a.q(`FISH_TANK_WORLD.placeRock(${toTankX(450)}, ${toTankY(350)})`);
  a.q("FISH_TANK_WORLD.placeKelp(500)");
  a.q("FISH_TANK_WORLD.placeKelp(1200)");
  a.q("FISH_TANK_WORLD.setTetraCount(64)");
  a.q("FISH_TANK_WORLD.setPredatorPresent(false)");
  a.q("FISH_TANK_WORLD.lightingPhaseOffset = 45");
  a.q("saveTank()");
  assert(capture.writes.length === 1, "the capturing stub must record the save");
  const [key, saved] = capture.writes[0];
  const json = JSON.parse(saved);
  assert(json.lighting.mode === "LIGHT_DUSK", "the saved mode at offset 45 must be LIGHT_DUSK");

  const b = boot(W, H, makeStorage({ [key]: saved }));
  b.frameAt(0);
  // Rocks (positions + radii).
  const rocks = b.q("FISH_TANK_WORLD.rocks");
  assert(rocks.length === 2, `the fresh world must load both rocks, got ${rocks.length}`);
  assert(Math.abs(rocks[0].x - toTankX(150)) < 1e-9 && Math.abs(rocks[0].y - toTankY(120)) < 1e-9,
    "rock 1 must load at the saved position");
  assert(Math.abs(rocks[1].x - toTankX(450)) < 1e-9 && Math.abs(rocks[1].y - toTankY(350)) < 1e-9,
    "rock 2 must load at the saved position");
  assert(rocks[0].r === 40 && rocks[1].r === 40, "rock radii must load field for field (40)");
  // Kelp anchors.
  const anchors = b.q("FISH_TANK_WORLD.kelp.map((s) => s.anchorX)");
  assert(anchors.length === 2 && anchors[0] === 500 && anchors[1] === 1200,
    `kelp anchors must load, got [${anchors}]`);
  // Species counts.
  assert(b.q("FISH_TANK_WORLD.agents.length") === 64, "the fresh world must load the saved tetra count");
  assert(b.q("FISH_TANK_WORLD.predator") === null, "the fresh world must respect predator-absent");
  // Lighting mode.
  assert(b.q("lightingModeOf()") === "LIGHT_DUSK",
    `the fresh world must hold the saved lighting mode, got ${b.q("lightingModeOf()")}`);
  b.tick(5); // and it keeps running
});

check("vm: a boot finds NO save and does not write anything until a save happens", () => {
  const storage = makeStorage();
  const g = boot(W, H, storage);
  g.frameAt(0);
  g.tick(5);
  assert(storage.writes.length === 0, "mere booting and stepping must not auto-write storage");
});

// ---------- schema validation at the boot boundary ----------
const DUSK_PRELOAD = {
  schemaVersion: SAVE_SCHEMA_VERSION,
  rocks: [{ x: 400, y: 300, r: 40 }],
  kelp: [{ x: 600 }],
  species: { tetra: 12, predator: 1 },
  lighting: { mode: "LIGHT_DUSK" },
};

check("boot with CORRUPTED JSON loads the full default tank without throwing", () => {
  const g = boot(W, H, makeStorage({ [STORAGE_KEY]: '{"rocks": [broken' }));
  g.frameAt(0);
  assertDefaultTank(g);
  g.tick(5); // the loop survives a rejected boot load
});

check("boot with a WRONG-SHAPED or WRONG-TYPE payload loads the full default tank without throwing", () => {
  const badShapes = [
    "empty object",
    {},
    "missing lighting mode",
    { ...DUSK_PRELOAD, lighting: {} },
    "rocks of the wrong type",
    { ...DUSK_PRELOAD, rocks: "nope" },
    "species.tetra of the wrong type",
    { ...DUSK_PRELOAD, species: { tetra: "12", predator: 1 } },
    "rock radius negative",
    { ...DUSK_PRELOAD, rocks: [{ x: 100, y: 100, r: -40 }] },
    "kelp cap exceeded",
    { ...DUSK_PRELOAD, kelp: Array.from({ length: 33 }, (_, i) => ({ x: i * 10 })) },
    "kelp anchor out of the tank (x: -5000)",
    { ...DUSK_PRELOAD, kelp: [{ x: -5000 }] },
  ];
  for (let i = 0; i < badShapes.length; i += 2) {
    const [name, payload] = [badShapes[i], badShapes[i + 1]];
    const g = boot(W, H, makeStorage({ [STORAGE_KEY]: JSON.stringify(payload) }));
    g.frameAt(0);
    assertDefaultTank(g);
    g.tick(3);
  }
});

check("boot with a NON-OBJECT stored value (number / string / null) loads the full default tank without throwing", () => {
  for (const raw of ["42", '"hello"', "null", "true"]) {
    const g = boot(W, H, makeStorage({ [STORAGE_KEY]: raw }));
    g.frameAt(0);
    assertDefaultTank(g);
  }
});

check("boot with an UNRECOGNIZED schemaVersion loads the full default tank without throwing", () => {
  for (const version of [0, 2, 99, "1"]) {
    const g = boot(W, H, makeStorage({
      [STORAGE_KEY]: JSON.stringify({ ...DUSK_PRELOAD, schemaVersion: version }),
    }));
    g.frameAt(0);
    assertDefaultTank(g);
  }
});

check("boot with a VALID stored layout loads it (the happy path the corruption battery defends)", () => {
  const g = boot(W, H, makeStorage({ [STORAGE_KEY]: JSON.stringify(DUSK_PRELOAD) }));
  g.frameAt(0);
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 1, "the saved rock must load");
  assert(g.q("FISH_TANK_WORLD.kelp.length") === 1, "the saved kelp must load");
  assert(g.q("FISH_TANK_WORLD.agents.length") === 12, "the saved tetra count must load");
  assert(g.q("lightingModeOf()") === "LIGHT_DUSK", "the saved lighting mode must load");
});

// ---------- the throwing-storage boot precedent (campaign 2) ----------
check("boot with a THROWING localStorage degrades to the default tank and the loop survives", () => {
  const g = boot(W, H, makeStorage({}, true));
  g.frameAt(0);
  assertDefaultTank(g);
  g.tick(15); // frames keep flowing
  assert(g.q("saveTank()") === undefined, "a throwing setItem must be swallowed, not propagated");
});

check("boot with NO localStorage available at all degrades to the default tank", () => {
  // The existing vm suites boot without any localStorage on window —
  // that path must keep working: no save, no crash.
  const els = new Map();
  for (const id of ALL_IDS) els.set(id, makeEl(id));
  const canvas = {
    width: 0, height: 0, style: {}, listeners: {},
    addEventListener: function (t, cb) { (this.listeners[t] ??= []).push(cb); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    getContext: () => makeCtx(),
  };
  let rafCb = null;
  let rafSeq = 0;
  const win = {
    innerWidth: W, innerHeight: H, devicePixelRatio: 1,
    addEventListener: () => {},
    requestAnimationFrame: (cb) => { rafCb = cb; return ++rafSeq; },
    // NOTE: deliberately no `localStorage` property on window.
  };
  const context = vm.createContext({
    window: win,
    document: { getElementById: (id) => (id === "game" ? canvas : els.get(id) ?? null) },
  });
  vm.runInContext(gameSource, context);
  const q = (expr) => vm.runInContext(expr, context);
  let now = 0;
  for (let i = 0; i < 6; i++) {
    now += i === 0 ? 0 : 1000 / 60;
    const cb = rafCb;
    rafCb = null;
    cb(now);
  }
  assert(q("FISH_TANK_WORLD.rocks.length") === 0, "no storage ⇒ default tank");
  assert(q("FISH_TANK_WORLD.agents.length") === 80, "no storage ⇒ default population");
  assert(q("FISH_TANK_WORLD.time") > 0, "the loop kept advancing the sim");
});

// ---------- auto-save on placement ----------
check("a toolbar rock placement auto-saves the updated layout to localStorage", () => {
  const storage = makeStorage();
  const g = boot(W, H, storage);
  g.frameAt(0);
  g.clickCanvas(200, 150); // place-rock is the default mode
  assert(storage.writes.length >= 1, "a successful placement must trigger a save");
  const [, raw] = storage.writes[storage.writes.length - 1];
  const json = JSON.parse(raw);
  assert(json.rocks.length === 1, "the saved layout must carry the placed rock");
  assert(Math.abs(json.rocks[0].x - toTankX(200)) < 1e-9 && Math.abs(json.rocks[0].y - toTankY(150)) < 1e-9,
    "the saved rock must sit where the cursor placed it");
});

check("a toolbar rock removal auto-saves the shrunken layout", () => {
  const storage = makeStorage();
  const g = boot(W, H, storage);
  g.frameAt(0);
  g.clickCanvas(200, 150); // place
  g.clickButton("tool-remove");
  g.clickCanvas(200, 150); // remove the same rock
  const [, raw] = storage.writes[storage.writes.length - 1];
  const json = JSON.parse(raw);
  assert(json.rocks.length === 0, "after the removal the saved layout must be rock-free");
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 0, "the live world agrees");
});

check("the seam's loadTank reloads the saved layout onto the LIVE world (mid-session restore)", () => {
  const storage = makeStorage();
  const g = boot(W, H, storage);
  g.frameAt(0);
  // Establish a saved layout and persist it.
  g.q("FISH_TANK_WORLD.placeRock(300, 250)");
  g.q("FISH_TANK_WORLD.placeKelp(700)");
  g.q("FISH_TANK_WORLD.setTetraCount(36)");
  g.q("FISH_TANK_WORLD.setPredatorPresent(false)");
  g.q("saveTank()");
  assert(storage.writes.length === 1, "the setup save must have landed");
  // Diverge the live world from the save.
  g.q("FISH_TANK_WORLD.placeRock(1200, 800)");
  g.q("FISH_TANK_WORLD.placeKelp(200)");
  g.q("FISH_TANK_WORLD.setTetraCount(50)");
  g.q("FISH_TANK_WORLD.setPredatorPresent(true)");
  assert(g.q("FISH_TANK_WORLD.rocks.length") === 2, "setup: the live world has diverged (2 rocks)");
  // Reload the saved layout mid-session.
  g.q("loadTank()");
  const rocks = g.q("FISH_TANK_WORLD.rocks");
  assert(rocks.length === 1, `loadTank must restore the saved rock count (1), got ${rocks.length}`);
  assert(rocks[0].x === 300 && rocks[0].y === 250 && rocks[0].r === 40,
    `the restored rock must be the saved one field for field, got (${rocks[0].x}, ${rocks[0].y}, ${rocks[0].r})`);
  const anchors = g.q("FISH_TANK_WORLD.kelp.map((s) => s.anchorX)");
  assert(anchors.length === 1 && anchors[0] === 700,
    `the restored kelp must be the saved anchor, got [${anchors}]`);
  assert(g.q("FISH_TANK_WORLD.agents.length") === 36, "the saved tetra count must be restored");
  assert(g.q("FISH_TANK_WORLD.predator") === null, "the saved predator-absent must be restored");
  assert(g.q("lightingModeOf()") === "LIGHT_DAY",
    `the saved lighting mode must be restored, got ${g.q("lightingModeOf()")}`);
  g.tick(5); // and the loop keeps running on the restored world
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
