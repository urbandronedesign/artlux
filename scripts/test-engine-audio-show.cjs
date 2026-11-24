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

async function run(engineAudio) {
  for (let i = 0; ; i++) {
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); break; } catch (e) { if (i >= 20) throw e; await sleep(500); }
  }
  fs.mkdirSync(PROFILE, { recursive: true });
  const logf = path.join(WORK, `run-${engineAudio ? 'engine' : 'addon'}.log`);
  const log = fs.openSync(logf, 'w');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const args = [`--user-data-dir=${PROFILE}`, '--headless', `--project=${project}`, '--native-engine', ...(engineAudio ? ['--engine-audio'] : [])];
  const child = spawn(EXE, args, { env, stdio: ['ignore', log, log] });
  try { await sleep(20000); }
  finally { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ } }
  return fs.readFileSync(logf, 'utf8').split(/\r?\n/);
}

(async () => {
  let failed = 0;
  const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
  const E = await run(true);
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
  const relayErr = E.filter((l) => /audio: .* failed|no audio library|audio call failed/.test(l));
  check('no relayed call failed', relayErr.length === 0, relayErr.slice(0, 2).join(' | '));

  const A = await run(false);
  check('without --engine-audio the plugin keeps its addon', !A.some((l) => /\[audio\] playing through the native engine/.test(l)));
  check('…and the engine opens no device', !A.some((l) => /audio: device opened in the engine/.test(l)));
  console.log(failed ? `\nengine audio show: ${failed} FAILED` : '\nengine audio show OK');
  process.exit(failed ? 1 : 0);
})();
