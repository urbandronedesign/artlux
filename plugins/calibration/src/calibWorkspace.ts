// Calibration pose-pairing orchestration — moved out of App (Stage 2d).
//
// This is the event-driven glue between three things the operator drives during a pose capture: the
// projector crosshair (arrives over the projector→main back-channel, fed in by plugin.renderer's
// onMessage tap), a model pick on the embedded 3D venue view (App forwards its onCalibPick here), and
// the solver. It holds no React state — purely module-level refs + host-services writes (via calibHost)
// — so it lives cleanly in the plugin.
//
// Stage 2b (2026-07-23): it now also owns the WORKSPACE STATE that App used to hold — which output is
// being calibrated, the flow, 3D pick mode, and the markerless anchors. App kept those as six useStates
// purely because there was nowhere else to put a Stage-coupled workspace; the `calib` workspace context
// is that place. App now only SUBSCRIBES, to feed the embedded 3D its pick props. The camera preview is
// no longer portaled into a div over the Stage: the wizard is the context's viewport and renders it.
//
// Board/manual flow: the projector shows a crosshair → the operator clicks the matching point on the
// 3D model → we pair (world, latest crosshair pixel) into posePicks and, at ≥4, solvePnP. There is
// deliberately NO confirm gesture: in pose mode every 3D click is a pick action already, so aiming IS
// arming — a separate Enter step was pure friction (removed 2026-07-31 on operator request).
// Markerless (Auto-Align) flow: its wizard registers a pick handler that takes precedence, so a model
// click feeds camera-image↔model correspondences instead of board pose.

import type { ProjectorCalibration } from '../../../shared/protocol';
import * as calibNative from './calibNative';
import { storeCalibration, getCalibration } from './calibHost';

let latestCrosshair: [number, number] | null = null;
let markerlessPick: ((world: [number, number, number], source?: string) => void) | null = null;
let markerlessSelect: ((i: number) => void) | null = null;
let calibratingId: string | null = null; // the output whose board pose is being captured

// ── Workspace state (was App's useStates) ───────────────────────────────────────────────────────
// A tiny pub/sub singleton in the cueBus/helpBus idiom. Read it with useCalibWorkspace() in plugin UI;
// App subscribes to feed the embedded 3D its calibPickMode / activePicks / selectedPick.
export interface CalibWorkspaceState {
  /** Surface id being calibrated, or null when no session is open. */
  target: string | null;
  flow: 'board' | 'auto' | 'manual';
  /** The embedded 3D is in pick mode (a click places a correspondence, not a selection). */
  pickMode: boolean;
  /** Markerless anchor world points, mirrored for the 3D markers. */
  picks: [number, number, number][];
  /** Which correspondence is being edited (highlighted in 3D). */
  selectedPick: number | null;
  // Armed one-shot edits on a pose pick (manual/board flow). ARMED, NEVER IMPLIED — same doctrine as
  // the markerless replaceArmed: selection happens as a side effect of ordinary clicks, so selection
  // alone must never make the next click MOVE a point. In state (not module refs) because the wizard
  // renders the armed banner from it.
  /** Next 3D model pick REPLACES this pick's world point instead of creating a pair. */
  editWorld: number | null;
  /** Next crosshair confirm (Enter on the projector) REPLACES this pick's pixel. */
  editPixel: number | null;
  /** Manual flow: re-estimate the lens (focal) from the picks on every solve, so the operator can
   *  calibrate without knowing the throw ratio at all. Off = the entered lens is locked. */
  lensAuto: boolean;
}
const IDLE: CalibWorkspaceState = { target: null, flow: 'board', pickMode: false, picks: [], selectedPick: null, editWorld: null, editPixel: null, lensAuto: true };
let state: CalibWorkspaceState = IDLE;
const subs = new Set<() => void>();
function emit(patch: Partial<CalibWorkspaceState>): void {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}

export function getState(): CalibWorkspaceState { return state; }
export function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }

/** Open a calibration session on an output (the Outputs table's Calibrate button). */
export function begin(surfaceId: string): void { calibratingId = surfaceId; emit({ ...IDLE, target: surfaceId }); }
/** Close it and drop every derived bit — the reset the old App closeCalib() did by hand. */
export function close(): void { calibratingId = null; reset(); emit(IDLE); }
export function setFlow(flow: 'board' | 'auto' | 'manual'): void { emit({ flow }); }
export function setPickMode(on: boolean): void { emit({ pickMode: on }); }
export function setPicks(picks: [number, number, number][]): void { emit({ picks }); }
export function setSelectedPick(i: number | null): void { emit({ selectedPick: i }); }

// Arm an edit. Mutually exclusive — an operator edits one half of one pair at a time. editWorld is a
// one-shot (the next model click consumes it); editPixel is LIVE (the pick follows the crosshair
// until released — see onCrosshair) and is released by the wizard's Done/Cancel, a selection change,
// or Enter on the projector.
export function armEditWorld(i: number | null): void { emit({ editWorld: i, editPixel: null }); }
export function armEditPixel(i: number | null): void { emit({ editWorld: null, editPixel: i }); }
export function setLensAuto(on: boolean): void { emit({ lensAuto: on }); }

// App sets which output the pose pairing targets (its `calibratingOutputId`), null when the panel closes.
export function setTarget(surfaceId: string | null): void { calibratingId = surfaceId; }

// Projector→main back-channel (from plugin.renderer's host.projectors.onMessage tap).
export function onCrosshair(pixel: [number, number]): void {
  latestCrosshair = pixel;
  // Live re-aim: while a pick's pixel is armed for editing, the crosshair IS that pixel — it follows
  // every move and the pose re-solves (throttled: solving is cheap, but each store re-renders the
  // wizard and re-pushes the projector overlay, and pointermove arrives at display rate). The guard
  // re-checks the arm at fire time: a trailing update must not move a point the operator released.
  if (state.editPixel != null && calibratingId) {
    const i = state.editPixel;
    throttledPixel(calibratingId, i, pixel, () => state.editPixel === i);
  }
}
// Enter on the projector: releases a live re-aim (commit what the crosshair shows now). With no
// armed edit it is a no-op — pairing needs no confirmation, the 3D model click IS the gesture.
export function onConfirm(): void {
  if (state.editPixel != null) {
    const i = state.editPixel;
    emit({ editPixel: null });
    if (calibratingId && latestCrosshair) updatePick(calibratingId, i, { pixel: latestCrosshair });
  }
}

// A placed point dragged DIRECTLY — grabbed on the projection itself or on the wizard's raster map.
// No arm, no guard: grabbing the point IS the consent, and the trailing update after release is the
// final position the operator dropped it at.
export function onPointDrag(index: number, pixel: [number, number]): void {
  if (!calibratingId) return;
  throttledPixel(calibratingId, index, pixel);
}

// A pick's 3D marker dragged across the venue mesh (vertex-snapped world position streams in from
// the 3D view's snap-hover channel at frame rate).
export function movePickWorld(index: number, world: [number, number, number]): void {
  const sid = calibratingId;
  if (!sid) return;
  worldArgs = { sid, i: index, world };
  if (worldTimer) return;
  worldTimer = window.setTimeout(() => {
    worldTimer = 0;
    const a = worldArgs; worldArgs = null;
    if (a) updatePick(a.sid, a.i, { world: a.world });
  }, 120);
}
let worldTimer = 0;
let worldArgs: { sid: string; i: number; world: [number, number, number] } | null = null;

let pixTimer = 0;
let pixArgs: { sid: string; i: number; pixel: [number, number]; guard?: () => boolean } | null = null;
function throttledPixel(sid: string, i: number, pixel: [number, number], guard?: () => boolean): void {
  pixArgs = { sid, i, pixel, guard };
  if (pixTimer) return;
  pixTimer = window.setTimeout(() => {
    pixTimer = 0;
    const a = pixArgs; pixArgs = null;
    if (a && (!a.guard || a.guard())) updatePick(a.sid, a.i, { pixel: a.pixel });
  }, 150);
}

/** Replace one half of an existing correspondence and re-solve from the full set. */
export function updatePick(surfaceId: string, index: number, patch: Partial<{ world: [number, number, number]; pixel: [number, number] }>): void {
  const cal = getCalibration(surfaceId);
  const picks = cal?.posePicks ?? [];
  if (index >= picks.length) return;
  const next = picks.map((p, i) => (i === index ? { ...p, ...patch } : p));
  storeCalibration(surfaceId, { posePicks: next });
  if (next.length >= 4) void solvePose(surfaceId, next);
}

// Live crosshair position, for the manual wizard's raster map. A getter, not state: the crosshair
// moves at pointer rate on the projector, and pushing that through emit() would re-render the whole
// wizard per mousemove — the raster map polls it in a rAF instead (the SnapCursor idiom).
export function getLatestCrosshair(): [number, number] | null { return latestCrosshair; }

// The markerless wizard registers/clears its own pick + select handlers (was App refs via props).
export function registerMarkerlessPick(cb: ((world: [number, number, number], source?: string) => void) | null): void { markerlessPick = cb; }
export function registerMarkerlessSelect(cb: ((i: number) => void) | null): void { markerlessSelect = cb; }
export function selectPick(i: number): void { markerlessSelect?.(i); } // 3D marker click → select in the wizard

// A model pick from the embedded 3D view. Markerless takes precedence when its wizard step is active;
// otherwise pair with the CURRENT projector crosshair pixel → pose correspondence.
export function pick(world: [number, number, number], source?: string): void {
  if (markerlessPick) { markerlessPick(world, source); return; }
  const sid = calibratingId;
  if (!sid) return;
  // Armed move: this model click re-places an existing pick's 3D point. One shot.
  if (state.editWorld != null) {
    const i = state.editWorld;
    emit({ editWorld: null });
    updatePick(sid, i, { world });
    return;
  }
  if (state.editPixel != null) return; // a live re-aim is running — a model click is not a new pair
  const pixel = latestCrosshair;
  if (!pixel) return; // the crosshair has never been aimed on the projector
  const cal = getCalibration(sid);
  if (!cal) return;
  // An unmoved crosshair means this model click is almost certainly a stray (two world points cannot
  // share a projector pixel) — dropping it beats poisoning the solve with a degenerate pair.
  const last = cal.posePicks?.[cal.posePicks.length - 1];
  if (last && last.pixel[0] === pixel[0] && last.pixel[1] === pixel[1]) return;
  const picks = [...(cal.posePicks ?? []), { world, pixel }];
  storeCalibration(sid, { posePicks: picks });
  if (picks.length >= 4) void solvePose(sid, picks);
}

// Hand-placed picks carry click error; from 6 points RANSAC can afford to vote one outlier down
// (at 4–5 every point is load-bearing, so it degenerates to the iterative solve). Fall back to the
// plain solve if RANSAC finds no consensus — a bad pose the operator can SEE beats a silent no-op.
async function bestPose(obj: number[], img: number[], k: number[], dist: number[], n: number) {
  return (n >= 6 ? await calibNative.calibSolvePnpRansac(obj, img, k, dist, 3.0) : null)
    ?? await calibNative.calibSolvePnp(obj, img, k, dist);
}

export async function solvePose(surfaceId: string, picks: NonNullable<ProjectorCalibration['posePicks']>): Promise<void> {
  const cal = getCalibration(surfaceId);
  if (!cal) return;
  const n = picks.length;
  const obj = picks.flatMap((p) => p.world);
  const img = picks.flatMap((p) => p.pixel);
  const dist = cal.distortion ?? [0, 0, 0, 0, 0];

  // AUTO-LENS (manual flow): the operator should not need to KNOW the throw ratio — PnP absorbs a
  // wrong focal into distance, so instead of asking them to measure and iterate, re-estimate the
  // focal from the picks themselves on every solve (single-view calibrateCamera seeded with the
  // current K; principal point + aspect held — one view cannot constrain them). VALIDATED, never
  // blind: the joint solve is ill-conditioned when the points lack depth spread, so the refined lens
  // is adopted only if its focal is a physically plausible throw ratio AND it fits the picks at
  // least as well as the current lens; otherwise the entered lens silently stands (and the wizard
  // shows which one is in play). Never touches a board-measured lens.
  if (state.flow === 'manual' && state.lensAuto && cal.intrinsicsSource !== 'board' && n >= 6 && cal.imageSize[0] > 0) {
    const [w, h] = cal.imageSize;
    const guided = await calibNative.calibCalibrateGuided(obj, img, [n], w, h, cal.intrinsics, true, true);
    const tr = guided ? guided.k[0] / w : 0;
    if (guided && tr >= 0.2 && tr <= 6) {
      // Single-view distortion estimates are noise — keep the focal, drop the distortion.
      const refined = await bestPose(obj, img, guided.k, [0, 0, 0, 0, 0], n);
      const fixed = await bestPose(obj, img, cal.intrinsics, dist, n);
      if (refined && (!fixed || refined.rms <= fixed.rms + 0.01)) {
        storeCalibration(surfaceId, {
          intrinsics: guided.k, distortion: [0, 0, 0, 0, 0], intrinsicsRms: guided.rms, intrinsicsSource: 'refined',
          rotation: refined.rotation, translation: refined.translation, poseRms: refined.rms,
        });
        return;
      }
      if (fixed) { storeCalibration(surfaceId, { rotation: fixed.rotation, translation: fixed.translation, poseRms: fixed.rms }); return; }
    }
  }

  const res = await bestPose(obj, img, cal.intrinsics, dist, n);
  if (!res) return;
  storeCalibration(surfaceId, { rotation: res.rotation, translation: res.translation, poseRms: res.rms });
}

// Remove ONE correspondence (the manual wizard's per-point delete): re-solve from what remains, or —
// below the 4-point minimum — drop the pose entirely rather than keep showing a solve the current
// picks can no longer justify.
export function removePick(surfaceId: string, index: number): void {
  const cal = getCalibration(surfaceId);
  if (!cal) return;
  // Removal renumbers everything after it — an armed edit would land on the wrong point.
  emit({ editWorld: null, editPixel: null });
  const picks = (cal.posePicks ?? []).filter((_, i) => i !== index);
  if (picks.length >= 4) {
    storeCalibration(surfaceId, { posePicks: picks });
    void solvePose(surfaceId, picks);
  } else {
    storeCalibration(surfaceId, { posePicks: picks, poseRms: undefined, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] });
  }
}

// Wizard leaving/entering the pose step: drop the stale crosshair + any armed edit.
export function poseModeChange(on: boolean): void {
  if (!on) {
    latestCrosshair = null;
    if (state.editWorld != null || state.editPixel != null) emit({ editWorld: null, editPixel: null });
  }
}

export function clearPoses(surfaceId: string): void {
  emit({ editWorld: null, editPixel: null });
  storeCalibration(surfaceId, { posePicks: [], poseRms: undefined, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] });
}

// Full teardown when the calibration panel closes (mirrors App's former closeCalib ref resets).
export function reset(): void {
  latestCrosshair = null; markerlessPick = null; markerlessSelect = null; calibratingId = null;
}
