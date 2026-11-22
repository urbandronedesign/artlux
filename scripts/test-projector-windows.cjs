#!/usr/bin/env node
// E1e-2 PROJECTOR WINDOWS (Windows): the engine's native output windows, read from the SCREEN.
//
//   node scripts/test-projector-windows.cjs [--fullscreen]
//
// `artlux-engine --project-windows` opens one window per projector output on the display it names and
// presents the projector raster (projector.rs — identical to the app's ProjectorGL, test:projector-parity)
// at that display's refresh. This test, with no hook into the engine (a PowerShell screen capture,
// engine/scripts/capture-window.ps1):
//   1. the window appears on the NAMED display, where it was asked to be, the size it was asked to be;
//   2. what is ON THE SCREEN is byte-identical to the engine's offscreen render of the same output
//      (`--project-once`) — so the window path (swapchain, the bottom-up flip, the compositor) adds nothing;
//   3. an output naming a display that does not exist is REFUSED, not put on another screen;
//   4. it keeps presenting, and exits at its deadline with every window closed.
// On a machine with one screen the output is a borderless WINDOW on it (the same renderer and swapchain as
// fullscreen). `--fullscreen` also runs one borderless-fullscreen output on display 0 — it COVERS THAT
// SCREEN for a few seconds — and checks the whole display. Run at 100% display scaling for byte equality.

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'win32') { console.log('Windows only (the capture is GDI) — skipped'); process.exit(0); }
const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine', 'target', 'release', 'artlux-engine.exe');
const CAPTURE = path.join(ROOT, 'engine', 'scripts', 'capture-window.ps1');
const WORK = path.join(os.tmpdir(), 'artlux-projector-windows');
fs.mkdirSync(WORK, { recursive: true });
const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A picture with sharp lines, gradients and blobs, so a scale, a shift or a flip cannot hide.
const W0 = 1280, H0 = 720;
const png = new PNG({ width: W0, height: H0 });
for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) {
  const i = (y * W0 + x) * 4;
  const line = x % 61 === 0 || y % 47 === 0;
  png.data[i] = line ? 255 : Math.round((x / (W0 - 1)) * 255);
  png.data[i + 1] = line ? 255 : Math.round((y / (H0 - 1)) * 255);
  png.data[i + 2] = line ? 255 : ((x >> 6) + (y >> 6)) % 2 ? 210 : 30;
  png.data[i + 3] = 255;
}
const picture = path.join(WORK, 'content-1280x720.png');
fs.writeFileSync(picture, PNG.sync.write(png));

// Keystone + Bézier-free soft edge + colour gain: the warp path with everything that could go wrong on it.
const output = {
  cornerPin: { tl: [0.05, 0.1], tr: [0.93, 0.02], br: [0.97, 0.95], bl: [0.02, 0.88] },
  softEdge: { left: 0.15, right: 0, top: 0, bottom: 0.1, gamma: 2.2 }, gamma: 1, colorGain: [1, 0.95, 0.9], blackLift: [0.01, 0.01, 0.02],
};
const W = 960, H = 540, AT = [80, 80];

function expected(w, h) {
  const inp = path.join(WORK, `exp-${w}x${h}.json`), out = path.join(WORK, `exp-${w}x${h}.out.json`);
  fs.writeFileSync(inp, JSON.stringify({ width: w, height: h, picture, cases: [{ name: 'probe', output, brightness: 0.9, aa: 4 }] }));
  execFileSync(ENGINE, ['--project-once', inp, out]);
  return Buffer.from(JSON.parse(fs.readFileSync(out, 'utf8')).cases[0].rgba, 'base64');
}
function capture(pid, name, file) {
  const line = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE, '-ProcId', String(pid), '-Name', name, '-Out', file], { encoding: 'utf8' }).trim().split(/\r?\n/).pop();
  if (line === 'NOWINDOW') return null;
  const [x, y, w, h] = line.split(' ').map(Number);
  return { x, y, w, h, png: PNG.sync.read(fs.readFileSync(file)) };
}
function compare(exp, got) {
  let exact = 0, max = 0;
  const n = exp.length / 4;
  for (let i = 0; i < n; i++) {
    let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(exp[i * 4 + k] - got.data[i * 4 + k]));
    if (!d) exact++; max = Math.max(max, d);
  }
  return { exact, n, max };
}
function engine(job, secs) {
  const inp = path.join(WORK, `windows-${Date.now()}.json`);
  fs.writeFileSync(inp, JSON.stringify(job));
  const p = spawn(ENGINE, ['--project-windows', inp, '--seconds', String(secs)], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = ''; p.stdout.on('data', (d) => { p.out += d; }); p.stderr.on('data', (d) => { p.out += d; });
  p.done = new Promise((res) => p.on('exit', (code) => res(code)));
  return p;
}

(async () => {
  let fails = 0;
  const ok = (cond, msg) => { if (!cond) fails++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); };
  if (!fs.existsSync(ENGINE)) { console.error(`no engine at ${ENGINE} — npm run build:engine`); process.exit(2); }

  // ── 1–4: a windowed output on display 0, and one naming a display that is not there ──────────────────
  const exp = expected(W, H);
  const p = engine({ picture, outputs: [
    { name: 'probe', display: { index: 0 }, window: { x: AT[0], y: AT[1], width: W, height: H }, output, brightness: 0.9, aa: 4 },
    { name: 'nowhere', display: { x: 40000, y: 0, width: 1920, height: 1080 }, output, brightness: 1, aa: 4 },
  ] }, 7);
  const a = capture(p.pid, 'probe', path.join(WORK, 'shot-a.png'));
  if (!a) { ok(false, 'the output window appeared'); }
  else {
    ok(true, 'the output window appeared (found by its title, from the screen)');
    ok(a.w === W && a.h === H, `its client area is the size asked for: ${a.w}×${a.h}`);
    // Display 0 here is the primary at (0, 0): the window is where it was asked to be ON it.
    ok(a.x === AT[0] && a.y === AT[1], `it is where it was asked to be on display 0: (${a.x}, ${a.y})`);
    if (a.w === W && a.h === H) {
      const c = compare(exp, a.png);
      ok(c.exact === c.n, `ON THE SCREEN = the engine's offscreen render: ${(100 * c.exact / c.n).toFixed(3)}% of ${c.n} pixels identical (max difference ${c.max})`);
    }
    await sleep(1200);
    const b = capture(p.pid, 'probe', path.join(WORK, 'shot-b.png'));
    if (b && b.w === W) { const c = compare(exp, b.png); ok(c.exact === c.n, `still identical ~1.5 s later (${(100 * c.exact / c.n).toFixed(3)}%)`); }
  }
  const nowhere = capture(p.pid, 'nowhere', path.join(WORK, 'shot-x.png'));
  ok(!nowhere, 'the output naming a display that is not here opened NO window');
  const code = await Promise.race([p.done, sleep(15000).then(() => 'timeout')]);
  if (code === 'timeout') p.kill();
  ok(code === 0, `the engine exited at its deadline (exit ${code})`);
  ok(/output 'nowhere' NOT opened: no display at 1920x1080 \(40000, 0\)/.test(p.out), 'it SAID why the other output was refused');
  const frames = Number((/output 'probe': (\d+) frames presented/.exec(p.out) || [])[1] || 0);
  ok(frames > 60, `it kept presenting (${frames} frames over the run, FIFO)`);
  console.log(`--- engine:\n${p.out.trim()}`);

  // ── every output refused → the engine says so and exits non-zero (nothing on any screen) ───────────────
  const q = engine({ picture, outputs: [{ name: 'ghost', display: { index: 9 }, output, brightness: 1, aa: 4 }] }, 3);
  const qc = await q.done;
  ok(qc !== 0 && /no output could be opened/.test(q.out), `with every output refused it opens nothing and exits ${qc}`);

  // ── optional: a real borderless-fullscreen output on display 0 ───────────────────────────────────────
  if (process.argv.includes('--fullscreen')) {
    const fx = execFileSync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -Name D -Namespace N -MemberDefinition "[DllImport(\\"user32.dll\\")] public static extern bool SetProcessDPIAware();"; [void][N.D]::SetProcessDPIAware(); $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($b.Width) $($b.Height)"'], { encoding: 'utf8' }).trim().split(' ').map(Number);
    const expF = expected(fx[0], fx[1]);
    const f = engine({ picture, outputs: [{ name: 'fullscreen', display: { index: 0 }, output, brightness: 0.9, aa: 4 }] }, 5);
    const s = capture(f.pid, 'fullscreen', path.join(WORK, 'shot-full.png'));
    ok(s && s.w === fx[0] && s.h === fx[1] && s.x === 0 && s.y === 0, `fullscreen covers display 0 exactly: ${s ? `${s.w}×${s.h} at (${s.x}, ${s.y})` : 'no window'}`);
    if (s && s.w === fx[0]) { const c = compare(expF, s.png); ok(c.exact === c.n, `fullscreen ON THE SCREEN = offscreen: ${(100 * c.exact / c.n).toFixed(3)}% of ${c.n} (max ${c.max})`); }
    ok((await f.done) === 0, 'the fullscreen output exited at its deadline');
  }
  console.log(fails ? `\nPROJECTOR WINDOWS FAILED: ${fails}` : '\nPROJECTOR WINDOWS OK');
  process.exit(fails ? 1 : 0);
})();
