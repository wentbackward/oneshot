Build a high-performance, interactive 2D/2.5D aquarium ecosystem simulation in TypeScript using HTML5 Canvas, spatial partitioning, and procedural entity animation. (Entity ANIMATION stays procedural; fish bodies may be textured from in-repo, build-time-embedded image assets under the asset contract in docs/DECISIONS.md.)

1. Architecture & Spatial Engine
- Isolate simulation physics (`src/sim/`) from rendering (`src/render/`) and UI controls (`src/ui/`).
- Implement a uniform spatial hash grid (`src/sim/spatialGrid.ts`) for O(1) average-case neighbor queries so the simulation sustains 60 FPS with 250+ active entities.
- Support deterministic fixed-timestep stepping (`dt`) for reproducible physics tests.

2. Multi-Species Ecosystem & Steering Behaviors
- Implement Craig Reynolds steering forces (separation, alignment, cohesion, boundary avoidance, obstacle avoidance, and target seeking) across at least 3 distinct aquatic behaviors:
  - **Schooling Tetra/Minnows:** Tight cohesive schools that scatter rapidly when a predator approaches or the user taps the glass.
  - **Grazing Angelfish/Discus:** Slower, independent cruisers with vertical bobbing that forage near bottom plants and drift toward dropped food.
  - **Apex Predator (e.g., Small Shark or Pike):** Patrols the tank, stalks isolated prey when hunger crosses a threshold, and enters a cooldown/resting state after feeding.
- **Procedural Spine/Fin Animation:** Render each fish using a multi-segment articulated spine or wave-deformed body path where tail undulation frequency scales dynamically with swimming speed and turning torque. Fish bodies may ride this spine as textured sprites (embedded image assets per the asset contract in docs/DECISIONS.md) — the spine articulation and the speed/torque-scaled undulation remain procedural; the hybrid is the intended design.

3. Environment, Water Physics & Interactivity
- **Interactive Tools (Toolbar):**
  - *Drop Food:* Spawns sinking pellets with drag physics and subtle water currents; fish detect pellets within sensory radius and compete to eat them.
  - *Tap Glass:* Creates an expanding shockwave ring at the cursor that startles nearby schooling fish.
  - *Place/Remove Rocks & Kelp:* Click to place smooth river rocks (dynamic collision obstacles) and multi-segment verlet/spring kelp strands that sway with water currents and bend when fish swim through them.
- **Atmospheric Rendering:** Animated top-down volumetric caustic light shafts, rising bubble emitters with sinusoidal wobble, layered parallax substrate/gravel, and a Day / Dusk / Bioluminescent Night lighting cycle.

4. Telemetry & Persistence
- Collapsible HUD showing real-time FPS, entity counts by species, active spatial-grid cell utilization, and simulation speed controls (`Pause`, `1x`, `2x`, `4x`).
- Save/load tank layout (placed rocks, kelp, species counts, lighting mode) to `localStorage` as JSON with schema validation.

5. Verification & Checks
- Unit tests for spatial grid neighbor accuracy vs. brute-force distance checks, steering force vector clamping, kelp spring constraint stability, and tank JSON serialization/validation.
- Benchmark test verifying 1,000 fixed-timestep updates with 200 entities completes well under real-time budget without NaN coordinates or out-of-bounds escapes.

6. Visual Direction & Media Design (standing requirement)

Before any visual work on this product starts, the digital-media-designer skill
(asset-forge toolchain) defines and documents the overall look and feel:

- Style and a one-sentence concept line for the world and mood.
- Colour palette per theme/lighting: a named hex list per lighting phase
  (Day / Dusk / Bioluminescent Night) and per decorative element group, so
  background, substrate and living things each occupy a deliberate contrast
  band; the day phase stays neutral daylight (art is tinted per phase at
  boot).
- Consistency anchors: light direction, outline policy, detail level.
- Required assets and animation direction: for every element that moves —
  what moves, how, frame count and cadence, easing (tail undulation, kelp
  sway, bubble wobble, caustics drift); which slots are drawn procedurally
  versus taken from build-time-embedded image assets.
- The palette/theme definitions are part of each ticket's acceptance
  criteria; final image assets follow the human approval process in
  docs/ASSET-SOURCING.md.
