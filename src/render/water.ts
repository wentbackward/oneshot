// ================================================================
// Procedural water (render, PRD §3 scaffold subset): the aquarium
// backdrop is a PURE function of the world clock — depth gradient,
// drifting caustic light shafts, surface ripples and rising bubbles.
// Stateless and allocation-free: an identical world time paints an
// identical frame, which is what makes fixed-step physics tests
// reproducible.
// ================================================================

const WATER_SURFACE = "#8fd8ea";
const WATER_DEPTH = "#0a2c45";

const CAUSTIC_SHAFTS = 5;
const CAUSTIC_BASE_ALPHA = 0.055;
const CAUSTIC_PULSE_ALPHA = 0.03;
const CAUSTIC_DRIFT = 0.06; // shaft-top drift, fraction of width
const CAUSTIC_SPEED = 0.35; // rad/s of drift and pulse

const SURFACE_RIPPLES = 3;
const RIPPLE_AMPLITUDE = 6; // px
const RIPPLE_SPEED = 1.4; // rad/s
const RIPPLE_STEP = 16; // px between path samples

const BUBBLES = 12;
const BUBBLE_MARGIN = 12; // px above top / below bottom of the column

/** Deterministic pseudo-random in [0,1) for one bubble's lane, size,
 *  speed and phase — same index, same bubble, every frame. */
function hash(unit: number, salt: number): number {
  const v = Math.sin(unit * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/** Paint the full water backdrop for world time t. */
export function drawWater(ctx: CanvasRenderingContext2D, width: number, height: number, t: number): void {
  drawBackdrop(ctx, width, height);
  drawCausticShafts(ctx, width, height, t);
  drawSurfaceRipples(ctx, width, t);
  drawBubbles(ctx, width, height, t);
}

function drawBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, WATER_SURFACE);
  grad.addColorStop(1, WATER_DEPTH);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
}

function drawCausticShafts(ctx: CanvasRenderingContext2D, width: number, height: number, t: number): void {
  for (let i = 0; i < CAUSTIC_SHAFTS; i++) {
    const sway = Math.sin(t * CAUSTIC_SPEED + i * 1.9) * CAUSTIC_DRIFT * width;
    const alpha = CAUSTIC_BASE_ALPHA + CAUSTIC_PULSE_ALPHA * Math.sin(t * CAUSTIC_SPEED * 1.7 + i * 2.6);
    const centerX = width * ((i + 0.5) / CAUSTIC_SHAFTS);
    const topX = centerX + sway * 0.4;
    const botX = centerX + sway + width * 0.1;
    ctx.beginPath();
    ctx.moveTo(topX - width * 0.03, 0);
    ctx.lineTo(topX + width * 0.03, 0);
    ctx.lineTo(botX + width * 0.09, height);
    ctx.lineTo(botX - width * 0.09, height);
    ctx.closePath();
    ctx.fillStyle = `rgba(220, 245, 255, ${alpha.toFixed(4)})`;
    ctx.fill();
  }
}

function drawSurfaceRipples(ctx: CanvasRenderingContext2D, width: number, t: number): void {
  ctx.lineWidth = 1.5;
  for (let j = 0; j < SURFACE_RIPPLES; j++) {
    const yBase = 14 + j * 9;
    const alpha = 0.25 - j * 0.06;
    ctx.beginPath();
    for (let x = 0; x <= width; x += RIPPLE_STEP) {
      const y = yBase + Math.sin(x * 0.02 + t * RIPPLE_SPEED + j * 1.3) * RIPPLE_AMPLITUDE;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(230, 250, 255, ${alpha.toFixed(3)})`;
    ctx.stroke();
  }
}

function drawBubbles(ctx: CanvasRenderingContext2D, width: number, height: number, t: number): void {
  ctx.lineWidth = 1;
  const column = height + BUBBLE_MARGIN * 2;
  ctx.strokeStyle = "rgba(230, 250, 255, 0.35)";
  for (let i = 0; i < BUBBLES; i++) {
    const xBase = width * (0.04 + 0.92 * hash(i, 1));
    const speed = 36 + 64 * hash(i, 2); // px/s
    const radius = 1.5 + 3.5 * hash(i, 3); // px
    const lag = hash(i, 4) * column; // stagger along the column
    const wobble = Math.sin(t * (1.2 + hash(i, 5) * 1.6) + i * 2.1) * 5;
    const y = height + BUBBLE_MARGIN - ((t * speed + lag) % column);
    ctx.beginPath();
    ctx.arc(xBase + wobble, y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}
