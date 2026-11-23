#!/usr/bin/env node
// ================================================================
// Placeholder art generator (ticket #137): writes the starter
// asset sets under assets/bricks/ and assets/fishtank/ — flat
// fills and labelled geometry whose ONLY job is to prove the
// embed pipeline and reserve the draw-call slots (visual quality
// is the enhancement tickets' business; final art arrives via
// docs/ASSET-SOURCING.md, human-approved).
//
// Deterministic: a fixed seed per file, node:zlib via
// scripts/lib/png.mjs — re-running on the same toolchain writes
// byte-identical files. Tiles are built from periodic functions
// (or fully-wrapped placement) so the integrity suite's seamless
// seam check passes by construction.
//
// Run: node scripts/generate-placeholders.mjs
// ================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./lib/assets.mjs";
import { encodePng } from "./lib/png.mjs";

// ---------- deterministic rng (fixed seed per file) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 5x7 bitmap font (uppercase + digits + few symbols) ----------
const FONT = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01111, 0b10000, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10010, 0b10001, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  ":": [0b00000, 0b00100, 0b00000, 0b00000, 0b00100, 0b00000, 0b00000],
  "-": [0b00000, 0b00000, 0b00000, 0b01110, 0b00000, 0b00000, 0b00000],
  " ": [0, 0, 0, 0, 0, 0, 0],
};

// ---------- tiny pixel canvas ----------
function makeCanvas(w, h) {
  const buf = new Uint8Array(w * h * 4);
  const cv = {
    w, h, buf,
    get(x, y) {
      const i = (y * w + x) * 4;
      return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
    },
    set(x, y, [r, g, b, a], ifEmpty = false) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      if (ifEmpty && buf[i + 3] > 0) return;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
    },
    rect(x0, y0, x1, y1, color) {
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y += 1) {
        for (let x = Math.max(0, x0); x < Math.min(w, x1); x += 1) cv.set(x, y, color);
      }
    },
    verticalGradient(top, bottom) {
      for (let y = 0; y < h; y += 1) {
        const t = h === 1 ? 0 : y / (h - 1);
        const c = [
          Math.round(top[0] + (bottom[0] - top[0]) * t),
          Math.round(top[1] + (bottom[1] - top[1]) * t),
          Math.round(top[2] + (bottom[2] - top[2]) * t),
          255,
        ];
        cv.rect(0, y, w, y + 1, c);
      }
    },
    ellipse(cx, cy, rx, ry, color, ifEmpty = true) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
          const dx = (x - cx) / rx;
          const dy = (y - cy) / ry;
          if (dx * dx + dy * dy <= 1) cv.set(x, y, color, ifEmpty);
        }
      }
    },
    triangle(ax, ay, bx, by, cx2, cy2, color, ifEmpty = true) {
      const inside = (px, py) => {
        const d1 = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
        const d2 = (px - bx) * (cy2 - by) - (py - by) * (cx2 - bx);
        const d3 = (px - cx2) * (ay - cy2) - (py - cy2) * (ax - cx2);
        const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
        const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
        return !(hasNeg && hasPos);
      };
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx2)));
      const maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx2)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy2)));
      const maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy2)));
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          if (inside(x, y)) cv.set(x, y, color, ifEmpty);
        }
      }
    },
    text(x, y, str, color, scale = 1) {
      let cursor = x;
      for (const ch of str.toUpperCase()) {
        const glyph = FONT[ch];
        if (glyph) {
          for (let gy = 0; gy < 7; gy += 1) {
            for (let gx = 0; gx < 5; gx += 1) {
              if (glyph[gy] & (1 << (4 - gx))) {
                for (let sy = 0; sy < scale; sy += 1) {
                  for (let sx = 0; sx < scale; sx += 1) cv.set(cursor + gx * scale + sx, y + gy * scale + sy, color);
                }
              }
            }
          }
        }
        cursor += 6 * scale;
      }
    },
  };
  return cv;
}

// ---------- asset slots ----------
// Every slot: [name, file, w, h, frames, fw, fh, alpha, tiling,
// category, painter]. frameWidth*frames === w and fh === h.
const LABEL = [214, 235, 120, 255]; // placeholder-amber label ink (fully opaque: labels may sit on opaque slots)
const LICENSE_LINE = "CC0-1.0 (generated in-repo by scripts/generate-placeholders.mjs)";

function drawLabeledPh(cv, label, x = 10, y = 10, scale = 2) {
  cv.text(x, y, `PH: ${label}`, LABEL, scale);
}

const FISH_TANK = [
  {
    name: "bg", file: "bg.png", w: 960, h: 600, frames: 1, fw: 960, fh: 600,
    alpha: "opaque", tiling: false, category: "background",
    paint(cv) {
      cv.verticalGradient([14, 58, 86, 255], [3, 14, 22, 255]);
      // Faint diagonal light shafts (static: the procedural caustics
      // animate above the texture).
      for (let x = 0; x < cv.w; x += 1) {
        for (let y = 0; y < cv.h; y += 1) {
          let v = 0;
          for (const [xc, sig] of [[260, 90], [560, 120], [840, 70]]) {
            const d = x - xc - y * 0.25;
            v = Math.max(v, Math.exp(-(d * d) / (2 * sig * sig)));
          }
          if (v > 0.02) {
            const [r, g, b, a] = cv.get(x, y);
            cv.set(x, y, [Math.min(255, r + 16 * v), Math.min(255, g + 22 * v), Math.min(255, b + 26 * v), a]);
          }
        }
      }
      drawLabeledPh(cv, "BG");
    },
  },
  {
    // Periodic in BOTH axes by construction -> seamless.
    name: "caustics-tile", file: "caustics-tile.png", w: 128, h: 128, frames: 1, fw: 128, fh: 128,
    alpha: "opaque", tiling: true, category: "tile",
    paint(cv) {
      const TAU = Math.PI * 2;
      for (let y = 0; y < cv.h; y += 1) {
        for (let x = 0; x < cv.w; x += 1) {
          const v =
            0.5 + 0.5 * Math.sin(TAU * x / cv.w) * Math.cos(TAU * y / cv.h) +
            0.35 * Math.sin(TAU * (2 * x / cv.w) + TAU * (3 * y / cv.h)) +
            0.25 * Math.sin(TAU * (x / cv.w + y / cv.h) + 1.3);
          const bright = Math.round(26 + 120 * Math.max(0, v));
          cv.set(x, y, [8 + Math.round(bright * 0.35), 30 + Math.round(bright * 0.7), 52 + bright, 255]);
        }
      }
    },
  },
  {
    // Base: periodic two-tone mottling; pebbles: wrapped placement
    // on every edge -> seamless. No label (text would break the wrap).
    name: "gravel-tile", file: "gravel-tile.png", w: 256, h: 96, frames: 1, fw: 256, fh: 96,
    alpha: "opaque", tiling: true, category: "tile",
    paint(cv) {
      const TAU = Math.PI * 2;
      for (let y = 0; y < cv.h; y += 1) {
        for (let x = 0; x < cv.w; x += 1) {
          const v = 0.5 + 0.5 * Math.sin(TAU * x / cv.w + 1.7) * Math.sin(TAU * y / cv.h - 0.4);
          cv.set(x, y, v > 0.62 ? [52, 74, 96, 255] : [43, 61, 80, 255]);
        }
      }
      const rng = mulberry32(13701);
      const tones = [[96, 128, 156, 255], [120, 152, 180, 255], [74, 96, 120, 255]];
      for (let cy2 = 0; cy2 < 3; cy2 += 1) {
        for (let cx2 = 0; cx2 < 4; cx2 += 1) {
          const px = (cx2 + 0.15 + 0.7 * rng()) * (cv.w / 4);
          const py = (cy2 + 0.2 + 0.6 * rng()) * (cv.h / 3);
          const rx = 5 + 6 * rng();
          const ry = 3 + 4 * rng();
          const tone = tones[Math.floor(rng() * tones.length)];
          for (const ox of [-cv.w, 0, cv.w]) {
            for (const oy of [-cv.h, 0, cv.h]) {
              cv.ellipse(px + ox, py + oy, rx, ry, tone, true);
            }
          }
        }
      }
    },
  },
  {
    name: "pebble-1", file: "pebble-1.png", w: 48, h: 32, frames: 1, fw: 48, fh: 32,
    alpha: "alpha", tiling: false, category: "sprite",
    paint(cv) {
      cv.ellipse(24, 22, 20, 10, [96, 120, 142, 235], true);
      cv.ellipse(20, 19, 13, 5, [128, 150, 172, 235], true);
      cv.text(4, 2, "PEBBLE 1", LABEL, 1);
    },
  },
  {
    name: "pebble-2", file: "pebble-2.png", w: 40, h: 28, frames: 1, fw: 40, fh: 28,
    alpha: "alpha", tiling: false, category: "sprite",
    paint(cv) {
      cv.ellipse(20, 19, 17, 8, [70, 92, 112, 235], true);
      cv.ellipse(16, 16, 10, 4, [98, 122, 144, 235], true);
      cv.text(3, 2, "PEBBLE 2", LABEL, 1);
    },
  },
  {
    name: "kelp-strip", file: "kelp-strip.png", w: 96, h: 128, frames: 1, fw: 96, fh: 128,
    alpha: "alpha", tiling: false, category: "texture",
    paint(cv) {
      const TAU = Math.PI * 2;
      const blades = [[8, 0.4, [38, 138, 78, 235]], [20, 2.1, [30, 118, 66, 235]], [32, 4.0, [46, 150, 92, 235]]];
      for (const [bx, phase, color] of blades) {
        for (let y = 0; y < cv.h; y += 1) {
          const sway = 6 * Math.sin(TAU * y / 64 + phase);
          const tx = Math.round(bx + sway * (y / cv.h));
          cv.set(tx, y, color, true);
          if (tx + 1 < cv.w) cv.set(tx + 1, y, color, true);
        }
      }
      cv.text(44, 8, "KELP", LABEL, 1);
    },
  },
  {
    name: "bubble", file: "bubble.png", w: 96, h: 32, frames: 1, fw: 96, fh: 32,
    alpha: "alpha", tiling: false, category: "sprite",
    paint(cv) {
      for (let y = 0; y < cv.h; y += 1) {
        for (let x = 0; x < 32; x += 1) {
          const d = Math.hypot(x - 16, y - 16);
          if (d >= 10.5 && d <= 13.5) cv.set(x, y, [190, 222, 255, 200], true);
          else if (d > 13.5) continue;
          else if (d >= 2 && d <= 4 && x < 12 && y < 12) cv.set(x, y, [255, 255, 255, 220], true);
          else cv.set(x, y, [180, 220, 255, 46], true);
        }
      }
      cv.text(38, 11, "BUBBLE", LABEL, 1);
    },
  },
  {
    name: "tetra-body", file: "tetra-body.png", w: 96, h: 32, frames: 1, fw: 96, fh: 32,
    alpha: "alpha", tiling: false, category: "sprite",
    paint(cv) {
      // Slender body (super-ellipse) + tail; rides the procedural
      // spine in the hybrid the PRD keeps (texture, not animation).
      for (let y = 0; y < cv.h; y += 1) {
        for (let x = 0; x < 80; x += 1) {
          const dx = Math.abs(x - 34) / 24;
          const dy = Math.abs(y - 16) / 8;
          if (Math.pow(dx, 1.6) + Math.pow(dy, 1.6) <= 1) cv.set(x, y, [235, 140, 60, 245], true);
        }
      }
      cv.triangle(56, 16, 72, 5, 72, 27, [212, 112, 40, 245], true);
      cv.ellipse(24, 14, 1.5, 1.5, [20, 20, 28, 255], false);
      cv.text(58, 28, "TETRA", LABEL, 1);
    },
  },
  {
    name: "angel-body", file: "angel-body.png", w: 128, h: 64, frames: 1, fw: 128, fh: 64,
    alpha: "alpha", tiling: false, category: "sprite",
    paint(cv) {
      for (let y = 0; y < cv.h; y += 1) {
        for (let x = 0; x < 76; x += 1) {
          const dx = (x - 38) / 27;
          const dy = (y - 32) / 18;
          if (dx * dx + dy * dy <= 1) cv.set(x, y, [230, 190, 60, 245], true);
        }
      }
      for (const stripe of [22, 34, 46]) {
        cv.rect(stripe, 12, stripe + 4, 52, [64, 52, 20, 245]);
      }
      cv.ellipse(18, 28, 1.5, 1.5, [24, 20, 12, 255], false);
      cv.text(84, 4, "ANGEL", LABEL, 1);
    },
  },
  {
    name: "predator-body", file: "predator-body.png", w: 160, h: 48, frames: 1, fw: 160, fh: 48,
    alpha: "alpha", tiling: false, category: "sprite",
    paint(cv) {
      for (let y = 0; y < cv.h; y += 1) {
        for (let x = 0; x < 112; x += 1) {
          const dx = Math.abs(x - 54) / 46;
          const dy = Math.abs(y - 26) / 11;
          if (Math.pow(dx, 1.5) + Math.pow(dy, 1.5) <= 1) cv.set(x, y, [92, 102, 114, 245], true);
        }
      }
      cv.triangle(40, 16, 52, 2, 64, 16, [76, 84, 96, 245], true); // dorsal fin
      cv.triangle(98, 26, 118, 12, 118, 40, [80, 90, 102, 245], true); // tail
      cv.ellipse(24, 22, 2, 2, [16, 18, 24, 255], false);
      cv.text(118, 4, "PREDATOR", LABEL, 1);
    },
  },
];

const BRICKS = [
  {
    name: "bg", file: "bg.png", w: 960, h: 600, frames: 1, fw: 960, fh: 600,
    alpha: "opaque", tiling: false, category: "background",
    paint(cv) {
      // Vertical-only variation: the brick stage is 960×600 (or the
      // 480×800 alleyway) and a flat vertical pattern stretches to
      // either aspect without visible distortion.
      cv.verticalGradient([26, 34, 46, 255], [10, 14, 20, 255]);
      for (let y = 0; y < cv.h; y += 4) {
        for (let x = 0; x < cv.w; x += 1) {
          const [r, g, b] = cv.get(x, y);
          cv.set(x, y, [r - 6, g - 6, b - 6, 255]); // dark scanline row
        }
      }
      drawLabeledPh(cv, "BG");
    },
  },
  {
    name: "brick-skin-a", file: "brick-skin-a.png", w: 64, h: 24, frames: 1, fw: 64, fh: 24,
    alpha: "opaque", tiling: false, category: "texture",
    paint(cv) {
      cv.rect(0, 0, cv.w, cv.h, [178, 62, 46, 255]);
      cv.rect(0, 0, cv.w, 3, [214, 96, 76, 255]); // top bevel
      cv.rect(0, cv.h - 3, cv.w, cv.h, [120, 36, 28, 255]); // bottom shade
      cv.rect(0, 0, 2, cv.h, [214, 96, 76, 255]);
      cv.rect(cv.w - 2, 0, cv.w, cv.h, [120, 36, 28, 255]);
      cv.text(26, 7, "A", [245, 235, 225, 255], 2);
    },
  },
  {
    name: "brick-skin-b", file: "brick-skin-b.png", w: 64, h: 24, frames: 1, fw: 64, fh: 24,
    alpha: "opaque", tiling: false, category: "texture",
    paint(cv) {
      cv.rect(0, 0, cv.w, cv.h, [58, 112, 152, 255]);
      cv.rect(0, 0, cv.w, 3, [88, 142, 182, 255]);
      cv.rect(0, cv.h - 3, cv.w, cv.h, [34, 74, 104, 255]);
      cv.rect(0, 0, 2, cv.h, [88, 142, 182, 255]);
      cv.rect(cv.w - 2, 0, cv.w, cv.h, [34, 74, 104, 255]);
      cv.text(26, 7, "B", [235, 240, 245, 255], 2);
    },
  },
  {
    name: "paddle", file: "paddle.png", w: 120, h: 14, frames: 1, fw: 120, fh: 14,
    alpha: "opaque", tiling: false, category: "texture",
    paint(cv) {
      cv.rect(0, 0, cv.w, cv.h, [10, 60, 70, 255]); // dark rim fills the whole slot
      cv.rect(2, 2, cv.w - 2, cv.h - 2, [46, 180, 190, 255]);
      cv.rect(2, 2, cv.w - 2, 3, [110, 214, 224, 255]);
      cv.rect(2, cv.h - 4, cv.w - 2, cv.h - 2, [20, 120, 130, 255]);
    },
  },
  {
    name: "ball", file: "ball.png", w: 16, h: 16, frames: 1, fw: 16, fh: 16,
    alpha: "alpha", tiling: false, category: "sprite",
    paint(cv) {
      for (let y = 0; y < cv.h; y += 1) {
        for (let x = 0; x < cv.w; x += 1) {
          const d = Math.hypot(x - 7.5, y - 7.5);
          if (d <= 7) {
            const shade = Math.round(255 - (d / 7) * 55);
            cv.set(x, y, [shade, shade, Math.min(255, shade + 8), 255], true);
          }
        }
      }
    },
  },
  {
    name: "ball-trail", file: "ball-trail.png", w: 16, h: 16, frames: 1, fw: 16, fh: 16,
    alpha: "alpha", tiling: false, category: "sprite",
    paint(cv) {
      for (let y = 0; y < cv.h; y += 1) {
        for (let x = 0; x < cv.w; x += 1) {
          const d = Math.hypot(x - 7.5, y - 7.5);
          if (d < 8) cv.set(x, y, [200, 220, 255, Math.min(255, Math.round(255 * (1 - Math.max(0, d - 0.71) / 7.29)))], true);
        }
      }
    },
  },
  {
    name: "debris-1", file: "debris-1.png", w: 12, h: 12, frames: 1, fw: 12, fh: 12,
    alpha: "alpha", tiling: false, category: "sprite",
    paint(cv) {
      cv.triangle(1, 10, 6, 1, 11, 8, [240, 180, 80, 240], true);
    },
  },
  {
    name: "debris-2", file: "debris-2.png", w: 12, h: 12, frames: 1, fw: 12, fh: 12,
    alpha: "alpha", tiling: false, category: "sprite",
    paint(cv) {
      cv.triangle(2, 2, 11, 4, 8, 11, [230, 90, 70, 240], true);
    },
  },
  {
    name: "powerups", file: "powerups.png", w: 96, h: 16, frames: 6, fw: 16, fh: 16,
    alpha: "alpha", tiling: false, category: "icon-set",
    paint(cv) {
      const icons = [
        ["E", [70, 160, 220]], ["B", [220, 160, 60]], ["S", [150, 110, 220]],
        ["U", [90, 200, 140]], ["M", [220, 90, 120]], ["X", [230, 220, 90]],
      ];
      for (let i = 0; i < 6; i += 1) {
        const [letter, [r, g, b]] = icons[i];
        const ox = i * 16;
        cv.rect(ox + 1, 1, 15, 15, [r, g, b, 235]);
        cv.rect(ox + 2, 2, 13, 1, [255, 255, 255, 90]);
        cv.text(ox + 5, 4, letter, [250, 250, 255, 255], 1);
      }
    },
  },
];

// ---------- emit ----------

const LICENSE_TXT = (game) => [
  `Asset provenance — assets/${game}`,
  "=====================================",
  "All current entries are PLACEHOLDERS generated in-repo by",
  "scripts/generate-placeholders.mjs (deterministic, no external",
  "sources) and dedicated to the public domain (CC0-1.0).",
  "",
  "Final (non-placeholder) art arriving via docs/ASSET-SOURCING.md",
  "adds one attribution line per asset below, mirroring the",
  '`license` field of the manifest entry:',
  "",
  "- (none yet — placeholders only)",
  "",
].join("\n");

function emitGame(game, slots) {
  const dir = path.join(ROOT, "assets", game);
  const entries = [];
  for (const slot of slots) {
    if (slot.fw * slot.frames !== slot.w || slot.fh !== slot.h) {
      throw new Error(`${game}/${slot.name}: slot geometry is inconsistent (fw*frames !== w or fh !== h)`);
    }
    const cv = makeCanvas(slot.w, slot.h);
    slot.paint(cv);
    writeFileSync(path.join(dir, slot.file), encodePng({ width: slot.w, height: slot.h, rgba: cv.buf }));
    entries.push({
      name: slot.name,
      file: slot.file,
      width: slot.w,
      height: slot.h,
      frames: slot.frames,
      frameWidth: slot.fw,
      frameHeight: slot.fh,
      alpha: slot.alpha,
      tiling: slot.tiling,
      category: slot.category,
      placeholder: true,
      license: LICENSE_LINE,
    });
    console.log(`wrote assets/${game}/${slot.file} (${slot.w}×${slot.h}${slot.frames > 1 ? `, ${slot.frames} frames` : ""})`);
  }
  const manifest = { game, entries };
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(path.join(dir, "LICENSE.txt"), LICENSE_TXT(game));
  console.log(`wrote assets/${game}/manifest.json (${entries.length} entries)`);
}

// assets/<game>/ dirs are created with a .gitkeep-free tree (the
// generated files themselves are the content).
for (const [game, slots] of [["bricks", BRICKS], ["fishtank", FISH_TANK]]) {
  // The assets/ tree is committed with the generated files; the
  // dirs are (re)created here so a wiped checkout regenerates.
  mkdirSync(path.join(ROOT, "assets", game), { recursive: true });
  emitGame(game, slots);
}
console.log("done — placeholder sets generated for bricks and fishtank");
