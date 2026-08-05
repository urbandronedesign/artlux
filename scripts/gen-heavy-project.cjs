// ArtLux heavy-project generator — the fixture for the cold-open bench (scripts/bench-open.cjs).
//
// WHY THIS EXISTS. The preload plan (plans: preload optimization) is judged on four metrics, and two of
// them — time-to-arm as a function of scene count, bytes read vs. bytes shown — need a project whose
// size is a KNOB, not whichever show happens to be on disk. This writes a real, openable project folder
// (project.artlux + assets/) shaped to hit the known scaling bugs on purpose:
//
//   · N scenes, each a full look snapshot with its own timeline — the O(scenes) normalize + parse cost;
//   · L layers × C clips per scene cycling a small media pool — warmMedia's every-clip read fan-out;
//   · a HUB state with 10 outgoing transitions — defeats the preloader budget (evictExcess protect-set
//     bypass, timelinePreloader.ts) until phase 2 fixes it;
//   · at least one fromAny transition — never preloaded (App.tsx look-ahead filters on t.from);
//   · a global audio bed + a per-scene sting at start=0 — the serial audio load and the
//     "sting loses its attack" re-decode (plugin.renderer.ts:431-445).
//
// MEDIA. --media <dir[,dir2]> uses REAL clips, probed for their actual codec so the fixture can
// guarantee what each scene contains. By default they are REFERENCED IN PLACE (absolute paths — the
// shape ArtLux already supports for assets outside a project folder); --copy-media copies them in
// instead, which is honest about a collected show but duplicates gigabytes. --synthetic writes filler
// byte files: they exercise ONLY the read path (the codec probe fails, <video> errors, so the gate
// always times out), which is useful for I/O and parse questions and useless for decode ones — the
// output says so in both places.
//
// EVERY SCENE IS GUARANTEED A REAL VIDEO. With a mixed pool each scene's first two layers get one HAP
// and one H.264 clip, so both decode paths are exercised in every scene — HAP's pre-roll ring and
// mp4's WebCodecs pipeline behave very differently at open, and a fixture that only happened to
// include one of them would measure half the problem.
//
// Audio is always real: tiny PCM WAVs are generated here (a sine sting + a bed), so the audio plugin's
// load/conform path runs in every mode.
//
// Usage:
//   node scripts/gen-heavy-project.cjs --out .traces/bench/heavy --scenes 60 --media "D:\clips,D:\hap"
//   node scripts/gen-heavy-project.cjs --out .traces/bench/sweep --scenes 1,10,40,120 --synthetic
//
// Flags:
//   --out <dir>              output project folder (sweep mode appends -<n> per scene count)
//   --scenes <n | a,b,c>     scene count, or a comma sweep (one folder per count)
//   --clips-per-scene <n>    default 12
//   --layers <n>             default 4
//   --surfaces <n>           default 24
//   --fixtures <n>           LED fixtures (default 24)
//   --leds <n>               LEDs per fixture (default 125 — 24x125 = 3000 LEDs, 500ch/universe)
//   --media <dir[,dir]>      real clips, probed for codec; referenced in place unless --copy-media
//   --copy-media             copy the pool into assets/video instead of referencing it
//   --synthetic              filler video files (read-path-only; labelled)
//   --synthetic-mb <n>       size of each filler file (default 8)
//   --pool <n>               distinct media files to cycle (default 24, capped by what --media holds)

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const OUT = path.resolve(ROOT, arg('out', '.traces/bench/heavy'));
const SCENE_COUNTS = String(arg('scenes', '60')).split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const CLIPS = Number(arg('clips-per-scene', 12));
const LAYERS = Number(arg('layers', 4));
const SURFACES = Number(arg('surfaces', 24));
const MEDIA_DIRS = (arg('media', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SYNTHETIC = has('synthetic') || !MEDIA_DIRS.length;
const COPY_MEDIA = has('copy-media');
const SYNTH_MB = Number(arg('synthetic-mb', 8));
const POOL = Number(arg('pool', 24));
const FIXTURES = Number(arg('fixtures', 24));
const LEDS_PER_FIXTURE = Number(arg('leds', 125));

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv']);

// ---------------------------------------------------------------------------
// Codec probe — which decode path will this file actually take?
//
// Not cosmetic: the fixture PROMISES each scene a HAP clip and an H.264 clip, and it can only keep
// that promise if it knows what it is holding. Extension does not tell you — the HAP samples here are
// `.mov`, and so is ProRes. So look for the codec fourcc in the container. Crude on purpose (scan the
// head and tail rather than walk the atom tree): `moov` sits at the front of a faststart file and at
// the end of everything else, and a misclassification only costs a less-balanced fixture, never a
// wrong measurement — the app decodes whatever it is handed regardless of what this guessed.
// ---------------------------------------------------------------------------
const HAP_FOURCC = ['Hap1', 'Hap5', 'HapY', 'HapM', 'HapA'];
const H264_FOURCC = ['avc1', 'avc3', 'hvc1', 'hev1'];

function probeCodec(file) {
    const size = fs.statSync(file).size;
    const N = Math.min(4 * 1048576, size);
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(N); fs.readSync(fd, head, 0, N, 0);
    const tail = Buffer.alloc(N); fs.readSync(fd, tail, 0, N, Math.max(0, size - N));
    fs.closeSync(fd);
    const hit = (cc) => head.includes(Buffer.from(cc, 'latin1')) || tail.includes(Buffer.from(cc, 'latin1'));
    if (HAP_FOURCC.some(hit)) return 'hap';
    if (H264_FOURCC.some(hit)) return 'mp4';
    return 'other';
}
let idCounter = 0;
const id = (p) => `${p}_${(++idCounter).toString(36)}`;

// ---------------------------------------------------------------------------
// Real PCM WAVs — the audio path must be exercised honestly even in synthetic mode. 16-bit mono 22.05k.
// ---------------------------------------------------------------------------
function writeWav(file, seconds, freq) {
    const rate = 22050;
    const n = Math.floor(rate * seconds);
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
        // A decaying sine: the sting has an ATTACK, which is the thing the no-preload bug eats.
        const env = Math.exp(-3 * (i / n));
        data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000 * env), i * 2);
    }
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(data.length, 40);
    fs.writeFileSync(file, Buffer.concat([h, data]));
}

// ---------------------------------------------------------------------------
// Media pool → assets/video/, returning project-relative paths (resolveAssets joins them at open).
// ---------------------------------------------------------------------------
// Returns [{ path, codec, bytes }] — `path` project-relative when copied/synthetic, ABSOLUTE when
// referenced in place (relativizeAssets keeps externals absolute, so this is a shape ArtLux already
// carries, and it is worth exercising: it is exactly what the media-protocol allowlist must admit).
function buildMediaPool(dir) {
    const vidDir = path.join(dir, 'assets', 'video');
    fs.mkdirSync(vidDir, { recursive: true });
    const pool = [];
    if (!SYNTHETIC) {
        const found = [];
        for (const d of MEDIA_DIRS) {
            if (!fs.existsSync(d)) { console.error(`--media dir not found: ${d}`); process.exit(1); }
            for (const f of fs.readdirSync(d)) {
                if (VIDEO_EXT.has(path.extname(f).toLowerCase())) found.push(path.join(d, f));
            }
        }
        if (!found.length) { console.error(`no video files under --media ${MEDIA_DIRS.join(', ')}`); process.exit(1); }
        const probed = found.map((f) => ({ abs: f, codec: probeCodec(f), bytes: fs.statSync(f).size }));
        // Interleave HAP and mp4 so a --pool smaller than the library still gets both, and take the
        // SMALLEST of each first: a bench that opens with two 1 GB files measures the disk, not the app.
        const hap = probed.filter((p) => p.codec === 'hap').sort((a, b) => a.bytes - b.bytes);
        const mp4 = probed.filter((p) => p.codec === 'mp4').sort((a, b) => a.bytes - b.bytes);
        const other = probed.filter((p) => p.codec === 'other');
        const picked = [];
        for (let i = 0; picked.length < POOL && (i < hap.length || i < mp4.length); i++) {
            if (i < hap.length && picked.length < POOL) picked.push(hap[i]);
            if (i < mp4.length && picked.length < POOL) picked.push(mp4[i]);
        }
        for (const o of other) if (picked.length < POOL) picked.push(o);
        for (const p of picked) {
            let ref = p.abs;
            if (COPY_MEDIA) {
                fs.copyFileSync(p.abs, path.join(vidDir, path.basename(p.abs)));
                ref = `assets/video/${path.basename(p.abs)}`;
            }
            pool.push({ path: ref, codec: p.codec, bytes: p.bytes, name: path.basename(p.abs) });
        }
        return pool;
    }
    {
        // Filler bytes with a real-looking name. Deliberately NOT a valid container: this pool measures
        // the read path only, and pretending otherwise is how a bench lies. Non-repeating content so
        // nothing between here and the disk can dedupe/compress it into a fake fast read.
        const chunk = Buffer.alloc(1 << 16);
        for (let f = 0; f < POOL; f++) {
            const file = path.join(vidDir, `synthetic-${String(f).padStart(2, '0')}.mp4`);
            const fd = fs.openSync(file, 'w');
            for (let written = 0; written < SYNTH_MB * 1048576; written += chunk.length) {
                for (let i = 0; i < chunk.length; i += 4) chunk.writeUInt32LE(((f + 1) * 2654435761 + written + i) >>> 0, i);
                fs.writeSync(fd, chunk);
            }
            fs.closeSync(fd);
            pool.push({ path: `assets/video/synthetic-${String(f).padStart(2, '0')}.mp4`, codec: 'synthetic', bytes: SYNTH_MB * 1048576, name: `synthetic-${f}` });
        }
    }
    return pool;
}

// ---------------------------------------------------------------------------
// Document pieces — shapes copied from examples/*.artlux + renderer/types.ts (VideoClip, VideoLayer).
// ---------------------------------------------------------------------------
function makeSurfaces(pool) {
    const cols = Math.ceil(Math.sqrt(SURFACES));
    return Array.from({ length: SURFACES }, (_, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        const w = 1 / cols, h = 1 / Math.ceil(SURFACES / cols);
        // A few VIDEO surfaces (their media is what surfaceMedia.pendingMedia gates on); the rest EFFECT
        // (free — the gate must NOT wait on generative content, and the bench would catch it if it did).
        const content = i < Math.min(4, pool.length)
            ? { type: 'VIDEO', url: pool[i % pool.length].path }
            : { type: 'EFFECT', effectId: (i % 8) + 1, paletteId: (i % 5) + 1, speed: 0.3, intensity: 0.7, opacity: 1 };
        return { id: id('srf'), name: `Surface ${i + 1}`, x: col * w, y: row * h, width: w, height: h, rotation: 0, zIndex: i, content };
    });
}

function makeTimeline(pool, sceneIdx) {
    const layers = Array.from({ length: LAYERS }, (_, l) => ({ id: id('lyr'), name: `Layer ${l + 1}` }));
    const clips = [];
    const perLayer = Math.max(1, Math.round(CLIPS / LAYERS));
    const clipDur = 5;
    const hapPool = pool.filter((p) => p.codec === 'hap');
    const mp4Pool = pool.filter((p) => p.codec === 'mp4');
    for (let l = 0; l < layers.length; l++) {
        for (let c = 0; c < perLayer; c++) {
            // EVERY SCENE GETS A REAL HAP AND A REAL H.264 AT ITS START. The two decode paths are not
            // interchangeable — HAP fills a pre-roll ring the boot gate can wait on, mp4 runs a
            // WebCodecs pipeline that (today) the gate cannot see into at all — so a fixture that
            // happened to give a scene only one of them would measure half the opening cost. Layers 0
            // and 1 are pinned; everything else cycles the whole pool.
            let src;
            if (c === 0 && l === 0 && hapPool.length) src = hapPool[sceneIdx % hapPool.length];
            else if (c === 0 && l === 1 && mp4Pool.length) src = mp4Pool[sceneIdx % mp4Pool.length];
            // EVERY CLIP IN A SCENE GETS A DISTINCT POOL ENTRY (while the pool lasts), offset per
            // scene so neighbours still share some paths. This matters more than it looks: warming
            // dedupes BY PATH, so a formula whose index range is smaller than the clip count makes
            // "warm every clip" and "warm the start clips" read the identical file set — the bench
            // then reports a 0% delta and the fixture, not the code, is what produced it. The first
            // version indexed by `sceneIdx + l + c`, spanning six values for twelve clips, and did
            // exactly that.
            else src = pool[(sceneIdx * CLIPS + l * perLayer + c) % pool.length];
            clips.push({
                id: id('clp'), layerId: layers[l].id, name: `${src.name}`,
                path: src.path,
                start: c * clipDur, duration: clipDur, inPoint: 0,
            });
        }
    }
    return {
        layers, clips, duration: perLayer * clipDur, fps: 30, markers: [],
        inPoint: null, outPoint: null, loop: true, trackingTakes: [],
        // The sting at start=0 — the exact shape plugin.renderer.ts:431-445 names as the victim of the
        // missing audio preload tier (phase 8's acceptance test replays this 20×).
        audio: {
            tracks: [{ id: id('atr'), name: 'Sting', gain: 1 }],
            clips: [{ id: id('acl'), trackId: 'SET_BELOW', name: `sting-${sceneIdx}`, path: 'assets/audio/sting.wav', start: 0, duration: 2, inPoint: 0, sourceDuration: 2, gain: 0.5, mute: false }],
        },
    };
}

// ── THE LED RIG ──────────────────────────────────────────────────────────────────────────────────
// Pixel fixtures sampling the VIDEO surfaces — without them the bench measures decode and compositing
// but never the thing the frames are FOR: per-surface GPU sampling, universe packing and Art-Net out.
// A cold open that looks fast while the rig sits dark is not a fast open.
//
// Patching is explicit and sequential rather than left to autoPatch: the fixture must be reproducible
// byte-for-byte across regenerations, and a bench whose addressing shifts when the app's patch policy
// changes would report that as a preload regression. 125 LEDs x 4 channels = 500 <= 512, so one
// fixture per universe, start address 1 — the arithmetic stays obvious when someone reads the file.
function makeControllers() {
    return [
        { id: 'ctl_a', name: 'LED node A', protocol: 0, ip: '127.0.0.1', broadcast: false, startUniverse: 0, drives: 'pixel' },
        { id: 'ctl_b', name: 'LED node B', protocol: 0, ip: '127.0.0.1', broadcast: false, startUniverse: 32, drives: 'pixel' },
    ];
}

function makeFixtures(surfaces) {
    // Spread over the VIDEO surfaces (the first four — see makeSurfaces): sampling an EFFECT surface
    // is real work too, but video is the path that has to survive a cold start.
    const videoSurfaces = surfaces.slice(0, Math.min(4, surfaces.length));
    const perController = Math.ceil(FIXTURES / 2);
    return Array.from({ length: FIXTURES }, (_, i) => {
        const surface = videoSurfaces[i % videoSurfaces.length];
        const onB = i >= perController;
        const strips = Math.max(1, Math.floor(FIXTURES / videoSurfaces.length));
        const slot = Math.floor(i / videoSurfaces.length) % strips;
        return {
            id: id('fix'), name: `Strip ${String(i + 1).padStart(2, '0')}`,
            // Laid out INSIDE the surface it samples, as horizontal strips — a fixture sampling
            // outside its surface would read black and the LED half of the bench would be a no-op.
            x: surface.x + 0.01,
            y: surface.y + (surface.height * (slot + 0.5)) / strips,
            width: surface.width - 0.02,
            height: 0.004,
            rotation: 0,
            universe: (onB ? 32 : 0) + (i % perController),
            startAddress: 1,
            ledCount: LEDS_PER_FIXTURE,
            reverse: i % 2 === 1,          // serpentine runs, as a real strip wall is wired
            colorData: [],                  // live data — never persisted (App strips it on save)
            surfaceId: surface.id,          // strict per-surface sampling
            controllerId: onB ? 'ctl_b' : 'ctl_a',
            channelsPerPixel: 4,
            colorOrder: 0,
        };
    });
}

// The FSM: state 0 is a HUB with up to 10 outgoing afterDelay transitions (protect-set bypass fodder),
// the rest chain onTimelineEnd, and one fromAny returns to the hub (the look-ahead blind spot).
function makeStateMachine(scenes) {
    const states = scenes.map((s, i) => ({
        id: `st_${i}`, name: `S${i}`, sceneId: s.id,
        x: 120 + (i % 10) * 140, y: 120 + Math.floor(i / 10) * 120,
        entry: [{ kind: 'play' }],
    }));
    const transitions = [];
    const spokes = Math.min(10, states.length - 1);
    for (let i = 1; i <= spokes; i++) {
        transitions.push({ id: `t_hub_${i}`, from: 'st_0', to: `st_${i}`, trigger: { kind: 'afterDelay', seconds: 4 + i }, fadeSec: 1 });
    }
    for (let i = 1; i < states.length - 1; i++) {
        transitions.push({ id: `t_chain_${i}`, from: `st_${i}`, to: `st_${i + 1}`, trigger: { kind: 'afterDelay', seconds: 6 }, fadeSec: 1 });
    }
    if (states.length > 1) {
        transitions.push({ id: 't_back_home', fromAny: true, from: '', to: 'st_0', trigger: { kind: 'afterDelay', seconds: 120 }, fadeSec: 2 });
    }
    return { enabled: true, initialStateId: 'st_0', regions: [], states, transitions };
}

function generate(outDir, sceneCount) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir, 'assets', 'audio'), { recursive: true });
    const pool = buildMediaPool(outDir);
    writeWav(path.join(outDir, 'assets', 'audio', 'bed.wav'), 30, 110);
    writeWav(path.join(outDir, 'assets', 'audio', 'sting.wav'), 2, 660);

    const surfaces = makeSurfaces(pool);
    const controllers = makeControllers();
    const fixtures = makeFixtures(surfaces);
    const scenes = Array.from({ length: sceneCount }, (_, i) => {
        const tl = makeTimeline(pool, i);
        tl.audio.clips[0].trackId = tl.audio.tracks[0].id;
        return {
            id: id('sc'), name: `Scene ${i + 1}`, fadeSec: 1, globalBrightness: 1, groups: [],
            // Full look snapshot per scene — the file-size shape the plan documents (Capture Scene
            // serializes surfaces per scene even though they alias in memory) — rig included, so a
            // recall restores the patch as a real captured scene does.
            surfaces, fixtures, timeline: tl,
        };
    });

    const assets = pool.map((p) => ({ id: id('ast'), name: p.name, type: 'video', path: p.path, addedAt: 0 }))
        .concat([
            { id: id('ast'), name: 'bed.wav', type: 'audio', path: 'assets/audio/bed.wav', addedAt: 0 },
            { id: id('ast'), name: 'sting.wav', type: 'audio', path: 'assets/audio/sting.wav', addedAt: 0 },
        ]);

    const bedTrack = { id: id('atr'), name: 'Bed', gain: 1, mute: false };
    const doc = {
        version: 1, timestamp: 0,
        generator: `gen-heavy-project scenes=${sceneCount} clips=${CLIPS} layers=${LAYERS} surfaces=${SURFACES} fixtures=${FIXTURES}x${LEDS_PER_FIXTURE}led ${SYNTHETIC ? 'SYNTHETIC (read-path only — decode NOT exercised)' : 'real media'}`,
        surfaces, fixtures, controllers, globalBrightness: 1, groups: [],
        scenes,
        timeline: { layers: [], clips: [], duration: 60, fps: 30, markers: [], inPoint: null, outPoint: null, loop: false, trackingTakes: [] },
        stateMachine: makeStateMachine(scenes),
        audio: {
            tracks: [bedTrack],
            clips: [{ id: id('acl'), trackId: bedTrack.id, name: 'bed', path: 'assets/audio/bed.wav', start: 0, duration: 30, inPoint: 0, sourceDuration: 30, gain: 1, mute: false }],
            buses: [],
        },
        assets, projectorOutputs: [], projectorFpsCap: 0, projectorBrightness: 1,
    };

    const file = path.join(outDir, 'project.artlux');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));

    const fileMB = fs.statSync(file).size / 1048576;
    let assetBytes = 0;
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : (assetBytes += fs.statSync(path.join(d, e.name)).size); };
    walk(path.join(outDir, 'assets'));
    const poolBytes = pool.reduce((n, p) => n + p.bytes, 0);
    const byCodec = pool.reduce((m, p) => { m[p.codec] = (m[p.codec] ?? 0) + 1; return m; }, {});
    // REPORT WHAT THE FIXTURE ACTUALLY PROMISES. A bench fixture that silently failed to include a HAP
    // clip, or whose rig sampled nothing, would produce numbers that look fine and mean something else.
    const scene0 = scenes[0].timeline.clips.map((c) => pool.find((p) => p.path === c.path)?.codec);
    console.log(`  ${path.relative(ROOT, file)}`);
    console.log(`    scenes=${sceneCount} clips/scene=${CLIPS} layers=${LAYERS} surfaces=${SURFACES} pool=${pool.length}${SYNTHETIC ? ' [SYNTHETIC]' : ''}`);
    console.log(`    pool codecs: ${Object.entries(byCodec).map(([k, v]) => `${k}x${v}`).join(' ')} · ${(poolBytes / 1048576).toFixed(0)} MB ${COPY_MEDIA || SYNTHETIC ? 'copied in' : 'referenced in place'}`);
    console.log(`    per scene: hap=${scene0.filter((c) => c === 'hap').length} mp4=${scene0.filter((c) => c === 'mp4').length} distinct paths=${new Set(scenes[0].timeline.clips.map((c) => c.path)).size}/${scenes[0].timeline.clips.length}`);
    console.log(`    rig: ${fixtures.length} fixtures x ${LEDS_PER_FIXTURE} LED = ${fixtures.length * LEDS_PER_FIXTURE} LEDs on ${controllers.length} controllers (universes ${fixtures[0]?.universe}..${fixtures[fixtures.length - 1]?.universe})`);
    if (!SYNTHETIC && !scene0.some((c) => c === 'hap' || c === 'mp4')) {
        console.log('    ⚠ NO REAL VIDEO IN SCENE 1 — the pool held none; decode is not being exercised.');
    }
    console.log(`    project file ${fileMB.toFixed(2)} MB · assets ${(assetBytes / 1048576).toFixed(1)} MB`);
    return file;
}

// ---------------------------------------------------------------------------
console.log(`\ngen-heavy-project → ${path.relative(ROOT, OUT)}${SYNTHETIC ? '   (synthetic media: measures the READ path + gate timeout, not decode)' : ''}\n`);
for (const n of SCENE_COUNTS) {
    generate(SCENE_COUNTS.length > 1 ? `${OUT}-${n}` : OUT, n);
}
console.log('\nnext:  npm run build   (bench must run the built app, not the dev server)');
console.log('       node scripts/bench-open.cjs --project <folder>/project.artlux\n');
