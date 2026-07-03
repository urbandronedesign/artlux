// Small shared helpers for the floor calibration + preview: the ground-contact ("foot") point of a
// detected person, and the world-space rectangle a floor calibration maps to.

import type { CornerPin, MediapipeFloor } from '../../../shared/protocol';
import type { PoseLandmark } from './poseStore';

// BlazePose landmark indices for the lower body (already in bottom-left normalized space in the store).
const ANKLE_L = 27, ANKLE_R = 28, HEEL_L = 29, HEEL_R = 30, FOOT_L = 31, FOOT_R = 32;
const HIP_L = 23, HIP_R = 24;
const VIS = 0.3; // min visibility to trust a landmark

// The person's ground-contact point in bottom-left normalized image space — what actually lies on the
// floor plane (so the homography maps it to a real floor position). Prefers the lowest reliable foot
// landmark pair (ankles → heels → foot-index), falling back to the hip midpoint when the legs are
// occluded (better than nothing; the caller may still want a position). Returns null if no usable pair.
export function footPoint(landmarks: PoseLandmark[] | undefined): [number, number] | null {
  if (!landmarks || landmarks.length < 33) return null;
  const mid = (a: number, b: number): [number, number] | null => {
    const la = landmarks[a], lb = landmarks[b];
    if (!la || !lb || la.visibility < VIS || lb.visibility < VIS) return null;
    return [(la.x + lb.x) / 2, (la.y + lb.y) / 2];
  };
  // Prefer the point closest to the ground: foot-index/heel sit lower than the ankle.
  return mid(FOOT_L, FOOT_R) ?? mid(HEEL_L, HEEL_R) ?? mid(ANKLE_L, ANKLE_R) ?? mid(HIP_L, HIP_R);
}

// The real floor rectangle a calibration maps to, as a CornerPin (metres) in {tl,tr,br,bl} order that
// matches the image quad's corners. Convention: x is width (centred, −W/2..+W/2), z is depth; the
// image's TOP row (tl,tr) is the FAR floor edge (z = depth), the bottom row (br,bl) the near edge (z=0).
export function worldQuad(f: Pick<MediapipeFloor, 'width' | 'depth'>): CornerPin {
  const w = f.width / 2, d = f.depth;
  return { tl: [-w, d], tr: [w, d], br: [w, 0], bl: [-w, 0] };
}

// Adapt the persisted imageQuad array to a CornerPin for squareToQuad.
export function imageCornerPin(q: MediapipeFloor['imageQuad']): CornerPin {
  return { tl: q[0], tr: q[1], br: q[2], bl: q[3] };
}
