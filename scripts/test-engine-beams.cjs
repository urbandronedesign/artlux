#!/usr/bin/env node
// E4b — THE BEAMS IN THE ENGINE'S 3D VIEW (plans/native-engine.md E4; engine/artlux-engine/src/beams.rs).
//
//   node scripts/test-engine-beams.cjs --packaged <ArtLux.exe> [--keep]
//
// A rig of six heads — four MAC 250 Beams (subtractive CMY, a shutter that is OPEN only in a band) and two RGB
// washes — each parked at its own pan / tilt / colour, one of them DARK (dimmer 0). The packaged app runs with
// --native-engine on a SCRATCH profile; the test goes to the 3D context, selects one head, and opens the 3D view in
// the engine's own window. The engine resolves every light itself (lightpack.rs Head::resolve — the port of
// fixtureSignal.resolveFixture, held to it by test:light-pack-parity) and draws the beams from that. Gates:
//   - the engine's light bytes never differ from the app's (the resolve runs on the same stack);
//   - its 3D view drew FIVE beam volumes (the dark head none) and a diagram: 5 rings of 32 segments, plus the
//     selected head's axis and eight edge rays = 169 segments;
//   - the window, captured from the screen, holds the beams' colours: the red wash's red and the blue wash's
//     blue both present where the beams are (saved as engine-beams.png for a look);
//   - PICKING (E4b): real mouse clicks IN THE ENGINE WINDOW, at the screen position of a head's housing (projected
//     with the window's own camera): the engine logs the pick, the EDITOR's selection follows (its inspector
//     shows the head), and the selection comes back to the engine — the full diagram moves to the picked head;
//     a click on empty sky clears it (160 segments: rings only); Shift-click adds a second head (178);
//   - THE MOVE GIZMO (E4b): with both heads selected, a real drag on the engine window's X handle (press, pull,
//     release — OS mouse events) moves BOTH heads along X in the editor's document (read back from the saved
//     project), and nothing else; the editor's Undo puts them back; then the SCALE tool spreads the two along X
//     about their centre, and the ROTATE tool turns one head 45° about Y on its ring — each read back from the
//     saved project and undone;
//   - a click on the screen behind the rig selects that MODEL in the editor (its row in the 3D objects list) and
//     clears the fixtures; a fixture in front of a screen still wins (unit-tested in view3d.rs); its own Move
//     handle then raises it (read back from the saved project; undone);
//   - the Rendered look: solid shafts, no diagram.
// Own processes only; nothing of the owner's is read or written.
'use strict';
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const ROOT = path.resolve(__dirname, '..');
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-engine-beams.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const KEEP = process.argv.includes('--keep');
const CDP_PORT = '9377';
const WORK = path.join(os.tmpdir(), 'artlux-engine-beams');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => { http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej); });
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));

const MAC = 'martin/mac-250-beam';
const RGB = 'american-dj/inno-pocket-beam-q4';
function buildProject() {
  const fixtures = [];
  let addr = 1;
  const add = (id, name, profileId, profileMode, footprint, dmx, position3D) => {
    fixtures.push({ id, name, x: 0, y: 0, width: 0.02, height: 0.02, rotation: 0, universe: 0, startAddress: addr, ledCount: 1, reverse: false, colorData: [], profileId, profileMode, dmx, position3D, controllerId: 'ctl_dmx' });
    addr += footprint;
  };
  // Shutter OPEN is a band: 20..49 on the MAC, 8..15 on the ADJ.
  const mac = (pan, tilt, c, m, y, dimmer = 1) => ({ 'shutter-strobe': 35 / 255, dimmer, pan, tilt, 'cyan-intensity': c, 'magenta-intensity': m, 'yellow-intensity': y });
  const rgb = (r, g, b) => ({ 'shutter-strobe': 12 / 255, dimmer: 1, pan: 0.5, tilt: 0.5, red: r, green: g, blue: b, white: 0 });
  add('fx_m1', 'Mover 1', MAC, '16bt', 13, mac(0.45, 0.35, 0, 0, 0), { x: -3, y: 5, z: -4 });
  add('fx_m2', 'Mover 2', MAC, '16bt', 13, mac(0.5, 0.4, 0, 1, 1), { x: -1, y: 5, z: -4 });     // magenta+yellow flags → red
  add('fx_m3', 'Mover 3', MAC, '16bt', 13, mac(0.55, 0.45, 1, 1, 0), { x: 1, y: 5, z: -4 });     // cyan+magenta → blue
  add('fx_m4', 'Mover 4', MAC, '16bt', 13, mac(0.5, 0.4, 0, 0, 0, 0), { x: 3, y: 5, z: -4 });    // DARK
  add('fx_w1', 'Wash 1', RGB, '13ch', 13, rgb(1, 0, 0), { x: -2, y: 4, z: 2 });
  add('fx_w2', 'Wash 2', RGB, '13ch', 13, rgb(0, 0.4, 1), { x: 2, y: 4, z: 2 });
  const file = path.join(WORK, 'engine-beams.artlux');
  fs.writeFileSync(file, JSON.stringify({
    version: '1.2', timestamp: '2026-01-01T00:00:00.000Z', surfaces: [], fixtures,
    controllers: [{ id: 'ctl_dmx', name: 'Lighting interface', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, startUniverse: 0, drives: 'light' }],
    globalBrightness: 1, groups: [], scenes: [], cueBanks: [],
    // A dark screen behind the rig (E4b: a click on it selects the MODEL).
    scene3D: { models: [{ id: 'scr', name: 'Back screen', kind: 'plane', path: '', position: { x: 0, y: 3, z: -7 }, rotation: { x: 0, y: 0, z: 0 }, scale: 4, visible: true }], lightIntensity: 1, environment: true, exposure: 1, gridVisible: true, reflectiveFloor: false, trackingViz: false, augmentaViz: false, trackingSmoothing: 0.6, trackingPredictMs: 50, hazeDensity: 0.6 },
    timeline: { layers: [], clips: [], duration: 60, fps: 30, markers: [], inPoint: null, outPoint: null, loop: false, trackingTakes: [], lightingTakes: [], lightingSequences: [] },
    schedule: [], assets: [], projectorOutputs: [], projectorFpsCap: 0, projectorBrightness: 1,
  }, null, 2));
  return file;
}

/** The engine window, captured from the screen (it is a native window: CDP cannot see it). */
function captureEngineWindow(out) {
  const ps = path.join(WORK, 'capture.ps1');
  fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct R { public int L, T, Rt, B; } }
"@
[W]::SetProcessDPIAware() | Out-Null
$h = [W]::FindWindow([NullString]::Value, "ArtLux $([char]0x2014) 3D view (engine)")
if ($h -eq [IntPtr]::Zero) { Write-Output "NOWINDOW"; exit 0 }
[W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700
$r = New-Object W+R; [W]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Rt - $r.L; $hh = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save("${out.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "OK $w x $hh"
`);
  return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps}"`).toString().trim();
}

/** Real mouse clicks in the engine window, at CLIENT pixels; `shift` holds Shift. Returns the client size. */
function clickEngineWindow(points) {
  const ps = path.join(WORK, 'click.ps1');
  const body = points.map(([x, y, shift]) => `Click ${Math.round(x)} ${Math.round(y)} ${shift ? '$true' : '$false'}`).join('\n');
  fs.writeFileSync(ps, `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class C { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, int f, int e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct R { public int L, T, Rt, B; } public struct P { public int X, Y; } }
"@
[C]::SetProcessDPIAware() | Out-Null
$h = [C]::FindWindow([NullString]::Value, "ArtLux $([char]0x2014) 3D view (engine)")
if ($h -eq [IntPtr]::Zero) { Write-Output "NOWINDOW"; exit 0 }
[C]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 500
function Click($x, $y, $shift) {
  $p = New-Object C+P; $p.X = $x; $p.Y = $y; [C]::ClientToScreen($h, [ref]$p) | Out-Null
  [C]::SetCursorPos($p.X, $p.Y) | Out-Null; Start-Sleep -Milliseconds 150
  if ($shift) { [C]::keybd_event(0x10, 0, 0, 0); Start-Sleep -Milliseconds 100 }
  [C]::mouse_event(0x02, 0, 0, 0, 0); Start-Sleep -Milliseconds 60; [C]::mouse_event(0x04, 0, 0, 0, 0)
  if ($shift) { Start-Sleep -Milliseconds 100; [C]::keybd_event(0x10, 0, 2, 0) }
  Start-Sleep -Milliseconds 1500
}
${body}
Write-Output "OK"
`);
  return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps}"`).toString().trim();
}
/** A real drag in the engine window: hover at a, press, pull to b in steps, release (CLIENT pixels). */
function dragEngineWindow(a, b) {
  const ps = path.join(WORK, 'drag.ps1');
  fs.writeFileSync(ps, `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class D { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct P { public int X, Y; } }
"@
[D]::SetProcessDPIAware() | Out-Null
$h = [D]::FindWindow([NullString]::Value, "ArtLux $([char]0x2014) 3D view (engine)")
if ($h -eq [IntPtr]::Zero) { Write-Output "NOWINDOW"; exit 0 }
[D]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
function To($x, $y) { $p = New-Object D+P; $p.X = $x; $p.Y = $y; [D]::ClientToScreen($h, [ref]$p) | Out-Null; [D]::SetCursorPos($p.X, $p.Y) | Out-Null }
To ${Math.round(a[0]) - 6} ${Math.round(a[1])}; Start-Sleep -Milliseconds 120
To ${Math.round(a[0])} ${Math.round(a[1])}; Start-Sleep -Milliseconds 400
[D]::mouse_event(0x02, 0, 0, 0, 0); Start-Sleep -Milliseconds 150
for ($i = 1; $i -le 20; $i++) { To ([int](${a[0]} + (${b[0]} - ${a[0]}) * $i / 20)) ([int](${a[1]} + (${b[1]} - ${a[1]}) * $i / 20)); Start-Sleep -Milliseconds 30 }
Start-Sleep -Milliseconds 300
[D]::mouse_event(0x04, 0, 0, 0, 0)
Start-Sleep -Milliseconds 600
Write-Output "OK"
`);
  return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps}"`).toString().trim();
}
function engineClientSize() {
  const ps = path.join(WORK, 'size.ps1');
  fs.writeFileSync(ps, `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class S { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct R { public int L, T, Rt, B; } }
"@
[S]::SetProcessDPIAware() | Out-Null
$h = [S]::FindWindow([NullString]::Value, "ArtLux $([char]0x2014) 3D view (engine)")
$r = New-Object S+R; [S]::GetClientRect($h, [ref]$r) | Out-Null
Write-Output "$($r.Rt) $($r.B)"
`);
  const [w, h] = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps}"`).toString().trim().split(/\s+/).map(Number);
  return { w, h };
}
/** view3d.rs Cam: a world point → client pixels, for a camera at `eye` looking at `target` with vertical `fov`. */
function toClient(eye, target, fov, p, w, h) {
  const sub = (a, b) => a.map((x, i) => x - b[i]), dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const f = norm(sub(target, eye)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f), v = sub(p, eye);
  const z = dot(v, f), t = Math.tan((fov * Math.PI / 180) / 2);
  const x = dot(v, r) / z / t / (w / h), y = dot(v, u) / z / t;
  return [(x + 1) / 2 * w, (1 - y) / 2 * h];
}
const beamLines = (logf) => fs.readFileSync(logf, 'utf8').split(/\r?\n/).filter((l) => /3D view beams:/.test(l));
const segmentsNow = (logf) => { const l = beamLines(logf); const m = /(\d+) diagram segment/.exec(l[l.length - 1] || ''); return m ? +m[1] : -1; };

/** Poll `fn` until it is truthy (or `ms` pass) and return its last value. The engine's log reaches the file
 *  through main, so a line can land a moment after the thing it reports — judging a log on one read is a flake. */
async function settle(fn, ms = 4000) {
  let v = fn();
  for (let t = 0; !v && t < ms; t += 100) { await new Promise((r) => setTimeout(r, 100)); v = fn(); }
  return v;
}

(async () => {
  for (let i = 0; ; i++) { try { fs.rmSync(WORK, { recursive: true, force: true }); break; } catch (e) { if (i >= 20) throw e; await sleep(500); } }
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'artlux-prefs.json'), JSON.stringify({ appSettings: { outputEnabled: false } }));
  const project = buildProject();
  const logf = path.join(WORK, 'app.log');
  const log = fs.openSync(logf, 'w');
  const env = { ...process.env, ARTLUX_CDP_PORT: CDP_PORT }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--user-data-dir=${PROFILE}`, '--native-engine', `--project=${project}`], { env, stdio: ['ignore', log, log] });
  const failures = [];
  const note = (ok, label, detail) => { console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); if (!ok) failures.push(label); };
  let browser = null;
  try {
    let ver = null;
    for (let i = 0; i < 90 && !ver; i++) { try { ver = JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json/version`)); } catch { await sleep(1000); } }
    if (!ver) throw new Error('no CDP endpoint');
    browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null });
    let page = null;
    for (let i = 0; i < 60 && !page; i++) { page = (await browser.pages()).find((p) => /index\.html/.test(p.url())) ?? null; if (!page) await sleep(1000); }
    if (!page) throw new Error('no editor page');
    for (let i = 0; i < 60; i++) { if (await page.evaluate(() => !!document.querySelector('[role="tablist"] button'))) break; await sleep(1000); }
    await sleep(4000);
    // The 3D context (the rail is labelled by shortTitle).
    const rail = await page.evaluate(() => { const b = [...document.querySelectorAll('[role="tablist"] button')].find((x) => (x.textContent || '').trim() === '3D'); b?.click(); return !!b; });
    if (!rail) throw new Error('no 3D rail entry');
    await sleep(5000);
    // Select Mover 1 — it gets the whole diagram.
    const sel = await page.evaluate(() => {
      const row = [...document.querySelectorAll('div[role="button"]')].find((d) => (d.textContent || '').trim() === 'Mover 1');
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return !!row;
    });
    note(sel, 'selected Mover 1 from the browser');
    await sleep(800);
    // Back the editor's camera off so the whole rig and its beams are in frame — the engine window opens there.
    const cv = await page.evaluate(() => { const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]; const r = c?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; });
    if (cv) { await page.mouse.move(cv.x, cv.y); for (let i = 0; i < 8; i++) { await page.mouse.wheel({ deltaY: 240 }); await sleep(120); } }
    await sleep(1200);
    const opened = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /in its own window/.test(x.getAttribute('title') || '') && /^Open/.test(x.getAttribute('title') || ''));
      b?.click(); return !!b;
    });
    if (!opened) throw new Error('no "open the 3D view in its own window" button (is the engine running?)');
    await sleep(4000);
    // The editor's own view (above) stays as it is; the ENGINE's camera is then put in front of the rig — the
    // same message that opens the window at the editor's camera — so the volumes are in frame.
    await page.screenshot({ path: path.join(WORK, 'editor-beams.png') });
    await page.evaluate(() => window.artlux.nativeEngineView3d(true, { position: [0, 3.2, 9], target: [0, 2.2, -3], fov: 55 }));
    await sleep(2500);
    const shot = path.join(WORK, 'engine-beams.png');
    const cap = captureEngineWindow(shot);
    note(cap.startsWith('OK'), 'captured the engine window', cap);

    await settle(() => /3D view beams:/.test(fs.readFileSync(logf, 'utf8')));
    const lines = fs.readFileSync(logf, 'utf8').split(/\r?\n/);
    const beamLine = lines.find((l) => /3D view beams:/.test(l));
    console.log(`   engine: ${beamLine ? beamLine.replace(/^.*artlux-engine: /, '') : '(no beam line)'}`);
    const m = beamLine && /(\d+) volume\(s\), (\d+) diagram segment\(s\)/.exec(beamLine);
    note(!!m && +m[1] === 5, 'five beam volumes — the dark head draws none', m ? `${m[1]}` : 'none');
    note(!!m && +m[2] === 5 * 32 + 1 + 8, 'the diagram: five rings, and the selected head\'s axis and edge rays', m ? `${m[2]} segments` : 'none');
    note(!lines.some((l) => /light bytes: differs/.test(l)), 'the engine\'s light bytes never differ from the app\'s');
    note(lines.some((l) => /light bytes: \d+ tick\(s\) solved/.test(l)), 'the engine solved the lights');

    if (cap.startsWith('OK')) {
      const img = PNG.sync.read(fs.readFileSync(shot));
      let red = 0, blue = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
        if (r > 60 && r > 2.5 * g && r > 2.5 * b) red++;
        if (b > 60 && b > 1.6 * r && b > 1.2 * g) blue++;
      }
      note(red > 400, 'red beams in the window', `${red} px`);
      note(blue > 400, 'blue beams in the window', `${blue} px`);
      console.log(`   screenshot: ${shot}`);
    }

    // THE FLOOR NUMBERS (E4b, labels.rs): looking down at the floor, as the editor's default view does — whole
    // metres along both runs, laid out by the editor's own rules; the engine logs how many glyphs it laid.
    await page.evaluate(() => window.artlux.nativeEngineView3d(true, { position: [0, 5, 7], target: [0, 0, 0], fov: 50 }));
    await sleep(2000);
    captureEngineWindow(path.join(WORK, 'engine-floor.png'));
    const gl = await settle(() => /floor numbers: (\d+) glyph/.exec(fs.readFileSync(logf, 'utf8')));
    note(!!gl && +gl[1] > 20, 'the floor is numbered', gl ? `${gl[1]} glyphs` : 'no glyphs logged');

    // PICKING (E4b): the engine camera looks along the row of movers, so the three clicks are well apart.
    const EYE = [1, 5.6, 5], TARGET = [0, 5, -4], FOV = 55;
    await page.evaluate((e, t, f) => window.artlux.nativeEngineView3d(true, { position: e, target: t, fov: f }), EYE, TARGET, FOV);
    await sleep(1500);
    const { w, h } = engineClientSize();
    const at = (p) => toClient(EYE, TARGET, FOV, p, w, h);
    const m3 = at([1, 5, -4]), m2 = at([-1, 5, -4]);
    console.log(`   engine window ${w} x ${h}; Mover 3 at ${m3.map(Math.round)}, Mover 2 at ${m2.map(Math.round)}`);
    const inspector = () => page.evaluate(() => [...document.querySelectorAll('div[role="button"]')]
      .filter((d) => /bg-accent|selected|active/i.test(d.className) || d.getAttribute('aria-selected') === 'true')
      .map((d) => (d.textContent || '').trim()).filter((t) => /^(Mover|Wash) \d$/.test(t)));
    clickEngineWindow([[m3[0], m3[1], false]]);
    await sleep(1200);
    await settle(() => /3D view pick: fx_m3\b/.test(fs.readFileSync(logf, 'utf8')));
    let logNow = fs.readFileSync(logf, 'utf8');
    note(/3D view pick: fx_m3\b/.test(logNow), 'a click on Mover 3 in the engine window picks it');
    note(JSON.stringify(await inspector()) === '["Mover 3"]', 'the editor\'s selection follows: Mover 3', JSON.stringify(await inspector()));
    await settle(() => segmentsNow(logf) === 169); note(segmentsNow(logf) === 169, 'the full diagram moved to the picked head', `${segmentsNow(logf)} segments`);
    clickEngineWindow([[w * 0.5, h * 0.06, false]]);
    await sleep(1200);
    await settle(() => /3D view pick: \(nothing\)/.test(fs.readFileSync(logf, 'utf8')));
    logNow = fs.readFileSync(logf, 'utf8');
    note(/3D view pick: \(nothing\)/.test(logNow), 'a click on empty sky picks nothing');
    note(JSON.stringify(await inspector()) === '[]', 'the editor\'s selection is cleared', JSON.stringify(await inspector()));
    await settle(() => segmentsNow(logf) === 160); note(segmentsNow(logf) === 160, 'rings only, no head aimed', `${segmentsNow(logf)} segments`);
    clickEngineWindow([[m3[0], m3[1], false], [m2[0], m2[1], true]]);
    await sleep(1200);
    // An INJECTED Shift-click is occasionally dropped by Windows before it reaches the window (1 run in 3 on the
    // RTX box, 2026-11-24: no pick logged at all — not a wrong pick). One retry, said out loud; a wrong pick or a
    // second miss still fails.
    if (!/3D view pick: fx_m2/.test(fs.readFileSync(logf, 'utf8'))) {
      console.log('   (the Shift-click never arrived — retried once)');
      clickEngineWindow([[m2[0], m2[1], true]]);
      await sleep(1200);
    }
    note(/3D view pick: fx_m2 \(add\)/.test(fs.readFileSync(logf, 'utf8')), 'Shift-click adds Mover 2');
    note(JSON.stringify((await inspector()).sort()) === '["Mover 2","Mover 3"]', 'the editor holds both', JSON.stringify(await inspector()));
    await settle(() => segmentsNow(logf) === 178); note(segmentsNow(logf) === 178, 'both heads get the full diagram', `${segmentsNow(logf)} segments`);

    // THE MOVE GIZMO: both heads selected → the handles sit at their centroid (0, 5, -4). Grab X 60 % along its
    // drawn shaft (GIZMO_PX = 90 on screen) and pull 160 px further along it on screen.
    await sleep(1000);   // the scene (≤ 4 Hz) brings the gizmo for the new selection
    const c0 = at([0, 5, -4]), cx = at([0.5, 5, -4]);
    const ux = [cx[0] - c0[0], cx[1] - c0[1]], ul = Math.hypot(ux[0], ux[1]);
    const dirX = [ux[0] / ul, ux[1] / ul];
    const grab = [c0[0] + dirX[0] * 54, c0[1] + dirX[1] * 54];
    const to = [grab[0] + dirX[0] * 160, grab[1] + dirX[1] * 160];
    dragEngineWindow(grab, to);
    await sleep(1500);
    const glog = fs.readFileSync(logf, 'utf8');
    note(/3D view gizmo: grabbed the X move handle/.test(glog), 'the X handle is grabbed in the engine window');
    const rel = /3D view gizmo: released at \[([-\d.]+), ([-\d.]+), ([-\d.]+)\]/.exec(glog);
    note(!!rel && +rel[1] > 0.3 && Math.abs(+rel[2]) < 1e-6 && Math.abs(+rel[3]) < 1e-6, 'pulled along X only', rel ? rel.slice(1).join(', ') : 'no release');
    captureEngineWindow(path.join(WORK, 'engine-gizmo.png'));
    // Read the DOCUMENT: save in place and look at the file.
    // Through the editor's own File / Edit menus: Ctrl+S / Ctrl+Z are menu ACCELERATORS, which a scripted key
    // event never reaches.
    const menu = async (top, item) => {
      const ok = await page.evaluate((t, it) => {
        const m = [...document.querySelectorAll('[role="menubar"] [role="menuitem"]')].find((x) => (x.textContent || '').trim() === t);
        if (!m) return false;
        m.click();
        return true;
      }, top, item);
      await sleep(300);
      const ok2 = await page.evaluate((it) => {
        const b = [...document.querySelectorAll('[data-menuitem]')].find((x) => new RegExp('^' + it + '(Ctrl|$)').test((x.textContent || '').trim()));
        b?.click(); return !!b;
      }, item);
      if (!ok || !ok2) throw new Error(`no ${top} ▸ ${item}`);
    };
    const savedPos = async () => {
      await menu('File', 'Save');
      await sleep(1500);
      const doc = JSON.parse(fs.readFileSync(project, 'utf8'));
      return Object.fromEntries(doc.fixtures.map((f) => [f.id, f.position3D]));
    };
    const after = await savedPos();
    const dx = rel ? +rel[1] : 0;
    const near = (a, b) => Math.abs(a - b) < 1e-3;
    note(near(after.fx_m2.x, -1 + dx) && near(after.fx_m3.x, 1 + dx) && near(after.fx_m2.y, 5) && near(after.fx_m3.z, -4),
      'the editor moved both heads by the engine\'s offset', `m2 ${JSON.stringify(after.fx_m2)}, m3 ${JSON.stringify(after.fx_m3)}`);
    note(near(after.fx_m1.x, -3) && near(after.fx_w1.x, -2), 'and nothing else', `m1 ${JSON.stringify(after.fx_m1)}`);
    await menu('Edit', 'Undo');
    await sleep(800);
    const undone = await savedPos();
    note(near(undone.fx_m2.x, -1) && near(undone.fx_m3.x, 1), 'one Undo puts them back', `m2 ${JSON.stringify(undone.fx_m2)}, m3 ${JSON.stringify(undone.fx_m3)}`);

    const tool = (name) => page.evaluate((n) => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('title') || '').startsWith(n)); b?.click(); return !!b; }, name);
    // The engine's log reaches the file through main, a moment after the release, and an EARLIER drag's line can
    // land late too (seen once: the scale check read the move's release). So wait until every grab in the log has
    // its release, then read the last one.
    const count = (re) => [...fs.readFileSync(logf, 'utf8').matchAll(re)].length;
    const nextRelease = async () => {
      for (let i = 0; i < 40 && count(/3D view gizmo: released at/g) < count(/3D view gizmo: grabbed the/g); i++) await sleep(100);
      return lastRelease();
    };
    const lastRelease = () => {
      const all = [...fs.readFileSync(logf, 'utf8').matchAll(/3D view gizmo: released at \[([-\d.]+), ([-\d.]+), ([-\d.]+)\] turned ([-\d.]+) deg scaled \[([-\d.]+), ([-\d.]+), ([-\d.]+)\]/g)];
      return all.length ? all[all.length - 1].slice(1).map(Number) : null;
    };

    // SCALE: the two heads, the X handle (the anchor's frame — identity for a group), pulled outward.
    note(await tool('Scale'), 'the editor\'s Scale tool');
    await sleep(1200);
    dragEngineWindow(grab, [grab[0] + dirX[0] * 110, grab[1] + dirX[1] * 110]);
    await sleep(1500);
    note(/grabbed the X scale handle/.test(fs.readFileSync(logf, 'utf8')), 'the X scale handle is grabbed');
    const sr = await nextRelease();
    const f = sr ? sr[4] : 1;
    note(!!sr && f > 1.2 && near(sr[5], 1) && near(sr[6], 1), 'scaled along X only', sr ? `×${f}` : 'no release');
    const spread = await savedPos();
    note(near(spread.fx_m2.x, -f) && near(spread.fx_m3.x, f) && near(spread.fx_m2.y, 5) && near(spread.fx_m3.z, -4),
      'the editor spread both heads about their centre', `m2 ${JSON.stringify(spread.fx_m2)}, m3 ${JSON.stringify(spread.fx_m3)}`);
    await menu('Edit', 'Undo'); await sleep(800);

    // ROTATE: Mover 3 alone (a plain click picks it), its Y ring (world axes), swept from 135° to 90° in the ring's
    // frame — a 45° turn; the test reads its size. Box select first: no handles, so the click lands on the head and
    // not on the two-head gizmo drawn beside it.
    // Empty sky first: a plain click on a member of a group keeps the group (the editor's rule —
    // App.handleSelectFixture only makes it the active one).
    await tool('Box select'); await sleep(1000);
    clickEngineWindow([[w * 0.5, h * 0.06, false], [m3[0], m3[1], false]]);
    await sleep(1200);
    note(JSON.stringify(await inspector()) === '["Mover 3"]', 'Mover 3 alone', JSON.stringify(await inspector()));
    note(await tool('Rotate'), 'the editor\'s Rotate tool');
    await sleep(1200);
    const A3 = [1, 5, -4];
    const r = 90 * (2 * Math.tan((FOV * Math.PI / 180) / 2) / h) * Math.hypot(EYE[0] - A3[0], EYE[1] - A3[1], EYE[2] - A3[2]);
    // view3d ring frame for n = +Y: a = (0,0,-1), b = (-1,0,0); a point at angle t is A + r(a cos t + b sin t).
    const ringAt = (t) => at([A3[0] - r * Math.sin(t), A3[1], A3[2] - r * Math.cos(t)]);
    dragEngineWindow(ringAt(Math.PI * 3 / 4), ringAt(Math.PI / 2));
    await sleep(1500);
    note(/grabbed the Y rotate handle/.test(fs.readFileSync(logf, 'utf8')), 'the Y ring is grabbed');
    const rr = await nextRelease();
    note(!!rr && Math.abs(rr[3] - 45) < 2 && near(rr[0], 0) && near(rr[4], 1), 'turned 45° about Y', rr ? `${rr[3]}°` : 'no release');
    const doc = await savedPos();
    const rot3 = JSON.parse(fs.readFileSync(project, 'utf8')).fixtures.find((x) => x.id === 'fx_m3').rotation3D || {};
    note(Math.abs(Math.abs(rot3.yaw ?? 0) - (rr ? rr[3] : 45)) < 0.5 && Math.abs(rot3.pitch ?? 0) < 0.5 && Math.abs(rot3.roll ?? 0) < 0.5 && near(doc.fx_m3.x, 1) && near(doc.fx_m3.z, -4),
      'the editor turned Mover 3 in place', `rotation3D ${JSON.stringify(rot3)}, position ${JSON.stringify(doc.fx_m3)}`);
    captureEngineWindow(path.join(WORK, 'engine-rotate.png'));
    await menu('Edit', 'Undo'); await sleep(800);
    const back = JSON.parse(fs.readFileSync(project, 'utf8'));
    await savedPos();
    const r3b = JSON.parse(fs.readFileSync(project, 'utf8')).fixtures.find((x) => x.id === 'fx_m3').rotation3D || {};
    note(Math.abs(r3b.yaw ?? 0) < 0.01, 'and Undo turns it back', JSON.stringify(r3b));
    void back;
    await tool('Move');

    // A VENUE MODEL: the empty part of the screen behind the rig, low and to the left.
    clickEngineWindow([[...at([-2.6, 1.8, -7]), false]]);
    await sleep(1500);
    await settle(() => /3D view pick: model scr$/m.test(fs.readFileSync(logf, 'utf8')));
    note(/3D view pick: model scr$/m.test(fs.readFileSync(logf, 'utf8')), 'a click on the screen picks the model');
    const modelRow = await page.evaluate(() => [...document.querySelectorAll('div[role="button"]')].filter((d) => /bg-accent/.test(d.className)).map((d) => (d.textContent || '').trim()));
    note(modelRow.some((t) => t.includes('Back screen')) && !modelRow.some((t) => /^(Mover|Wash) \d$/.test(t)), 'the editor selects the screen, not a fixture', JSON.stringify(modelRow));
    await sleep(800);
    captureEngineWindow(path.join(WORK, 'engine-model.png'));

    // THE MODEL'S OWN HANDLES (E4b): the screen is selected and the Move tool is on, so the engine draws its
    // handles at its position (room axes). Pull Y up; the saved project has the screen raised by exactly the
    // engine's offset, and one Undo puts it back.
    const s0 = at([0, 3, -7]), s1 = at([0, 3.5, -7]);
    const uy = [s1[0] - s0[0], s1[1] - s0[1]], uyl = Math.hypot(uy[0], uy[1]);
    const dy = [uy[0] / uyl, uy[1] / uyl];
    const g0 = [s0[0] + dy[0] * 54, s0[1] + dy[1] * 54];
    dragEngineWindow(g0, [g0[0] + dy[0] * 100, g0[1] + dy[1] * 100]);
    await sleep(1500);
    const mrel = await nextRelease();
    note(/grabbed the Y move handle/.test(fs.readFileSync(logf, 'utf8').split('pick: model scr').pop()), 'the Y handle of the screen is grabbed');
    note(!!mrel && mrel[1] > 0.2 && near(mrel[0], 0) && near(mrel[2], 0), 'pulled up along Y', mrel ? mrel.slice(0, 3).join(', ') : 'no release');
    await savedPos();
    const scr = (JSON.parse(fs.readFileSync(project, 'utf8')).scene3D.models || []).find((m) => m.id === 'scr');
    note(!!scr && !!mrel && near(scr.position.y, 3 + mrel[1]) && near(scr.position.x, 0) && near(scr.position.z, -7), 'the editor raised the screen by the engine offset', JSON.stringify(scr?.position));
    await menu('Edit', 'Undo'); await sleep(800);
    await savedPos();
    const scrBack = (JSON.parse(fs.readFileSync(project, 'utf8')).scene3D.models || []).find((m) => m.id === 'scr');
    note(!!scrBack && near(scrBack.position.y, 3), 'and Undo puts it back', JSON.stringify(scrBack?.position));
    captureEngineWindow(path.join(WORK, 'engine-pick.png'));

    // THE RENDERED LOOK follows the editor's display mode: the button flips it, the scene (≤ 4 Hz) carries it, the
    // engine logs the look it draws in and its window shows solid shafts (no diagram: Rendered is a picture).
    const rend = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Rendered look/.test(x.getAttribute('title') || '')); b?.click(); return !!b; });
    note(rend, 'switched the editor to Rendered');
    await sleep(3500);
    const shot2 = path.join(WORK, 'engine-beams-rendered.png');
    const cap2 = captureEngineWindow(shot2);
    const rl = fs.readFileSync(logf, 'utf8').split(/\r?\n/).filter((l) => /3D view beams:/.test(l));
    const last = rl[rl.length - 1] || '';
    console.log(`   engine: ${last.replace(/^.*artlux-engine: /, '')}`);
    note(/5 volume\(s\), 0 diagram segment\(s\).*Rendered/.test(last), 'Rendered: five solid shafts, no diagram', last ? '' : 'no line');
    if (cap2.startsWith('OK')) {
      const img = PNG.sync.read(fs.readFileSync(shot2));
      let lit = 0;
      for (let i = 0; i < img.data.length; i += 4) if (Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) > 90) lit++;
      note(lit > 3000, 'Rendered: the shafts light the window', `${lit} px`);
      console.log(`   screenshot: ${shot2}`);
    }
  } catch (e) {
    note(false, 'run', e.message);
  } finally {
    try { browser?.disconnect(); } catch { /* gone */ }
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
  }
  console.log(failures.length ? `\nengine beams: ${failures.length} FAILED` : '\nengine beams OK');
  if (!KEEP && !failures.length) { await sleep(1500); try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* held */ } }
  process.exit(failures.length ? 1 : 0);
})();
