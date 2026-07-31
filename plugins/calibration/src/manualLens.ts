// Manual-lens math for the board-free calibration flow.
//
// The projector is a pinhole camera whose K normally comes from structured light. When the operator
// has no board/camera, K can be built analytically from two numbers every projector spec sheet
// publishes: the throw ratio (throw distance ÷ image width) and the lens shift. That K is exact in
// focal by construction (fx = TR·W is the definition of throw ratio in pixels) and approximate in
// principal point — which solvePnP mostly absorbs into tilt, so the picked points still land; the
// optional refine step (calibrateCamera over the picks, manual K as seed) recovers the rest.

import type { ProjectorCalibration } from '../../../shared/protocol';

/** Analytic K from spec-sheet optics. shiftH/shiftV are fractions of raster w/h (0 = centered;
 *  shiftV = +0.5 → optical axis on the bottom edge, the common fully-up-shifted fixed lens). */
export function manualK(throwRatio: number, shiftH: number, shiftV: number, w: number, h: number): number[] {
  const f = throwRatio * w; // square pixels → fy = fx
  return [f, 0, w * (0.5 + shiftH), 0, f, h * (0.5 + shiftV), 0, 0, 1];
}

/** The spec-sheet numbers a K implies — shows what a refine changed, in operator units. */
export function lensFromK(k: number[], w: number, h: number): { throwRatio: number; shiftH: number; shiftV: number } {
  return { throwRatio: k[0] / w, shiftH: k[2] / w - 0.5, shiftV: k[5] / h - 0.5 };
}

/** Per-pick reprojection error (px) under the full OpenCV model (radial + tangential), same math the
 *  native RMS uses — surfaced per point so the operator can spot THE one bad anchor instead of
 *  re-picking everything. Empty when the pose has not solved yet. */
export function reprojectionErrors(
  cal: Pick<ProjectorCalibration, 'intrinsics' | 'distortion' | 'rotation' | 'translation'>,
  picks: Array<{ world: [number, number, number]; pixel: [number, number] }>,
): number[] {
  const K = cal.intrinsics, R = cal.rotation, t = cal.translation;
  const [k1, k2, p1, p2, k3] = cal.distortion ?? [0, 0, 0, 0, 0];
  return picks.map(({ world: [X, Y, Z], pixel: [u, v] }) => {
    const xc = R[0] * X + R[1] * Y + R[2] * Z + t[0];
    const yc = R[3] * X + R[4] * Y + R[5] * Z + t[1];
    const zc = R[6] * X + R[7] * Y + R[8] * Z + t[2];
    if (zc <= 1e-9) return Infinity; // behind the lens — a pick that cannot be projected
    const x = xc / zc, y = yc / zc;
    const r2 = x * x + y * y;
    const rad = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
    const xd = x * rad + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
    const yd = y * rad + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
    const pu = K[0] * xd + K[2], pv = K[4] * yd + K[5];
    return Math.hypot(pu - u, pv - v);
  });
}
