import { defaultCornerPin, type CornerPin, type BezierWarp, type WarpGrid } from '../../../shared/protocol';
import { squareToQuad, applyH } from './homography';

type P = [number, number];

// Cubic Bernstein basis at t.
function bern3(t: number): [number, number, number, number] {
  const it = 1 - t;
  return [it * it * it, 3 * it * it * t, 3 * it * t * t, t * t * t];
}

// Build a flat Bézier control net from a corner-pin: sample the homography at the cubic
// parameter grid {0, 1/3, 2/3, 1}² so a fresh patch reproduces the corner-pin (corners exact).
export function makeBezierWarp(pin: CornerPin): BezierWarp {
  const m = squareToQuad(pin);
  const points: P[] = [];
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) points.push(applyH(m, i / 3, j / 3));
  }
  return { points };
}

// Evaluate the bicubic patch at (u,v) ∈ [0,1]² (u along columns i, v along rows j).
export function evalBezier(w: BezierWarp, u: number, v: number): P {
  const bu = bern3(u), bv = bern3(v);
  let x = 0, y = 0;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const wij = bv[j] * bu[i];
      const p = w.points[j * 4 + i];
      x += wij * p[0]; y += wij * p[1];
    }
  }
  return [x, y];
}

// Tessellate the patch into an n×n render mesh (normalized display points on a regular UV grid).
export function tessellateBezier(w: BezierWarp, n: number): WarpGrid {
  const points: P[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) points.push(evalBezier(w, i / n, j / n));
  }
  return { cols: n, rows: n, points };
}

// The four patch corners in the 4×4 control net (top-left, top-right, bottom-right, bottom-left).
export const BEZIER_CORNERS = [0, 3, 15, 12];

// Normalized display space, so this is ~0.02 px on a 1920-wide raster — finer than a drag can
// express, and far finer than anything an operator could see on a wall.
const WARP_EPS = 1e-4;
const CORNER_KEYS = ['tl', 'tr', 'br', 'bl'] as const;
// Built once: the control net a corner-pin-to-Bézier conversion produces when nothing has been moved.
const IDENTITY_NET = makeBezierWarp(defaultCornerPin());

// Does this output carry a residual warp worth running the GL stage for?
//
// A CALIBRATED output draws its picture through the 3D scene, so the warp stage is pure ADDED cost
// there — a full-resolution canvas→texture upload plus the mesh pass, per frame, per projector. This
// predicate is the whole safety property of that path: it keeps an un-nudged output on the original
// zero-cost early-return, pixel-identical and cost-identical to before the feature existed.
//
// So it must answer FALSE for anything that resolves to the unit square, not merely for `warp == null`
// — converting a corner-pin into a Bézier net without dragging a handle yields a non-null, perfectly
// identity, net, and treating that as "warped" would silently put every converted output on the
// expensive path for no visible change.
export function hasResidualWarp(pin: CornerPin | null | undefined, warp: BezierWarp | null | undefined): boolean {
  // A Bézier net supersedes the corner-pin wherever one exists (same precedence as ProjectorGL).
  if (warp) {
    return warp.points.some((p, i) => {
      const q = IDENTITY_NET.points[i];
      return !q || Math.abs(p[0] - q[0]) > WARP_EPS || Math.abs(p[1] - q[1]) > WARP_EPS;
    });
  }
  if (!pin) return false;
  const d = defaultCornerPin();
  return CORNER_KEYS.some((k) => Math.abs(pin[k][0] - d[k][0]) > WARP_EPS || Math.abs(pin[k][1] - d[k][1]) > WARP_EPS);
}
