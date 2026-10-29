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
