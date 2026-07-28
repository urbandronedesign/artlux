// The unattended recalibration run: the thing that happens at 4am with nobody in the building.
//
// SEQUENCE, and the order is the design:
//   1. Refuse unless every precondition holds (window, no wizard open, venue meshes, camera profile).
//   2. Re-anchor the CAMERA from the ArUco marker map. It is mounted but bumpable, so it is never an
//      absolute reference — its pose is re-derived every run before it is used to judge anything.
//   3. Cheap drift check per projector (~5 s of dots, not a 42-plane scan).
//   4. Only if drift warrants it, a full re-solve — then score candidate AND incumbent against the
//      same fresh evidence, so the comparison is like-for-like.
//   5. validateSolve decides. Conservative by construction; a rejection is the normal outcome.
//   6. Apply as ONE state transaction plus exactly one save, keeping the old calibration for rollback.
//
// A gross fault (a knocked projector, an occlusion) alerts and does NOT auto-solve: a projector aimed
// at the floor still solves "successfully", with a low RMS, and the result is garbage.

import type {
  AutoRecalConfig, CalibReference, ProjectorCalibration, ProjectorOutput, CalibCameraProfile,
} from '../../../shared/protocol';
import { defaultAutoRecalConfig } from '../../../shared/protocol';
import * as calibWorkspace from './calibWorkspace';
import * as slCapture from './slCapture';
import * as cam from './calibCapture';
import * as calibNative from './calibNative';
import * as blendController from './blendController';
import * as venueRegistrar from './venueRegistrar';
import { getHost, sendToProjector, getRig, patchRig, getScene, saveProject } from './calibHost';
import { camPicksFromAruco, anchorQuality, solveCameraPose, solveGeometry, defaultMarkerlessConfig } from './markerlessController';
import { runDriftCheck, type DriftScore, EMPTY_SCORE } from './driftCheck';
import { pickProbes } from './driftScore';
import { validateSolve, type Verdict } from './validateSolve';
import { computeResiduals } from './residuals';
import type { MarkerlessResult } from './markerlessController';
import { hasVenueMeshes } from './venueRaycast';

export type RunOutcome =
  | 'ok'            // nothing needed changing, or a change was applied
  | 'kept-old'      // a candidate was solved and refused
  | 'aborted'       // a precondition failed — the run never really started
  | 'gross-fault';  // something is physically wrong; a human is needed

export interface SurfaceResult {
  surfaceId: string;
  outcome: RunOutcome;
  detail: string;
  drift?: DriftScore;
  verdict?: Verdict;
}

export interface RunReport {
  startedAt: string;
  finishedAt: string;
  cameraAnchorRms: number | null;
  results: SurfaceResult[];
  aborted?: string;
}

type Log = (line: string) => void;
let running = false;

export const isRunning = (): boolean => running;

const cfgOf = (): AutoRecalConfig => ({ ...defaultAutoRecalConfig(), ...(getRig().autoRecal ?? {}) });

// "HH:MM" window, inclusive, and it wraps past midnight (03:30–05:30 does not, but 23:00–01:00 does).
export function insideWindow(now: Date, w?: { start: string; end: string }): boolean {
  if (!w) return true;
  const mins = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const t = now.getHours() * 60 + now.getMinutes();
  const a = mins(w.start), b = mins(w.end);
  return a <= b ? t >= a && t <= b : t >= a || t <= b;
}

// ── Step 2: the camera is re-derived, never trusted ────────────────────────────────────────────
export interface CameraAnchor {
  camK: number[]; camDist: number[];
  rotation: number[]; translation: [number, number, number];
  rms: number;
  /** The picks that produced it — reused by a full re-solve so detection is not repeated. */
  picks: ReturnType<typeof camPicksFromAruco>;
}

async function anchorCamera(profile: CalibCameraProfile, cfg: AutoRecalConfig, log: Log): Promise<CameraAnchor | { error: string }> {
  const map = getScene().markerMap;
  if (!map?.markers.length) return { error: 'no marker map — the camera has no absolute reference' };

  // Markers need light. At 4am in a dark venue an unlit ArUco tag is invisible, so put a dim flat
  // field up first; `checkLevel` keeps it courteous rather than blasting the room white.
  await slCapture.projectField([cfg.checkLevel, cfg.checkLevel, cfg.checkLevel]);
  await new Promise((r) => setTimeout(r, 250));

  const g = await cam.grab();
  if (!g) return { error: 'no camera frame' };
  const det = await calibNative.calibDetectAruco(g.data.buffer as ArrayBuffer, g.w, g.h, map.dict ?? 0);
  if (!det) return { error: 'ArUco detection unavailable' };

  const q = anchorQuality(det, map);
  // A pose from ONE centre-only marker is four rays through a single point: formally ≥4 picks,
  // geometrically rank-deficient. Tolerable with a human watching; not as the sole reference here.
  if (q.distinctPoints < 4) {
    return { error: `only ${q.distinctPoints} distinct 3D reference points visible (need ≥4) — register markers with corners` };
  }
  const picks = camPicksFromAruco(det, map);
  const pose = await solveCameraPose(picks, profile.cameraK, profile.cameraDist);
  if ('error' in pose) return { error: `camera pose: ${pose.error}` };
  if (pose.rms > 2) return { error: `camera anchor RMS ${pose.rms.toFixed(2)}px (max 2)` };
  log(`camera anchored: ${q.markers} markers, ${q.distinctPoints} points, RMS ${pose.rms.toFixed(2)}px`);
  return {
    camK: profile.cameraK, camDist: profile.cameraDist,
    rotation: pose.rotation, translation: pose.translation, rms: pose.rms, picks,
  };
}

const referenceFor = (surfaceId: string): CalibReference | undefined =>
  getRig().references?.find((r) => r.surfaceId === surfaceId);

/** Build a reference from a fresh scan — what an accepted solve stores for tomorrow's check. */
export function referenceFrom(
  surfaceId: string, denseMap: { proj: number[]; world: number[] }, raster: [number, number], baselineMm: number, baselinePx: number,
): CalibReference {
  return {
    surfaceId,
    capturedAt: new Date().toISOString(),
    probes: pickProbes(denseMap, raster),
    baseline: { rmsPx: baselinePx, rmsMm: baselineMm },
  };
}

// A successful wizard scan is the ONLY producer of the two things unattended recalibration needs and
// cannot make for itself: the camera intrinsics that were actually used, and a reference observation
// to measure against. Called from AutoAlignWizard.runScan, so simply calibrating a projector by hand
// commissions it — an operator never has to know this subsystem exists to enable it.
//
// Never overwrites a camera profile's intrinsics with a WORSE source: a self-cal result supersedes a
// nominal FOV guess, but not the other way round.
export function commissionFromScan(surfaceId: string, r: MarkerlessResult): void {
  const rig = getRig();
  const prev = rig.camera;
  const selfCalled = !!r.selfCal?.ok;
  if (r.cameraK.length === 9 && (!prev || prev.cameraK.length !== 9 || selfCalled)) {
    const live = cam.current();
    patchRig({
      camera: {
        source: live?.source ?? prev?.source ?? 'browser',
        index: live?.index ?? prev?.index,
        deviceId: live?.deviceId ?? prev?.deviceId,
        width: live?.w ?? prev?.width ?? 0,
        height: live?.h ?? prev?.height ?? 0,
        fps: live?.fps ?? prev?.fps ?? 30,
        fourcc: live?.fourcc ?? prev?.fourcc,
        props: prev?.props,
        cameraK: r.cameraK,
        cameraDist: prev?.cameraDist ?? [0, 0, 0, 0, 0],
        hfovDeg: prev?.hfovDeg,
      },
    });
  }
  // The reference: probes to re-project nightly, plus how good this calibration was on day zero.
  // Baseline is its OWN reprojection residual — later runs are judged against what it actually
  // achieved, not against an ideal it never reached.
  const res = computeResiduals(r.denseMap, r.calibration);
  storeReference(referenceFrom(surfaceId, r.denseMap, r.calibration.imageSize, 0, res.stats.rms));
}

export interface RunOptions {
  /** 'check' stops after the drift measurement; 'full' may re-solve and (if allowed) apply. */
  mode?: 'check' | 'full';
  surfaceId?: string;
  log?: Log;
  /** Bypass the wall-clock window (an operator pressing the button from the tablet). */
  manual?: boolean;
}

export async function run(opts: RunOptions = {}): Promise<RunReport> {
  const log: Log = opts.log ?? ((l) => console.log(`[recal] ${l}`));
  const startedAt = new Date().toISOString();
  const bail = (reason: string): RunReport => {
    log(`aborted: ${reason}`);
    return { startedAt, finishedAt: new Date().toISOString(), cameraAnchorRms: null, results: [], aborted: reason };
  };

  if (running) return bail('a recalibration is already running');
  const cfg = cfgOf();
  if (!cfg.enabled && !opts.manual) return bail('auto-recalibration is disabled');
  if (!opts.manual && !insideWindow(new Date(), cfg.window)) return bail('outside the maintenance window');
  // slCapture and the camera are module singletons — a run during a wizard session would fight it.
  if (calibWorkspace.getState().target !== null) return bail('a calibration wizard is open');
  if (!hasVenueMeshes()) {
    return bail(venueRegistrar.status().active
      ? 'venue meshes not loaded yet (registrar still working, or the GLB failed to parse)'
      : 'no venue geometry registered — nothing to raycast against');
  }
  const host = getHost();
  const profile = getRig().camera;
  if (!profile) return bail('no camera profile saved — commission the camera first');
  if (profile.cameraK.length !== 9) return bail('camera profile has no intrinsics');

  const targets = ((host?.projectorOutputs.list() ?? []) as ProjectorOutput[])
    .filter((o) => o.enabled && o.calibration?.poseRms != null)
    .filter((o) => !opts.surfaceId || o.surfaceId === opts.surfaceId);
  if (!targets.length) return bail('no calibrated outputs to check');

  running = true;
  const results: SurfaceResult[] = [];
  let anchorRms: number | null = null;
  // The in-flight marker: if this process dies mid-run (watchdog relaunch, power cut), its presence
  // at the next activation is the ONLY evidence a run started and never finished — the project file
  // looks untouched, because the single save never happened.
  await calibNative.calibRecalMark({ mode: opts.mode ?? 'full', targets: targets.map((t) => t.surfaceId) });
  void calibNative.calibAuditAppend({ ts: startedAt, event: 'run-start', mode: opts.mode ?? 'full', manual: !!opts.manual });
  try {
    // Open the camera exactly as commissioned — same device, same mode, auto-everything OFF.
    try {
      await cam.start({
        source: profile.source,
        index: profile.index,
        deviceId: profile.deviceId,
        width: profile.width, height: profile.height, fps: profile.fps, fourcc: profile.fourcc,
      } as Parameters<typeof cam.start>[0]);
    } catch (e) {
      return bail(`camera would not open: ${(e as Error).message}`);
    }
    // start() resolving is not proof of a live feed — OpenCV will happily open a device another app
    // holds and then hand back all-black frames (see docs/CALIBRATION.md). Demand a real frame.
    for (const [k, v] of Object.entries(profile.props ?? {})) await cam.setProp(k, v);
    if (!(await cam.grab())) return bail('camera opened but delivered no frame');

    for (const out of targets) {
      const sid = out.surfaceId;
      const push = (r: SurfaceResult) => {
        results.push(r);
        log(`${sid}: ${r.outcome} — ${r.detail}`);
        void calibNative.calibAuditAppend({
          ts: new Date().toISOString(), event: 'surface', surfaceId: sid,
          outcome: r.outcome, detail: r.detail,
          driftMm: r.drift?.rmsMm ?? null, matched: r.drift?.matched ?? null, expected: r.drift?.expected ?? null,
          reason: r.verdict && 'reason' in r.verdict ? r.verdict.reason : null,
        });
        void report(sid, r);
      };
      const reference = referenceFor(sid);
      if (!reference) { push({ surfaceId: sid, outcome: 'aborted', detail: 'no stored reference — recalibrate once by hand first' }); continue; }

      slCapture.beginScan(sid, (m) => sendToProjector(sid, m));
      try {
        const anchor = await anchorCamera(profile, cfg, log);
        if ('error' in anchor) { push({ surfaceId: sid, outcome: 'aborted', detail: anchor.error }); continue; }
        anchorRms = anchor.rms;

        const drift = await runDriftCheck(reference, out.calibration!, anchor, { level: 255 });
        if ('error' in drift) { push({ surfaceId: sid, outcome: 'aborted', detail: drift.error }); continue; }

        const coverage = drift.expected ? drift.matched / drift.expected : 0;
        if (coverage < 0.6 || drift.rmsMm > cfg.driftFailMm) {
          // The one place where doing nothing is the ACTIVE choice: a projector this far out (or
          // this occluded) will still solve "successfully" and hand back a confident wrong answer.
          push({
            surfaceId: sid, outcome: 'gross-fault', drift,
            detail: `drift ${drift.rmsMm.toFixed(1)}mm, ${drift.matched}/${drift.expected} probes seen — not auto-solving`,
          });
          continue;
        }
        if (drift.rmsMm <= cfg.driftWarnMm) {
          push({ surfaceId: sid, outcome: 'ok', drift, detail: `healthy — drift ${drift.rmsMm.toFixed(1)}mm` });
          continue;
        }
        if (opts.mode === 'check') {
          push({ surfaceId: sid, outcome: 'kept-old', drift, detail: `drift ${drift.rmsMm.toFixed(1)}mm exceeds ${cfg.driftWarnMm}mm — full run needed` });
          continue;
        }

        // ── Full re-solve, judged against the incumbent on the SAME fresh evidence ──
        // Reuses the anchor's picks: the camera has not moved since, and re-detecting would only add
        // a second chance to disagree with the pose everything else in this run is measured against.
        // selfCal stays OFF here — an unattended run must not quietly rewrite the trusted lens.
        log(`${sid}: drift ${drift.rmsMm.toFixed(1)}mm — re-solving`);
        const mk = { ...defaultMarkerlessConfig(), cameraK: profile.cameraK, cameraDist: profile.cameraDist, camMask: getScene().camMask };
        const solved = await solveGeometry(mk, anchor.picks, false);
        if ('error' in solved) { push({ surfaceId: sid, outcome: 'kept-old', drift, detail: `solve failed: ${solved.error}` }); continue; }

        const candScore = await runDriftCheck(
          { ...reference, probes: pickProbes(solved.denseMap, solved.calibration.imageSize) },
          solved.calibration, anchor, { level: 255 },
        );
        const verdict = validateSolve(
          solved, out.calibration ?? null,
          { candidate: 'error' in candScore ? EMPTY_SCORE : candScore, incumbent: drift },
          cfg, profile.cameraK[0],
        );
        if ('reason' in verdict) { // (not !verdict.accept: this repo compiles without `strict`)
          push({ surfaceId: sid, outcome: 'kept-old', drift, verdict, detail: `${verdict.reason}: ${verdict.detail}` });
          continue;
        }
        if (!cfg.autoApply) {
          push({ surfaceId: sid, outcome: 'kept-old', drift, verdict, detail: 'would have applied, but autoApply is off' });
          continue;
        }

        // ── Apply: one state transaction, then exactly one save (see applyAccepted) ──
        await applyAccepted(sid, out.calibration ?? null, solved, candScore as DriftScore, reference);
        push({ surfaceId: sid, outcome: 'ok', drift, verdict, detail: 'new calibration applied and saved' });
      } finally {
        slCapture.endScan();
      }
    }
  } finally {
    running = false;
    try { cam.stop(); } catch { /* already closed */ }
    void calibNative.calibAuditAppend({ ts: new Date().toISOString(), event: 'run-end', results: results.length });
    if (anchorRms != null) {
      void calibNative.calibMetric('artlux_calib_camera_anchor_rms', 'ArUco camera-anchor RMS (px)', {}, anchorRms);
    }
    // The run finished — reached even on an exception, which is the point: the marker must only
    // survive a process that DIED, not one that failed and said so.
    await calibNative.calibRecalClear();
  }
  return { startedAt, finishedAt: new Date().toISOString(), cameraAnchorRms: anchorRms, results };
}

// The alerting surface. `result` is the one an alert rule fires on, and `last_run_ts` is the one that
// catches the failure nobody notices: a maintenance task that quietly stopped running months ago.
const RESULT_CODE: Record<RunOutcome, number> = { ok: 0, 'kept-old': 1, aborted: 2, 'gross-fault': 3 };

async function report(surfaceId: string, r: SurfaceResult): Promise<void> {
  const l = { surface: surfaceId };
  await calibNative.calibMetric('artlux_calib_result', '0 ok, 1 kept-old, 2 aborted, 3 gross-fault', l, RESULT_CODE[r.outcome]);
  await calibNative.calibMetric('artlux_calib_last_run_ts', 'Unix time of the last completed check', l, Date.now() / 1000);
  if (r.drift && Number.isFinite(r.drift.rmsMm)) {
    await calibNative.calibMetric('artlux_calib_drift_mm', 'Measured projection drift on the surface (mm)', l, r.drift.rmsMm);
  }
}

/** On activation: was a previous run killed part-way? Report it once, and do NOT resume. */
export async function reportInterrupted(log: Log = (l) => console.warn(`[recal] ${l}`)): Promise<void> {
  const m = await calibNative.calibRecalTakeInterrupted();
  if (!m) return;
  log(`a previous recalibration was interrupted (started ${String(m.startedAt)}) — not resuming; the next scheduled run starts fresh`);
  void calibNative.calibAuditAppend({ ts: new Date().toISOString(), event: 'interrupted', ...m });
}

// Patch state, refresh the rig blend, then save ONCE. Adjacency matters: a watchdog relaunch between
// the patch and the save reloads the incumbent from disk, which is consistent — only the night's
// result is lost. Two saves, or a save far from the patch, would widen that window for no gain.
async function applyAccepted(
  surfaceId: string,
  previous: ProjectorCalibration | null,
  solved: { calibration: ProjectorCalibration; denseMap: { proj: number[]; world: number[] } },
  score: DriftScore,
  oldRef: CalibReference,
): Promise<void> {
  const host = getHost();
  host?.projectorOutputs.patch(surfaceId, {
    calibrationPrev: previous,
    calibration: { ...solved.calibration, calibratedAt: new Date().toISOString() },
  } as Partial<ProjectorOutput>);

  await blendController.captureScan(surfaceId, solved.calibration.imageSize, solved.denseMap);
  const ref = referenceFrom(surfaceId, solved.denseMap, solved.calibration.imageSize,
    Number.isFinite(score.rmsMm) ? score.rmsMm : oldRef.baseline.rmsMm,
    Number.isFinite(score.rmsPx) ? score.rmsPx : oldRef.baseline.rmsPx);
  storeReference(ref);

  // One projector moving invalidates the whole rig's blend — its share of the overlap changed.
  await blendController.solveRig();
  await saveProject();
}

/** Merge a reference into the rig (replacing any for the same surface). */
export function storeReference(ref: CalibReference): void {
  const cur = getRig();
  patchRig({ references: [...(cur.references ?? []).filter((r) => r.surfaceId !== ref.surfaceId), ref] });
}

/** Undo the last accepted apply for one output — the tablet's "that made it worse" button. */
export async function revertCalibration(surfaceId: string): Promise<boolean> {
  const host = getHost();
  const out = host?.projectorOutputs.get(surfaceId) as ProjectorOutput | undefined;
  if (!out?.calibrationPrev) return false;
  host?.projectorOutputs.patch(surfaceId, {
    calibration: out.calibrationPrev,
    calibrationPrev: out.calibration ?? null,   // swap, so revert is itself revertible
  } as Partial<ProjectorOutput>);
  await saveProject();
  return true;
}
