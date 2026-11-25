#!/usr/bin/env node
// E3m — A SHOW'S SOUND FROM THE NATIVE ENGINE (plans/native-engine.md §4: JUCE in the engine process).
//
//   node scripts/test-engine-audio-show.cjs --packaged <ArtLux.exe>
//
// The audio plugin's calls (configure, loadClip, playClip, gains, meters…) relayed to the JUCE INSIDE the engine
// (`--native-engine --engine-audio`: engineHost.audioCall → the engine's audio thread → artlux_audio.dll, the same
// core.h the addon is) instead of audio_engine.node. A looping show plays a bed (the repo's 100 Hz tone, quietly)
// for ~20 s on a SCRATCH profile. Gates, from the logs:
//   - the plugin says it plays through the engine; the engine loaded its library and OPENED THE DEVICE ITSELF;
//   - the engine's audio clock advances at the device rate and its output peak shows the tone;
//   - a second run WITHOUT --engine-audio (the addon, as before) opens no device in the engine — the switch is
//     the flag and nothing else.
// It makes a faint sound on the default output. Headless, own processes only.
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-engine-audio-show.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const ROOT = path.join(__dirname, '..');
const TONE = path.join(ROOT, 'native', 'audio-engine', 'tone-100.wav');
const WORK = path.join(os.tmpdir(), 'artlux-engine-audio-show');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true });

const project = path.join(WORK, 'engine-audio-show.artlux');
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [], fixtures: [], controllers: [], groups: [], scenes: [], cueBanks: [],
  timeline: { duration: 6, fps: 30, loop: true, layers: [], clips: [] },
  // The bed: the tone over the whole (looping) show, at a low gain.
  audio: { tracks: [{ id: 'atr', name: 'Bed', gain: 0.1, mute: false }], clips: [{ id: 'acl', trackId: 'atr', name: 'tone', path: TONE, start: 0, duration: 6, inPoint: 0, sourceDuration: 3, gain: 1, mute: false }], buses: [] },
  stateMachine: { enabled: true, initialStateId: 'st', states: [{ id: 'st', name: 'Play', x: 100, y: 100, entry: [{ kind: 'play' }] }], transitions: [], regions: [] },
}, null, 2));

async function run(engineAudio, restart = false, extraEnv = {}) {
  for (let i = 0; ; i++) {
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); break; } catch (e) { if (i >= 20) throw e; await sleep(500); }
  }
  fs.mkdirSync(PROFILE, { recursive: true });
  const logf = path.join(WORK, `run-${engineAudio ? 'engine' : 'addon'}${Object.keys(extraEnv).length ? '-mut' : ''}.log`);
  const log = fs.openSync(logf, 'w');
  const env = { ...process.env, ...extraEnv }; delete env.ELECTRON_RUN_AS_NODE;
  const args = [`--user-data-dir=${PROFILE}`, '--headless', `--project=${project}`, '--native-engine', ...(engineAudio ? ['--engine-audio'] : [])];
  const child = spawn(EXE, args, { env, stdio: ['ignore', log, log] });
  try {
    if (!restart) await sleep(20000);
    else {
      // E3n: kill the ENGINE (our own run's child, by the pid main logged) mid-show; main restarts it, and the audio
      // state must come back with it — or the show is silent from here on.
      await sleep(12000);
      const up = fs.readFileSync(logf, 'utf8').match(/\[engine\] up \(pid (\d+)/);
      if (up) { try { execSync(`taskkill /PID ${up[1]} /F`, { stdio: 'ignore' }); } catch { /* gone */ } }
      await sleep(14000);
    }
  }
  finally { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ } }
  return fs.readFileSync(logf, 'utf8').split(/\r?\n/);
}

(async () => {
  let failed = 0;
  const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
  const E = await run(true, true);
  check('the audio plugin plays through the engine', E.some((l) => /\[audio\] playing through the native engine/.test(l)));
  const loaded = E.find((l) => /audio: .*artlux_audio\.dll loaded/.test(l));
  check('the engine loaded its audio library', !!loaded, loaded?.replace(/^.*audio: /, ''));
  const opened = E.find((l) => /audio: device opened in the engine/.test(l));
  check('the engine opened the output device itself', !!opened, opened?.replace(/^.*in the engine — /, ''));
  const clocks = E.map((l) => l.match(/audio: clock ([\d.]+) s \((\d+) samples at ([\d.]+) Hz\), output peak ([\d.]+)/)).filter(Boolean).map((m) => ({ t: +m[1], n: +m[2], rate: +m[3], peak: +m[4] }));
  check('the engine reported its audio clock while the show played', clocks.length >= 4, `${clocks.length} reports`);
  if (clocks.length >= 2) {
    const a = clocks[0], b = clocks[clocks.length - 1];
    check('the audio clock advanced at the device rate', b.n > a.n && Math.abs((b.t - a.t) - (b.n - a.n) / b.rate) < 0.001, `${(b.t - a.t).toFixed(2)} s of audio between the first and last report`);
  }
  const loud = clocks.filter((c) => c.peak > 0.001).length;
  check('the bed is on the engine\'s output', loud >= 2, `${loud} of ${clocks.length} reports above silence (peak up to ${Math.max(0, ...clocks.map((c) => c.peak)).toFixed(4)})`);
  // E3o: THE PICTURE ON THE AUDIO CLOCK — the engine's own clock advances at the sound card's rate (measured against
  // the wall), and the checks against the app's playhead (at the app's instant) stay clean.
  const follows = E.map((l) => l.match(/the engine's clock follows the audio clock — ([+-][\d.]+) ppm against the wall \(±([\d.]+)\), over ([\d.]+) s/)).filter(Boolean);
  const f = follows[follows.length - 1];
  // Against SYSTEM time (the clock the engine reads; NTP-disciplined) — not the monotonic timer test:engine-audio
  // measures against, so the two numbers differ by however far Windows' time sync has the two apart.
  check('the engine\'s clock follows the audio clock', !!f && Math.abs(+f[1]) < 200 && +f[2] < 2, f ? `${f[1]} ppm ±${f[2]} against system time, fitted over ${f[3]} s of device callbacks` : 'never reported');
  const tdiff = E.filter((l) => /transport: differs/.test(l)).length;
  check('the transport checks stay clean on the audio clock', tdiff === 0, `${tdiff} difference line(s)`);
  // E3n: after the kill — the replay, the device reopened, and sound again from the NEW engine.
  const ups = E.filter((l) => /\[engine\] up \(pid/.test(l)).length;
  check('the engine was killed mid-show and restarted', ups >= 2, `${ups} start(s)`);
  const replay = E.find((l) => /audio replayed to the restarted engine/.test(l));
  check('the audio state was replayed to the restarted engine', !!replay && (!/ 0 sounding/.test(replay) || !/ 0 held/.test(replay)), replay?.replace(/^.*engine: /, ''));
  check('the restarted engine opened the device again', E.filter((l) => /audio: device opened in the engine/.test(l)).length >= 2);
  // The clock reports of the NEW engine: from the first report whose clock went BACKWARDS (a fresh process).
  const restartAt = clocks.findIndex((c, i) => i > 0 && c.n < clocks[i - 1].n);
  const after = restartAt > 0 ? clocks.slice(restartAt) : [];
  check('the bed sounds again from the restarted engine', after.filter((c) => c.peak > 0.001).length >= 1, `${after.length} report(s) after the restart, peak up to ${Math.max(0, ...after.map((c) => c.peak)).toFixed(4)}`);
  const relayErr = E.filter((l) => /audio: .* failed|no audio library|audio call failed/.test(l));
  check('no relayed call failed', relayErr.length === 0, relayErr.slice(0, 2).join(' | '));
  // E3p: THE SOUND HELD TO THE ENGINE'S CLOCK — where each play really landed against the engine's clock, then every
  // check after it within the hold (2 ms; a seek corrects anything further), also on the restarted engine.
  const landed = E.map((l) => l.match(/audio: clip (\S+) landed ([+-][\d.]+) ms from the engine's clock/)).filter(Boolean).map((m) => +m[2]);
  const holds = (L) => L.map((l) => l.match(/holding (\d+) clip\(s\) to the engine's clock — within ([\d.]+) ms over (\d+) checks since the last report, (\d+) re-seek/)).filter(Boolean).map((m) => ({ ms: +m[2], checks: +m[3], seeks: +m[4] }));
  const H = holds(E);
  check('the engine read where each play landed against its own clock', landed.length >= 2, `landed ${landed.map((x) => x.toFixed(1)).join(', ')} ms`);
  check('the engine held the bed to its clock', H.length >= 3 && H.every((h) => h.ms <= 2.5), `${H.length} reports, within ${Math.max(0, ...H.map((h) => h.ms)).toFixed(2)} ms at worst, ${H.length ? H[H.length - 1].seeks : 0} re-seek(s)`);
  const ri = E.findIndex((l) => /audio replayed to the restarted engine/.test(l));
  check('…and again on the restarted engine', ri > 0 && E.slice(ri).some((l) => /audio: clip \S+ landed/.test(l)) && holds(E.slice(ri)).length >= 1);
  // E3q: THE ENGINE DECIDES THE PLAYS — the bed (a 3 s tone in a 6 s window of a 6 s loop) is started by the engine
  // at each pass of its window and stopped where its source runs out, and the driver sends no play at all.
  const starts = E.map((l) => l.match(/the engine started clip (\S+) at ([\d.]+) s of its source — ([\d.]+) ms into its window/)).filter(Boolean).map((m) => ({ src: +m[2], into: +m[3] }));
  const decided = E.map((l) => l.match(/the engine decided (\d+) start\(s\) and (\d+) stop\(s\) in all; the driver sent (\d+) play/)).filter(Boolean).map((m) => ({ starts: +m[1], stops: +m[2], plays: +m[3] }));
  // Each pass of the window is CUED ahead (through the loop's wrap) and started by the mix loop on the sample — the
  // landing that follows reads where it really began (half a block at most: 5 ms at 480 / 48 kHz).
  const cues = E.map((l) => l.match(/the engine cued clip (\S+) at ([\d.]+) s of its source — its window opens in ([\d.]+) ms/)).filter(Boolean).map((m) => ({ src: +m[2], ahead: +m[3] }));
  check('the engine cues the bed at each pass of its window', cues.length >= 2 && cues.every((c) => c.src < 0.01), `${cues.length} cue(s), ${cues.map((c) => c.ahead.toFixed(1) + ' ms ahead').join(', ')}; ${starts.length} late start(s)`);
  check('…and each cued start lands on the engine\'s clock', landed.length >= cues.length && landed.every((x) => Math.abs(x) <= 5.5), `landed ${landed.map((x) => x.toFixed(2)).join(', ')} ms`);
  check('the engine stops it where its source runs out', E.some((l) => /the engine stopped clip \S+ — its source ran out/.test(l)));
  check('the driver sent no play — the engine decided them all', decided.length >= 1 && decided.every((d) => d.plays === 0), decided.length ? `last: ${JSON.stringify(decided[decided.length - 1])}` : 'never reported');

  // The mutation: the engine wants every clip 40 ms further on than the app played it — it must find that, re-seek,
  // and HOLD the clip there (a correction that did not land would be re-seeked on every check).
  const S = await run(true, false, { ARTLUX_AUDIO_LOCK_SKEW_MS: '40' });
  const reseeks = S.map((l) => l.match(/re-seeked to the engine's clock — it was ([+-][\d.]+) ms off/)).filter(Boolean).map((m) => +m[1]);
  const HS = holds(S);
  check('mutation: a clip 40 ms from the engine\'s clock is re-seeked', reseeks.length >= 1 && reseeks.every((x) => Math.abs(x + 40) < 15), `${reseeks.length} re-seek(s), off by ${reseeks.slice(0, 4).map((x) => x.toFixed(1)).join(', ')} ms`);
  check('mutation: …and lands, and stays', HS.length >= 3 && HS.every((h) => h.ms <= 2.5) && reseeks.length <= 8, `within ${Math.max(0, ...HS.map((h) => h.ms)).toFixed(2)} ms at worst after, ${reseeks.length} re-seek(s) in 20 s`);

  const A = await run(false);
  check('without --engine-audio the plugin keeps its addon', !A.some((l) => /\[audio\] playing through the native engine/.test(l)));
  check('…and the engine opens no device', !A.some((l) => /audio: device opened in the engine/.test(l)));
  console.log(failed ? `\nengine audio show: ${failed} FAILED` : '\nengine audio show OK');
  process.exit(failed ? 1 : 0);
})();
