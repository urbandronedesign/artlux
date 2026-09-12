// THE RENDER ITSELF — step the clock, settle every source, draw, encode, stream to disk.
//
// The whole point is that this loop is NOT paced by anything. It takes as long per frame as the
// decoders and the GPU need, and the output is identical whether a frame took 4 ms or four seconds.
// Everything that makes that true was built before this file existed: engine/renderClock owns the
// time, both live rAF loops stand down while it does, and contentSource.prepareExact() refuses rather
// than hand back a neighbouring frame.
//
// WHAT THIS SLICE DOES NOT DO YET, so nobody reads more into a green run than is there:
//   · sound is rendered through the REAL graph (the JUCE offline pull), not a second mixer — see §4.3
//     of plans/offline-bake.md for why a JS approximation was refused;
//   · no auto-swap and no `ProjectData.bakes` entry — it writes a file and stops (Phase 2);
//   · a surface fed by TIMELINE TRACKS is refused, because the layer path does not await its
//     decoders yet; generative and single-file surfaces are exact today.

import { Output, Mp4OutputFormat, StreamTarget, CanvasSource, AudioSampleSource, AudioSample } from 'mediabunny';
import * as audioClient from '@artlux/plugin-audio/renderer';
import * as renderClock from '@/engine/renderClock';
import { timeline } from '@/services/timeline';
import * as surfaceMedia from '@/services/surfaceMedia';
import * as contentSource from '@/services/contentSource';
import { SourceType, type Surface } from '@/types';
import type { BakeProgress, BakeRequest, BakeResult } from './types';
import * as client from './bakeClient';
import * as bakeStore from '@/services/bakeStore';
import * as stateMachine from '@/services/stateMachine';
import { videoCodecRegistry } from '@/host/registries';
import { getBakeHost } from './bakeHost';

/** Content a render can produce exactly today. Everything else is refused BY NAME. */
function refusalFor(s: Surface): string | null {
  const t = s.content.type;
  if (t === SourceType.SLICE) {
    return 'a slice crops another surface — bake the source surface instead, so the split stays adjustable';
  }
  if (t === SourceType.NONE) return 'this surface has no content';
  return null;
}

/**
 * The tracks a surface is fed by: exactly what is ticked in the Tracks checklist. null means "every
 * contributing track", which is what a PROGRAM surface shows.
 *
 * Deliberately NOT a copy of the stacking rule — z-order, muted, solo and blend all stay inside
 * timeline.compositeLayers. This only answers WHICH ids, which is the surface's own field.
 */
function tracksOf(s: Surface): readonly string[] | null | undefined {
  if (s.content.type === SourceType.PROGRAM) return null;
  if (s.content.type !== SourceType.LAYER) return undefined; // not timeline-fed at all
  const ids = s.content.layerIds && s.content.layerIds.length
    ? s.content.layerIds
    : (s.content.layerId ? [s.content.layerId] : []);
  return ids;
}

/** Filesystem-safe, and never empty — an unnamed surface would otherwise collapse the whole segment. */
function slug(v: string | null | undefined, fallback: string): string {
  const out = (v ?? '').trim().replace(/[^\w .-]+/g, '-').replace(/\s+/g, ' ').replace(/-{2,}/g, '-').trim();
  return out || fallback;
}

/**
 * A DEFAULT FILENAME THAT SAYS WHERE THE FILE CAME FROM.
 *
 * A render is a derived artefact that outlives the thing it was derived from, and it lands in a folder
 * beside a dozen others. `Wall.mp4` tells an operator nothing six months later: not which show, not
 * which scene of it, not what range, not at what rate — and re-deriving any of that means opening the
 * project and guessing. The four facts that make it re-derivable are cheap to carry in the name, so
 * they are:
 *
 *   <project>__<scene>__<surface>__<start>-<end>s_<fps>fps[_playhead].mp4
 *   Aurora__Finale__Wall__0-30s_30fps.mp4
 *
 * The clock is named ONLY when it is the playhead, because that is the one an operator can be
 * surprised by (a timeline-fed surface is forced onto it — see the call site). `show` is the ordinary
 * case and naming it every time would just make every filename longer.
 *
 * Only a SUGGESTION: the save dialog is still the operator's, and this is what it opens with.
 */
/**
 * WHERE A RENDER GOES BY DEFAULT: the project's own media folder.
 *
 * A rendered surface is project media — it is referenced by the document, it is collected by *Collect
 * Assets*, and `mapAssetPaths` relativizes it on save so the folder stays portable. Landing it anywhere
 * else makes a show that works on this machine and arrives at the venue with a missing file. `.mp4` is
 * already a known asset category, so `assets/video` is where the rest of the project's video lives.
 *
 * Null when the project has never been saved — there is no folder to be relative to yet, and the SDK's
 * own rule is that a caller with no path degrades rather than guessing one.
 */
function projectMediaDir(): string | null {
  const projectPath = getBakeHost()?.project.path() ?? null;
  if (!projectPath) return null;
  const dir = projectPath.replace(/[\\/][^\\/]*$/, '');
  return dir ? `${dir}/assets/video` : null;
}

function suggestedName(surface: Surface, req: BakeRequest, clock: 'show' | 'playhead'): string {
  const host = getBakeHost();
  const projectPath = host?.project.path() ?? null;
  const project = slug(projectPath ? (projectPath.split(/[\\/]/).pop() ?? '').replace(/\.artlux$/i, '') : null, 'untitled');

  // The scene the render actually reads — a recall swaps the bound timeline AND the surfaces, so which
  // one was live is part of what this file IS.
  const activeId = host?.show.getStatus().activeSceneId ?? null;
  const scenes = (host?.show.getScenes() ?? []) as Array<{ id: string; name?: string }>;
  const scene = slug(activeId ? (scenes.find((sc) => sc.id === activeId)?.name ?? activeId) : null, 'global');

  const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  const range = `${num(req.startSec)}-${num(req.endSec)}s_${num(req.fps)}fps`;
  const tail = clock === 'playhead' ? '_playhead' : '';
  return `${project}__${scene}__${slug(surface.name, 'surface')}__${range}${tail}.mp4`;
}

/**
 * GIVE THE BROWSER A TURN.
 *
 * ⚠ `await` IS NOT A YIELD. Awaiting an already-resolved promise continues in a MICROTASK, and
 * microtasks drain to exhaustion before the event loop gets anywhere near a paint. This render loop is
 * full of awaits and every one of them can resolve immediately — a generative surface settles with no
 * I/O at all, and the encoder resolves instantly whenever it is keeping up — so the whole render ran
 * inside a single macrotask: no paint, no React flush, and an application that is simply frozen until
 * it finishes. The progress bar was not slow to update; it never rendered once.
 *
 * `setTimeout(0)` is a real macrotask, so the browser can paint between frames. Gated on ELAPSED TIME
 * rather than done every frame: a timer costs a millisecond or more in Chromium, and paying that on
 * every frame of a ten-minute render is minutes of pure waiting. ~16 ms gives the UI a chance to draw
 * about as often as a display refresh, which is as smooth as a progress bar can usefully be, and costs
 * nothing on a render that is already slower than that per frame.
 */
/**
 * NOTHING IN A RENDER MAY WAIT FOREVER.
 *
 * Every await in this loop can, in the wrong conditions, never settle: a <video> that will not seek
 * resolves no `seeked` event, a codec asked for a frame it cannot reach spins its own budget, an IPC
 * round trip to a main process blocked on disk never comes back. Each of those is indistinguishable
 * from the others while it is happening, and all three look identical to an operator: the application
 * stops. A render that cannot proceed has to SAY which step it died on, because that is the only thing
 * that makes the next attempt smarter than the last one.
 *
 * The loser is the race, not the operation: a timed-out decode may still be running. That is fine —
 * the render is abandoned anyway, and the decoder is handed back in the `finally`.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not finish within ${(ms / 1000).toFixed(0)}s`)), ms);
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e as Error); },
    );
  });
}

/** How long ONE step of ONE frame may take before the render gives up and names it. */
const STEP_TIMEOUT_MS = 20_000;
/** How long the audio graph may take to detach the device and prepare itself. */
const AUDIO_BEGIN_TIMEOUT_MS = 30_000;

// Phase tracing. Loud for the first few frames — where a render dies is almost always on frame 0 or 1,
// and by frame 200 the console is noise — then once in a while, so a long render still leaves a trail.
let phase = 'idle';
// Where the time actually goes. A render that is slower than expected is not a mystery worth guessing
// at — audio, settling sources and encoding fail slowly in completely different ways, and the only
// useful first question is which of the three it is.
const cost: Record<string, number> = {};
let phaseStarted = 0;
function trace(i: number, p: string): void {
  const now = performance.now();
  if (phaseStarted) cost[phase] = (cost[phase] ?? 0) + (now - phaseStarted);
  phase = p;
  phaseStarted = now;
  if (i < 3 || i % 250 === 0) console.info(`[bake] frame ${i}: ${p}`);
}
function costSummary(): string {
  return Object.entries(cost).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(', ');
}

function yieldToUi(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}
const YIELD_EVERY_MS = 16;

/** What the material in a range actually is, so an export can be rated and sized from it. */
export interface SourceSurvey {
  /** One entry per distinct file the ticked tracks show in the range. */
  files: Array<{ name: string; fps: number; width: number; height: number }>;
  /** Native rates present, ascending. Empty for purely generative content. */
  rates: number[];
  /** The rate that loses nothing — see suggestRate. */
  suggestedFps: number;
  /** Largest native frame, or null when nothing declares one. */
  size: { width: number; height: number } | null;
  /** True when the rates are not multiples of one another, so no single rate is lossless. */
  incompatible: boolean;
}

/**
 * THE RATE A RENDER SHOULD RUN AT.
 *
 * ⚠ NOT the document's `Timeline.fps`. That is a TIMECODE rate — it is what the ruler counts in, and
 * the only things that read it are the seek drift tolerance, the end-stop park and an epsilon. It does
 * not quantise the playhead (which is continuous) and it does not gate picture production (the
 * timeline's loop is uncapped and syncs layers at display rate). A 25 fps document showing a 50p clip
 * really does put 50 distinct pictures a second on a projector.
 *
 * ⚠ AND NOT "the lowest rate present", which is the intuitive answer and is only right by coincidence.
 * It is right when every source agrees — then lowest and highest are the same number, and rendering at
 * it is both lossless and the cheapest thing to decode later. With MIXED rates the lowest permanently
 * destroys motion: render 25p+50p at 25 and half of the 50p clip's frames are gone from the file for
 * good. The highest is lossless whenever the others divide into it — a 25p frame simply appears twice
 * at 50, and a duplicate frame costs almost nothing in H.264 — so the highest is the rate that loses
 * nothing, and it is what this returns.
 *
 * The one case with no right answer is rates that are not multiples (25 and 30): every choice makes
 * one of them judder. The survey flags it rather than pretending, because that is a decision about
 * which material matters, and only the person who assembled it can make it.
 *
 * Purely generative content (a shader, type) has NO native rate — it is a continuous function of time
 * and any rate renders it truthfully — so there the document's rate is the honest default, being the
 * number the operator already thinks in.
 */
function suggestRate(rates: number[], docFps: number): number {
  if (!rates.length) return Math.max(1, Math.round(docFps));
  return Math.max(...rates);
}

/** Are these rates multiples of one another (so the highest is lossless for all)? */
function ratesCompatible(rates: number[]): boolean {
  if (rates.length < 2) return true;
  const top = Math.max(...rates);
  return rates.every((r) => Math.abs(top / r - Math.round(top / r)) < 0.02);
}

/**
 * What is in this range, natively. Sizing and rating an export from the material is the only honest
 * way to do it: the alternative — whatever clip happens to sit under the playhead when the panel opens
 * — silently renders a 4K show at 720p because that is what the first clip was.
 */
export function surveySources(surface: Surface, startSec: number, endSec: number): SourceSurvey {
  const tracks = tracksOf(surface);
  const docFps = timeline.getFps();
  if (tracks === undefined) {
    // Not timeline-fed: a single source, or generative. A VIDEO surface can still declare a rate.
    const url = surface.content.url;
    const codec = url ? videoCodecRegistry.forPath(url) : undefined;
    const info = codec?.sourceInfo ? codec.sourceInfo(url as string) : null;
    const rates = info ? [info.fps] : [];
    return {
      files: info ? [{ name: baseName(url as string), fps: info.fps, width: info.width, height: info.height }] : [],
      rates,
      suggestedFps: suggestRate(rates, docFps),
      size: info ? { width: info.width, height: info.height } : null,
      incompatible: false,
    };
  }

  const files: SourceSurvey['files'] = [];
  for (const src of timeline.contributingSources(tracks, startSec, endSec)) {
    const codec = videoCodecRegistry.forPath(src.path);
    const info = codec?.sourceInfo ? codec.sourceInfo(src.path) : null;
    if (!info || !(info.fps > 0)) continue;   // not open yet, or a format that cannot say
    files.push({ name: baseName(src.path), fps: info.fps, width: info.width, height: info.height });
  }
  const rates = [...new Set(files.map((f) => Math.round(f.fps * 100) / 100))].sort((a, b) => a - b);
  const size = files.length
    ? { width: Math.max(...files.map((f) => f.width)), height: Math.max(...files.map((f) => f.height)) }
    : null;
  return { files, rates, suggestedFps: suggestRate(rates, docFps), size, incompatible: !ratesCompatible(rates) };
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/**
 * Does this surface draw anything NOT fully opaque right now?
 *
 * Sampled off a small copy of the live drawable — a render only needs to know whether a matte is worth
 * the second decoder, not where the transparency is, so 64x64 is plenty and costs nothing. Answers
 * false when it cannot tell (nothing drawn yet, a tainted source), because the cheaper file is the
 * safer default: a missing matte on opaque content changes nothing, while a matte nobody needed costs
 * a decoder for the life of the show.
 */
export function hasTransparency(surface: Surface): boolean {
  const d = surfaceMedia.getDrawable(surface);
  if (!d) return false;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d', { alpha: true, willReadFrequently: true });
  if (!g) return false;
  g.clearRect(0, 0, 64, 64);
  try { g.drawImage(d, 0, 0, 64, 64); } catch { return false; }
  try {
    const px = g.getImageData(0, 0, 64, 64).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 250) return true;
  } catch { return false; }   // tainted: cannot tell, so do not claim it is transparent
  return false;
}

let running = false;
let cancelled = false;

/** Ask the render in flight to stop at the next frame boundary. */
export function cancel(): void { cancelled = true; }
export function isRunning(): boolean { return running; }

export async function run(
  req: BakeRequest,
  surfaces: readonly Surface[],
  onProgress?: (p: BakeProgress) => void,
): Promise<BakeResult> {
  if (running) return { kind: 'refused', reason: 'a render is already in flight' };

  const surface = surfaces.find((s) => s.id === req.surfaceId);
  if (!surface) return { kind: 'refused', reason: 'that surface no longer exists' };

  const refusal = refusalFor(surface);
  if (refusal) return { kind: 'refused', reason: refusal };

  // A soloed track elsewhere makes a ticked track composite BLACK — correctly, matching the program.
  // Refusing here is the difference between an operator who knows why and one who thinks the renderer
  // is broken.
  if (timeline.hasSolo()) {
    return { kind: 'refused', reason: 'a timeline track is soloed — clear it, or the render records black' };
  }

  const tracks = tracksOf(surface);
  if (tracks !== undefined && tracks !== null && tracks.length === 0) {
    return { kind: 'refused', reason: 'this surface names no timeline tracks — tick at least one' };
  }

  const frames = Math.max(1, Math.round((req.endSec - req.startSec) * req.fps));
  if (!Number.isFinite(frames) || frames <= 0) return { kind: 'refused', reason: 'that range is empty' };

  // A timeline-fed surface is addressed by the bound document's PLAYHEAD; a generative one rides the
  // SHOW clock. Getting this wrong does not fail loudly, it drifts — so correct it rather than trust
  // the picker, and say nothing, because there is no decision here to make.
  const clock: 'show' | 'playhead' = tracks !== undefined ? 'playhead' : req.clock;

  const name = suggestedName(surface, req, clock);
  const mediaDir = projectMediaDir();
  // Beside the project by default — both as the dialog's starting point and, when the operator has
  // asked to keep renders with the show, as the answer itself.
  const suggested = mediaDir ? `${mediaDir}/${name}` : name;

  let outPath = req.outPath ?? null;
  if (!outPath && req.intoProject) {
    if (!mediaDir) return { kind: 'refused', reason: 'save the project first — there is no folder to put the render in yet' };
    outPath = suggested;
  }
  if (!outPath) {
    // The dialog is a MODAL on the main window: while it is up the app looks frozen, so say what is
    // happening before it opens.
    console.info(`[bake] asking where to write (${suggested}) — the window is modal until you answer`);
    outPath = await client.pickOutput(suggested);
  }
  if (!outPath) return { kind: 'refused', reason: 'cancelled' };

  const id = `bake-${Date.now().toString(36)}`;
  if (!(await client.open(id, outPath))) return { kind: 'refused', reason: 'could not open that file for writing' };

  // EVEN DIMENSIONS, ALWAYS. H.264 is 4:2:0 — the chroma planes are half resolution in each axis, so
  // an odd width or height has no valid encoding and the encoder simply refuses the configuration.
  // Rounding down by a pixel is invisible; the failure is not, and it arrives as a dead render rather
  // than as a message about width.
  const even = (v: number) => Math.max(2, Math.round(v) - (Math.round(v) % 2));
  const W = even(req.width), H = even(req.height);

  // THREE CANVASES WHEN TRANSPARENCY IS KEPT, and each does one job.
  //   frame  — RGBA, what the surface actually drew, alpha intact
  //   canvas — the COLOUR video: `frame` over black, i.e. premultiplied, which is what matteGL expects
  //   matte  — the ALPHA video: the same alpha carried as brightness
  // Extracting alpha as luma needs no shader: fill white, keep it only where `frame` has alpha
  // (`destination-in`), then lay that premultiplied white over black — which leaves rgb == alpha
  // exactly. Measured through H.264 at 2/255 worst case across hard edges, ramps and 2px strokes.
  const frame = document.createElement('canvas');
  frame.width = W; frame.height = H;
  const fctx = frame.getContext('2d', { alpha: true });
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const matte = document.createElement('canvas');
  matte.width = W; matte.height = H;
  const mctx = req.alpha ? matte.getContext('2d', { alpha: false }) : null;
  if (!ctx || !fctx || (req.alpha && !mctx)) {
    client.cancelWrite(id);
    return { kind: 'refused', reason: 'no 2D context for the export canvas' };
  }

  // Positional writes: an MP4's moov is patched after the media, so the offsets are not monotonic.
  const target = new StreamTarget(
    new WritableStream({
      write(chunk) { client.chunk(id, chunk.data, chunk.position); },
    }),
  );
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new CanvasSource(canvas, {
    codec: 'avc',                 // HEVC encode is unsupported on this Chromium; H.264 is the format
    bitrate: req.bitrate,
    keyFrameInterval: 1,          // ~1 s: a sparse GOP makes looping and scrubbing the result expensive
  });
  output.addVideoTrack(source, { frameRate: req.fps });

  // The matte is its own file with its own muxer and its own descriptor in main. Side by side in ONE
  // frame would have halved the bookkeeping and doubled the frame height — 3840x4320 for a 4K surface,
  // past what the encoder will accept — so two files it is.
  let matteId: string | null = null;
  let matteOut: Output | null = null;
  let matteSource: CanvasSource | null = null;
  let mattePath: string | null = null;
  if (req.alpha) {
    mattePath = outPath.replace(/\.mp4$/i, '') + '.matte.mp4';
    matteId = `${id}-matte`;
    if (!(await client.open(matteId, mattePath))) {
      try { await output.cancel(); } catch { /* never started */ }
      client.cancelWrite(id);
      return { kind: 'refused', reason: 'could not open the matte file for writing' };
    }
    const mTarget = new StreamTarget(new WritableStream({
      write(chunk) { client.chunk(matteId as string, chunk.data, chunk.position); },
    }));
    matteOut = new Output({ format: new Mp4OutputFormat(), target: mTarget });
    matteSource = new CanvasSource(matte, {
      codec: 'avc',
      // A matte is high-contrast and mostly flat, so it compresses far below the colour it accompanies;
      // a quarter of the budget is generous and keeps the pair from doubling the disk.
      bitrate: Math.max(1_000_000, Math.round(req.bitrate / 4)),
      keyFrameInterval: 1,
    });
    matteOut.addVideoTrack(matteSource, { frameRate: req.fps });
  }

  let audioNote: string | null = null;

  // ---- SOUND ------------------------------------------------------------------------------------
  // AAC is STEREO-ONLY on this Chromium (measured — see the plan's Phase 0), so a multichannel or
  // ambisonic show cannot put its whole bus in an MP4. Binaural output is already two channels and is
  // the right stereo rendering of a spatial show, so that is what a render asks the graph for.
  //
  // Sound is OPTIONAL and never fatal: a build with no audio addon, or a Linux box with no AAC
  // encoder, produces a silent file and says so, rather than failing a render that is otherwise good.
  const AUDIO_SR = 48000, AUDIO_CH = 2;
  let audioSource: AudioSampleSource | null = null;
  let audioReady = false;
  if (req.audio) {
    // ⚠ THIS ONE CAN GENUINELY BLOCK THE MAIN PROCESS. offlineBegin detaches the audio device and
    // re-prepares the whole graph, and AudioTransportSource::prepareToPlay() blocks on DISK for every
    // loaded clip. On a show with a lot of audio that is real time, and an unbounded wait here reads
    // exactly like the application hanging — which is what it is.
    console.info('[bake] preparing the audio graph (the device is released while rendering)');
    const began = await withTimeout(
      audioClient.offlineBegin({ sampleRate: AUDIO_SR, blockSize: 512, channels: AUDIO_CH }),
      AUDIO_BEGIN_TIMEOUT_MS, 'preparing the audio graph',
    ).catch((e: Error) => ({ ok: false as const, error: e.message }));
    if (began.ok) {
      const supported = typeof AudioEncoder !== 'undefined' && (await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2', sampleRate: AUDIO_SR, numberOfChannels: AUDIO_CH, bitrate: 192_000,
      }).then((r) => !!r.supported).catch(() => false));
      if (supported) {
        audioSource = new AudioSampleSource({ codec: 'aac', bitrate: 192_000 });
        output.addAudioTrack(audioSource);
        audioReady = true;
      } else {
        await audioClient.offlineEnd();
        audioNote = 'no AAC encoder on this machine — rendered without sound';
      }
    } else {
      audioNote = began.error ?? 'the audio engine could not render offline — rendered without sound';
    }
  }

  // The sample cursor. Absolute, never accumulated: fps rarely divides the sample rate (48000/25 is
  // exact, 48000/29.97 is not), and a per-frame delta would drift a render out of sync with itself
  // over ten minutes. Each frame pulls exactly the samples between its own boundaries.
  const samplesAt = (frameIndex: number): number => Math.round((frameIndex * AUDIO_SR) / req.fps);
  let audioCursor = 0;

  running = true;
  cancelled = false;
  for (const k of Object.keys(cost)) delete cost[k];
  phaseStarted = 0;
  const startedAt = performance.now();
  let lastReport = 0;
  let lastYield = performance.now();
  let done = 0;

  // Abandoning a render frees BOTH ends. Closing the file descriptor without cancelling the muxer
  // leaves its encoder and its queued writes alive, and a half-written MP4 on disk is worse than none
  // -- it plays for most of its length and then stops, which reads as a finished file.
  const abandon = async (): Promise<void> => {
    try { await output.cancel(); } catch { /* never started, or already gone */ }
    client.cancelWrite(id);
    if (matteOut) { try { await matteOut.cancel(); } catch { /* as above */ } }
    if (matteId) client.cancelWrite(matteId);
  };

  try {
    console.info(`[bake] starting: ${frames} frames, ${W}x${H} @${req.fps}fps${req.alpha ? ' + matte' : ''} -> ${outPath}`);
    await withTimeout(output.start(), STEP_TIMEOUT_MS, 'opening the encoder');
    if (matteOut) await withTimeout(matteOut.start(), STEP_TIMEOUT_MS, 'opening the matte encoder');

    // Pause everything that decodes on its own clock. A <video> whose currentTime keeps moving makes
    // an awaited seek describe a position we no longer care about.
    contentSource.setPlaying(false);
    // Let the caller's "busy" state paint BEFORE the loop takes the thread, or the first thing an
    // operator sees is the old idle panel, frozen.
    await yieldToUi();
    const clockBaseMs = performance.now();
    renderClock.beginOffline(clockBaseMs);

    // ── THE SHOW MUST NOT MOVE UNDER THE RENDER ──────────────────────────────────────────────────
    // fsm.tick() lives in the timeline's frame body, and stepFrame() runs that body -- so the state
    // machine advances on the STEPPED playhead, at render speed, exactly as it would in a show. If a
    // transition fires mid-render it recalls a scene, and a recall restores `surfaces` wholesale: the
    // surface being baked changes content halfway through its own file. The result is two scenes
    // spliced together, at full fidelity, with nothing wrong in any single frame -- the kind of thing
    // that is only ever noticed on a wall.
    //
    // Predicting it is not possible (a transition can be waiting on a tracker, an OSC message or the
    // clock), so this DETECTS it and refuses to hand over the file instead. Same doctrine as
    // frameExact: a renderer that cannot tell a near-miss from a hit must not deliver the near-miss.
    const stateAtStart = stateMachine.getCurrentStateId();

    for (let i = 0; i < frames; i++) {
      if (cancelled) {
        await abandon();
        return { kind: 'refused', reason: 'cancelled' };
      }
      const stateNow = stateMachine.getCurrentStateId();
      if (stateNow !== stateAtStart) {
        await abandon();
        return {
          kind: 'refused',
          reason: `the show moved on during the render — the state machine left ${stateAtStart ?? 'no state'} for ` +
            `${stateNow ?? 'no state'} at frame ${i} of ${frames}. A state change recalls a scene, which replaces ` +
            `the surface being rendered, so the rest of the file would have been a different scene. ` +
            `Stop the show (or bake a range the state machine does not step through) and run it again.`,
        };
      }

      // ABSOLUTE, never accumulated -- both of these. `renderClock.now() + delta` would have been a
      // running sum, and the rounding error of a per-frame delta over ten minutes at 59.94 is exactly
      // what fixed-rate stepping exists to avoid. Every frame's time is a function of its index.
      const t = req.startSec + i / req.fps;
      renderClock.stepTo(clockBaseMs + (i * 1000) / req.fps);

      // Move the transport to t on the clock this content actually rides, then step one frame so
      // automation, the state machine and every layer see it.
      if (clock === 'show') timeline.showSeek(t); else timeline.seek(t);
      timeline.stepFrame();

      // ── SOUND FIRST, THEN THE PICTURE ────────────────────────────────────────────────────────
      // Not an ordering preference. Audio-reactive shaders read the LIVE device spectrum tap, and with
      // the device detached for the render that tap reads silence — so every audio-reactive surface
      // would render flat unless the block for this frame has already been pushed through the
      // analyser by the time the frame is drawn.
      if (audioReady && audioSource) {
        const want = samplesAt(i + 1) - audioCursor;
        if (want > 0) {
          trace(i, 'audio');
          const pcm = await withTimeout(audioClient.offlinePull(want), STEP_TIMEOUT_MS, 'rendering audio');
          if (pcm.length > 0) {
            const frames = pcm.length / AUDIO_CH;
            audioSource.add(new AudioSample({
              data: pcm,
              format: 'f32',
              numberOfChannels: AUDIO_CH,
              sampleRate: AUDIO_SR,
              timestamp: audioCursor / AUDIO_SR,
            }));
            audioCursor += frames;
          }
        }
      }

      // Timeline-fed surfaces settle through the transport (every ticked track waits for its own
      // decoder); everything else settles its own source. Two paths because they are two different
      // things, not because the rule differs: both mean "do not composite until the pictures are the
      // ones that belong at t".
      if (tracks !== undefined) {
        trace(i, 'settling timeline tracks');
        const why = await withTimeout(timeline.settleLayersExact(tracks), STEP_TIMEOUT_MS, 'settling timeline tracks');
        if (why) { await abandon(); return { kind: 'refused', reason: why }; }
      } else {
        trace(i, 'settling the source');
        const ready = await withTimeout(
          contentSource.prepareExact(surface.id, surface.content, t), STEP_TIMEOUT_MS, 'settling the source');
        if (!ready) {
          await abandon();
          return { kind: 'refused', reason: `no exact frame at ${t.toFixed(3)}s — this content cannot be rendered off the clock` };
        }
      }

      trace(i, 'drawing');
      const drawable = surfaceMedia.getDrawable(surface);
      // What the surface actually drew, alpha and all.
      fctx.clearRect(0, 0, W, H);
      if (drawable) fctx.drawImage(drawable, 0, 0, W, H);
      // The colour video: that, over black.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(frame, 0, 0);
      if (mctx) {
        // The alpha video: white kept only where `frame` has alpha, laid over black — rgb == alpha.
        mctx.globalCompositeOperation = 'source-over';
        mctx.fillStyle = '#000';
        mctx.fillRect(0, 0, W, H);
        mctx.save();
        mctx.globalCompositeOperation = 'source-over';
        mctx.fillStyle = '#fff';
        mctx.fillRect(0, 0, W, H);
        mctx.globalCompositeOperation = 'destination-in';
        mctx.drawImage(frame, 0, 0);
        mctx.restore();
      }

      trace(i, 'encoding');
      await withTimeout(source.add(i / req.fps, 1 / req.fps), STEP_TIMEOUT_MS, 'encoding a frame');
      if (matteSource) await withTimeout(matteSource.add(i / req.fps, 1 / req.fps), STEP_TIMEOUT_MS, 'encoding a matte frame');

      done = i + 1;
      // Report on TIME as well as on frame count. Every fifth frame alone looks smooth on a fast
      // render and frozen on a slow one — and a slow one is exactly when somebody is watching the bar
      // to decide whether to wait. ~5 Hz is plenty for a progress readout and far below the rate at
      // which re-rendering this panel would cost anything.
      const nowMs = performance.now();
      if (onProgress && (done === frames || nowMs - lastReport > 200)) {
        lastReport = nowMs;
        const elapsed = (nowMs - startedAt) / 1000;
        onProgress({ frame: done, frames, rate: elapsed > 0 ? done / elapsed : 0 });
      }
      // The actual hand-back. Without it none of the above reaches a screen, and Electron's
      // `unresponsive` detector eventually treats the window as hung.
      if (nowMs - lastYield > YIELD_EVERY_MS) {
        lastYield = nowMs;
        await yieldToUi();
      }
    }

    trace(done, 'finalising');
    console.info(`[bake] cost: ${costSummary()}`);
    await withTimeout(output.finalize(), STEP_TIMEOUT_MS, 'finalising the file');
    if (matteOut) await withTimeout(matteOut.finalize(), STEP_TIMEOUT_MS, 'finalising the matte');
    const written = await client.close(id);
    if (!written) return { kind: 'refused', reason: 'the file could not be closed' };
    const matteWritten = matteId ? await client.close(matteId) : null;
    if (matteId && !matteWritten) return { kind: 'refused', reason: 'the matte could not be closed' };

    // RECORD THE BINDING, not a content swap. The signature is taken from the surface's AUTHORED
    // content — which the render never touched — so it keeps matching across scene recalls and stops
    // matching the moment someone edits the shader, which is exactly when the render goes stale.
    // signatureOf() is the host's, so the writer and the playback reader cannot disagree.
    getBakeHost()?.bakes.add({
      id,
      surfaceId: surface.id,
      contentSig: bakeStore.signatureOf(surface.content, timeline.activePoolKey()),
      clock,
      startSec: req.startSec,
      endSec: req.startSec + done / req.fps,   // what was ACTUALLY rendered, not what was asked for
      fps: req.fps,
      width: W,
      height: H,
      path: written,
      ...(matteWritten ? { mattePath: matteWritten } : {}),
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    return { kind: 'ok', path: written, mattePath: matteWritten, frames: done, elapsedMs: Math.round(performance.now() - startedAt), audioNote };
  } catch (e) {
    await abandon();
    const msg = `${(e as Error).message} (frame ${done}, while ${phase})`;
    console.error('[bake] failed:', msg);
    return { kind: 'refused', reason: msg };
  } finally {
    // Order matters: hand the decoders back BEFORE the clock, so releases happen while the render
    // still owns the world it built.
    // Give the device back BEFORE the clock: the audio graph was detached for the render, and leaving
    // it detached would be a silent show.
    if (audioReady) { try { await audioClient.offlineEnd(); } catch { /* the plugin may be gone */ } }
    contentSource.releaseExact([surface.id]);
    renderClock.endOffline();
    running = false;
  }
}
