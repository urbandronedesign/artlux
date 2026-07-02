// Calibration pose-pairing orchestration — moved out of App (Stage 2d).
//
// This is the event-driven glue between three things the operator drives during a pose capture: the
// projector crosshair (arrives over the projector→main back-channel, fed in by plugin.renderer's
// onMessage tap), a model pick on the embedded 3D venue view (App forwards its onCalibPick here), and
// the solver. It holds no React state — purely module-level refs + host-services writes (via calibHost)
// — so it lives cleanly in the plugin. App keeps the *rendering* (embedded Simulator3D + camera portal)
// and the UI state (which output/flow/pick-mode); it just calls into here instead of owning the logic.
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
