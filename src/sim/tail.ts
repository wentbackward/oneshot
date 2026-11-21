// ================================================================
// Procedural tail undulation (PRD §2): the exported pure formula
// mapping a tetra's swimming speed and turning torque to its tail
// frequency in Hz. The rule: tail undulation frequency scales
// dynamically with swimming speed AND with turning torque — a
// stationary, non-turning fish idles at ~zero Hz, a fast or hard-
// turning fish beats faster.
//
// Contract (pinned by tests/fishtank-tail.test.mjs):
//  - pure: no inputs mutated, no hidden state, deterministic;
//  - zero (within 1e-9) for (speed 0, torque 0);
//  - magnitude contract: non-decreasing in |speed| and in
//    |torque| (sign-symmetric in torque — turning either way is
//    the same effort). The speed monotonicity is pinned over the
//    contracted domain speed >= 0, where |speed| is the identity;
//    signed negative speeds fold through Math.abs, so no signed-
//    monotonicity claim is made across the negative-to-zero range;
//  - finite for absurd magnitudes.
// ================================================================

/** Contribution of swimming speed to tail frequency, Hz per tank
 *  unit/s of speed. */
export const TAIL_FREQ_SPEED_GAIN = 0.04;

/** Contribution of turning torque to tail frequency, Hz per rad/s
 *  of (absolute) torque. */
export const TAIL_FREQ_TORQUE_GAIN = 0.25;

/** Tail frequency in Hz for a fish moving at `speed` (tank
 *  units/s, magnitude — negative values are treated as their
 *  magnitude) while turning under `torque` (rad/s, signed). */
export function tailFrequency(speed: number, torque: number): number {
  return TAIL_FREQ_SPEED_GAIN * Math.abs(speed) + TAIL_FREQ_TORQUE_GAIN * Math.abs(torque);
}
