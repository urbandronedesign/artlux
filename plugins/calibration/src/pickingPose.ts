import type { ProjectorCalibration } from '../../../shared/protocol';

// Is there a pose to PICK against? A solved one, or a starting pose taken from a projector placed in
// the venue file (`poseSeeded`). Only the picking gestures may ask this — predicting where a new point
// lands, the leader lines, the projected wireframe underlay. Everything that means "this output is
// calibrated" keeps asking `poseRms != null`, which a seed never sets.
export const hasPickingPose = (cal: ProjectorCalibration | null | undefined): boolean =>
  cal?.poseRms != null || !!cal?.poseSeeded;
