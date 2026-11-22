// ================================================================
// Tank save/load (PRD §4, ticket #126): the tank LAYOUT — placed
// rocks (position + radius), kelp anchors, species counts and the
// lighting mode — captured from the live World into a
// schema-versioned JSON payload and persisted to localStorage.
//
// Trust model: storage is ENEMIES-IN-THE-HOUSE territory. Every
// byte read back is validated by validateSave() BEFORE it touches
// the world; ANY failure (bad JSON, wrong shape, wrong type,
// unrecognized schemaVersion) loads the full DEFAULT tank instead
// — mirroring the campaign-2 throwing-storage boot precedent
// (tests/bricks-scaffold.test.mjs). A throwing storage
// (blocked/insecure context) degrades the same way: save/load
// never propagate an exception.
//
// What is NOT saved (deliberately): live fish/predator poses and
// kelp verlet states. The layout is user-placed STATE; the animals
// and strands are live PROCESSES — a fresh world regrows them
// deterministically (seeded spawn cohorts, seeded kelp strands),
// which is exactly what "load on a fresh world" means.
//
// This module is the app layer for persistence: it may see the
// sim (World) and the render (the lighting phase table) — the
// sim/render layers themselves never import it.
// ================================================================

import {
  KELP_MAX,
  ROCK_MAX,
  SAVE_MAX_TETRA,
  TANK_HEIGHT,
  TANK_WIDTH,
} from "./sim/constants.ts";
import { lightPhaseAt, LIGHT_PHASES } from "./render/lighting.ts";
import type { World } from "./sim/world.ts";

/** Current payload schema version: a NUMBER, bumped on any
 *  breaking shape change; unknown versions load the default tank. */
export const SAVE_SCHEMA_VERSION = 1;

/** The named localStorage key of the saved layout. */
export const STORAGE_KEY = "oneshot.fishtank.save.v1";

/** The three lighting palettes' names (render/lighting.ts owns
 *  the tables; the names are the payload's wire vocabulary). */
export type LightingMode = "LIGHT_DAY" | "LIGHT_DUSK" | "LIGHT_NIGHT";

/** One saved rock: position AND radius in tank units. */
export interface SavedRock {
  x: number;
  y: number;
  r: number;
}

/** One saved kelp strand: its anchor x on the substrate (the
 *  strand itself regrows deterministically from the world seed). */
export interface SavedKelp {
  x: number;
}

/** The species census of a saved tank. */
export interface SavedSpecies {
  /** Tetra population (whole fish, 0..SAVE_MAX_TETRA). */
  tetra: number;
  /** 0 or 1: is the apex predator in the tank. */
  predator: number;
}

/** The schema-versioned tank layout payload (wire shape). */
export interface TankSave {
  schemaVersion: number;
  rocks: SavedRock[];
  kelp: SavedKelp[];
  species: SavedSpecies;
  lighting: { mode: LightingMode };
}

/** The storage surface the module needs (localStorage-compatible;
 *  tests inject a Map-backed stub). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Sim time (seconds) at which each named phase BEGINS, derived
 *  once from the render layer's phase table — the table stays the
 *  single source of truth. */
const PHASE_STARTS: Readonly<Record<LightingMode, number>> = (() => {
  const starts = {} as Record<LightingMode, number>;
  let t = 0;
  for (const phase of LIGHT_PHASES) {
    starts[phase.palette.name] = t;
    t += phase.duration;
  }
  return starts;
})();

/** The lighting mode HOLDING in the world at its current clock
 *  (what the HUD-less payload records on save). */
export function lightingModeOf(world: World): LightingMode {
  return lightPhaseAt(world.time + world.lightingPhaseOffset).palette.name;
}

/** Capture the live layout as a fresh payload (never aliases
 *  world state — a later edit cannot rewrite history). */
export function captureLayout(world: World): TankSave {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    rocks: world.rocks.map((rk) => ({ x: rk.x, y: rk.y, r: rk.r })),
    kelp: world.kelp.map((strand) => ({ x: strand.anchorX })),
    species: {
      tetra: world.agents.length,
      predator: world.predator !== null ? 1 : 0,
    },
    lighting: { mode: lightingModeOf(world) },
  };
}

// ---------- validation ----------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a decoded payload against the schema (pure: returns
 *  a NORMALIZED copy or null — never mutates `raw`, never throws
 *  on any input). A payload is rejected as a WHOLE: partial
 *  layouts are worse than the default tank. */
export function validateSave(raw: unknown): TankSave | null {
  if (!isPlainObject(raw)) return null;
  if (raw.schemaVersion !== SAVE_SCHEMA_VERSION) return null;

  // ---- rocks ----
  if (!Array.isArray(raw.rocks) || raw.rocks.length > ROCK_MAX) return null;
  const rocks: SavedRock[] = [];
  for (const entry of raw.rocks) {
    if (!isPlainObject(entry)) return null;
    const { x, y, r } = entry;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(r)) return null;
    if (!(r > 0)) return null;
    // A saved rock must sit FULLY inside the tank (legitimate
    // placements always do — placeRock clamps the circle in).
    if (x < r || x > TANK_WIDTH - r || y < r || y > TANK_HEIGHT - r) return null;
    rocks.push({ x, y, r });
  }

  // ---- kelp ----
  if (!Array.isArray(raw.kelp) || raw.kelp.length > KELP_MAX) return null;
  const kelp: SavedKelp[] = [];
  for (const entry of raw.kelp) {
    if (!isPlainObject(entry)) return null;
    if (!isFiniteNumber(entry.x)) return null;
    kelp.push({ x: entry.x });
  }

  // ---- species ----
  if (!isPlainObject(raw.species)) return null;
  const { tetra, predator } = raw.species;
  if (
    !isFiniteNumber(tetra) ||
    !Number.isInteger(tetra) ||
    tetra < 0 ||
    tetra > SAVE_MAX_TETRA
  ) {
    return null;
  }
  if (predator !== 0 && predator !== 1) return null;

  // ---- lighting ----
  if (!isPlainObject(raw.lighting)) return null;
  const { mode } = raw.lighting;
  if (
    typeof mode !== "string" ||
    !(
      mode === "LIGHT_DAY" ||
      mode === "LIGHT_DUSK" ||
      mode === "LIGHT_NIGHT"
    )
  ) {
    return null;
  }

  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    rocks,
    kelp,
    species: { tetra, predator },
    lighting: { mode },
  };
}

// ---------- application ----------

/** Restore a VALIDATED layout onto the world (precondition:
 *  `save` came out of validateSave — this function trusts it and
 *  does not re-validate, which keeps the hot path single-
 *  responsibility). Order: scenery, then animals, then light. */
export function applyLayout(world: World, save: TankSave): void {
  // Kelp strands regrow from the world's seed sequence; dropping
  // the old strands first keeps the anchor list exactly the
  // saved one (kelpSequence keeps running, which is fine — the
  // STRANDS' appearance is per-world derived state, not layout).
  world.kelp.length = 0;
  for (const k of save.kelp) world.placeKelp(k.x);

  world.rocks.length = 0;
  for (const rk of save.rocks) world.rocks.push({ x: rk.x, y: rk.y, r: rk.r });

  world.setTetraCount(save.species.tetra);
  world.setPredatorPresent(save.species.predator === 1);

  // Hold the saved mode at the world's CURRENT clock: shifting the
  // phase table so the mode's window contains t = world.time
  // (offsets are whole phase starts, so boundaries stay exact).
  world.lightingPhaseOffset = PHASE_STARTS[save.lighting.mode] ?? 0;
}

// ---------- storage I/O (exceptions die HERE, never downstream) ----------

/** Persist the live layout under STORAGE_KEY. A throwing or
 *  missing storage is silently tolerated: the sim never
 *  interrupts itself over a convenience feature. */
export function saveTank(world: World, storage: StorageLike | null): void {
  if (storage === null) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(captureLayout(world)));
  } catch {
    // blocked storage (quota, privacy mode): degrade silently.
  }
}

/** Load the saved layout onto the world at boot. ANY failure —
 *  missing storage, throwing accessors, corrupt JSON, non-object
 *  value, unrecognized schema, wrong shape/types — leaves the
 *  world exactly as constructed (the default tank). */
export function loadTank(world: World, storage: StorageLike | null): void {
  if (storage === null) return;
  let raw: unknown;
  try {
    const text = storage.getItem(STORAGE_KEY);
    raw = text === null ? null : JSON.parse(text);
  } catch {
    return; // corrupt JSON or blocked read: default tank.
  }
  const save = validateSave(raw);
  if (save !== null) applyLayout(world, save);
}
