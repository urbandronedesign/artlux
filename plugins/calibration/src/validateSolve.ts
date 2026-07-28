// May this solve replace the one currently running the show?
//
// The single most dangerous function in the unattended path, so it is pure, exhaustively table-
// testable, and biased hard toward REFUSING. In a permanent venue at 4am there is nobody to notice a
// bad apply, nobody to undo it, no undo history in show mode and no crash-recovery file. Known drift
// is a far better outcome than a confident wrong answer.
//
// The governing insight: A LOW RESIDUAL IS NOT EVIDENCE OF A CORRECT SOLVE. Every check below exists
// because some failure mode produces a beautifully self-consistent calibration of the wrong thing.
// The worst of them is a bad camera anchor — one mis-registered marker, or a marker someone knocked —
// which yields a projector pose that is metrically excellent with respect to a world that is wrong.
// That is why an implausible POSE JUMP rejects regardless of how good the numbers look.

import type { ProjectorCalibration, AutoRecalConfig } from '../../../shared/protocol';
import type { MarkerlessResult } from './markerlessController';
import type { DriftScore } from './driftCheck';

export type RejectReason =
  | 'data-starved'          // the scan decoded too little to trust
  | 'bad-camera-anchor'     // the reference frame itself is suspect
  | 'bad-solve'             // residuals above the wizard's own quality bar
  | 'implausible-pose-jump' // projectors are bolted; this means the anchor is wrong
  | 'implausible-optics'    // the lens did not change overnight
  | 'selfcal-runaway'
  | 'coverage-loss'         // a solve of half the screen must not win
  | 'not-better';           // it is valid, just not an improvement worth churning for

export interface SolveReport {
  decoded: number;
  hits: number;
  hitRate: number;
  cameraPoseRms: number;
  intrinsicsRms: number;
  poseRms: number;
  poseJumpM: number;
  poseRotDeg: number;
  focalChangePct: number;
  candidateMm: number;
  incumbentMm: number;
}

export type Verdict =
  | { accept: true; report: SolveReport }
  | { accept: false; reason: RejectReason; detail: string; report: SolveReport };

// Camera centre in world coordinates from a world→camera [R|t]: C = -Rᵀ t.
export function opticalCentre(rotation: number[], translation: number[]): [number, number, number] {
  const R = rotation, t = translation;
  return [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
}

// Geodesic angle between two rotations: acos((trace(RaᵀRb) − 1) / 2).
export function rotationDeltaDeg(a: number[], b: number[]): number {
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tr += a[i * 3 + j] * b[i * 3 + j];
  const c = Math.min(1, Math.max(-1, (tr - 1) / 2));
  return (Math.acos(c) * 180) / Math.PI;
}

export function validateSolve(
  candidate: MarkerlessResult,
  incumbent: ProjectorCalibration | null,
  scores: { candidate: DriftScore; incumbent: DriftScore },
  cfg: AutoRecalConfig,
  nominalCameraFx?: number,
): Verdict {
  const c = candidate.calibration;
  const hitRate = candidate.decoded > 0 ? candidate.hits / candidate.decoded : 0;
  const centreNew = opticalCentre(c.rotation, c.translation);
  const centreOld = incumbent ? opticalCentre(incumbent.rotation, incumbent.translation) : centreNew;
  const poseJumpM = Math.hypot(centreNew[0] - centreOld[0], centreNew[1] - centreOld[1], centreNew[2] - centreOld[2]);
  const poseRotDeg = incumbent ? rotationDeltaDeg(c.rotation, incumbent.rotation) : 0;
  const fxNew = c.intrinsics[0], fxOld = incumbent?.intrinsics[0] ?? fxNew;
  const focalChangePct = fxOld > 0 ? Math.abs(fxNew / fxOld - 1) * 100 : 0;

  const report: SolveReport = {
    decoded: candidate.decoded, hits: candidate.hits, hitRate,
    cameraPoseRms: candidate.cameraPoseRms,
    intrinsicsRms: c.intrinsicsRms ?? Infinity,
    poseRms: c.poseRms ?? Infinity,
    poseJumpM, poseRotDeg, focalChangePct,
    candidateMm: scores.candidate.rmsMm, incumbentMm: scores.incumbent.rmsMm,
  };
  const no = (reason: RejectReason, detail: string): Verdict => ({ accept: false, reason, detail, report });

  // ── Is there enough evidence to have solved anything? ──
  // The wizard's own floors are 50 decoded / 30 hits, which is right for "a human is watching and can
  // see the result on the wall" and far too low for "overwrite the show unattended".
  if (candidate.decoded < cfg.minDecoded) return no('data-starved', `only ${candidate.decoded} decoded (need ${cfg.minDecoded})`);
  if (candidate.hits < cfg.minHits) return no('data-starved', `only ${candidate.hits} rays hit the venue (need ${cfg.minHits})`);
  if (hitRate < 0.5) return no('data-starved', `only ${(hitRate * 100).toFixed(0)}% of decoded points hit the model`);

  // ── Is the frame of reference itself sound? Everything downstream inherits this. ──
  if (!(candidate.cameraPoseRms <= 2)) return no('bad-camera-anchor', `camera pose RMS ${candidate.cameraPoseRms.toFixed(2)}px (max 2)`);

  // ── Is the solve internally good? (Necessary, nowhere near sufficient.) ──
  if (!((c.poseRms ?? Infinity) <= 3)) return no('bad-solve', `projector pose RMS ${(c.poseRms ?? Infinity).toFixed(2)}px (max 3)`);
  if (!((c.intrinsicsRms ?? Infinity) <= 2)) return no('bad-solve', `lens RMS ${(c.intrinsicsRms ?? Infinity).toFixed(2)}px (max 2)`);

  // ── Is it PLAUSIBLE? These are the checks that catch a confident wrong answer. ──
  if (incumbent) {
    if (poseJumpM > cfg.maxPoseJumpM) {
      return no('implausible-pose-jump',
        `projector appears to have moved ${(poseJumpM * 100).toFixed(0)}cm (max ${(cfg.maxPoseJumpM * 100).toFixed(0)}cm) — ` +
        `a bolted projector did not; far more likely the camera anchor is wrong`);
    }
    if (poseRotDeg > cfg.maxPoseJumpDeg) {
      return no('implausible-pose-jump', `projector appears to have rotated ${poseRotDeg.toFixed(1)}° (max ${cfg.maxPoseJumpDeg}°)`);
    }
    if (focalChangePct > cfg.maxFocalChangePct) {
      return no('implausible-optics', `focal length changed ${focalChangePct.toFixed(1)}% (max ${cfg.maxFocalChangePct}%) — the lens did not`);
    }
  }
  const fy = c.intrinsics[4];
  if (fy > 0 && Math.abs(fxNew / fy - 1) > 0.02) {
    return no('implausible-optics', `fx/fy differ by ${(Math.abs(fxNew / fy - 1) * 100).toFixed(1)}% — projector pixels are square`);
  }
  const throwRatio = fxNew / Math.max(1, c.imageSize[0]);
  if (!(throwRatio >= 0.3 && throwRatio <= 4)) {
    return no('implausible-optics', `implied throw ratio ${throwRatio.toFixed(2)} is outside 0.3–4`);
  }
  if (candidate.selfCal?.ok && nominalCameraFx && nominalCameraFx > 0) {
    const d = Math.abs(candidate.cameraK[0] / nominalCameraFx - 1) * 100;
    if (d > 15) return no('selfcal-runaway', `self-cal moved the camera focal ${d.toFixed(0)}% off the stored profile`);
  }

  // ── Did it actually see the whole screen? A solve of half the surface must never win. ──
  if (scores.incumbent.expected > 0) {
    const cov = scores.candidate.matched / scores.incumbent.expected;
    if (cov < 0.7) return no('coverage-loss', `only ${(cov * 100).toFixed(0)}% of the reference probes were seen — partial occlusion?`);
  }

  // ── Finally: is it BETTER? With hysteresis, so nightly noise never churns a good calibration. ──
  const better = scores.candidate.rmsMm < scores.incumbent.rmsMm * cfg.improveFactor;
  const incumbentBroken = scores.incumbent.rmsMm > cfg.driftWarnMm;
  if (!better && !incumbentBroken) {
    return no('not-better',
      `${scores.candidate.rmsMm.toFixed(1)}mm vs incumbent ${scores.incumbent.rmsMm.toFixed(1)}mm — ` +
      `not a ${((1 - cfg.improveFactor) * 100).toFixed(0)}% improvement, so nothing changes`);
  }
  return { accept: true, report };
}
