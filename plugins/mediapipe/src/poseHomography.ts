// Image→floor planar homography for the pose floor calibration.
//
// A floor is a plane, so mapping a webcam image point to a real floor coordinate is an exact 3x3
// projective transform fixed by 4 point correspondences — no camera intrinsics/lens solve needed. We
// reuse the host's closed-form `squareToQuad` (Heckbert) + `applyH` from the projector corner-pin util
// and compose image-quad→world-quad as:  H = squareToQuad(world) · squareToQuad(image)⁻¹.
// The 3x3 inverse + multiply don't exist elsewhere in the repo, so they're added here (small + pure).

import { squareToQuad, applyH, type Mat3 } from '@/projector/homography'; // transitional @/ seam (pure util)
import type { CornerPin } from '../../../shared/protocol';

export type { Mat3 };
export { applyH };

// Adjugate/determinant inverse of a row-major 3x3. Returns the identity if (near-)singular so a
// degenerate calibration can't produce NaNs downstream (the caller just sees an unhelpful mapping).
export function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const inv = 1 / det;
  return [
    A * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    B * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    C * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
}

// Row-major 3x3 · 3x3.
export function multiply(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9) as number[];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      r[row * 3 + col] = a[row * 3] * b[col] + a[row * 3 + 1] * b[col + 3] + a[row * 3 + 2] * b[col + 6];
    }
  }
  return r as Mat3;
}

// The homography mapping an image quad (normalized [u,v]) to a world quad (metres). The two quads use
// different coordinate systems; that's fine — the perspective divide in applyH handles the scale. Both
// quads must be given in the SAME logical corner order ({tl,tr,br,bl}) so corners correspond.
export function imageToWorld(imageQuad: CornerPin, worldQuad: CornerPin): Mat3 {
  return multiply(squareToQuad(worldQuad), invert(squareToQuad(imageQuad)));
}
