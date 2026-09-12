// Standalone test for engine/renderClock — the one answer to "what time is this frame".
//
// Runnable with no Electron, no bundler and no app (see scripts/tsconfig.test.json). The module is
// twelve lines of state and it is read from the hottest loop in the app, so the temptation is to
// assume it obviously works. It does not obviously work: three of the four behaviours below are
// refusals, and a refusal that silently does the opposite is exactly the kind of bug that would
// surface as "the bake recorded the wrong frames" three hours into a render.
//
//   npx tsc -p scripts/tsconfig.test.json && node .tmp-tests/scripts/test-renderclock.js

import * as clock from '../src/renderer/engine/renderClock';

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log(`  ok   ${name}`); return; }
  console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`);
  failed++;
}

// ── Live mode is the wall ────────────────────────────────────────────────────────────────────────
check('starts live', clock.isOffline(), false);
{
  const a = clock.now();
  const b = clock.now();
  check('live now() advances with the wall (b >= a)', b >= a, true);
  check('live now() is near performance.now()', Math.abs(clock.now() - performance.now()) < 50, true);
}

// ── stepTo is inert in live mode ─────────────────────────────────────────────────────────────────
// A caller that steps without taking the clock first has a bug; obeying it would silently freeze the
// show's clock at an arbitrary number, which is unrecoverable and looks like a transport failure.
{
  clock.stepTo(1_000_000);
  check('stepTo() is refused in live mode', Math.abs(clock.now() - performance.now()) < 50, true);
}

// ── Offline mode is stable within a frame ────────────────────────────────────────────────────────
// THE load-bearing property: two reads inside one rendered frame must be the same number. In live
// mode they can differ by a millisecond, which is fine for a show and fatal for a reproducible bake.
{
  const flips: boolean[] = [];
  const off = clock.subscribe((o) => flips.push(o));

  clock.beginOffline(5_000);
  check('beginOffline flips the mode', clock.isOffline(), true);
  check('beginOffline seeds now() from its argument', clock.now(), 5000);
  check('the flip is announced', flips, [true]);

  check('now() is STABLE across reads while offline', clock.now() === clock.now(), true);

  clock.stepTo(5_016.6667);
  check('stepTo moves it', clock.now(), 5016.6667);

  // Absolute, not a delta — the bake computes `start + i / fps` per frame so rounding cannot accumulate.
  clock.stepTo(5_033.3333);
  check('stepTo is absolute', clock.now(), 5033.3333);

  // ── The two refusals that keep a render honest ──
  clock.stepTo(5_000);
  check('stepTo() refuses to go backwards', clock.now(), 5033.3333);
  clock.stepTo(Number.NaN);
  check('stepTo() refuses NaN', clock.now(), 5033.3333);

  // Idempotent: a second starter must not yank the cursor back to the top of the render.
  clock.beginOffline(1_000);
  check('beginOffline is idempotent, not a reset', clock.now(), 5033.3333);
  check('no second flip announced', flips, [true]);

  clock.endOffline();
  check('endOffline returns to the wall', clock.isOffline(), false);
  check('both flips announced', flips, [true, false]);
  check('now() is the wall again', Math.abs(clock.now() - performance.now()) < 50, true);

  // endOffline twice must not announce twice — a subscriber re-anchors on this signal, and a spurious
  // re-anchor while live would move the playhead by whatever drifted between the two calls.
  clock.endOffline();
  check('endOffline is idempotent', flips, [true, false]);

  off();
  clock.beginOffline(9_000);
  check('unsubscribe holds', flips, [true, false]);
  clock.endOffline();
}

// ── A subscriber that throws cannot take the flip down with it ───────────────────────────────────
// The re-anchor in timeline.ts rides this callback. If one subscriber throwing stopped the rest from
// being told, a clock hand-back could leave a derived clock anchored to an epoch minutes stale.
{
  const seen: string[] = [];
  const a = clock.subscribe(() => { throw new Error('boom'); });
  const b = clock.subscribe(() => { seen.push('b'); });
  clock.beginOffline(1_000);
  check('a throwing subscriber does not stop the others', seen, ['b']);
  a(); b();
  clock.endOffline();
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall passed\n');
process.exit(failed ? 1 : 0);
