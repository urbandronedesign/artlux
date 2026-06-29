// Camera mask for the markerless scan (VIOSO-style camera masking). The operator paints exclusion
// polygons over reflective hotspots / obstructions / out-of-screen regions in camera space; those
// camera pixels are then dropped from the Gray-code decode.
//
// Rather than thread a mask parameter through the native ABI, we exploit the decode's existing
// rejection path: decode_dense / map_corners already skip any camera pixel whose white−black contrast
// is below a threshold (lib.rs). Forcing white[i] = black[i] = 0 inside the mask makes those pixels
// fail that same gate, so they vanish from both the dense map and the board mapping — no native change.
//
// Pure functions (no three.js / DOM), unit-testable in plain node like blendCompute.ts / nvwarpApply.ts.

import type { CamMask } from '../../../shared/protocol';
export type { CamMask };

// Even-odd point-in-polygon test (ray casting). `poly` is a closed ring (first≠last is fine).
function inPoly(px: number, py: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const intersects = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// True if (px,py) falls inside any of the mask's exclusion polygons.
export function masked(mask: CamMask, px: number, py: number): boolean {
  for (const poly of mask.polys) if (poly.length >= 3 && inPoly(px, py, poly)) return true;
  return false;
}

// Zero the white/black contrast references for masked camera pixels (in place), so the decode's
// contrast gate drops them. `white`/`black` are row-major w×h single-channel buffers (the same ones
// captureGrayCode returns). A null/empty mask is a no-op. Returns the count of pixels masked.
export function applyCamMask(white: Uint8Array, black: Uint8Array, w: number, h: number, mask: CamMask | null | undefined): number {
  if (!mask || !mask.polys.length) return 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!masked(mask, x, y)) continue;
      const i = y * w + x;
      white[i] = 0; black[i] = 0;
      n++;
    }
  }
  return n;
}
