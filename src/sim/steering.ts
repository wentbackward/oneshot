// ================================================================
// Craig Reynolds steering forces (PRD §2): the six behaviours every
// species composes from — separation, alignment, cohesion, boundary
// avoidance, obstacle avoidance and target seeking.
//
// Contract (pinned by tests/fishtank-steering.test.mjs):
//  - every force is a PURE function returning a fresh Vec2; inputs
//    are never mutated and no hidden state is kept;
//  - the returned magnitude NEVER exceeds the force's named clamp
//    constant, and every per-force clamp is at or under the master
//    MAX_STEERING_FORCE;
//  - alignment is the mean neighbour HEADING (unit vectors averaged,
//    so fast and slow neighbours vote equally);
//  - boundary avoidance ramps linearly from 0 at the margin edge to
//    full strength AT the wall, and points strictly inward;
//  - degenerate inputs (empty lists, coincident positions, zero
//    velocity, absurd magnitudes, points outside the domain) yield
//    finite results, never NaN.
// ================================================================

/** A 2-D vector in logical tank units. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Anything that swims: a position plus a heading (velocity). */
export interface MovingBody extends Vec2 {
  vx: number;
  vy: number;
}

/** A circular collision obstacle (a placed rock). */
export interface Obstacle extends Vec2 {
  r: number;
}

// ---------- named tuning values ----------

/** Master force limit: no per-force clamp may exceed this. */
export const MAX_STEERING_FORCE = 120;

/** Per-force clamps (tank units of acceleration, per fixed step). */
export const MAX_SEPARATION_FORCE = 90;
export const MAX_ALIGNMENT_FORCE = 1; // alignment is a heading average: unit scale
export const MAX_COHESION_FORCE = 60;
export const MAX_BOUNDARY_AVOIDANCE_FORCE = MAX_STEERING_FORCE;
export const MAX_OBSTACLE_AVOIDANCE_FORCE = 100;
export const MAX_SEEK_FORCE = 100;

/** Frenemies within this distance repel each other (matches the
 *  grid cell edge, so one 3×3 cell probe covers the whole radius). */
export const NEIGHBOUR_RADIUS = 64;

/** How hard a body steers toward its neighbours' centroid per unit
 *  of distance. */
export const COHESION_GAIN = 0.05;

/** How close to a wall a body must come before being pushed back;
 *  the push ramps linearly to full strength AT the wall. */
export const BOUNDARY_MARGIN = 120;

/** How far ahead of a rock a body starts curving away from it. */
export const OBSTACLE_AVOID_DISTANCE = 150;

/** Cruise speed a seeking body aims for (Reynolds "desired"). */
export const FISH_MAX_SPEED = 80;

// ---------- small vector helpers (allocation-light by design) ----------

function zero(): Vec2 {
  return { x: 0, y: 0 };
}

/** Scale the vector to at most maxLength, preserving direction.
 *  A zero vector passes through untouched. */
function clampLength(v: Vec2, maxLength: number): Vec2 {
  const len = Math.hypot(v.x, v.y);
  if (len === 0) return v;
  if (len <= maxLength) return v;
  const s = maxLength / len;
  return { x: v.x * s, y: v.y * s };
}

/** Unit vector of (x, y), or (0, 0) when the length is zero. */
function unit(x: number, y: number): Vec2 {
  const len = Math.hypot(x, y);
  return len === 0 ? zero() : { x: x / len, y: y / len };
}

// ---------- the six forces ----------

/** Separation: steer AWAY from frenemies, weighted 1/d² so the
 *  closer they press the harder they push. */
export function separation(self: MovingBody, neighbours: MovingBody[]): Vec2 {
  const sum = zero();
  const r2 = NEIGHBOUR_RADIUS * NEIGHBOUR_RADIUS;
  for (const n of neighbours) {
    const dx = self.x - n.x;
    const dy = self.y - n.y;
    const d2 = dx * dx + dy * dy;
    if (d2 === 0 || d2 > r2) continue; // coincident or out of radius: no defined push direction / no influence
    sum.x += dx / d2;
    sum.y += dy / d2;
  }
  return clampLength(sum, MAX_SEPARATION_FORCE);
}

/** Alignment: the mean neighbour HEADING. Each neighbour votes with
 *  its unit heading, so a fast neighbour cannot drown the school;
 *  still neighbours cast no vote. */
export function alignment(neighbours: MovingBody[]): Vec2 {
  const sum = zero();
  let votes = 0;
  for (const n of neighbours) {
    const h = unit(n.vx, n.vy);
    if (h.x === 0 && h.y === 0) continue;
    sum.x += h.x;
    sum.y += h.y;
    votes += 1;
  }
  if (votes === 0) return zero();
  return clampLength({ x: sum.x / votes, y: sum.y / votes }, MAX_ALIGNMENT_FORCE);
}

/** Cohesion: steer TOWARD the neighbours' centroid, proportional to
 *  how far away it is. */
export function cohesion(self: MovingBody, neighbours: MovingBody[]): Vec2 {
  if (neighbours.length === 0) return zero();
  let cx = 0;
  let cy = 0;
  for (const n of neighbours) {
    cx += n.x;
    cy += n.y;
  }
  const toCentroid = { x: cx / neighbours.length - self.x, y: cy / neighbours.length - self.y };
  return clampLength(
    { x: toCentroid.x * COHESION_GAIN, y: toCentroid.y * COHESION_GAIN },
    MAX_COHESION_FORCE,
  );
}

/** Boundary avoidance: each wall within BOUNDARY_MARGIN pushes
 *  inward, linearly harder the closer the body gets — a body AT the
 *  wall gets the full push. Inward means: +x from the left wall,
 *  −x from the right, +y from the top (y grows downward), −y from
 *  the bottom. */
export function boundaryAvoidance(pos: Vec2, width: number, height: number): Vec2 {
  const f = zero();
  if (pos.x < BOUNDARY_MARGIN) f.x += ((BOUNDARY_MARGIN - pos.x) / BOUNDARY_MARGIN) * MAX_BOUNDARY_AVOIDANCE_FORCE;
  if (pos.x > width - BOUNDARY_MARGIN) f.x -= ((pos.x - (width - BOUNDARY_MARGIN)) / BOUNDARY_MARGIN) * MAX_BOUNDARY_AVOIDANCE_FORCE;
  if (pos.y < BOUNDARY_MARGIN) f.y += ((BOUNDARY_MARGIN - pos.y) / BOUNDARY_MARGIN) * MAX_BOUNDARY_AVOIDANCE_FORCE;
  if (pos.y > height - BOUNDARY_MARGIN) f.y -= ((pos.y - (height - BOUNDARY_MARGIN)) / BOUNDARY_MARGIN) * MAX_BOUNDARY_AVOIDANCE_FORCE;
  return clampLength(f, MAX_BOUNDARY_AVOIDANCE_FORCE);
}

/** Obstacle avoidance: steer AROUND circular rocks. Each rock whose
 *  surface comes within OBSTACLE_AVOID_DISTANCE of the body pushes
 *  straight away from its centre, harder the closer it gets; a rock
 *  the body is already inside pushes straight out. */
export function obstacleAvoidance(self: MovingBody, obstacles: Obstacle[]): Vec2 {
  const sum = zero();
  for (const o of obstacles) {
    const dx = self.x - o.x;
    const dy = self.y - o.y;
    const d = Math.hypot(dx, dy);
    const reach = d + OBSTACLE_AVOID_DISTANCE;
    if (reach <= 0) continue;
    const w = 1 - (d - o.r) / OBSTACLE_AVOID_DISTANCE;
    if (w <= 0) continue; // rock surface beyond sensing distance
    const dir = d === 0 ? { x: 1, y: 0 } : { x: dx / d, y: dy / d }; // centre-on-body: deterministic push out
    sum.x += dir.x * w;
    sum.y += dir.y * w;
  }
  return clampLength(sum, MAX_OBSTACLE_AVOIDANCE_FORCE);
}

/** Seek: steer toward a target at cruise speed (Reynolds: desired
 *  heading minus current velocity). Already at the target → no
 *  steering at all. */
export function seek(self: MovingBody, target: Vec2): Vec2 {
  const dx = target.x - self.x;
  const dy = target.y - self.y;
  const d = Math.hypot(dx, dy);
  if (d === 0) return zero();
  const desired = { x: (dx / d) * FISH_MAX_SPEED, y: (dy / d) * FISH_MAX_SPEED };
  return clampLength({ x: desired.x - self.vx, y: desired.y - self.vy }, MAX_SEEK_FORCE);
}
