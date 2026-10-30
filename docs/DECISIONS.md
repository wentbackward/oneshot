# Decision log

## 2025-10-29 — Ticket #2: scaffold, rAF loop, controllable ship

- **Tuning constants declared with `var`, not `const`/`let`.** The ticket's acceptance
  criterion requires reassigning `TURN_SPEED` from the browser console; a top-level `const`
  binding rejects reassignment, and a script-level `let` — though reassignable from the
  console — is a lexical global, not a property of `window`. The real benefit of `var`
  over `let` is that it exposes the binding as a `window` property, so each knob is
  stably addressable as `window.THRUST` & co. (corrected per review #2-2; see the
  Ticket #14 entry). Alternatives: a frozen `TUNING` object (rejected — the criterion names bare
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

## 2026-10-29 — Ticket #8: start screen, game over, and restart

- **A single `gameState` ("start" | "playing" | "gameover") gates the
  simulation, the movement/fire key buffer, and which screen renders.**
  `update()` runs `updateParticles` unconditionally, then returns early
  in any non-playing state, so the start screen is a static empty field
  and the game-over world is frozen. Alternative: per-system
  start/dead/overlay flags (rejected — three states across ~six
  systems; one variable plus two gates is the whole feature).
- **The world freezes at game over (hazards no longer drift behind the
  overlay), superseding ticket #5's "world keeps moving" detail.**
  `startGame` wipes every pool, so the frozen field serves nothing;
  skipping the hazard/wave updates behind the overlay is also cheaper
  and removes the oddity of waves quietly advancing on a corpse screen.
  The death burst still plays out, because particles tick in every
  state (the #5 behaviour the tests lock in). Alternatives: keep the
  world drifting (cost + confusion for no player-visible gain) or
  freeze particles too (rejected — the final explosion would hang
  mid-air on the overlay).
- **`startGame()` is the one reset path, shared by first start and
  restart:** it deactivates every laser/asteroid/drone/particle slot,
  centres the ship at rest pointing up, and restores hull, score, wave,
  `waveBuilt`, intermission and all the cooldown/spawn timestamps.
  Zero live entities after restart is therefore true by construction,
  not by accident. The death hand-off moved into the extracted
  `hitShip()` (shared by the rock and drone branches): final blow sets
  `shipDead` and `gameState = "gameover"` in exactly one place.
  Alternative: a per-screen reset function pair (rejected — two paths
  that would drift apart).
- **Screens stay canvas-drawn, continuing the ticket #4/#7 precedent
  over DOM overlays**: all overlay glyphs go through the same
  ctx-stub-verifiable `fillText` path as the HUD, no new DOM/state.
  The retro criterion is carried by two named constants —
  `UI_FONT = "monospace"` and a single `UI_ACCENT` ("#5eead4", the
  existing ship/laser teal) plus the three screen font sizes — used by
  the HUD, the ship and laser strokes, and every overlay line. The HUD
  text recolours from #e2e8f0 to the accent so ONE colour does the
  entire UI (entity colours — amber particles, slate rocks, red
  drones — are not UI and are untouched). The `<style>` block keeps
  its functional job (dark full-bleed backdrop); the ticket's concrete
  check is `grep -qi monospace`, which now also rides in the
  `.devloop.json` gate. Alternative: DOM overlay divs styled in
  `<style>` (rejected — splits the render path, breaks the ctx-stub
  test convention, adds state to keep in sync).
- **Transitions are edge-triggered and state-gated in the keydown
  handler: Enter from start, Enter or R from game over, nothing
  elsewhere; movement/fire keys are only buffered while playing.**
  R and Enter mid-run are no-ops (never reset a live run), R on the
  start screen does nothing (Enter-only start), and after death the
  key buffer stays closed, satisfying #5's "all input ignored" without
  any extra bookkeeping. Alternative: polling held keys each frame
  (rejected — a held Enter would re-trigger the transition, and key-up
  races appear).
- **Existing suites adapted per the #7 precedent:** the five
  behavioural boots now dispatch an Enter keydown right after boot so
  they drive the running simulation; `tests/screens.test.mjs` is the
  exception — its boot deliberately parks on the start screen and
  drives the state machine, and it captures each `fillText` together
  with the font/fill in force so the monospace + single-accent
  criterion is asserted per glyph across all three screens.

## 2026-10-30 — Ticket #9: procedural Web Audio sound effects

- **Four named SFX recipes on one master bus:** shoot is a short
  (`SFX_SHOOT_S` = 0.07 s) square-wave blip whose pitch falls from
  `SFX_SHOOT_FROM_HZ` (920) to `SFX_SHOOT_TO_HZ` (420); asteroid kill,
  drone kill and player hit share one low-passed white-noise burst
  generator (`playNoiseBurst`) and are distinguished purely by preset
  constants — 500 Hz / 0.25 s (deep rock thud), 900 Hz / 0.18 s
  (sharp zap), 300 Hz / 0.45 s (long heavy hit) — each with its own
  level. Spec-silent values were picked so the four sounds sit in
  distinct pitch/texture bands and are audibly separate. Alternatives:
  per-effect bespoke generators (more code for the same two primitives —
  oscillator vs. filtered noise), or pitch-only differentiation (the
  ticket calls for noise-burst impacts, so texture must differ too).
- **The AudioContext is created, and only created, from the first
  keydown (`initAudio()` at the top of the keydown handler); a later
  keydown resumes it if the browser has suspended it.** Any key counts,
  so the start-screen Enter gesture warms the audio for the first shot.
  Before the first gesture — and in engines without `AudioContext` —
  every generator is a silent no-op (a `typeof` guard, which is what the
  six other vm suites rely on to keep running unchanged). Alternatives:
  create-on-first-shot (dead air on the opening blip; the criterion
  says "first keydown") or create-on-load (violates the autoplay-policy
  criterion outright).
- **The white-noise buffer is baked once** (`SFX_NOISE_S` = 0.5 s,
  ≥ the longest decay) and replayed by every burst; per-burst nodes
  (source, filter, envelope gain) are scheduled and dropped, which is
  the standard Web Audio pattern and happens at event rate, never in the
  60 fps hot path. Alternatives: per-burst random fill (allocates on
  every kill) or a single persistent source (can't overlap fast kills).
- **`MASTER_GAIN` (mutable `var`, 0.2) is applied both at context init
  and re-read on every SFX schedule**, so a console reassignment —
  including `MASTER_GAIN = 0` — takes effect from the next sound and 0
  provably silences everything: every recipe's envelope terminates at
  the single GainNode wired to `destination`. Envelopes peak at the
  per-recipe level into that one bus, so there is exactly one place to
  adjust overall loudness. Alternatives: a per-node cached level that
  ignores console retunes (breaks the criterion's test path) or N
  buses (no ticket benefit).
- **Only the standard `AudioContext` global is used (no
  `webkitAudioContext` fallback).** Every current browser ships the
  unprefixed constructor; the fallback alias adds a branch the
  `typeof` guard already keeps safe. Existing suites untouched — they
  simply never see an `AudioContext` global, the same silent-degradation
  path this ticket's own "no Web Audio" test locks in.
- **The drone-kill fixture parks its chaser (`DRONE_SPEED = 0`)** so a
  beam fired straight up cannot miss a drone that would otherwise steer
  off the line mid-flight; same hermetic-knob precedent as
  `suppressSpawns` in the other suites. New gate grep: `MASTER_GAIN`
  (rides the console-retunable-knob convention).

## 2026-10-29 — Ticket #14: apply accumulated reviewer should-fixes

- **Corrected the Ticket #2 `var` justification (review #2-2):** the
  original entry justified `var` purely by `const`'s reassignment
  refusal; the real benefit of `var` over `let` is that top-level
  `var` exposes the binding as a `window` property (script-scope
  `let`/`const` are lexical globals, absent from the global object).
  The #2 entry was edited in place.
- **`ASTEROID_INWARD_MIN` = 20 px/s (review #4-2):** after the
  re-aim mirror a near-tangent corner drift can still enter the field
  almost arbitrarily slowly, so entry time was unbounded in the worst
  case; candidates whose inward component falls below the floor are
  rejected inside the existing 8-candidate retry budget. Floor sized
  so the 960×600 diagonal (~1130 px) is crossed in well under a
  minute. Alternatives: rescale the drift speed after re-aiming (would
  distort the tuned speed distribution) or widen the ±60° jitter
  (changes spawn character).
- **`ASTEROID_MAX_SPAWNS` split into `ASTEROID_CANDIDATE_RETRIES` /
  `ASTEROID_SPAWNS_PER_FRAME` (review #4-3)**, both defaulting to 8 so
  behaviour is unchanged; names describe the role rather than carry
  the old one. `DRONE_MAX_SPAWNS` keeps the analogous dual role — the
  review only asked for the asteroid side.
- **`hp` documented as a (re)start-time snapshot of `PLAYER_MAX_HP`
  (review #5-2)** instead of deriving max HP lazily: `startGame()`
  already re-reads the knob, so a console retune takes effect from the
  next (re)start — the load-time initializer now says so, and the
  behaviour matches every other `var` knob that is read where the run
  begins. Alternative: store only the deficit against a live max
  (more machinery for an imperceptible gain).
- **NumpadEnter scoped to the start screen (review #8-3),** per the
  ticket wording; game-over restart stays Enter/R. Alternative: accept
  it everywhere (broadening scope the review did not ask for).
- **Review #9-2 (suite count):** `tests/sfx.test.mjs` and this log
  said "the other five vm suites"; there are six siblings (lasers,
  asteroids, ship-damage, drones, screens, waves) — both records
  corrected.

## 2026-10-29 — Ticket #14 review round 1: reproducible soak and honest abort comment

- **Safe-radius soak pinned to `mulberry32Source(7)` (review #14-A):** the
  `spawns >= 100` floor was previously probabilistic (Node's entropy-seeded
  `Math.random` gave 295/296/270 across three measured runs). Seed 7 was
  probed to deterministically yield 297 spawns — ~3× the floor. Alternatives:
  a different seed (all of 1–17 probed land at 269–304, none marginal) or
  asserting a tighter count (over-pins against future spawn-logic tweaks;
  the floor is a sample-size guard, not a prediction).
- **`spawnAsteroid` abort comment lists both rejection causes
  (review #14-B):** safe-radius crowding *and* the `ASTEROID_INWARD_MIN`
  inward-component floor. The analogous `spawnDrone` comment was left
  untouched — drones have no inward floor, so their comment remains
  complete.

## 2026-10-30 — Ticket #28: bricks.html scaffold, responsive canvas, start screen

- **`setScreen` is not generalized beyond the start overlay yet**
  (deferred per review round 1, item 4). A single-overlay helper is the
  smallest thing the ticket's criteria need; it becomes a real screen
  router when #21's game-over overlay and #24's pause screen introduce
  the second and third states, so generalizing now would be speculative
  surface. The scaffold keeps its `"start" | "playing"` state comment as
  the extension point.
- **Tunables declared with `var` (`CANVAS_SCALE`, `UI_FONT`).**
  Campaign-1 precedent (tickets #2/#3): the acceptance criterion requires
  them vm-queryable as globals, which `const` bindings are not; `var`
  also exposes them on `window` for console tuning. Alternatives: a frozen
  `TUNING` object (rejected — the criterion names bare globals),
  `const` (rejected — not global-object properties).
- **Canvas covers the full viewport; HUD and overlays are fixed-position
  layers on top of it.** The criterion measures `canvas.width/height`
  against the *viewport*, so a canvas that excluded a HUD bar could not
  satisfy it; overlaying the PRD §3 top bar costs nothing and keeps a
  single, unambiguous sizing contract (CSS 100vw×100vh, internal
  resolution `round(viewport × CANVAS_SCALE)` with `CANVAS_SCALE = 2`,
  so aspect distortion is zero). Alternative: flex-column layout with the
  canvas shrinking under the bar (rejected — violates the criterion's
  viewport equality and complicates later gameplay coordinates).
- **Resize is deferred to the next frame via a `resizePending` flag**
  (the criterion explicitly asks for "rescales on the next frame"), which
  also collapses resize-event bursts into one relayout. Alternative:
  resize synchronously in the event (rejected — mid-frame backing-store
  swaps can hitch, and the burst case wastes relayouts).
- **High-score persistence syncs `score → highScore → localStorage`
  inside the frame loop, writing on every rise.** The per-rise write is
  by design: #23's criteria require the suite to assert the `setItem` call
  the moment the live score overtakes the stored high score, so the write
  is the observable contract, not an optimisation to defer to a run-end
  hook. Corrupt/unparseable stored values degrade to 0, and a blocked
  `localStorage` (throwing accessors) is caught so the game still runs
  (locked in by the throwing-storage boot tests). (Amended per #28 review
  round 1, items 1 and 3: the original entry's "~1 write per session"
  traffic rationale misdescribed the per-rise behaviour.)
- **`update(dt)` is an empty, documented hook** — the fixed per-frame
  gameplay entry point for the later paddle/ball/bricks tickets, so their
  diffs touch the loop once instead of restructuring it. The LIVES HUD
  cell shows "–" until the lives ticket wires it.
