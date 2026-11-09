// The camera INTERACTION AREA as a tracking surface — what makes trigger zones work on a webcam.
//
// The LiDAR plugin owns the zone engine (zones, hysteresis, show rules). This module contributes the
// surface 'POSE' to the SDK's tracking-surface registry: every frame, each detected person's body parts
// (hands, feet, head, body — poseAreaMath.extractParts) are mapped from the camera image into the
// operator's marked quad (Scene3D.mediapipeArea) and handed over as tagged points. A zone on 'POSE' then
// counts the PEOPLE with a qualifying part inside it. Neither plugin imports the other.
//
// Render-free; read on the zone engine's frame callback. Points are recomputed only when the pose store
// or the calibration changed, so N zones on the area cost one mapping pass per inference frame.

import type { TrackedPoint, TrackingSurfaceContribution } from '@artlux/sdk/renderer';
import type { MediapipeArea } from '../../../shared/protocol';
import type { Mat3 } from '@/projector/homography';
import * as poseStore from './poseStore';
import * as poseEngine from './poseEngine';
import * as poseCamera from './poseCamera';
import { getHost } from './poseHost';
import { PARTS, extractParts, imageToArea, mapToArea, inArea, type PartId } from './poseAreaMath';
import { areaToField } from './poseField';

export const POSE_SURFACE_KEY = 'POSE';
const STALE_MS = 500; // same window as poseStore.snapshot(): a dead camera is NOBODY, not a frozen crowd

export function getArea(): MediapipeArea | undefined {
  return (getHost()?.scene3D.get() as { mediapipeArea?: MediapipeArea } | undefined)?.mediapipeArea;
}

// The homography follows the calibration object: Save writes a NEW object, so identity is the version.
let hFor: MediapipeArea | undefined;
let hCache: Mat3 | null = null;
function homography(area: MediapipeArea | undefined): Mat3 | null {
  if (area !== hFor) { hFor = area; hCache = area ? imageToArea(area.imageQuad) : null; }
  return hCache;
}

let ptsAt = -1;
let ptsArea: MediapipeArea | undefined;
let pts: TrackedPoint[] = [];

/** This frame's tagged points in area space (also what the calibration Test view draws). */
export function points(): TrackedPoint[] {
  const area = getArea();
  const h = homography(area);
  if (!area || !h) return [];
  const at = poseStore.lastUpdatedAt();
  if (performance.now() - at > STALE_MS) return [];
  if (at === ptsAt && area === ptsArea) return pts;
  ptsAt = at; ptsArea = area;
  const out: TrackedPoint[] = [];
  // PERSON = this inference frame's detection index. Zones count distinct people PER FRAME and carry
  // their own dwell/hysteresis, so cross-frame identity buys nothing here — and BlazePose has none.
  poseStore.getDetections().forEach((d, i) => {
    for (const p of extractParts(d.landmarks)) {
      const [u, v] = mapToArea(h, p.x, p.y, area.mirror);
      if (Number.isFinite(u) && Number.isFinite(v) && inArea(u, v)) out.push({ u, v, person: String(i), part: p.part });
    }
  });
  pts = out;
  return pts;
}

/** Calibrated on a different camera than the one running now? (label or resolution changed). */
export function cameraMismatch(): string | null {
  const area = getArea();
  const cur = poseCamera.info();
  if (!area?.camera || !cur) return null;
  if (area.camera.label === cur.label && area.camera.w === cur.w && area.camera.h === cur.h) return null;
  return `Calibrated on ${area.camera.label} ${area.camera.w}×${area.camera.h} — the current camera is ${cur.label} ${cur.w}×${cur.h}. Re-mark the area if the picture moved.`;
}

let holdSeq = 0;
export const poseSurface: TrackingSurfaceContribution = {
  key: POSE_SURFACE_KEY,
  label: 'Camera area (MediaPipe)',
  parts: PARTS.map((p) => ({ id: p.id, label: p.label })),
  available: () => !!homography(getArea()),
  points,
  aspect: () => {
    const a = getArea()?.aspect;
    return typeof a === 'number' && Number.isFinite(a) && a > 0.05 && a < 20 ? a : 1;
  },
  // Zones on the area hold the camera + inference running, even with no pose content on screen.
  acquire: (owner) => {
    const key = `zones:${owner}:${++holdSeq}`;
    poseEngine.acquire(key);
    return () => poseEngine.release(key);
  },
  calibrateAction: 'pose-calibrate',
  warning: cameraMismatch,
  // Zones sit on the camera-field panel PoseViz draws — so only while that overlay is on (the 3D
  // panel's "Camera pose markers" toggle) and the area is valid. Lifted 2 cm so a zone outline is not
  // z-fighting the panel it is drawn on.
  toWorld: (u, v) => {
    const s = getHost()?.scene3D.get() as { mediapipeViz?: boolean; mediapipeArea?: MediapipeArea } | undefined;
    const area = s?.mediapipeArea;
    if (!s?.mediapipeViz || !area || !homography(area)) return null;
    return areaToField(area, u, v, 0.02);
  },
};

export type { PartId };
