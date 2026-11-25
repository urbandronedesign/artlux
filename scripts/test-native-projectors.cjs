#!/usr/bin/env node
// E1f-3 THE NATIVE ENGINE TAKES THE PROJECTOR OUTPUTS — in the REAL app (Windows), read from the SCREEN.
//
//   node scripts/test-native-projectors.cjs [--packaged <ArtLux.exe>]
//
// ⚠ IT COVERS DISPLAY 0 (the primary) with a fullscreen projector output, three times, for ~15 s each.
//
// ArtLux in BROADCAST mode (projector outputs are its only windows; headless suppresses them) on its own
// project: one still on a surface, one projector output on display 0 with a keystone, a soft edge, a gamma,
// colour gain + black lift and a projector brightness — everything the plain warp path does. Then:
//   A. without --native-engine: the app's projector window — the screen is the reference;
//   B. with it: the engine's TOPMOST window shows the output (main logs `owns the projector outputs`);
//      Its window must equal A's pixel for pixel (an MP4: within 1);
//   C. kill the engine: main uncovers the app's windows (its log), and the restarted engine takes the
//      outputs back — its window = A again;
//   A2. the app alone again: it must equal A, which is what makes A the reference.
// (Until 2026-11-22 the engine was judged against a capture taken just after the kill — which was the
// RESTARTED engine's window. See C below.)
// Nothing synchronous runs while ArtLux does: in dev its stdout is piped here, and on Windows a blocked
// reader blocks the writer (E1f-1).
// OWN PROCESSES, OWN PROFILE (2026-11-25): every launch uses a SCRATCH profile (--user-data-dir) — it used to
// back up, rewrite and restore the OPERATOR's prefs in %APPDATA% — and only this run's own process tree is ever
// killed (by pid). `stopAll` used to `taskkill /IM` every electron.exe, ArtLux.exe and artlux-engine.exe on the
// machine, and C. killed "the first artlux-engine" — either could take down a show the operator had open.
// E6f: the output also carries a projection MASK and a BLEND MAP. The app's projector window applies neither (the
// mask is the NVIDIA scanout path's, the blend map render-from-projector's — both refused separately), so the
// engine takes the output and must show the same picture: A = B with them on.
// --windowed (E6f): the output is a WINDOWED one (Windowed (this screen)). The engine opens an ordinary window where the
// app's is and main HIDES the app's: the two are compared over the window's content rect only (the title bars are
// two programs'), exactly one visible window carries the output's title and it is the engine's, a move of the
// engine's window is followed by the hidden app window, and after a kill the restarted engine opens at the moved
// place. The rest of the screen is not judged (it is the desktop).
// --ndi (E6f): the output is also SENT AS NDI. The frames are RECEIVED here (a child process, the app's own addon,
// uncapped) from the app in A and from the ENGINE in B and after the restart: the engine's NDI frame must equal the
// app's, there must be exactly ONE source of that name while the engine sends (the app's sender stood down), and the
// app's sender comes back when the engine dies.
// --hwwarp (E6f): the output has NVIDIA HARDWARE WARP on. With NVAPI owning it the app's window draws the output FLAT
// (the scanout warps the display — whichever window is on it) and the engine must draw the same flat picture.
// --hwwarp --no-nvapi: NVAPI absent — the app IGNORES hwWarp and draws the GLSL warp, and so must the engine.
// ⚠ NO RUN EVER REACHES REAL NVAPI: every launch sets ARTLUX_NVWARP_PRETEND (main/nvwarpManager.ts) — `1` for
// --hwwarp (reported available), `0` otherwise (absent) — and main then skips every scanout call. A GeForce RTX 5090
// answered available() TRUE (2026-11-25): the first --no-pretend run put its keystone on the operator's primary
// display AT SCANOUT (no screen capture sees it — they read the framebuffer), and the forced kill skipped the clear.

const { spawn, execFile, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'artlux-native-projectors');
fs.mkdirSync(WORK, { recursive: true });
const PROFILE = path.join(WORK, 'profile');
const PREFS = path.join(PROFILE, 'artlux-prefs.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));
const env0 = { ...process.env }; delete env0.ELECTRON_RUN_AS_NODE; delete env0.ARTLUX_NVWARP_PRETEND;
const pk = process.argv.indexOf('--packaged');
const PACKAGED = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
// --baked: the output plays an imported CALIBRATION MAP (item 3) — a real .mpcdi, written by the app's own
// encoder (src/main/mpcdi.ts buildMpcdi), loaded the way a show machine loads one: Prefs.calibrationFile.
const BAKED = process.argv.includes('--baked');
// --mp4 [clip]: the output shows an MP4 surface (item 2c-4) — a clip whose frames are all the same picture
// (engine/testdata/still-avc-1280x720.mp4, made by test:mp4-parity's encoder), so two screens can be
// compared. The app ships it to its window as createImageBitmap(frame); the engine copies its own decoded,
// converted frame (GPU) — within 1 of Chromium's conversion, so the windows are held to "within 1".
const mk = process.argv.indexOf('--mp4');
const WINDOWED = process.argv.includes('--windowed');
const NDI = process.argv.includes('--ndi');
const HWWARP = process.argv.includes('--hwwarp');
// --calibrated [--glb] (E6f): RENDER-FROM-PROJECTOR — the output is calibrated and draws the VENUE (two screen planes,
// one through its UVs, one projected from this projector; --glb adds the multi-projector example's venue GLB wearing
// the still). The app's window draws it with three.js (ProjectorScene), the engine with calib3d.rs.
// --distort: a lens distortion (radial + tangential) — ProjectorScene's post pass (EffectComposer). --calib-blend: a
// soft edge, colour gain, black lift and a solved rig blend — the same pass. --calib-warp: a residual warp (a nudged
// corner pin — ProjectorApp path B: the scene's canvas becomes the warp stage's source). --calib-occlude: projected
// OCCLUSION — a blocker screen stands between the projector and the projected one, and (with --glb) the venue GLB is
// projected too and shadows itself. --calib-refused: an NDI send WITHOUT a residual warp (the app sends nothing
// there), which the engine leaves alone: the app must KEEP the outputs, with the reason.
// --hold (E6h): the ENGINE run with ARTLUX_NO_APP_PROJECTOR=1 — the app's projector windows draw nothing of their own,
// as with no browser engine (E6i) — and a slow restart (ARTLUX_ENGINE_TEST_RESTART_MS): killed, the engine's LAST
// PICTURE must be what the screen shows (main hands it to the app's window, engineHost.holdProjectors), until the
// restarted engine covers it again.
const HOLD = process.argv.includes('--hold');
// --partial (E6i step 2): a SECOND enabled output the engine cannot show (no display chosen — the app keeps it). Owned
// per output, the engine must still take 'Wall' (it used to hand EVERY output back for one refusal), main must say
// which it keeps and why, and the screen must still equal A.
const PARTIAL = process.argv.includes('--partial');
const CALIBRATED = process.argv.includes('--calibrated');
const CALIB_WARP = CALIBRATED && process.argv.includes('--calib-warp');
const CALIB_OCCLUDE = CALIBRATED && process.argv.includes('--calib-occlude');
const CALIB_REFUSED = CALIBRATED && process.argv.includes('--calib-refused');
// --calib-own: the blender-screens example ROOM behind the screens — its walls and floor in the file's OWN materials
// (lit by the window's ambient + hemisphere lights, ACES tone-mapped), its named screen 'screen_main' wearing the still.
// --calib-layer: a TIMELINE LAYER on the venue — the tilted screen (and, with --calib-own, the room's screen) shows a
// track playing a second still (the first, colour-inverted), paused at 0. The engine composites it as a LAYER surface.
const CALIB_LAYER = CALIBRATED && process.argv.includes('--calib-layer');
const CALIB_OWN = CALIBRATED && process.argv.includes('--calib-own') ? path.join(ROOT, 'examples', 'blender-screens', 'venue.glb') : null;
// --calib-occlude projects from a SECOND projector ('sQ', a disabled output at another pose): occlusion is invisible
// from the projecting projector itself (what its depth map hides, its own depth buffer hides too), so the shadow is
// only seen from somewhere else — here, from the output under test. Yawed 0.4 rad toward −X, 3 m to the right.
const Q_C = [3, 1.5, 3.5], Q_T = 0.4;
const Q_R = [Math.cos(Q_T), 0, -Math.sin(Q_T), 0, -1, 0, -Math.sin(Q_T), 0, -Math.cos(Q_T)];
const Q_t = [0, 1, 2].map((r) => -(Q_R[r * 3] * Q_C[0] + Q_R[r * 3 + 1] * Q_C[1] + Q_R[r * 3 + 2] * Q_C[2]));
const PROJ_FROM = CALIB_OCCLUDE ? 'sQ' : 'sP';
const CALIB_DISTORT = CALIBRATED && process.argv.includes('--distort');
const CALIB_BLEND = CALIBRATED && process.argv.includes('--calib-blend');
const CALIB_GLB = CALIBRATED && process.argv.includes('--glb') ? path.join(ROOT, 'examples', 'multi-projector', 'assets', 'models', 'panorama-venue.glb') : null;
const PRETEND = HWWARP && !process.argv.includes('--no-nvapi');
env0.ARTLUX_NVWARP_PRETEND = PRETEND ? '1' : '0';   // ALWAYS set — see the header (never the real scanout)
// --editor: launch WITHOUT --broadcast (the editor's window opens too). With --ndi that is the editor's 720p NDI cap,
// so a 1080p output is SCALED DOWN for the send — the path broadcast (1080p cap) never takes.
const EDITOR = process.argv.includes('--editor');
const MP4 = mk > 0 ? path.resolve(process.argv[mk + 1] && !process.argv[mk + 1].startsWith('--') ? process.argv[mk + 1] : path.join(ROOT, 'engine', 'testdata', 'still-avc-1280x720.mp4')) : null;

// The primary display, as Electron names it (the project's output points at it).
const disp = JSON.parse(execSync(`"${path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')}" "${path.join(WORK, 'disp.cjs')}"`, {
  env: env0, encoding: 'utf8', input: '', stdio: ['pipe', 'pipe', 'ignore'],
  ...(() => { fs.writeFileSync(path.join(WORK, 'disp.cjs'), "const { app, screen } = require('electron'); app.whenReady().then(() => { const d = screen.getPrimaryDisplay(); console.log(JSON.stringify({ id: d.id, b: screen.dipToScreenRect(null, d.bounds) })); app.quit(); });"); return {}; })(),
}).trim().split(/\r?\n/).pop());

// ── the project ───────────────────────────────────────────────────────────────────────────────────────
const W0 = 1280, H0 = 720, png = new PNG({ width: W0, height: H0 });
for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) {
  const i = (y * W0 + x) * 4, line = x % 61 === 0 || y % 47 === 0;
  png.data.set([line ? 255 : Math.round(x / (W0 - 1) * 255), line ? 255 : Math.round(y / (H0 - 1) * 255), line ? 255 : ((x >> 6) + (y >> 6)) % 2 ? 210 : 30, 255], i);
}
const picture = path.join(WORK, 'projected-1280x720.png');
fs.writeFileSync(picture, PNG.sync.write(png));
const layerPicture = path.join(WORK, 'layer-1280x720.png');
if (CALIB_LAYER) {
  const inv = new PNG({ width: W0, height: H0 });
  for (let i = 0; i < png.data.length; i += 4) inv.data.set([255 - png.data[i], 255 - png.data[i + 1], 255 - png.data[i + 2], 255], i);
  fs.writeFileSync(layerPicture, PNG.sync.write(inv));
}
const project = path.join(WORK, 'projectors.artlux');
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [{ id: 'sP', name: 'Projected', x: 0.1, y: 0.1, width: 0.5, height: 0.28125, rotation: 0, zIndex: 0, content: MP4 ? { type: 'VIDEO', url: MP4, opacity: 1 } : { type: 'IMAGE', url: picture, opacity: 1 } },
    ...(CALIB_OCCLUDE || PARTIAL ? [{ id: 'sQ', name: 'Other', x: 0.6, y: 0.6, width: 0.3, height: 0.16875, rotation: 0, zIndex: 1, content: { type: 'IMAGE', url: picture, opacity: 1 } }] : [])],
  fixtures: [], controllers: [], groups: [], scenes: [], cueBanks: [],
  ...(CALIB_LAYER ? { timeline: { duration: 10, fps: 25, loop: false, layers: [{ id: 'LV', name: 'Venue layer', opacity: 1 }],
    clips: [{ id: 'cV', layerId: 'LV', name: 'still', path: '', content: { type: 'IMAGE', url: layerPicture, opacity: 1 }, start: 0, duration: 10, inPoint: 0 }], markers: [], inPoint: null, outPoint: null } } : {}),
  projectorBrightness: 0.9,
  projectorOutputs: [...(PARTIAL && !CALIB_OCCLUDE ? [{ surfaceId: 'sQ', name: 'Other', enabled: true, displayId: null }] : []), ...(CALIB_OCCLUDE ? [{
    // The projecting projector of --calib-occlude: calibrated, NOT enabled (nothing to show — it only throws content).
    surfaceId: 'sQ', name: 'Other', enabled: false, displayId: null, useCalibration: true,
    calibration: { intrinsics: [1800, 0, 960, 0, 1800, 540, 0, 0, 1], distortion: [0, 0, 0, 0, 0], rotation: Q_R, translation: Q_t, imageSize: [1920, 1080], poseRms: 0.4 },
  }] : []), CALIBRATED ? {
    // --calibrated: RENDER-FROM-PROJECTOR — a solved pose (1800 px focal on a 1920×1080 raster, 4 m in front of the
    // venue and 1.5 m up, looking down −Z), no distortion, no blend pass, no residual warp (the engine draws those
    // later — refused for now).
    surfaceId: 'sP', name: 'Wall', enabled: true, displayId: WINDOWED ? -1 : disp.id, useCalibration: true,
    // --ndi with --calib-warp: path B captures after warping (without a residual warp the app sends nothing).
    ...(NDI || CALIB_REFUSED ? { ndiSend: true } : {}),
    calibration: {
      intrinsics: [1800, 0, 960, 0, 1800, 540, 0, 0, 1], distortion: CALIB_DISTORT ? [-0.18, 0.07, 0.0015, -0.002, 0.01] : [0, 0, 0, 0, 0],
      rotation: [1, 0, 0, 0, -1, 0, 0, 0, -1], translation: [0, 1.5, 4], imageSize: [1920, 1080], poseRms: 0.4,
    },
    // --calib-blend: the blend pass — soft edge on two sides, a colour match, a black lift and a solved rig blend map.
    ...(CALIB_BLEND ? {
      softEdge: { left: 0.12, right: 0, top: 0, bottom: 0.09, gamma: 2.2 }, colorGain: [1, 0.94, 0.88], blackLift: [0.015, 0.01, 0.02],
      blend: { w: 5, h: 3, alpha: [1, 1, 0.8, 0.45, 0.1, 1, 1, 0.75, 0.4, 0.05, 1, 0.95, 0.7, 0.35, 0], black: [0, 0, 0.3, 0.7, 1, 0, 0.1, 0.4, 0.8, 1, 0, 0.2, 0.5, 0.9, 1], solvedAt: '2026-01-01T00:00:00.000Z', rigIds: ['sP'] },
    } : {}),
    // --calib-warp: a residual warp — a nudged corner pin (a real keystone, so the warp resamples every pixel).
    ...(CALIB_WARP ? { cornerPin: { tl: [0.03, 0.02], tr: [0.98, 0], br: [1, 0.97], bl: [0, 1] } } : {}),
  } : {
    surfaceId: 'sP', name: 'Wall', enabled: true, displayId: WINDOWED ? -1 : disp.id, ...(NDI ? { ndiSend: true } : {}), ...(HWWARP ? { hwWarp: true } : {}),
    cornerPin: { tl: [0.05, 0.1], tr: [0.93, 0.02], br: [0.97, 0.95], bl: [0.02, 0.88] },
    softEdge: { left: 0.15, right: 0, top: 0, bottom: 0.1, gamma: 2.2 }, gamma: 1, colorGain: [1, 0.95, 0.9], blackLift: [0.01, 0.01, 0.02],
    // E6f: drawn by neither the app's window nor the engine (see the header) — present to prove the engine takes it.
    projMask: { polys: [[[0.6, 0.6], [0.9, 0.6], [0.9, 0.9]]] },
    blend: { w: 4, h: 2, alpha: [1, 1, 0.5, 0, 1, 1, 0.5, 0], solvedAt: '2026-01-01T00:00:00.000Z', rigIds: ['sP'] },
  }],
  ...(CALIBRATED ? { scene3D: { models: [
    // A screen wearing the still through its UVs — tilted, so its texels are not 1:1 with the raster.
    { id: 'scr', name: 'Screen', kind: 'plane', path: '', surfaceId: 'sP', ...(CALIB_LAYER ? { layerId: 'LV' } : {}), position: { x: -0.9, y: 1.2, z: 0 }, rotation: { x: 0, y: 18, z: 4 }, scale: 1, scaleXYZ: [1.6, 1.6, 1], visible: true },
    // A screen PROJECTED from this very projector (resolveProjectedScene fills its matrix from the calibration).
    { id: 'prj', name: 'Projected', kind: 'plane', path: '', surfaceId: 'sP', position: { x: 1.3, y: 1.0, z: -0.5 }, rotation: { x: -12, y: -25, z: 0 }, scale: 1, scaleXYZ: [1.2, 1.2, 1], visible: true,
      uvMode: 'projected', uvProjFrom: PROJ_FROM, uvProjSoft: 0.05, uvProjOccludeOff: !CALIB_OCCLUDE },
    // --calib-occlude: a small screen on the line from 'sQ' to 'prj' — it casts into sQ's depth map, so a patch of
    // 'prj' goes dark: the shadow, seen from this output.
    ...(CALIB_OCCLUDE ? [{ id: 'blk', name: 'Blocker', kind: 'plane', path: '', surfaceId: 'sP', position: { x: 2.3, y: 1.3, z: 1.9 }, rotation: { x: 0, y: 20, z: 0 }, scale: 1, scaleXYZ: [0.15, 0.22, 1], visible: true }] : []),
    // --glb: the multi-projector example's venue, the still on every mesh of it (its UVs, v flipped as three flips it).
    ...(CALIB_GLB ? [{ id: 'ven', name: 'Venue', kind: 'mesh', path: CALIB_GLB, surfaceId: 'sP', position: { x: 0, y: 2.9, z: -3 }, rotation: { x: 0, y: 0, z: 0 }, scale: 0.5, visible: true,
      ...(CALIB_OCCLUDE ? { uvMode: 'projected', uvProjFrom: PROJ_FROM } : {}) }] : []),
    ...(CALIB_OWN ? [{ id: 'room', name: 'Room', kind: 'mesh', path: CALIB_OWN, position: { x: 0, y: 1.3, z: -2.5 }, rotation: { x: 0, y: 8, z: 0 }, scale: 0.6, visible: true,
      screens: { screen_main: CALIB_LAYER ? { layerId: 'LV' } : { surfaceId: 'sP' } } }] : []),
  ] } } : {}),
}, null, 2));

let calibFile = null;
if (BAKED) {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
  const mb = path.join(WORK, 'mpcdi.cjs');
  esbuild.buildSync({ entryPoints: [path.join(ROOT, 'src', 'main', 'mpcdi.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: mb, logLevel: 'error', external: ['electron'] });
  const { buildMpcdi } = require(mb);
  const mw = disp.b.width, mh = disp.b.height, xyz = new Float32Array(mw * mh * 3);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    const i = (y * mw + x) * 3, nx = (x + 0.5) / mw, ny = (y + 0.5) / mh;
    const ex = (nx - 0.5) / 0.46, ey = (ny - 0.5) / 0.44, r = Math.hypot(ex, ey);
    if (r > 1) { xyz[i] = NaN; xyz[i + 1] = NaN; xyz[i + 2] = NaN; continue; }
    const k = 1 - 0.25 * (1 - r * r);
    xyz[i] = 0.5 + ex * 0.5 * k; xyz[i + 1] = 0.5 - ey * 0.5 * k; xyz[i + 2] = r > 0.97 ? Math.max(0.05, (1 - r) / 0.03) : 1;
  }
  const aw = 480, ah = 270, a = new Uint8Array(aw * ah);
  for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) a[y * aw + x] = Math.round(255 * Math.min(1, Math.max(0, (x / aw - 0.6) / -0.3 + 1)));
  calibFile = path.join(WORK, 'rig.mpcdi');
  fs.writeFileSync(calibFile, buildMpcdi([{ id: 'sP', projW: mw, projH: mh, geo: { w: mw, h: mh, xyz, kind: 'uv' }, alpha: { w: aw, h: ah, data: a } }]));
}

// ── the screen, captured asynchronously ───────────────────────────────────────────────────────────────
const CAP = path.join(WORK, 'cap.ps1');
fs.writeFileSync(CAP, `param([string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class N {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(P p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
}
"@
[void][N]::SetProcessDPIAware()
$bmp = New-Object System.Drawing.Bitmap ${disp.b.width}, ${disp.b.height}
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(${disp.b.x}, ${disp.b.y}, 0, 0, $bmp.Size); $g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
# The taskbar, IF it is the top window at its own centre (over the capture), as "x y w h" — else nothing.
$t = [N]::FindWindow('Shell_TrayWnd', $null)
if ($t -ne [IntPtr]::Zero) {
  $r = New-Object N+R; [void][N]::GetWindowRect($t, [ref]$r)
  $c = New-Object N+P; $c.X = [int](($r.L + $r.Rt) / 2); $c.Y = [int](($r.T + $r.B) / 2)
  if ([N]::GetAncestor([N]::WindowFromPoint($c), 2) -eq $t) { Write-Output "TASKBAR $($r.L) $($r.T) $($r.Rt - $r.L) $($r.B - $r.T)" }
}
`);
// THE TASKBAR, when Windows draws it OVER the app's fullscreen output (seen 2026-11-25 on the primary display: the
// app's window is fullscreen but not topmost, and from that afternoon the taskbar stayed on top of it — A and A2
// carried it, the engine's TOPMOST window covers it: 92 160 pixels, exactly the taskbar's 1920x48). Not the output's
// pixels, so once a capture SEES it on top (asked of Windows, not guessed from the pixels) its rect is left out of
// every comparison, on both sides — and the run says so.
const MASKED = [];
const noteTaskbar = (out) => {
  const m = /TASKBAR (-?\d+) (-?\d+) (\d+) (\d+)/.exec(out || '');
  if (!m) return;
  const r = { x: +m[1] - disp.b.x, y: +m[2] - disp.b.y, w: +m[3], h: +m[4] };
  if (MASKED.some((q) => q.x === r.x && q.y === r.y && q.w === r.w && q.h === r.h)) return;
  MASKED.push(r);
  console.log(`     the taskbar is drawn over the capture (${r.w}x${r.h} at ${r.x}, ${r.y}) — left out of the comparisons`);
};
const capture = (name, region = REGION) => new Promise((res) => {
  const f = path.join(WORK, `${name}.png`);
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CAP, '-Out', f], { windowsHide: true, encoding: 'utf8' }, (_e, out) => {
    noteTaskbar(out);
    res(crop(PNG.sync.read(fs.readFileSync(f)), region));
  });
});
const masked = (a, i) => { if (!MASKED.length) return false; const x = (i / 4) % a.width + (a.ox ?? 0), y = Math.floor(i / 4 / a.width) + (a.oy ?? 0); return MASKED.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h); };
const diff = (a, b) => { let n = 0, max = 0; for (let i = 0; i < a.data.length; i += 4) { if (masked(a, i)) continue; let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.data[i + k] - b.data[i + k])); if (d) n++; max = Math.max(max, d); } return { n, max, of: a.data.length / 4 }; };
// A capture held to `ref`, RETAKEN while it differs (up to 4 times, 4 s apart): a fullscreen D3D window that has just
// appeared gets the NVIDIA app's own toast ("Alt+Z to open the overlay", top right, ~10 s) drawn OVER it by the
// system — not our pixels (seen 2026-11-25: 23 662 pixels by up to 231, exactly that box). A difference that
// stays is ours.
async function settledCapture(name, ref, bar) {
  let c = await capture(name);
  for (let k = 0; k < 4 && !bar(diff(ref, c)); k++) { console.log(`     ${name}: differs — retaken in 4 s (a system toast over a new fullscreen window clears by itself)`); await sleep(4000); c = await capture(name); }
  return c;
}
// --windowed: the region compared — the output window's content rect, relative to the captured display.
let REGION = null, aRect = null;
// Windows 11 ROUNDS a window's corners (DWM, radius 8): the bottom two corners of the content are blended with
// whatever is behind the window — the desktop, different once the window has moved (measured: 14 pixels in the
// bottom-right 8×8, by up to 6). Not the output's pixels, so both corners are blacked out of both sides.
const DWM_CORNER = 8;
const crop = (a, r) => {
  if (!r) return a;
  const o = new PNG({ width: r.w, height: r.h });
  o.ox = r.x; o.oy = r.y;   // where it sits on the display (MASKED)
  for (let y = 0; y < r.h; y++) a.data.copy(o.data, y * r.w * 4, ((r.y + y) * a.width + r.x) * 4, ((r.y + y) * a.width + r.x + r.w) * 4);
  for (let y = r.h - DWM_CORNER; y < r.h; y++) for (const x0 of [0, r.w - DWM_CORNER]) o.data.fill(0, (y * r.w + x0) * 4, (y * r.w + x0 + DWM_CORNER) * 4);
  return o;
};
// The engine's latest word on where its windowed output is (open, or a reported move), display-relative.
const engineRect = (child, after = 0) => {
  const l = child.lines.filter((x) => x.at >= after && /output 'sP' windowed, \d+x\d+ at \(-?\d+, -?\d+\)/.test(x.l)).pop();
  const m = l && /(\d+)x(\d+) at \((-?\d+), (-?\d+)\)/.exec(l.l);
  return m ? { x: +m[3] - disp.b.x, y: +m[4] - disp.b.y, w: +m[1], h: +m[2] } : null;
};
// The VISIBLE top-level windows whose title ENDS with `title` (both programs title it 'ARTLux — <output>'): pid and content rect (physical). -Move dx,dy moves the one owned by
// -Pid first (SetWindowPos on its frame).
const WINPS = path.join(WORK, 'wins.ps1');
fs.writeFileSync(WINPS, `param([string]$Title, [int]$Owner = 0, [int]$Dx = 0, [int]$Dy = 0, [int]$Close = 0)
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public class W {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref PT p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public struct R { public int L, T, Rt, B; } public struct PT { public int X, Y; }
  public static List<IntPtr> Find(string t) { var o = new List<IntPtr>(); EnumWindows((h, l) => { if (IsWindowVisible(h)) { var s = new StringBuilder(256); GetWindowText(h, s, 256); if (s.ToString().EndsWith(t)) o.Add(h); } return true; }, IntPtr.Zero); return o; }
}
"@
[void][W]::SetProcessDPIAware()
foreach ($h in [W]::Find($Title)) {
  $p = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$p)
  if ($Owner -ne 0 -and $p -eq $Owner -and ($Dx -ne 0 -or $Dy -ne 0)) { $r = New-Object W+R; [void][W]::GetWindowRect($h, [ref]$r); [void][W]::SetWindowPos($h, [IntPtr]::Zero, $r.L + $Dx, $r.T + $Dy, 0, 0, 0x15) }
  if ($Close -ne 0 -and $p -eq $Owner) { [void][W]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) }
  $c = New-Object W+R; [void][W]::GetClientRect($h, [ref]$c); $o = New-Object W+PT; [void][W]::ClientToScreen($h, [ref]$o)
  Write-Output "$p $($o.X) $($o.Y) $($c.Rt) $($c.B)"
}
`);
const wins = async (title, pid = 0, dx = 0, dy = 0, close = 0) => (await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WINPS, '-Title', title, '-Owner', String(pid), '-Dx', String(dx), '-Dy', String(dy), '-Close', String(close)]))
  .split(/\r?\n/).filter((l) => l.trim()).map((l) => { const [p, x, y, w, h] = l.trim().split(/\s+/).map(Number); return { pid: p, x, y, w, h }; });
// --ndi: one frame of the source 'ArtLux — Projected', received through the app's own addon in a child process
// (uncapped). Waits for the source, then keeps the LAST frame of ~2 s; also reports how many sources carry the name.
const NDI_NAME = 'ArtLux — Projected';
const RECV = path.join(WORK, 'ndi-recv.cjs');
fs.writeFileSync(RECV, `const a = require(${JSON.stringify(path.join(ROOT, 'native', 'ndi', 'ndi.node'))});
const fs = require('fs'); const out = process.argv[2]; const want = ${JSON.stringify(NDI_NAME)};
a.setRecvCap(8192, 8192);
const t0 = Date.now(); let src = null, n = 0, last = null;
const tick = () => {
  if (!src) {
    const all = a.listSources().filter((x) => x.endsWith('(' + want + ')'));
    n = all.length; if (all.length) { src = all[0]; try { a.recvConnect(src); } catch (e) { src = null; } }
    if (!src && Date.now() - t0 > 20000) { fs.writeFileSync(out + '.json', JSON.stringify({ n, frames: 0 })); process.exit(0); }
    return setTimeout(tick, 300);
  }
  const f = a.recvFrame(); if (f) last = f;
  if (last && Date.now() - t0 > 4000) {
    n = a.listSources().filter((x) => x.endsWith('(' + want + ')')).length;
    fs.writeFileSync(out, Buffer.from(last.data)); fs.writeFileSync(out + '.json', JSON.stringify({ n, w: last.width, h: last.height, sw: last.srcWidth, sh: last.srcHeight }));
    process.exit(0);
  }
  if (Date.now() - t0 > 30000) { fs.writeFileSync(out + '.json', JSON.stringify({ n, frames: 0 })); process.exit(0); }
  setTimeout(tick, 15);
};
tick();`);
const BS = String.fromCharCode(92);
const NDI_DIRS = [process.env.NDI_RUNTIME_DIR_V6, process.env.NDI_RUNTIME_DIR_V5, ['C:', 'Program Files', 'NDI', 'NDI 6 Runtime', 'v6'].join(BS),
  process.env.NDI_SDK_DIR ? path.join(process.env.NDI_SDK_DIR, 'Bin', 'x64') : null].filter((d) => d && fs.existsSync(d));
const ndiGrab = (name) => new Promise((res) => {
  const f = path.join(WORK, `ndi-${name}.rgba`);
  try { fs.unlinkSync(f + '.json'); } catch { /* */ }
  execFile(process.execPath, [RECV, f], { windowsHide: true, env: { ...process.env, PATH: [...NDI_DIRS, process.env.PATH].join(';') } }, (e, _o, err) => {
    let meta = null; try { meta = JSON.parse(fs.readFileSync(f + '.json', 'utf8')); } catch { /* */ }
    if (!meta) return res({ n: 0, err: (err || String(e || '')).slice(0, 300) });
    res({ ...meta, data: meta.w ? fs.readFileSync(f) : null });
  });
});
const ndiDiff = (a, b) => {
  if (!a?.data || !b?.data || a.w !== b.w || a.h !== b.h) return { n: -1, max: -1, of: 0 };
  let n = 0, max = 0; for (let i = 0; i < a.data.length; i += 4) { let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.data[i + k] - b.data[i + k])); if (d) n++; max = Math.max(max, d); }
  return { n, max, of: a.data.length / 4 };
};
let ndiA = null;
const lit = (a) => { let n = 0; for (let i = 0; i < a.data.length; i += 4) if (a.data[i] + a.data[i + 1] + a.data[i + 2] > 30) n++; return n / (a.data.length / 4); };

function launch(native) {
  const args = [`--user-data-dir=${PROFILE}`, ...(EDITOR ? [] : ['--broadcast']), `--project=${project}`, ...(native ? ['--native-engine'] : ['--no-native-engine'])];
  const env = native && HOLD ? { ...env0, ARTLUX_NO_APP_PROJECTOR: '1', ARTLUX_ENGINE_TEST_RESTART_MS: '9000' } : env0;
  const child = PACKAGED
    ? spawn(PACKAGED, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('npm.cmd', ['run', 'dev', '--', '--', ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  child.lines = [];
  const take = (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) child.lines.push({ at: Date.now(), l: l.trim() }); };
  child.stdout.on('data', take); child.stderr.on('data', take);
  running.push(child);
  return child;
}
const said = (child, re) => child.lines.find((x) => re.test(x.l));
async function waitFor(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(200); } return false; }
const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { windowsHide: true, encoding: 'utf8' }, (e, out) => res(out || '')));
const running = [];
async function stopAll() {
  // THIS RUN'S trees only (the app, its engine and GPU / renderer children), by pid.
  for (const c of running.splice(0)) await run('taskkill', ['/PID', String(c.pid), '/F', '/T']);
  await sleep(2500);
}

(async () => {
  let fails = 0;
  const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
  try {
    {
      fs.rmSync(PROFILE, { recursive: true, force: true }); fs.mkdirSync(PROFILE, { recursive: true });
      fs.writeFileSync(PREFS, JSON.stringify(calibFile ? { calibrationFile: calibFile } : {}, null, 2));
    }
    if (BAKED) console.log(`BAKED: the output plays ${calibFile}`);
    console.log(`display ${disp.id} ${disp.b.width}x${disp.b.height} at (${disp.b.x}, ${disp.b.y}) · ${project} · ${PACKAGED ? `packaged ${PACKAGED}` : 'dev (npm run dev)'}`);
    // ── A. the app's own projector window ───────────────────────────────────────────────────────────
    let app = launch(false);
    await waitFor(() => said(app, /\[open\]/), 120000);
    await sleep(12000);
    let A = await capture('A-app', null);
    const Afull = A;
    if (WINDOWED) {
      const w = (await wins('Wall')).filter((x) => x.pid !== 0);
      ok(w.length === 1, `A. the app shows its windowed output in one window (${w.map((x) => `${x.w}x${x.h} at ${x.x}, ${x.y}`).join('; ') || 'none'})`);
      if (w[0]) { aRect = { x: w[0].x - disp.b.x, y: w[0].y - disp.b.y, w: w[0].w, h: w[0].h }; A = crop(Afull, aRect); }
    }
    ok(lit(A) > 0.3, `A. the app's projector output is on the screen (${(100 * lit(A)).toFixed(0)}% of it lit)`);
    if (HWWARP) {
      // The keystone + soft edges leave ~18% of the screen dark (82% lit, measured); drawn FLAT for the scanout, the
      // whole screen is picture. (Not one corner pixel: the test picture's own top-left is near black.)
      const flat = lit(A) > 0.97;
      ok(!!said(app, /\[nvwarp\] PRETEND/) && (PRETEND ? flat : !flat), PRETEND
        ? `A. NVAPI owns the output (pretended) — the app's window draws it FLAT for the scanout (${(100 * lit(A)).toFixed(0)}% lit)`
        : `A. no NVAPI — the app ignores hwWarp and draws the GLSL keystone (${(100 * lit(A)).toFixed(0)}% lit)`);
    }
    if (NDI) {
      ndiA = await ndiGrab('A-app');
      ok(!!ndiA.data && ndiA.n === 1, `A. the app sends the output as NDI '${NDI_NAME}' (${ndiA.data ? `${ndiA.w}x${ndiA.h}, ${ndiA.n} source(s)` : `nothing received${ndiA.err ? `: ${ndiA.err}` : ''}`})`);
    }
    await stopAll();

    // ── B. the engine's window ───────────────────────────────────────────────────────────────────────
    app = launch(true);
    if (CALIB_REFUSED) {
      // What the engine does not draw is REFUSED, with its reason — and the app's window stays the picture.
      const kept = await waitFor(() => said(app, /keeps the projector outputs: output 'Wall': calibrated and sent as NDI/), 60000);
      ok(kept && !said(app, /\[engine\] owns the projector outputs/), `B. a calibrated output sent as NDI without a residual warp stays the app's, with the reason (${(said(app, /keeps the projector outputs/) || { l: 'no answer' }).l})`);
      await sleep(12000);
      const K = await capture('B-kept');
      const dK = diff(A, K);
      // The app's own three.js render, twice: within 1 at an MSAA edge (see A2).
      ok(dK.max <= 1 && dK.n <= dK.of * 0.0001, `B. ...and the screen is still the app's (${dK.n} pixels differ, max ${dK.max})`);
      await stopAll();
      console.log(fails ? `\nNATIVE PROJECTORS FAILED: ${fails}` : '\nNATIVE PROJECTORS OK');
      process.exit(fails ? 1 : 0);
    }
    const OWNS = PARTIAL ? /\[engine\] owns projector output\(s\) 'sP' \(document \d+\) — the app keeps the others: output 'Other': no display chosen/ : /\[engine\] owns the projector outputs/;
    const owned = await waitFor(() => said(app, OWNS), 120000);
    ok(owned, `B. main logged the engine owning the projector output${PARTIAL ? " 'Wall' — and the app keeping 'Other', with its reason" : 's'}${owned ? '' : ` — ${(said(app, /keeps the|owns /) || { l: 'no answer' }).l}`}`);
    await sleep(6000);
    if (WINDOWED) {
      const said = engineRect(app);
      ok(!!said, `B. the engine opened a WINDOWED output${said ? ` (it says ${said.w}x${said.h} at ${said.x}, ${said.y})` : ''}`);
      const ePid = Number(/\(pid (\d+)/.exec(app.lines.filter((x) => /\[engine\] up \(pid/.test(x.l)).pop()?.l ?? '')?.[1]);
      const w = await wins('Wall');
      ok(w.length === 1 && w[0].pid === ePid, `B. ONE visible window carries the output, the engine's — the app's is hidden (${w.map((x) => `pid ${x.pid} ${x.w}x${x.h} at ${x.x}, ${x.y}`).join(', ') || 'none'}; engine ${ePid})`);
      // WHERE IT IS, read off the screen (not its first log line — main lays windowed outputs out after they open).
      if (w[0]) REGION = { x: w[0].x - disp.b.x, y: w[0].y - disp.b.y, w: w[0].w, h: w[0].h };
      ok(!!REGION && !!aRect && REGION.x === aRect.x && REGION.y === aRect.y && REGION.w === aRect.w && REGION.h === aRect.h, `B. ...exactly where the app's window was (app ${aRect ? `${aRect.w}x${aRect.h} at ${aRect.x}, ${aRect.y}` : '?'})`);
      if (aRect) A = crop(Afull, aRect);
    }
    const bar0 = (d) => BAKED && !MP4 ? d.n === 0 : d.max <= 1 && d.n <= d.of * (MP4 ? 0.001 : 0.0001);
    const B = await settledCapture('B-engine', A, bar0);
    ok(lit(B) > 0.3, `B. the engine's window shows the output (${(100 * lit(B)).toFixed(0)}% of the screen lit)`);
    // THE ENGINE'S WINDOW AGAINST THE APP'S OWN (run A — the app alone, nothing else on the screen). A2 at
    // the end shows that reference is sound: the app equals itself across launches.
    // The bar, per path, as MEASURED once the comparison was honest (2026-11-22):
    //   - a baked map: IDENTICAL;
    //   - the plain warp (a still): within 1 on at most 0.01% — 11 pixels by 1 on this rig, all in the
    //     bottom soft-edge band (the share is read off the mesh-interpolated coordinate, under 4x MSAA;
    //     the map path reads raster space without MSAA and is identical). Not chased yet;
    //   - an MP4: within 1 on at most 0.1% — the conversion is Chromium's within 1 (test:mp4-parity).
    // --calib-occlude: content projected from ANOTHER, steeply angled projector — a texture coordinate one float
    // step apart flips a quantised bilinear weight now and then (measured: the same 22 pixels of 2 073 600, by ≤ 2,
    // with occlusion ON or OFF, and unchanged by rewriting the engine's matrix product or its divide — FXC compiles
    // the app's HLSL and the engine's differently). The occlusion itself adds nothing: with it, a subset (16).
    const SLACK = CALIB_OCCLUDE ? 2 : 1;
    const bar = (d) => BAKED && !MP4 ? d.n === 0 : d.max <= SLACK && d.n <= d.of * (MP4 ? 0.001 : 0.0001);
    const dAB = diff(A, B);
    if (NDI) {
      const nB = await ndiGrab('B-engine');
      ok(said(app, /NDI send 'ArtLux — Projected' up/) && said(app, /\[ndi\] the engine sends 1 projector output/), `B. the ENGINE sends the NDI source and the app's sender stood down (${said(app, /NDI send '.*' up/)?.l ?? 'the engine did not say'})`);
      ok(nB.n === 1, `B. exactly ONE source named '${NDI_NAME}' (${nB.n})`);
      const d = ndiDiff(ndiA, nB);
      ok(d.n === 0, `B. THE ENGINE'S NDI FRAME = THE APP'S: ${d.n < 0 ? `not comparable (app ${ndiA?.w}x${ndiA?.h}, engine ${nB.w}x${nB.h})` : `${d.of - d.n} of ${d.of} pixels identical (max ${d.max})`}`);
    }
    ok(bar(dAB), `THE ENGINE'S WINDOW = THE APP'S: ${dAB.of - dAB.n} of ${dAB.of} pixels identical (max difference ${dAB.max})${BAKED && !MP4 ? '' : ` — within ${SLACK} allowed`}`);

    // ── C. the engine dies → the app's window, uncovered ──────────────────────────────────────────────
    // OUR engine: the pid main logged for this run (never "the first artlux-engine" on the machine).
    const ups = app.lines.filter((x) => /\[engine\] up \(pid (\d+)/.test(x.l));
    const pid = Number(/\(pid (\d+)/.exec(ups[ups.length - 1]?.l ?? '')?.[1]);
    // --windowed: the operator MOVES the engine's window — the engine reports it once it settles, main puts the app's
    // hidden window there, and the engine restarted below must open at the moved place.
    let moved = null;
    if (WINDOWED && REGION) {
      const t0 = Date.now();
      await wins('Wall', pid, 90, 50);
      await waitFor(() => { const r = engineRect(app, t0); return r && r.x === REGION.x + 90 && r.y === REGION.y + 50; }, 5000);
      moved = engineRect(app, t0);
      ok(!!moved && moved.x === REGION.x + 90 && moved.y === REGION.y + 50 && moved.w === REGION.w && moved.h === REGION.h, `C. a move of the engine's window is reported (${moved ? `${moved.w}x${moved.h} at ${moved.x}, ${moved.y}` : 'nothing'})`);
      await sleep(1000);
    }
    const killedAt = Date.now();
    try { process.kill(pid, 'SIGKILL'); } catch (e) { console.log(`     kill: ${e.message}`); }
    await waitFor(() => app.lines.some((x) => x.at > killedAt && /the app keeps the projector outputs: the engine exited/.test(x.l)), 5000);
    const back = app.lines.find((x) => x.at > killedAt && /the app keeps the projector outputs/.test(x.l));
    ok(!!back, `C. engine killed: main uncovered the app's windows${back ? ` (${back.at - killedAt} ms after the kill)` : ''}`);
    if (HOLD) {
      // The restart is held off (9 s): the screen now shows what the app's window shows — and that draws nothing of
      // its own, so it can only be the engine's last picture, handed over by main.
      const said = app.lines.find((x) => x.at > killedAt && /\[engine\] holding the last picture on (\d+) of (\d+) projector/.test(x.l));
      ok(!!said && /on 1 of 1/.test(said.l), `C. main hands the app's window the engine's last picture (${said ? said.l : 'nothing said'})`);
      await sleep(1500);
      if (moved) REGION = moved;   // --windowed: the app's window followed the operator's move (main placed it there)
      const H = await capture('C-held');
      const dH = diff(B, H);
      ok(dH.n === 0, `C. WHAT THE ROOM SEES AFTER THE DEATH = THE ENGINE'S LAST PICTURE: ${dH.of - dH.n} of ${dH.of} pixels identical (max ${dH.max}) — and the app's window draws nothing of its own`);
    }
    // ⚠ NO CAPTURE OF "THE APP'S WINDOW AGAIN" HERE. One used to be taken ~0.4 s after the kill and held up as
    // the app's uncovered window — and the engine was judged against it. A capture takes PowerShell about a
    // second to start, and by then main has RESTARTED the engine, topmost again: that capture was the
    // ENGINE'S window, so "the engine = the app" compared the engine with ITSELF (found 2026-11-22: a copy
    // shifted by one pixel still passed, and the shot 3 s later was the same picture). What it can say is
    // main's log, above. The app's window is judged where nothing else can be on the screen: run A, and A2.
    const retook = await waitFor(() => app.lines.some((x) => x.at > killedAt && OWNS.test(x.l)), 15000);
    ok(retook, 'C. the restarted engine takes the projector outputs back');
    if (NDI) {
      ok(app.lines.some((x) => x.at > killedAt && /\[ndi\] the app sends 1 projector output\(s\) again/.test(x.l)), "C. engine killed: the app's NDI sender came back");
      const nD = await ndiGrab('D-engine');
      const d = ndiDiff(ndiA, nD);
      ok(nD.n === 1 && d.n === 0, `C. ...and the restarted engine's NDI frame = the app's again (${nD.n} source(s); ${d.n < 0 ? 'not comparable' : `${d.of - d.n} of ${d.of}, max ${d.max}`})`);
    }
    await sleep(3000);
    if (moved) {
      const again = engineRect(app, killedAt);
      ok(!!again && again.x === moved.x && again.y === moved.y && again.w === moved.w && again.h === moved.h, `C. ...and opens where the operator had moved it — the app's hidden window followed (${again ? `${again.w}x${again.h} at ${again.x}, ${again.y}` : 'not opened'})`);
      REGION = again ?? moved;
    }
    const D = await settledCapture('D-engine-again', A, bar);
    const dD = diff(A, D);
    // MP4: within 1 (the conversion is Chromium's within 1 — test:mp4-parity).
    ok(bar(dD), `C. ...and the restarted engine's window = the app's (A) again (${dD.of - dD.n} of ${dD.of}, max ${dD.max})`);
    // --windowed: the operator CLOSES the engine's window from its title bar = closing the app's. In broadcast, closing
    // the last output by hand ends the show (main/index.ts) — the app quits, as it does when its own window is closed.
    if (WINDOWED) {
      const ups2 = app.lines.filter((x) => /\[engine\] up \(pid (\d+)/.test(x.l));
      const pid2 = Number(/\(pid (\d+)/.exec(ups2[ups2.length - 1]?.l ?? '')?.[1]);
      let exited = false; app.once('exit', () => { exited = true; });
      await wins('Wall', pid2, 0, 0, 1);
      const quit = await waitFor(() => exited, 15000);
      ok(quit, `C. closing the engine's window from its title bar closes the output — in broadcast the app quits, as for its own window${quit ? '' : ` (still running; ${(said(app, /closed from its title bar/) || { l: 'the engine did not say it was closed' }).l})`}`);
    }
    fs.writeFileSync(path.join(WORK, 'last-run.log'), app.lines.map((x) => x.l).join('\n'));
    await stopAll();

    // ── A2. the app alone AGAIN — is run A a sound reference? ─────────────────────────────────────────
    app = launch(false);
    await waitFor(() => said(app, /\[open\]/), 120000);
    await sleep(12000);
    let A2 = await capture('A2-app', null);
    if (WINDOWED) { const w = (await wins('Wall'))[0]; A2 = w ? crop(A2, { x: w.x - disp.b.x, y: w.y - disp.b.y, w: w.w, h: w.h }) : A2; }
    const dAA = diff(A, A2);
    // --calibrated: the app's three.js render is NOT bit-stable across launches at an MSAA edge (measured: 0 one run,
    // 1 pixel by 1 the next, same build) — so there the reference is held to the engine's own bar, within 1.
    const a2ok = CALIBRATED ? dAA.max <= 1 && dAA.n <= dAA.of * 0.0001 : dAA.n === 0;
    ok(a2ok, `A2. the app's window equals itself across two launches (${dAA.n} pixels differ, max ${dAA.max})${CALIBRATED ? ' — within 1 allowed (three.js MSAA edges)' : ''} — so A is the reference`);
    await stopAll();
  } catch (e) {
    fails++; console.log(`FAIL ${e.stack || e}`);
    await stopAll();
  }
  console.log(fails ? `\nNATIVE PROJECTORS FAILED: ${fails}` : '\nNATIVE PROJECTORS OK');
  process.exit(fails ? 1 : 0);
})();
