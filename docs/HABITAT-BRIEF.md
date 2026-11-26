# Habitat Brief — tank-floor design direction (ticket #145)

Designer-directed composition for the fishtank's substrate and its new
ambient decor. The production review found the floor reads as "a sparse
strip of pebbles on sand"; this brief defines a populated, layered
habitat and the per-element animation direction, then is realised in
`src/render/habitat.ts` + `src/render/substrate.ts`.

## Design language

Everything must read as the SAME tank as the existing procedural
language: cool blue-grey/teal water, charcoal near-bed rock mass, sea
green kelp, day-neutral palettes that stay legible through the
Day / Dusk / Bioluminescent Night cycle (the ambient gradient behind
carries the phase; decor colours are fixed neutrals, exactly like the
existing procedural kelp, rocks and gravel fills). All new decor is
PROCEDURAL CANVAS — no new image slots — so the single-self-contained-
file asset contract and the 1 MiB / 1.5 MiB budgets are untouched and
no human art gate is needed.

## Composition

Three parallax bands, back to front (differential drift IS the depth):

| Band  | Contents (draw order)                                        | Drift (px/s) |
|-------|--------------------------------------------------------------|--------------|
| Far   | Ambient water backdrop → far gravel bed: 44 blue-grey stones (`#31506b`–`#466a8c`) in a 6 %-height band, tile-doubled | 1.2 (SUBSTRATE_FAR_DRIFT) |
| Mid   | NEW: drifting marine-snow motes through the water column     | self-motion (fall + sinusoidal wobble) |
| Near  | New grass-tuft clusters + pulsing anemone/coral clusters, then the near decor band: 6 charcoal rocks + 4 kelp tufts (all tile-doubled), then placed kelp/rocks (world-anchored), then the fish | 3.0 (SUBSTRATE_NEAR_DRIFT) |

Rock size distribution and pebble scatter (existing, kept): far
gravel rx 3–8 px / ry 2–5.5 px at random band height; near rocks
rx 18–42 px / ry 8–20 px resting 50 % sunk. The new near-bed decor
sits ON the same band — tufts and anemones at random u across the
tile, heights 4–9 % of tank height (tufts) and a 9–15 px base
(anemones) — so the bed reads planted rather than scattered.

## New decorative elements (three of the four candidates judged)

1. **Swaying grass-tuft clusters** — 8 clusters × 3 narrow blades,
   a lighter sea green (`rgba(74, 149, 102, 0.75)`) so they sit in
   front of the darker placed kelp. ANIMATION: continuous sway,
   0.8 rad/s (the kelp idle-sway frequency — the shared "current
   driver"), 4.5 px mid-amp × 1.5 at the tips, per-blade phase
   offsets so a cluster shimmers rather than tilting in unison, PLUS
   a steady LEAN into the ambient current (6 px at `AMBIENT_CURRENT_X`):
   tufts and the verlet kelp bend the same way — the decor
   participates in the current field, nothing is static noise.
2. **Pulsing anemone/coral clusters** — 3 clusters, 5 tentacles each,
   coral-rose tentacles (`rgba(226, 148, 155, 0.7)`) over a dark rose
   base (`#5a3d4e`) — the warm accent the cool palette lacks.
   ANIMATION: tentacles breathe, 0.6 rad/s pulse of ±18 % rest
   length, staggered by a golden-angle phase per tentacle so the
   bloom rolls around the cluster instead of pulsing in a lump.
3. **Drifting marine-snow motes** — a 48-slot pool of small
   pale motes (`rgba(205, 235, 250, 0.22)`, 0.8–1.8 px) falling
   through the water column at 3–6 px/s with a slow sinusoidal
   lateral wobble (3–8 px, 0.15–0.45 rad/s). ANIMATION: pure drift —
   position is an analytic function of sim time (same stateless
   recipe as the bubble column), wrapping seamlessly, giving the
   mid band its "alive" motion.

Rejected candidate: the broken-arch/ruin silhouette — a large static
mass adds little motion to the "more life" goal and would compete
with the predator's sightlines at night.

## Constraints honoured

- Non-colliding: decor never enters the sim; existing rock/kelp
  collision unchanged.
- Draw order: all new decor renders AFTER the placed scenery and
  STRICTLY BEFORE the fish layers (behind every swimmer).
- Placement is seeded (same seed ⇒ identical layout, `HABITAT_SEED`),
  and floor decor keeps the substrate's tile-wrap + near-drift
  discipline.
- Performance: pools fixed at construction, no per-frame allocation,
  one fillStyle/strokeStyle write per sub-layer per frame.

## Evidence

3-phase (Day / Dusk / Bioluminescent Night) plus a predation-frame
browser screenshot set ships with the PR (sourcing-runbook standard);
max-density bench and placement-determinism tests in
`tests/fishtank-habitat.test.mjs` and the render-order contract in
`tests/fishtank-atmosphere.test.mjs`.
