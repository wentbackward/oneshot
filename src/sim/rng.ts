// ================================================================
// Seeded PRNG (PRD §1): the single random source the simulation is
// allowed to draw from. Everything stochastic (initial populations,
// behaviour jitter) flows through a mulberry32 stream so identical
// seeds replay identical tanks — the determinism tests hash on
// exactly this property. Wall-clock time and Math.random must never
// reach the sim.
// ================================================================

/** Create a mulberry32 generator: a small, fast, deterministic
 *  32-bit stream. Returns a function yielding floats in [0, 1).
 *  Identical seeds replay identical streams, everywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
