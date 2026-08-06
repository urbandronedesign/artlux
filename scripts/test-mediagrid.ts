// Standalone test for components/mediaGridWindow — the Media panel's windowing arithmetic.
//
// Worth asserting rather than eyeballing: an off-by-one in `perRow` misplaces every spacer, and a
// window that never reaches the last row makes the final assets unreachable — which looks like "the
// import didn't work" rather than like a scrolling bug. All pure, so it runs with no Electron.
//
//   npx tsc -p scripts/tsconfig.test.json && node .tmp-tests/scripts/test-mediagrid.js

import { gridWindow, type GridMetrics } from '../src/renderer/components/mediaGridWindow';

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log(`  ok   ${name}`); return; }
  console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`);
  failed++;
}
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  console.log(`  FAIL ${name}${detail ? '  (' + detail + ')' : ''}`);
  failed++;
}

// A medium-tile grid in a 320px column: (320-16+8) / (74+8) = 3.8 → 3 per row.
const base: GridMetrics = { count: 60, width: 320, height: 200, scrollTop: 0, tileW: 74, rowH: 61, gap: 8, padX: 16 };

check('columns fit as auto-fill would lay them out', gridWindow(base).perRow, 3);
check('a column narrower than one tile still fits one', gridWindow({ ...base, width: 40 }).perRow, 1);
check('list view is always one per row', gridWindow({ ...base, single: true }).perRow, 1);

// ── The window starts at the top and includes overscan ──────────────────────────────────────────
const top = gridWindow(base);
check('starts at item 0', top.from, 0);
check('no spacer above at scrollTop 0', top.top, 0);
ok('mounts far fewer than the whole library', top.to < base.count, `${top.to} of ${base.count}`);
ok('mounts more than fills the viewport (overscan)', top.to >= 3 * Math.ceil(200 / 69), `to=${top.to}`);

// ── Spacers must always sum to the full content height, or the scrollbar lies ────────────────────
const step = base.rowH + base.gap;
const rows = Math.ceil(base.count / gridWindow(base).perRow);
for (const scrollTop of [0, 100, 500, 1000, 99999]) {
  const w = gridWindow({ ...base, scrollTop });
  const mountedRows = Math.ceil((w.to - w.from) / w.perRow);
  const total = w.top + mountedRows * step + w.bottom;
  ok(`spacers + mounted rows == content height (scrollTop ${scrollTop})`,
     Math.abs(total - rows * step) <= step, `${total} vs ${rows * step}`);
  ok(`no negative spacer (scrollTop ${scrollTop})`, w.top >= 0 && w.bottom >= 0, `${w.top}/${w.bottom}`);
  ok(`window stays inside the list (scrollTop ${scrollTop})`, w.to <= base.count && w.from <= w.to, `${w.from}..${w.to}`);
}

// ── Scrolled to the very bottom, the LAST item must be mounted ───────────────────────────────────
const bottom = gridWindow({ ...base, scrollTop: rows * step });
check('the last item is reachable', bottom.to, base.count);
check('no spacer below at the end', bottom.bottom, 0);

// ── Degenerate inputs must not produce nonsense ──────────────────────────────────────────────────
check('empty library', gridWindow({ ...base, count: 0 }), { from: 0, to: 0, top: 0, bottom: 0, perRow: 3 });
const unmeasured = gridWindow({ ...base, height: 0 });
ok('an unmeasured viewport still mounts something', unmeasured.to > 0, `to=${unmeasured.to}`);
const stale = gridWindow({ ...base, count: 2, scrollTop: 5000 });
ok('a stale scrollTop after filtering cannot go negative', stale.bottom >= 0 && stale.to <= 2, JSON.stringify(stale));

console.log(failed ? `\n${failed} FAILED\n` : '\nall passed\n');
process.exit(failed ? 1 : 0);
