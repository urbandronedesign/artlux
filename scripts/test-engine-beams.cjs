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
//     blue both present where the beams are (saved as engine-beams.png for a look).
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
    scene3D: { models: [], lightIntensity: 1, environment: true, exposure: 1, gridVisible: true, reflectiveFloor: false, trackingViz: false, augmentaViz: false, trackingSmoothing: 0.6, trackingPredictMs: 50, hazeDensity: 0.6 },
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
