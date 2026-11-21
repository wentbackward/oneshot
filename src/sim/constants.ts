// ================================================================
// Simulation constants — named tuning values for the fishtank
// fixed-timestep engine (PRD §1).
// ================================================================

/** Fixed physics timestep in seconds: the world always advances in
 *  exact multiples of this (60 Hz), independent of frame pacing. */
export const FIXED_DT = 1 / 60;

/** Largest wall-clock gap (seconds) a single frame may feed the
 *  world. Tab switches and long pauses stop advancing the sim after
 *  this instead of bursting thousands of steps. */
export const MAX_FRAME_DELTA = 0.25;

/** Default tetra population the app boots with (PRD §2: schooling
 *  tetras are the flagship species; the sim scales well past this —
 *  the 250+ headroom is proven in tests/fishtank-bench.test.mjs). */
export const TETRA_COUNT = 80;

/** Radius (tank units) of a startle event: every tetra within it
 *  receives the outward impulse (PRD §2: schools scatter when the
 *  user taps the glass). */
export const STARTLE_RADIUS = 140;

/** Magnitude of the outward velocity kick a startled tetra
 *  receives, tank units/s. The next fixed step re-clamps the speed
 *  into [TETRA_MIN_SPEED, TETRA_MAX_SPEED]. */
export const STARTLE_IMPULSE = 200;

/** Speed band a tetra is kept inside each fixed step, tank
 *  units/s: never stalled, never explosive. */
export const TETRA_MIN_SPEED = 30;
export const TETRA_MAX_SPEED = 220;
