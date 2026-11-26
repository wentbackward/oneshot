## Brief
Create a complete, playable arcade action game in a single index.html file using vanilla HTML5, CSS, and JavaScript. 

## Concept: "Asteroid Horizon" — a fast-paced 2D top-down space shooter where the player controls a ship that rotates, thrusts, shoots lasers, and dodges/destroys incoming waves of asteroids and enemy drones.

## Requirements:
1. Self-contained: Put all CSS inside <style> and all JS inside <script> tags within a single index.html file. Do not use external libraries, CDNs, or image assets (use Canvas 2D shapes, vector paths, or procedural particles).
2. Game Loop & Physics: Smooth requestAnimationFrame loop, velocity/friction movement, screen wrapping or boundary collision, and collision detection between lasers, player, and hazards.
3. UI & State: Start screen, live score, health/lives counter, wave counter, and a Game Over / Restart screen.
4. Controls: Arrow keys or WASD to move/rotate, Spacebar to shoot.
5. Polish: Add basic particle explosions on impact, sound effects using the browser Web Audio API (procedural beep/noise synthesis so no external audio files are needed), and clean retro/arcade styling.

Return ONLY valid raw HTML code inside a single markdown code block. No conversational filler, no explanations before or after.


## Visual Direction & Media Design (standing requirement)

Before any visual work on this product starts, the digital-media-designer skill
(asset-forge toolchain) defines and documents the overall look and feel:

- Style and a one-sentence concept line for the world and mood.
- Colour palette per theme: a named hex list per selectable theme (pixel art:
  8–32 colours, the spec's `palette`; every pixel asset snaps to it). Contrast
  hierarchy: gameplay pieces pop, backgrounds recede.
- Consistency anchors: light direction, outline policy, detail level.
- Required assets and animation direction: for every element that moves —
  what moves, how, frame count and cadence, easing.
- The palette/theme definitions are part of each ticket's acceptance
  criteria; final image assets follow docs/ASSET-SOURCING.md (where
  applicable).

Asteroids-specific: rendering stays FULLY PROCEDURAL (Canvas shapes / vector
paths, no image assets). The digital-media-designer still defines the
palette, themes and animation direction, and the implementer realises it in
vector code and procedural animation.
