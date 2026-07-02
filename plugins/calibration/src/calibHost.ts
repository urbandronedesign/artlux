// Host-services access for the calibration wizards.
//
// The renderer plugin captures `ctx.host` at activation and stashes it here, so the wizard components
// (still mounted by App, which owns their embedded-Simulator3D + camera-portal workspace) perform
// their state mutations + projector IO through the reusable host-services API instead of App callback
// props. This inverts the wizards' write path off App (Stage 2c); the interactive *workspace* props
// (pick mode, camera host, split, pose pairing) remain App-owned by design — that UI is the editor's.

import type { RendererHostServices } from '@artlux/sdk/renderer';
import type { MainToProjector } from '@/projector/bridge';
import type { ProjectorCalibration, ProjectorOutput, Scene3D, CamMask, MarkerMap } from '../../../shared/protocol';

let host: RendererHostServices | null = null;

// Called once from the plugin's renderer activate(). In the main window this is the real host; the
// wizards only ever render there, so it's set before any wizard mounts.
export function setHost(h: RendererHostServices): void { host = h; }

// main → projector (structured-light patterns, calib mode, crosshair, scene).
export function sendToProjector(surfaceId: string, msg: MainToProjector): void {
  host?.projectors.send(surfaceId, msg);
}

// Merge a calibration patch into the output (mirrors App's former handleStoreCalibration): read the
// current calibration, fill defaults, stamp calibratedAt, patch back through the outputs service.
export function storeCalibration(surfaceId: string, patch: Partial<ProjectorCalibration>): void {
  const prev = (host?.projectorOutputs.get(surfaceId) as ProjectorOutput | undefined)?.calibration ?? null;
  const base: ProjectorCalibration = prev ?? {
    intrinsics: [1, 0, 0, 0, 1, 0, 0, 0, 1], distortion: [0, 0, 0, 0, 0],
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0], imageSize: [0, 0],
  };
  host?.projectorOutputs.patch(surfaceId, { calibration: { ...base, ...patch, calibratedAt: new Date().toISOString() } } as Partial<ProjectorOutput>);
}

export function setUseCalibration(surfaceId: string, on: boolean): void {
  host?.projectorOutputs.patch(surfaceId, { useCalibration: on } as Partial<ProjectorOutput>);
}

// Live read of an output's current calibration (for the pose-pairing orchestration in calibWorkspace).
export function getCalibration(surfaceId: string): ProjectorCalibration | undefined {
  return (host?.projectorOutputs.get(surfaceId) as ProjectorOutput | undefined)?.calibration ?? undefined;
}

// Camera exclusion mask + fiducial marker map live on the 3D scene (venue), not the output.
export function storeCamMask(mask: CamMask | null): void {
  host?.scene3D.patch({ camMask: mask ?? undefined } as Partial<Scene3D>);
}
export function storeMarkerMap(map: MarkerMap | null): void {
  host?.scene3D.patch({ markerMap: map ?? undefined } as Partial<Scene3D>);
}
