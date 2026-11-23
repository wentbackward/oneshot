// ================================================================
// Shared angular policy (leaf module, alongside rng.ts and
// tail.ts): the TAU constant, the shortest-heading-difference
// wrap, and the per-step torque-smoothing blend that every spine
// animal shares — the tetras (src/sim/world.ts) and the angels
// (src/sim/angels.ts) measure turning the SAME way, so the policy
// lives in exactly one place.
// ================================================================

/** One full turn, radians. */
export const TAU = 2 * Math.PI;

/** Per-step blend of the instantaneous turning torque into the
 *  smoothed one feeding the tail formula: 0.25 reacts in ≈ 4 steps
 *  without strobing on per-step force jitter. */
export const TORQUE_SMOOTHING = 0.25;

/** Wrap a heading delta into [−π, π]: the shortest angular
 *  difference, so the torque measurement sees a U-turn as π, not
 *  2π. (Both endpoints can occur: ±π modulo 2π survives the
 *  branch cuts as-is.) */
export function wrapPi(angle: number): number {
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}
