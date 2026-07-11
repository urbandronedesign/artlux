import { Timeline, VideoClip, SurfaceContent, LayerBlendMode, StateMachine, isContentClip, defaultTimeline } from '../types';
import { getBlobUrl, ensureBlobUrl } from './mediaCache';
import * as contentSource from './contentSource';
import { clipKindRegistry, videoCodecRegistry } from '../host/registries';
import { automationTargetRegistry } from '../host/registries';
import { sampleLane, type Cursor } from './automation';
import type { AutomationLane, Keyframe } from '../types';
import type { AutomationTargetProvider } from '@artlux/sdk/renderer';
import type { VideoCodecContribution } from '@artlux/sdk/renderer';
import * as fsm from './stateMachine';
import type { TransportIntent, SmContext } from './stateMachine';
import * as cueBus from './cueBus';

// Per-window video-layer timeline engine. The single source of playback time so React
// never re-renders per frame (mirrors dmxSignal/livePreview). One <video> per layer
// (track); as the playhead crosses clip boundaries the layer video's source is swapped.
// The main window advances the playhead itself; the Scene window runs in `external` mode
// and is driven by the bridged transport.
//
// Files the browser <video> can't decode (HAP; later DXV / native MP4) are handled by a plugin
// VideoCodec: for those we pull the exact frame for the playhead from the codec and it paints a
// per-layer canvas we draw like a <video>.

// A layer's playback state: a browser <video> for normal clips, plus a lazily-created canvas fed by
// a plugin VideoCodec for codec clips. `mode` says which is live this frame.
type CodecState = { path: string; canvas: CanvasImageSource | null; codecId: string };
type LayerVid = {
  el: HTMLVideoElement; clipId: string | null; srcPath: string | null;
  mode: 'video' | 'codec' | 'content' | null; codec: CodecState | null;
  // 'content' mode: a generalized source clip (image/effect/camera/spout/ndi/dmx/tracking) is live
  // on this layer; pixels come from contentSource keyed by `layer:<id>`.
  content?: SurfaceContent; contentClipId?: string | null; contentLocalTime?: number;
};

const layerKey = (layerId: string): string => `layer:${layerId}`;

// Per-scene decoupled timelines: each scene owns its own timeline, so each needs its own pool of
// per-layer <video> elements. `pools` is keyed by poolKey (scene.id, or '__global__' for the shared
// fallback timeline). Exactly ONE pool is ACTIVE (playing) at a time — `layerVideos` always points at
// pools.get(activeKey), so the frame loop / syncLayer / drawable readers are unchanged; a warm-swap
// just repoints `layerVideos` at an already-decoded standby pool. WARM standby pools hold paused
// <video>s (a decoder, ~0 CPU) pre-rolled to the timeline's first frame so promotion is hitless.
export const GLOBAL_POOL = '__global__';
type LayerPool = Map<string, LayerVid>;
const pools = new Map<string, LayerPool>([[GLOBAL_POOL, new Map()]]);
let activeKey = GLOBAL_POOL;
let layerVideos: LayerPool = pools.get(GLOBAL_POOL)!;
// External mirror windows (Scene / projector) don't decode: the main window decodes once
// and streams each layer's frame here as a transferable ImageBitmap (keeps concurrent
// hardware-decode sessions to one — see App.tsx scene/projector frame pumps).
const layerBitmaps = new Map<string, ImageBitmap>();

// --- Program: the whole timeline composited (all contributing layers, z-ordered). Built once per
// frame in the main window only when a consumer wants it (a surface routed to SourceType.PROGRAM).
// Mirror windows receive the composited frame over the bridge like any other surface drawable.
// Sentinel layerId: a 3D plane/mesh (SceneModel.layerId) set to this shows the whole timeline
// program instead of a single layer — see useLayerTexture.
export const PROGRAM_LAYER_ID = '__program__';
const PROGRAM_W = 1280, PROGRAM_H = 720;
let programCanvas: HTMLCanvasElement | null = null;
let programCtx: CanvasRenderingContext2D | null = null;
const programConsumers = new Set<string>(); // surfaces + 3D planes that want the program built
let programActive = false; // derived from programConsumers — build the composite each frame
let programReady = false;  // the canvas holds a freshly composited frame this run
const blendOp = (m?: LayerBlendMode): GlobalCompositeOperation =>
  m === 'add' ? 'lighter' : m === 'screen' ? 'screen' : m === 'multiply' ? 'multiply' : 'source-over';

const subs = new Set<(playhead: number) => void>();
// Transport intents emitted by the FSM control layer (main window only). App subscribes and
// turns them into React transport state, so App stays the single writer of `playing`.
const intentSubs = new Set<(i: TransportIntent) => void>();
const emitIntent = (i: TransportIntent): void => { intentSubs.forEach(cb => cb(i)); };

let data: Timeline = defaultTimeline();
let playing = false;
let external = false; // true in mirror windows (Scene/projector) — playhead set from the bridge
// In a mirror window, decode HAP layers locally instead of consuming streamed frames. HAP has
// no hardware-decode-session limit (it's CPU/SIMD + GPU block upload), so each visible window
// can decode it — and a VISIBLE window (the fullscreen projector) runs full-speed, whereas the
// hidden broadcast main window throttles its rAF and starves the streamed-frame pump.
let hapLocal = false;
let playhead = 0;
// Monotonic clock anchor: performance.now() (ms) corresponding to playhead==0. The playhead is
// derived as (now - originMs), so it never accumulates rAF-jitter drift and the source-frame
// cadence stays uniform against the display refresh. Mirror windows phase-lock this anchor to the
// bridged transport (see seek) with a gentle slew instead of a hard resync snap.
let originMs = 0;
let raf = 0;
let prevPlayhead = 0; // previous frame's playhead — for FSM crossing detection
const SLEW = 0.1; // fraction of residual drift a mirror window corrects per transport update

// The project-level state machine (set by App via setStateMachine). Lives here — not in `data` — so
// it runs independently of the timeline document and can drive scenes while the transport is stopped.
let projectSm: StateMachine | undefined;
let frameNowSec = 0; // wall clock (seconds) sampled each frame — the FSM's standalone clock

// Is a clip live under the playhead on this layer? (for the FSM 'onClipEnd' trigger)
const clipActive = (layerId: string, t: number): boolean => activeClip(layerId, t) != null;
// Per-frame context handed to the FSM runtime.
const smContext = (): SmContext => ({ markers: data.markers ?? [], clipActive, emit: emitIntent, recallScene: (id, fadeSec) => cueBus.requestRecall(id, fadeSec), fireCue: (id) => cueBus.requestFireCue(id), nowSec: frameNowSec });

const ensureBlob = (path: string): void => { void ensureBlobUrl(path, 'video/mp4'); };

function getLayerVideo(layerId: string, pool: LayerPool = layerVideos): LayerVid {
  let lv = pool.get(layerId);
  if (!lv) {
    const el = document.createElement('video');
    el.muted = true; el.playsInline = true; el.loop = false; el.crossOrigin = 'anonymous';
    lv = { el, clipId: null, srcPath: null, mode: null, codec: null };
    pool.set(layerId, lv);
  }
  return lv;
}

// Topmost clip on a layer covering time t (later clips win on overlap).
function activeClip(layerId: string, t: number): VideoClip | null {
  let found: VideoClip | null = null;
  for (const c of data.clips) {
    if (c.layerId === layerId && t >= c.start && t < c.start + c.duration) found = c;
  }
  return found;
}

// Stop holding any generalized-content source this layer had live (clip ended / changed away).
function releaseContent(lv: LayerVid, layerId: string): void {
  if (lv.mode === 'content' || lv.content) contentSource.release(layerKey(layerId));
  lv.content = undefined; lv.contentClipId = null;
}

function syncLayer(layerId: string, t: number): void {
  const lv = getLayerVideo(layerId);
  const clip = activeClip(layerId, t);
  if (!clip) {
    if (!lv.el.paused) lv.el.pause();
    releaseContent(lv, layerId);
    lv.clipId = null; lv.mode = null;
    return;
  }

  // Generalized content clip (image/effect/camera/spout/ndi/dmx/tracking).
  if (isContentClip(clip)) {
    // Mirror windows (Scene/projector) consume the streamed bitmap rather than opening their own
    // live receivers — keep this main-window-only, like the non-HAP <video> path below.
    if (external) { if (!lv.el.paused) lv.el.pause(); releaseContent(lv, layerId); lv.mode = null; lv.clipId = clip.id; return; }
    syncContentLayer(layerId, lv, clip, t);
    return;
  }
  // Switching from a content clip back to a video/HAP clip: drop the content source first.
  if (lv.mode === 'content' || lv.content) releaseContent(lv, layerId);

  // Codec clips (HAP, …) can't go through the <video>; pull the playhead's frame from the plugin codec.
  const codec = videoCodecRegistry.forPath(clip.path);
  if (codec) {
    const known = codec.probed(clip.path);
    if (known === undefined) { void codec.probe(clip.path); return; } // still probing
    if (known) { syncCodecLayer(layerId, lv, clip, t, codec); return; } // decode locally (any window)
    // known === false → the codec declined (e.g. a non-HAP .mov / H.264); fall through to <video>.
  }
  // Non-HAP clips are only decoded in the main window; mirror windows consume streamed frames.
  if (external) { lv.mode = null; return; }
  syncVideoLayer(lv, clip, t);
}

function syncVideoLayer(lv: LayerVid, clip: VideoClip, t: number): void {
  if (lv.srcPath !== clip.path) {
    const url = getBlobUrl(clip.path);
    if (url) { lv.el.src = url; lv.srcPath = clip.path; }
    else { ensureBlob(clip.path); return; } // not loaded yet
  }
  lv.clipId = clip.id;
  lv.mode = 'video';
  const target = t - clip.start + clip.inPoint;
  if (lv.el.readyState >= 1) {
    const drift = Math.abs(lv.el.currentTime - target);
    // Seek when scrubbing/paused, or when playback drifts too far (boundary/load).
    if (!playing || drift > 0.25) { try { lv.el.currentTime = Math.max(0, target); } catch { /* ignore */ } }
  }
  if (playing) { if (lv.el.paused) lv.el.play().catch(() => {}); }
  else if (!lv.el.paused) lv.el.pause();
}

function syncCodecLayer(layerId: string, lv: LayerVid, clip: VideoClip, t: number, codec: VideoCodecContribution): void {
  if (!lv.el.paused) lv.el.pause(); // not using the <video> for this clip
  if (!lv.codec || lv.codec.path !== clip.path) {
    lv.codec = { path: clip.path, canvas: null, codecId: codec.id };
  }
  lv.clipId = clip.id;
  lv.mode = 'codec';
  // The codec samples the exact frame for this clip-local playhead time and paints its per-layer
  // canvas (GPU decompress); it tracks the decoded index internally so it only re-uploads on advance.
  const clipTime = t - clip.start + clip.inPoint;
  lv.codec.canvas = codec.layerFrame(layerId, clip.path, clipTime);
}

// A generalized content clip: route its SurfaceContent onto the layer via the shared contentSource
// registry (same producers as surfaces). Acquire on first activation / content edit; the per-frame
// drawable is pulled in getLayerDrawable. Effects use clip-local time; live sources ignore it.
function syncContentLayer(layerId: string, lv: LayerVid, clip: VideoClip, t: number): void {
  if (!lv.el.paused) lv.el.pause(); // the <video> isn't used for this clip
  const content = clip.content!;
  const key = layerKey(layerId);
  // (Re)acquire when the active clip or its content changes; idempotent so a re-acquire is cheap.
  if (lv.contentClipId !== clip.id || lv.content !== content) {
    contentSource.acquire(key, content);
    lv.contentClipId = clip.id;
    lv.content = content;
  }
  lv.clipId = clip.id;
  lv.mode = 'content';
  lv.contentLocalTime = t - clip.start + clip.inPoint;
}

// --- Per-scene timeline swap helpers (main window only) ------------------------------------------

// Warm shared, path-keyed media for a timeline's clips (blob URLs + codec sessions). Idempotent and
// cheap — mediaCache and codec preWarm both dedupe by path. Shared by setData (cold) and warmPool.
function warmMedia(t: Timeline): void {
  for (const c of t.clips) {
    if ((c.kind && clipKindRegistry.has(c.kind)) || isContentClip(c)) continue; // non-video / lazy content
    const codec = videoCodecRegistry.forPath(c.path);
    if (codec) codec.preWarm(c.path);
    else ensureBlob(c.path);
  }
}

// The clip visible at a timeline's start (inPoint ?? 0) on a given layer — the frame a clean restart shows.
function startClip(t: Timeline, layerId: string): { clip: VideoClip; startT: number } | null {
  const startT = t.inPoint ?? 0;
  let found: VideoClip | null = null;
  for (const c of t.clips) if (c.layerId === layerId && startT >= c.start && startT < c.start + c.duration) found = c;
  return found ? { clip: found, startT } : null;
}

// Pre-roll a standby pool: for each layer, create a paused <video> seeked to the exact first frame the
// timeline shows at its start, so readyState climbs to >=2 BEFORE the swap (no black/partial first
// frame). Video/codec only — content/live clips are lazy and only ever acquired by the ACTIVE pool.
function warmPoolVideos(pool: LayerPool, t: Timeline): void {
  for (const l of t.layers) {
    if (clipKindRegistry.get(l.kind ?? '')?.skipVideoSync) continue;
    const sc = startClip(t, l.id);
    if (!sc || isContentClip(sc.clip)) continue;
    const codec = videoCodecRegistry.forPath(sc.clip.path);
    if (codec) { codec.preWarm(sc.clip.path); continue; } // codec frames are pulled on demand; preWarm suffices
    const url = getBlobUrl(sc.clip.path);
    if (!url) { ensureBlob(sc.clip.path); continue; } // not loaded yet — pre-roll on a later warm() pass
    const lv = getLayerVideo(l.id, pool);
    if (lv.srcPath !== sc.clip.path) { lv.el.src = url; lv.srcPath = sc.clip.path; }
    lv.el.pause();
    const target = sc.startT - sc.clip.start + sc.clip.inPoint;
    try { lv.el.currentTime = Math.max(0, target); } catch { /* seek once metadata lands */ }
  }
}

// Tear down per-layer <video>s in a pool that its timeline no longer references. Codec/content release
// is keyed by layerId GLOBALLY, so only release for a layerId the ACTIVE timeline doesn't also use.
function pruneStaleLayers(pool: LayerPool, t: Timeline): void {
  for (const id of [...pool.keys()]) {
    if (t.layers.find(l => l.id === id)) continue;
    const lv = pool.get(id)!;
    lv.el.pause(); lv.el.removeAttribute('src');
    pool.delete(id);
    if (!data.layers.find(l => l.id === id)) { // not held by the active timeline → safe to free shared state
      for (const c of videoCodecRegistry.all()) c.releaseLayer(id);
      contentSource.release(layerKey(id));
    }
  }
}

// Main-window seek (mirror-window phase-lock lives in the seek() method). Re-anchors the monotonic
// clock and suppresses FSM crossings across the jump — the clean first-frame start on every trigger.
function mainSeek(sec: number): void {
  const clamped = Math.max(0, sec);
  playhead = clamped;
  originMs = performance.now() - clamped * 1000;
  prevPlayhead = clamped;
}


// ── Automation ──────────────────────────────────────────────────────────────────────────────────
// Lanes ride the Timeline, so they arrive with `data` for free — the ACTIVE timeline's lanes, layered
// over the GLOBAL timeline's as a BASE (shadowed per targetPath, so a scene can override one curve
// without disturbing the rest of the show's automation).
//
// The lane set is COMPILED (resolve the provider, cache the range/epsilon, preallocate the cursor) on
// setData/swap/setBaseAutomation — never per frame. Per frame we only sample and, if the value actually
// moved, push it. Nothing here allocates: the audio provider's write() ends in an audio-lock acquisition,
// so a value that hasn't changed must never be pushed.
interface LaneRT {
  kfs: Keyframe[];
  path: string;
  provider: AutomationTargetProvider;
  log: boolean;
  eps: number;          // change-detect epsilon: half a UI step — below it, nothing can represent the difference
  cursor: Cursor;       // preallocated; carries last frame's segment index
  last: number;         // last value pushed; NaN ⇒ never ⇒ the first sample always lands
}
let lanesRT: LaneRT[] = [];
let ownedPaths = new Set<string>();
let baseAutomation: AutomationLane[] = [];   // the GLOBAL timeline's lanes (the base layer)
let frameEndProviders: AutomationTargetProvider[] = []; // cached at compile — registry.all() allocates

function compileAutomation(): void {
  if (external) return; // the projector's playhead is slew-corrected, so re-sampling there would differ
  // Active lanes shadow base lanes by targetPath. The global timeline IS the base, so it must not also
  // stack on itself when it happens to be the active one.
  const active = data.automation ?? [];
  const activePaths = new Set(active.map(l => l.targetPath));
  const base = activeKey === GLOBAL_POOL ? [] : baseAutomation.filter(l => !activePaths.has(l.targetPath));
  const lanes = [...base, ...active];

  const next: LaneRT[] = [];
  const nextPaths = new Set<string>();
  for (const lane of lanes) {
    if (lane.enabled === false || !lane.keyframes?.length) continue;
    const head = lane.targetPath.split('.')[0];
    const provider = automationTargetRegistry.get(head);
    if (!provider) continue; // unknown namespace (a plugin is disabled) — the lane persists, but is inert
    const def = provider.enumerate().find(d => d.path === lane.targetPath);
    if (!def) continue;      // dangling target (the clip was deleted) — kept in the file, not evaluated
    // Trust nothing: the cursor needs sorted keys, and the value must sit inside the target's range.
    // A hand-edited project could carry cutoff: 0 on a LOG target — Math.log(0) is -Infinity, which would
    // propagate a NaN into the lane's SVG path and into setClipEffects. Clamp it here, where the range is
    // known (normalizeAutomation can't clamp: it has no idea what the target is).
    const kfs = lane.keyframes
      .map(k => ({ ...k, v: Math.min(def.max, Math.max(def.min, k.v)) }))
      .sort((a, b) => a.t - b.t);
    next.push({
      kfs,
      path: lane.targetPath,
      provider,
      log: !!def.log,
      eps: (def.step ?? (def.max - def.min) / 1000) * 0.5,
      cursor: { i: -1 },
      last: NaN,
    });
    nextPaths.add(lane.targetPath);
  }
  // RELEASE-ON-DROP. A path we owned last compile but not now — the lane was deleted, disabled, or
  // dropped by a scene swap — must be handed back to manual control, or the target would be STRANDED at
  // the outgoing curve's last value forever (a bed clip stuck at whatever gain the curve happened to be
  // holding when the scene changed).
  for (const p of ownedPaths) {
    if (nextPaths.has(p)) continue;
    automationTargetRegistry.get(p.split('.')[0])?.release(p);
  }
  lanesRT = next;
  ownedPaths = nextPaths;
  frameEndProviders = automationTargetRegistry.all().filter(p => !!p.frameEnd);
}

function sampleAutomation(t: number): void {
  const n = lanesRT.length;
  if (n === 0) return; // the no-automation cost is one compare
  let wrote = false;
  for (let i = 0; i < n; i++) {
    const rt = lanesRT[i];
    const v = sampleLane(rt.kfs, t, rt.cursor, rt.log);
    if (Math.abs(v - rt.last) < rt.eps) continue; // unchanged — do NOT push (every audio push takes the audio lock)
    rt.last = v;
    rt.provider.write(rt.path, v);
    wrote = true;
  }
  if (wrote) for (let i = 0; i < frameEndProviders.length; i++) frameEndProviders[i].frameEnd!();
}

function frame(now: number): void {
  raf = requestAnimationFrame(frame); // reschedule first so a throw below can never kill the loop
  try {
    // The main window owns the clock; a hapLocal mirror (the fullscreen projector) runs the same
    // monotonic clock so it plays at full speed while the hidden main window's bridged transport is
    // throttled. Deriving the playhead from a fixed origin (not += dt) keeps cadence uniform against
    // the display refresh and never drifts; seek() phase-locks mirror windows to the authority.
    if (!external || hapLocal) {
      if (playing) {
        // Infinite timeline: advance unbounded (never modulo by duration). Wrap ONLY when looping
        // is on with a valid [inPoint, outPoint) region — re-anchoring originMs keeps cadence uniform.
        let t = (now - originMs) / 1000;
        const a = data.inPoint, b = data.outPoint;
        const loopOn = !!data.loop && a != null && b != null && b > a;
        if (loopOn && t >= (b as number)) { t = (a as number) + ((t - (a as number)) % ((b as number) - (a as number))); originMs = now - t * 1000; }
        else if (loopOn && t < (a as number)) { t = a as number; originMs = now - t * 1000; }
        playhead = Math.max(0, t);
      } else {
        originMs = now - playhead * 1000; // keep the anchor live while paused so resume is seamless
      }
    }
    // Automation: sample the lanes and push what moved. Deliberately NOT a subscribe() callback — `subs`
    // is insertion-ordered and the audio driver is one of them, so a late subscriber's values would land
    // AFTER reconcile() had already run this frame, costing a permanent frame of latency. It also sits
    // OUTSIDE the `playing` gate above, so scrubbing while paused still moves the curve (which is what
    // makes the bed sound right the instant you hit play).
    if (!external) {
      try { sampleAutomation(playhead); } catch (e) { console.error('[timeline] automation error', e); }
    }
    // FSM control layer (main window only — mirrors receive the resulting transport via the bridge).
    // Ticks every frame regardless of `playing` so the standalone wall clock advances while stopped.
    if (!external) {
      frameNowSec = now / 1000;
      try { fsm.tick(projectSm, playhead, prevPlayhead, smContext()); } catch (e) { console.error('[timeline] fsm error', e); }
    }
    // Main window decodes everything; mirror windows decode only HAP locally (when hapLocal),
    // otherwise they consume streamed frames and skip decoding entirely.
    if (!external || hapLocal) for (const l of data.layers) {
      if (clipKindRegistry.get(l.kind ?? '')?.skipVideoSync) continue; // non-video lanes (e.g. tracking takes) — see the plugin's clip-kind contribution
      try { syncLayer(l.id, playhead); } catch (e) { console.error('[timeline] syncLayer error', e); }
    }
    // Composite the whole-timeline program once per frame when a surface routes to it (main window
    // only; mirror windows receive the result as a streamed surface drawable).
    if (!external && programActive) { try { buildProgram(); } catch (e) { console.error('[timeline] program error', e); } }
    else programReady = false;
    prevPlayhead = playhead;
    subs.forEach(cb => cb(playhead));
  } catch (e) {
    console.error('[timeline] frame error', e);
  }
}

// The local (non-mirror) drawable for a layer: HAP canvas, generalized content, or the <video>.
function layerDrawable(layerId: string): CanvasImageSource | null {
  const lv = layerVideos.get(layerId);
  if (!lv || !lv.clipId) return null;
  if (lv.mode === 'content') return lv.content ? contentSource.getDrawable(layerKey(layerId), lv.content, lv.contentLocalTime ?? 0) : null;
  if (lv.mode === 'codec') return lv.codec ? lv.codec.canvas : null;
  return lv.mode === 'video' && lv.el.readyState >= 2 ? lv.el : null;
}

// Composite all contributing layers into the program canvas (bottom of the track list = back, top =
// front). enabled/muted/solo gate contribution; per-layer opacity + blendMode drive the mix.
function buildProgram(): void {
  if (!programCanvas) {
    programCanvas = document.createElement('canvas');
    programCanvas.width = PROGRAM_W; programCanvas.height = PROGRAM_H;
    programCtx = programCanvas.getContext('2d');
  }
  const ctx = programCtx;
  if (!ctx) return;
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, PROGRAM_W, PROGRAM_H);
  const anySolo = data.layers.some(l => l.solo && !clipKindRegistry.get(l.kind ?? '')?.excludeFromProgram);
  for (let i = data.layers.length - 1; i >= 0; i--) { // last in the list is the back-most layer
    const l = data.layers[i];
    if (clipKindRegistry.get(l.kind ?? '')?.excludeFromProgram || l.enabled === false || l.muted) continue;
    if (anySolo && !l.solo) continue;
    const d = layerDrawable(l.id);
    if (!d) continue;
    ctx.globalAlpha = Math.max(0, Math.min(1, l.opacity ?? 1));
    ctx.globalCompositeOperation = blendOp(l.blendMode);
    try { ctx.drawImage(d, 0, 0, PROGRAM_W, PROGRAM_H); } catch { /* drawable not ready this frame */ }
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  programReady = true;
}

export const timeline = {
  // Feed the ACTIVE timeline document (initial load, editing the active timeline, projector bridge).
  // Per-scene recall does NOT go through here — it uses swap() to promote a warm standby pool. Keeps
  // `data` and the active pool in sync: pre-warm the incoming media and prune the active pool's stale
  // layers. Tracking-take clips (.lblob) aren't video — trackingPlayback handles them.
  setData(t: Timeline): void {
    data = t;
    if (external) return; // mirror windows don't decode — no blobs / video elements to manage
    warmMedia(t);
    pruneStaleLayers(layerVideos, t);
    compileAutomation();
  },
  // Pre-warm a scene's timeline into a standby pool WITHOUT going live (WARM tier): shared media by
  // path + a paused, first-frame-seeked <video> per layer, so a later swap() is hitless. Idempotent.
  warmPool(poolKey: string, t: Timeline): void {
    if (external) return;
    let pool = pools.get(poolKey);
    if (!pool) { pool = new Map(); pools.set(poolKey, pool); }
    warmMedia(t);
    warmPoolVideos(pool, t);
  },
  // Promote a (warm, ideally) pool to ACTIVE — the seamless per-scene timeline swap. Only ONE pool is
  // ever live: the outgoing one is paused (kept warm for the preloader to evict), orphaned content
  // sources are released, and by default the incoming timeline restarts at its first frame.
  swap(poolKey: string, t: Timeline, opts?: { transport?: 'restart' | 'preserve'; holdMs?: number }): void {
    if (external) { data = t; return; } // mirror windows just track the doc; App bridges it separately
    const prevData = data;
    const prevKey = activeKey;
    data = t;
    let pool = pools.get(poolKey);
    if (!pool) { pool = new Map(); pools.set(poolKey, pool); warmMedia(t); warmPoolVideos(pool, t); } // cold fallback
    activeKey = poolKey;
    layerVideos = pool;
    // One transport at a time: pause the outgoing pool's videos (kept warm; preloader evicts later).
    if (prevKey !== poolKey) { const prev = pools.get(prevKey); if (prev) for (const lv of prev.values()) { if (!lv.el.paused) lv.el.pause(); } }
    // Only ACTIVE holds live receivers — release generalized-content the swap orphaned (layers the old
    // timeline had but the new one doesn't).
    for (const l of prevData.layers) { if (!t.layers.find(nl => nl.id === l.id)) contentSource.release(layerKey(l.id)); }
    pruneStaleLayers(pool, t);
    warmMedia(t);
    if ((opts?.transport ?? 'restart') === 'restart') mainSeek(t.inPoint ?? 0); // clean first-frame start
    compileAutomation(); // AFTER the seek, so the first post-recall sample is taken at the new playhead
  },
  // The GLOBAL timeline's lanes, which run as a BASE under every scene (the global audio bed is global,
  // so its curves must outlive a scene swap). Pushed by App whenever the global timeline changes.
  setBaseAutomation(lanes: AutomationLane[]): void {
    baseAutomation = lanes;
    compileAutomation();
  },
  // The set of AUTOMATABLE TARGETS changed, though the timeline didn't. Compiling resolves each lane
  // against its provider's enumerate(), so a lane can only be evaluated while its target exists — and the
  // audio bed is NOT the timeline. Delete the clip or the effect a lane drives, or add the one it wants,
  // and nothing above fires. Without this the stale lane would keep sampling a dead path forever, and a
  // lane waiting on a target that just appeared would never wake up. App calls it when the bed changes,
  // and once after the plugins have registered their providers.
  recompileAutomation(): void { compileAutomation(); },
  // Demote a standby pool to COLD: tear down its <video>s (decoders) and free codec/content it uniquely
  // holds. Never drops the global fallback or the currently-active pool. Driven by the preloader.
  releasePool(poolKey: string): void {
    if (poolKey === GLOBAL_POOL || poolKey === activeKey) return;
    const pool = pools.get(poolKey);
    if (!pool) return;
    for (const [id, lv] of pool) {
      lv.el.pause(); lv.el.removeAttribute('src');
      if (!data.layers.find(l => l.id === id)) { for (const c of videoCodecRegistry.all()) c.releaseLayer(id); contentSource.release(layerKey(id)); }
    }
    pools.delete(poolKey);
  },
  // Which pool keys currently hold decoders (active + warm standby) — for the preloader's LRU budget.
  warmPoolKeys(): string[] { return [...pools.keys()]; },
  activePoolKey(): string { return activeKey; },
  setPlaying(p: boolean): void {
    if (p === playing) return;
    playing = p;
    if (p) originMs = performance.now() - playhead * 1000; // re-anchor the monotonic clock on resume
  },
  setExternal(e: boolean): void { external = e; },
  setHapLocal(v: boolean): void { hapLocal = v; },
  seek(sec: number): void {
    const clamped = Math.max(0, sec); // unbounded — the timeline has no fixed end
    if (external && hapLocal) {
      // The projector free-runs its own monotonic clock; the bridged transport is the authority.
      // Phase-lock to it with a gentle slew (continuous, invisible) instead of a hard resync snap —
      // that snap was the periodic hitch. Big jumps (manual seek, loop wrap) still snap instantly.
      const err = clamped - playhead;
      if (Math.abs(err) > 0.5) { playhead = clamped; originMs = performance.now() - clamped * 1000; }
      else originMs -= err * 1000 * SLEW;
      return;
    }
    mainSeek(clamped); // don't fire FSM crossings across a deliberate jump
  },
  getPlayhead(): number { return playhead; },
  getDuration(): number { return data.duration; },
  isPlaying(): boolean { return playing; },
  // FSM control layer (main window). App subscribes to intents and turns them into transport state.
  subscribeIntent(cb: (i: TransportIntent) => void): () => void { intentSubs.add(cb); return () => { intentSubs.delete(cb); }; },
  // Inject a transport intent from outside the FSM (e.g. external OSC control). Flows through the
  // same subscribeIntent consumers, so App remains the single writer of `playing`.
  dispatchTransportIntent(i: TransportIntent): void { if (!external) emitIntent(i); },
  subscribeSmState(cb: (id: string | null) => void): () => void { return fsm.subscribeState(cb); },
  // Subscribe to "a transition just fired" events (for the editor's active-edge pulse).
  subscribeSmFired(cb: (transitionId: string) => void): () => void { return fsm.subscribeFired(cb); },
  // Seconds spent in the current state on the standalone wall clock (for the main-UI status chip).
  getSmElapsedSec(): number { return fsm.getStateElapsedSec(); },
  // Register the project-level state machine to drive each frame. App calls this whenever it changes.
  setStateMachine(sm: StateMachine | undefined): void { projectSm = sm; },
  // Fire a manual FSM transition out of the current state (wired to the state-lane buttons).
  triggerSmTransition(id: string): void { if (!external) fsm.triggerManual(projectSm, id, playhead, smContext()); },
  // Force-enter a state by id, independent of the timeline (UI double-click test + future external
  // triggers like OSC/MIDI). Queued and applied on the next tick once the machine is enabled.
  enterSmState(id: string): void { if (!external) fsm.requestEnter(id); },
  // Store the latest streamed frame for a layer (mirror windows only). Closes the prior
  // bitmap it replaces so transferred frames don't leak.
  setLayerBitmap(layerId: string, bmp: ImageBitmap): void {
    const prev = layerBitmaps.get(layerId);
    if (prev && prev !== bmp) prev.close();
    layerBitmaps.set(layerId, bmp);
  },
  // The live drawable for a layer: a streamed ImageBitmap in mirror windows, else the HAP
  // canvas (HAP clips) or the decoding <video>. Null when nothing is under the playhead / ready.
  getLayerDrawable(layerId?: string): CanvasImageSource | null {
    if (!layerId) return null;
    if (external) {
      // Locally-decoded HAP wins (the projector decodes its own); else the streamed frame.
      const lv = layerVideos.get(layerId);
      if (hapLocal && lv && lv.mode === 'codec' && lv.codec) return lv.codec.canvas;
      return layerBitmaps.get(layerId) ?? null;
    }
    return layerDrawable(layerId);
  },
  // Refcount consumers that want the whole-timeline program composite built each frame (a surface
  // routed to SourceType.PROGRAM, or a 3D plane bound to PROGRAM_LAYER_ID). Build only when wanted.
  retainProgram(key: string): void { programConsumers.add(key); programActive = true; },
  releaseProgram(key: string): void { programConsumers.delete(key); if (programConsumers.size === 0) { programActive = false; programReady = false; } },
  // The composited program drawable (main window only; mirror windows stream it as a surface frame).
  getProgramDrawable(): CanvasImageSource | null { return !external && programReady && programCanvas ? programCanvas : null; },
  programSize(): { w: number; h: number } { return { w: PROGRAM_W, h: PROGRAM_H }; },
  subscribe(cb: (playhead: number) => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; },
  start(): void { if (!raf) { originMs = performance.now() - playhead * 1000; raf = requestAnimationFrame(frame); } },
};

timeline.start();
