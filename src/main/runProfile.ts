// WHICH SUBSYSTEMS THIS LAUNCH CARRIES. Parsed once, from argv, and read by every window builder —
// so the editor window and the projector windows it spawns can never disagree about the profile.
//
// Today there is exactly one axis: projector calibration.
//
// ── WHY CALIBRATION IS A PROFILE AND NOT A PREFERENCE ──────────────────────────────────────────
// A calibrated output does not merely warp a picture: `plugins/calibration` mounts a full-window
// panel over the projector's canvas that renders the venue AGAIN — its own react-three-fiber scene,
// a depth pass and two postprocessing effects — because a solve has to be verified against the real
// wall. That is correct for calibrating and for running a show, and ruinous while authoring.
//
// ⚠ CORRECTED. This block used to read "60 fps against 17.6, same project, same build". It was not
// the same project — the two figures came from two different ones, and the gap was mostly the
// projects. Controlled, on ONE project, it measured 38.9 uncalibrated against 34.4 calibrated: real,
// worth avoiding while authoring, and nowhere near a 3.4× cliff. The claim is left here rather than
// deleted because it was quoted onward into `renderer/host/plugins.ts` and into an invariant's
// rationale before anyone re-measured it, and a number that travels that far deserves a correction
// that travels with it. Capping the calibrated scene does not close even the real gap: the cost is
// the second scene EXISTING, not the rate it draws at (caps of 15 and 30 measured the same).
//
// Since then a baked calibration map supersedes that second scene outright (ProjectorApp's
// applyCalibMode), so a calibrated output that plays a map costs one fragment shader. What remains
// behind this profile is AUTHORING — the wizards, the camera, OpenCV, and the live venue render you
// align against — which the calibration plugin now gates itself (isAuthoringLaunch), so that playing
// a calibration no longer requires the machinery for making one.
//
// So the editor drops it, and everything that actually puts light on a wall keeps it:
//   editor      → OFF unless --calibrate
//   broadcast   → ON, always. This is the show; its outputs are the calibrated ones.
//   headless    → ON, always. Same reason — it is a show with no window.
//
// It is a launch profile rather than a runtime toggle because plugin activation happens once, at
// window load, in both the editor and every projector window. A mid-session switch would leave the
// two disagreeing, which is the shape of bug that ends with a black output at a venue.

const argv = process.argv.slice(1);

const HEADLESS = argv.includes('--headless');
const BROADCAST = argv.includes('--broadcast');

/** `--calibrate`: bring the calibration workbench into an EDITOR launch. Implied by show modes. */
export const CALIBRATION_ENABLED = argv.includes('--calibrate') || HEADLESS || BROADCAST;

/**
 * The profile as renderer query params, merged into whatever a window already passes. Absent when
 * off, so a plain editor launch keeps the byte-identical URL it had before this existed.
 */
export function profileQuery(): Record<string, string> {
  return CALIBRATION_ENABLED ? { calibrate: '1' } : {};
}
