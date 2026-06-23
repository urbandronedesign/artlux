import type { CornerPin, BezierWarp, WarpGrid } from '../../../shared/protocol';
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
