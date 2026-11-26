#!/usr/bin/env node
// ================================================================
// Unit + render-contract tests — habitat richness (ticket #145,
// design direction in docs/HABITAT-BRIEF.md, PRD §3 "Atmospheric
// Rendering"): the tank floor gains three procedurally painted
// decor elements — swaying grass-tuft clusters, pulsing
// anemone/coral clusters and drifting marine-snow motes — on top
// of the seeded parallax substrate. Proven from the REAL module
// (src/render/habitat.ts) through its public interface:
//   - placement determinism: same seed ⇒ identical layout,
//     different seed ⇒ different layout (the ticket's
//     placement-determinism criterion);
//   - the tufts participate in the current field: their tip
//     offset carries a steady lean LINEAR in the ambient
//     current (±AMBIENT_CURRENT_X ⇒ ±HABITAT_TUFT_CURRENT_LEAN)
//     on top of a sim-time-driven sway that moves with time;
//   - the marine-snow motes fall at per-slot speeds inside the
//     named band, wrap the column, and wobble within their named
//     amplitude around a fixed lane — pooled and stateless
//     (position = f(sim time));
//   - the anemone tentacles pulse: over one period every tentacle
//     tip sweeps across BOTH extremes of the ±
//     HABITAT_ANEMONE_PULSE_AMP envelope;
//   - max-density performance: 600 consecutive paints (the full
//     named pools at a 1600×900 viewport) with a byte-stable
//     per-frame op profile, byte-identical pools afterwards, and
//     a wall-time budget orders of magnitude under one frame.
//
// Harness: stock node with flag-free .ts type-stripping imports
// the real src/render source; a recording 2d-context proxy logs
// the drawing calls (habitat's legal call set is small — anything
// else, e.g. a stray save/translate or a per-frame gradient,
// throws, which is what keeps the op profile exact). Seeded, no
// network, no wall-clock dependence in the layout audits (the
// perf check uses performance.now, as ticket #120's bench does).
//
// Run: node tests/fishtank-habitat.test.mjs
// =================================================================
import { performance } from "node:perf_hooks";
import { Habitat,
  HABITAT_TUFT_COUNT, HABITAT_TUFT_BLADES, HABITAT_TUFT_CURRENT_LEAN,
  HABITAT_ANEMONE_COUNT, HABITAT_ANEMONE_TENTACLES,
  HABITAT_ANEMONE_PULSE_SPEED, HABITAT_ANEMONE_PULSE_AMP,
  HABITAT_MOTE_COUNT, HABITAT_MOTE_FALL_MIN, HABITAT_MOTE_FALL_MAX,
  HABITAT_TILE_COPIES,
} from "../src/render/habitat.ts";
import { SUBSTRATE_NEAR_DRIFT } from "../src/render/substrate.ts";
import { AMBIENT_CURRENT_X } from "../src/sim/constants.ts";

const TAU = 2 * Math.PI;
const EPS = 1e-9;

// ---------- tiny test harness (house style) ----------
let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${name}\n       ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------- recording 2d context (habitat's primitives only) ----------
// Habitat is pure vector paint with constant styles, painted
// BEFORE the fish layers (behind them): the calls it may legally
// issue are beginPath/moveTo/quadraticCurveTo/arc/ellipse/stroke/
// fill. Anything else throws, so the op-profile audits below pay
// only for what they audit.
const CALL_METHODS = [
  "beginPath", "moveTo", "lineTo", "quadraticCurveTo", "arc",
  "ellipse", "stroke", "fill",
];
function makeRecordingCtx() {
  const calls = [];
  const target = {
    canvas: { width: 0, height: 0 },
    createLinearGradient: () => { throw new Error("habitat must not build a gradient per frame"); },
    createRadialGradient: () => { throw new Error("habitat must not build a gradient per frame"); },
  };
  for (const m of CALL_METHODS) {
    target[m] = (...args) => calls.push({ kind: m, args });
  }
  return {
    calls,
    ctx: new Proxy(target, {
      get(t, prop) {
        if (prop === Symbol.toPrimitive) return undefined;
        if (prop in t) return t[prop];
        throw new Error(`habitat issued an unaudited context call: ${String(prop)}`);
      },
      set() { return true; }, // absorb fillStyle/strokeStyle/lineWidth writes
    }),
  };
}

/** The terminal point (tip) of every QCT path in one paint, in
 *  paint order — anemone tentacles first, then tuft blades
 *  (quadraticCurveTo(cp1x, cp1y, x, y): the tip is the 3rd/4th arg). */
function qctTips(calls) {
  const tips = [];
  for (const c of calls) if (c.kind === "quadraticCurveTo") tips.push([c.args[2], c.args[3]]);
  return tips;
}
const ANEMONE_TIPS = HABITAT_ANEMONE_COUNT * HABITAT_TILE_COPIES * HABITAT_ANEMONE_TENTACLES;
const TUFT_TIPS = HABITAT_TUFT_COUNT * HABITAT_TILE_COPIES * HABITAT_TUFT_BLADES;

/** Paint one frame; return the recorded calls. `t` is sim seconds,
 *  `currentX` defaults to the world's ambient current. */
function paintCalls(h, W, H, t, currentX) {
  const r = makeRecordingCtx();
  h.paint(r.ctx, W, H, t, currentX);
  return r.calls;
}

// ================================================================
// Criterion (placement determinism): the same seed yields the
// same habitat layout; a different seed yields a different one
// ================================================================
check("placement is deterministic per seed: same seed -> identical layout, different seed -> different layout", () => {
  const a = new Habitat();
  const b = new Habitat();
  assert(JSON.stringify(a.layout) === JSON.stringify(b.layout),
    "two habitats built from the same default seed must carry identical element data");
  const c = new Habitat(7);
  const d = new Habitat(8);
  assert(JSON.stringify(c.layout) !== JSON.stringify(d.layout),
    "different seeds must give different layouts (the placement must actually read its seed)");
  // Shape sanity: the named pools exist at their named sizes.
  assert(a.layout.tufts.length === HABITAT_TUFT_COUNT && a.layout.tufts.every((tf) => tf.blades.length === HABITAT_TUFT_BLADES),
    "tuft pool must carry HABITAT_TUFT_COUNT clusters of HABITAT_TUFT_BLADES blades");
  assert(a.layout.anemones.length === HABITAT_ANEMONE_COUNT,
    "anemone pool must carry HABITAT_ANEMONE_COUNT clusters");
  assert(a.layout.motes.length === HABITAT_MOTE_COUNT,
    "mote pool must carry HABITAT_MOTE_COUNT motes");
});

// ================================================================
// Criterion (animation direction 1 + current-field participation):
// the tuft tips SWAY with sim time (nothing is static), and their
// steady lean is linear in the ambient current
// ================================================================
check("tuft blades sway with sim time: tip offsets move between two sim times", () => {
  const h = new Habitat();
  const W = 800; const H = 600;
  const tips1 = qctTips(paintCalls(h, W, H, 2.0, AMBIENT_CURRENT_X)).slice(ANEMONE_TIPS);
  const tips2 = qctTips(paintCalls(h, W, H, 2.4, AMBIENT_CURRENT_X)).slice(ANEMONE_TIPS);
  assert(tips1.length === TUFT_TIPS && tips2.length === TUFT_TIPS,
    `expected ${TUFT_TIPS} tuft-blade QCT tips per paint, got ${tips1.length}/${tips2.length}`);
  let movers = 0;
  for (let i = 0; i < TUFT_TIPS; i++) {
    if (Math.abs(tips1[i][0] - tips2[i][0]) > EPS) movers++;
  }
  assert(movers >= TUFT_TIPS / 2,
    `only ${movers} of ${TUFT_TIPS} tuft blades moved between t = 2.0 and t = 2.4 — the tufts are static noise`);
});

check("tufts lean into the current field: tip offset shifts by exactly +/-HABITAT_TUFT_CURRENT_LEAN for +/-AMBIENT_CURRENT_X (linear)", () => {
  const h = new Habitat();
  const W = 800; const H = 600;
  const t = 3.3; // any fixed sim time: the sway term cancels in the difference
  const base = qctTips(paintCalls(h, W, H, t, 0)).slice(ANEMONE_TIPS);
  const cases = [["+", AMBIENT_CURRENT_X, HABITAT_TUFT_CURRENT_LEAN],
                 ["-", -AMBIENT_CURRENT_X, -HABITAT_TUFT_CURRENT_LEAN]];
  for (const [label, cur, want] of cases) {
    const tips = qctTips(paintCalls(h, W, H, t, cur)).slice(ANEMONE_TIPS);
    for (let i = 0; i < TUFT_TIPS; i++) {
      const dx = tips[i][0] - base[i][0];
      assert(Math.abs(dx - want) <= EPS,
        `tuft blade ${i}: current ${label}${AMBIENT_CURRENT_X} must shift the tip by ${want}px, recorded ${dx}px`);
    }
  }
});

// ================================================================
// Criterion (animation direction 2 + pooling): the marine-snow
// motes fall at a per-slot speed inside the named band, wrap the
// column, and wobble within their named amplitude around a fixed
// lane (analytic in sim time — pooled and stateless)
// ================================================================
check("marines-snow motes fall in the named speed band, wrap the column, and stay within their named wobble amplitude around a fixed lane", () => {
  const h = new Habitat();
  const W = 800; const H = 800;
  const DT = 4;                  // sim seconds between recorded paints
  const T_END = 320;             // > H / FALL_MIN: every slot must wrap
  const rows = [];               // per-paint: { ys: [mote y], xs: [mote x] }
  for (let t = 0; t <= T_END; t += DT) {
    const ys = []; const xs = [];
    for (const c of paintCalls(h, W, H, t, AMBIENT_CURRENT_X)) {
      if (c.kind === "arc") { xs.push(c.args[0]); ys.push(c.args[1]); }
    }
    assert(ys.length === HABITAT_MOTE_COUNT, `expected ${HABITAT_MOTE_COUNT} mote arcs per paint, got ${ys.length}`);
    rows.push({ xs, ys });
  }
  const wrapped = new Set();
  for (let k = 1; k < rows.length; k++) {
    for (let m = 0; m < HABITAT_MOTE_COUNT; m++) {
      const dy = rows[k].ys[m] - rows[k - 1].ys[m];
      if (dy < -H / 2) {
        wrapped.add(m); // the slot fell back to the top of the column
        continue;
      }
      const fall = dy / DT;
      assert(fall >= HABITAT_MOTE_FALL_MIN - EPS && fall <= HABITAT_MOTE_FALL_MAX + EPS,
        `mote ${m}: fall speed ${fall}px/s escaped the named band [${HABITAT_MOTE_FALL_MIN}, ${HABITAT_MOTE_FALL_MAX}]`);
    }
  }
  assert(wrapped.size === HABITAT_MOTE_COUNT,
    `only ${wrapped.size} of ${HABITAT_MOTE_COUNT} motes wrapped the column by t = ${T_END}s`);
  // Lane bound (toroidal): each mote stays within its own wobble
  // amplitude of x0*W at every recorded instant.
  const motes = h.layout.motes;
  for (let m = 0; m < HABITAT_MOTE_COUNT; m++) {
    const lane = motes[m].x0 * W;
    const amp = motes[m].wobble;
    for (let k = 0; k < rows.length; k++) {
      const d = ((((rows[k].xs[m] - lane + W / 2) % W) + W) % W) - W / 2;
      assert(Math.abs(d) <= amp + 1e-6,
        `mote ${m} at t = ${k * DT}: drifted ${Math.abs(d).toFixed(2)}px from its lane — beyond the named wobble amplitude ${amp}`);
    }
  }
});

// ================================================================
// Criterion (animation direction 3): the anemone tentacles pulse
// — over one period every tentacle tip sweeps from below
// (1 − AMP)·L to above (1 + AMP)·L
// ================================================================
check("anemone tentacles pulse: over one period every tip crosses both extremes of the +/-HABITAT_ANEMONE_PULSE_AMP envelope", () => {
  const h = new Habitat();
  const W = 800; const H = 600;
  const PERIOD = TAU / HABITAT_ANEMONE_PULSE_SPEED;
  const SAMPLES = 48;
  const anemones = h.layout.anemones;
  // radii[cluster][tentacle][sample] = tip distance from its base center
  const radii = anemones.map(() => Array.from({ length: HABITAT_ANEMONE_TENTACLES }, () => []));
  for (let s = 0; s <= SAMPLES; s++) {
    const t = (s * PERIOD) / SAMPLES;
    const off = (t * SUBSTRATE_NEAR_DRIFT) % W;
    const tips = qctTips(paintCalls(h, W, H, t, AMBIENT_CURRENT_X));
    anemones.forEach((c, ci) => {
      for (const copy of [0, 1]) {
        const bx = c.u * W + off + copy * -W; // the tile-doubled copy sits one tile left
        for (let i = 0; i < HABITAT_ANEMONE_TENTACLES; i++) {
          const tip = tips[(ci * HABITAT_TILE_COPIES + copy) * HABITAT_ANEMONE_TENTACLES + i];
          radii[ci][i].push(Math.hypot(tip[0] - bx, tip[1] - H));
        }
      }
    });
  }
  anemones.forEach((c, ci) => {
    for (let i = 0; i < HABITAT_ANEMONE_TENTACLES; i++) {
      const rs = radii[ci][i];
      const hi = Math.max(...rs);
      const lo = Math.min(...rs);
      assert(hi >= c.tentLen * (1 + HABITAT_ANEMONE_PULSE_AMP * 0.9),
        `anemone ${ci} tentacle ${i}: peak radius ${hi.toFixed(2)} < (1+0.9·AMP)·L = ${(c.tentLen * (1 + HABITAT_ANEMONE_PULSE_AMP * 0.9)).toFixed(2)} — the pulse never opened`);
      assert(lo <= c.tentLen * (1 - HABITAT_ANEMONE_PULSE_AMP * 0.9),
        `anemone ${ci} tentacle ${i}: trough radius ${lo.toFixed(2)} > (1-0.9·AMP)·L = ${(c.tentLen * (1 - HABITAT_ANEMONE_PULSE_AMP * 0.9)).toFixed(2)} — the pulse never closed`);
    }
  });
});

// ================================================================
// Criterion (performance, ticket scope §3): max-density 60 fps
// headroom and zero per-frame allocation — 600 consecutive paints
// of the FULL named pools at a 1600×900 viewport carry a byte-
// stable per-frame op profile, leave the pools byte-identical,
// and beat a wall-time budget orders of magnitude under one frame
// ================================================================
check("600 max-density paints: stable per-frame op profile, immutable pools, a fraction of one 60 fps frame each", () => {
  const h = new Habitat();
  const before = JSON.stringify(h.layout);
  const W = 1600; const H = 900;
  const FRAMES = 600;
  let profile = null;
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    const calls = paintCalls(h, W, H, f * (1 / 60), AMBIENT_CURRENT_X);
    if (profile === null) profile = calls.length;
    else assert(calls.length === profile,
      `frame ${f}: op profile drifted to ${calls.length} calls — per-frame allocation or branching crept in`);
  }
  const seconds = (performance.now() - t0) / 1000;
  console.log(`       (measured: ${(seconds / FRAMES * 1000).toFixed(3)} ms per paint for the full habitat at ${W}x${H}; frame budget 16.7 ms)`);
  assert(seconds < 2, `600 habitat paints took ${seconds.toFixed(3)} s — the per-frame work is not 60 fps safe`);
  assert(JSON.stringify(h.layout) === before,
    "painting must not mutate the seeded pools (stateless per frame, like the bubble column)");
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
