#!/usr/bin/env node
// E4b — SHADOWS IN THE ENGINE'S RENDERED LOOK (plans/native-engine.md E4b; engine view3d.rs spot shadows).
//
//   node scripts/test-engine-shadows.cjs --packaged <ArtLux.exe> [--keep]      (shadows)
//   node scripts/test-engine-shadows.cjs --packaged <ArtLux.exe> --ao           (ambient occlusion)
//
// One wide wash (ADJ Flat Par QA12, 40° lens) hung 5 m up and turned to point straight down, a 0.5 m box hanging
// under it at 3 m (a tiny glTF written by this test), the editor in Rendered, the engine's 3D view open looking down
// from above. The box must SHADOW the floor: on the floor around the box's foot the pool is darker than in the ring
// further out, although without a shadow the middle of a downward pool is its brightest part (nearest the lens,
// square on). In Rendered the beam's solid shaft is drawn additively over the whole pool and the stage floor is
// nearly black, so the shadow is judged as a DIFFERENCE: the same ring of floor just outside the box's silhouette,
// captured with the box and again with it hidden (the editor's own Hide) — the shadow must lift when the box goes,
// and the order of that ring and one further out must flip. Packaged app, SCRATCH profile, own processes only.
//
// --ao: AMBIENT OCCLUSION (ao.rs). Under Rendered's bloom a box's lit top swamps the contact darkening, so this run
// starts the engine with ARTLUX_VIEW3D_AO_ONLY=1 (the window shows the occlusion term alone), shows a box RESTING on
// the floor instead of the hanging one, and judges the floor along its base against open floor the same distance
// from the pool's centre on the other side.
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
if (!EXE) { console.error('usage: node scripts/test-engine-shadows.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const KEEP = process.argv.includes('--keep');
const AO = process.argv.includes('--ao');
const CDP_PORT = '9379';
const WORK = path.join(os.tmpdir(), AO ? 'artlux-engine-ao' : 'artlux-engine-shadows');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => { http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej); });
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));

/** A unit cube as an embedded glTF: 24 vertices (positions + normals), 36 indices, a grey lit material. */
function cubeGltf(file) {
  const pos = [], nrm = [], idx = [];
  const faces = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]], [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];
  for (const [n, u, w] of faces) {
    const base = pos.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) pos.push(0.5 * n[k] + 0.5 * a * u[k] + 0.5 * b * w[k]);
      nrm.push(...n);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const pb = Buffer.from(new Float32Array(pos).buffer), nb = Buffer.from(new Float32Array(nrm).buffer), ib = Buffer.from(new Uint16Array(idx).buffer);
  const buf = Buffer.concat([pb, nb, ib]);
  fs.writeFileSync(file, JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'box' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.6, 0.6, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    buffers: [{ byteLength: buf.length, uri: 'data:application/octet-stream;base64,' + buf.toString('base64') }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pb.length }, { buffer: 0, byteOffset: pb.length, byteLength: nb.length }, { buffer: 0, byteOffset: pb.length + nb.length, byteLength: ib.length }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  }));
}

function buildProject() {
  const box = path.join(WORK, 'box.gltf');
  cubeGltf(box);
  const file = path.join(WORK, 'shadows.artlux');
  fs.writeFileSync(file, JSON.stringify({
    version: '1.2', timestamp: '2026-01-01T00:00:00.000Z', surfaces: [],
    fixtures: [{ id: 'fx_w', name: 'Wash', x: 0, y: 0, width: 0.02, height: 0.02, rotation: 0, universe: 0, startAddress: 1, ledCount: 1, reverse: false, colorData: [],
      profileId: 'american-dj/flat-par-qa12', profileMode: '5ch', dmx: { dimmer: 1, red: 1, green: 1, blue: 1, amber: 0 },
      position3D: { x: 0, y: 5, z: 0 }, rotation3D: { pitch: -90, yaw: 0, roll: 0 }, controllerId: 'ctl' }],
    controllers: [{ id: 'ctl', name: 'Lighting interface', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, startUniverse: 0, drives: 'light' }],
    globalBrightness: 1, groups: [], scenes: [], cueBanks: [],
    // 'base' rests ON the floor inside the pool, hidden at first: showing it must darken the floor along its lit side
    // (ambient occlusion — ao.rs), where its shadow does not fall.
    scene3D: { models: [{ id: 'box', name: 'Box', kind: 'mesh', path: box, position: { x: 0, y: 3, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 0.5, visible: !AO },
      { id: 'base', name: 'Base', kind: 'mesh', path: box, position: { x: -1.0, y: 0.25, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 0.5, visible: AO }],
      lightIntensity: 1, environment: true, exposure: 1, gridVisible: false, reflectiveFloor: false, trackingViz: false, augmentaViz: false, trackingSmoothing: 0.6, trackingPredictMs: 50, hazeDensity: 0.35 },
    timeline: { layers: [], clips: [], duration: 60, fps: 30, markers: [], inPoint: null, outPoint: null, loop: false, trackingTakes: [], lightingTakes: [], lightingSequences: [] },
    schedule: [], assets: [], projectorOutputs: [], projectorFpsCap: 0, projectorBrightness: 1,
  }, null, 2));
  return file;
}

/** The engine window, captured from the screen (CLIENT area), and its client size. */
function capture(out) {
  const ps = path.join(WORK, 'capture.ps1');
  fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct R { public int L, T, Rt, B; } public struct P { public int X, Y; } }
"@
[W]::SetProcessDPIAware() | Out-Null
$h = [W]::FindWindow([NullString]::Value, "ArtLux $([char]0x2014) 3D view (engine)")
if ($h -eq [IntPtr]::Zero) { Write-Output "NOWINDOW"; exit 0 }
[W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700
$r = New-Object W+R; [W]::GetClientRect($h, [ref]$r) | Out-Null
$p = New-Object W+P; [W]::ClientToScreen($h, [ref]$p) | Out-Null
$bmp = New-Object System.Drawing.Bitmap $r.Rt, $r.B
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($p.X, $p.Y, 0, 0, $bmp.Size)
$bmp.Save("${out.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "OK $($r.Rt) $($r.B)"
`);
  return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps}"`).toString().trim();
}

/** view3d.rs Cam: a world point → client pixels. */
function toClient(eye, target, fov, p, w, h) {
  const sub = (a, b) => a.map((x, i) => x - b[i]), dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const f = norm(sub(target, eye)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f), v = sub(p, eye);
  const z = dot(v, f), t = Math.tan((fov * Math.PI / 180) / 2);
  return [((dot(v, r) / z / t / (w / h)) + 1) / 2 * w, (1 - dot(v, u) / z / t) / 2 * h];
}

(async () => {
  for (let i = 0; ; i++) { try { fs.rmSync(WORK, { recursive: true, force: true }); break; } catch (e) { if (i >= 20) throw e; await sleep(500); } }
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'artlux-prefs.json'), JSON.stringify({ appSettings: { outputEnabled: false } }));
  const project = buildProject();
  const logf = path.join(WORK, 'app.log');
  const log = fs.openSync(logf, 'w');
  const env = { ...process.env, ARTLUX_CDP_PORT: CDP_PORT, ...(AO ? { ARTLUX_VIEW3D_AO_ONLY: '1' } : {}) }; delete env.ELECTRON_RUN_AS_NODE;
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
    for (let i = 0; i < 60; i++) { if (await page.evaluate(() => !!document.querySelector('[role="tablist"] button'))) break; await sleep(1000); }
    await sleep(4000);
    await page.evaluate(() => { [...document.querySelectorAll('[role="tablist"] button')].find((x) => (x.textContent || '').trim() === '3D')?.click(); });
    await sleep(5000);
    note(await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Rendered look/.test(x.getAttribute('title') || '')); b?.click(); return !!b; }), 'the editor in Rendered');
    await sleep(1500);
    note(await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /in its own window/.test(x.getAttribute('title') || '') && /^Open/.test(x.getAttribute('title') || '')); b?.click(); return !!b; }), 'opened the engine window');
    await sleep(4000);
    const EYE = [0, 11, 3], TARGET = [0, 0, 0], FOV = 45;
    await page.evaluate((e, t, f) => window.artlux.nativeEngineView3d(true, { position: e, target: t, fov: f }), EYE, TARGET, FOV);
    // The box's file loads off the presenter; give it, and the shadow maps, time.
    for (let i = 0; i < 30 && !/3D view loaded .*box\.gltf/.test(fs.readFileSync(logf, 'utf8')); i++) await sleep(500);
    note(/3D view loaded .*box\.gltf/.test(fs.readFileSync(logf, 'utf8')), 'the engine loaded the box');
    await sleep(2500);
    const shot = path.join(WORK, 'engine-shadow.png');
    const cap = capture(shot);
    note(cap.startsWith('OK'), 'captured the engine window', cap);
    await page.screenshot({ path: path.join(WORK, 'editor-shadow.png') });
    if (cap.startsWith('OK') && AO) {
      const img = PNG.sync.read(fs.readFileSync(shot));
      const { width: w, height: h } = img;
      // The occlusion term on the floor: along Base's face toward the centre (x −0.72…−0.66, the face at −0.75)
      // against open floor at the same distance on the other side (x +0.66…+0.72).
      const strip = (x0, x1) => {
        let sum = 0, n = 0;
        for (let x = x0; x <= x1; x += 0.01) for (let z = -0.18; z <= 0.18; z += 0.02) {
          const [u, v] = toClient(EYE, TARGET, FOV, [x, 0, z], w, h).map(Math.round);
          const k = (v * w + u) * 4;
          sum += 0.2126 * img.data[k] + 0.7152 * img.data[k + 1] + 0.0722 * img.data[k + 2]; n++;
        }
        return sum / n;
      };
      const contact = strip(-0.72, -0.66), open = strip(0.66, 0.72);
      console.log(`   occlusion term: at the box's base ${contact.toFixed(1)}, open floor ${open.toFixed(1)}`);
      note(open > 100, 'open floor is unoccluded', open.toFixed(1));
      note(contact < open - 5, 'AMBIENT OCCLUSION darkens the floor where the box meets it', `${contact.toFixed(1)} vs ${open.toFixed(1)}`);
      console.log(`   screenshot: ${shot}`);
    } else if (cap.startsWith('OK')) {
      const img = PNG.sync.read(fs.readFileSync(shot));
      const { width: w, height: h } = img;
      // Mean luma of the floor between radii r0 and r1 (metres from the pool's centre), sampled on a polar grid and
      // projected with the window's own camera. Points the box hides from the camera are skipped (the box's
      // silhouette at the floor is ≈ 0.25 · 11 / 7.75 ≈ 0.36 m from straight above).
      const ring = (r0, r1) => {
        let s = 0, n = 0;
        for (let r = r0; r <= r1; r += 0.03) for (let a = 0; a < Math.PI * 2; a += 0.05) {
          const [x, y] = toClient(EYE, TARGET, FOV, [Math.cos(a) * r, 0, Math.sin(a) * r], w, h).map(Math.round);
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const k = (y * w + x) * 4;
          s += 0.2126 * img.data[k] + 0.7152 * img.data[k + 1] + 0.0722 * img.data[k + 2]; n++;
        }
        return n ? s / n : NaN;
      };
      // Pool radius at the floor: 5 · tan 20° ≈ 1.82 m. The box's shadow (its top face, 3.25 m up) reaches
      // 0.25 · 5 / 1.75 ≈ 0.71 m.
      const inner = ring(0.5, 0.62), outer = ring(1.05, 1.35), far = ring(2.6, 3.0);
      console.log(`   with the box: the shadowed ring ${inner.toFixed(1)}, a lit ring ${outer.toFixed(1)}, outside the pool ${far.toFixed(1)}`);
      note(outer > far + 4, 'the pool lights the floor', `${outer.toFixed(1)} vs ${far.toFixed(1)}`);
      console.log(`   screenshot: ${shot}`);
      // Hide the box (the editor's own toggle in the 3D objects list): no caster, no shadow.
      const hid = await page.evaluate(() => {
        const row = [...document.querySelectorAll('div[role="button"]')].find((d) => (d.textContent || '').trim().startsWith('Box'));
        const b = row && [...row.querySelectorAll('button')].find((x) => x.getAttribute('title') === 'Hide');
        b?.click(); return !!b;
      });
      note(hid, 'hid the box');
      await sleep(2500);
      const shot2 = path.join(WORK, 'engine-no-shadow.png');
      capture(shot2);
      const img2 = PNG.sync.read(fs.readFileSync(shot2));
      img.data = img2.data;
      const inner2 = ring(0.5, 0.62), outer2 = ring(1.05, 1.35);
      console.log(`   without it:   the same ring ${inner2.toFixed(1)}, the lit ring ${outer2.toFixed(1)}`);
      note(inner2 - inner > 3, 'the box SHADOWS the floor: the ring brightens when it goes', `${inner.toFixed(1)} → ${inner2.toFixed(1)}`);
      // The order of the two rings FLIPS: with the box the shadowed ring is the darker one; without it the middle of
      // a downward pool is the brighter (nearer the lens, square on). (The outer ring does not stay equal: the box's lit
      // top adds bloom around it, which goes with it — which is also why the inner ring brightening is a fair proof.)
      note(inner < outer && inner2 > outer2, 'the shadowed ring is darker only while the box is there', `with ${inner.toFixed(1)} < ${outer.toFixed(1)}, without ${inner2.toFixed(1)} > ${outer2.toFixed(1)}`);
    }
  } catch (e) {
    note(false, 'run', e.message);
  } finally {
    try { browser?.disconnect(); } catch { /* gone */ }
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
  }
  console.log(failures.length ? `\nengine shadows: ${failures.length} FAILED` : '\nengine shadows OK');
  if (!KEEP && !failures.length) { await sleep(1500); try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* held */ } }
  process.exit(failures.length ? 1 : 0);
})();
