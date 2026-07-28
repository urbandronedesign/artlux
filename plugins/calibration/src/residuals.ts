// How well a calibration explains the scan it came from: reproject every dense correspondence with
// the solved intrinsics + pose and measure how far it lands from where the projector actually put it.
//
// This lived inside the wizard's heatmap canvas effect, which meant the only way to see it was to
// LOOK at it — there was no number anywhere in the app, and nothing headless could ask "is this solve
// better than the one it would replace?". That question is the entire basis of an unattended
// recalibration that is allowed to apply its result, so the maths has to be callable without a DOM.
//
// Pure (cvCamera.reproject is pure math, no three.js), so it unit-tests in plain node.

import type { ProjectorCalibration } from '../../../shared/protocol';
import { reproject } from './cvCamera';

export interface ResidualStats {
  /** Correspondences that reprojected at all (a point behind the projector cannot). */
  n: number;
  /** Of the input points, how many were skipped — a large share means the pose is badly wrong. */
  skipped: number;
  rms: number;   // px
  p95: number;   // px — the number that actually predicts a visible error; rms hides a bad corner
  max: number;   // px
}

export interface Residuals {
  stats: ResidualStats;
  /** Per-point error in projector px, index-aligned with denseMap.proj pairs. NaN where skipped. */
  perPoint: Float32Array;
}

export function computeResiduals(
  denseMap: { proj: number[]; world: number[] },
  cal: ProjectorCalibration,
): Residuals {
  const n = Math.floor(denseMap.proj.length / 2);
  const perPoint = new Float32Array(n);
  const errs: number[] = [];
  let skipped = 0;
  for (let i = 0; i < n; i++) {
    const X: [number, number, number] = [denseMap.world[i * 3], denseMap.world[i * 3 + 1], denseMap.world[i * 3 + 2]];
    const rp = reproject(cal.intrinsics, cal.distortion, cal.rotation, cal.translation as [number, number, number], X);
    if (!rp) { perPoint[i] = NaN; skipped++; continue; }
    const du = rp[0] - denseMap.proj[i * 2], dv = rp[1] - denseMap.proj[i * 2 + 1];
    const e = Math.hypot(du, dv);
    perPoint[i] = e;
    errs.push(e);
  }
  if (!errs.length) return { stats: { n: 0, skipped, rms: Infinity, p95: Infinity, max: Infinity }, perPoint };
  let sq = 0, max = 0;
  for (const e of errs) { sq += e * e; if (e > max) max = e; }
  const sorted = [...errs].sort((a, b) => a - b);
  return {
    stats: {
      n: errs.length,
      skipped,
      rms: Math.sqrt(sq / errs.length),
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      max,
    },
    perPoint,
  };
}
