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
  inside the frame loop, writing on every rise.** Per-frame order is
  resize → `update(dt)` → `syncScore` → `draw`, so a record overtaken
  mid-frame persists on the very frame it happens. The per-rise write is
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

## 2026-10-30 — Ticket #21: paddle control, ball launch, bounces, lives, game over

- **Single mutable `ball` object (no pool) and a single `paddle.x` scalar.** #21 is a
  one-ball run; the extra-ball power-up (#25) will promote this to a pooled model. Paddle
  geometry is derived per-frame from the (resizable) canvas height (`paddleTop()`), so a
  viewport relayout can never strand the paddle or orphan a serve position. Alternatives:
  a pre-built ball pool now (rejected — dead surface until #25), fixed-pixel paddle y
  (rejected — breaks under the responsive rescale).
- **The paddle bounce is a sweep across the top face: the collision fires when the ball's
  bottom crosses `paddleTop` between frames (previous bottom captured before
  integration), not a per-frame overlap band.** A band test either tunnels on clamped or
  fast frames or double-fires on slow ones; the crossing test is exact at any speed and
  costs one captured scalar. The outgoing angle is
  `clamp(hitOffset / halfWidth) * MAX_PADDLE_BOUNCE_ANGLE` (60° at the rim, PRD §4),
  applied to the *incoming* speed, so every reflection preserves speed exactly and the
  ball always leaves with `vy < 0` (cos 60° = 0.5 keeps a strong upward component — the
  ball can never squirt sideways off the rim). Alternatives: fixed 45° rebound (fails
  the position-dependence criterion), renormalising to a base speed per bounce (a hidden
  retune every hit; the criteria measure preservation, not resetting).
- **The serve is straight up at `BALL_SERVE_SPEED` (480 px/s), detached by a canvas
  click or tap (`click` + `touchend`; the tap's synthetic `click` is absorbed by the
  `attached` flag).** The PRD is silent on serve angle; straight up is the most
  predictable baseline and makes "launched upward at the named serve speed" exactly
  testable. Alternatives: small random angle (untestable, worse serve feel),
  paddle-offset serve (that mechanic is what the paddle bounce already does).
- **Pointer listeners are state-ungated: `mousemove`/`touchmove` set the
  paddle x in any state; launch is gated to `"playing"` and to `attached`.**
  In a real browser the full-viewport start overlay occludes the canvas, so
  no pointer input reaches the listeners before start — the ungating is a
  script-layer property (which the tests exercise by dispatching events
  directly), not a serve-aiming feature. The `touchmove`
  handler passes `{ passive: false }` so its `preventDefault` keeps the page from
  scrolling mid-drag. Keyboard movement stays confined to `update`, which the loop only
  calls in `"playing"`, so "stops on release" falls out with no extra state; a window
  `blur` clears both held-key sets so a key released off-window cannot leave the paddle
  gliding. Alternatives: gate the pointer to playing (rejected — invisible in
  a real browser, since the overlay occludes anyway, and it adds state), buffer pointer
  events until play (extra state, no player-visible benefit).
- **Restart and first start share one `beginRun()` reset path (score, level, lives,
  serve, icons, HUD); `restartRun` additionally requires `gameState === "gameover"`, so a
  stray `btn-restart` click mid-run is a no-op.** "No live ball or bricks from the
  previous run" is read as: after restart the only ball is the fresh *attached* serve,
  at rest on the paddle centre — nothing in flight carries over (no bricks exist yet).
  At game over the ball is re-served through the same `serveBall()`
  as after each lost life (attached, at rest on the paddle centre) rather
  than deleted, so the frozen field behind the overlay shows the ball
  riding the paddle. Alternatives: a separate restart
  reset function (drift risk — the #8 single-reset-path precedent argues against),
  deleting the ball object (needs recreation machinery for no behaviour).
- **`#lives` renders one small paddle-bar `<span class="life-icon">` per remaining life,
  rebuilt (clear + append) only when a life changes — never in the frame loop.** Icons
  show `PLAYER_LIVES` from boot, advertising the run's stake on the start screen, and the
  node holds exactly `lives` children at all times (checked through the stubbed document:
  `createElement`/`appendChild`/`firstChild`). Alternative: per-icon show/hide over a
  fixed trio (keeps stale nodes alive; a rebuild on the rare life event is trivially
  exact and cheaper to reason about).

## 2026-10-30 — Ticket #21 review round 1: per-direction held keys, true-quarter fixture

- **Held keys are tracked as one `Set` of key codes per direction (`keys.left` /
  `keys.right`), not booleans (review should-fix 1).** With booleans, holding
  `ArrowLeft` + `KeyA` and releasing one stopped the paddle although the other was
  still held. The review suggested counters; a set of *distinct* held codes is the
  repeat-safe form of that counter — browser auto-repeat re-dispatches the same
  `keydown`, which would inflate a naive per-event counter, whereas `add(code)` is
  idempotent, so set size mirrors the fingers on the deck, not the re-dispatches.
  `onBlur` clears both sets (same ghost-key protection as before). The travel speed is
  sign-based (`size > 0`), so two held same-direction keys never double the speed
  (locked in by the new auto-repeat travel test). Alternatives: raw per-event
  counters with `e.repeat` filtering (depends on the event property, which the vm
  stubs would also have to fake), per-code boolean map + reduction (same result,
  more code than a set).
- **The `incomingHit` test fixture's parameter is now the game's own normalised
  offset — a fraction of the paddle *half* width (review should-fix 2).** The old
  fixture multiplied by the full `PADDLE_WIDTH`, so its "left quarter" (`rel = -0.5`)
  actually sat on the left **rim** (`rel = -1`). Call sites now pass `±0.75`, i.e.
  the quarter centres at offset `∓0.375·PADDLE_WIDTH`, and the left-quarter test
  additionally asserts the pre-bounce x equals `paddle.x - PADDLE_WIDTH * 0.375` so
  label and placement cannot drift apart again. The reviewed "stale parked-ball
  coordinates at game over" note is accepted as documented behaviour — no code change.


## 2026-10-30 — Ticket #21 review round 2: symmetric start gate, blur lock-in, honest palette comment

- **`startGame` is gated on `gameState === "start"`, mirroring `restartRun`'s
  `gameState === "gameover"` gate (review round 2, item 3).** The former
  `!== "playing"` gate also admitted game over, so two buttons could both
  restart a run; now each screen owns exactly one transition and stray clicks
  in every other state are no-ops (locked in by the new symmetry test, which
  also confirms Try Again remains the working restart path). The old
  "repeat clicks never reset a run" guarantee still holds — start is a
  no-op mid-run too. Alternative: keep the `playing`-only gate (rejected —
  asymmetric, the review asked for symmetry).
- **A short `blur` test locks in the held-key clearing (review round 2,
  item 2).** Ghost-key protection existed (`onBlur` clears both held-key
  sets) but had no dedicated regression test; the test holds `ArrowLeft`,
  fires a window `blur` without the keyup, and asserts the paddle stops.
- **The palette header comment reverts to the scaffold-era honest phrasing
  — "a canvas-drawn mirror is added with the canvas-text gameplay tickets"
  (review round 2, item 1).** The #21 rewrite ("keeps one colour doing the
  entire UI") overclaimed: no canvas UI text exists yet, and `COLOR_PADDLE`
  is an entity colour, not a UI mirror.

## 2026-10-30 — Ticket #21 review round 3: re-serve at game over, honest pointer-ungating claim

- **`enterGameOver` now calls `serveBall()` instead of hand-writing the
  parked-ball fields (review round 3, item 1).** The old parking set
  `attached`/zero velocity but left the ball at its stale drop
  coordinates — below the bottom edge, i.e. off-screen — so the comment
  claiming the frozen field "draws cleanly" pointed at a ball the player
  could not see. Re-serving through the shared `serveBall()` puts the
  frozen field behind the overlay in exactly the canonical rest pose
  (ball on the paddle centre) and reuses the single park/serve path.
  Alternative: keep manual parking and add two coordinate assignments
  (duplicates `serveBall`'s contract; the round-1 "stale parked-ball
  coordinates" note is retired as behaviour, superseded by this fix).
- **The pointer-ungating bullet is reworded to its honest claim and the
  matching test renamed (review round 3, item 2).** The old bullet sold
  "hovering before Start aims the serve position", but the full-viewport
  start overlay occludes the canvas in a real browser, so pre-start
  pointer input never reaches the handlers and no serve aiming exists.
  The bullet now states the true property (listeners are state-ungated,
  a script-layer fact exercised by direct dispatch in tests) and the
  test is renamed to that claim. No code change: the gating question
  was about the claim, not the listeners.


## 2026-10-30 — Ticket #22: brick grid, ball collision, scoring, levels, win condition

- **Bricks live in a fixed-size pool allocated once at module scope
  (`BRICK_ROWS * BRICK_COLS` slots, each `{active, tier, x, y, w, h}`),
  mutated in place for every level.** Campaign-1 pool precedent
  (tickets #3/#4): spawning and respawning never allocate, keeping the
  hot path GC-free, and the ticket's "fixed-size pool (no per-level
  allocation)" criterion has exactly one structure that can satisfy
  it. A level spawn is an activation pass over the same slots plus a
  geometry pass (`layoutBricks` reads the *current* canvas size, so
  the deferred viewport rescale — which now also re-lays the grid
  while playing — keeps the grid inside the field). The win check is
  an O(1) `bricksLeft` counter decremented in the single
  `destroyBrick` kill path. Alternatives: rebuild the array per level
  (rejected — allocates, violates the criterion), a live subset
  array + swap-remove (rejects — moves slots around, which is
  allocation-free but complicates the tier/row indexing the layout
  and tests rely on).
- **Three colour tiers with named per-colour point constants
  (`COLOR_BRICK_{A,B,C}` / `POINTS_BRICK_{A,B,C}` = 30/20/10), every
  brick one-hit.** The ticket mandates "destroyed in one hit" for the
  ball collision, so durability variation is out of scope for this
  ticket and the colour encodes the point value (PRD section 2:
  "different colors represent different point values or durability").
  Per-level layout variation (PRD section 4 "a faster, more
  challenging brick layout") is the tier rows cycling by one slot per
  level — `tier = (row + (level - 1)) % 3` — deterministic, one line,
  and observably different per level (locked in by the layout-differs
  test). Alternatives: identical layout each level (ignores the PRD
  word "layout"), random tier shuffles (needs the campaign-1
  `random` hook for test determinism — more machinery than this
  ticket asks for), multi-hit durability (contradicts the one-hit
  criterion; belongs to a later ticket if ever wanted).
- **Ball integration sub-steps in chunks of at most `BALL_RADIUS`
  (≤ 8 px) before the brick scan; at most one brick is hit per
  sub-step (first contact), resolved along the shallowest
  penetration axis with a sign-based velocity flip.** With the
  sub-step shorter than a radius, the ball can never skip a brick
  face even at `MAX_BALL_SPEED` on a clamped 1/30 s frame, and the
  sign flip preserves the incoming speed exactly — the same
  speed-preservation contract the wall and paddle bounces already
  honour. Alternatives: swept segment-vs-rectangle intersection
  (the campaign-1 laser technique; a circle needs an
  entry-point/quadratic solve — more code for the same guarantee at
  10× fewer bodies than 32 lasers), per-frame overlap band around the
  ball (tunnels on fast clamped frames, which is exactly the
  criterion being locked in).
- **Progression state is a runtime `serveSpeed` variable, reset to
  `BALL_SERVE_SPEED` in `beginRun`, grown by
  `serveSpeed * LEVEL_SPEED_GROWTH` (capped at `MAX_BALL_SPEED`) in
  `advanceLevel`.** The level-2 serve is then *exactly*
  `BALL_SERVE_SPEED * LEVEL_SPEED_GROWTH` (one multiplication, same
  operand order the test uses — the "exact, via vm query" criterion
  holds bit-for-bit). `MAX_BALL_SPEED = 1500` is what makes "the
  maximum per-level speed" well-defined for the tunnelling criterion:
  growth reaches the cap at level 10 (480 × 1.15⁹ ≈ 1688) and the
  fixture runs at the cap. A cap also keeps unbounded play playable
  (a 1.15ⁿ serve would exceed the paddle's keyboard traversal well
  before a human could react). Alternatives: no cap (the "maximum
  per-level speed" would be level-dependent and the criterion's
  fixture unanchored), scaling `BALL_SERVE_SPEED` itself (mutates
  the level-1 constant the #21 suite asserts on restart).
- **A level win is triggered from inside the single `destroyBrick`
  kill path when `bricksLeft` reaches 0: `advanceLevel` raises the
  level by exactly 1, spawns the next layout, and re-serves through
  the shared `serveBall()` (fresh attached ball at rest on the
  paddle, #21's single park/serve path).** Physics-driven kills and
  console-style kills (`destroyBrick(i)` from the vm/tests) therefore
  share the whole scoring-and-winning pipeline, and "level +=
  exactly 1" has one code path to break. The post-win frame skips the
  paddle/drop checks (early return), since the ball was just
  reflected — or re-served and is attached — so it cannot legally
  meet the paddle or the bottom edge in the same instant. Alternative:
  a per-frame win scan (`bricks.every(inactive)`) (rejected — O(n)
  per frame for what the counter answers for free).
- **The paddle suite's 600-frame wall-bounce soak now deactivates the
  brick field in its fixture and moves its seed x 300 → 340.**
  Campaign-1 precedent for adapting old suites when a new entity
  class joins the field (ticket #6's `suppressSpawns`). The reseed
  was forced, not cosmetic: #22's sub-stepped integration conserves
  the top-wall overshoot instead of discarding it, which phase-shifts
  the bounce by up to a radius; under the old seed the run ends 3.7
  px short of the right wall (measured 1908.33 vs 1912). The new
  seed keeps both mandated reflections (top and right) with margin.
  Alternatives: keep the old seed and let the soak lose its
  right-wall assertion (weakens the locked-in behaviour), or change
  the sub-step wall handling to discard overshoot (defeats the point
  of sub-stepping).

## 2026-10-30 — Ticket #22 review round 2: sub-step overlap drain

- **After a brick hit, the sub-step loop now drains residual overlaps —
  `while (collideBricks()) {}` before resuming/breaking — so the frame
  always ends with the ball clear of every live brick.** Root cause:
  `BRICK_GAP` (6 px) is narrower than the ball (16 px diameter), so the
  x-resolution pin (ball pushed to `face ± BALL_RADIUS`) of a row-centre
  side hit can land the ball inside the seam neighbour; the old
  single-shot `if (collideBricks()) break` then left that overlap to be
  popped a frame early. The drain is structurally terminating: each
  `true` destroys exactly one brick, so at most `bricks.length`
  iterations, and a draining win (last brick) is safe because the
  re-served ball rides the paddle, far from the fresh grid. Locked by
  the row-centre side-hit regression test in the grid suite.
  Alternatives: shrink the push-out to the seam midpoint (rejected —
  fudges the physics and still leaks partial overlaps), or widen the
  drain to a full pre-flight check before every sub-step (rejected —
  O(n) per sub-step with no behaviour gain; overlaps only ever appear
  from our own push-out).

## 2026-10-30 — Ticket #25: power-up drops with the expand paddle

- **The paddle now has a runtime width `paddleW` alongside the new
  base constant `BASE_PADDLE_W`; every consumer (clamp, ball-bounce
  span and angle, draw) reads the runtime width, and
  `PADDLE_WIDTH` was renamed to `BASE_PADDLE_W`** (mechanical
  update in the paddle suite). The ticket names the base width
  `BASE_PADDLE_W`, so the old constant became the base and the
  widening became state. Alternatives: keep `PADDLE_WIDTH` and add a
  parallel `BASE_PADDLE_W` alias (rejected — two names for one
  value), or make the widen a per-frame draw-only illusion (rejected
  — the collision span must match what is rendered).
- **Simulated-time clock `simTime` advances only while "playing",
  and the widen expires at `simTime >= expandUntil`.** The effect
  duration is simulation time per the ticket (paused/tab-hidden time
  must not consume it); the rAF loop already clamps `dt`, so the
  expiry is exact to one frame. Alternatives: wall-clock timestamps
  (rejected — violates "simulation time" and is unfreezeable in the
  test harness).
- **Recatching Expand assigns `expandUntil = simTime +
  PADDLE_EXPAND_DURATION_S` (now + full duration), never adds.**
  Straight assignment implements the ticket's "extended, not
  additive" wording; locked by the re-arm test that asserts
  `expandUntil === t1 + D` exactly.
- **Capsules come from a fixed 4-slot pool pre-allocated at boot; a
  drop with no free slot is silently dropped, and a drop rolls its
  kind as `CAPSULE_KINDS[floor(random() * len)]`.** The pool length
  is constant across the run (the ticket's no-allocation criterion)
  and 4 concurrent capsules is generous for a single-column fall
  stream. Silent overflow drop keeps `destroyBrick` allocation-free
  and branch-simple. Alternatives: grow the pool (violates the
  criterion), or recycle the lowest capsule (arbitrary displacement
  of a visible object).
- **Catch detection is a plain rect-overlap of the capsule and the
  paddle band per frame (no sweep).** At `CAPSULE_FALL_SPEED`
  (200 px/s) the clamped-frame travel (≤ 6.7 px) is far under the
  capture band height (`CAPSULE_H + PADDLE_HEIGHT`), so tunnelling is
  structurally impossible at these values. Alternatives: the
  ball-style sweep test (rejected — no tunneling risk at capsule
  speeds).

## 2026-10-30 — Ticket #25 review round 1: fold-ins

- **The right-rim edge clamp is locked by a new test rather than new
  code.** `applyCapsule(KIND_EXPAND)` already re-runs `clampPaddle()`
  the instant the widen lands, so a paddle parked at the right rim
  snaps to exactly `canvas.width - paddleW/2` and the per-frame
  clamp keeps it locked while the key is held. The new test locks
  that exact value (and the hold-at-rim frames); the code needed no
  change. Alternatives: a dedicated widen-path clamp (rejected —
  duplicates the single existing clamp, two sources of truth).
- **Capsule colour is looked up in an exhaustive `CAPSULE_COLORS`
  table (indexed by kind) instead of a ternary with a `COLOR_BALL`
  fallback.** The old `: COLOR_BALL` arm was a speculative branch for
  a kind that does not exist; the table makes "one row per kind" the
  only extension point, so the draw pass stays branch-free as kinds
  grow. A test asserts every enumerated kind has a row and no row is
  left over. Alternatives: keep the ternary (review rejected it), or
  a per-kind switch (same future-facing-branch problem).
- **`drawPowerups()` now runs only while `gameState === "playing"`.**
  Update is already frozen outside playing, so an airborne capsule
  would otherwise render suspended over the game-over board; gating
  the draw hides it while leaving bricks, paddle and ball as a tidy
  frozen field. Alternatives: deactivate capsules in
  `enterGameOver()` (destroys in-flight state the restart path does
  not guarantee), or draw them dimmed (extra palette state for no
  player-visible benefit).

## 2026-10-30 — Ticket #26: extra ball and sticky paddle power-ups

- **The single `ball` object becomes a fixed pool `balls` allocated once
  at the named `var MAX_BALLS` (5); slot 0 is the run's serve ball, a
  free slot is activated per extra-ball catch, and the pool never grows.**
  Campaign pool precedent (#22 bricks, #25 capsules): activation is a flag
  flip, so a catch never allocates and the MAX_BALLS cap falls out of the
  pool size — a catch with no free slot is a no-op. Alternatives: cap the
  *active* count over an unbounded pool (rejected — allocating, and the
  ticket names the cap as the structural bound), or a grow-on-catch array
  (rejected — allocation churn, the 60 fps rule).
- **An extra-ball catch spawns at the paddle centre and launches straight
  up at the current (level-grown) `serveSpeed` immediately — "second ball
  into active play" (PRD §4) — rather than parking attached for the next
  click.** PRD says the ball enters active play; the ticket says it spawns
  at the paddle. Immediate launch satisfies both readings with one code
  path and no new serve-queue state. Alternatives: attach-and-await-click
  (requires multi-attached serve bookkeeping and a weaker reading of the
  PRD), random angle (untestable, #21 precedent rejects it).
- **A ball dropped below the bottom edge only costs a life when it was
  the last live ball: the drop path deactivates the slot and calls
  `loseLife()` iff `liveBallCount() === 0`; `loseLife()` itself keeps its
  exact #21 meaning (−1 life, fresh serve or game over).** Keeps the
  existing `loseLife` contract (and the #25 suite's direct `lives = 1;
  loseLife()` game-over test) intact while adding the multi-ball rule at
  the drop site — one decision point, not a flag scattered over the life
  flow. Alternatives: fold the count check into `loseLife` (changes its
  contract; the direct-call tests would need rewiring), or treat every
  drop as a life loss (rejected — violates the criterion).
- **Sticky is an absolute sim-time threshold `stickyUntil` (armed
  `simTime + STICKY_DURATION_S`, 6 s, re-arm = now + full duration like
  expand), checked at the paddle contact as `simTime < stickyUntil`.**
  Same simulation-time discipline as #25 (pause-safe, exactly frame-
  deterministic, no per-frame expiry mutation). At the expiry frame the
  paddle is already non-sticky, so the boundary test lands unambiguously.
  Alternatives: per-frame countdown variable (equivalent; the threshold
  form matches the `expandUntil` precedent), or sticky-until-first-catch
  (rejected — the ticket fixes a duration).
- **A sticky contact attaches the ball at its contact offset
  (`attachOff`, clamped to the paddle half width), the attached ball rides
  `paddle.x + attachOff` each frame, and a click launches *every* attached
  ball, each inheriting the position-dependent paddle-angle logic for its
  own offset at the `serveSpeed`.** Attaching at the hit point (instead of
  re-centering) makes the ride feel like a catch, keeps the re-launch
  angle honestly position-derived, and handles the (legal) two-attached
  case without special-casing. Alternatives: re-center on catch (loses the
  catch feel and makes the "position-dependent" launch trivially
  centre-fire), launch only the oldest attached (extra branch for an edge
  case players would read as broken).
- **`serveBall()` drains every slot and parks slot 0 — so a level win, a
  lost last ball, and the game-over re-serve all reset to ONE fresh
  attached ball; extra balls never carry across a serve, while the
  sticky WINDOW intentionally does.** The window is a fixed sim-time span
  anchored at the catch (`stickyUntil`), so a re-serve that lands inside
  it leaves the paddle armed until the anchor expires — disarming on
  serve would silently shorten a bought duration, and a parked (attached)
  serve ball never crosses the contact sweep anyway, so there is no
  "sticky paddle at rest" surprise state. Reuses #21's single park/serve
  path; the frozen game-over field shows the canonical rest pose exactly
  as before. Only the run-level reset
  (`beginRun()` on start/restart) clears the arm. Alternatives: carry
  extra balls across a level win (the win re-serve would desync from the
  "fresh serve" contract, and a cleared board with N leftover balls is a
  softer difficulty drop the ticket does not ask for), or disarm sticky
  in `serveBall()` (truncates the fixed duration the ticket fixes —
  rejected in review round 1; the earlier draft's "sticky arms never
  carry" wording was false and has been corrected).
- **Legacy `bricks-paddle` / `bricks-grid` suites adapted to the pool,
  mirroring the campaign precedent for entity-shape changes (#6 suite
  adaptations, #25's `PADDLE_WIDTH` → `BASE_PADDLE_W` mechanical rename):**
  every fixture and accessor now addresses `balls[0]` (the serve slot,
  which is the only active ball in their scenarios) and direct
  `collideBricks()` calls pass `balls[0]`. No test semantics changed.

## 2026-10-30 — Ticket #26 review round 1: fold-ins

- **The same-frame double-drop edge is locked by a committed fixture
  rather than new code.** Both fixture balls share one height, so both
  cross the loss line in one `updateBalls()` pass; the pool-order loop
  deactivates ball #0 first (a ball still lives → no life spent) and
  only the last live drop triggers `loseLife()`. The new test asserts
  exactly one life lost and exactly one fresh slot-0 attached serve.
  Alternatives: special-case simultaneous drops in `updateBalls()`
  (rejected — the count-after-deactivate rule already handles it; the
  branch would be dead code).
- **`launchBall` renamed to `launchAttachedBalls`.** The singular name
  was false — the handler iterates and launches EVERY attached ball
  (the legal two-attached case). No signature, listener or behaviour
  change; the name now matches the code. Alternatives: keep the name
  (review rejected it — dishonest singular).
- **The sticky-survives-serve wording in `serveBall()`'s comment and in
  this file is corrected to state what the code actually does** (above
  and in the `stickyUntil` declaration): the window is a fixed sim-time
  span that intentionally survives mid-run re-serves; only `beginRun()`
  clears it. No behaviour change. Alternatives: change the behaviour to
  match the old wording (review kept the behaviour instead).

## 2026-10-30 — Ticket #27: synthesized Web Audio SFX on a master gain bus

- **The campaign-1 audio architecture (ticket #9) is mirrored exactly,
  including the `MASTER_GAIN` semantics.** `MASTER_GAIN` (mutable `var`,
  default 0.2) is the **bus level**, not a per-envelope scalar:
  `MASTER_BUS.gain.value = MASTER_GAIN` is applied at init and re-read on
  **every** `scheduleSound()` call ("live console retunes apply"), so
  `MASTER_GAIN = 0` zeroes the single GainNode wired to `destination`
  from the next scheduled sound onward — which is how "every
  subsequently scheduled envelope terminates at 0" is asserted on the
  stub graph (bus gain 0 × any envelope = 0). The brick suite's tests
  therefore assert the bus value, not per-envelope zeros. Alternatives:
  a peak-scaling `MASTER_GAIN` (diverges from the campaign-1 precedent
  and its testable semantics; rejected) or an immutable bus with a
  separate mute flag (extra state the ticket does not ask for).
- **Four named recipes, one per required event, on the shared
  primitives:** paddle bounce — sine 220 Hz / 0.05 s; brick break —
  filtered noise, 900 Hz lowpass / 0.09 s (the campaign-1 noise-burst
  pattern: a pre-baked white-noise buffer replayed through a lowpass
  cut at the recipe's `freq`, since a noise waveform has no fundamental
  to set directly); power-up catch — square 660 Hz / 0.12 s (caught by
  kind — the catch blip is kind-independent); game over — sine
  110 Hz / 0.50 s, the longest of the four. Spec-silent values picked
  so the four sounds sit in distinct pitch/texture bands, as in
  campaign 1. Alternatives: per-recipe `LEVEL` constants (campaign 1
  differentiates its presets by level; rejected here — the ticket names
  only wave/frequency/duration per recipe, so one shared `SFX_PEAK`
  is the smaller surface) or a fourth texture for the catch (nothing
  to gain over the two proven primitives).
- **The AudioContext is built only on the first user gesture, exactly
  once:** `ensureAudio()` guards with `if (audioCtx) { resume-if-suspended; return; }`
  and is hooked into the four gesture paths — `onKeyDown` (any key,
  matching campaign 1's "any key counts"), `launchAttachedBalls`
  (canvas click **and** touchend land here), `startGame` and
  `restartRun` (the overlay buttons). Hooks sit *before* the state
  gates, so a stray click on the wrong screen still counts as the
  warming gesture but changes nothing else. `typeof AudioContext ===
  "undefined"` is the entire platform guard (bare global, no
  `webkitAudioContext` fallback — the campaign-1 rationale stands);
  before the first gesture and on such platforms every
  `scheduleSound()` is a silent no-op, which is the silent-degradation
  path the existing five suites exercise unchanged. Alternatives:
  create-on-load (autoplay-policy violation) or a dedicated
  "pointerdown" listener (new listener surface; click/keydown cover the
  ticket).
- **Envelope shape: `setValueAtTime(SFX_PEAK)` then
  `exponentialRampToValueAtTime(SFX_DECAY_FLOOR, t + dur)`** — the
  campaign-1 decay, kept verbatim. Exact 0 is unreachable with an
  exponential ramp, hence the named `SFX_DECAY_FLOOR` (0.001); the
  tests assert decay-to-floor, and the muting test asserts the bus
  carries 0 instead. Alternatives: a linear ramp to literal 0 (diverges
  from campaign 1; "terminates at 0" is met by the zeroed bus either
  way).
- **The noise buffer is baked once in `ensureAudio()`** from the
  game's mutable `random` hook (deterministic under the suites'
  `random = ...` pins, like every other random value) — never on the
  60 fps hot path; per-sound nodes (source/filter/envelope) are
  scheduled and dropped at event rate, the standard Web Audio pattern.
  A catch fixture that kills a brick also emits a break sound, so the
  routing/mute tests count four sounds for three visible events and
  pin `random` to force no unplanned capsule before intermediate kills.

## 2026-10-30 — Ticket #27 review round 1: exp-ramp clamps, mute-product pin, resume() rejections

- **Exponential ramp start and target are clamped: `Math.max(SFX_PEAK, SFX_EXP_EPS)` /
  `Math.max(SFX_DECAY_FLOOR, SFX_EXP_EPS)`**, with the start set at the schedule time
  (`t0`). Exponential ramps only span positive values — a console zeroed `SFX_PEAK`
  or `SFX_DECAY_FLOOR` previously produced an unbounded/invalid parameter region
  (start 0 → −inf dB) or a rejected target. The guard is a named constant
  `SFX_EXP_EPS = 1e-4`, applied at scheduling so the runtime constants stay the
  source of truth. The audio stub now enforces the same positivity contract
  (RangeError on a non-positive ramp target or start), so the regression tests
  fail for the real reason. Alternatives: reject-and-stay-silent (rejected —
  a zeroed knob means "quiet", not "broken") or clamp at the constants
  (rejected — the knobs must keep working from the console).
- **"Terminates at 0" is pinned as the audible level: the mute test now also
  asserts post-mute envelope terminus × bus gain === 0 exactly.** The envelope
  keeps its named shape (peak → floor); silence comes from the zeroed bus.
  Alternative reading — rewrite the envelope to literal 0 — rejected: diverges
  from the campaign-1 decay and loses the named-floor contract.
- **Both `audioCtx.resume()` call sites swallow rejection with a bare
  `.catch(() => {})`.** `resume()` returns a Promise that rejects when the
  context cannot resume; an unhandled rejection would log (and, under some
  engines, crash) the silent-degradation path. The stub's `resume()` returns a
  promise-like that records `.catch` attachment, so the test proves every call
  is guarded. Alternatives: `await`/try-catch (needs an async wrapper around
  the gesture handlers) or ignore the Promise (unhandled rejections are the
  defect being fixed).
- **Campaign 1 (`asteroids.html`) carries the same un-guarded `resume()` and
  hardcoded 0.001 decays; left untouched.** Ticket #27 scopes to the bricks
  campaign; campaign 1's decay constants are literal (not console-tunable) so
  the clamp hazard is absent there. A follow-up ticket should mirror the
  review fixes there if desired.
- **The scaffold suite's catch-binding rule now carves out dotted Promise
  methods.** Its round-2 static check banned `catch (` anywhere in the
  source (intent: storage guards keep bare `catch {`); the review-required
  `.catch(() => {})` collided with the over-broad regex. The check now
  ignores a `.` before `catch` — try/catch statement bindings with an unused
  parameter are still flagged. Alternatives: `then(undefined, …)` (obscure,
  and the review named `.catch` explicitly) or a synchronous wrapper that
  cannot observe the Promise rejection.

## 2026-10-30 — Ticket #23: persist high score in localStorage across reloads

- **The top-bar high-score element is `#hiscore`, replacing `#hud-high`.** The
  ticket's criteria name the `#hiscore` selector explicitly, so the scaffold's
  `hud-high` id was renamed (markup, DOM handle, and the stub registries of all
  six bricks suites in one mechanical pass). Alternatives: keep `hud-high` and
  treat it as equivalent (rejected — the criteria are the contract, and two
  names for one readout would leave `#hiscore` unmet), or add a parallel
  `#hiscore` span (rejected — duplicate state surface for no requirement).
- **The stored value is written with `JSON.stringify` and read with
  `JSON.parse` + a `Number.isInteger` gate, instead of `String`/`parseInt`.**
  The criteria require `setItem` "with the new value as a JSON number", so the
  codec is now literally JSON on both sides; the wire format is byte-identical
  for integers (`"600"`), so the existing suite expectations keep holding.
  The `Number.isInteger` gate rejects what `parseInt` used to silently truncate
  (e.g. `"72.9"` → 72) — a corrupt value now degrades to 0, matching the
  blocked-storage degradation. Alternatives: keep `String`/`parseInt` and note
  equivalence (rejected — the test must prove the JSON contract itself),
  store an object like `{"highScore": n}` (rejected — over-encodes a single
  scalar the PRD never asks for).
- **An overtake now refreshes the HUD in the same frame: `syncScore` calls
  `syncHud()` inside the `score > highScore` branch.** The new exact-write
  criterion requires `#hiscore` to show 600 the moment the live score reaches
  600, but the per-frame path (`frame` → `syncScore` → `draw`) previously only
  updated `highScore` and storage, leaving the readout stale until the next
  coincidental `syncHud` (brick kill, level, game over). The branch placement
  keeps the write-through cost at overtake rate, not frame rate. Alternatives:
  call `syncHud` every frame (rejected — write-checks on three nodes per frame
  for nothing; `setText` is already change-gated but the call itself is the
  per-frame work the PRD's 60 fps rule discourages), or only in `draw` (wrong
  layer — draw renders, it does not mutate HUD state).

## 2026-10-30 — Ticket #24: pause and resume screen via Escape/P

- **Edge triggering uses a held-key `Set` (`pauseKeys`), not the
  `KeyboardEvent.repeat` flag.** The paddle suites model browser
  auto-repeat as plain re-dispatched keydowns with no `repeat`
  property, and the synthetic dispatch in every bricks suite carries
  no such flag — a `repeat` check would be untestable here and would
  leave no home for the blur semantics. `pauseKeys` mirrors the
  existing `keys.left/right` sets exactly (add on the first keydown of
  a held code, delete on keyup, `onBlur()` clears it all), so one
  concept of "finger on the key" covers paddle and pause, and a blur
  while the key is logically held cannot swallow the next press as a
  ghost repeat. Alternatives: an `e.repeat`-guarded handler
  (rejected — synthetic events carry no flag, untestable), or a
  time-debounced toggle (rejected — timing knobs the PRD never asks
  for, and a 500 ms window would feel laggy for legitimate rapid
  pauses).
- **The `mousemove`/`touchmove` listeners stay state-ungated in
  "paused", per the recorded pointer decision.** The first draft
  state-gated `setPaddleX` to `"playing"`, which broke the paddle
  suite's review-approved contract ("pointer listeners are
  state-ungated: a canvas mousemove dispatched during 'start' still
  moves the paddle"). That ruling transfers unchanged: in a real
  browser the full-viewport pause overlay (`.screen`, `z-index: 3`)
  occludes the canvas, so no pointer input can actually reach the
  listeners while paused — the ungated write is a script-layer
  property, unreachable by a player, and the ticket's soak criterion
  is frame-driven (no pointer dispatch) and holds. The keyboard side
  is frozen for free: `updatePaddle` only runs in `"playing"`, so a
  held arrow key cannot glide the paddle across the pause.
  Alternatives: gate the pointer writes (rejected — reverses a
  review-approved decision mid-ticket and adds state the overlay
  makes inert), or buffer pointer events until resume (extra state, no
  player-visible benefit, same overlay-occlusion argument as the
  original ruling).
- **Either pause key resumes (`KeyP` exits an `Escape` pause and
  vice versa); the keys are aliases of one action, not two.** The
  ticket guarantees "the same key" resumes; treating both codes as
  one toggle (both map to `togglePause` through the shared held set)
  is simpler and cannot strand a pause that only one of the two keys
  could close. Alternative: remember which key paused and accept
  only that one (rejected — bookkeeping for a UX nobody requested).

## 2026-10-30 — Ticket #35: guard audio resume() Promises in asteroids.html

- **Mirror campaign 2's bare `.catch(() => {})` on both `audioCtx.resume()` call
  sites (first-gesture creation and the suspended-retry path in `initAudio()`),
  and do NOT port ticket #27's exp-ramp clamps.** The defect is identical to
  campaign 2's: a gesture handler leaking an unhandled rejection from a refused
  `resume()`, while the rest of the silent-degradation path already assumes
  "refused = quiet, not broken". The clamps are out of scope because the hazard
  they fixed does not exist in campaign 1: bricks' decay floors became
  console-reassignable `var` knobs after #27, so a bad console value (≤ 0 or NaN)
  could reach `exponentialRampToValueAtTime` and throw `RangeError`; campaign 1's
  decay targets are hardcoded literals (`0.001`, positive `SFX_*_TO_HZ` constants)
  that cannot be reassigned to a non-positive or NaN value, so a clamp there would
  be dead code. Alternatives: `await`/try-catch (requires wrapping the synchronous
  gesture handlers in async context), or `then(undefined, …)` (less explicit;
  ticket #27's review named `.catch` specifically).

## 2026-10-31 — Ticket #39: letterbox CSS sizes use Math.round, not Math.floor

- **The stage's visible (CSS) size is computed as the largest 16:10
  rectangle fitting the viewport and rounded with `Math.round` per axis,
  and the backing-store assignments in the resize pass are guarded by a
  mismatch check so they execute effectively once.** Rounding reproduces
  the exact canonical sizes the ticket specifies (320×568 viewport →
  320px × 200px); `Math.floor` would instead yield 319 × 199 because
  `960 * (320 / 960)` is `319.99…` in floating point, so a floor-based
  fit would look visibly under-sized against the viewport edges while
  still fitting (worst-case overshoot of round is ≤ 0.5px per axis).
  Alternatives: `Math.ceil` (can exceed the viewport on fractional fits
  — rejects "fit, not stretch"), or keeping floor (correct but
  systematically one pixel smaller than the true fit at common sizes).
  The backing-store guard means a resize storm never re-clears the
  canvas (setting `canvas.width` even to the same value resets the 2d
  context), keeping the hot path allocation- and state-free.

## 2026-10-31 — Ticket #39 review round 1: zero-width rect in `setPaddleX` is ignored, not snapped

- **When `getBoundingClientRect().width` is not `> 0` (canvas hidden,
  mid-detach), `setPaddleX` skips the move entirely: the paddle keeps
  its last valid position instead of receiving a NaN (naive division)
  or snapping to an edge (clamping a NaN maps to the left edge).**
  A hidden canvas receives no meaningful pointer data anyway, so the
  latest *valid* position is the best known truth; the next event with
  a real rect re-maps normally. Alternatives: snap to the nearest edge
  (wrong — fabricates a move the player never made), or leave the
  divide alone and rely on `clampPaddle` (poisons: NaN comparisons are
  false, so the paddle stays NaN forever).
- **SUPERSEDED 2026-11-02 by ticket #101 (see that entry): the letterbox fit WAS capped
  at the native stage size (scale ≤ 1): a viewport larger than 960×600 rendered
  the stage at 960×600 CSS px, never upscaled.** The original rationale was that
  Paul's "optimal size irrespective of screen size" reads as the stage having a
  definite size and that upsampling a 2× raster past 1:1 only blurs. The operator
  later explicitly asked for the stage to grow with the screen; see the
  ticket #101 entry for the current behaviour.

## 2026-10-31 — Ticket #40: the window-level touchmove keeps page-wide `preventDefault`

- **Moving `touchmove` from the canvas to `window` also moves its
  `{ passive: false }` + `preventDefault()` to page scope: a horizontal
  drag anywhere in the viewport (including across the letterbox bars)
  steers the paddle without triggering browser scroll/refresh
  gestures.** The page already sets `overflow: hidden` and the game is
  single-screen, so suppressing the default costs nothing; a
  canvas-scoped handler would only cover the stage and reopen the
  tracking hole the ticket closes. Alternatives: keep `touchmove` on
  the canvas (rejected — the same off-stage gap the ticket closes),
  or drop `preventDefault` at window level (rejected — refresh/scroll
  gestures would fight the paddle during a drag).

## 2026-10-31 — Ticket #41: launch the attached ball with Space or Enter

- **Space/Enter keydown routes through the existing `launchAttachedBalls()`
  and deliberately calls no `preventDefault()`.** The page is
  `overflow: hidden` (single-screen, never scrolls), so Space has no
  default action to cancel; and suppressing the Enter/Space default
  would disable native keyboard activation of a focused CTA (e.g. Tab
  to the pause screen's Resume button + Enter). The one behavioural
  side effect a real browser adds — Enter/Space "clicking" a focused
  CTA (e.g. the just-mouse-started Start button) — is already a no-op,
  because `startGame`, `restartRun` and `resumeGame` are all
  state-gated to their own screen. Alternatives: `preventDefault()`
  like the arrow keys (rejected — no scrollable page to defend, and it
  silently breaks keyboard activation of CTAs), or a dedicated
  keyboard-launch branch (rejected — the ticket mandates the SAME path
  the click uses, not duplicate physics).

## 2026-10-31 — Ticket #42: durability curve A=3 / B=2 / C=1; `destroyBrick()` stays the unconditional kill path

- **Each `BRICK_TIERS` row gains `hp` (`HP_BRICK_A=3`, `HP_BRICK_B=2`,
  `HP_BRICK_C=1`), stored on the brick pool entry and refilled by
  `spawnLevel()` from the tier table. `collideBricks()` resolves the
  overlap exactly as before, then costs one hp: `hp > 0` reflects
  only (no score, no capsule roll, `bricksLeft` untouched); `hp`
  reaching 0 routes to `destroyBrick()` unchanged. `destroyBrick()`
  remains the unconditional kill path shared by the lethal hit and
  console access, so console-driven clears and the win condition
  behave exactly as before.** Alternatives: per-hit `damageBrick()`
  with a separate console kill (rejected — the ticket prescribes the
  decrement-then-destroy split and keeps the console path
  unchanged), or equal hp across tiers (rejected — the PRD's colour
  legend reads best when only the top tiers are visibly durable and
  the base tier keeps the classic one-hit feel).

## 2026-10-31 — Ticket #42: brick-face pins nudge `BRICK_PIN_EPS` (1e-6 px) outside the face

- **When `collideBricks()` pins a ball flush to a brick face it now
  places it `BRICK_PIN_EPS` px OUTSIDE, so a re-computed overlap of
  the pinned position is strictly ≤ 0.** Multi-hit bricks changed the
  seam-drain calculus: a ball pinned flush used to re-test as a
  +ulp overlap, letting the drain loop charge a phantom second hit
  to the brick it had just resolved (observed: one seam contact
  costing a two-hit brick both of its hp, non-deterministically
  across layouts). The nudge removes the whole class; the frame ends
  with the ball exactly one micro-pixel clear of every face, which is
  invisible at `CANVAS_SCALE`. Tests that asserted an exact pin
  coordinate now tolerate 1e-5 px. Alternatives: an `ovx > EPS`
  contact threshold (rejected — would blunt real shallow contacts,
  not just the flush-pin artefact), or leaving the pins exact
  (rejected — the phantom-hit outcome depended on ulp rounding).

## 2026-10-31 — Ticket #42 review round 1: per-brick, per-frame damage cap (1 hp max)

- **A brick may pay at most ONE hp per frame, regardless of how many
  times the frame's sub-step drain loop re-contacts it.** Review round 1
  flagged the gameplay defect: with per-hit charging, the seam-drain
  `while (collideBricks()) {}` could legitimately re-register a
  non-lethal hit on the brick it had just resolved in the same frame
  and cost an hp-2 brick both of its hp in one 16 ms step. The cap is
  a per-entry `charged` flag: `collideBricks()` still reflects and
  pins the overlap every time (physics unchanged), but only the first
  contact of a frame spends the charge; `update()` clears every flag
  once at frame end, and `spawnLevel()` resets them on (re)spawn. The
  flag is a plain boolean on the existing pool entry — no allocation,
  the #22 fixed-pool/no-churn rule intact; the clear is one pass over the
  50 slots, negligible at 60 fps. Locked in by the seam-scrape
  regression test (two same-frame contacts on hp-2 bricks end the frame
  at hp 1, alive; only a next-frame contact is lethal) and by the two
  multi-strike fixtures ported to the one-strike-per-frame contract
  (a `g.tick(1)` boundary between strikes). Alternatives: make the
  drain loop remember the last resolved brick per sub-step (rejected —
  special-cases one drain shape, and other multi-contact paths within
  a frame would still double-charge), or charge damage on
  frame-boundary contact scans instead of on resolution (rejected —
  rewires the collision pipeline for a per-flag fix).

## 2026-10-31 — Ticket #42 review round 2: bound the sub-step seam drain

- **The post-hit drain in `updateBalls()` is bounded by
  `MAX_BRICK_RESCANS_PER_SUBSTEP` (= pool size + 1).** The unbounded
  `while (collideBricks(b)) {}` spun forever on one fixture: a ball
  wedged 0.5 px into a row-centre face, gap (6 px) narrower than the
  ball (2·R = 14 px). Geometry proof of infeasibility: clearing the
  left neighbour requires the centre ≥ leftRightFace + R; clearing the
  right neighbour requires it ≤ rightLeftFace − R; the two bounds sit
  2·R − GAP = 8 px apart — no position satisfies both. Pre-#42 the
  loop terminated only because the re-contacted brick DIED on
  contact (one-hit tiers); the per-frame charge cap made the
  re-contact persistent and damage-free, so each drain iteration
  ping-pongs the pin between the two faces and flips `vx` forever
  (verified: 9-hour hang in `bricks-grid.test.mjs`, caught by the
  process watchdog). The cap is a plain counter over the existing
  call — no allocation; worst case 51 rescans × 50 pool entries per
  sub-step, reachable only in the pathological wedge, negligible at
  60 fps. Residual overlap past the cap is accepted as a documented
  one-brick seam artifact (the frame ends with the ball in flight,
  each seam member at exactly −1 hp). The grid suite's wedge test now
  locks termination + accounting instead of "zero live overlap"
  (geometrically unreachable), and its two double-strike fixtures
  gained the mandatory frame boundary between strikes (same-frame
  double-strike was never a legal contract under the cap).
  Alternatives: skip charged bricks in the drain scan (rejected —
  leaves the ball stuck inside a charged brick; the pin IS the
  useful part of a charged re-resolution), or deepen `BRICK_PIN_EPS`
  / nudge wedged balls out along `vy` (rejected — heuristic nudges
  couple to fixture geometry and still admit other non-convergent
  pin pairs).
## 2026-11-01 — Ticket #43: pattern tables, fixed bricks and the tunnel reading

- **`LEVEL_PATTERNS[0]` (level 1) stays a full 5×10 grid with the historic
  tier rows (A/B/C/A/B), and its letter order is chosen so that the three
  probe cells of the grid suite — (4,5)=B, (0,0)=A, (2,9)=C — remain three
  distinct colours, and every bottom-row cell the six sibling suites kill by
  coordinate stays live.** The other three patterns carry the variation:
  a gated fort (fixed top wall + two-column gate), a checker scatter and a
  fixed-slab overhang. Alternatives: vary level 1 too (rejected — six
  suites address concrete level-1 cells; rewriting them all would churn
  tests whose subject is not this ticket), or derive patterns from the
  old row-shift (rejected — the ticket names a literal row-string table).
- **The fixed brick is the fourth `BRICK_TIERS` entry
  (`COLOR_BRICK_FIXED`, 0 points, `unbreakable: true`) indexed by
  `TIER_FIXED`, and each pooled brick carries an `unbreakable` flag set
  from the pattern letter at spawn time.** `collideBricks` and
  `destroyBrick` gate on the *brick's* flag rather than a tier lookup, so
  the kill and reflect paths stay single-branch; `drawBricks` is
  untouched — the fixed colour falls out of the existing tier-colour
  lookup, keeping the draw pass branch-free as always. `bricksLeft`
  counts non-X cells only, which is what makes "clear the breakables,
  fixed bricks remain, win fires" fall out of the existing O(1) check.
  Alternatives: special-case `TIER_FIXED` at every use site (rejected —
  re-scatters one concept over the physics, scoring and draw passes),
  or a separate `fixed` pool (rejected — doubles the pool the ticket
  pins to `BRICK_ROWS * BRICK_COLS`).
- **The tunnel criterion's "topmost occupied row" is read as the
  pattern's minimum occupied row** (the row from which the ball's pocket
  behind the wall is measured): a qualifying pair needs zero breakable
  cells in both columns on every row below it. Pattern 1 qualifies with
  columns 4–5 — entirely empty below its fixed top wall, so the ball is
  guided up through the gate and back down the same channel. The check
  counts breakable cells only, per the ticket's literal wording; the
  shipped patterns additionally keep the whole channel empty of fixed
  bricks, so the corridor is physically passable. Alternative reading
  (per-pair topmost occupied row) would make a fully empty pair
  ill-defined — rejected as the weaker specification.
## 2026-11-01 — Ticket #44: persisted difficulty selector (presets, run snapshot, expand baseline)

- **Preset values are the author's choice** (the ticket names the knobs, not
  their numbers): easy `{serveSpeed 400, paddleWidth 150, dropRate 0.35}`,
  hard `{560, 96, 0.15}`, and `normal` references the existing named
  constants (`BALL_SERVE_SPEED`, `BASE_PADDLE_W`, `POWERUP_DROP_RATE`) so
  the default experience is byte-identical to before and the constants
  stay the single source of truth. Symmetric ±~20% spread around legacy.
  Alternatives: percentage deltas (rejected — opaque at the tuning site),
  keeping three literal copies (rejected — normal drifting from the
  constants would fork the legacy tuning).
- **Direction: easier = slower serve, wider paddle, MORE capsules; harder
  = faster, narrower, fewer.** Capsules are player aids (expand, extra
  ball, sticky), so generosity scales with ease. Alternative: hard gets
  more capsules as "extra reward" (rejected — contradicts the aid
  framing).
- **The expand power-up now widens from the RUN's base width**, a new
  `basePaddleW` state snapshotted in `beginRun()`, instead of the raw
  `BASE_PADDLE_W` constant — otherwise an expand caught on easy/hard
  would relax back to the wrong (normal) width. Alternatives: recomputing
  from the preset on expiry (rejected — re-reads selection that could
  legitimately differ from the running preset) or leaving it (rejected —
  a real correctness bug for non-normal presets, covered by a test).
- **Selection persists on change only**: clicking the already-active
  option is a no-op, so an idle screen never chatters localStorage
  writes. Stored values are validated against the table keys and the
  string type; anything else (unknown name, corrupt JSON, non-string)
  falls back to `normal` so a botched write can never break boot — the
  same posture as `loadHighScore`.

## 2026-11-01 — Ticket #45: life-restore and score-multiplier capsules (values and colours)

- **`MULT_VALUE = 2`, `MULT_DURATION_S = 6`** (the ticket names neither). The duration mirrors the sibling timed effects (`PADDLE_EXPAND_DURATION_S`, `STICKY_DURATION_S`) so the whole power-up family shares one rhythm; value 2 doubles tier points for EVERY tier (the ticket names tier A only; applying it uniformly is the simpler rule, so B/C kills are doubled too) and is the weakest non-trivial multiplier, keeping scores in band with the existing hiscore tuning. Alternatives: value 3 (rejected — inflates scores fast on the 10-wide tier-A rows), stacking/stacked windows (rejected — the ticket specifies re-arm, not extend).
- **Window mechanics mirror `expandUntil`**: `multUntil` stores the expiry, `updatePowerups()` clears it to -1 at expiry, `destroyBrick()` tests `simTime < multUntil`. Alternatives: a boolean flag toggled by the timer (rejected — two-state drift risk), subtractive countdown (rejected — inconsistent with the other armed windows).
- **Colours**: `COLOR_CAPSULE_LIFE = "#ff5c7a"` (warm rose — reads as heart/life), `COLOR_CAPSULE_MULT = "#6eff8f"` (mint — reads as bonus/gain); both distinct from the yellow/cyan/purple already in use.

## 2026-11-01 — Ticket #46: three selectable retro themes (THEMES table, one-pass apply, persistence)

- **`THEMES` is one row per skin holding the CSS custom-property triple
  (`bg`/`accent`/`ink`) and the canvas palette mirrors the draw pass
  reads (`COLOR_BG`/`COLOR_PADDLE`/`COLOR_BALL` plus the four
  `BRICK_TIERS` colours in A/B/C/fixed order).** `classic` references the
  named module-load constants for every mirror (the `DIFFICULTY.normal`
  row precedent), so the legacy look keeps one source of truth; the
  other two rows are literal hex (the ticket's neon-cyberpunk and
  minimalist concepts). `applyTheme()` is the single apply path shared
  by boot and selection change: it writes the CSS triple onto
  `document.documentElement` and every canvas mirror in one pass — the
  draw code itself never changes and keeps reading the same variables,
  so theming adds zero per-frame branches (locked in by the one-pass
  test that reads the globals in the running context after a click).
  Alternatives: a per-draw theme lookup (rejected — per-frame branches,
  the ticket forbids them), separate constants per theme
  (rejected — dead parallel palettes).
- **The brick tiers' dimmed `dark` variants are re-derived inside
  `applyTheme` via the existing `darkenHex` rule, so damage dimming
  stays exactly the 0.45-factor rule per theme.** Alternative: store a
  pre-baked `dark` per row (rejected — doubles the table data and could
  drift from the rule).
- **The CSS write degrades silently when there is no
  `documentElement.style` (the vm test stubs of the sibling suites),
  leaving the canvas mirrors to carry the skin on the playfield.**
  Mirrors the Web-Audio `typeof`-guard silent-degradation precedent
  (ticket #9); the alternative — forcing all twelve sibling harnesses
  to stub `documentElement` — buys nothing the game needs.
- **The translucent accent tints (difficulty/theme option borders and
  button hovers, `rgba(92, 242, 176, …)`) stay at the legacy teal under
  every theme.** The ticket scopes the theme surface to the
  `--bg`/`--accent`/`--ink` triple and the canvas palette; re-tinting
  those would need extra custom properties (e.g. a per-theme
  `--accent-soft`) the ticket does not ask for. The theme buttons reuse
  the exact `.difficulty-opt` pattern (group div, `.opt` buttons,
  `.selected` mark) so the start-screen markup and the harness stubs
  stay uniform across both selectors.
- **Persistence mirrors the difficulty selector exactly: JSON string
  under `THEME_KEY = "brickbreaker.theme"`, validated against the table
  keys and the string type at boot, unknown/corrupt/non-string values
  falling back to `classic`, and a no-op on re-clicking the active
  skin so an idle screen never chatters writes.** Alternatives: a
  separate encoding (rejected — the high-score/difficulty precedent is
  the house style), applying the theme only per run like difficulty
  (rejected — the ticket says applied at boot AND on selection change,
  and the draw pass is cheap enough that a live apply is a three-write
  CSS + nine-assign pass with no gameplay cost).

## 2026-11-01 — Ticket #47: sound toggle + volume slider (placement, invalid-value policy)

- **The controls live on the start screen, as a row below the theme
  selector (`#btn-mute` toggle button + `#sound-volume` range
  input, 0–100).** The ticket allows "start screen (or HUD)"; the
  start screen already hosts every persisted preference
  (difficulty, theme), and a mute/volume row there keeps the HUD
  clear of non-status chrome. The toggle communicates state via its
  label ("Sound On"/"Sound Off") and a `.muted` accent class — the
  same state-mark pattern the option selectors use — instead of
  `aria-pressed`, which the vm harness element stubs would have
  needed to grow for every suite.
- **Invalid *stored* fields fall back to the defaults per field
  (unmuted, volume 100), while *in-flight* slider values are clamped
  into [0, 100].** Loading mirrors the house fallback precedent
  (difficulty/theme: invalid stored value → default, never crash);
  clamping at load would silently invent a level the user never set.
  The slider's own handler still clamps because the value is read
  from the DOM and a programmatic out-of-range write must degrade
  cleanly. Re-applying an identical `{muted, volume}` pair is a
  no-op (no redundant storage write), matching the
  selectDifficulty/selectTheme precedent.
- **`MASTER_GAIN` stays the single live knob:** the settings block
  recomputes `MASTER_GAIN = effectiveMaster()` at boot and on every
  accepted change, and neither `ensureAudio()` nor `scheduleSound()`
  gains branches — mute wins over volume, a muted boot never blocks
  gesture context building, and console reassignment of
  `MASTER_GAIN` keeps its ticket #27 meaning until the next settings
  change. Alternatives: a dedicated `effectiveMaster()` read in
  `scheduleSound` (rejected — two sources of truth for the bus level)
  and skipping scheduling while muted (rejected — the silence must be
  the bus, so unmuting changes only a gain value, mid-run).
## 2026-11-01 — Ticket #48: high-score reset and local top-five leaderboard
- **The two on-screen leaderboard containers are
  `#leaderboard-start` and `#leaderboard-gameover`, sharing the
  `leaderboard` class; each screen carries exactly one.** The ticket's
  "`#leaderboard` element" wording is taken as "an element
  identifiable as the leaderboard"; literal duplicate `id="leaderboard"`
  in one document would be invalid HTML (ids must be unique), and moving
  a single element between sections would break the always-present
  start-screen display the ticket requires. Locked in by the
  HTML-shape test (one container per section, one reset button).
- **Boundary rule: a run's final score qualifies iff it is an integer
  > 0 and the list has room (< 5 entries) or strictly beats the list's
  lowest entry — a tie with the lowest of a FULL list never displaces
  it, and duplicates are kept while there is room.** A rejected tie
  performs no storage write at all. Alternatives: replace-on-tie
  (arbitrary — the incumbent's position in time is unknowable) and
  deduplicate-on-insert (drops genuine repeated scores while there is
  room). Locked in by the tie, duplicate and top-five-truncation tests.
- **An empty list renders as one placeholder row ("no scores yet") on
  BOTH screens rather than hiding the containers.** Keeps both
  screens' layout identical between states; the ticket allows either
  (hidden or single placeholder row) and the placeholder is the
  self-documenting choice.
- **Load is defensive and validating: the stored value must parse to an
  array whose every entry is a positive integer, else the list starts
  empty; valid lists are re-sorted descending and re-capped to five at
  load.** Mirrors the high-score/difficulty/loadTheme corrupt-fallback
  house style; hand-edited or drifted storage is normalised, never
  trusted. Alternatives: trust the stored order (rejected — one
  hand-edit away from a broken ranking) and filter individual bad
  entries (silent data loss, harder to explain).
- **The reset control (`#btn-reset-hiscore`) deletes BOTH
  `brickbreaker.highScore` and `brickbreaker.leaderboard` and drops
  both in-memory mirrors to their empty baselines in one click;
  `removeItem` failures degrade like the other storage paths
  (in-memory reset still applies).** The ticket names it the
  documented single control for both; a per-key confirm dialog was
  rejected as scope creep.

## 2026-11-01 — Ticket #49: engine firing animation (geometry, flicker source, colour)
- **The flame is a single triangle from the hull's rear notch: base
  points at local (−0.4·SHIP_RADIUS, ±0.35·SHIP_RADIUS), tip at
  (−0.4·SHIP_RADIUS − len, 0), drawn inside the hull's existing
  save/translate/rotate block so it inherits the heading and the
  invulnerability blink for free.** The ticket mandates the knobs,
  flicker and heading inheritance but not the shape; a rear triangle
  is the classic Asteroids reading and needs exactly three inline
  coordinates (zero allocation). Alternatives: a two-segment flame
  with a curved base (more points, no readability win) and a
  sprite-like pre-built path (needs stored state).
- **Flicker is `random()` per frame: len = MIN + (MAX − MIN) ·
  random().** Reuses the campaign's injectable random source (same
  convention as particles and SFX noise), which keeps the test suite
  able to pin a deterministic sequence and keeps the console
  retunable through the `var` knobs. Alternatives: frame-parity
  alternation (only two legal lengths, less organic) and a
  sine-of-gameTime oscillator (correlates every ship; rejected).
- **The flame fills with #fbbf24 (the impact-fragment amber) and
  strokes with the hull's already-set UI_ACCENT / lineWidth 2, per the
  ticket's "existing stroke/fill pattern".** Keeping the existing
  stroke state avoids extra ctx assignments in the hot path; reusing
  the particle amber ties the flame into the existing palette without
  a third colour. Alternative: a pure UI_ACCENT flame (less readable
  against the teal HUD/stroke palette).
## 2026-11-01 — Ticket #52: wrap lasers around the screen edges

- **`LASER_LIFETIME_S` is a console-retunable `var` defaulting to 1.5 s.**
  With wrapping, a beam has nowhere to leave to, so the old "recycle on
  first off-screen exit" rule is obsolete and the lifetime is a pure
  tuning choice. 1.5 s at the default 700 px/s covers ~1050 px — more
  than a 960×600 field's width or height and within one body of its
  1131 px diagonal, so a default beam travels about as far as the
  longest old-beam flight; the knob retunes from the console either
  way. Alternatives: derive the lifetime from canvas size at boot
  (rejected — a console resize would desync it, and the criterion asks
  for a named sim-time constant) or an integer frame count (rejected —
  the criterion names a `*_S` seconds value). Declared `var` per the
  ticket-#2/#3 precedent for console retuning.
- **Wrap margin is the beam's own `LASER_LENGTH`, ship-convention:
  x/y each wrap independently once the beam CENTRE is fully past the
  edge by `LASER_LENGTH` (≥ half the beam), re-entering the opposite
  edge offset by `w + 2·LASER_LENGTH` / `h + 2·LASER_LENGTH` — the
  exact remainder, mirrored symmetrically like the ship (`±2·margin`).**
  Independence of axes is what makes the near-corner diagonal wrap
  both edges in the same update and re-emerg at the opposite corner.
  Alternatives: margin 0 (rejected — half the beam vanishes then
  reappears, the ship-wrap defect the #2 decision already rejected) or
  margin `LASER_LENGTH/2` (works, but the ticket pins the margin at
  `LASER_LENGTH`, and the wider band gives the entry/exit a visible
  glide-in rather than a pop).
- **Cross-seam kill detection needed NO change to `checkLaserKills`:
  the sweep segment is reconstructed backwards from the CURRENT
  (already-wrapped) position — `prev = pos − dir·speed·dt` — which
  after a wrap lands in the matching periodic copy of the field, and
  that lifted segment IS the beam's true entry-side sweep.** A rock
  just inside the opposite edge is hit by that segment on the frame(s)
  the beam traverses it. Proven by the deterministic cross-seam kill
  fixture (parked rock, single beam, exact-remainder arithmetic).
  Alternatives: explicit per-axis wrap flags and dual segment tests
  (rejected — more hot-path work for a result the backwards
  reconstruction already yields) or torus-distance math (rejected —
  overkill for a straight-line sweep).
- **`tests/lasers.test.mjs` adaptations (documented in the file header):**
  the old "deactivate once off-screen" test was rewritten for wrap +
  lifetime recycling; the 2 s cooldown soak raises `LASER_LIFETIME_S`
  to 10 s (under the old cull, the giant canvas kept the beam alive
  for the window — the lifetime knob now does that job); the
  pool-saturation soak (pathological `LASER_SPEED = 0`) raises
  `LASER_LIFETIME_S` to 100 s so the default 1.5 s life cannot reclaim
  slots before the 32-slot pool saturates. All other campaign-1 suites
  needed no adaptation.

## 2026-11-01 — Ticket #50: accelerating thrust and coast inertia

- **Two-phase ship dynamics replace the old thrust+always-on-friction mix:
  held thrust integrates `THRUST` along the heading and hard-caps the
  resulting speed at `SHIP_MAX_SPEED` (direction preserved); with no
  thrust key held, velocity decays by `v *= SHIP_COAST_FRICTION^(dt·60)`
  and the existing `STOP_SPEED` snap ends the coast.** The hard cap is
  what makes "hold longer → faster" read as building momentum (linear
  ramp in ~0.52 s at default `THRUST = 420`), instead of the old 0.90
  retention fighting the thrust into a low, invisible plateau
  (~63 px/s). Defaults: `SHIP_MAX_SPEED = 220` px/s (3.5× the old
  plateau, still ~1.4 s to cross the 960 px field),
  `SHIP_COAST_FRICTION = 0.95`, `SHIP_SPEED_EPS = 1` px/s,
  `COAST_SETTLE_S = 2.0` s. All four are top-level `var`s — console-
  retunable, per campaign-1 precedent.
- **`SHIP_COAST_FRICTION = 0.95` is chosen to sit between both ticket
  bounds with margin, verified by driven frames in
  `tests/ship-thrust.test.mjs`:** after 0.25 s the retained fraction is
  `0.95¹⁵ ≈ 0.463` (bound: ≥ 0.25), and a coast from the 220 px/s cap
  falls below `STOP_SPEED` (1 px/s) after ⌈ln 220 / −ln 0.95⌉ = 106
  frames ≈ 1.77 s (bound: within `COAST_SETTLE_S` = 2.0 s, so 1–3 s).
  Rejected alternatives: (a) instant stop on release — no inertia at
  all, the exact complaint that filed this ticket; (b) pure
  exponential decay without the `STOP_SPEED` snap — the ship would
  glide at sub-pixel speeds forever (the "exactly zero" bound would be
  unreachable); (c) one shared friction for thrust and coast — friction
  while thrusting turns the top speed into an ASYMPTOTE
  (`THRUST·f/(1−f)`) that is approached, never attained; forcing all
  three bounds to hold at once pins `f ≈ 0.969` with a ~2.9 s settle —
  zero margin against console retunes, and the ramp reads as the old
  plateau. Two phases, two named knobs, each retunable independently.
- **`COAST_SETTLE_S` ships in the game source as a contract constant
  (not read by the update loop): the friction + snap combo is what
  enforces it, and the vm suite asserts the bound by driving frames.**
  Kept as a named `var` so a console retune of `SHIP_COAST_FRICTION`
  has a documented target; re-tuning it back in violation is caught by
  the settle test. Alternative: compute it from the other two (rejected
  — a derived constant would hide the intent and die with a retune).
- **Existing campaign-1 suites: no fixture values needed changing.** The
  lasers "ghost thrust after blur" soak rests the ship within a
  120-frame (2 s) window — still satisfied, from ~210 px/s the new coast
  snaps at frame ~105; its comment now names the coast mechanism
  instead of the retired `FRICTION`. Every other suite parks or zeros
  the ship velocity explicitly, so the old curve was never encoded in a
  fixture number.
## 2026-11-01 — Ticket #51: split shot asteroids large -> 2 medium -> 2 small

- **Tier geometry: `ASTEROID_R_LARGE = 24` px, geometric descent through
  the named ratio `ASTEROID_SIZE_RATIO = 0.5` -> medium 12 px, small 6 px
  (exactly the former `ASTEROID_MIN_R`); `ASTEROID_CHILDREN = [2, 2, 0]`
  names the fragment count per tier.** The old random-radius range
  (`ASTEROID_MIN_R`/`ASTEROID_MAX_R`) is gone: rocks of a tier are
  indistinguishable except by spin, which reads cleaner at fixed sizes.
  Scoring follows Paul's classic ordering: `SCORE_PER_LARGE = 20`,
  `SCORE_PER_MEDIUM = 10`, `SCORE_PER_SMALL = 5` (mutable `var` knobs,
  read on every kill so console retunes apply immediately). Edge spawns
  are always the large tier — the wave rosters (`ASTEROID_BASE` /
  `ASTEROID_GROWTH`) now count LARGE rocks, and the large-build pauses
  while fragments hold pool slots. Alternatives: keep random radii with
  a tier cut (rejected — two "medium" sizes would be indistinguishable
  in score) or a three-level linear scale (rejected — the ticket names a
  ratio, and a 2:1:1 cascade of equal halves is the arcade feel).
- **Chain-kill protection is per-BEAM identity, not per frame: each beam
  carries a monotonically rising `serial` (assigned in `tryFire`), and a
  shatter fragment records its parent's killer in `splitBy` — immune to
  that one beam for its whole remaining life (1.5 s), while any OTHER
  beam (or the ship) can hit it normally. On the shattering frame, the
  `bornFrame` stamp additionally shields fragments from every beam.** A
  beam slot released by a test without `tryFire` keeps serial 0, which is
  "identity unassigned" and grants no immunity. Alternatives:
  birth-frame-only immunity (rejected — the shattering beam sweeps the
  fragment band for up to 1.5 s and would eat its own cascade) or
  permanent per-rock laser immunity (rejected — fragments would be
  unkillable by the next shot, breaking the cascade game).
- **Saturated-pool rule: a shatter frees the parent slot FIRST, then
  spawns as many fragments as fit (never allocating).** With 48 slots a
  saturated wave can lose at most `wanted − free` fragments; the rule is
  pinned by the saturated-pool fixture (one free slot -> exactly one
  medium spawns). Alternative: drop the shatter when no fragments fit
  (rejected — the kill and its score must still stand).
- **Wave completion generalizes ticket #7's gate: roster fully spawned
  (`waveBuilt`, counted by edge spawns only) AND zero live hazards of ANY
  tier — live fragments keep the wave open; a zero roster still cannot
  complete.** Both directions are re-tested in `tests/asteroid-split.test.mjs`.
- **Existing-suite adaptations (each documented at the change site):**
  `asteroids.test.mjs` — per-tier score constants replace
  `SCORE_PER_ASTEROID`; `placeAst` gains a tier argument; seeded spawn
  streams re-derived (the radius roll left the spawn sequence, so cycle
  lengths and coordinates shifted, e.g. right-edge candidate 317 -> 325,
  top-edge spawn -17 -> -25); the population soak runs an invulnerable
  ship (hull impacts now shatter and would push the live count past the
  roster); the "frame-1 sweep 23..34.7 px" assumption was WRONG — the
  bootstrap tick integrates with dt = 0, so the beam only releases from
  the nose and hit-tests as a point; kill fixtures now straddle the nose
  (y = 277). `lasers.test.mjs` — the cross-seam fixture's death is now
  asserted via the large-rock score + its 2 medium fragments (the slot is
  reused by its own fragment, so "rock gone" no longer terminates);
  score expectations follow the fixture's default tier. `screens.test.mjs`
  — the parked-rock kill leaves 2 medium fragments in the field (and the
  death-residue precondition counts 3 x 2 shatter fragments from
  `killShip`), and its laser kill pins `LASER_COOLDOWN_MS` so the held
  Space never releases a second beam. `sfx.test.mjs` — kill expectation
  follows the fixture's default tier. All other suites passed untouched.

### 2026-11-01 — review folds: explicit hazard kind, dead edge-spawn stamp, explicit fixture tiers (ticket #51)

Follow-up to the entry above, from code review:

- `applyHullImpact(hazard, isRock)` now takes the hazard kind
  explicitly from its two call sites instead of duck-typing
  `hazard.tier !== undefined` — a drone slot that ever grew a `tier`
  property would have been routed through `shatterAsteroid`
  silently. Drones stay no-split by construction: the caller passes
  `false`, the pipeline destroys the slot outright.
- The edge-spawn `bornFrame = frameNo` stamp was removed: edge rocks
  are born in `updateWaves`, which runs after `checkLaserKills` in
  the same frame, so an edge rock is first hit-tested on
  `frameNo + 1` and can never satisfy the `bornFrame === frameNo`
  guard. Stamping the identity value `0` instead ("not birth-stamped
  this frame"); shatter fragments keep their live stamp, which is the
  only case where the guard can fire.
- The `placeAst` fixture helpers in `lasers`, `drones`,
  `ship-damage`, `screens` and `sfx` now set `s.tier = 0` explicitly
  rather than relying on the pool slot's initial value surviving a
  prior fragment occupancy.
- Review also surfaced a pre-existing bug unrelated to this ticket:
  `tryFire` reuses a laser slot without resetting `slot.dt`, so a
  fresh beam's first sweep segment is lengthened by the previous
  occupant's step (a short phantom reach behind the nose). Tracked
  separately (issue #67), not fixed here.

### 2026-11-01 — laser: reset slot.dt on fire (ticket #67)

Bug: `tryFire` reactivated a recycled laser slot without resetting
`slot.dt`, and `checkLaserKills` rebuilds each beam's swept segment
backwards as `pos - dir * LASER_SPEED * s.dt`. A fresh beam therefore
carried its previous occupant's last step as phantom reach behind the
muzzle (up to `LASER_SPEED / 30` ≈ 16.7 px at defaults): a rock parked
just astern of the nose could score before the beam had visibly
reached it, and the first-frame sweep was asymmetric with every later
frame.

Fix: `slot.dt = 0` at (re)initialization in `tryFire`, beside the
existing x/y/dx/dy writes. The beam starts as a point at the muzzle
and its swept segment grows from its own motion only.

Rejected alternative: clamp or reject the first hit-test frame inside
`checkLaserKills` (e.g. `if (s.framesLive === 1) use a point`) — it
would add a per-frame branch in the hot loop to compensate for an
initializer that should have been complete; fixing the writer is the
single-line structural fix, and it matches the documented bootstrap
behaviour (first rAF frame carries dt = 0; the beam releases from the
nose as a point).

Test: `tests/lasers.test.mjs` gains a recycled-slot fixture — the
slot's previous occupant fires several frames, dies, the slot recycles
to a fresh beam aimed at a rock parked ~10 px astern of the nose; the
rock must NOT score on the fresh beam's first hit-test frame, and
MUST score once the beam's own swept front crosses it a few frames
later. The fixture probes the `tryFire -> checkLaserKills` hand-off
state directly (the two calls, back to back): in the shipped frame
order `tryFire` runs, then `updateLasers` overwrites `s.dt` with the
fresh beam's OWN step before the first `checkLaserKills`, so the stale
step never actually reaches the hit test in natural play at 60 fps
(the stale step would equal the fresh one). The test therefore pins
the initializer CONTRACT — if a future reordering hit-tested before
`updateLasers`, the stale step would resurface, and the suite would
catch it rather than shipping a rock that scores before the beam
visibly reaches it.

### 2026-11-02 — Bricks: playfield boundary render gating (ticket #69)

The ticket listed the game-over screen among screens where the walls
must NOT be drawn, but parenthetically instructed us to "match
whatever the current 'playing field visible' render gating is".
Verified against the code: `draw()` hides the field on the start
screen only — on "paused" and "gameover" it deliberately renders the
frozen field behind the overlay (documented in `enterGameOver`:
"the frozen field behind the overlay shows the ball at rest").
Decision: gate `drawBoundary()` with exactly that existing guard
(`gameState === "start"` early-return), so walls appear in
playing/paused/gameover frames and never on the start screen.

Rejected alternative: drawing the walls only in "playing"/"paused" —
it would leave the game-over field with bricks, paddle and ball but
no boundary, a visually inconsistent state the ticket's own
"match the current gating" instruction rules out.

### 2026-11-02 — Bricks: boundary colours as two explicit palette keys (ticket #69)

`THEMES[name].palette` gains `wall` and `danger` alongside
bg/paddle/ball/bricks, mirrored onto `COLOR_WALL`/`COLOR_DANGER` in
`applyTheme` (same write-through pattern). Values reuse existing
palette hues so each theme's pair reads as native: classic
`#5cf2b0` (accent) / `#ef5d62` (brick-A red), neon `#00f0ff` (accent)
/ `#ff2d78` (neon magenta brick), minimal `#14141a` (ink) /
`#57534e` (darkest stone brick). Rejected alternatives: one key plus
a `globalAlpha` fade for the danger line (the dash already provides
the "subtle" distinction; alpha would muddy the minimal theme's
near-monochrome ground) and reading the CSS `--accent` value (canvas
mirrors are the established palette source for the draw pass).

### 2026-11-02 — Bricks: dash arguments prebuilt at module load (ticket #69)

`DANGER_DASH = [12, 10]` and `NO_DASH = []` are module-load globals;
`drawBoundary` passes those same references to `setLineDash` every
frame (pattern, then reset). Writing a fresh array literal per frame
would be per-frame allocation in the hot path — banned by house rule.
Rejected alternative: setting the dash once at boot (a future caller
could clobber the state; explicit reset each frame keeps the draw
pass self-contained at negligible cost). The boundary suite pins the
reference identity across frames, so a regression to a per-frame
literal fails the suite.
### 2026-11-02 — bricks: main menu reachable from pause (M) and game over (ticket #70)

Return to the menu is `quitToMenu()` — the existing shared reset
`beginRun()` followed by `gameState = "start"` and `setScreen("start")`.
The ticket mandates that BOTH exits (pause-M and game-over Menu) funnel
through the one reset path first-start and restart already share, so
there is exactly one state-clearing implementation; the menu state
differs from a true boot only in that the level-1 board is spawned
(dormant under the overlay: `draw()` early-returns in "start", so the
field difference is invisible and the next Start click is an idempotent
`beginRun()`).
Rejected alternative: a dedicated boot-state reset (deactivate the
whole brick pool, no spawn) — a second state-clearing code path the
ticket explicitly forbids, and it buys nothing visible.

`KeyM` is state-gated to `"paused"` alone, with NO `pauseKeys`-style
edge tracking (unlike Escape/KeyP). M is a one-way transition, not a
toggle: once the first press flips the state to "start", browser
auto-repeat of the held key lands in a state where M is a no-op, so
repeat presses cannot churn screens. Adding M to the edge-held set
would be bookkeeping for a glitch the state gate already excludes.

The pause hint line (`Esc resume · M menu`) is a second DOM `<p>` in
`#screen-pause`, not canvas text: the existing pause copy is a DOM
overlay element (the ticket's "drawn on canvas" parenthetical does not
match the shipped implementation), so the hint rides the same
display-gated section — visible while paused, hidden otherwise, with
no new draw-pass machinery.
Rejected alternative: `ctx.fillText` in the draw loop — bricks.html has
no canvas text infrastructure yet, and a floating canvas line would not
track the overlay's layout.

### 2026-11-02 — Asteroids: "Enter on game over restarts cleanly" flake is a count-based checkpoint, not game nondeterminism (ticket #80)

tests/screens.test.mjs asserted an exact live hazard count (8) at the
game-over checkpoint. That count is not a game invariant: killShip parks
each hit rock on the ship, so a shattered rock's fragments spawn *within
the ship-overlap radius* too (parent at 25 px centre distance, overlap
radius 20+14=34 > fragment 12+14=26). Fragment headings/speeds come from
`random`, which the test never pinned — so at each 200 ms invuln expiry,
`checkShipHits` (first overlapping slot in slot order wins) legitimately
consumed a leftover fragment instead of the freshly parked rock ~24% of
runs (measured 400 replays: 95 runs at 6 hazards, 305 at 8). The
freshly parked death rock thus survives at the ship while a leftover
fragment is consumed instead; the game is deterministic given its RNG
stream, and nothing in asteroids.html is non-deterministic.

The checkpoint is now structural, per the ticket's fix direction: (a) the
two parked hazards are identified by their parked coordinates and zero
velocity, (b) the shatter residue is bounded *below* by the two
fragments the first hit rock must always leave (it is the only
overlapping hazard at its hit, and no later hit removes more residue
than it leaves — the smallest tier shatters into nothing, higher tiers
replace one hazard with two), and (c) the RNG is pinned to a constant for
the scenario so the residue layout is byte-for-byte reproducible (with
the pin the count settles deterministically at 6).

Alternatives rejected: pinning the RNG alone (deterministic but still
asserting a count that is not an invariant — it would break the moment a
tier table or invuln window moves); freezing fragment velocities after
each hit (does not help — frozen fragments still overlap the ship and
still win the slot-order race, and fights the sim); a real-game
change to make shatter fragments skip ship collision for a frame
(rejected — AC3 forbids game changes and the behaviour is legitimate
arcade physics).

## 2026-11-02 — Ticket #71: per-hit visual wear (shade ramp + crack)

- **Wear ramp is a linear multiplicative darkening: `ramp[d] = darken(base, 1 − BRICK_WEAR_STEP·d)` with `BRICK_WEAR_STEP = 0.28`, precomputed per tier into `BRICK_TIERS[t].ramp` (length `tier.hp` for breakable tiers, `[base]` for the unbreakable tier) and rebuilt in `applyTheme()`.** The 3-hp tier shows 1.00 / 0.72 / 0.44 — three distinct states with a 28% relative lightness step between neighbours, comfortably past the ~15% floor, and the deepest stage (~0.44) matches the legacy single dim's 0.45 so the classic look barely moves. Because each stage re-derives from the tier's CURRENT base colour, one formula yields a correct per-theme ramp: the theme pass just reassigns `.color` and calls `buildTierRamps()`. Alternatives rejected: equal-RGB interpolation toward a fixed shadow colour (steps shrink with the base's luminance, so early stages were imperceptible on the minimal theme's light stone colours), per-theme hand-tuned ramp tables (three palettes × four tiers of manual tuning for zero gain), or computing shades per frame (string churn in the hot path — the ticket forbids it). A console-retuned step outside [0, 1] is clamped inside `darkenHex` instead of letting negative factors poison the hex string.
- **Crack overlay: one polyline per damage taken, capped at `CRACK_LINES_MAX = 2`, drawn from a normalised point table `CRACK_POINTS` (per pool index: two polylines × three points) precomputed once at module load by a fixed integer scramble of the brick index.** The crack therefore has three properties the tests pin: it is deterministic (no `random` hook — the suites' RNG pin never touches it, and it is identical across frames and across respawned boards), it is per-brick (different index → different path), and deepening is prefix-stable (the stage-1 polyline stays put when the second line appears, so a brick "cracks further" instead of repainting randomly). Alternatives rejected: per-brick `random()` seeds (breaks the deterministic vm suites and changes the crack every respawn — exactly what the ticket forbids), per-frame crack geometry (arithmetic per brick per frame for something that never changes; the table costs ~1 KB at boot), or a richer jagged path (more than two short polylines adds no perceptual signal on a 26-px-tall brick and burns draw calls).
- **Crack ink is the tier's deepest ramp stage (`tier.ramp[tier.hp − 1]`) rather than a fixed dark colour.** The ink then tracks the theme (a grey-black seam on the light minimal ground, a deep magenta on neon) and the draw path stays a pure table index. Rejected: a constant near-black stroke (clashed with the minimal theme's off-white ground) and per-frame shade mixing (allocation).
- **The unbreakable tier keeps the bare fill path**: its ramp is `[base]` and its hp delta is permanently 0, so `drawBricks` issues exactly the same two ops it always did (base-colour `fillRect`, no strokes) — the ticket's "render path unchanged" reads as a byte-identical recorded op sequence in the durability suite, and single-hit (tier C) bricks likewise never leave `ramp[0]` because their first hit is lethal.
## 2026-11-02 — Ticket #72: audible chip cue on non-lethal multi-hit brick hits

- **Pitch is keyed on the hp the brick had AT IMPACT (pre-decrement), not
  on the hp remaining after.** The acceptance criterion names the 3-hp
  brick's first chip "tier-3" and its second "tier-2", which matches
  pre-decrement hp exactly. Alternative: key on remaining hp (first chip
  would be the tier-2 pitch) — rejected, contradicts the criterion's
  naming.
- **Frequencies as a named `var` table `SFX_BRICK_CHIP_FREQ`
  (`[0, 440, 550, 660]`, index = hp) plus the shared recipe object
  `SFX_BRICK_CHIP` (`{ wave: WAVE_SINE, freq, dur: 0.04 }`).** All entries
  sit below the destruction pop (900 Hz) so chip and pop read
  differently, and the spacing (440→550→660) is wide enough to read as
  distinct pitches even on a small speaker. The recipe object is reused
  and mutated in place by `scheduleBrickChip(hpAtHit)`, so the hit path
  allocates nothing beyond what `scheduleSound` already allocates (one
  oscillator + one envelope gain). Alternatives: one flat `var` per hp
  (rejected — a table indexes naturally by hp and scales to a hypothetical
  4-hp tier with no code change); computing the pitch arithmetically
  (rejected — the ticket asks for named, console-retunable values).
- **The chip is routed through the unchanged `scheduleSound` path**, so
  it inherits the master bus, mute, volume, the SFX_PEAK/SFX_DECAY_FLOOR
  envelope clamps and the gesture-gated context for free — no new
  AudioContext, no new bus, no new DOM elements. Alternative: a dedicated
  chip-only gain chain (rejected — unnecessary; the ticket explicitly
  reuses the existing plumbing).
- **Only `else` (non-lethal) hits call `scheduleBrickChip`; the fatal
  branch still routes solely to `destroyBrick`.** Chip and pop are
  mutually exclusive by construction (if/else), not by suppressing one
  sound after scheduling both. Alternative: schedule both and rely on
  timing (rejected — the criterion demands exactly one).

## 2026-11-02 — Ticket #73: start-screen ball-speed slider (50–150%, persisted)

- **The slider scales the run's PRESET serve speed (difficulty × percent), not only `BALL_SERVE_SPEED`.** The begin-run path already snapshots `DIFFICULTY[selectedDifficulty].serveSpeed` (whose normal row references `BALL_SERVE_SPEED`), so applying one `speedFactor = ballSpeedPct / 100` to the preset serve AND the `MAX_BALL_SPEED` ceiling yields the ticket's numbers at default difficulty (125% → 600 px/s launch, 1875 ceiling) while easy/hard runs stay consistent (their serves scale by the same factor — curve shape and relative tier speeds preserved). Alternatives: rewriting the global `BALL_SERVE_SPEED`/`MAX_BALL_SPEED` vars (rejected — the ticket says the `var` knobs are "scaled, never replaced", and the `DIFFICULTY.normal` row references them, so mutating them would poison the table); scaling only the normal preset (rejected — mixed scaled/unscaled difficulty tiers would be surprising).
- **The ceiling is a per-run runtime var `serveCeiling`, snapshotted beside `serveSpeed` in `beginRun()`**, so `advanceLevel()` caps at `serveCeiling` and a mid-run slider move can never shift the live run. Alternative: computing `MAX_BALL_SPEED * ballSpeedPct/100` inside `advanceLevel()` (rejected — it would read the LIVE slider mid-run, violating the begin-run snapshot rule the ticket shares with difficulty/theme/sound).
- **Persisted as a JSON integer under `brickbreaker.speed` (the high-score / difficulty / theme / sound encoding precedent).** The loader accepts only integers within `[MIN_BALL_SPEED_PCT, MAX_BALL_SPEED_PCT]` (50..150) and falls back to `DEFAULT_BALL_SPEED_PCT` (100) on absent, corrupt or out-of-range values; the input listener clamps programmatic out-of-range writes into range and treats non-integers as "keep current" (the volume-slider precedent). Alternatives: storing a JSON string (rejected — the ticket names an int percent); passing out-of-range stored values through (rejected — a botched write must never skew run speeds).
## 2026-11-02 — Ticket #77: secret level-skip keys (Shift+L / Shift+K)

- **Forward step (Shift+L) is the REAL `advanceLevel()` itself, not a
  copy of its body.** "Exactly as if the current one were cleared" is
  guaranteed by construction (same expression, same `MAX_BALL_SPEED`
  cap, same respawn/serve/hud sequence), and there is no second
  clear-progression path to drift. Alternatives rejected: duplicating
  the three-line body (a future cap tweak would silently fork the
  cheat and the real path); refactoring to a shared `setLevelTo(k)`
  (larger blast radius for zero benefit while the forward step is a
  pure increment).
- **Backward recompute derives from a new runtime `var runServeBase`
  snapshotted in `beginRun()` from the selected difficulty preset's
  `serveSpeed` × the run's ball-speed percent (ticket #73's factor —
  included so a back-step lands where a forward run stands under any
  slider setting)** — the house-standard pattern (`serveSpeed`,
  `dropRate` snapshot the same way), console-retunable, and immune to
  mid-run `DIFFICULTY` edits. The target level's speed is
  `min(runServeBase × LEVEL_SPEED_GROWTH^(target−1), serveCeiling)`,
  i.e. the level's own legitimate speed against the run's scaled
  ceiling, so stepping back after
  forward skips (or after cap saturation) is exact to the prescribed
  recompute formula (±1 ULP vs the forward `serveSpeed × growth`
  chain at deep levels — a Math.pow association difference, ~1e-13
  px/s, never a delta in any practical sense).
  Alternatives rejected: recomputing from
  `DIFFICULTY[selectedDifficulty].serveSpeed` at press time (would
  silently change under console retunes and trusts the start-screen
  state mid-run); dividing the drifted `serveSpeed` by the factor
  (float division loses low bits versus the straight product —
  `base·g²/g ≠ base·g` in IEEE 754 — and the cap is unrecoverable by
  division).
- **The combo is read as `e.shiftKey` on the letter's keydown only;
  no Shift keyup bookkeeping.** Releasing Shift before the letter is
  dispatched with `shiftKey: false` and is simply not a press of the
  combo, which is exactly the leak the ticket forbids. Shift-then-
  letter is the one supported ordering (documented nowhere, as
  intended); a letter held down while Shift arrives is not retro-
  triggered (browser-delivered, and no suite can rely on it either).
  Alternative: tracking Shift in the held-sets and triggering on
  Shift-down (adds keyup/blurred-window state for a combo nobody
  asked for).
- **Edge gating mirrors `pauseKeys`: a `levelSkipKeys` Set
  (added on the triggering keydown, removed on keyup, cleared on
  blur)** so browser auto-repeat of a held Shift+L advances exactly
  once per physical press instead of walking every level at the OS
  repeat rate. Alternatives rejected: no gating (hold-the-key level
  walk is a footgun, not a feature); a `shiftedUntil` time window
  (introduces wall-clock-ish state into a deterministic sim for no
  gain over the existing set precedent).
- **State gating is `gameState === "playing"` alone** — start, paused
  and game-over presses are inert (asserted per state by
  `tests/bricks-secret-skip.test.mjs`). The consumed-edge is added to
  the set even when ignored out of play, so a press started on the
  pause screen cannot fire later in the same physical press after
  resume; the next fresh press works. Score, lives, leaderboard and
  the multiplier window are untouched by design (the ticket: the
  multiplier keeps running).
- **No new boot-time DOM elements:** the keys live in `onKeyDown`/
  `onKeyUp`/`onBlur` on existing handlers, so no existing suite's
  element stub map gains an id (the house trap from the last wave is
  vacuous here — verified: the new suite's stub map is byte-for-byte
  the existing one).

## 2026-11-02 — Ticket #74: CLASSIC/EXCITING mode selector scaffold with drop-rate economy

- **One named `MODES` table is the seam follow-ups branch on — not a
  per-mode boolean flag.** Each mode is a row of named knobs
  (`{ dropFactor }` for now); `beginRun()` snapshots both
  `runMode = selectedMode` and the derived
  `dropRate = preset.dropRate * MODES[runMode].dropFactor`, so a
  mid-run click can never disturb a live run (the difficulty snapshot
  precedent). The exciting-capsules ticket will add its knobs as
  further fields on the `exciting` row; the alleyway ticket adds a
  row plus one more `modeButtons` entry, and the mark/select loops
  pick both up without changes. Alternatives rejected: a
  `selectedMode === "exciting"` branch in `maybeDropCapsule`
  (buries mode knowledge in the hot path and scales quadratically
  with modes); a `selected`-attribute CSS approach (the
  class-list precedent is what difficulty/theme already do).
- **`EXCITING_DROP_FACTOR` is a top-level mutable `var` (2.0), and
  `MODES.exciting.dropFactor` captures it at module load** — the
  `DIFFICULTY.normal` row precedent, keeping one source of truth;
  retunes behave exactly like the difficulty knobs, i.e. the table
  rows freeze the var at module load (a console retune of either the
  factor or the preset rates takes effect only after a page reload,
  not on the next run — the per-run snapshot then freezes the table
  value for the run).
  `EXCITING_DROP_FACTOR` sits beside `POWERUP_DROP_RATE` in the
  power-up tuning block since it scales that quantity.
- **Economy is a MULTIPLIER on the selected preset's rate, not a
  fixed exciting rate** — so Easy+Exciting (0.35 × 2.0 = 0.70) and
  Hard+Exciting (0.15 × 2.0 = 0.30) stay on their preset curves, and
  classic remains bit-identical to the pre-ticket roll
  (`× 1.0` is an exact identity in IEEE 754, asserted as a
  regression in `tests/bricks-modes.test.mjs`). Alternative rejected:
  a parallel `EXCITING_DROP_RATES` table (duplicates every future
  difficulty knob for one mode's one tweak).
- **Button ids follow the selector-family precedent
  (`difficulty-easy`, `theme-classic`) as `mode-classic` /
  `mode-exciting` with `data-mode` attributes**, rather than the
  ticket's suggested `#btn-mode-*` ids — the ticket allows either,
  and consistency with the two existing option rows beats the
  suggestion. The new `tests/bricks-modes.test.mjs` pins the
  `data-mode` static markup and drives behaviour through the
  data-attribute-free stub ids; the gate gained the same
  exactly-one-`selected`-on-`data-mode="classic"` check the
  difficulty row has.
- **NEW BOOT-TIME DOM ELEMENTS: `mode-classic` and `mode-exciting`
  were added to ALL twenty bricks suites' element stub maps**
  (verified by grep: one stub line per suite), not just the new
  suite — the house trap from the last wave, applied once,
  exhaustively.

## 2026-11-02 — Ticket #75: exciting-mode capsules — invulnerable, multiball x10, blast radius

- **The three new kinds live in a SEPARATE `CAPSULE_KINDS_EXCITE` table
  (`[0..7]`), appended after the untouched `CAPSULE_KINDS` (`[0..4]`);
  `beginRun()` snapshots the selected mode's table onto `runCapsuleKinds`,
  and `maybeDropCapsule()` rolls from that snapshot.** `CAPSULE_KINDS`
  itself is pinned to exactly five rows by
  `tests/bricks-capsules.test.mjs` (legacy exhaustive-table invariant),
  and the ticket mandates classic's table stays filtered to the original
  five. The MODES row carries the table reference (the ticket-74 seam
  comment anticipated exactly this knob). Alternatives rejected:
  filtering one shared eight-kind table by mode inside
  `maybeDropCapsule` (buries mode knowledge in the per-kill roll path and
  mutates a legacy-pinned constant); building the exciting list per run
  with `.concat()` (allocates on every beginRun for a constant value).
- **The ball pool is sized to `MAX_BALLS_EXCITE = 30` at boot; the
  classic `MAX_BALLS = 5` survives as the normal-play cap via the
  `runBallCap` run snapshot (classic → 5, exciting → 30), enforced by
  `spawnExtraBall()` and the multiball spawner.** One 30-slot pool
  serves both modes: the extra-ball catch is the only classic spawn
  path and stops at its cap, so classic runs never see more than five
  live balls. `tests/bricks-multiball.test.mjs`'s two pool-SIZE
  assertions were re-pointed from `MAX_BALLS` to `MAX_BALLS_EXCITE` —
  an explicit ticket mandate ("the pool is sized at boot for
  MAX_BALLS_EXCITE = 30"), not a behaviour change; that suite's
  MAX_BALLS-cap behaviour test is untouched and still green.
  Alternatives rejected: a second 30-slot pool activated in exciting
  (double memory, a second pool in every update/draw loop); lazily
  growing the pool on multiball (violates the no-allocation house
  rule and the "pool identity invariants" criterion).
- **INVULNERABLE reuses the shared `destroyBrick()` kill path for every
  pass-through brick — no reflection, no pinning — so scoring (tier
  points × the armed multiplier), the brick-break SFX, and the
  final-brick win all come for free; the ball keeps its exact vector.**
  The window is the `invulnUntil` sim-time stamp (the expand/sticky/mult
  `-1 = unarmed, expiry = now + full duration` convention), armed in
  `applyCapsule()` and expired by `updatePowerups()`. Fixed bricks never
  take the pass-through branch, so they stop the ball with a normal
  bounce mid-window. A level is captured at the top of `collideBricks()`
  and both window paths abort if it changed: a final-brick win calls
  `serveBall()` mid-scan, which drains every ball slot — continuing the
  scan would run against the freshly spawned level. Alternatives
  rejected: a per-ball `invuln` flag (state smeared across pool slots
  with no owner for the timer); an `updateBalls()`-side bypass of
  collision (would have to re-implement scoring/drops/win in a second
  place); suppressing drops by filtering the drop TABLE while invuln is
  live (wastes the `random` rolls and would also suppress
  blast-window drops, which must still drop).
- **Drop suppression during the window lives in ONE guard —
  `if (!invulnActive()) maybeDropCapsule(...)` inside `destroyBrick()`** —
  so pass-through kills (the window's own kill source) release nothing,
  while every non-invuln kill (including blast detonations, which this
  ticket defines as non-invuln) keeps dropping exactly as before.
  Cascade-free by construction: a brick destroyed by the pass-through
  is inactive, so it is scored exactly once and rolls at most one
  (suppressed) drop.
- **The invuln tint is a named-colour pass in `drawBalls()`: while
  `invulnActive()` every active ball gets one soft halo
  (`INVULN_GLOW_RADIUS_PX` / `INVULN_GLOW_ALPHA`) plus a `COLOR_BALL_INVLUN`
  core; after expiry the draw path is byte-for-byte the legacy one.**
  Theme palettes were NOT extended with per-theme invuln colours: the
  ticket asks for "a distinct tint/glow so the state is legible", not a
  skinnable colour, and three more palette rows × three themes is
  surface the PRD does not buy. Rejected: canvas `shadowBlur` glow
  (measurably expensive in the hot draw path for a status effect).
- **MULTIBALL fans from a SNAPSHOT roster: `spawnMultiball()` collects
  the in-flight parent indices into a boot-allocated scratch
  (`multiballParents`) and then fans each parent — iterating the live
  pool while spawning would make clones clone themselves (a single
  parent saturated the 30 cap on first run before the fix).** The fan
  is `(j − 4) × MULTIBALL_SPREAD_STEP` about the incoming vector
  (symmetric, speed-preserving, parent slot keeps its exact vector);
  clones take free pool slots in pool order and spawning stops at the
  per-spawn `liveBallCount() < runBallCap` check, so the ticket's
  "excess spawns skipped in deterministic order" is exactly the
  pool-order iteration order. Parked (attached) balls do not fan:
  their velocity is zero, and rotating a zero vector is a degenerate
  spawn — "every ACTIVE ball" is read as every in-flight ball.
  Alternatives rejected: fanning from the paddle centre instead of the
  parent position (loses "replaced by TEN" — the original must stay);
  an even-spaced full-circle fan (the ticket says "the same speed
  vector rotated by the spread", i.e. a fan about the incoming
  direction).
- **BLAST fires on every REFLECTED brick hit (breakable or fixed) while
  `blastActive()`, at the ball's centre at contact; `blastAround()` is a
  SINGLE radius-squared scan that destroys every breakable brick inside
  `BLAST_RADIUS_PX` via the shared kill path — one radius per hit
  event, structurally chain-free** (blast-destroyed bricks never pass
  through the collision resolver, so they cannot detonate). Fixed
  bricks are skipped by the scan but still reflect, so the ticket's
  "anchor a blast without breaking" is the fixed-brick hit case
  itself. The same level-captured-mid-scan guard as invuln applies.
  Alternatives rejected: recursive chaining (explicitly excluded by the
  ticket — one radius per hit event); a per-frame proximity field /
  precomputed brick-distance table (the blast is an event, not a
  steady state — one O(bricks) scan per hit costs nothing at 50 bricks);
  measuring from the brick centre instead of the impact point (the
  criterion is worded around "the impact point", i.e. where the ball
  struck).
- **The blast + invuln intersection: while the invuln window is live,
  blast detonations are SUPPRESSED** (`!invulnActive()` on the trigger
  line). During invuln the ball does not bounce off breakable bricks at
  all, so the mechanic's trigger ("each brick hit") does not occur;
  allowing a fixed-brick bounce mid-invuln to detonate would mix the
  two window mechanics in a state neither description covers.
  Documented here rather than silently chosen. Alternative rejected:
  letting the fixed-brick bounce anchor blasts during invuln (a
  surprise interaction the ticket's "rejected alternatives" note asked
  us to decide against).
- **Each new capture gets its OWN named recipe**
  (`SFX_CATCH_INVULNERABLE` sine 880, `SFX_CATCH_MULTIBALL` square 990,
  `SFX_CATCH_BLAST` noise 1200 — each distinct from
  `SFX_POWERUP_CATCH` square 660 and from its siblings), scheduled
  through the unchanged `scheduleSound()` bus, so the mute/volume
  plumbing (`MASTER_GAIN`, master bus) applies with zero new wiring.
  `applyCapsule()` picks the recipe before its effect dispatch.
  Alternatives rejected: one shared recipe mutated per kind in place
  (the `SFX_BRICK_CHIP` precedent exists for a continuously-varying
  pitch, not four discrete captures); a fanfare of multiple blips per
  capture (extra node churn for a status pickup).
- **No new boot-time DOM elements** — all three effects are
  canvas/render-state only (the mode buttons from ticket #74 already
  exist), so none of the sibling suites' element stub maps needed
  additions; the house trap was checked and does not apply.
## 2026-11-02 — Ticket #76: ALLEYWAY mode — portrait 480×800 arena with its own level patterns

- **`GAME_W`/`GAME_H` became the RUNTIME stage size, initialised from new
  named `CLASSIC_W`/`CLASSIC_H` (960/600) and `ALLEYWAY_W`/`ALLEYWAY_H`
  (480/800) vars; `BRICK_ROWS`/`BRICK_COLS` likewise from
  `CLASSIC_BRICK_ROWS/COLS` (5/10) and `ALLEYWAY_BRICK_ROWS/COLS` (10/5).
  `beginRun()` re-sets all four from `runMode` and re-runs
  `resizeCanvas()`, so the backing store, the CSS letterbox fit and the
  rect-mapped pointer math follow the mode with zero new branches in
  the hot path.** The ticket names the stage-size vars as the seam
  ("the stage-size vars switch per mode at run start and restore on
  returning to menu"); making the EXISTING `GAME_W`/`GAME_H`/
  `BRICK_ROWS`/`BRICK_COLS` the switched pair means every geometry
  reader (`resizeCanvas`, `fitStageCss`, `setPaddleX`, `bounceWalls`,
  `layoutBricks`, `spawnLevel`, the draw pass) already consumes the
  right value — no call site changes. Alternatives rejected:
  a `stageDims(mode)` accessor (scatters a mode branch into every
  geometry read, per-call allocation-free but per-site noisier);
  a parallel `ALLEYWAY_GAME_W` consulted ad hoc (two sources of truth
  for the same quantity).
- **Portrait patterns are a SEPARATE table
  (`ALLEYWAY_LEVEL_PATTERNS`, two patterns: "spine" and "slalom"),
  not the landscape table transposed.** Transposing the 5×10
  landscape strings onto the 10×5 portrait grid preserves the WIDE-WALL
  proportions — a transposed "tiered wall" is ten stacked rows that
  reads as a stretched landscape board, which the ticket calls out
  explicitly. The portrait table is designed for the tall field:
  vertical corridors, offset fixed slabs. Every pattern reuses the
  tier system (A/B/C + fixed X) and is provably clearable — the suite
  flood-fills each pattern from the bottom row (X impassable) and
  asserts every breakable cell is reachable, so a future edit cannot
  ship an uncleareable level. Alternatives rejected: transposed
  landscape table (proportions); a third shared generator function
  (more moving parts for two fixed patterns — a table row is the
  house convention, cf. `LEVEL_PATTERNS`).
- **The portrait 5×10 grid reuses the single 50-cell brick pool**
  (10×5 = 5×10, same product as the landscape 5×10), so the pool
  allocation, the precomputed `CRACK_POINTS` table and the
  `MAX_BRICK_RESCANS_PER_SUBSTEP` cap all stay untouched; `spawnLevel`
  and `layoutBricks` just re-index with the runtime `BRICK_COLS`.
  Alternative rejected: a second pool for the portrait grid (double
  the memory for identical capacity, and every collision/draw/clear
  loop would need a mode branch to pick it).
- **The alleyway mode row carries only `dropFactor: 1.0`** — its
  geometry lives in the named `ALLEYWAY_*` vars, not on the row, so
  the `MODES` table stays the pure drop-economy snapshot (the
  ticket's "classic rules, classic drop rate") and future modes that
  need knobs get a row field, not a bag of heterogeneous types.
  Alt. rejected: `{ w, h, rows, cols, dropFactor }` on the row (mixes
  structural geometry into the economy table and forces the
  classic/exciting rows to duplicate 960/600/5/10).
- **`beginRun()` clamps the paddle AFTER the resize** — a landscape
  run can park the paddle at x≈900 (stage px), which is outside the
  portrait field; clamping pre-resize would clamp against the stale
  width. Combined with the existing `clampPaddle` in the pointer/
  keyboard paths this closes the "paddle clamped to the narrower
  width" criterion.
- **NEW BOOT-TIME DOM ELEMENT: `mode-alleyway` was added to ALL
  twenty-one bricks suites' element stub maps** (verified by grep:
  one stub line per suite), not just the new `tests/bricks-
  alleyway.test.mjs` — the house trap from the last wave, applied
  once, exhaustively. `tests/bricks-modes.test.mjs`'s static
  assertions were widened from "two data-mode nodes" to three
  (classic|exciting|alleyway) as the scaffold absorbed the button.

## 2026-11-02 — Ticket #91: pointer outside the stage rect holds the paddle; per-event displacement cap (supersedes the #40 edge-clamp) — SUPERSEDED by #95 (the step cap and the out-of-rect hold are both removed; instant rect-mapped tracking with wall-hug restored)

- **SUPERSESSION: the pointer edge-clamp dating from tickets #21/#40
  (any pointer position outside the field mapped to the nearest
  wall via `clampPaddle()`) is superseded.** `setPaddleX` now
  ignores events whose position falls outside the stage's fitted
  bounding rect (read via `getBoundingClientRect()` on every
  event): the paddle HOLDS its last position instead of pinning to
  an edge. Holding is gentler because an escaped cursor is a
  transient accident, not a command — pinning converted "cursor
  wandered into the letterbox" into "paddle welded to the wall",
  while holding converts it into "nothing happens". No paddle range
  is lost: the stage rect IS the field, and the containment test is
  inclusive on all four edges, so a cursor sitting exactly on the
  rect rim still maps wall-to-wall.
- **What actually misbehaved (repro, deterministic in the vm
  suites):** (1) a cursor parked in the left letterbox bar pinned
  the paddle to `paddleW / 2` on every mousemove — a ball served or
  bounced in that window kept slamming the left wall, the operator's
  "the mouse keeps escaping and the game misbehaves"; (2) on cursor
  return, ONE event teleported the paddle the full distance (e.g.
  760 px in one event at boot stage size) — an attached ball rode
  the teleport and launched from a suddenly different offset (the
  bounce angle is offset-proportional), and any free ball aimed at
  the previous paddle centre missed outright; (3) investigated
  event ordering and stale rects after window resize: no hazard —
  the rect is read per event (never cached), so a resize can only
  leave it at most one frame stale while the deferred CSS re-fit
  (`resizePending`) runs, and that self-corrects; the pre-existing
  degenerate-rect (width 0) guard is retained and still exercised.
  The fix addresses (1) with the hold rule and (2) with the cap;
  (3) needs no code change.
- **`POINTER_MAX_STEP = 18` px/event** — a top-level mutable
  `var`, console-retunable, = 1.5× the keyboard paddle's per-frame
  travel (`PADDLE_SPEED` 720 px/s ÷ 60 fps = 12 px). At ≥60
  events/s that is ≥1080 px/s, faster than keyboard steering, so
  normal following feels immediate; the worst case (cursor returns
  from the far letterbox bar) still takes ≥107 events (~1.8 s at
  60 Hz) to traverse the 1920-px field — accepted as the price of
  never teleporting the paddle out from under a riding ball. The
  cap applies INSIDE the rect too, per event, stateless and
  deterministic (each event walks at most the cap toward the
  cursor; sustained events converge exactly on it — asserted).
  Alternatives rejected: a velocity-style px/s cap (needs
  timestamp arithmetic in the handler and wall-clock input —
  fights the sleep-free deterministic vm harness); per-frame
  easing/interpolation toward the cursor (per-frame state and hot-
  path work for a benefit the event cap already gives); X-only
  containment (a cursor in the TOP/BOTTOM letterbox bars would
  still steer, but the complaint is about the cursor leaving the
  game area, any bar).

## 2026-11-02 — Ticket #95: pointer steering returns to instant 1:1 rect-mapped + clamped tracking (supersedes the #91 step cap and out-of-rect hold)

- **Decision: `setPaddleX` maps the pointer's clientX through the
  stage's fitted bounding rect, clamps the result to the paddle's
  reachable range `[paddleW/2, canvas.width − paddleW/2]` (via the
  existing `clampPaddle()`) and ASSIGNS it directly. `POINTER_MAX_STEP`
  and the #91 four-edge containment hold are DELETED.** Both #91
  protections broke play in the field: (a) the 18 px/event cap made
  the paddle crawl and permanently lag a moving cursor; (b) the
  outside-rect hold froze the paddle the instant the cursor left the
  fitted stage (letterbox strip, HUD, just off-window) — "impossible
  to play with mouse now, whether full screen or not". With a
  rect-relative mapping plus a clamp, the #40-era "teleport"
  complaint is moot: a large cursor jump lands the paddle exactly
  where it aims, which is what aiming is for. Off-rect events are
  no longer ignored either: a cursor left/right of the stage HUGS
  the matching wall (a continuous, controllable command, not a
  freeze), and a cursor above/below (the vertical letterbox bars —
  the exact case #91 argued for ignoring) now steers by its
  horizontal position, which the old code's four-edge test treated
  as "outside" too. Surviving guards: the degenerate-rect (zero-
  width) ignore, and the missing/NaN clientX reject via negated
  comparison. Mouse and touch share the single path. No new DOM
  ids, no new tuning knobs, hot path is primitives only (one rect
  read, one division, one clamp — the same shape #91 had).
- **Alternatives rejected:** a LARGER per-event cap (a velocity
  cap can never track a moving cursor 1:1 — it only makes the
  crawl faster); keeping the hold but widening the containment to
  the viewport (still freezes whenever the cursor crosses into a
  HUD strip or leaves the window, and couples steering to page
  layout); per-frame interpolation toward the cursor (adds run
  state and per-frame hot-path work, and #91 already rejected it
  on the same grounds — at 60 fps, events and frames alternate,
  so direct assignment IS the interpolator).
## 2026-11-02 — Ticket #90: ball-speed slider 5% snap, 100% notch, live readout, double-click reset

- **Off-grid snap is NEAREST-stop (round), after clamp — not floor/truncation.**
  An off-grid programmatic input (e.g. 123) lands on 125, not 120: dragging near
  a stop feels like a magnet rather than always one cell behind. Clamping first
  keeps both bounds exact (10→50, 999→150). The snap is JS-side
  (`snapBallSpeedPct`) because the vm stubs don't emulate the browser's native
  `step` enforcement, so the grid guarantee is assertable via input events in
  the deterministic suite; the native `step="5"` attribute stays as the
  declarative source of the grid for real browsers. Alternatives rejected:
  floor-snap (asymmetric, always ≤1 cell low — feels sluggish); drop the JS
  snap and rely on native step alone (unassertable in the harness, and
  programmatic `el.value` writes bypass native snapping in some engines).
  Known cosmetic consequence: a hand-stored off-grid 123 boots with the
  readout showing "123%" while a real browser's native step
  sanitisation renders the thumb at the 125 stop until the user's first
  move — the ticket's "don't rewrite a stored out-of-grid value unless
  the user moves the slider" requirement makes the two views diverge
  briefly; not a bug, do not "fix" by rewriting the stored value at boot.
- **The live readout is a bare `<span id="ball-speed-value">` INSIDE the
  existing row `<label>`**, inheriting the shared `.vol` row-label treatment
  (size, letterspacing, uppercase, `--ink`) — zero new type rules; the flex
  gap already spaces it from the "Ball Speed" text. Alternatives rejected:
  a `<output>` sibling of the label (extra flex item, no semantic gain for a
  value that is never the result of a form submission); giving the readout its
  own font rule (duplicates `.vol`, drift-prone).
- **The single `dblclick` reset handler lives on the row label
  (`#ball-speed-label`), which wraps the readout** — in a real browser a
  double-click anywhere on the "BALL SPEED 125%" text (readout or label)
  bubbles to the one handler, satisfying "the readout (or the row label)"
  without duplicated listeners. The vm stubs don't model the tree, so the
  test driver models that one containment hop explicitly
  (`DBLCLICK_PARENTS`). Alternatives rejected: a second listener on the
  readout span (double firing in a real browser — second pass is a no-op but
  dead complexity); making the readout a `<button>` (wrong widget for a
  passive value; focus ring + button styling fight the row-label treatment).
- **The 100% notch is `.speed .slider::after` — a pseudo-element tick on a
  tight `.slider` wrapper around the input, anchored `left: 50%`** (100 is
  exactly the mid of the 50..150 range), `background: var(--accent)` at
  0.75 opacity, `pointer-events: none`. Pseudo-element over a span element:
  no extra node, and crucially no new boot-time DOM id to replicate into all
  23 bricks suites' stub maps (the house trap). The wrapper exists only so
  the tick can be positioned against the TRACK's extent (the input itself
  can't reliably host positioned children across engines); it is
  `display: inline-flex` so it hugs the 120px input and 50% of the wrapper
  is 50% of the track. Alternatives rejected: a separate `<span class=
  "notch">` element (extra node/id churn for zero benefit); drawing the tick
  on the canvas (the start screen is DOM, not canvas); per-theme CSS
  overrides (the `--accent` variable already re-points per theme via
  `applyTheme`, so one rule is theme-aware by construction).
- **Reset is a state+persist operation, not an `input` dispatch.**
  `resetBallSpeed()` assigns `ballSpeedPct = 100`, writes storage once, and
  calls `syncBallSpeedControl()` (thumb + readout). Dispatching a synthetic
  `input` would also work but couples the reset path to the parse-and-snap
  path; the direct assignment is the simpler single-write path and keeps the
  no-op invariant obvious (already 100 → early return, zero writes).
  Alternatives rejected: synthetic `dispatchEvent(new Event("input"))`
  (hidden coupling, harder to audit the write count); a dedicated
  "reset" button (the ticket defines the gesture as double-click — a
  second affordance duplicates the same state change).
- **NEW BOOT-TIME DOM ELEMENTS: `#ball-speed-value` and
  `#ball-speed-label` were added to ALL twenty-three bricks suites'
  element stub maps** (verified by grep: one stub line per id per suite),
  not just `tests/bricks-ballspeed.test.mjs` — the house trap from the last
  wave, applied once, exhaustively.

## 2026-11-02 — Ticket #89: speed slider scales capsule fall speed and keyboard paddle speed too

- **Two new per-run snapshots: `runCapsuleFallSpeed` and
  `runPaddleKeySpeed`, named `var`s initialised to the base values
  (`CAPSULE_FALL_SPEED` / `PADDLE_SPEED`) before the first run and
  reassigned in `beginRun()` as `base * speedFactor`, exactly beside
  `serveSpeed` / `serveCeiling` / `runServeBase`.** The base named vars
  stay top-level, console-retunable, and are multiplied — never
  replaced — so at 100% the hot path consumes a bitwise-identical
  value (`x * 1 === x`), making the 100% regression byte-identical by
  construction rather than by approximation. Alternatives rejected:
  passing the factor through the update functions (`updatePowerups`
  would read `ballSpeedPct` live, violating the snapshot semantics the
  ticket pins, and a per-frame division would creep into the hot
  path); storing the factor and multiplying at each use site (same
  per-frame multiply, weaker audit trail than a named snapshot beside
  the serve's).
- **`POINTER_MAX_STEP` is deliberately NOT rescaled even though its
  comment derives it from `PADDLE_SPEED/60`.** The ticket states the
  pointer paddle is position-following with no speed term and must not
  gain one; the cap is a per-event teleport guard, not a tempo knob,
  so it keeps deriving from the BASE keyspeed. Alternatives rejected:
  snapshotting a scaled cap (would couple a safety limit to player
  tempo and change #91's guaranteed behaviour); a mid-run dynamic cap
  (inert-by-snapshot is the established tempo rule).

## 2026-11-02 — Ticket #96: wall-bounce cue recipe — restrained peak, distinct timbre
- **The "quieter gain" comes from a NEW OPTIONAL per-recipe `peak`
  field, not a new bus or per-call gain arithmetic.** `scheduleSound()`
  peaks the envelope at `recipe.peak` when the recipe carries one, else
  `SFX_PEAK` (unchanged), so `SFX_WALL_BOUNCE = { wave: WAVE_SQUARE,
  freq: 170, dur: 0.05, peak: SFX_WALL_BOUNCE_PEAK }` with
  `SFX_WALL_BOUNCE_PEAK = 0.25` (half the standard 0.5 at boot) sits at
  the existing SFX_PEAK/decay-floor/SFX_EXP_EPS machinery. Retuning: the
  recipe's `.peak` is read LIVE at schedule time, so console retunes go
  through `SFX_WALL_BOUNCE.peak`; `SFX_WALL_BOUNCE_PEAK` is the
  initialisation source only (the recipe captures its value at
  declaration, like `freq`), and the clamp still protects against a
  zeroed value. Alternatives rejected:
  a second, quieter master bus (adds wiring, complicates the
  single-bus mute invariant the audio suite pins); a separate
  lower-envelope helper (duplicates the scheduler, violates the
  "reuse the scheduler" instruction).
- **Timbre: low SQUARE blip at 170 Hz, 0.05 s — chosen to stay
  distinct from BOTH neighbours without a new waveform constant.**
  The chips are 440/550/660 Hz sine, the pop is 900 Hz lowpassed
  noise, the paddle bounce is 220 Hz sine; 170 Hz square is below
  every chip pitch and the pop, and square harmonics separate it
  from the sine family even at a similar loudness. Alternatives
  rejected: a new WAVE_TRIANGLE constant (the audio suite pins the
  three named waveform constants and every recipe to them — a new
  wave would rip through that matrix for no functional gain);
  sine (indistinguishable from the paddle/chip family at a glance
  and by spectral content).
- **Trigger placement: each crossing arm of `bounceWalls()`, i.e.
  one blip per physical reflection.** A corner hit (two crossings in
  one sub-step pass) therefore plays two blips — two reflections are
  two audible events. No dedupe/throttle was added: the pinning
  removes the ball from the crossing half-space, so a resting ball
  can never re-trigger (verified by the "parked ball stays silent"
  test), and the cue's own short duration/quiet peak is what keeps
  rapid rattle from cluttering. Alternatives rejected: a per-frame
  "already rattled" flag (hidden state in the hot path, changes
  corner semantics); throttling by sim time (allocation-free but
  arbitrary and unpinnable in deterministic tests).
## 2026-11-02 — Ticket #97: randomise the serve launch direction

- **Jitter is additive on the launch angle, not a fixed minimum
  angle.** A floor (e.g. "at least 5° off vertical") would make every
  centre serve deterministically biased to one side once the sign rule
  is known, so a skilled player could pre-compensate with a fixed
  paddle nudge and re-create the straight column; a symmetric uniform
  jitter in `[-LAUNCH_JITTER_ANGLE, +LAUNCH_JITTER_ANGLE]` drawn
  through the existing mutable `random` hook has zero mean, zero
  pattern to learn, and stays bit-reproducible under test pins.
  Alternatives rejected: a fixed minimum angle (learnable bias, above);
  choosing a random paddle contact point instead (changes perceived
  ball position at serve — worse than moving the invisible angle);
  per-difficulty jitter (the exploit exists on every preset; the knob
  is globally retunable if tuning ever wants per-preset values).
- **`LAUNCH_JITTER_ANGLE = 0.12` rad (~6.9°).** Midpoint of the
  ticket's 0.10–0.14 rad suggestion: large enough to visibly break
  the column rhythm, small enough that a well-timed player still reads
  the launch as "their" serve. Declared as a top-level `var` beside
  `MAX_PADDLE_BOUNCE_ANGLE` (console-retunable, matching the house
  knob style).
- **The upward guarantee is analytic, not clamped:**
  `|rel * MAX_PADDLE_BOUNCE_ANGLE + jitter| <= PI/3 + 0.12 < PI/2`
  for all `rel in [-1,1]`, so `cos(ang) > 0` and `vy < 0` always.
  Clamping `ang` would silently distort the angle law at the rims and
  is dead weight while the bound holds; the bound itself is asserted
  in `tests/bricks-serve-jitter.test.mjs`.
- **Extra-ball catches (`spawnExtraBall`) keep their straight-up
  spawn.** The ticket scopes the fix to serve launches
  (`launchAttachedBalls`); a catch-spawned ball is already in live
  play at full speed and the paddle can intercept a vertical one —
  it is not the parked-serve exploit.
- **Pre-existing exact angle-law tests pin the jitter to its
  zero-crossing (`random() = 0.5`) rather than widening their
  tolerance.** They exist to pin the position-angle law itself;
  drawing 0.5 makes the jitter term exactly 0 with zero
  approximation error, and the jitter behaviour gets its own dedicated
  suite (`tests/bricks-serve-jitter.test.mjs`). Widening the epsilon
  would have turned exact-law assertions into fuzzy ones.

## 2026-11-02 — Ticket #98: widen the brick field side inset (angle reach)

- **`BRICK_SIDE_MARGIN` raised from 24 to 40 canvas px (single value,
  both modes).** The angle-reach rationale: at 24 px the outermost
  bricks sit so close to the side walls that the shallow angles the
  paddle can impart barely let the ball slide along and reach
  off-centre bricks. 40 px is "slightly bigger, not a huge reflow":
  in classic the column width drops 181.8 → 178.6 px (~1.8%), in
  alleyway 177.6 → 171.2 px (~3.6%) — a modest, uniform shrink that
  `layoutBricks()` performs automatically because the column width
  derives from `canvas.width` minus the doubled margin. The field
  stays perfectly symmetric (left gap == right gap == 40) and
  centred; the top margin stays at `BRICK_TOP_MARGIN = 64` (the
  ticket's optional top nudge is deliberately not taken — the side
  gap was the problem, and fewer changed constants means fewer
  things to verify).
- **One shared inset for both modes, not per-mode vars.** With 5
  columns the portrait arena already has proportionally *more*
  margin than the landscape one (40/960 vs 40/1920 canvas px), and
  the 5 wide columns (171.2 px) are still ~4× the inset, so nothing
  crowds. Alternatives rejected: separate
  `CLASSIC_BRICK_SIDE_MARGIN`/`ALLEYWAY_BRICK_SIDE_MARGIN` vars
  (extra surface for no demonstrated need), 24 → 32 (visible but a
  weak relief for the reach problem), 24 → 48+ (drifts toward the
  "huge reflow" the ticket warns against). 40 stays a plain
  top-level `var`, so it remains console-retunable per the house
  knob style.
- **The test pins the widened value against the real layout, not
  against re-derived copies of the same expression.** Left gap is
  compared exactly (it *is* the named margin); the right gap is the
  derived edge (margin + 9 column steps), so it gets a 1e-9 px
  sub-nanopixel float tolerance — the ~2e-13 residual is binary
  float addition, not a layout defect. `tests/bricks-side-inset.test.mjs`
  covers the widened value, symmetry, the modest-bounds check and
  the unchanged 10/5 column counts in both modes; the pre-existing
  suites (bricks-grid, bricks-alleyway, bricks-level-layouts) derive
  positions from the named vars, so they track the new inset with
  no edits.
## 2026-11-02 — Ticket #100: double the timed powerup durations

- **Doubling the five named durations is the fix, not a base-speed
  change.** The complaint is "the effect is gone before the ball
  finishes its round trip" — that is a window-length problem, so the
  window is doubled in place: `PADDLE_EXPAND_DURATION_S` 6→12,
  `STICKY_DURATION_S` 6→12, `MULT_DURATION_S` 6→12,
  `INVULNERABLE_DURATION_S` 6→12, `BLAST_DURATION_S` 5→10. The
  operator floated "maybe the base game speed is too slow also?" —
  that is a QUESTION, and acting on it would silently retime the whole
  game (serve, ball growth, collisions) on every preset and difficulty
  row, for a complaint the duration doubling already resolves. The
  BALL SPEED slider (50–150%, tickets #73/#89/#90) already exposes
  tempo to the player and scales the whole speed curve, so it stays
  the escape hatch if the base tempo is ever judged wrong.
  Alternatives rejected: lowering `BALL_SERVE_SPEED` / the level speed
  curve (global retime, out of scope); scaling durations by the
  ball-speed percent (couples two already-linked systems, and at 50%
  the player deliberately chose slower balls AND shorter windows).
- **The values stay top-level `var` knobs (console-retunable, house
  style)** — only the initialisers moved. Expiry bookkeeping
  (`*Until = simTime + DURATION`, cleared in `updatePowerups()`) is
  untouched, so every existing dynamic test stays valid and the new
  suite `tests/bricks-powerup-durations.test.mjs` pins the exact
  doubled values plus the holds-at-T+D/2 / gone-at-T+D semantics per
  kind.
- **Extra/Life remain instant** (no duration var exists or is added),
  per the ticket.

## 2026-11-02 — Ticket #99: start-screen legend of all capsule powerups

- **A start-screen legend, not a help overlay.** The operator asked for "all the
  powerups" visible where the player chooses a run; the start screen already
  hosts the controls and leaderboard, so the legend joins it there rather than
  inventing a new overlay state (a toggleable help panel adds a screen state,
  a pause/transition path, and key handling — machinery the game does not
  otherwise have, for one static table). Alternatives rejected: in-game HUD
  icon (invisible until a capsule is caught late in a run); help overlay
  (extra state machine + keyboard surface); per-mode filtering (explicitly
  not wanted — "all the powerups").
- **One data table, dynamic rows.** `CAPSULE_LEGEND = [{kind, label, blurb,
  color}, …]` in kind order 0..7, defined next to `CAPSULE_DRAW_COLORS`;
  `buildCapsuleLegend()` renders one row per entry at boot into
  `#capsule-legend` (static markup holds only the empty container + heading,
  so the harness diamond needs just the container id). Swatch colours index
  the same colour constants the capsules draw with, so the legend cannot
  drift from in-game play. The table is the single source of truth for
  label + blurb + colour, so a ninth kind is one table row.
- **Chosen values.** Two-column grid (eight rows on four compact lines),
  14×8 px swatches matching the life-icon radius, 0.75 rem monospace
  letter-spaced rows on the existing `--ink`/muted palette — theme-consistent
  without a new colour token. Blurbs, kept tight: Expand "widens the
  paddle", Extra "spawns a spare ball", Sticky "paddle catches the ball",
  Life "restores a life", Multiplier "doubles the score", Invulnerable "ball
  smashes through bricks", Multiball "each ball fans out to ten", Blast
  "brick hits detonate a radius". "Extra" is named Extra (not "Life drop")
  because `applyCapsule(KIND_EXTRA)` spawns a spare ball, not a life —
  `KIND_LIFE` is the life.
- **Placement.** Inside `#screen-start`, below the leaderboard block and
  above the Reset High Score / Start buttons, per the ticket.
## 2026-11-02 — Ticket #101: drop the 1:1 cap — the stage fits (and grows) the viewport

- **`fitStageCss()` now uses `fit = min(innerWidth / GAME_W, innerHeight / GAME_H)`
  with the old `, 1` cap removed.** On large viewports the stage up-scales
  (fit > 1) so the game grows with the screen, as the operator asked; on small
  viewports it still down-scales, and the native-size viewport remains exactly
  the fit == 1 boundary. Aspect-fit + letterbox centring is unchanged — fit is
  still the MIN of the two axes, so nothing stretches, and the pointer mapping
  (`setPaddleX` via `getBoundingClientRect`) is unaffected because it divides by
  the rendered rect, not the CSS cap (verified by
  `tests/bricks-stage-fit.test.mjs`, incl. the upscaled-rect cases).
- **Why upscaling is acceptable here: the retro aesthetic is deliberately
  chunky, and the bitmap is already 2×-supersampled** (`CANVAS_SCALE = 2`,
  so the backing store is 1920×1200 for the classic stage). Bilinear up to a
  2.4× fit lands at effective ~1.2 device px per logical px on typical
  displays — soft-edged but legible, in keeping with the vector-shape art;
  the operator traded that softness for a stage that fills the monitor.
  Crispness note: no `image-rendering: pixelated` is added — pixel-snapping a
  vector-art, anti-aliased raster would only make ball motion judderier at
  non-integer fits, and the soft look fits the aesthetic better.
  Alternatives rejected: DPR-aware backing-store re-rasterisation (changes the
  logical resolution and every geometry constant — rejected, the ticket keeps
  the backing store at GAME_W × CANVAS_SCALE); optional pixelated CSS toggle
  (extra DOM/UI the ticket forbids).
- **Supersedes** the scale ≤ 1 bullet in the ticket #2-era responsive-scaling
  entry (marked SUPERSEDED in place). The suite
  `tests/bricks-stage-fit.test.mjs` drives `window.innerWidth/innerHeight`
  deterministically in the vm harness and sweeps 12 viewport sizes to pin the
  ratio, the min-of-axes letterbox, the native boundary and the backing-store
  invariance.

## 2026-11-02 — Ticket #102: right-mouse hold fast-forward (1.5x / 2.0x / 3.0x)

- **One timeScale on the simulation dt, not scaled velocities per system.**
  `frame()` computes `simDt = dt * (rmbHeld && fastFwdMult > 0 ? fastFwdMult : 1)`
  and passes `simDt` into `update()`, so every gameplay system (ball
  integration and its sub-stepping, capsules, powerup timers, simTime
  stamps for expand/sticky/multiplier, score) accelerates consistently:
  a 12 s-of-game-time powerup elapses in 12/mult seconds of real time.
  Alternatives rejected: scaling each velocity/timer individually — the
  expiry stamps are sim-time comparisons, so per-system scaling would
  desynchronise them (a "timed" powerup would outlive or undercut the
  warped ball physics), and it would need a scale passed through every
  update path with a chance to leak one; the ball's tunnel-prevention
  (sub-steps by `travel = speed * dt`) would silently stop protecting
  unless remembered per call site.
- **Clamp BEFORE scale.** The real frame dt is clamped to
  MAX_FRAME_SECONDS and only then multiplied, so a stalled tab under a
  held warp costs at most MAX_FRAME_SECONDS × mult of sim time — never
  a 5-second stall teleported ×3. Verified in
  `tests/bricks-fastfwd.test.mjs` ("stalled frame" check).
- **Render stays on real frames.** Only sim time scales; `draw()` still
  runs once per raf callback, so the warp can never desynchronise or
  multiply renders (the "full-stage clear once per driven frame" check
  pins this at 1x and 3x).
- **Context menu is suppressed over the canvas at ALL states**, not just
  during play (ticket left the scope to implementer judgement). Reason:
  the right button is stage vocabulary wherever the stage is visible;
  the overlay screens (start/pause/gameover) sit ABOVE the canvas, so
  their own context menus are untouched — the suppression only bites on
  the visible stage. A play-only gate would add a state branch to a
  handler whose whole job is "this surface has no menu".
- **The multiplier is a LIVE knob, not a per-run snapshot.** Unlike
  mode/difficulty (which `beginRun()` snapshots), `fastFwdMult` is read
  by the frame loop every frame: a click on the start screen arms or
  disarms the warp on the next frame, and the OFF row zeroes it even if
  the button is already held. Simplest semantics that fits "hold
  right-mouse to expedite" — the hold and the setting compose
  multiplicatively with no snapshot to drift.
- **Option buttons are STATIC markup with ids** (`fastfwd-off`,
  `fastfwd-1-5`, `fastfwd-2-0`, `fastfwd-3-0`), mirroring the
  difficulty/theme/mode rows exactly (`data-fastfwd` + `.fastfwd-opt
  selected`), rather than being boot-generated like the capsule legend.
  Cost: four new stub ids in every bricks-*.test.mjs stub map (the
  standing harness diamond); benefit: uniformity with the other three
  selector rows and zero new element APIs in the stubs (no
  setAttribute/dataset needed).
- Persistence: own key `brickbreaker.fastfwd`, JSON-string-encoded,
  default `"2.0"`, corrupt/unknown → default — same read/write style as
  `brickbreaker.mode` et al. `FAST_FWD_KEY`, `FAST_FWD_OPTIONS`,
  `DEFAULT_FAST_FWD`, `fastFwdMult`, `rmbHeld` are all console-
  retunable top-level vars per house style.

## 2026-11-02 — Ticket #111: start screen overflows short viewports

- **Compaction, not reflow.** The ticket prefers tightening the vertical
  rhythm over restructuring the panel, and the arithmetic agrees: the
  legend alone could only yield ~10 px, so the section gap carried most
  of the load. Chosen spacings (CSS only, no DOM changes, type scale and
  the 2-column legend untouched): `.screen` gap 1.25rem → 0.75rem
  (−96 px across 12 sections), option-button vertical padding
  0.5em → 0.45em on all six selector rows incl. Reset High Score
  (−7.7 px), legend row gap 0.25rem → 0.15rem (−4.8 px), legend
  line-height pinned to 1.15 (−0.8 px). Result, measured in a real
  1280×577 window: content 563.8 px, btn-start bottom y=570.4 (was
  625.1) — 6.6 px of clearance, zero font-size changes.
  Alternatives: reordering/removing rows (rejected — reflow), smaller
  title/tagline (rejected — the ticket bans shrinking the type scale),
  gap 1rem alone (insufficient: content would land at 625 px, still
  past the fold).
- **Legend line-height pinned to 1.15, not the ticket's suggested ~1.25.**
  Calibration against the repro window showed the rows already render at
  ~14 px on "normal" line-height (≈1.17× the 12 px font); 1.25 would have
  made them 15 px — *taller*. 1.15 (13.8 px) is both a tiny additional
  saving and deterministic across browsers, whose "normal" metric varies.
- **Deliberate side effect: the `.screen` gap change (1.25rem → 0.75rem)
  tightens the pause and game-over overlays too, not just the start
  panel.** Those screens share the `.screen` class and now sit a bit more
  compactly — intended (the ticket allows trimming generic section
  spacing) and visually benign (fewer rows, no clipping; both remain
  centred). Recorded here so it is not mistaken for drift later.
- **Safety net is `overflow-y: auto` + `justify-content: safe center` on
  #screen-start.** Plain `overflow-y: auto` alone still suffers the
  flexbox centring trap: on overflow, centered content clips at the top
  and the scroll range starts *below* it. `safe center` degrades to
  start-alignment only when the panel genuinely overflows (an
  extremely-short-window case the compaction makes unobservable in
  practice), keeping the CTA scrollable into view from the top; verified
  at a 400 px viewport (btn-start fully visible after scrolling).
  Unsupported browsers fall back to `center` — today's behaviour.
- **The fold test measures a deterministic layout model fed by the real
  CSS, calibrated on Chrome.** The vm harness cannot rasterize, so
  `bricks-start-fold.test.mjs` parses the actual `<style>` block and
  derives every block height from real declarations (font-size, padding,
  borders, gaps, grid geometry); "normal" line-height resolves with
  Chrome's monospace metric 1.15625 (calibration: 64 px title rendered
  74 px; model 671.6 px vs measured 673.1 px pre-fix — 1.5 px apart).
  Unknown top-level blocks fail the suite loudly rather than passing
  silently. The 14 px model margin over the 577 px limit absorbs residual
  font-metric drift.

## 2026-11-02 — Ticket #113: native full screen mode (button + F key)

- **Toggle target is `document.body`, not a wrapper element.** Requesting
  body fullscreens the canvas, HUD and overlay screens together with no new
  wrapper DOM, and the CSS layout is untouched — body is already the
  single-screen root. Alternatives: wrapping everything in a new `#app`
  div (extra DOM layer, would have to absorb the `position: fixed`
  centering and the repo's `#game` cursor gate) and fullscreening only
  the canvas (HUD/overlays stay letterboxed — defeats the ticket's
  rationale that no-letterbox removes the pointer-tracking issues at the
  source).
- **`document.fullscreenElement` is the single source of truth; the
  button is a pure mirror.** The `fullscreenchange` listener re-syncs the
  label ("Full Screen" ↔ "Exit Full Screen") and the `.active` class on
  every change, so the native Esc exit is a no-op state-wise: we do NOT
  bind Escape ourselves (binding it would collide with the existing
  pause/resume Escape key and duplicate the browser's own exit).
- **The Fullscreen API promise is swallowed with `.catch(() => {})`.**
  Permission denial or a transient failure must never throw into a user
  gesture (the toggle is invoked from a click / keydown handler). On a
  denial nothing else happens — no state moved, so the mirrored label is
  already correct; no internal "we are fullscreen" flag exists to drift.
- **KeyF ignores browser auto-repeat (`e.repeat`).** Without the guard a
  HELD F would flap the toggle every ~500 ms of key repeat. The press
  edge alone counts — simpler than a held-set (no blur cleanup path
  needed). No `preventDefault`: the page cannot scroll (overflow: hidden)
  and suppressing it would only break focused-CTA semantics for nothing.
- **Start-screen compaction to make room for the new row.** The fold lock
  (ticket #111, 577 px) had ~15 px of headroom; the new ~40 px row
  outgrew it. Chosen: tighten ONLY `#screen-start`'s flex gap
  0.75rem → 0.55rem (the pause/game-over overlays keep the shared
  `.screen` 0.75rem). Model result: 14 blocks, content ~560.6 px —
  ~16.4 px of clearance, zero font-size changes (the locked type scale
  in bricks-start-fold.test.mjs is untouched). Alternatives: shrinking
  option-button padding again (second bite out of #111's compaction
  budget; the row would also feel cramped) and a 0.6rem gap (only ~6 px
  clearance — too thin next to the calibration-margin policy).
## 2026-11-02 — Ticket #114: native full screen mode (F key, start-screen hint)

- **Parity with the bricks fullscreen ticket (#113): the Fullscreen API
  targets `document.body`, and `document.fullscreenElement` is the single
  source of truth.** Asteroids already draws a full-window canvas (no
  letterbox, no overlay DOM beyond the canvas), so making the body full
  screen just scales the whole stage up — no wrapper element is needed.
  Alternatives: targeting the canvas element itself (rejected — the same
  visual result, but `resize()` reads `window.innerWidth/Height` and the
  body target matches the bricks precedent, keeping both games
  comparable).
- **`toggleFullscreen()` guards for the `document.requestFullscreen`
  function (silent no-op when absent) and attaches `.catch(() => {})`
  to the returned promise.** Unsupported browsers get a silent no-op (the game still
  boots and starts), and a permission denial — which the API reports
  ASYNCHRONOUSLY as a rejected promise — can never surface as an
  unhandled rejection out of the keydown gesture. Alternative:
  try/catch (rejected — it cannot catch the async denial path).
- **The `fullscreenchange` listener calls the existing `resize()`
  explicitly.** Entering/leaving full screen does NOT guarantee a
  window `"resize"` event, so without the explicit refit the canvas
  would keep its pre-fullscreen size and stretch. When the event
  fires, `document.fullscreenElement` is already the browser's actual
  state, so one listener serves BOTH entry and the native Esc
  exit — Escape is deliberately left unbound.
- **KeyF is checked before the screen-transition and gameplay key
  handling, with an `e.repeat` guard.** F must work in ANY game state
  and can never be swallowed as movement/fire input or mistaken for
  Enter/KeyR's jobs. Verified against the current bindings: KEY_CODES
  is arrows/WASD/Space only — F is not among them, and the nearest
  neighbours (KeyA/KeyD turn, KeyR restart, Enter start/restart) are
  distinct codes, so no adjacency conflict; that verification is what
  this bullet records. The repeat guard stops a HELD F flapping the
  toggle — only the press edge counts (same precedent as bricks #113).
  Alternative: letting F fall into the gameplay path (rejected — the
  ticket forbids swallowing it as input).
- **The start-screen hint is a canvas-drawn line ("F  FULL SCREEN")**
  in the same `UI_HUD_PX` monospace font and two-space-separator style
  as "ARROWS / WASD  MOVE"/"SPACE  FIRE", centred at the existing
  control-list rhythm — no new DOM element. Alternative: a dedicated
  smaller caption (rejected — the existing prompt style is what the
  ticket designates).
- **Test stubs: the vm `document` stubs in the nine existing asteroids
  suites gained a no-op `addEventListener` (same precedent as bricks
  #113)** because the fullscreenchange listener registers on document
  at boot. The element-id stub maps are unchanged (no new DOM).

## 2026-11-03 — Operator request: hub page + drop-in demo package

- **`index.html` is a pure-CSS page: no `<script>` at all.** The hub has
  nothing to compute — no clock, no canvas, no state. The starfield is
  four tiled `radial-gradient` dot layers and the blinking coin a CSS
  `steps()` animation (disabled under `prefers-reduced-motion`).
  Fewer moving parts means nothing to break on an arbitrary host, and
  the gate check `grep -c '<script' index.html == 0` pins the property
  permanently. Alternatives: a JS-drawn intro (rejected — complexity
  with zero payoff for a three-item menu), shared game assets (rejected
  — the repo rule is one file, no external refs, per game AND now per
  page).
- **Every link is a bare relative href (`bricks.html`, `index.html`).**
  No root-absolute paths, no query strings: the `oneshot/` folder then
  serves identically at any mount depth on any static host — the
  WordPress-under-a-subfolder case is what motivated this. The packager
  copies files as-is; nothing is rewritten at build time.
- **The games' back links are inert static markup (anchor + 6-line
  `<style>`), added with zero JS and no boot-time `getElementById`.**
  The vm suites boot the real `<script>` of each game file, and any id
  queried at boot needs a stub in ~35 suites (the recurring harness
  diamond); an anchor the script never touches is invisible to the
  harness — the full 46-suite loop confirms. Alternative: inject the
  link from a shared snippet at build time (rejected — the games must
  also work directly from the repo, and a build step violates the
  "the .html file IS the deployable artifact" invariant the packager
  relies on).
- **The no-external-refs gate checks on the two games now exclude
  exactly one exception: `href="index.html"`.** The original rule
  (zero `src=`/`href=`) encoded "no external assets, playable when
  opened directly" — a sibling-page navigation link violates neither,
  and narrowing the check keeps the real protection (assets, CDN,
  cross-origin) while allowing the hub round trip. A missing
  `index.html` (e.g. opening a copied `bricks.html` alone) degrades to
  a dead link, not a broken game.
- **`scripts/package-oneshot.sh` shells out to python3 std-lib
  `zipfile`** rather than the `zip` binary (not guaranteed installed)
  or tar.gz (WordPress/Windows users expect `.zip`). ZipInfo
  timestamps are pinned (1980-01-01) and attributes fixed (0644), so
  identical sources produce a byte-identical archive — the test asserts
  this by building twice and comparing sha256. Rejected: a Makefile
  target (no Makefile exists; the scripts/ dir is the convention), a
  build step that renders the games into a template (there is nothing
  to render — the files already are the artifacts).
- **`tests/oneshot-pack.test.mjs` locks the package contract**: the
  hub is doctype-valid, script-free and free of external refs; the hub
  links both games; both games link back to the hub; the packager
  output contains EXACTLY `oneshot/{index,bricks,asteroids}.html`,
  each member byte-identical (sha256) to its repo source. Node has no
  built-in zip reader, so the manifest is read back via the same
  python3 std-lib the packager uses (still hermetic: no network, no
  wall-clock dependence — the determinism check is on build output, not
  on time).

## 2026-11-05 — Operator request: Docker + Caddy deploy for oneshot.paulgresham.com

- **The Dockerfile is a single `caddy:latest` stage with no build
  step** — mirroring the world-cal pattern, minus the node build stage,
  because the repo root IS the deployable: `COPY index.html bricks.html
  asteroids.html /srv/` and the same in-image Caddyfile world-cal uses
  (`root * /srv`, `file_server`, `encode gzip`, port 80). The in-image
  Caddy serves plain HTTP; TLS terminates at the VPS edge Caddy exactly
  as for every other paulgresham app. Alternative: a multi-stage file
  (rejected — there is nothing to build; a second stage would be
  theatre).
- **The webroot is the domain root, NOT the `oneshot/` subfolder the
  WordPress zip uses.** `oneshot.paulgresham.com/` must serve the hub,
  so the three files go to `/srv` flat. The two packaging targets have
  different consumers (a subfolder drop-in vs an owned hostname) and
  deliberately diverge; both are still pure copies of the same repo
  files — `.devloop.json` pins that the Dockerfile's COPY line names
  all three, so a fourth game can never silently miss the image.
- **Deployment mirrors world-cal's three-stage workflow verbatim**
  (test → build/push `ghcr.io/wentbackward/oneshot:{latest,sha}` →
  SSH to the VPS, pull, `docker run --name oneshot --network
  infra_app-net`, health-wait, prune), so the VPS topology stays
  uniform: one shared docker network, one edge Caddy, one container
  per app. Differences are only the app name and the test stage,
  which runs the repo's suite loop directly (no `npm ci` — this repo
  has no `package.json`; the suites depend on node builtins plus the
  runner's `python3`/`bash`, both stock on ubuntu-latest).
- **The container health check curls host port 80, i.e. the VPS edge
  Caddy — inherited deliberately from world-cal.** It passes only once
  the `oneshot.paulgresham.com` route exists in the VPS Caddyfile
  (kept on the VPS, not in this repo; `infra/Caddyfile.example`
  documents the block). A missing route therefore surfaces as a
  failed deploy with the container logs, which is the correct signal
  for a first-time deploy. Alternative: a container-local HTTP probe
  (rejected — the caddy image ships no curl/wget, and adding a tool
  just for probing breaks the "tiny container" property).
- **Secrets stay in GitHub Actions, never in the repo** (the repo is
  headed for public as a dev-loop demo): `GHCR_TOKEN`, `VPS_HOST`,
  `VPS_SSH_KEY` — the identical trio world-cal already uses, so the
  operator provisions them once per repo with the same values.

## 2026-11-06 — Deploy: drop GHCR_TOKEN — public package, automatic token

- **The workflow no longer uses a `GHCR_TOKEN` secret at all** (operator
  observation: the project is public, so the image is public). Push side:
  the build job declares `permissions: { contents: read, packages: write }`
  and logs in to GHCR with the automatic `GITHUB_TOKEN`, which may publish
  to the actor's own GHCR — no long-lived PAT in the secret store. Pull
  side: the VPS `docker pull`s the PUBLIC package anonymously (GHCR allows
  unauthenticated pulls of public images; 100 pulls / 6 h per IP, we do
  one per deploy) — the `docker login` on the VPS is deleted. Secrets
  reduce to the transport pair `VPS_HOST` + `VPS_SSH_KEY`.
- **Explicit precondition: the repo, and with it the package, must be
  public.** Recorded as a workflow comment AND a doc line, because the
  repo is private TODAY: a first push while private would pass the test
  stage and fail at the GHCR push (private package rejects the
  GITHUB_TOKEN publish; and even if it didn't, the VPS's anonymous pull
  of a private image would fail). Alternative kept as escape hatch: if
  we ever hit GHCR's anonymous pull rate limit, a one-time `docker login
  ghcr.io` with a read-only token stored on the VPS — not in the repo.
- **Divergence from world-cal is deliberate and one-way:** world-cal
  keeps its `GHCR_TOKEN` (its package visibility predates this decision
  and its workflow predates the automatic-token pattern); oneshot takes
  the tighter form. Migrating world-cal is a candidate for a later
  ticket, not a scope creep here.
