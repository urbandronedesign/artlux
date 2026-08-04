// The renderer half of the launch profile — see src/main/runProfile.ts for what it means and why.
//
// Read from the query string because that is the one channel every window already has before any
// IPC round-trip: plugin activation happens during module load, long before prefs could answer, and
// it happens identically in the editor window and in each projector window. Main puts the same
// param on every URL it builds, so the two cannot disagree.

const QS = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');

/**
 * Does this window carry projector calibration? OFF in a plain editor launch; ON under
 * `--calibrate`, and always ON in broadcast/headless, which are shows.
 *
 * Consumers: the renderer plugin host (whether `plugins/calibration` activates at all) and the core
 * workspace (whether the Calib rail context is registered — the plugin only supplies that context's
 * viewport, so registering it without the plugin would leave an empty workbench on the rail).
 */
export const CALIBRATION_ENABLED = QS.get('calibrate') === '1';
