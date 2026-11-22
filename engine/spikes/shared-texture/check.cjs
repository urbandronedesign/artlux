// E0c spike check: runs the spike app, then judges spike-result.json.
//   node engine/spikes/shared-texture/check.cjs [outDir]        (SPIKE_ISOLATED=1: the sandboxed, isolated page)
// Claims: every frame the engine announced reached the page and was drawn (none lost, no send error);
// the four test-card quadrants are exact; and the live bar in each report sits where THAT frame's number
// puts it — so the page shows exactly the frame announced, never a slot's stale or half-written contents.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(require('node:os').tmpdir(), 'artlux-e0c'));
fs.mkdirSync(OUT, { recursive: true });
try { fs.unlinkSync(path.join(OUT, 'spike-result.json')); } catch { /* none */ }
const env = { ...process.env, SPIKE_OUT: OUT };
delete env.ELECTRON_RUN_AS_NODE;
spawnSync(path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'), [__dirname], { env, stdio: 'inherit', timeout: 90000 });
let r;
try { r = JSON.parse(fs.readFileSync(path.join(OUT, 'spike-result.json'), 'utf8')); } catch (e) { console.log('FAIL no result:', e.message); process.exit(1); }
let fails = 0;
const note = (ok, what) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const s = r.stats;
console.log(r.isolated ? 'page: sandboxed + context-isolated, frames through the preload' : 'page: node integration');
note(r.engineExit === 0, `the engine ran and exited cleanly (exit ${r.engineExit})`);
note(s.announced > 0 && s.sent === s.announced && s.drawn === s.announced && s.sendErrors === 0,
  `every announced frame reached the page and was drawn: announced ${s.announced}, sent ${s.sent}, drawn ${s.drawn}, send errors ${s.sendErrors}${r.lastError ? ` (${r.lastError})` : ''}`);
const want = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], white: [255, 255, 255] };
const w = s.slots ? s.slots.w : 640;
let exact = 0, onFrame = 0;
for (const x of r.reports) {
  if (Object.entries(want).every(([k, v]) => x.quads[k].join() === v.join())) exact++;
  if (x.barX === Math.ceil(((x.n % 240) / 240) * w - 0.5)) onFrame++;
}
note(r.reports.length >= 3 && exact === r.reports.length, `the page's pixels: quadrants exact in ${exact}/${r.reports.length} reports`);
note(r.reports.length >= 3 && onFrame === r.reports.length, `each report shows the frame announced (bar on frame n): ${onFrame}/${r.reports.length}`);
console.log(fails ? `${fails} FAILED` : 'ALL PASSED', `— ${OUT}`);
process.exit(fails ? 1 : 0);
