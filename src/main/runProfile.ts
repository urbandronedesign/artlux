// WHICH SUBSYSTEMS THIS LAUNCH CARRIES. Parsed once, from argv, and read by every window builder —
// so the editor window and the projector windows it spawns can never disagree about the profile.
//
// Two axes: projector calibration (below), and where the renderer is loaded FROM across a relaunch
// (bottom of the file) — both are facts about this launch that main parses once and every window
// builder must agree on.
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

import { app } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

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

// ── WHERE THE RENDERER COMES FROM, AND WHY A RELAUNCH CANNOT INHERIT THE ANSWER ────────────────
//
// `--built-renderer`: load the renderer from disk (`out/renderer/*.html`) even though
// ELECTRON_RENDERER_URL is still sitting in this process's environment. Added by relaunchArgs()
// on every unpackaged relaunch, and carried forward by each further one.
//
// WHY IT HAS TO EXIST. In dev the app is a child of `electron-vite dev`, which exports
// ELECTRON_RENDERER_URL and serves the renderer from memory on :3000. Every relaunch site does
// `app.relaunch({args}); app.exit(0)` — and app.relaunch spawns the successor with THIS PROCESS'S
// ENVIRONMENT (there is no `env` option on RelaunchOptions), so the successor inherits that URL.
// But the exit(0) is exactly what tears the dev server down: electron-vite exits when its electron
// child exits cleanly. The successor therefore spends its entire life pointing at a port nobody is
// listening on, and there is no second chance — the server does not come back.
//
// NOTHING THROWS. The window is created, argv is right, main boots, the plugins activate, the tray
// appears, the metrics endpoint answers with mode="broadcast" — and the renderer never loads, so
// App never runs, so no projector output is ever opened. From the operator's chair "Launch in
// Broadcast Mode" simply does nothing. Worse, the failed process is deliberately invisible in
// broadcast (opacity 0, off the taskbar) and stays alive holding the metrics port, the Art-Net
// socket and the audio device, so the NEXT `npm run dev` misbehaves too and the cause looks like
// something else entirely. Diagnosed off a live process reporting mode="broadcast" with
// artlux_render_fps 0 — main up, renderer never painted a frame.
//
// So: never read ELECTRON_RENDERER_URL directly in a window builder, and never hand-roll the
// relaunch argv. Both are guarded by `npm run verify:invariants`.

const BUILT_RENDERER = argv.includes('--built-renderer');

/**
 * The electron-vite dev-server URL, or undefined when this launch must use the built renderer.
 * THE ONLY sanctioned reader of ELECTRON_RENDERER_URL — every window builder goes through here so
 * the editor, the projectors, the docs window and the splash can never disagree about the source.
 */
export function rendererDevUrl(): string | undefined {
  // A SHIPPED APP HAS NO DEV SERVER, so it must never be talked into looking for one. Nothing sets
  // this variable in an installed environment — but "nothing sets it" is an assumption about the
  // machine, and inheriting an ambient variable that names a server nobody is running is the exact
  // bug this file exists to document. Packaged answers unconditionally, off its own state.
  if (app.isPackaged) return undefined;
  if (BUILT_RENDERER) return undefined;
  return process.env['ELECTRON_RENDERER_URL'] || undefined;
}

/**
 * The base argv for ANY intentional relaunch (broadcast, calibration profile, watchdog self-heal,
 * playlist switch). Callers append their own flags.
 *
 * app.relaunch replaces argv wholesale, so when unpacked the app path must be re-passed or Electron
 * relaunches with no app at all (the welcome screen). `--built-renderer` rides along for the reason
 * above, and because it comes from argv it is re-emitted by the successor's own relaunchArgs() —
 * a watchdog self-heal three relaunches deep still knows the dev server is gone.
 */
export function relaunchArgs(): string[] {
  return app.isPackaged ? [] : [app.getAppPath(), '--built-renderer'];
}

/**
 * Dev-only preflight for a relaunch: the path of the built renderer when it is MISSING, else null.
 *
 * `--built-renderer` will loadFile() this, so without it the successor is just as blank as the bug
 * above — only now because nobody ever ran `npm run build`. Callers that a human triggered should
 * refuse the relaunch and say so, rather than exiting into a process that can never draw.
 */
export function missingBuiltRenderer(): string | null {
  if (app.isPackaged) return null;
  const f = join(__dirname, '../renderer/index.html');
  return existsSync(f) ? null : f;
}
