// =========================================================// Simulation constants — named tuning values for the fishtank
// fixed-timestep engine (PRD §1).
// =========================================================
/** Fixed physics timestep in seconds: the world always advances in
 *  exact multiples of this (60 Hz), independent of frame pacing. */
export const FIXED_DT = 1 / 60;

/** Logical tank extent in tank units (rendering maps it to the
 *  viewport). Defined HERE (not in world.ts) so leaf sim modules
 *  like predator.ts can depend on the arena without an import
 *  cycle; world.ts re-exports both for existing importers. */
export const TANK_WIDTH = 1600;
export const TANK_HEIGHT = 1000;

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

// ---------- apex predator (PRD §2's third behaviour, #124) ----------

/** Speed of the predator's waypoint patrol, tank units/s — patrol
 *  speed never exceeds this. A full 2400-unit lap (plus the 360-
 *  unit walk-in from the spawn) fits inside the 600-step patrol
 *  test window at this speed. */
export const PREDATOR_PATROL_SPEED = 340;

/** Stalk speed, tank units/s: deliberately ABOVE TETRA_MAX_SPEED,
 *  so every chase closes on any prey (minimum closure
 *  PREDATOR_STALK_SPEED − TETRA_MAX_SPEED = 160 u/s). */
export const PREDATOR_STALK_SPEED = 380;

/** Rest drift speed, tank units/s: a slow, purposeless glide.
 *  Above TETRA_MIN_SPEED so the resting animal never reads as
 *  dead. */
export const PREDATOR_REST_SPEED = 30;

/** Hunger gain per second; hunger lives in [0, 1] and rises even
 *  during rest (a feed resets it to 0). At this rate a fresh belly
 *  reaches the stalk threshold in ≈ 11.7 s of sim time. */
export const PREDATOR_HUNGER_RATE = 0.06;

/** The hunger level at which the predator will stalk an isolated
 *  tetra in sight. The rest window (PREDATOR_REST_STEPS steps =
 *  4 s) only recovers ≈ 0.24 of hunger, so a recently-fed
 *  predator provably cannot re-stalk during it. */
export const PREDATOR_STALK_THRESHOLD = 0.7;

/** How far the predator detects prey, tank units. */
export const PREDATOR_SIGHT_RANGE = 400;

/** A tetra is prey-eligible ("isolated") only when no other tetra
 *  lies within this radius: schools are safe, stragglers are not.
 *  Wider than the tetras' personal NEIGHBOUR_RADIUS (64) so the
 *  rule reads at swimming scale. */
export const PREDATOR_ISOLATION_RADIUS = 160;

/** Prey within this distance is captured, tank units. */
export const PREDATOR_CAPTURE_RADIUS = 28;

/** Fixed steps the predator rests after a feed; patrol resumes on
 *  the boundary step that counts the window down to zero. */
export const PREDATOR_REST_STEPS = 240;

/** Closed-ball arrival radius around a patrol waypoint, tank
 *  units — generous against the 340 u/s × 1/60 s ≈ 5.7-unit step,
 *  tight enough to make each stop individually attributable. */
export const PREDATOR_WAYPOINT_TOLERANCE = 48;
// ---------- dropped food & tap-glass (PRD §3, #121) ----------

/** Tank capacity: at most this many live (uneaten, unsettled)
 *  pellets, enforced by World.dropFood(). Pinned by
 *  tests/fishtank-food-toolbar.test.mjs. */
export const PELLET_MAX = 64;

/** Visual/body radius of a pellet (tank units): a small flake. */
export const PELLET_RADIUS = 5;

/** Sinking acceleration on a pellet, tank units/s². */
export const PELLET_GRAVITY = 120;
/** Linear drag coefficient (1/s) opposing the pellet's velocity in
 *  BOTH axes: the water's resistance. The integrator relaxes vy to
 *  the terminal PELLET_GRAVITY / PELLET_DRAG and vx to the current's
 *  equilibrium flow `currentX / PELLET_DRAG` (units/s) over the
 *  same time scale. */
export const PELLET_DRAG = 2;
/** Terminal sink speed, tank units/s — the drag balance of gravity
 *  (PELLET_GRAVITY / PELLET_DRAG). The integrator approaches it from
 *  below, never above; pinned by tests/fishtank-pellets.test.mjs. */
export const PELLET_TERMINAL_V = PELLET_GRAVITY / PELLET_DRAG;

/** How far a tetra SENSES a pellet and homes on it (tank units):
 *  the food-seeking perception, deliberately narrower than the
 *  school perception so food competes with, and usually wins over,
 *  schooling forces at this range. */
export const PELLET_SENSE_RADIUS = 120;

/** Tetra→pellet contact distance: at (or under) this gap the
 *  nearest claiming tetra eats the pellet. Inside PELLET_SENSE_
 *  RADIUS by construction. */
export const PELLET_EAT_RADIUS = 16;

/** Expanding shockwave ring growth rate (tap glass), tank units/s.
 *  30 fixed frames (0.5 s) take the ring to 200 units — strictly
 *  growing yet clear of SHOCKWAVE_RING_MAX_RADIUS, pinned by
 *  tests/fishtank-food-toolbar.test.mjs. */
export const SHOCKWAVE_RING_SPEED = 400;
/** Radius at which a ring is retired (fully expanded, tank units).
 *  A ring lives SHOCKWAVE_RING_MAX_RADIUS / SHOCKWAVE_RING_SPEED =
 *  0.75 s of sim time. */
export const SHOCKWAVE_RING_MAX_RADIUS = 300;
/** Live rings the world keeps at most: new rings are REFUSED at
 *  the cap (the startle still fires — the scare is never denied). */
export const SHOCKWAVE_MAX_RINGS = 16;

// ---------- placement tools: rocks & kelp (PRD §3) ----------

/** Tank capacity: at most this many placed rocks… */
export const ROCK_MAX = 24;
/** …and at most this many placed kelp strands (PRD §3 caps).
 *  Pinned by tests/fishtank-rocks.test.mjs / -placement.test.mjs. */
export const KELP_MAX = 32;

/** Body of a placed rock: a smooth river-rock CIRCLE of this
 *  radius (tank units) — uniform circles keep collision and
 *  rendering trivial and honest. */
export const ROCK_RADIUS = 40;

/** Clearance a fish keeps beyond a rock's surface (tank units):
 *  the hard collision radius is `rock.r + ROCK_COLLIDE_PAD`, and
 *  the 600-step soak (tests/fishtank-rocks.test.mjs) pins that no
 *  tetra ever enters it. */
export const ROCK_COLLIDE_PAD = 6;

/** Extra pick radius around a rock's surface that remove mode
 *  accepts (tank units) — the clickable target, not the body. */
export const ROCK_PICK_SLACK = 24;

/** Remove-mode pick width around a kelp anchor's x (tank units). */
export const KELP_PICK_SLACK = 24;

/** Vertical reach of the kelp pick (tank units): only a click
 *  inside this band above the substrate (y ≥ TANK_HEIGHT −
 *  KELP_PICK_BAND) may strike a strand, so a remove click on open
 *  water high above it cannot. Sized to cover the anchor plus the
 *  BASE SEGMENTS' SWEEP: the three base segments rest
 *  3 × (KELP_TOTAL_LENGTH / KELP_SEGMENTS) ≈ 83 units up, and the
 *  base of the chain flexes well beyond that under fish drag and
 *  current — so 140 comfortably brackets everything a click is
 *  expected to hit. */
export const KELP_PICK_BAND = 140;

/** Per-placement seed stride for kelp strands: strand N draws from
 *  `worldSeed + KELP_SEED_STRIDE · N`, so consecutive strands get
 *  disjoint, well-mixed PRNG streams. */
export const KELP_SEED_STRIDE = 104729;

// ---------- kelp strands: multi-segment verlet (PRD §3/§5) ----------

/** Verlet segments per strand — ≥ 6 required (PRD §3), pinned by
 *  tests/fishtank-kelp.test.mjs. */
export const KELP_SEGMENTS = 8;
/** Total strand length in tank units; the segments tile it evenly,
 *  so each segment's rest length is KELP_TOTAL_LENGTH /
 *  KELP_SEGMENTS. */
export const KELP_TOTAL_LENGTH = 220;
/** Upward growth / buoyancy acceleration on every free point (tank
 *  units/s², −y). It pre-tensions the strand against the substrate
 *  anchor, so a folded strand is a distance-violation and the
 *  upright shape is the stable one (a bottom-anchored strand under
 *  net-downward force would be an inverted pendulum: neutrally
 *  stable at best, and it topples). The substrate pin then only
 *  has to carry the top of a straight, taut strand. */
export const KELP_GROWTH = 150;
/** Soft base-orientation pull: each iteration nudges point 1 back
 *  toward the rest point on the substrate ray (fraction 0..1).
 *  Tipping the strand costs this spring, so the strand always
 *  recovers to vertical after a disturbance (fish passes, flow
 *  gusts) instead of staying pinned at whatever angle it ended up. */
export const KELP_ANCHOR_PULL = 0.3;
/** Fraction of a point's previous-step velocity retained (verlet
 *  damping): 0.985 bleeds out sway oscillation in ≈ 2–3 s. */
export const KELP_DAMPING = 0.985;
/** Distance-constraint passes per fixed step. Eight passes settle
 *  the chain to << KELP_TOL length error (pinned by the soak). */
export const KELP_CONSTRAINT_ITERS = 8;
/** Seeded horizontal spawn jitter per point (tank units): a
 *  strand is born almost vertical, not laser-straight. */
export const KELP_JITTER = 2;
/** Settle tolerance (PRD §5): after 600 relaxed zero-current
 *  steps every segment length sits within 1 ± KELP_TOL of its
 *  rest length. */
export const KELP_TOL = 0.02;
/** Rest tolerance: after 600 relaxed zero-current steps the
 *  strand hangs within this angle (radians) of straight vertical.
 */
export const KELP_REST_ANGLE_TOL = 0.05;

/** Ambient current: a constant horizontal flow applied as
 *  acceleration to every kelp point (tank units/s², +x). */
export const AMBIENT_CURRENT_X = 40;
/** Required response: with the ambient current on, a settled
 *  strand's tip must lean beyond this angle (radians) from
 *  vertical. Calibrated ≈ 2.2× below the measured lean of
 *  (current 40 vs growth 150) so the check has real margin. */
export const KELP_CURRENT_TIP_DEVIATION_MIN = 0.10;

/** Fish → kelp coupling: a kelp point within KELP_FISH_RADIUS of
 *  a fish is dragged along the fish's velocity (falloff 1 − d/R).
 */
export const KELP_FISH_RADIUS = 48;
/** Drag coefficient: point displacement per (fish speed × dt ×
 *  falloff), tank units. */
export const KELP_FISH_PUSH_GAIN = 2.0;
