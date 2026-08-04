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
// Measured on the dev laptop (Intel Iris Xe), same project, same build:
//   • output open, NOT calibrated → the editor holds 60 fps (render 59.9, Art-Net 56)
//   • output open, calibrated     → the WHOLE app falls to 17.6 fps, including editor contexts that
//                                   draw no 3D at all
// Capping the calibrated scene helps a little and cannot close that gap: the cost is the second
// scene existing, not the rate it draws at (caps of 15 and 30 measured the same).
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
