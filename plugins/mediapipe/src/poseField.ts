// THE CAMERA FIELD in the 3D scene — one vertical panel standing for the camera picture, behind the
// floor origin. PoseViz draws it (outline, the marked interaction area, live body parts) and the camera
// area's toWorld() places trigger zones on it, so both go through ONE mapping: a zone can never be drawn
// somewhere other than where the parts it counts are drawn.
//
// It is a picture of the CAMERA'S VIEW, not the room. The interaction area can be any plane (a wall, a
// screen, the floor), and a 2D camera cannot say which, so the honest 3D place for it is the picture.
// The floor calibration (mediapipeFloor) is a separate thing: it places PEOPLE on the floor.

import type { MediapipeArea } from '../../../shared/protocol';
import { areaToImage } from './poseAreaMath';

export const CAM_W = 4, CAM_H = 2.25, BASE_Y = 0.5, Z_BB = -0.5; // metres; 16:9 panel

/** Image space (0..1, bottom-left) → a point on the panel, lifted `lift` metres toward the viewer. */
export function imageToField(u: number, v: number, lift = 0): [number, number, number] {
  return [u * CAM_W - CAM_W / 2, BASE_Y + v * CAM_H, Z_BB + lift];
}

/** Area space → panel, through the area's own homography + mirror (the inverse of what zones test). */
export function areaToField(area: MediapipeArea, u: number, v: number, lift = 0): [number, number, number] | null {
  const [x, y] = areaToImage(area.imageQuad, u, v, area.mirror);
  return Number.isFinite(x) && Number.isFinite(y) ? imageToField(x, y, lift) : null;
}
