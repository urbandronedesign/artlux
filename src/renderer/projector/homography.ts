import type { CornerPin } from '../../../shared/protocol';

// Perspective-correct corner-pin without a general matrix solve. For a convex quad, the
// projective `q` (homogeneous w) at each vertex is fixed by the diagonals' intersection:
// passing (u·q, v·q, q) as the texcoord and dividing by q in the fragment shader yields
// true perspective interpolation (no diagonal seam, unlike naive affine triangles).
// See Heckbert / the classic OpenGL "perspective texture mapping" trick.

type P = [number, number];

// Intersection point of line (a→b) with line (c→d); null if (near-)parallel.
function intersect(a: P, b: P, c: P, d: P): P | null {
  const r: P = [b[0] - a[0], b[1] - a[1]];
  const s: P = [d[0] - c[0], d[1] - c[1]];
  const denom = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / denom;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}

const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Per-vertex q for [tl, tr, br, bl]. Falls back to all-1 (affine) for degenerate quads.
export function cornerQs(c: CornerPin): [number, number, number, number] {
  const center = intersect(c.tl, c.br, c.tr, c.bl); // the two diagonals
  if (!center) return [1, 1, 1, 1];
  const dTl = dist(c.tl, center), dBr = dist(c.br, center);
  const dTr = dist(c.tr, center), dBl = dist(c.bl, center);
  const qTl = dBr > 1e-9 ? (dTl + dBr) / dBr : 1;
  const qBr = dTl > 1e-9 ? (dBr + dTl) / dTl : 1;
  const qTr = dBl > 1e-9 ? (dTr + dBl) / dBl : 1;
  const qBl = dTr > 1e-9 ? (dBl + dTr) / dTr : 1;
  return [qTl, qTr, qBr, qBl];
}

// Convert a normalized display-space corner (0..1, origin top-left) to WebGL clip space.
export const toClip = (p: P): P => [p[0] * 2 - 1, 1 - p[1] * 2];

// Row-major 3x3 [a,b,c, d,e,f, g,h,i].
export type Mat3 = [number, number, number, number, number, number, number, number, number];

// Heckbert square→quad: the projective map sending the unit-square corners
// (0,0)(1,0)(1,1)(0,1) to the corner-pin quad (tl,tr,br,bl). Same transform the GL q-trick
// applies, so a grid mapped with this lines up exactly with the warped content.
export function squareToQuad(c: CornerPin): Mat3 {
  const [x0, y0] = c.tl, [x1, y1] = c.tr, [x2, y2] = c.br, [x3, y3] = c.bl;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
    return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1]; // affine
  }
  const den = dx1 * dy2 - dy1 * dx2;
  const g = (dx3 * dy2 - dy3 * dx2) / den;
  const h = (dx1 * dy3 - dy1 * dx3) / den;
  return [
    x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
    y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
    g, h, 1,
  ];
}

// Map a source-square point (u,v in 0..1) through the homography → normalized display point.
export function applyH(m: Mat3, u: number, v: number): P {
  const X = m[0] * u + m[1] * v + m[2];
  const Y = m[3] * u + m[4] * v + m[5];
  const W = m[6] * u + m[7] * v + m[8];
  return [X / W, Y / W];
}
