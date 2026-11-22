// ================================================================
// Lighting cycle (render, PRD §3 "Atmospheric Rendering"): the
// aquarium's ambient light breathes through exactly three NAMED
// palettes — LIGHT_DAY, LIGHT_DUSK and LIGHT_NIGHT (the
// "Bioluminescent Night") — each held for its named duration of
// SIMULATION time. Phases hard-switch (no crossfade), so the
// ambient never visits a colour outside the three palettes, and
// the walk is provably DAY -> DUSK -> NIGHT in order (pinned by
// tests/fishtank-atmosphere.test.mjs).
//
// The cycle is driven purely by the world clock: a paused sim
// (zero steps) freezes the phase, and future sim-speed controls
// scale it for free. Stateless: identical world time resolves an
// identical palette.
// ================================================================

/** One named lighting palette: the ambient water-gradient stops
 *  plus the caustic-shaft tint it illuminates with. */
export interface LightPalette {
  name: "LIGHT_DAY" | "LIGHT_DUSK" | "LIGHT_NIGHT";
  /** Top stop of the ambient water gradient. */
  surface: string;
  /** Bottom stop of the ambient water gradient. */
  depth: string;
  /** "r, g, b" components the caustic-shaft gradient tints with. */
  causticRgb: string;
  /** Base alpha of a shaft's top gradient stop. */
  causticBaseAlpha: number;
  /** Sinusoidal alpha swing added to the base, per shaft. */
  causticPulseAlpha: number;
}

export const LIGHT_DAY: LightPalette = {
  name: "LIGHT_DAY",
  surface: "#8fd8ea",
  depth: "#0a2c45",
  causticRgb: "220, 245, 255",
  causticBaseAlpha: 0.055,
  causticPulseAlpha: 0.03,
};

export const LIGHT_DUSK: LightPalette = {
  name: "LIGHT_DUSK",
  surface: "#e89a5e",
  depth: "#2a1638",
  causticRgb: "255, 216, 160",
  causticBaseAlpha: 0.065,
  causticPulseAlpha: 0.035,
};

/** Bioluminescent Night: near-black water, and the caustic tint
 *  shifts to a cold phosphorescent teal that reads as living light
 *  instead of sun. */
export const LIGHT_NIGHT: LightPalette = {
  name: "LIGHT_NIGHT",
  surface: "#123650",
  depth: "#030e18",
  causticRgb: "130, 240, 255",
  causticBaseAlpha: 0.085,
  causticPulseAlpha: 0.05,
};

/** Named phase durations in SIMULATION seconds. Each is an exact
 *  multiple of FIXED_DT, so every phase boundary lands on a step
 *  boundary (the AC allows ±1 step of slack). */
export const DAY_DURATION = 45;
export const DUSK_DURATION = 15;
export const NIGHT_DURATION = 20;

/** One full Day -> Dusk -> Night cycle in simulation seconds. */
export const CYCLE_DURATION = DAY_DURATION + DUSK_DURATION + NIGHT_DURATION;

export interface LightPhase {
  palette: LightPalette;
  duration: number;
}

/** The cycle in order; index 0 holds at t = 0 and after every
 *  wrap. Its entries' durations sum to CYCLE_DURATION. */
export const LIGHT_PHASES: readonly LightPhase[] = [
  { palette: LIGHT_DAY, duration: DAY_DURATION },
  { palette: LIGHT_DUSK, duration: DUSK_DURATION },
  { palette: LIGHT_NIGHT, duration: NIGHT_DURATION },
];

/** Resolve the lighting phase holding at simulation time t. The
 *  cycle wraps every CYCLE_DURATION; a boundary instant belongs to
 *  the phase that BEGINS there (t = DAY_DURATION is DUSK, not
 *  DAY). Negative t is wrapped, never NaN'd. */
export function lightPhaseAt(t: number): LightPhase {
  const u = ((t % CYCLE_DURATION) + CYCLE_DURATION) % CYCLE_DURATION;
  let remaining = u;
  let resolved: LightPhase | undefined;
  for (const phase of LIGHT_PHASES) {
    if (remaining < phase.duration) {
      resolved = phase;
      break;
    }
    remaining -= phase.duration;
  }
  if (resolved === undefined) {
    throw new Error("lighting: phase table does not cover CYCLE_DURATION");
  }
  return resolved;
}
