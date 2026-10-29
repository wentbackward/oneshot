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
- **Jitter span is exactly ±60°, matching the inline comment** — `(random() -
  0.5) * (2π/3)`. Review round 1 caught the original `(4π/3)` span (±120°);
  the code is now what the docs always claimed. Alternative: widen the docs to
  ±120° (rejected — near-corner spawns would often point away from the field).
- **Wrap-around is suspended per-rock until its centre crosses the spawn edge
  into the field (`entry` field on the pool slot).** The spawn offset
  (`±(r+1)`) is deliberately smaller than a full radius, so the classic
  “fully off → wrap” rule teleported every fresh rock to the opposite edge on
  the next frame. Suppression lifts once the centre is inside; from then on
  normal torus wrap applies (an exiting rock’s velocity already points into
  the field at its new edge, so no double-wrap). Alternative: raise the wrap
  trigger to a band wider than the max per-frame step (reviewer’s suggestion;
  rejected on its own — a rock that exits and continues outward re-crosses the
  band immediately and re-wraps every frame, and an outward-drifting spawner
  orbits forever).
- **Guaranteed inward entry: the outward component of the spawn velocity is
  mirrored if the jitter aimed the rock back out along the spawn edge.** With
  ±60° jitter near a screen corner the raw heading can point away from the
  field; such a rock would then never settle (entry suppression would suspend
  its wrap indefinitely) and silently eat a pool slot. Flipping the normal
  component keeps speed, angle variety and one branch per edge. Alternative:
  reject-and-retry those headings (extra RNG draws per spawn) or clamp the
  jitter cone per edge (less natural distribution).
- **Collision and wrap use the circumscribed radius `r`, although the polygon
  vertices are `0.75r–1.0r`.** A beam hitting within `r` of the centre kills
  the rock even in the concave gaps between spikes — up to ~25% overshoot at
  the corners. Kept as a deliberate simplification: one scalar per rock is
  cheap in the hot loop, reads generously (“you hit it”), and the mismatch is
  smaller than the laser’s own length. Alternative: point-in-polygon or
  per-vertex segment tests (more code, tighter feel — revisit if gameplay
  tuning complains).
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

## 2026-10-29 — Ticket #5: damage ship on collision with particle bursts

- **A rock that hits the hull is destroyed (shattered), matching the laser
  kill rule.** The ticket's browser check parks the ship inside an asteroid
  for 3 s expecting no repeated drain; if the rock survived, it would legally
  re-hit the instant the 1500 ms window lapses, and "flying through a second
  hazard" reads as a distinct rock. One impact, one rock, one hp — also keeps
  the burst a single source. Alternative: rock survives and only
  invulnerability prevents the repeat (rejected — the 3 s park would then cost
  2 hp, contradicting the verification, and leaves the ship parked on a
  hazard).
- **One damage event per frame even when several rocks overlap:** the hit
  scan returns after the first contact. The criterion says "decrements HP by
  exactly 1" per overlap; charging per rock in a dense cluster would punish
  spawn crowding, not skill. Alternative: charge once per rock (rejected —
  harsher and still unspecified).
- **Invulnerability is an absolute sim-time threshold (`invulnUntil = gameTime
  + INVULN_MS/1000`)** checked at the top of the hit scan; while immune the
  hazard is left intact and simply ignored, so a rock met mid-window still
  hits once the window elapses (documented and tested). The ship blinks
  (6 Hz dimming via `globalAlpha`) to make the window visible in play. The
  ship explodes at the overlap mid-point; hp clamps at 0 and `shipDead`
  latches. Alternative: a countdown variable (equivalent; threshold form
  needs no per-frame mutation and compares in one op).
- **Burst = 16 particles from a 128-slot pool (`particlePool`), 0.7 s life,
  60–260 px/s, amber 4 px squares fading linearly.** 16 ≥ the required 10;
  the pool size covers ~8 simultaneous bursts with headroom, and `burst()`
  silently caps at pool capacity instead of allocating (mirrors the
  laser/asteroid pool discipline). Particles update even after death so the
  final explosion finishes on the GAME OVER screen. Alternative: 10 exactly
  (too sparse) or 32+ (allocation-churn risk on dense fights).
- **Death removes only the ship, not the world:** ship physics, firing,
  hull checks and the ship's sprite are skipped; lasers, asteroids, HUD and
  the static centred "GAME OVER" text keep running. Input handlers stay
  registered but act on nothing, satisfying "all input is ignored" without
  adding a restart path — screens/restart belong to the state-machine
  ticket. Alternative: freeze the whole sim (rejected — the ticket scopes
  the final screen styling to the later ticket; a drifting field behind
  GAME OVER is standard arcade behaviour and costs zero).

## 2026-10-29 — Ticket #6: chasing drones that lasers can destroy

- **Tuning defaults (spec-silent):** `DRONE_TARGET = 3`, `DRONE_RADIUS = 10 px`,
  `DRONE_SPEED = 120 px/s`, `DRONE_TURN_SPEED = 2.4 rad/s`, spawn cadence 0.35 s
  from a 24-slot pool. Three chasers alongside six rocks keeps the field busy
  without doubling threat density; the speed sits at the asteroid median so a
  drone is evadable but cannot be outrun indefinitely; 2.4 rad/s (~14°/frame
  at 60 fps) turns a full 180° in ~1.3 s — a slow-enough turn to dodge,
  fast enough to make the ticket's "distance decreases each second" criterion
  hold against a parked ship. `DRONE_SPEED` is a `var` like `LASER_SPEED` so
  console tunes (and the hermetic unit tests) can retune it. Alternatives:
  faster/accelerating pursuit (rejected — punishing and makes the bounded
  turn harder to verify) or per-frame steering with lookahead (rejected —
  more math, no ticket requirement).
- **Pursuit = pure proportional turn toward the ship, no acceleration and no
  screen wrap.** The heading rotates at most `DRONE_TURN_SPEED * dt` toward
  `atan2(ship - drone)` each frame (the bounded-turn criterion), and the
  drone advances straight at constant speed. Drones never wrap: wrapping a
  chaser would teleport it through the ship's defences, and a pursuing body
  does not need edge recycling — off-field excursions (possible only after
  the ship dies, since a live ship always re-attracts them) are tolerable.
  After the ship dies, drones keep chasing the frozen last ship position:
  zero extra branching, the world keeps moving behind GAME OVER exactly like
  the drifting rocks. Alternative: deactivate drones on death (extra state
  machine, no visible benefit).
- **Spawning reuses the asteroid pattern:** fixed radius, random edge just
  outside the field, rejected within `SPAWN_SAFE_RADIUS` of the ship (the
  existing constant, not a new one — drones are just another hazard class),
  born facing the ship, capped at `DRONE_TARGET` with a per-frame attempt
  budget. No minimum-gap check between drones: unlike rocks they converge on
  one point anyway, so spacing would only fight the behaviour. Alternative:
  spawn at a random distance off-screen (rejected — the ticket says "from
  edges", and the edge fixture makes the spawn point testable).
- **Hull impact destroys the drone**, mirroring the rock-shatter rule from
  ticket #5 (one impact, one hazard consumed, one hp, burst at the overlap
  mid-point, INVULN_MS window). Leaving the drone to re-touch next frame
  would make the window the only protection and would contradict the "same
  hit pipeline as asteroid collisions" wording. The scan checks rocks first,
  then drones, and still takes at most one damage event per frame, so a
  rock + drone pair overlapping in one frame costs exactly 1 hp.
  Alternative: drone survives hull contact (rejected — asymmetric with the
  rock rule and harsher for no reason).
- **A laser kill credits `SCORE_PER_DRONE` (default 25) AND fires the shared
  particle burst; an asteroid laser kill still does not burst.** The ticket
  explicitly asks for the shared burst on drone kills, but the established
  asteroid behaviour predates it and this ticket does not ask to change it,
  so the two kill types stay intentionally asymmetric until tuning says
  otherwise. Same sweep-segment test as rocks (no tunnelling), one pass over
  both hazard pools per beam — the old `checkAsteroidHits` became
  `checkLaserKills`. Alternative: burst both kill types (out of scope, would
  rewrite #4's verified behaviour).
- **Existing suites that assume a rock-only world now set
  `DRONE_TARGET = 0` in setup** (three ship-damage tests, three asteroids
  score tests). Their assertions are absolute (exact score, no drain over
  3 s, no `translate` calls after death) and would be flaked out or broken
  by default-spawning chasers; disabling auto-spawns there is the same
  hermeticity trick they already used for `ASTEROID_TARGET`. The drone
  suite itself keeps the default field where it must (spawn/cap test) and
  otherwise isolates via `quietField`.

## 2026-10-29 — Ticket #7: numbered waves with rising difficulty

- **Waves replace the steady-state targets: `ASTEROID_TARGET` and
  `DRONE_TARGET` are deleted, superseded by the per-wave rosters
  `ASTEROID_BASE + ASTEROID_GROWTH * (N-1)` (6 / +2) and
  `DRONE_BASE + DRONE_GROWTH * (N-1)` (0 / +1)**, exposed as the named
  functions `waveAsteroidCount`/`waveDroneCount` so the formula itself is
  unit-testable. Keeping the old knobs as dead or parallel paths would
  have left two sources of truth for one behaviour. All four new constants
  are mutable `var`s like every other tuning knob (the criterion reassigns
  `BETWEEN_WAVES_S` from the console). The gate greps in `.devloop.json`
  moved with the names (`ASTEROID_TARGET`/`DRONE_TARGET` → `*_BASE`,
  `*_GROWTH`, plus a new `BETWEEN_WAVES_S` check).
- **A wave's roster is a fixed set, built through the existing spawners:
  `waveBuilt` counts spawns since the wave started, and top-up only runs
  while `waveBuilt < waveTotal(wave)`.** Destroyed hazards are never
  replaced mid-wave — that is what makes "destroying every hazard ends the
  wave" reachable at all (a continuous top-up to a constant could be
  outrun, at best, and a mid-wave respawn would resurrect the player's own
  kills); this holds while the wave's clamped roster fits its pools —
  with no free pool slot, no replaced hazard could spawn at all.
  Alternative: keep top-up running and declare the wave cleared
  when the count hits zero (rejected — with live respawns the field never
  reliably empties, and a burst of quick kills would end the wave before
  its roster even materialised).
- **Completion requires `waveBuilt >= total` AND zero live hazards, and a
  zero-sized roster can never complete.** The `waveBuilt` gate stops a
  wave from being "cleared" while its roster is still building (e.g. the
  player wipes out the first two rocks of a six-rock wave); the `total > 0`
  gate keeps hermetic zero-roster test setups — and a console tune to all
  zeros — from cycling through infinite empty waves. A zero roster simply
  holds the wave number steady. Alternative: a per-phase state machine
  (building/live/cleared; rejected — the two scalars plus the gates
  already encode it without a third state field).
- **Intermission is an absolute sim-time threshold
  (`intermissionEndsAt = gameTime + BETWEEN_WAVES_S`), checked at the top
  of `updateWaves`; `BETWEEN_WAVES_S = 0` flips on the very next frame,**
  i.e. ~16.7 ms after the detection frame — "immediately" by the game's
  own clock. The wave number is incremented by exactly `+= 1` in that one
  place, so the "+exactly one" criterion has a single code path to break.
  No hazards can exist during the pause (completion required zero), so the
  pause reads as an empty field by construction. Alternative: a
  frame-counter countdown (equivalent; the threshold form matches the
  `invulnUntil` precedent and needs no per-frame mutation).
- **The HUD gains a third left-column line, `WAVE n` at (16, 76)**, drawn
  with the existing SCORE/HP `fillText` batch — the PRD's wave counter is
  cheapest as canvas text and is verifiable through the ctx stub, exactly
  like the score and hull lines. Alternative: a DOM overlay (rejected —
  same reasons as recorded for the score in ticket #4).
- **Existing suites adapted, mirroring the ticket-#6 precedent:**
  `quietField`/`suppressSpawns` now zero all four roster constants
  (`ASTEROID_BASE = 0; ASTEROID_GROWTH = 0; DRONE_BASE = 0;
  DRONE_GROWTH = 0`); the asteroid population test re-anchors on
  `ASTEROID_BASE` (mid-wave reassignment still repopulates, because
  `waveBuilt < total` resumes when the roster grows); the drone cap test
  uses a rock-free world with `DRONE_BASE = 3, DRONE_GROWTH = 0` and
  asserts the field builds to 3 and never exceeds it (the exact final
  count is no longer meaningful — chasers die on the parked ship and new
  waves rebuild the roster, so the cap and the build are the invariants).
  The safe-radius soak now counts new-wave rosters instead of respawns.
  Alternatives: keeping `ASTEROID_TARGET` as a hidden multiplier over the
  roster (rejected — dead/parallel knob) or rewriting the wave machine as
  a module with injected config (rejected — no module system; the single
  file must stay directly openable).

## 2026-10-30 — Ticket #7 review round 1: pool-capacity clamps and a deterministic wave suite

- **Per-wave rosters are clamped to pool capacity: `waveTotal(n) =
  waveAsteroidCap(n) + waveDroneCap(n)` where the caps are
  `Math.min(waveAsteroidCount(n), ASTEROID_POOL_SIZE)` /
  `Math.min(waveDroneCount(n), DRONE_POOL_SIZE)`, applied at the two
  spawner caps and the completion check.** The raw formulas stay exposed
  as `waveAsteroidCount`/`waveDroneCount` (still unit-tested, still the
  source of truth for "what wave N calls for"); the caps are the
  *effective* rosters. Without them the ticket's own defaults deadlock
  at wave 23 (50 wanted > 48 slots): the wave never completes and
  cleared hazards respawn from the unreachable remainder. Alternative:
  grow the pools dynamically (rejected — allocates, breaks the pooled,
  no-churn rule) or leave it as a known limitation (rejected — a
  soft-lock on the default settings is a correctness bug, not a tuning
  quirk).
- **The wave behavioural suite is seeded, not corner-parked, for
  determinism:** `boot()` pins the game's `random` hook to a fixed
  `mulberry32` sequence (same self-contained-source factory as
  `tests/asteroids.test.mjs`), and `keepLast` additionally zeroes the
  survivors' drift. The corner-park assumption was false — a lone
  survivor can drift into the parked ship and shatter, flaking the
  "survivor is the only hazard" invariant. Seeding makes every
  roster-count wait reproducible, not just that one. Alternative: pin
  positions only (fragile — other waits still roll the RNG).
