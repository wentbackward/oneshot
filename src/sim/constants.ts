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
