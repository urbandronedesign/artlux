// FRAME THE PROJECTOR IN FOCUS (ArtLux Calibrator). Picking a projector in the Rig points the 3D view
// at what it lights, so the next thing the operator does — click points on the venue, judge a seam —
// starts with the right part of the room on screen. Before this nothing framed anything: the view kept
// wherever it last was, which for a projector just added to the rig was the floor.
//
// From the projector's pose: the calibration once solved, else the starting pose taken from Blender
// (poseSeed). The camera stands a little behind and above the projector, looking at where its axis meets
// the venue, so its frustum and the wall are both in view. A projector with no pose yet gets the whole
// venue, seen from the side the rest of the rig stands on.

import type { ProjectorOutput, Scene3D } from '../../../shared/protocol';
import { cameraCenter, type Mat3, type Vec3 } from './cvCamera';
import { venueBounds, raycastVenue } from './venueRaycast';
import { getHost } from './calibHost';

type View3D = { position: Vec3; target: Vec3 };

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Where the projector stands and which way it looks (world), from its solved or seeded pose. */
function poseOf(o: ProjectorOutput): { C: Vec3; fwd: Vec3 } | null {
  const c = o.calibration;
  const src = c?.poseRms != null && c.rotation && c.translation ? { R: c.rotation, t: c.translation }
    : c?.poseSeed ? { R: c.poseSeed.rotation, t: c.poseSeed.translation } : null;
  if (!src) return null;
  const R = src.R as Mat3;
  // OpenCV cameras look along their +Z; in world that is R's third row.
  return { C: cameraCenter(R, src.t as Vec3), fwd: [R[6], R[7], R[8]] };
}

export function viewForProjector(id: string): View3D | null {
  const outs = (getHost()?.projectorOutputs.list() ?? []) as ProjectorOutput[];
  const o = outs.find((x) => x.surfaceId === id);
  const bounds = venueBounds();
  const pose = o ? poseOf(o) : null;
  if (pose) {
    const hit = raycastVenue(pose.C, pose.fwd);
    const dist = hit ? len(sub(hit, pose.C)) : bounds ? len(sub(bounds.center, pose.C)) : 5;
    const target = hit ?? add(pose.C, mul(pose.fwd, dist));
    const back = dist * 0.35;
    return { position: add(sub(pose.C, mul(pose.fwd, back)), [0, back * 0.4, 0]), target };
  }
  if (!bounds) return null;
  const others = outs.filter((x) => x.surfaceId !== id).map(poseOf).filter((p): p is { C: Vec3; fwd: Vec3 } => !!p);
  let dir: Vec3 = [0, 0, 1];
  if (others.length) {
    const avg = mul(others.reduce<Vec3>((s, p) => add(s, p.C), [0, 0, 0]), 1 / others.length);
    const d = sub(avg, bounds.center);
    if (len(d) > 1e-6) dir = mul(d, 1 / len(d));
  }
  return { position: add(add(bounds.center, mul(dir, bounds.size * 1.6)), [0, bounds.size * 0.25, 0]), target: bounds.center };
}

/** Point the editor camera at the projector — left alone while the view looks THROUGH a projector. */
export function frameProjector(id: string): void {
  const host = getHost();
  if (!host?.scene3D.applyView || (host.scene3D.get() as Scene3D).viewFrom) return;
  const v = viewForProjector(id);
  if (v) host.scene3D.applyView(v);
}
