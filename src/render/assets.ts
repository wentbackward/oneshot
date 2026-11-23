// ================================================================
// Embedded image assets (ticket #137, asset contract in
// docs/DECISIONS.md). The build (scripts/build-fishtank.mjs) prints
// a deterministic base64 payload — window.__FISHTANK_ASSETS__, in
// stable sorted manifest order — into the page shell AHEAD of this
// bundle. The boot decodes every entry to an ImageBitmap ONCE,
// before the first frame, into a cached table the renderer reads
// per frame via plain drawImage calls: zero per-frame decodes and
// zero per-frame allocations (the 60 fps rule applies to textures
// exactly as to procedural paint).
//
// Degradation is by construction, never a crash path:
//   - no decoder (headless vm suites import/boot this bundle):
//     decodeAllAssets() settles SYNCHRONOUSLY, the loop starts
//     immediately and every texture draw is skipped;
//   - a payload entry whose base64 or decode fails is dropped from
//     the cache and the frame still renders (procedural fallback
//     for that slot).
// ================================================================

/** One manifest entry as shipped inside the page-shell payload
 *  (fixed key order from scripts/lib/assets.mjs). */
export interface EmbeddedAssetEntry {
  /** Slot name (manifest `name`), e.g. "bg", "gravel-tile". */
  name: string;
  /** Intrinsic width in px. */
  w: number;
  /** Intrinsic height in px. */
  h: number;
  /** Frames per row for sheets; 1 for single-image slots. */
  frames: number;
  /** 1 while the slot holds placeholder art (data-only swap flag). */
  ph: number;
  /** Base64 of the committed PNG file. */
  d: string;
}

export type BitmapDecoder = (source: Blob | ArrayBuffer) => Promise<ImageBitmap>;

const PAYLOAD_GLOBAL = "__FISHTANK_ASSETS__";

/** The payload the build injected ahead of this bundle. Under
 *  stock node (the erasable-import test imports every module
 *  directly) the global is absent and the table is simply empty. */
export const EMBEDDED_ASSETS: readonly EmbeddedAssetEntry[] = (() => {
  // The build assigns the payload to window (the browser global);
  // under stock node there is no window and the table is simply
  // empty. Read from the SAME carrier the build writes to — in the
  // vm boots, window and globalThis are distinct objects.
  const carrier: Record<string, unknown> =
    typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : (globalThis as Record<string, unknown>);
  const raw: unknown = carrier[PAYLOAD_GLOBAL];
  return Array.isArray(raw) ? (raw as EmbeddedAssetEntry[]) : [];
})();

/** base64 → raw bytes on a dedicated ArrayBuffer (so a Blob can
 *  wrap the view losslessly), or null when the payload entry is
 *  undecodable (dropped from the cache, frame still renders). */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64);
    const ab = new ArrayBuffer(bin.length);
    const bytes = new Uint8Array(ab);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Decode every embedded asset into `cache` exactly once. When
 *  the payload is empty or no decoder exists, onSettled() runs
 *  SYNCHRONOUSLY (the headless-boot contract); otherwise it runs
 *  after the last decode has settled — success OR failure — so the
 *  loop can never hang on a broken entry.
 *
 *  Source handed to the decoder: a Blob, which is what real
 *  browsers' createImageBitmap actually accepts (Chrome rejects
 *  raw ArrayBuffers); where no Blob constructor exists (headless
 *  vm boots) the raw buffer goes through as-is. */
export function decodeAllAssets(cache: Record<string, ImageBitmap>, onSettled: () => void): void {
  const decoder: unknown = (globalThis as Record<string, unknown>).createImageBitmap;
  if (EMBEDDED_ASSETS.length === 0 || typeof decoder !== "function" || typeof atob !== "function") {
    onSettled();
    return;
  }
  const decode = decoder as BitmapDecoder;
  let pending = EMBEDDED_ASSETS.length;
  const settle = (): void => {
    pending -= 1;
    if (pending === 0) onSettled();
  };
  for (const entry of EMBEDDED_ASSETS) {
    const bytes = base64ToBytes(entry.d);
    if (bytes === null) {
      settle();
      continue;
    }
    const source: Blob | ArrayBuffer =
      typeof Blob !== "undefined" ? new Blob([bytes]) : (bytes.buffer as ArrayBuffer);
    try {
      decode(source)
        .then((bitmap: ImageBitmap) => {
          cache[entry.name] = bitmap;
        })
        .catch(() => {
          // One bad entry loses its slot only; the frame still
          // renders without it.
        })
        .then(settle);
    } catch {
      // A synchronous throw (hostile/absent decoder) drops the
      // entry instead of killing the boot.
      settle();
    }
  }
}
