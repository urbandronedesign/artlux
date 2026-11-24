#!/usr/bin/env node
// E3j — THE ENGINE CHOOSES A VIDEO TRACK'S FRAME (plans/native-engine.md §4: "playhead → clip/frame mapping").
//
//   node scripts/test-video-frame-clock.cjs --packaged <ArtLux.exe> --hap <clip.mov> --mp4 <film.mp4>
//
// Until E3j the frame a HAP / MP4 track drew was the APP's (its decoded index / VideoFrame timestamp rode the
// tick). Now the engine chooses it from the clip time as the app's codecs do (eval.rs VidTable: HAP
// `round(t·fps)` clamped, MP4 the last presentation time at or before t + 1 ms) at its OWN clock, and CHECKS its
// choice at the app's instant against the frame the app showed. A looping 10 s show plays itself for ~24 s, the
// engine owning the wire: a HAP track, and a real FILM on an MP4 track (a Full HD / 4K H.264 or HEVC, BT.709 — the
// owner's choice, 2026-11-24: "use a film already on the computer") cut in two — 0–5 s from its start, 5–10 s from
// its 5 s mark — so the track crosses a video clip boundary and the second cut starts mid-GOP.
// Gates: the clock checks clean (0 differences), the engine's frame IS the app's on nearly every playing tick
// (the app shows what its decoder has ready — a frame not decoded yet in time is the only way they part), and
// both tracks move on the wire. Headless, SCRATCH profile, own processes only.
const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
const hk = process.argv.indexOf('--hap');
const HAP = hk > 0 ? path.resolve(process.argv[hk + 1]) : process.env.ARTLUX_HAP;
if (!EXE || !HAP || !fs.existsSync(HAP)) { console.error('usage: node scripts/test-video-frame-clock.cjs --packaged <ArtLux.exe> --hap <clip.mov> (or ARTLUX_HAP)'); process.exit(2); }
const mk = process.argv.indexOf('--mp4');
const MP4 = mk > 0 ? path.resolve(process.argv[mk + 1]) : process.env.ARTLUX_MP4;
if (!MP4 || !fs.existsSync(MP4)) { console.error('needs a film: --mp4 <file.mp4> (or ARTLUX_MP4) — Full HD or 4K, at least 10 s'); process.exit(2); }
const PORT = 6498;
const WORK = path.join(os.tmpdir(), 'artlux-video-frame-clock');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true });

const project = path.join(WORK, 'video-frame-clock.artlux');
const strip = (id, sid, uni, y) => ({ id, name: id, surfaceId: sid, x: 0.03, y, width: 0.9, height: 0.01, rotation: 0, ledCount: 150, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 });
const vclip = (id, layerId, p, start, duration, inPoint = 0) => ({ id, layerId, name: id, path: p, start, duration, inPoint });
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [
    { id: 'sM', name: 'MP4 track', x: 0.02, y: 0.02, width: 0.96, height: 0.45, rotation: 0, zIndex: 0, content: { type: 'LAYER', layerId: 'LM', opacity: 1 } },
    { id: 'sH', name: 'HAP track', x: 0.02, y: 0.52, width: 0.96, height: 0.45, rotation: 0, zIndex: 1, content: { type: 'LAYER', layerId: 'LH', opacity: 1 } },
  ],
  fixtures: [strip('fM', 'sM', 0, 0.25), strip('fH', 'sH', 1, 0.75)],
  timeline: { duration: 10, fps: 30, loop: true, layers: [{ id: 'LH', name: 'HAP', opacity: 1 }, { id: 'LM', name: 'MP4', opacity: 1 }], clips: [vclip('cH', 'LH', HAP, 0, 10), vclip('cM1', 'LM', MP4, 0, 5), vclip('cM2', 'LM', MP4, 5, 5, 5)] },
  stateMachine: { enabled: true, initialStateId: 'st', states: [{ id: 'st', name: 'Play', x: 100, y: 100, entry: [{ kind: 'play' }] }], transitions: [], regions: [] },
  controllers: [], groups: [], scenes: [], cueBanks: [],
}, null, 2));

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true }); fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'artlux-prefs.json'), JSON.stringify({ appSettings: { outputEnabled: true, artNetIp: '127.0.0.1', artNetPort: PORT, broadcast: false, protocol: 'artnet' } }));
  const all = new Map();
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (m) => {
    if (m.length < 18 || m.toString('latin1', 0, 7) !== 'Art-Net' || m.readUInt16LE(8) !== 0x5000) return;
    const uni = m.readUInt16LE(14);
    if (!all.has(uni)) all.set(uni, []);
    all.get(uni).push(Array.from(m.subarray(18, 18 + m.readUInt16BE(16))).reduce((a, b) => a + b, 0));
  });
  await new Promise((r) => sock.bind(PORT, '127.0.0.1', r));
  const logf = path.join(WORK, 'run-engine.log');
  const log = fs.openSync(logf, 'w');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--user-data-dir=${PROFILE}`, '--headless', `--project=${project}`, '--native-engine'], { env, stdio: ['ignore', log, log] });
  try {
    await sleep(12000);
    for (const k of [...all.keys()]) all.set(k, []);
    await sleep(12000);
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
    sock.close();
  }
  const lines = fs.readFileSync(logf, 'utf8').split(/\r?\n/);
  let failed = 0;
  if (!lines.some((l) => /owns the wire/.test(l))) { console.log('FAIL: the engine never took the wire'); failed++; }
  const sums = lines.filter((l) => /video frames chosen by the engine/.test(l));
  const last = sums[sums.length - 1] ?? '';
  // The summary is printed per document, so read the running counters off the run's last tick instead: the
  // engine's clock summary carries them too.
  const m = last.match(/(\d+) difference\(s\) from the app so far; drawn at the engine's own clock (\d+) time\(s\), held at the app's playhead across a clip boundary (\d+) time\(s\); video frames chosen by the engine: (\d+) the app's, (\d+) not the app's/);
  if (!m) { console.log('FAIL: no frame-choice summary from the engine'); failed++; }
  else {
    const [, diffs, drawn, held, same, other] = m.map(Number);
    const share = same / Math.max(1, same + other);
    console.log(`clock differences ${diffs}; tracks drawn at the engine's clock ${drawn}, held ${held}; frames: ${same} the app's, ${other} not (${(share * 100).toFixed(1)}% the same)`);
    if (diffs !== 0) { console.log('FAIL: the clock checks differ'); failed++; }
    if (same + other < 100) { console.log('FAIL: too few video frames chosen'); failed++; }
    if (share < 0.9) { console.log('FAIL: the engine\'s frame is not the app\'s on most ticks'); failed++; }
  }
  for (const [uni, name] of [[0, 'MP4 track'], [1, 'HAP track']]) {
    const s = all.get(uni) ?? [];
    const distinct = new Set(s).size;
    let changes = 0; for (let i = 1; i < s.length; i++) if (s[i] !== s[i - 1]) changes++;
    console.log(`universe ${uni} ${name}: ${s.length} frames, ${distinct} distinct levels, ${changes} changes`);
    if (s.length < 200 || distinct < 6 || changes < 30) { console.log(`FAIL universe ${uni}: the ${name} did not move on the wire`); failed++; }
  }
  console.log(failed ? `\nvideo frame clock: ${failed} FAILED` : '\nvideo frame clock OK');
  process.exit(failed ? 1 : 0);
})();
