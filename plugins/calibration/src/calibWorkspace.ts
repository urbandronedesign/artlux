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
// Board flow: the projector shows a crosshair → operator confirms (pendingPixel) → operator clicks the
// matching point on the 3D model → we pair (world, pixel) into posePicks and, at ≥4, solvePnP.
// Markerless (Auto-Align) flow: its wizard registers a pick handler that takes precedence, so a model
// click feeds camera-image↔model correspondences instead of board pose.

import type { ProjectorCalibration } from '../../../shared/protocol';
import * as calibNative from './calibNative';
import { storeCalibration, getCalibration } from './calibHost';

let latestCrosshair: [number, number] | null = null;
let pendingPixel: [number, number] | null = null;
let markerlessPick: ((world: [number, number, number]) => void) | null = null;
let markerlessSelect: ((i: number) => void) | null = null;
let calibratingId: string | null = null; // the output whose board pose is being captured

// ── Workspace state (was App's useStates) ───────────────────────────────────────────────────────
// A tiny pub/sub singleton in the cueBus/helpBus idiom. Read it with useCalibWorkspace() in plugin UI;
// App subscribes to feed the embedded 3D its calibPickMode / activePicks / selectedPick.
export interface CalibWorkspaceState {
  /** Surface id being calibrated, or null when no session is open. */
  target: string | null;
  flow: 'board' | 'auto';
  /** The embedded 3D is in pick mode (a click places a correspondence, not a selection). */
  pickMode: boolean;
  /** Markerless anchor world points, mirrored for the 3D markers. */
  picks: [number, number, number][];
  /** Which correspondence is being edited (highlighted in 3D). */
  selectedPick: number | null;
}
const IDLE: CalibWorkspaceState = { target: null, flow: 'board', pickMode: false, picks: [], selectedPick: null };
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
export function setFlow(flow: 'board' | 'auto'): void { emit({ flow }); }
export function setPickMode(on: boolean): void { emit({ pickMode: on }); }
export function setPicks(picks: [number, number, number][]): void { emit({ picks }); }
export function setSelectedPick(i: number | null): void { emit({ selectedPick: i }); }

// App sets which output the pose pairing targets (its `calibratingOutputId`), null when the panel closes.
export function setTarget(surfaceId: string | null): void { calibratingId = surfaceId; }

// Projector→main back-channel (from plugin.renderer's host.projectors.onMessage tap).
export function onCrosshair(pixel: [number, number]): void { latestCrosshair = pixel; }
export function onConfirm(): void { pendingPixel = latestCrosshair; }

// The markerless wizard registers/clears its own pick + select handlers (was App refs via props).
export function registerMarkerlessPick(cb: ((world: [number, number, number]) => void) | null): void { markerlessPick = cb; }
export function registerMarkerlessSelect(cb: ((i: number) => void) | null): void { markerlessSelect = cb; }
export function selectPick(i: number): void { markerlessSelect?.(i); } // 3D marker click → select in the wizard

// A model pick from the embedded 3D view. Markerless takes precedence when its wizard step is active;
// otherwise pair with the confirmed projector crosshair pixel → board pose correspondence.
export function pick(world: [number, number, number]): void {
  if (markerlessPick) { markerlessPick(world); return; }
  const sid = calibratingId, pixel = pendingPixel;
  if (!sid || !pixel) return; // operator must confirm a crosshair on the projector first
  pendingPixel = null;
  const cal = getCalibration(sid);
  if (!cal) return;
  const picks = [...(cal.posePicks ?? []), { world, pixel }];
  storeCalibration(sid, { posePicks: picks });
  if (picks.length >= 4) void solvePose(sid, picks);
}

export async function solvePose(surfaceId: string, picks: NonNullable<ProjectorCalibration['posePicks']>): Promise<void> {
  const cal = getCalibration(surfaceId);
  if (!cal) return;
  const obj = picks.flatMap((p) => p.world);
  const img = picks.flatMap((p) => p.pixel);
  const res = await calibNative.calibSolvePnp(obj, img, cal.intrinsics, cal.distortion ?? [0, 0, 0, 0, 0]);
  if (!res) return;
  storeCalibration(surfaceId, { rotation: res.rotation, translation: res.translation, poseRms: res.rms });
}

// Board wizard leaving/entering the pose step: drop any half-captured crosshair.
export function poseModeChange(on: boolean): void { if (!on) { pendingPixel = null; latestCrosshair = null; } }

export function clearPoses(surfaceId: string): void {
  pendingPixel = null;
  storeCalibration(surfaceId, { posePicks: [], poseRms: undefined, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] });
}

// Full teardown when the calibration panel closes (mirrors App's former closeCalib ref resets).
export function reset(): void {
  latestCrosshair = null; pendingPixel = null; markerlessPick = null; markerlessSelect = null; calibratingId = null;
}
