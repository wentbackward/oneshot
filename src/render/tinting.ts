// ================================================================
// Phase art tinting (ticket #139 — the ticket's default policy:
// ONE neutral-palette asset set, tinted at runtime by the
// Day/Dusk/Night cycle): each named palette (lighting.ts) maps to
// one art treatment. DAY is the IDENTITY pass-through — noon light
// adds no colour, so the neutral bitmap IS the day art and no bake
// exists for it. DUSK and NIGHT are multiplicative per-channel
// tints baked into phase-specific copies of every decoded bitmap
// AT BOOT (once per asset per phase, before the first frame).
//
// Why boot-time bakes (recorded in docs/DECISIONS.md, #139): the
// frame loop then selects the finished table with one map lookup —
// zero per-frame allocation and zero per-frame pixel work, which
// is the render-hygiene contract the 60 fps rule demands. The
// alternatives were per-frame `ctx.filter`/composite passes
// (per-frame cost and canvas-2D filter compatibility risk) and a
// single runtime multiply composite (a `multiply` composite over
// an ALPHA sprite punches the tint colour into the sprite's
// transparent corners — the bake's getImageData path never
// touches the alpha channel, so sprites stay holey).
//
// Degradation is by construction, never a crash path — the same
// discipline as the #137 decode: a bitmap without usable
// dimensions, or a runtime without a bake surface (headless boots
// have no OffscreenCanvas/document), simply yields no phase copy
// for that slot and the frame falls back to the neutral bitmap.
// That is why the vm draw-recording suites see one stable op
// profile across all three phases.
// ================================================================

import type { LightPalette } from "./lighting.ts";

/** One multiplicative phase tint: per-channel factors in (0, 1]
 *  applied to the art's RGB channels (alpha is never touched). */
export interface ArtTint {
  r: number;
  g: number;
  b: number;
}

/** Dusk: a warm amber wash (sunset light raking through the tank). */
export const ART_TINT_DUSK: ArtTint = { r: 1, g: 0.78, b: 0.6 };

/** Bioluminescent Night: a cold, dimmed teal wash (moon /
 *  phosphor light) — visibly darker AND bluer than dusk. */
export const ART_TINT_NIGHT: ArtTint = { r: 0.55, g: 0.78, b: 1 };

/** The three-phase art-tint table, keyed by palette name:
 *  LIGHT_DAY is null = the identity pass-through (no bake); dusk
 *  and night carry their multiplicative washes. */
export const PHASE_TINTS: Record<LightPalette["name"], ArtTint | null> = {
  LIGHT_DAY: null,
  LIGHT_DUSK: ART_TINT_DUSK,
  LIGHT_NIGHT: ART_TINT_NIGHT,
};

/** The minimal surface contract bakeTintVariant needs (a browser
 *  HTML canvas — or its 2d context — satisfies it; the unit suite
 *  satisfies it with an in-memory fake, so the tint math is proven
 *  without a browser). */
export interface BakeSurface extends SizedSource {
  getContext(kind: "2d"): BakeContext2D | null;
}
export interface BakeContext2D {
  drawImage(source: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
  putImageData(image: { data: Uint8ClampedArray }, x: number, y: number): void;
}
export type SurfaceFactory<S extends BakeSurface = BakeSurface> = (width: number, height: number) => S | null;

/** The surfaces the real runtime bakes onto: an OffscreenCanvas
 *  where available (no DOM needed), else a document canvas — both
 *  are drawable CanvasImageSources, so a baked variant may be used
 *  straight in drawImage. */
export type RealSurface = OffscreenCanvas | HTMLCanvasElement;

/** A drawable that reports its own size in px (an ImageBitmap, or
 *  a canvas baked as a phase variant — both qualify, VideoFrame
 *  does not). The frame's art table and every texture slot take
 *  this, never the bare CanvasImageSource union. */
export interface SizedSource {
  width: number;
  height: number;
}
export type ArtTexture = CanvasImageSource & SizedSource;

/** The real-runtime surface factory (see RealSurface); null when
 *  neither exists (headless) — the slot keeps its neutral art. */
export function defaultSurfaceFactory(width: number, height: number): RealSurface | null {
  try {
    if (typeof OffscreenCanvas === "function") {
      return new OffscreenCanvas(width, height);
    }
    if (typeof document !== "undefined" && typeof document.createElement === "function") {
      return document.createElement("canvas");
    }
  } catch {
    // A hostile/unsupported surface facility degrades the SAME
    // way an absent one does: no bake, neutral art, no crash.
  }
  return null;
}

/** Bake ONE phase copy of a decoded bitmap: the bitmap is drawn
 *  onto a fresh same-size surface, every RGB channel is
 *  multiplied by the phase tint (alpha is NEVER touched — the
 *  tint must not punch or fill the sprite's transparent parts),
 *  and the surface comes back as the phase variant. Returns null
 *  (the caller keeps the neutral bitmap) when the bitmap or the
 *  surface facility cannot be produced — degradation, not failure. */
export function bakeTintVariant<S extends BakeSurface>(
  bitmap: ArtTexture,
  tint: ArtTint,
  makeSurface: SurfaceFactory<S>,
): S | null {
  const w = bitmap.width;
  const h = bitmap.height;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const surface = makeSurface(w, h);
  if (surface === null) return null;
  const ctx = surface.getContext("2d");
  if (ctx === null) return null;
  try {
    ctx.drawImage(bitmap, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.round(d[i]! * tint.r);
      d[i + 1] = Math.round(d[i + 1]! * tint.g);
      d[i + 2] = Math.round(d[i + 2]! * tint.b);
      // d[i + 3] (alpha) deliberately untouched — see the module
      // header for why a naive multiply composite is wrong.
    }
    ctx.putImageData(img, 0, 0);
    return surface;
  } catch {
    return null; // missing 2d facilities: slot keeps the neutral art
  }
}
