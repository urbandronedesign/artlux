#!/usr/bin/env node
// E1f-3 THE NATIVE ENGINE TAKES THE PROJECTOR OUTPUTS — in the REAL app (Windows), read from the SCREEN.
//
//   node scripts/test-native-projectors.cjs
//
// ⚠ IT COVERS DISPLAY 0 (the primary) with a fullscreen projector output, three times, for ~15 s each.
//
// ArtLux in BROADCAST mode (projector outputs are its only windows; headless suppresses them) on its own
// project: one still on a surface, one projector output on display 0 with a keystone, a soft edge, a gamma,
// colour gain + black lift and a projector brightness — everything the plain warp path does. Then:
//   A. without --native-engine: the app's projector window — the screen is the reference;
//   B. with it: the engine's TOPMOST window shows the output (main logs `owns the projector outputs`);
//   C. kill the engine: the app's window — open underneath, COVERED — is uncovered and draws; the screen
//      then must equal B pixel for pixel (the engine's window and the app's, in ONE session), and the
//      restarted engine takes the outputs back (identical again).
// Nothing synchronous runs while ArtLux does: in dev its stdout is piped here, and on Windows a blocked
// reader blocks the writer (E1f-1). Prefs are backed up and restored.

const { spawn, execFile, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'artlux-native-projectors');
fs.mkdirSync(WORK, { recursive: true });
const PREFS = path.join(process.env.APPDATA, 'ArtLux', 'artlux-prefs.json');
const PREFS_BAK = path.join(WORK, 'prefs.backup.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));
const env0 = { ...process.env }; delete env0.ELECTRON_RUN_AS_NODE;

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
const project = path.join(WORK, 'projectors.artlux');
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [{ id: 'sP', name: 'Projected', x: 0.1, y: 0.1, width: 0.5, height: 0.28125, rotation: 0, zIndex: 0, content: { type: 'IMAGE', url: picture, opacity: 1 } }],
  fixtures: [], controllers: [], groups: [], scenes: [], cueBanks: [],
  projectorBrightness: 0.9,
  projectorOutputs: [{
    surfaceId: 'sP', name: 'Wall', enabled: true, displayId: disp.id,
    cornerPin: { tl: [0.05, 0.1], tr: [0.93, 0.02], br: [0.97, 0.95], bl: [0.02, 0.88] },
    softEdge: { left: 0.15, right: 0, top: 0, bottom: 0.1, gamma: 2.2 }, gamma: 1, colorGain: [1, 0.95, 0.9], blackLift: [0.01, 0.01, 0.02],
  }],
}, null, 2));

// ── the screen, captured asynchronously ───────────────────────────────────────────────────────────────
const CAP = path.join(WORK, 'cap.ps1');
fs.writeFileSync(CAP, `param([string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type -Name D -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][N.D]::SetProcessDPIAware()
$bmp = New-Object System.Drawing.Bitmap ${disp.b.width}, ${disp.b.height}
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(${disp.b.x}, ${disp.b.y}, 0, 0, $bmp.Size); $g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
`);
const capture = (name) => new Promise((res) => {
  const f = path.join(WORK, `${name}.png`);
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CAP, '-Out', f], { windowsHide: true }, () => res(PNG.sync.read(fs.readFileSync(f))));
});
const diff = (a, b) => { let n = 0, max = 0; for (let i = 0; i < a.data.length; i += 4) { let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.data[i + k] - b.data[i + k])); if (d) n++; max = Math.max(max, d); } return { n, max, of: a.data.length / 4 }; };
const lit = (a) => { let n = 0; for (let i = 0; i < a.data.length; i += 4) if (a.data[i] + a.data[i + 1] + a.data[i + 2] > 30) n++; return n / (a.data.length / 4); };

function launch(native) {
  const args = ['--broadcast', `--project=${project}`, ...(native ? ['--native-engine'] : [])];
  const child = spawn('npm.cmd', ['run', 'dev', '--', '--', ...args], { cwd: ROOT, env: env0, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  child.lines = [];
  const take = (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) child.lines.push({ at: Date.now(), l: l.trim() }); };
  child.stdout.on('data', take); child.stderr.on('data', take);
  return child;
}
const said = (child, re) => child.lines.find((x) => re.test(x.l));
async function waitFor(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(200); } return false; }
const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { windowsHide: true, encoding: 'utf8' }, (e, out) => res(out || '')));
async function stopAll() {
  await run('taskkill', ['/IM', 'electron.exe', '/F', '/T']);
  await run('taskkill', ['/IM', 'artlux-engine.exe', '/F', '/T']);
  await sleep(2500);
}

(async () => {
  let fails = 0;
  const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
  const hadPrefs = fs.existsSync(PREFS);
  if (hadPrefs) fs.copyFileSync(PREFS, PREFS_BAK);
  try {
    console.log(`display ${disp.id} ${disp.b.width}x${disp.b.height} at (${disp.b.x}, ${disp.b.y}) · ${project}`);
    // ── A. the app's own projector window ───────────────────────────────────────────────────────────
    let app = launch(false);
    await waitFor(() => said(app, /\[open\]/), 120000);
    await sleep(12000);
    const A = await capture('A-app');
    ok(lit(A) > 0.3, `A. the app's projector output is on the screen (${(100 * lit(A)).toFixed(0)}% of it lit)`);
    await stopAll();

    // ── B. the engine's window ───────────────────────────────────────────────────────────────────────
    app = launch(true);
    const owned = await waitFor(() => said(app, /\[engine\] owns the projector outputs/), 120000);
    ok(owned, `B. main logged the engine owning the projector outputs${owned ? '' : ` — ${(said(app, /keeps the projector outputs/) || { l: 'no answer' }).l}`}`);
    await sleep(6000);
    const B = await capture('B-engine');
    ok(lit(B) > 0.3, `B. the engine's window shows the output (${(100 * lit(B)).toFixed(0)}% of the screen lit)`);

    // ── C. the engine dies → the app's window, uncovered ──────────────────────────────────────────────
    const pidOut = await run('powershell', ['-NoProfile', '-Command', '(Get-Process artlux-engine | Select-Object -First 1).Id']);
    const pid = Number(pidOut.trim());
    const killedAt = Date.now();
    try { process.kill(pid, 'SIGKILL'); } catch (e) { console.log(`     kill: ${e.message}`); }
    await waitFor(() => app.lines.some((x) => x.at > killedAt && /the app keeps the projector outputs: the engine exited/.test(x.l)), 5000);
    const back = app.lines.find((x) => x.at > killedAt && /the app keeps the projector outputs/.test(x.l));
    ok(!!back, `C. engine killed: main uncovered the app's windows${back ? ` (${back.at - killedAt} ms after the kill)` : ''}`);
    await sleep(400);
    const C = await capture('C-app-again');
    // THE IDENTITY IS JUDGED IN ONE SESSION: the engine's window (B) against the app's own window in the
    // same run (C, uncovered). Two LAUNCHES of the app itself differ (A vs C below: measured 11 pixels by 1
    // level, all inside the soft-edge band) — the app is not bit-stable across launches there, so a
    // reference from another launch cannot hold the engine to "identical".
    const dBC = diff(B, C);
    ok(lit(C) > 0.3, `C. ~0.4 s after the kill the app's own window is on the screen again (${(100 * lit(C)).toFixed(0)}% lit)`);
    ok(dBC.n === 0, `THE ENGINE'S WINDOW = THE APP'S, same session: ${dBC.of - dBC.n} of ${dBC.of} pixels identical (max difference ${dBC.max})`);
    const dAC = diff(A, C);
    console.log(`     (for the record: the app against ITSELF across two launches — ${dAC.n} pixels differ, max ${dAC.max})`);
    const retook = await waitFor(() => app.lines.some((x) => x.at > killedAt && /\[engine\] owns the projector outputs/.test(x.l)), 15000);
    ok(retook, 'C. the restarted engine takes the projector outputs back');
    await sleep(3000);
    const D = await capture('D-engine-again');
    const dD = diff(C, D);
    ok(dD.n === 0, `C. ...and the restarted engine's window = the app's again (${dD.of - dD.n} of ${dD.of}, max ${dD.max})`);
    fs.writeFileSync(path.join(WORK, 'last-run.log'), app.lines.map((x) => x.l).join('\n'));
    await stopAll();
  } catch (e) {
    fails++; console.log(`FAIL ${e.stack || e}`);
    await stopAll();
  } finally {
    if (hadPrefs) fs.copyFileSync(PREFS_BAK, PREFS);
    console.log('prefs restored');
  }
  console.log(fails ? `\nNATIVE PROJECTORS FAILED: ${fails}` : '\nNATIVE PROJECTORS OK');
  process.exit(fails ? 1 : 0);
})();
