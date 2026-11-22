// ================================================================
// Dropped food & tap-glass state (PRD §3, #121): the data shapes
// the World carries for the two new toolbar tools, plus the PURE
// pellet integrator (drag + subtle water current) the world's
// fixed step applies to every survivor. No world access, no
// hidden state — the integrator is the unit under test in
// tests/fishtank-pellets.test.mjs and is deterministic by
// construction (explicit dt, explicit current, in-place mutation
// of exactly the one pellet it is handed).
// ================================================================

import { PELLET_DRAG, PELLET_GRAVITY } from "./constants.ts";

/** A sinking food flake in tank units. Velocity is in tank
 *  units/s; a fresh pellet is dropped at rest (vx = vy = 0) and
 *  the water does the rest. */
export interface Pellet {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** The tap-glass shockwave ring: the epicentre in tank units plus
 *  the CURRENT radius (the world grows it each fixed step). Alpha
 *  for rendering is a pure function of radius — no separate age
 *  channel to desynchronize. */
export interface Shockwave {
  x: number;
  y: number;
  radius: number;
}

/** Advance ONE pellet exactly dt seconds: gravity pulls it down,
 *  linear drag opposes the velocity in both axes, and the ambient
 *  horizontal current pulls vx toward the water's own flow
 *  (units/s — the water drifts, the pellet relaxes to it). The
 *  semi-implicit Euler form (update the velocity first) is stable
 *  for dt up to well past FIXED_DT and keeps the sink speed
 *  asymptotic to PELLET_TERMINAL_V from below. Mutates `p` in
 *  place; returns nothing. */
export function stepPellet(p: Pellet, dt: number, currentX: number): void {
  p.vy += (PELLET_GRAVITY - PELLET_DRAG * p.vy) * dt;
  p.vx += (currentX - PELLET_DRAG * p.vx) * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
}
