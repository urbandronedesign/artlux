// Gray-code structured-light patterns for projector calibration. The bit layout here MUST match the
// decode in native/calib/src/lib.rs (map_corners_to_projector): planes are emitted as (pattern,
// inverse) PAIRS — column-coding bits first (MSB→LSB), then row-coding bits — and the projector pixel
// is reconstructed by reading the per-bit (pattern > inverse) comparison MSB-first, then Gray→binary.
//
// The projector window renders plane `p` for its own raster via planeBit(); the main window only needs
// the plane count (graycodeLayout) to drive the capture sequence. Plus an all-white and all-black
// reference frame for the per-pixel contrast mask. Keep this file dependency-free + unit-testable.

export interface GraycodeLayout {
  nColBits: number;  // bits to code a projector column (x)
  nRowBits: number;  // bits to code a projector row (y)
  planeCount: number; // coded planes = 2*(nColBits+nRowBits) (pattern+inverse per bit)
}

// Smallest bit count whose power-of-two range covers n (matches Rust bits_for).
export function bitsFor(n: number): number {
  let b = 0, v = 1;
  while (v < n) { v <<= 1; b++; }
  return Math.max(b, 1);
}

// Binary-reflected Gray code of x.
export function grayCode(x: number): number {
  return x ^ (x >>> 1);
}

export function graycodeLayout(projW: number, projH: number): GraycodeLayout {
  const nColBits = bitsFor(projW);
  const nRowBits = bitsFor(projH);
  return { nColBits, nRowBits, planeCount: 2 * (nColBits + nRowBits) };
}

// Bit value (0/1) to display at projector pixel (x,y) for coded plane index p in [0, planeCount).
// Even p = pattern, odd p = its inverse; first 2*nColBits planes code the column (x), the rest the
// row (y); within each, plane pair index 0 is the MSB (matches the MSB-first decode in Rust).
export function planeBit(layout: GraycodeLayout, p: number, x: number, y: number): 0 | 1 {
  const { nColBits, nRowBits } = layout;
  let bitPos: number, g: number, inverse: boolean;
  if (p < 2 * nColBits) {
    const b = p >> 1;                       // which column bit (0 = MSB)
    inverse = (p & 1) === 1;
    g = grayCode(x);
    bitPos = nColBits - 1 - b;
  } else {
    const pr = p - 2 * nColBits;
    const b = pr >> 1;                       // which row bit (0 = MSB)
    inverse = (pr & 1) === 1;
    g = grayCode(y);
    bitPos = nRowBits - 1 - b;
  }
  const bit = (g >>> bitPos) & 1;
  return (inverse ? (1 - bit) : bit) as 0 | 1;
}

// Special pattern indices on the bridge (outside the coded-plane range): all-white / all-black
// reference frames for the contrast mask, 'off' to clear the projector to black between poses, and
// 'fill' for an arbitrary flat RGB field (camera-based gamma/colour measurement — a level ramp).
// 'dots' draws a sparse set of filled discs at given projector pixels — the nightly drift check.
// A full Gray-code scan is ~42 frames plus a settle each; projecting the stored probe points and
// measuring where the camera sees them is ~6 frames and answers the only question a health check
// asks: has this projector moved? See driftCheck.ts.
export type CalibPatternKind = 'plane' | 'white' | 'black' | 'off' | 'fill' | 'dots';

/** Disc radius in projector px. Big enough to survive a mid-range camera, small enough to centroid. */
export const DOT_RADIUS = 6;

// Render coded plane `p` (or a flat white/black/level field) into an RGBA ImageData-sized
// Uint8ClampedArray for a projW×projH buffer. For 'fill', `rgb` (0..255 per channel) is the flat level.
// Column planes are vertical stripes (one value per x, repeated down rows) and row planes are
// horizontal stripes (one value per y), so we compute a 1-D LUT and broadcast it — O(W·H) writes but
// only O(W) or O(H) bit evaluations.
export function fillPattern(
  out: Uint8ClampedArray, projW: number, projH: number, kind: CalibPatternKind, p: number,
  rgb?: [number, number, number], dots?: [number, number][],
): void {
  if (kind === 'dots') {
    out.fill(0);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    const [r, g, b] = rgb ?? [255, 255, 255];
    const rad = DOT_RADIUS, r2 = rad * rad;
    for (const [cx, cy] of dots ?? []) {
      const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(projW - 1, Math.ceil(cx + rad));
      const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(projH - 1, Math.ceil(cy + rad));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx, dy = y - cy;
          if (dx * dx + dy * dy > r2) continue;
          const o = (y * projW + x) * 4;
          out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
        }
      }
    }
    return;
  }
  if (kind === 'fill') {
    const [r, g, b] = rgb ?? [255, 255, 255];
    for (let i = 0; i < out.length; i += 4) { out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255; }
    return;
  }
  if (kind === 'white' || kind === 'black') {
    out.fill(kind === 'white' ? 255 : 0);
    // keep alpha at 255
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return;
  }
  if (kind === 'off') { out.fill(0); for (let i = 3; i < out.length; i += 4) out[i] = 255; return; }

  const layout = graycodeLayout(projW, projH);
  const isColumn = p < 2 * layout.nColBits;
  if (isColumn) {
    const lut = new Uint8Array(projW);
    for (let x = 0; x < projW; x++) lut[x] = planeBit(layout, p, x, 0) ? 255 : 0;
    for (let y = 0; y < projH; y++) {
      let o = y * projW * 4;
      for (let x = 0; x < projW; x++, o += 4) { const v = lut[x]; out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255; }
    }
  } else {
    for (let y = 0; y < projH; y++) {
      const v = planeBit(layout, p, 0, y) ? 255 : 0;
      let o = y * projW * 4;
      for (let x = 0; x < projW; x++, o += 4) { out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255; }
    }
  }
}
