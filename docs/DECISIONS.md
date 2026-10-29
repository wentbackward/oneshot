# Decision log

## 2025-10-29 — Ticket #2: scaffold, rAF loop, controllable ship

- **Tuning constants declared with `var`, not `const`.** The ticket's acceptance
  criterion requires reassigning `TURN_SPEED` from the browser console and
  observing the effect; a top-level `const` binding rejects reassignment.
  Alternatives: a frozen `TUNING` object (rejected — the criterion names bare
  globals `THRUST`/`FRICTION`/`TURN_SPEED`), or a `window.tune()` API
  (rejected — extra surface the PRD does not ask for).
- **Friction applied framerate-independently: `v *= FRICTION^(dt * 60)`, plus a
  snap-to-zero below `STOP_SPEED` (1 px/s).** Guarantees the "decays to
  stillness within 1 s" criterion holds even on slow frames, and leaves the
  ship exactly still instead of drifting forever. Alternatives: per-frame-only
  decay (breaks on non-60 Hz displays) or pure exponential decay (never
  reaches exactly zero).
- **Frame delta clamped to `MAX_FRAME_SECONDS` = 1/30 s.** Prevents the ship
  teleporting after a tab switch / long GC pause. Alternative: no clamp
  (rejected — violates "smooth 60 fps" spirit; clamping costs nothing).
- **Wrap margin uses `SHIP_RADIUS`:** the ship respawns on the opposite edge
  once fully off-screen, so no hull pops visible at the seam. Alternative:
  wrap on centre point (rejected — half the hull vanishes then reappears).
- **Down/S intentionally unmapped** — the ticket scopes movement to thrust
  (up/W) and rotation (left/right, A/D) only; reverse thrust is not in the
  PRD concept and stays for a later ticket if ever requested.

## 2025-10-30 — Ticket #3: lasers with spacebar firing and cooldown

- **`LASER_COOLDOWN_MS` / `LASER_SPEED` declared with `var` (150 ms / 700 px/s defaults).**
  Matches the ticket-#2 precedent: the acceptance criterion requires reassigning the
  cooldown from the browser console, which a `const` binding rejects. `LASER_SPEED` is a
  tuning knob in the same family, so it keeps the same mutability. `LASER_POOL_SIZE`
  (32) and `LASER_LENGTH` (18 px) are structural, so `const`.
- **Holding Space auto-fires, gated by the cooldown** ("sustained fire at least 5
  lasers/s" implies repeat fire without re-pressing; 150 ms at 60 fps ≈ 6–7 shots/s).
  Alternatives: one-shot-per-keypress (violates criterion 3), edge-triggered taps with
  an `e.repeat` bypass (same effect, more code).
- **Beam spawns just past the hull tip** (`SHIP_RADIUS + LASER_LENGTH/2` along the
  heading) so it never overlaps the nose on frame one; travels on the unit heading
  vector recorded at fire time, so bank-and-shoot keeps the beam straight.
- **Recycle only once the beam is fully off-screen** (center ± `LASER_LENGTH` past the
  viewport), mirroring the ship-wrap-margin rule. Alternative: cull on center point
  (rejected — a sliver of beam vanishes visibly at the edge).
- **Exhausted pool skips the shot instead of stealing the oldest beam.** A dropped
  *tracked* laser corrupts later collision tests; a dropped *new* shot is invisible.
  32 slots cover normal fire at any sane cooldown (700 px/s × 150 ms ≈ 105 px between
  beams → ≤ ~11 in flight across a tall screen). Only pathological console tunes
  (e.g. `LASER_SPEED = 0`) can saturate the pool, and the wait-for-slot behaviour
  keeps the pool fixed-size by construction.
- **Cooldown measured on accumulated simulation time** (`gameTime`), not the wall
  clock: survives tab-switch frame clamps and makes fire-rate deterministic under
  the node/vm unit tests.

## 2026-10-29 — Ticket #4: asteroids with laser kills and score

- **Pre-allocated 48-slot asteroid pool, mutated in place (incl. the polygon
  outline array).** Mirrors the laser-pool precedent from ticket #3: spawning
  and respawning never allocate, keeping the hot path GC-free. Alternative:
  grow/shrink an array (rejected — allocation churn, the PRD's 60 fps rule).
- **`ASTEROID_TARGET` / `SCORE_PER_ASTEROID` are mutable `var`s; structural
  sizes (`SPAWN_SAFE_RADIUS`, `ASTEROID_POOL_SIZE`, radii, speeds) are `const`.**
  The criteria reassign the target and per-kill value from the "console";
  everything else is gameplay structure. 48 slots give 8× headroom over the
  default target of 6 so console retunes can't saturate the pool quickly.
- **Spawns just outside a random edge, aimed at the field centre with a ±60°
  jitter.** Rejected candidates: start closer than `SPAWN_SAFE_RADIUS` (200) to
  the ship, or within `r + other.r + 40` of a live rock. Up to 8 retries per
  attempt slot, one attempt slot per `ASTEROID_SPAWN_EVERY` (0.25 s), so a
  pathological field (ship parked on an edge) costs nothing. Alternative:
  spawn anywhere with the safe-disc check only (weaker — rocks could pop in
  view), or reject-and-give-up silently (field starves while the player camps).
- **Random source is a mutable `var random = Math.random`** that the game only
  ever calls. Lets the vm unit tests install deterministic sequences (and makes
  the spawn logic reproducible) without changing gameplay. Alternative:
  injectable constructor args (rejected — no module system; single file must
  stay directly openable in a browser).
- **Laser hits use a sweeping segment test (previous position reconstructed
  from the stored frame dt vs. the rock centre).** A 700 px/s beam moves
  11.7 px/frame; point-vs-point would tunnel through thin rocks on clamped
  frames. Cost: one distance-per-active-laser-per-rock check — trivial at the
  pool sizes. Alternative: substep the beam (rejected — more code for a
  problem the segment test already covers).
- **Score is a plain `let score = 0` rendered as canvas text top-left
  ("SCORE n").** The PRD wants a live score; the HUD text is the cheapest
  live display and is verifiable via the ctx stub. Alternative: a DOM element
  overlay (rejected — extra markup/state the single-canvas design avoids until
  a later ticket introduces lives/waves, which will extend this HUD).
