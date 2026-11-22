// ================================================================
// Verlet kelp strand (PRD §3): a multi-segment chain anchored at
// the substrate (y = TANK_HEIGHT) that grows upright, sways with
// the ambient current and bends when fish swim through it.
//
// Physics: position-based verlet integration (pos, prevPos) under
// two uniform accelerations — the ambient current (→ +x) and
// upward growth/buoyancy (→ −y) — followed by an iterative
// distance-constraint solve. The growth term pre-tensions the
// strand against its substrate pin, which is what makes the
// UPRIGHT shape stable: a bottom-anchored chain under net
// downward force is an inverted pendulum and topples (verified
// empirically), while under net upward force a folded strand is a
// distance violation and the straight strand is the energy minimum.
// A soft base-orientation spring (point 1 → rest point on the
// substrate ray) prices tipping, so any tilt a disturbance leaves
// behind decays back to vertical instead of sticking.
//
// "Velocity" is always the implicit (pos − prevPos)/dt — no
// velocity state is stored, so the step is allocation-free and
// unconditionally stable at the fixed 60 Hz timestep.
//
// Contract (pinned by tests/fishtank-kelp.test.mjs):
//  - after 600 relaxed zero-current steps: every segment length
//    within 1 ± KELP_TOL of rest length, no NaN coordinates, and
//    the tip hangs within KELP_REST_ANGLE_TOL of vertical (PRD §5
//    spring-constraint stability law);
//  - with the ambient current on: the tip deviates beyond
//    KELP_CURRENT_TIP_DEVIATION_MIN;
//  - a fish passing nearby drags its points (KELP_FISH_RADIUS /
//    KELP_FISH_PUSH_GAIN), displacing the tip measurably.
//
// WELL-FORMEDNESS (same policy as World.step): a non-finite or
// non-positive dt is refused — the step is a no-op that touches
// nothing.
// ================================================================

import {
  KELP_ANCHOR_PULL,
  KELP_CONSTRAINT_ITERS,
  KELP_DAMPING,
  KELP_FISH_PUSH_GAIN,
  KELP_FISH_RADIUS,
  KELP_GROWTH,
  KELP_JITTER,
  KELP_SEGMENTS,
  KELP_TOTAL_LENGTH,
} from "./constants.ts";
import { mulberry32 } from "./rng.ts";
import type { MovingBody } from "./steering.ts";

/** One verlet point of a strand. `px`/`py` are the PREVIOUS-step
 *  coordinates: the implicit velocity is (x − px, y − py)/dt. */
export interface KelpPoint {
  x: number;
  y: number;
  px: number;
  py: number;
}

/** A kelp strand: KELP_SEGMENTS verlet segments whose points[0] is
 *  welded to the substrate anchor. All coordinates are tank units. */
export class KelpStrand {
  /** Anchor x on the substrate (point 0's x, never moves). */
  readonly anchorX: number;
  /** Anchor y — always TANK_HEIGHT (the substrate). */
  readonly anchorY: number;
  /** Segment count (KELP_SEGMENTS, ≥ 6). */
  readonly segments: number;
  /** Rest length of EVERY segment (they tile the strand evenly). */
  readonly restLength: number;
  /** The base spring's rest point: restLength up the (jittered)
   *  base direction from the anchor — point 1 is pulled toward it
   *  every constraint pass (see KELP_ANCHOR_PULL). */
  private readonly baseRestX: number;
  private readonly baseRestY: number;
  /** points[0] is the pinned anchor; points[segments] is the tip. */
  readonly points: KelpPoint[] = [];

  /** Build the strand at (anchorX, anchorY) as a nearly vertical
   *  column of segments pointing UP (−y): the seeded jitter keeps
   *  it from being laser-straight, which would make the settle
   *  tests vacuous (a perfectly symmetric chain has nothing to
   *  relax). `seed` is the world's deterministic source for it. */
  constructor(anchorX: number, anchorY: number, seed: number) {
    if (!Number.isFinite(anchorX) || !Number.isFinite(anchorY)) {
      throw new RangeError("KelpStrand: anchor must be finite");
    }
    this.anchorX = anchorX;
    this.anchorY = anchorY;
    this.segments = KELP_SEGMENTS;
    this.restLength = KELP_TOTAL_LENGTH / KELP_SEGMENTS;
    const rng = mulberry32(seed >>> 0);
    for (let i = 0; i <= this.segments; i++) {
      const jitter = i === 0 ? 0 : (rng() * 2 - 1) * KELP_JITTER;
      const x = anchorX + jitter;
      const y = anchorY - this.restLength * i;
      this.points.push({ x, y, px: x, py: y });
    }
    // Base direction is whatever the jittered first segment points
    // where: the rest point sits restLength along it.
    const p0 = this.points[0]!;
    const p1 = this.points[1]!;
    const bx = p1.x - p0.x;
    const by = p1.y - p0.y;
    const bl = Math.hypot(bx, by);
    this.baseRestX = p0.x + (bx / bl) * this.restLength;
    this.baseRestY = p0.y + (by / bl) * this.restLength;
  }

  /** One fixed step: verlet-integrate current + growth, apply the
   *  fish drag, then satisfy every segment's rest length
   *  KELP_CONSTRAINT_ITERS times, re-pinning the anchor each pass
   *  and finishing each pass with the soft base-orientation pull.
   *
   *  `currentX` is the ambient horizontal flow (tank units/s², 0 =
   *  still water); `fish` is the world's agents in fixed order
   *  (each head drags any kelp point within KELP_FISH_RADIUS).
   *  A non-finite or non-positive `dt` is refused: the step is a
   *  no-op touching nothing (same policy as World.step). */
  step(dt: number, currentX: number, fish: readonly MovingBody[]): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const dt2 = dt * dt;
    // Verlet integration: x' = x + (x − px)·damping + a·dt².
    // Point 0 is the pinned anchor: it never integrates.
    for (let i = 1; i < this.points.length; i++) {
      const p = this.points[i]!;
      const vx = (p.x - p.px) * KELP_DAMPING;
      const vy = (p.y - p.py) * KELP_DAMPING;
      p.px = p.x;
      p.py = p.y;
      p.x += vx + currentX * dt2;
      p.y += vy - KELP_GROWTH * dt2;
    }
    this.dragByFish(dt, fish);
    // Constraint solve: pin the anchor, relax each segment to its
    // rest length, then apply the soft base-orientation pull as
    // the pass's LAST WORD (a later constraint pass could otherwise
    // dilute it — a diluted base spring cannot price tipping).
    for (let iter = 0; iter < KELP_CONSTRAINT_ITERS; iter++) {
      const anchor = this.points[0]!;
      anchor.x = this.anchorX;
      anchor.y = this.anchorY;
      for (let i = 1; i < this.points.length; i++) {
        this.satisfy(this.points[i - 1]!, this.points[i]!);
      }
      const base = this.points[1]!;
      base.x += (this.baseRestX - base.x) * KELP_ANCHOR_PULL;
      base.y += (this.baseRestY - base.y) * KELP_ANCHOR_PULL;
    }
  }

  /** Fish → kelp coupling: each fish drags every point inside
   *  KELP_FISH_RADIUS along its own velocity, scaled by the
   *  named gain and a linear (1 − d/R) falloff. Displacement per
   *  step is bounded by gain × speed × dt, so a fast fish whips
   *  the strand while a slow one barely stirs it. */
  private dragByFish(dt: number, fish: readonly MovingBody[]): void {
    const r2 = KELP_FISH_RADIUS * KELP_FISH_RADIUS;
    for (const f of fish) {
      const fx = f.vx * dt;
      const fy = f.vy * dt;
      if (fx === 0 && fy === 0) continue;
      for (let i = 1; i < this.points.length; i++) {
        const p = this.points[i]!;
        const ex = p.x - f.x;
        const ey = p.y - f.y;
        const d2 = ex * ex + ey * ey;
        if (d2 >= r2) continue;
        const falloff = 1 - Math.sqrt(d2) / KELP_FISH_RADIUS;
        p.x += fx * KELP_FISH_PUSH_GAIN * falloff;
        p.y += fy * KELP_FISH_PUSH_GAIN * falloff;
      }
    }
  }

  /** Relax segment (a, b) to the rest length: split the correction
   *  between the endpoints, giving the pinned anchor zero weight
   *  (b is never pinned — only points[0] is). */
  private satisfy(a: KelpPoint, b: KelpPoint): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    if (d === 0) return; // coincident points: no defined correction direction
    const diff = (d - this.restLength) / d;
    const wA = a === this.points[0] ? 0 : 0.5;
    const wB = a === this.points[0] ? 1 : 0.5;
    a.x += dx * diff * wA;
    a.y += dy * diff * wA;
    b.x -= dx * diff * wB;
    b.y -= dy * diff * wB;
  }
}

/** Angle (radians, 0 = perfectly vertical) between the anchor→tip
 *  chord and straight up — the "hangs vertical" and "leans in the
 *  current" measurements the tests take on the strand's tip. A
 *  degenerate (zero-length) chord reads 0. */
export function tipDeviationFromVertical(strand: KelpStrand): number {
  const tip = strand.points[strand.points.length - 1]!;
  const vx = tip.x - strand.anchorX;
  const vy = tip.y - strand.anchorY; // negative: the strand points UP
  const len = Math.hypot(vx, vy);
  if (len === 0) return 0;
  // cos θ of the chord against the UP axis (0, −1): clamp for
  // near-degenerate chords so acos cannot receive a tiny |x| > 1.
  const cos = Math.max(-1, Math.min(1, -vy / len));
  return Math.acos(cos);
}
