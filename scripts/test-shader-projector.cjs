#!/usr/bin/env node
// E2 — A SHADER ON A PROJECTOR OUTPUT, drawn by the native engine, read from the SCREEN (Windows).
//
//   node scripts/test-shader-projector.cjs --packaged <ArtLux.exe> [--text]
//
// ⚠ IT COVERS THE PRIMARY DISPLAY with a fullscreen projector output, twice, for ~15 s each.
//
// ArtLux in BROADCAST mode on its own project: a STILL shader on a surface, one projector output on the
// primary display with a keystone, a soft edge, colour gain and black lift. The app's projector window runs
// its own copy of the shader at the display's size (shaderDrawable.sizeFor, windowKind 'projector'); the
// engine does the same with a second runner sized from the display main reports (engineHost `css`).
//   A. without --native-engine: the app's projector window — the reference;
//   B. with it: main logs that the engine owns the projector outputs, and the screen must equal A within 1.
// SCRATCH profile (its prefs are written there — the operator's are never touched); only this test's own
// process tree is closed.
const { spawn, execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const ROOT = path.resolve(__dirname, '..');
const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-shader-projector.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const WORK = path.join(os.tmpdir(), 'artlux-shader-projector');
const PROFILE = path.join(WORK, 'profile');
fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEXT = process.argv.includes('--text');
const env0 = { ...process.env }; delete env0.ELECTRON_RUN_AS_NODE;

// The primary display, as Electron names it.
fs.writeFileSync(path.join(WORK, 'disp.cjs'), "const { app, screen } = require('electron'); app.whenReady().then(() => { const d = screen.getPrimaryDisplay(); console.log(JSON.stringify({ id: d.id, b: screen.dipToScreenRect(null, d.bounds) })); app.quit(); });");
const disp = JSON.parse(execFileSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [path.join(WORK, 'disp.cjs')], { env: env0, encoding: 'utf8', input: '', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split(/\r?\n/).pop());

// A STILL shader (no time): a gradient, rings and a 1-px grid — detail a wrong raster size would blur.
const SHADER = `vec4 shaderColor(vec2 uv) {
  vec2 p = uv * iResolution.xy;
  float grid = (mod(floor(p.x), 64.0) < 1.0 || mod(floor(p.y), 48.0) < 1.0) ? 1.0 : 0.0;
  float ring = 0.5 + 0.5 * cos(length(uv - 0.5) * 60.0);
  return vec4(mix(vec3(uv.x, uv.y, ring), vec3(1.0), grid), 1.0);
}`;
const project = path.join(WORK, 'shader-projector.artlux');
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [{ id: 'sP', name: 'Projected', x: 0.1, y: 0.1, width: 0.5, height: 0.28125, rotation: 0, zIndex: 0, content: TEXT
    // --text: a TEXT surface instead (E2 text — a raster the app draws; the projector copy at the display's size).
    ? { type: 'TEXT', textBody: 'ArtLux on the wall — small type 12345', textWrap: true, textSize: 0.18, textColor: '#ffe680', textStrokeColor: '#2040ff', textStrokeWidth: 0.01, opacity: 1 }
    : { type: 'SHADER', shaderSource: SHADER, opacity: 1 } }],
  fixtures: [], controllers: [], groups: [], scenes: [], cueBanks: [],
  projectorBrightness: 0.9,
  projectorOutputs: [{
    surfaceId: 'sP', name: 'Wall', enabled: true, displayId: disp.id,
    cornerPin: { tl: [0.05, 0.1], tr: [0.93, 0.02], br: [0.97, 0.95], bl: [0.02, 0.88] },
    softEdge: { left: 0.15, right: 0, top: 0, bottom: 0.1, gamma: 2.2 }, gamma: 1, colorGain: [1, 0.95, 0.9], blackLift: [0.01, 0.01, 0.02],
  }],
}, null, 2));

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
const diff = (a, b) => { let n = 0, max = 0; for (let i = 0; i < a.data.length; i += 4) { let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.data[i + k] - b.data[i + k])); if (d > 1) n++; max = Math.max(max, d); } return { n, max, of: a.data.length / 4 }; };
const lit = (a) => { let n = 0; for (let i = 0; i < a.data.length; i += 4) if (a.data[i] + a.data[i + 1] + a.data[i + 2] > 30) n++; return n / (a.data.length / 4); };

async function runOnce(native) {
  fs.rmSync(PROFILE, { recursive: true, force: true }); fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'artlux-prefs.json'), JSON.stringify({ appSettings: { outputEnabled: false } }));
  const child = spawn(EXE, [`--user-data-dir=${PROFILE}`, '--broadcast', `--project=${project}`, ...(native ? ['--native-engine'] : [])], { env: env0, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const take = (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) lines.push(l.trim()); };
  child.stdout.on('data', take); child.stderr.on('data', take);
  try {
    await sleep(14000);
    return { shot: await capture(native ? 'engine' : 'app'), lines };
  } finally {
    await new Promise((r) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => r()));
    await sleep(2500);
  }
}

(async () => {
  let fails = 0;
  const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
  const A = await runOnce(false);
  // Type covers far less of the screen than a full-frame shader does.
  ok(lit(A.shot) > (TEXT ? 0.02 : 0.3), `A: the app's projector window shows the ${TEXT ? 'text' : 'shader'} (${(100 * lit(A.shot)).toFixed(0)}% of the screen lit)`);
  const B = await runOnce(true);
  const owns = B.lines.find((l) => /owns the projector outputs/i.test(l));
  ok(!!owns, `B: the engine owns the projector outputs${owns ? '' : ' — ' + (B.lines.find((l) => /keeps the projector/.test(l)) || 'no word from main')}`);
  const shaderLine = B.lines.find((l) => TEXT ? /sources: .*=raster/.test(l) : /shader drawn by the engine/.test(l));
  ok(!!shaderLine, `B: ${shaderLine || (TEXT ? 'the engine was never given the text raster' : 'the engine never drew the shader')}`);
  const d = diff(A.shot, B.shot);
  ok(d.n / d.of < 0.0001, `B = A on screen: ${d.n} of ${d.of} pixels differ by more than 1 (max ${d.max})`);
  const what = TEXT ? 'text' : 'shader';
  console.log(fails ? `\n${what} projector: ${fails} FAILED` : `\n${what} projector OK`);
  process.exit(fails ? 1 : 0);
})();
