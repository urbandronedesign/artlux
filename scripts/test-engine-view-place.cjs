#!/usr/bin/env node
// E4b — THE ENGINE'S 3D VIEW COMES BACK WHERE IT WAS (plans/native-engine.md E4; view3d.rs Place).
//
//   node scripts/test-engine-view-place.cjs --packaged <ArtLux.exe>
//
// The operator puts the engine's 3D view window on a screen and sizes it; the next open puts it back. The packaged
// app runs with --native-engine on a SCRATCH profile; the window is moved and sized from outside (SetWindowPos, the
// way a drag ends) and the test checks, in order:
//   1. the engine reports the place once it settles, and main saves it in THIS profile's prefs (engineView3dPlace);
//   2. closing and reopening the window (the editor's button) puts it back at exactly that rect;
//   3. MAXIMISED is remembered too — and the rect under it is the one it had before;
//   4. after the app is quit and started again, the window opens where it was;
//   5. a saved place on a screen that no longer exists (far off every monitor) is NOT used: the window opens at
//      the default, on a screen, and the engine says why.
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
if (!EXE) { console.error('usage: node scripts/test-engine-view-place.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const CDP_PORT = '9378';
const WORK = path.join(os.tmpdir(), 'artlux-engine-view-place');
const PROFILE = path.join(WORK, 'profile');
const PREFS = path.join(PROFILE, 'artlux-prefs.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => { http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej); });
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));

/** The engine window, from outside: `rect` → "x y w h max" (outer position, CLIENT size — what the engine saves),
 *  `move x y w h` (outer rect), `max`. Physical pixels (DPI-aware). */
function win(cmd) {
  const ps = path.join(WORK, 'win.ps1');
  fs.writeFileSync(ps, `
param([string]$cmd, [int]$px = 0, [int]$py = 0, [int]$pw = 0, [int]$ph = 0)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class V { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct R { public int L, T, Rt, B; } }
"@
[V]::SetProcessDPIAware() | Out-Null
$h = [V]::FindWindow([NullString]::Value, "ArtLux $([char]0x2014) 3D view (engine)")
if ($h -eq [IntPtr]::Zero) { Write-Output "NOWINDOW"; exit 0 }
if ($cmd -eq "move") { [V]::ShowWindow($h, 9) | Out-Null; [V]::SetWindowPos($h, [IntPtr]::Zero, $px, $py, $pw, $ph, 0x0014) | Out-Null }
if ($cmd -eq "max") { [V]::ShowWindow($h, 3) | Out-Null }
$r = New-Object V+R; [V]::GetWindowRect($h, [ref]$r) | Out-Null
$c = New-Object V+R; [V]::GetClientRect($h, [ref]$c) | Out-Null
Write-Output "$($r.L) $($r.T) $($c.Rt) $($c.B) $([V]::IsZoomed($h))"
`);
  const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps}" ${cmd}`).toString().trim();
  if (out === 'NOWINDOW') return null;
  const [x, y, w, h, z] = out.split(/\s+/);
  return { x: +x, y: +y, w: +w, h: +h, max: z === 'True' };
}

const prefs = () => { try { return JSON.parse(fs.readFileSync(PREFS, 'utf8')); } catch { return {}; } };

async function launch(tag) {
  const logf = path.join(WORK, `app-${tag}.log`);
  const log = fs.openSync(logf, 'w');
  const env = { ...process.env, ARTLUX_CDP_PORT: CDP_PORT }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--user-data-dir=${PROFILE}`, '--native-engine', `--project=${path.join(WORK, 'place.artlux')}`], { env, stdio: ['ignore', log, log] });
  let ver = null;
  for (let i = 0; i < 90 && !ver; i++) { try { ver = JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json/version`)); } catch { await sleep(1000); } }
  if (!ver) throw new Error('no CDP endpoint');
  const browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = (await browser.pages()).find((p) => /index\.html/.test(p.url())) ?? null; if (!page) await sleep(1000); }
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => !!document.querySelector('[role="tablist"] button'))) break; await sleep(1000); }
  await sleep(3000);
  await page.evaluate(() => { [...document.querySelectorAll('[role="tablist"] button')].find((x) => (x.textContent || '').trim() === '3D')?.click(); });
  await sleep(4000);
  return { child, browser, page, logf };
}
const toggle = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /in its own window/.test(x.getAttribute('title') || '') && /^(Open|Close)/.test(x.getAttribute('title') || ''));
  b?.click(); return b ? b.getAttribute('title').split(' ')[0] : null;
});
async function stop(run) {
  try { run.browser.disconnect(); } catch { /* gone */ }
  try { execSync(`taskkill /PID ${run.child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
  await sleep(2500);
}
const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

(async () => {
  for (let i = 0; ; i++) { try { fs.rmSync(WORK, { recursive: true, force: true }); break; } catch (e) { if (i >= 20) throw e; await sleep(500); } }
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(PREFS, JSON.stringify({ recentFiles: [], appSettings: { outputEnabled: false } }));
  fs.writeFileSync(path.join(WORK, 'place.artlux'), JSON.stringify({ version: '1.2', timestamp: '2026-01-01T00:00:00.000Z', surfaces: [], fixtures: [], controllers: [], groups: [], scenes: [], cueBanks: [], timeline: { layers: [], clips: [], duration: 10, fps: 30, markers: [], loop: false } }));
  const failures = [];
  const note = (ok, label, detail) => { console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); if (!ok) failures.push(label); };
  let run = null;
  try {
    run = await launch('1');
    note(await toggle(run.page) === 'Open', 'opened the engine window');
    await sleep(2500);
    const first = win('rect');
    note(!!first, 'the window is up', JSON.stringify(first));
    // 1. Put it somewhere of the test's choosing, as a drag would end.
    const moved = win('move 160 120 1000 640');
    await sleep(1500);
    const saved = prefs().engineView3dPlace;
    note(!!saved && saved.x === moved.x && saved.y === moved.y && saved.w === moved.w && saved.h === moved.h && saved.max === false,
      'the place is saved in this profile\'s prefs once it settles', `window ${JSON.stringify(moved)}, prefs ${JSON.stringify(saved)}`);
    // 2. Close and reopen: back at exactly that rect.
    await toggle(run.page); await sleep(1500);
    note(win('rect') === null, 'closed');
    await toggle(run.page); await sleep(2500);
    const back = win('rect');
    note(same(back, moved) && !back.max, 'reopened where it was', JSON.stringify(back));
    // 3. Maximised.
    win('max'); await sleep(1500);
    const smax = prefs().engineView3dPlace;
    note(!!smax && smax.max === true && smax.x === moved.x && smax.w === moved.w, 'maximised is saved, over the rect it had', JSON.stringify(smax));
    await toggle(run.page); await sleep(1500);
    await toggle(run.page); await sleep(2500);
    const bmax = win('rect');
    note(!!bmax && bmax.max, 'reopened maximised', JSON.stringify(bmax));
    // Back to the plain rect for the restart.
    win('move 160 120 1000 640'); await sleep(1500);
    await stop(run); run = null;

    // 4. A new session on the same profile.
    run = await launch('2');
    await toggle(run.page); await sleep(2500);
    const again = win('rect');
    note(same(again, moved), 'after a restart it opens where it was', JSON.stringify(again));
    await stop(run); run = null;

    // 5. A place on a screen that is gone.
    const p = prefs(); p.engineView3dPlace = { x: -40000, y: -40000, w: 1000, h: 640, max: false };
    fs.writeFileSync(PREFS, JSON.stringify(p));
    run = await launch('3');
    await toggle(run.page); await sleep(2500);
    const dflt = win('rect');
    note(!!dflt && dflt.x > -20000 && dflt.y > -20000, 'a place on a missing screen is not used — the window is on a screen', JSON.stringify(dflt));
    note(/its saved place .* is on no screen now/.test(fs.readFileSync(run.logf, 'utf8')), 'and the engine says why');
  } catch (e) {
    note(false, 'run', e.message);
  } finally {
    if (run) await stop(run);
  }
  console.log(failures.length ? `\nengine view place: ${failures.length} FAILED` : '\nengine view place OK');
  process.exit(failures.length ? 1 : 0);
})();
