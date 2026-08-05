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
// MEDIA. --media <dir> copies real clips in (decode is exercised — the honest run). --synthetic writes
// filler byte files instead: they exercise ONLY the read path (probe fails, <video> errors), so a
// synthetic run measures I/O and the gate's timeout behaviour, NOT decode — the output says so.
// Audio is always real: tiny PCM WAVs are generated here (a sine sting + a bed), so the audio plugin's
// load/conform path runs in both modes.
//
// Usage:
//   node scripts/gen-heavy-project.cjs --out .traces/bench/heavy --scenes 60 \
//        --clips-per-scene 12 --layers 4 --surfaces 24 --media D:\clips
//   node scripts/gen-heavy-project.cjs --out .traces/bench/sweep --scenes 1,10,40,120 --synthetic
//
// Flags:
//   --out <dir>              output project folder (sweep mode appends -<n> per scene count)
//   --scenes <n | a,b,c>     scene count, or a comma sweep (one folder per count)
//   --clips-per-scene <n>    default 12
//   --layers <n>             default 4
//   --surfaces <n>           default 24
//   --media <dir>            copy real video files from here (else --synthetic is implied)
//   --synthetic              filler video files (read-path-only; labelled)
//   --synthetic-mb <n>       size of each filler file (default 8)
//   --pool <n>               distinct media files to cycle (default 8, capped by what --media holds)

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
const MEDIA_DIR = arg('media', null);
const SYNTHETIC = has('synthetic') || !MEDIA_DIR;
const SYNTH_MB = Number(arg('synthetic-mb', 8));
const POOL = Number(arg('pool', 8));

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv']);
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
function buildMediaPool(dir) {
    const vidDir = path.join(dir, 'assets', 'video');
    fs.mkdirSync(vidDir, { recursive: true });
    const rel = [];
    if (!SYNTHETIC) {
        const src = fs.readdirSync(MEDIA_DIR).filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()));
        if (!src.length) { console.error(`no video files in --media ${MEDIA_DIR}`); process.exit(1); }
        for (const f of src.slice(0, POOL)) {
            fs.copyFileSync(path.join(MEDIA_DIR, f), path.join(vidDir, f));
            rel.push(`assets/video/${f}`);
        }
    } else {
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
            rel.push(`assets/video/synthetic-${String(f).padStart(2, '0')}.mp4`);
        }
    }
    return rel;
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
            ? { type: 'VIDEO', url: pool[i % pool.length] }
            : { type: 'EFFECT', effectId: (i % 8) + 1, paletteId: (i % 5) + 1, speed: 0.3, intensity: 0.7, opacity: 1 };
        return { id: id('srf'), name: `Surface ${i + 1}`, x: col * w, y: row * h, width: w, height: h, rotation: 0, zIndex: i, content };
    });
}

function makeTimeline(pool, sceneIdx) {
    const layers = Array.from({ length: LAYERS }, (_, l) => ({ id: id('lyr'), name: `Layer ${l + 1}` }));
    const clips = [];
    const perLayer = Math.max(1, Math.round(CLIPS / LAYERS));
    const clipDur = 5;
    for (let l = 0; l < layers.length; l++) {
        for (let c = 0; c < perLayer; c++) {
            clips.push({
                id: id('clp'), layerId: layers[l].id, name: `clip ${l}.${c}`,
                // Cycle the pool with a per-scene offset so adjacent scenes share SOME paths (the
                // path-keyed dedupe claim) but not all (the per-scene cost claim).
                path: pool[(sceneIdx + l + c) % pool.length],
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
    const scenes = Array.from({ length: sceneCount }, (_, i) => {
        const tl = makeTimeline(pool, i);
        tl.audio.clips[0].trackId = tl.audio.tracks[0].id;
        return {
            id: id('sc'), name: `Scene ${i + 1}`, fadeSec: 1, globalBrightness: 1, groups: [],
            // Full look snapshot per scene — the file-size shape the plan documents (Capture Scene
            // serializes surfaces per scene even though they alias in memory).
            surfaces, fixtures: [], timeline: tl,
        };
    });

    const assets = pool.map((p) => ({ id: id('ast'), name: path.basename(p), type: 'video', path: p, addedAt: 0 }))
        .concat([
            { id: id('ast'), name: 'bed.wav', type: 'audio', path: 'assets/audio/bed.wav', addedAt: 0 },
            { id: id('ast'), name: 'sting.wav', type: 'audio', path: 'assets/audio/sting.wav', addedAt: 0 },
        ]);

    const bedTrack = { id: id('atr'), name: 'Bed', gain: 1, mute: false };
    const doc = {
        version: 1, timestamp: 0,
        generator: `gen-heavy-project scenes=${sceneCount} clips=${CLIPS} layers=${LAYERS} surfaces=${SURFACES} ${SYNTHETIC ? 'SYNTHETIC (read-path only — decode NOT exercised)' : 'real media'}`,
        surfaces, fixtures: [], controllers: [], globalBrightness: 1, groups: [],
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
    console.log(`  ${path.relative(ROOT, file)}`);
    console.log(`    scenes=${sceneCount} clips/scene=${CLIPS} layers=${LAYERS} surfaces=${SURFACES} pool=${pool.length}${SYNTHETIC ? ' [SYNTHETIC]' : ''}`);
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
