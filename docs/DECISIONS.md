
## 2026-11-26 — Ticket #144: schooling motion overhaul (fish-like curves, buoyancy, no billiard bounces)

- **The elastic wall reflection is deleted; a non-mirroring safety net replaces it
  (position clamp + outward-normal absorption, `TETRA_WALL_NORMAL_RETENTION = 0`).**
  Root-cause instrumentation on the old code showed all 160 >90°/step heading events
  in a 1000-step default-population run were axis mirrors at the walls
  (max 140.03°/step; e.g. x=1597, v(+192,−96) → (−191,−97)). Absorption preserves the
  tangential component and lets the boundary band do the turning; the turn cap below
  keeps even this residue a continuous curve. Alternatives: retaining a reflection
  fraction (keeps the mirror feel), spring pushback (second force path), snapping the
  heading on contact (violates the turn cap).
- **Turn-rate cap of 2.6 rad/s is applied to the FINAL velocity, not the raw steering
  output**, and the velocity is rebuilt at `old heading + clamped(Δ)`: the measured
  per-step |Δheading| is then bounded by construction (verified max 2.48° = the cap,
  0 right-angle steps). A full-speed turn needs only ≈ 0.9 rad/s (master force ÷
  speed), so the cap binds only at low speed, where force spikes would otherwise whip
  the fish around; a 180° reversal takes ≈ 1.2 s. The cap is per-step on the stored
  heading (the quantity the tail-torque and the tests measure), so the rare
  contact-residue case is covered without a special path. Alternative: limiting only
  steering-derived turns (a post-safety-net velocity change would then breach the cap
  exactly in the edge case the ticket cares about).
- **Pure-normal contact recovery:** if absorption + a zero tangential leave the fish
  motionless on the glass (a square full-speed strike), it is relaunched at
  `TETRA_MIN_SPEED` along the wall's inward normal — `atan2(0,0)` would snap the spine
  to +x (a 180° teleported heading) and a zero velocity has no defined heading.
- **Vertical story = constant gravity (8 u/s²) + squared thrust lift (20 u/s² at
  `TETRA_MAX_SPEED`)**: net negative buoyancy below ≈ 139 u/s (sags slowly), net lift
  above (rises on a startle/chase burst). No per-fish pitch or thrust state was added —
  that would grow the save/telemetry contract and the tail model for no ticket ask.
  Alternatives: pitch-coupled thrust vector (heavier, more state), target-depth
  steering (not the described "energy" feel).
- **Wander is a perpendicular force (4 u/s²) modulated by a slow per-tetra sine; the
  frequency/phase ride the existing per-spawn RNG stream** (two extra draws per fish,
  fixed order — same seed ⇒ same school, trajectories shift on purpose per the
  ticket). Sized below `TETRA_GRAVITY` so the buoyancy story's vertical drift is not
  swamped by wander's sideways pull, and negligible at cruising speed where straight
  runs are honest anyway. Alternatives: a second dedicated RNG stream (no justification),
  angels'-style cumulative yaw (heading drifts far from the school average while
  alignment is weak).
- **Boundary band retuned: `BOUNDARY_MARGIN` 120 → 300, `MAX_STEERING_FORCE`
  120 → 200** (the band is the only force at master scale). Stop-energy argument: a
  fastest tetra entering the margin edge carries ½·220² = 24 200; the linear ramp to
  200 u/s² over 300 u supplies 30 000 of work — contact becomes the rare residue the
  safety net exists for. The pinned steering contract (linear ramp 0→full at the wall,
  strictly inward, per-force ≤ master) is unchanged; the constants moved to
  `constants.ts` with the rationale, re-exported from `steering.ts` so the contract
  tests' import seam is intact. Alternatives: a non-linear ramp (breaks the pinned
  contract), keeping 120/120 (contacts at 220 u/s stay frequent — the billiard feel
  returns).
- **`startleAt` refreshes each startled tetra's derived heading in the same call.**
  The impulse re-orients the velocity; without the refresh the next step's turn cap
  would measure from the pre-jolt heading and fight the scatter (the 60-frame
  positive-radial-velocity test would degrade). Tail torque smooths over the jolt as
  before. Alternative: exempting the startle from the cap (pokes a hole in the
  smoothness guarantee for the one event the existing suite protects).
- **Angels get the side-wall band force inlined (x only), and predator/angel wall
  contacts absorb instead of mirror.** Angels' vertical story (bob + base-altitude
  clamp) and the forage-ring behaviour stay untouched; the inlined formula (same
  constants, no fresh vector) keeps the angel path allocation-free, satisfying the
  #144 "no new per-step allocations" constraint. The predator's kinematic velocity is
  re-set every step, so absorbing the outward normal at contact just makes a
  wall-bound rest-drift slide until the next aim — no new predator AI.
- **AC1 mirror observable: a component flip counts as an axis-mirror only when it
  keeps ≥ 70 % of its magnitude AND the normal was ≥ 25 % of the speed.** A real
  reflection flips the component that carries the motion (~100 % preserved); a fish
  riding the glass post-startle rocks its heading a couple of degrees around
  perpendicular and its ~1 u/s sideways wobble (≈ 2 % of a 50 u/s slide) crossing
  zero is organic sliding, not a billiard bounce.
## 2026-11-26 — Ticket #143: per-theme art set (NEON + MINIMAL)

- **Multi-sets asset contract: one manifest per game, a required `set`
  field per entry; slot names repeat across sets and the (set, name) pair is the
  slot's identity.** The manifest stays pre-sorted, now by (set, name); uniqueness
  holds per (set, name) pair and the per-file ownership rule forbids one file backing
  two slots (it would double-count the raw budget and blur identity).
  Alternatives: per-set subdirectories (rejected — more filesystem churn, no
  test benefit), or a second manifest per set (rejected — splits the single
  validated contract; the budget/attribution story lives in one place).
- **Set naming: the canonical set ships its slot's bare name (`bg.png`), the new
  sets suffix theirs (`bg-neon.png`).** Keeps the classic sets at its established file
  names (no provenance drift) and makes the new sets' ownership greppable in the
  tree. The embedded payload carries the set name per entry in the stable
  (set, name) order, `set` leading the fixed key order, so a consumer can group
  the table by sets without re-reading the manifest.
- **Per-set lazy decode, replacing the boot-decode-all + `ART_ON` gate.**
  Boot decodes the ACTIVE theme's set only; selecting a theme aliases its
  per-set table as `ASSETS` and starts its decode if not already attempted
  (per-entry settle, once per set — repeats toggle pointers, never decodes).
  While a set is undecoded its frames stay on the procedural paint the classic
  fallback always used, so a failed/pending set never blanks a frame.
  `THEMES.<name>.art` and the `ART_ON` flag are dropped — every theme now
  carries a set, so the gate would be a constant-true branch (the 60 fps
  rule: no dead branches). A set with no payload entries yet (the
  classic-only interim state) behaves exactly like the old flat theme:
  synchronous settle, empty table, procedural frame.
- **Provenance scheme: the cand metadata, the set spec and the run record
  commit under `art/<game>-<theme>/`; the raw candidate images and contact
  sheets stay in the shared art workspace (referenced from the PR notes).**
  A 960×600 background's candidate sheet is ~MB-scale per set; the cand-*.json
  records carry everything the review needs (model, seed, parameters,
  licence), and the committed contact-sheet absence is the deliberate size
  trade-off. Alternative: commit the full run dir (rejected — repo weight
  without added review value).

## 2026-11-26 — Ticket #145: procedural habitat richness (seeded floor decor — tufts, anemones, marine snow)
- **Habitat decor is realised as procedural canvas, with no new
  image slots** (2026-11-26, ticket #145). The designer brief
  (docs/HABITAT-BRIEF.md) directs the composition; the three chosen
  elements (swaying grass-tuft clusters, pulsing anemone/coral
  clusters, marine-snow motes) are painted by a new
  src/render/habitat.ts module. Reasons: the ticket prefers
  procedural realisation to stay inside the asset budget, no human
  art gate is required, and the palette stays a single day-neutral
  set consistent with the existing untinted procedural layers
  (gravel, kelp, placed rocks). Alternatives: asset-forge sprite
  slots (requires the sourcing runbook, budget headroom and a
  human approval cycle — disproportionate for a visual-direction
  ticket); reusing the kelp-strip art for the tufts (wrong shape
  language — a broad leaf, not a fine blade fan).
- **Marine-snow motes are analytic functions of sim time, not
  integrated** (2026-11-26, ticket #145). Position = f(t) with
  fall + sinusoidal lateral wobble and both-axis wrapping, the
  same stateless recipe as the bubble column: zero per-frame
  allocation, a paused sim freezes them, and the placement
  determinism test reads straight from the seeded pool data.
  Alternatives: verlet/integrated motes in the sim (a new sim
  system, per-step allocation churn, and it would make decor a
  sim participant — out of scope); a static snow texture tile
  (static noise — the ticket forbids it).
- **Habitat floor elements share the substrate's near-band
  parallax and draw without transforms** (2026-11-26, ticket
  #145). Tuft and anemone bases live on the seeded tile, are
  tile-doubled at x and x - tile, and drift at
  SUBSTRATE_NEAR_DRIFT — they sit in the same depth band as the
  substrate's own kelp tufts, so the parallax story stays
  coherent. No save/translate/rotate: tile doubling is computed
  inline, which also keeps the render-order audit's translate
  anchors (substrate 2 + caustic 5) intact. Alternatives: a
  dedicated third parallax band with its own drift (adds a
  translate the AC4 audits would have to re-pin); world-anchored
  placement like placed rocks (decor would no longer belong to
  the parallax substrate band, and it would need sim-side
  storage — out of scope).