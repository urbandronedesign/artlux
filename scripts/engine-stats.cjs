// Summarise the engine's per-stage stats (ARTLUX_ENGINE_STATS=1, engine/artlux-engine/src/prof.rs) from a log.
//   node scripts/engine-stats.cjs <log> [--skip-reports=N]   (plans/engine-optimisation-and-deferred-3d.md: the before / after)
// Each 5 s report is `artlux-engine: stats <thread>: <stage> <n>× p50 <a> p99 <b> max <c> ms · …`. Per thread and
// stage this prints: calls per report (median), the MEDIAN of the reports' p50s, the median and the worst of their
// p99s, and the worst max — so one bad 5 s does not hide in an average, and one good one does not flatter.
const fs = require('fs');
const file = process.argv[2];
const skip = Number((process.argv.find((a) => a.startsWith('--skip-reports=')) || '=2').split('=')[1]);
const text = fs.readFileSync(file, 'utf8');
const by = new Map(); // thread -> stage -> [{n,p50,p99,max}]
const seen = new Map();
for (const l of text.split(/\r?\n/)) {
  const m = /stats (.+?): (.+ ms)$/.exec(l);
  if (!m || /presents\/s/.test(l)) continue;
  const th = m[1]; const k = (seen.get(th) || 0) + 1; seen.set(th, k);
  if (k <= skip) continue; // warm-up reports
  for (const part of m[2].split(' · ')) {
    const q = /^(\S+) (\d+)× p50 ([\d.]+) p99 ([\d.]+) max ([\d.]+) ms$/.exec(part.trim());
    if (!q) continue;
    if (!by.has(th)) by.set(th, new Map());
    const st = by.get(th); if (!st.has(q[1])) st.set(q[1], []);
    st.get(q[1]).push({ n: +q[2], p50: +q[3], p99: +q[4], max: +q[5] });
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
for (const [th, st] of [...by].sort()) {
  console.log(`${th}`);
  for (const [stage, r] of st) {
    console.log(`  ${stage.padEnd(12)} ${String(med(r.map((x) => x.n))).padStart(5)}/5s  p50 ${med(r.map((x) => x.p50)).toFixed(2).padStart(7)}  p99 ${med(r.map((x) => x.p99)).toFixed(2).padStart(7)} (worst ${Math.max(...r.map((x) => x.p99)).toFixed(2)})  max ${Math.max(...r.map((x) => x.max)).toFixed(2)} ms   [${r.length} reports]`);
  }
}
