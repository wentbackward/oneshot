// ================================================================
// Minimal deterministic PNG codec (ticket #137): the encoder
// writes 8-bit RGBA (colour type 6), no ancillary chunks, filter 0
// per scanline — the exact profile the placeholder generator
// (scripts/generate-placeholders.mjs) emits. The decoder accepts
// 8-bit colour types 2 (RGB) and 6 (RGBA), un-interlaced, with
// adaptive filters 0–4, so it can also audit externally sourced
// final art the same way the integrity suite checks placeholders.
//
// Pure node:zlib — no native image libraries. Same inputs always
// produce the same bytes on a given toolchain, which is what the
// "stable sorted manifest order, reproducible base64" clause of the
// asset contract rests on.
// ================================================================
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------- CRC-32 (PNG chunk checksum) ----------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.alloc(12 + data.length);
  body.writeUInt32BE(data.length, 0);
  body.write(type, 4, "ascii");
  data.copy(body, 8);
  body.writeUInt32BE(crc32(body.subarray(4, 8 + data.length)), 8 + data.length);
  return body;
}

// ---------- encoder ----------

/** Encode RGBA pixels (Uint8Array, width*height*4) as an 8-bit
 *  RGBA PNG. Throws on malformed input. */
export function encodePng({ width, height, rgba }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodePng: invalid dimensions ${width}x${height}`);
  }
  const stride = width * 4;
  if (rgba.length !== stride * height) {
    throw new Error(`encodePng: rgba buffer is ${rgba.length} bytes, expected ${stride * height}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolor with alpha
  // compression / filter / interlace = 0,0,0 (already zeroed)
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- decoder ----------

/** Decode an 8-bit, un-interlaced, colour-type 2 or 6 PNG.
 *  Returns { width, height, rgba } with a fully-expanded RGBA
 *  buffer (RGB inputs gain alpha 255). Throws a descriptive
 *  Error on any violation (truncated, wrong signature,
 *  unsupported profile, checksum failure). */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("decodePng: not a PNG (signature mismatch)");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const storedCrc = buf.readUInt32BE(dataEnd);
    if (crc32(buf.subarray(offset + 4, dataEnd)) !== storedCrc) {
      throw new Error(`decodePng: CRC mismatch in ${type} chunk`);
    }
    if (type === "IHDR") {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colourType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
      if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6) || interlace !== 0) {
        throw new Error(`decodePng: unsupported profile (depth ${bitDepth}, type ${colourType}, interlace ${interlace})`);
      }
      if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
        throw new Error(`decodePng: implausible dimensions ${width}x${height}`);
      }
    } else if (type === "IDAT") {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    // ancillary chunks (tEXt, tRNS, gAMA, ...): intentionally skipped
    offset = dataEnd + 4;
  }
  if (width === 0 || height === 0 || idat.length === 0) {
    throw new Error("decodePng: IHDR/IDAT missing or incomplete");
  }
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    throw new Error("decodePng: IDAT payload failed to inflate");
  }
  if (raw.length < (stride + 1) * height) {
    throw new Error(`decodePng: raw scanlines short (${raw.length} < ${(stride + 1) * height})`);
  }
  const rgba = new Uint8Array(width * height * 4);
  let line = Buffer.alloc(stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const cur = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    unfilter(filter, cur, prev, line, width, channels);
    for (let x = 0; x < width; x += 1) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      rgba[di] = line[si];
      rgba[di + 1] = line[si + 1];
      rgba[di + 2] = line[si + 2];
      rgba[di + 3] = channels === 4 ? line[si + 3] : 255;
    }
    const tmp = prev;
    prev = line;
    line = tmp;
  }
  return { width, height, rgba };
}

function unfilter(filter, cur, prev, out, width, channels) {
  if (filter === 0) {
    cur.copy(out);
    return;
  }
  for (let i = 0; i < cur.length; i += 1) {
    const a = i >= channels ? out[i - channels] : 0; // left
    const b = prev[i]; // up
    const c = i >= channels ? prev[i - channels] : 0; // upper-left
    let v = cur[i];
    switch (filter) {
      case 1: v += a; break; // Sub
      case 2: v += b; break; // Up
      case 3: v += (a + b) >> 1; break; // Average
      case 4: v += paeth(a, b, c); break; // Paeth
      default: throw new Error(`decodePng: unknown filter ${filter}`);
    }
    out[i] = v & 0xff;
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
