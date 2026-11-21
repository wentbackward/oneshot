Build an interactive 3D hardware showcase and thermal airflow visualizer in TypeScript using Three.js, featuring a procedurally modeled dual/triple-fan flagship graphics card on a studio display stand.

1. Architecture & Decoupled State
- Separate scene state/simulation logic (`src/sim/thermalModel.ts` and `src/sim/cameraPresets.ts`) from Three.js mesh builders (`src/meshes/`) and the WebGL render loop (`src/renderer/`).
- All thermal calculations, fan RPM curves, exploded-view interpolation math, and preset transitions must be pure TypeScript modules covered by unit tests.

2. Procedural 3D Geometry (`src/meshes/`)
- Construct a detailed GPU assembly using procedural Three.js geometries and PBR materials (`MeshStandardMaterial` / `MeshPhysicalMaterial`) with no external `.gltf`/`.obj` dependencies:
  - Backplate with brushed metal finish, cutouts, and mounting screws.
  - PCB with gold PCIe edge connector fingers, SMD capacitor arrays, GPU die package, VRAM chips, and 12V-2x6 power header.
  - Dense aluminum heatsink fin stack with copper heatpipes passing through the fins.
  - Sculpted outer shroud with 3 axial fans (curved blades, hub badges) and addressable RGB accent light strips.
  - IO bracket with DisplayPort/HDMI ports and ventilation slots.

3. Interactive Modes & Physics Simulation
- **Exploded View Slider & Toggle:** Smoothly interpolate component groups (backplate, PCB, heatsink, shroud, fans) along vertical/exploded axes with optional floating callout labels pointing to each subsystem.
- **Thermal & Load Simulator:** User-controlled GPU workload slider (Idle 0% to Full Load 100%) and ambient room temperature (15°C–40°C). Compute realistic core/memory temperatures and PWM fan RPM curves over time; tie fan blade angular velocity directly to live RPM.
- **Airflow Particle Visualizer:** Toggleable particle system showing cool intake air (blue) entering through the axial fans and heated exhaust air (orange/red) exiting through the fin stack and IO bracket, scaling velocity and color with live thermal state.
- **RGB Lighting Controller:** Modes for Static Color, Rainbow Wave, Breathing, and Temperature-Reactive (shifting green → amber → red based on GPU core temp).

4. Camera & Studio Environment
- OrbitControls with damping, zoom limits, and smooth animated transitions between camera presets: `Hero 3/4`, `PCB & Die Close-up`, `Heatsink Profile`, and `IO Bracket`.
- Studio lighting rig with key/fill/rim lights, shadow mapping, and a subtle dark reflective pedestal.

5. Verification & Checks
- Unit tests verifying thermal convergence math, fan PWM curve clamping, exploded-view coordinate interpolation bounds, and RGB color mapping.
- Headless scene-graph instantiation test (verifying mesh hierarchy, disposal/cleanup without memory leaks, and zero TypeScript errors).

