import { Timeline, VideoClip, SurfaceContent, LayerBlendMode, StateMachine, isContentClip, defaultTimeline, timelineEnd, timelineStart, timelineDuration } from '../types';
import { getBlobUrl, ensureBlobUrl } from './mediaCache';
import * as contentSource from './contentSource';
import { clipKindRegistry, videoCodecRegistry, smTriggerRegistry } from '../host/registries';
import { automationTargetRegistry } from '../host/registries';
import { sampleLane, type Cursor } from './automation';
import { videoAudioOf } from './videoAudio';
import type { AutomationLane, Keyframe, TimelineAudio } from '../types';
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
  // THE LAST GOOD FRAME. A seeking <video> reports readyState < 2 and is not drawable — and the
  // compositor clears then repaints from live drawables, so an undrawable element means BLACK, not a
  // frozen picture. Nothing else in the main-window path retains a frame. We snapshot the element the
  // moment before a seek destroys it, and draw this while the decoder catches up: a scrub then lags by
  // a frame or two instead of strobing black. Only written when a seek is actually issued — idle pause
  // and steady playback pay nothing for it.
  hold?: HTMLCanvasElement | null;
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
// The layers THIS window actually draws (mirror windows only; null = every layer). See the frame
// loop's layer sync — a projector renders one surface, so decoding the whole document there is work
// nobody ever looks at, multiplied by the number of outputs.
let localLayers: Set<string> | null = null;
let playhead = 0;
// Monotonic clock anchor: performance.now() (ms) corresponding to playhead==0. The playhead is
// derived as (now - originMs), so it never accumulates rAF-jitter drift and the source-frame
// cadence stays uniform against the display refresh. Mirror windows phase-lock this anchor to the
// bridged transport (see seek) with a gentle slew instead of a hard resync snap.
let originMs = 0;
// ── THE SHOW CLOCK ───────────────────────────────────────────────────────────────────────────────
// ONE TRANSPORT, TWO PLAYHEADS. `playhead` is the SCENE clock (the BOUND document's time). `showTime`
// is the SHOW clock — the time the global audio bed and the GLOBAL timeline's automation (the base
// layer) ride. Both are DERIVED from performance.now() against their own anchor, both are gated on the
// SAME `playing` flag, and there is still exactly one rAF, one `playing`, one <video> pool. What is new
// is a second derived TIME VALUE, not a second transport.
//
// WHY IT NEEDS ITS OWN ANCHOR: originMs is re-anchored by SEVEN sites (mainSeek, the underrun branch,
// the loop wrap, the end-stop park, the paused hold, setPlaying(true), the mirror snap/slew). A single
// anchor cannot carry two times that are REQUIRED to diverge — and divergence is the whole point: a
// scene recall mainSeeks the playhead to the scene's in-point, and the bed must not hear it.
//
// WHILE GLOBAL IS BOUND (the pill) THE TWO ARE THE SAME NUMBER. That identity is maintained by seek(), which
// tests clocksCoincident(). There used to be a second predicate here — isGlobalDocBound() — because a scene
// with no timeline of its own bound the GLOBAL doc under a scene's pool key, so "which document is bound"
// and "are the clocks equal" could disagree. That state was deleted on 2026-07-14 (Scene.timeline is now
// required), and the two questions collapsed into one. See clocksCoincident().
//
// THE SHOW CLOCK IS SILENT. It NEVER emits a TransportIntent and NEVER pulses hitEnd: the bed wrapping
// is not a show event, and firing 'onTimelineEnd' off it would advance the state machine behind the
// operator's back. It only WRAPS (global loop on) or PARKS (global loop off) — and the park is PUBLISHED
// on isShowAtEndBound(), because a consumer riding a frozen clock has to know it is frozen.
let showTime = 0;
let showOriginMs = 0;
// The GLOBAL timeline document, pushed by App. `data` is ALWAYS the BOUND doc, so this is the engine's
// only handle on the global one — and the show clock is bounded by ITS [start, end): the global
// timeline's Length is the SHOW's length, and the bed lives inside it.
let globalDoc: Timeline = defaultTimeline();
let raf = 0;
let prevPlayhead = 0; // previous frame's playhead — for FSM crossing detection
// End-of-timeline latch. The engine cannot write `playing` (App owns it), so it emits a 'pause'
// intent — which takes a React round-trip to come back. Without this latch we would emit one intent
// per frame for the whole trip. Cleared by any seek and by pressing play again.
let endLatched = false;
let hitEnd = false; // true for exactly the frame the playhead reached the end — feeds the FSM trigger
// ── THE HOLD (Timeline.holdAtEnd) ────────────────────────────────────────────────────────────────
// TRUE FOR EVERY FRAME THE SCENE CLOCK IS PARKED ON ITS LAST FRAME WITH THE TRANSPORT STILL RUNNING.
// The state's picture is over; the SHOW is not. `playing` is untouched, so the show clock, the audio
// bed and the global automation run straight through it — which is the entire difference between a
// hold and the plain end-stop (that one emits `pause`, and `playing:false` freezes both clocks).
//
// ⚠ DERIVED PER FRAME, NEVER LATCHED, and that is a correctness argument rather than a style one. A
// latch would have to be cleared by mainSeek, swap's two arms, setPlaying, the loop wrap, the
// document-edit clamp and setGlobalDoc — seven sites, the same seven that re-anchor originMs (see the
// show-clock note above). One missed site leaves the machine believing a running show is still held:
// `requireEnd` transitions fire early and the audio driver keeps a container silenced. Recomputing it
// where the park actually happens makes every one of those sites correct by construction, for free.
//
// Read by: the FSM (SmContext.held → SmTransition.requireEnd), the audio driver (via
// host.show.getStatus().held — a frozen clock must not be reconciled against; see isBoundHeld) and
// the HOLDING chips in the UI.
let held = false;
const SLEW = 0.1; // fraction of residual drift a mirror window corrects per transport update

// The project-level state machine (set by App via setStateMachine). Lives here — not in `data` — so
// it runs independently of the timeline document and can drive scenes while the transport is stopped.
let projectSm: StateMachine | undefined;
let frameNowSec = 0; // wall clock (seconds) sampled each frame — the FSM's standalone clock

// ── THE COLD-START ARM ───────────────────────────────────────────────────────────────────────────
// The FSM is HELD while a freshly-opened project's first look is still loading (services/bootGate).
// warmPool() is fire-and-forget — it kicks blob reads, codec probes and first-frame seeks and returns
// immediately — so on the frame after applyProjectData the machine would otherwise initialize, enter
// `initialStateId`, run its `play` entry action and start the show against decoders that hold NOTHING:
// a <video> below readyState 2 is undrawable and buildProgram clears to black, so the opening seconds
// go out black on the projectors AND on the LED output. Worse, 'afterDelay' rides a WALL clock that
// starts the moment the state is entered — an opening state with a 5s dwell can expire before its
// content ever appeared on stage.
//
// It gates ONLY fsm.tick(). Not the clock (nothing plays yet — `playing` is false until something
// asks), not syncLayer (the pre-roll needs the compositor to keep drawing what it has), and not the
// end-stop's deferred pause (see the tick site). Defaults to TRUE so every window/path that never
// opens a project — mirrors, a bare session, the projector — behaves exactly as before.
let armed = true;
const armedSubs = new Set<(a: boolean) => void>();

// Is a clip live under the playhead on this layer? (for the FSM 'onClipEnd' trigger)
const clipActive = (layerId: string, t: number): boolean => activeClip(layerId, t) != null;
// Per-frame context handed to the FSM runtime. `atEnd` is the one-frame end-of-timeline pulse (hitEnd,
// reset at the top of every frame) — the FSM's 'onTimelineEnd' trigger, and hitEnd's only reader.
// PLUGIN-OWNED TRIGGERS, resolved here so stateMachine.ts keeps importing nothing but types. An
// UNREGISTERED source is INERT (false), never truthy: a project may name a trigger whose plugin is
// disabled or newer than this build, and an unknown condition must not advance a show. A source that
// THROWS is inert too — a plugin's evaluation bug must not take the state machine down with it, and
// the FSM tick's own try/catch is too coarse (it would skip every other transition that frame).
const pluginTrigger = (source: string, params: Record<string, unknown>, stateEnteredAtSec: number): boolean => {
  const t = smTriggerRegistry.get(source);
  if (!t) return false;
  try { return !!t.fires(params, { nowSec: frameNowSec, stateEnteredAtSec, held }); }
  catch (e) { console.error(`[timeline] trigger source "${source}" threw`, e); return false; }
};
const smContext = (): SmContext => ({ markers: data.markers ?? [], clipActive, emit: emitIntent, recallScene: (id, fadeSec) => cueBus.requestRecall(id, fadeSec), fireCue: (id) => cueBus.requestFireCue(id), nowSec: frameNowSec, atEnd: hitEnd, held, pluginTrigger });

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

// Snapshot the element's current frame so we can keep showing it while a seek is in flight. Called
// ONLY on the frames where we are about to issue a seek — i.e. never during idle pause, and only on a
// real drift correction during playback. A no-op if there is nothing good to keep.
function captureHold(lv: LayerVid): void {
  const el = lv.el;
  if (el.readyState < 2 || !el.videoWidth || !el.videoHeight) return;
  if (!lv.hold) lv.hold = document.createElement('canvas');
  if (lv.hold.width !== el.videoWidth || lv.hold.height !== el.videoHeight) {
    lv.hold.width = el.videoWidth; lv.hold.height = el.videoHeight;
  }
  const ctx = lv.hold.getContext('2d');
  if (!ctx) return;
  try { ctx.drawImage(el, 0, 0); } catch { /* not drawable this frame — keep whatever we had */ }
}

function syncVideoLayer(lv: LayerVid, clip: VideoClip, t: number): void {
  if (lv.srcPath !== clip.path) {
    const url = getBlobUrl(clip.path);
    if (url) { lv.el.src = url; lv.srcPath = clip.path; lv.hold = null; } // a new FILE: the held frame is a lie
    else { ensureBlob(clip.path); return; } // not loaded yet
  }
  lv.clipId = clip.id;
  lv.mode = 'video';
  const target = t - clip.start + clip.inPoint;
  if (lv.el.readyState >= 1) {
    const drift = Math.abs(lv.el.currentTime - target);
    // Seek when the element is NOT WHERE WE WANT IT — and only then. This used to read
    // `if (!playing || drift > 0.25)`, which short-circuits: while paused, `drift` was never
    // consulted, so EVERY rAF frame assigned `currentTime` — to the value the element already held.
    // In Chromium an assignment starts a seek; the next one lands 16 ms later, before the previous can
    // finish. The element never completed a seek, `seeking` never cleared, `readyState` never climbed
    // back to 2 — so layerDrawable() (below) returned null, buildProgram() cleared and skipped the
    // layer, and THE OUTPUT WENT BLACK ON PAUSE, on the main window and on every projector. It
    // re-seeked 60×/s to where it already was and starved itself of the frame it had already decoded.
    // (Measured: playhead 1.962, currentTime 1.962, seeking=true, readyState=1. See
    // scratch/videoseek-sim.mjs, which reproduces the black and proves this predicate holds the frame.)
    // Paused, the threshold is HALF A FRAME: below that the element is already showing the frame we
    // want, and touching currentTime can only destroy it. A real scrub still moves the target by more
    // than that, so scrubbing still seeks, frame-exactly, exactly as before.
    if (drift > (playing ? 0.25 : frameSec(data) * 0.5)) {
      captureHold(lv);   // keep the frame we are about to destroy — a seek makes the element undrawable
      try { lv.el.currentTime = Math.max(0, target); } catch { /* ignore */ }
    }
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

// The clip visible at a timeline's start on a given layer — the frame a clean restart shows. Uses the
// GUARDED start (timelineStart), not the raw in-point: a junk `inPoint` would make startT NaN, match no
// clip, and silently skip the pre-roll — the standby pool would then promote on a black first frame.
function startClip(t: Timeline, layerId: string): { clip: VideoClip; startT: number } | null {
  const startT = timelineStart(t);
  let found: VideoClip | null = null;
  for (const c of t.clips) if (c.layerId === layerId && startT >= c.start && startT < c.start + c.duration) found = c;
  return found ? { clip: found, startT } : null;
}

// Pre-roll a standby pool: for each layer, create a paused <video> seeked to the exact first frame the
// timeline shows at its start, so readyState climbs to >=2 BEFORE the swap (no black/partial first
// frame). Video/codec only — content/live clips are lazy and only ever acquired by the ACTIVE pool.
//
// ⚠ IT MUST BE SAFE TO CALL REPEATEDLY ON A POOL THAT IS ALREADY WARM, and it is called that way:
// setData, warmPool, swap's cold fallback and — every poll — the boot gate's poolReady() below. The
// seek is therefore conditional. Assigning `currentTime` unconditionally RESTARTS the seek even when
// the element is already parked on that exact frame: readyState drops back under 2, the element is
// undrawable again, and a gate that polls at 10 Hz would hold a pool one seek short of ready forever
// while the compositor showed black.
function warmPoolVideos(pool: LayerPool, t: Timeline): void {
  for (const l of t.layers) {
    if (clipKindRegistry.get(l.kind ?? '')?.skipVideoSync) continue;
    const sc = startClip(t, l.id);
    if (!sc || isContentClip(sc.clip)) continue;
    const codec = videoCodecRegistry.forPath(sc.clip.path);
    if (codec) { codec.preWarm(sc.clip.path); continue; } // codec frames are pulled on demand; preWarm suffices
    const url = getBlobUrl(sc.clip.path);
    // Not read yet. ensureBlobUrl dedupes by path, so asking again is free — and asking again is the
    // POINT: on a cold project open the blob lands AFTER this pass, and the pre-roll used to wait for
    // "a later warm() pass" that, for the scene the show opens on, never came. The pool then promoted
    // on an empty element and the show started on black. poolReady() re-drives this every poll.
    if (!url) { ensureBlob(sc.clip.path); continue; }
    const lv = getLayerVideo(l.id, pool);
    if (lv.srcPath !== sc.clip.path) { lv.el.src = url; lv.srcPath = sc.clip.path; }
    lv.el.pause();
    const target = Math.max(0, sc.startT - sc.clip.start + sc.clip.inPoint);
    // Half a source frame of slop: exact equality never holds (a decoder lands on the nearest frame
    // boundary, not on the number we asked for), and re-asking is what the note above forbids.
    if (!lv.el.seeking && Math.abs(lv.el.currentTime - target) > frameSec(t) / 2) {
      try { lv.el.currentTime = target; } catch { /* seek once metadata lands */ }
    }
  }
}

// How much decoded material a codec layer must hold before the show is allowed to start. Matched to
// the HAP ring's own 300 ms look-ahead: less and the buffer is still filling when playback begins,
// more and the venue waits for material the ring would evict anyway. The gate's timeout is the
// backstop — a source that cannot reach this never holds the show past the operator's patience.
const PREROLL_SEC = 0.3;

// ── COLD-START READINESS OF A POOL ───────────────────────────────────────────────────────────────
// "Would promoting this pool put a PICTURE on stage, or black?" — asked by services/bootGate while the
// FSM is held. Re-drives the pre-roll first (idempotent, see above), so a blob that landed since the
// last poll is turned into a seeked <video> here rather than waiting for a warm() nobody will call.
//
// Only the frame the timeline OPENS on is judged: that is the one the audience sees on GO. Layers with
// nothing under the start, content/live clips (lazy by design, and a live receiver may never arrive)
// and non-video lanes are all `ready` by omission — a boot gate that waited on an NDI feed would hold
// a venue dark until the sending machine woke up.
function poolReadiness(poolKey: string, t: Timeline): { ready: boolean; pending: string[] } {
  if (external) return { ready: true, pending: [] };
  let pool = pools.get(poolKey);
  if (!pool) { pool = new Map(); pools.set(poolKey, pool); }
  warmPoolVideos(pool, t);
  const pending: string[] = [];
  for (const l of t.layers) {
    if (clipKindRegistry.get(l.kind ?? '')?.skipVideoSync) continue;
    const sc = startClip(t, l.id);
    if (!sc || isContentClip(sc.clip)) continue;
    const name = sc.clip.path.split(/[\\/]/).pop() || sc.clip.path;
    const codec = videoCodecRegistry.forPath(sc.clip.path);
    if (codec) {
      // A codec pulls frames on demand, so there is no element to watch — the honest "it is open and it
      // is really this codec" signal is the probe having ANSWERED (true or false: false means the host
      // falls back to a <video>, which is a decision, not a wait).
      const probed = codec.probed(sc.clip.path);
      if (probed === undefined) { pending.push(`${name} (${codec.id})`); continue; }
      // …AND THEN WAIT FOR A BUFFER, NOT A FRAME. A codec that decodes ahead starts EMPTY, so a show
      // armed on "the first frame exists" opens by missing the next hundred: the compositor paints the
      // nearest decoded neighbour and the first seconds visibly stutter (measured: 167 misses in the
      // first ten seconds of a 1080p60 HAP show, then ~none). preRoll both TOPS UP and reports, and the
      // gate's polling is what fills it. Clip-local time, because that is the source offset the layer
      // opens on. Codecs without preRoll behave exactly as before.
      if (probed && codec.preRoll) {
        const at = Math.max(0, sc.startT - sc.clip.start + sc.clip.inPoint);
        if (!codec.preRoll(sc.clip.path, at, PREROLL_SEC)) pending.push(`${name} (buffering)`);
      }
      continue;
    }
    const lv = pool.get(l.id);
    if (!lv || lv.srcPath !== sc.clip.path || lv.el.readyState < 2) pending.push(name);
  }
  return { ready: pending.length === 0, pending };
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

// One frame in the document's own timebase — the distance from `end` back to the LAST FRAME, where a
// non-looping show parks. A corrupt/absent fps must never poison the clock (a NaN here would make the
// parked playhead NaN), so anything non-finite or sub-1 falls back to defaultTimeline()'s 30.
function frameSec(t: Timeline): number {
  const fps = t.fps;
  return 1 / (typeof fps === 'number' && Number.isFinite(fps) && fps >= 1 ? fps : 30);
}

// Main-window seek (mirror-window phase-lock lives in the seek() method). Re-anchors the monotonic
// clock and suppresses FSM crossings across the jump — the clean first-frame start on every trigger.
function mainSeek(sec: number): void {
  const clamped = Math.max(0, sec);
  playhead = clamped;
  originMs = performance.now() - clamped * 1000;
  prevPlayhead = clamped;
  endLatched = false; // a deliberate jump re-arms the end
}

// The show clock's mainSeek — the ONLY thing that moves showTime from outside the frame loop.
// DELIBERATELY SEPARATE from mainSeek: mainSeek is reached from five semantically different events
// (Stop, a user seek, a scene recall, play-from-the-parked-end, project open) and the show-clock policy
// DISCRIMINATES among them — a recall must not reset it, a Stop must. So the policy lives at the CALL
// SITES, never in here. See the reset table in docs/TIMELINE.md.
//
// There is no prevShowTime to re-baseline (invariant 4's second half): nothing crossing-detects on this
// clock. fsm.tick() runs on `playhead` alone, by design.
function showSeekInternal(sec: number): void {
  const clamped = Math.max(0, sec);
  showTime = clamped;
  showOriginMs = performance.now() - clamped * 1000;
}

// Is the SHOW clock parked at the global end (global loop off)? The twin of atEndBound(), asked of the
// GLOBAL document instead of the bound one. Without it, a show that ran out its global Length while a
// scene looped underneath would have a permanently parked bed: setPlaying()'s restart test only ever
// looks at the BOUND doc, which is still merrily looping.
function showAtEndBound(): boolean {
  return !globalDoc.loop && showTime >= timelineEnd(globalDoc) - frameSec(globalDoc) - 1e-6;
}

// IS THE GLOBAL PILL BOUND? One question, one test — but it took deleting a state to get here.
//
// There used to be TWO functions, and the file carried forty lines arguing that they were different
// questions that must never be confused:
//
//   isGlobalDocBound()  = `activeKey === GLOBAL_POOL || data === globalDoc`   — WHICH DOCUMENT is bound.
//                         Decided which CLOCK an automation lane rides.
//   clocksCoincident()  = `activeKey === GLOBAL_POOL`                         — are the two clocks EQUAL.
//                         Decided whether a seek may drag the show clock with it.
//
// They differed in exactly ONE state: a scene with NO TIMELINE OF ITS OWN, which bound the GLOBAL doc under
// the scene's pool key — so `data === globalDoc` was true while `activeKey` was the scene's id. That state
// was deleted on 2026-07-14 (Scene.timeline is now required, types.ts). A scene's document is always
// `normalizeTimeline(scene.timeline)`, a freshly minted object, so `data === globalDoc` can now ONLY be true
// on the Global pill — which makes the two tests provably identical, and the distinction they were drawing
// vanishes with the state that made it necessary.
//
// The argument the deleted comments were making is still worth keeping, because it is why the SEEK gate must
// be this and not something looser: on the Global pill, and only there, no restart-swap has pulled the clocks
// apart ('reconverge' snaps the playhead onto the show clock on the way in), so both run off the same wall
// clock against the same document bounds and stay equal. Anywhere else they are diverged ON PURPOSE — that
// divergence IS the show clock — and a seek that dragged showTime to a scene-relative number would hurl a
// 20-minute ambient bed back to its top on every entry to that state, forever, in an empty room.
//
// Same rule as the mixer's own seek lock (AudioBedPanel: `sceneBound = activeSceneId != null`) and the same
// rule App uses to decide whether the bed's lanes may be drawn against the ruler at all. One place.
function clocksCoincident(): boolean {
  return activeKey === GLOBAL_POOL;
}

// Is the transport PARKED AT THE END (loop off)? A position test, not the `endLatched` flag — see the
// long argument in setPlaying(), which owns the reasoning. Hoisted out of setPlaying so App's 'play'
// intent handler can ask the same question: an FSM `play` entry action reached ON the end frame lands
// on a `playing` value React already holds, so setIsVideoPlaying(true) is a no-op, setPlaying() is
// never called, and the latch would never clear — the show freezes on one frame while still reporting
// itself as playing. App re-seeks imperatively instead (see isAtEndBound below).
function atEndBound(): boolean {
  return !data.loop && playhead >= timelineEnd(data) - frameSec(data) - 1e-6;
}

// REPOINTING `data` UNDER A LIVE PLAYHEAD MUST NEVER SYNTHESISE A TRANSPORT EVENT.
//
// The clock re-reads timelineEnd(data) every frame, so the instant `data` becomes a document whose end
// is at or behind the current playhead, the very next frame takes the end-stop branch. That branch is
// written for PLAYBACK reaching the end: it re-anchors originMs to the new (nearer) end, which drags
// the playhead backwards live on the projectors, emits `pause`, and PULSES hitEnd — firing the FSM's
// 'onTimelineEnd' edge and putting the wrong scene on stage, from something that was never playback.
//
// setData() IS THE SOLE CALLER — a document EDIT (Length lowered, `O` at the playhead, the out-handle
// dragged left, fps changed). Nothing else routes through here, and nothing else should.
//
// ⚠ swap() DOES NOT CALL THIS, AND MUST NOT BE ASSUMED TO. It used to, on the old
// `transport:'preserve'` path — which is exactly how a click on the scene pill → Global emitted a
// `pause` and killed the audio bed. That mode is GONE. The UI-CLICK case (pill → Global, deleting the
// bound scene) is now swap()'s `'reconverge'` arm, which snaps the playhead onto the SHOW CLOCK — a
// number that is by construction inside the global doc's [start, end), so there is normally nothing to
// clamp at all. The one case that is NOT free — a PARKED show clock, sitting exactly one frame inside
// the end — carries its OWN copy of the latch-without-pulse treatment below, inside that arm. If you
// are reading this because you changed swap(), go read swap(): the guard is there, not here.
//
// So handle the EDIT case HERE, where we know it was an edit and not playback:
//   • mainSeek to the new last frame — re-anchors originMs AND re-baselines prevPlayhead, so the move
//     is not read as a window the playhead traversed (no phantom atTime/onMarker/onClipEnd crossings).
//   • latch the end WITHOUT pulsing hitEnd: the machine must never be advanced by an edit or a click.
//     The latch also keeps the end-stop below from re-emitting while App's `playing` round-trips.
//   • ask App to pause (the engine still never writes `playing` itself).
// Ordering matters: mainSeek() CLEARS the latch, so it is re-set after.
//
// LOOP ON IS EXCLUDED, and must be: a looping clock has no end-stop — it WRAPS an out-of-range
// playhead back into [start, end) on the next frame, emitting nothing and pulsing nothing (and it
// re-baselines prevPlayhead itself). Pausing a looping show because its Length was shortened, or
// because the operator clicked back to Global, would be a regression invented by this guard.
function clampPlayheadIntoDoc(t: Timeline): void {
  if (!playing || t.loop || playhead < timelineEnd(t)) return;
  mainSeek(Math.max(timelineStart(t), timelineEnd(t) - frameSec(t)));
  endLatched = true;
  emitIntent({ kind: 'pause' });
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
  // WHICH CLOCK THIS LANE READS. A BASE lane belongs to the GLOBAL timeline, so it must ride the SHOW
  // clock — otherwise a global curve authored over five minutes is re-sampled at scene-relative 0-30 s
  // on every recall, which is what happens today and is a bug (the audio bed is global, so its curves
  // must outlive a scene swap: that is exactly why setBaseAutomation exists). An ACTIVE lane belongs to
  // the BOUND document and rides its playhead. Resolved HERE, at compile time, because compileAutomation
  // is the only place that still knows which DOCUMENT a lane came from.
  clock: 'show' | 'scene';
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
  // WHICH CLOCK DOES A LANE RIDE? A lane of the GLOBAL doc is a BASE lane and rides the SHOW clock (it is
  // the base layer under every scene, like the bed). A lane of a SCENE's doc rides the PLAYHEAD.
  //
  // THIS IS SOUND ONLY BECAUSE OF AN INVARIANT, so state it: A SCENE'S `automation` NEVER HOLDS A LANE
  // COPIED FROM THE GLOBAL TIMELINE. Break it and the copy is tagged 'scene' AND shadows the real base lane
  // by targetPath on the very next line — so the genuine show-clock lane is DELETED from this compile and
  // replaced by a playhead-riding impostor. That was a merge blocker: a house fade on audio.master.gain
  // jumped +9.6 dB in one frame on a GO, and the scene's copy was persisted, so it recurred forever.
  //
  // Two writers used to break it, and BOTH are now structurally impossible rather than guarded:
  //   · a timeline-less scene materialised a copy of the global doc on its first edit — that state is gone
  //     (Scene.timeline is required, types.ts);
  //   · Capture Scene deep-cloned the bound doc, automation and all — it now strips `automation` (App.tsx).
  // No fix HERE could ever have worked: by the time we run, a copied lane is byte-identical to one the
  // operator drew on the scene. The fact that told them apart was destroyed by the writer.
  const onGlobalDoc = clocksCoincident();
  const base = onGlobalDoc ? [] : baseAutomation.filter(l => !activePaths.has(l.targetPath));
  // Tag each lane with the clock it rides BEFORE the concat — afterwards there is no way to tell them
  // apart. When the global doc is bound, `base` is empty (the global timeline IS the base and must not
  // stack on itself) and its own lanes are the base layer ⇒ 'show'. When Global is bound on the pill the
  // two clocks are the same number anyway (the identity), so 'show' is exactly right there too.
  const lanes: { lane: AutomationLane; clock: 'show' | 'scene' }[] = [
    ...base.map(lane => ({ lane, clock: 'show' as const })),
    ...active.map(lane => ({ lane, clock: (onGlobalDoc ? 'show' : 'scene') as 'show' | 'scene' })),
  ];

  const next: LaneRT[] = [];
  const nextPaths = new Set<string>();
  for (const { lane, clock } of lanes) {
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
      clock,
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

function sampleAutomation(playheadSec: number, showTimeSec: number): void {
  const n = lanesRT.length;
  if (n === 0) return; // the no-automation cost is one compare
  let wrote = false;
  for (let i = 0; i < n; i++) {
    const rt = lanesRT[i];
    // The GLOBAL timeline's lanes (the base layer) ride the SHOW clock; the bound document's own lanes
    // ride its playhead. See LaneRT.clock.
    const t = rt.clock === 'show' ? showTimeSec : playheadSec;
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
    hitEnd = false; // one frame only: set below when the playhead lands on the end, read by the FSM tick
    // Cleared here and re-established below on every frame the hold branch actually parks — so ANY
    // other outcome (a seek, a recall's swap, loop switched on, the transport stopped, the document
    // edited shorter) drops it without needing to know it exists. See the flag's own note.
    held = false;
    // The end-stop's `pause` intent is RAISED in the clock below but only EMITTED after fsm.tick() —
    // see the deferral just past the tick. Frame-local: it must never survive into the next frame.
    let pausePending = false;
    // The main window owns the clock; a hapLocal mirror (the fullscreen projector) runs the same
    // monotonic clock so it plays at full speed while the hidden main window's bridged transport is
    // throttled. Deriving the playhead from a fixed origin (not += dt) keeps cadence uniform against
    // the display refresh and never drifts; seek() phase-locks mirror windows to the authority.
    if (!external || hapLocal) {
      if (playing) {
        // Bounded timeline: `Length` (duration), or an explicit out-point, IS the end.
        //   loop ON  → wrap over [start, end), re-anchoring originMs so cadence stays uniform
        //   loop OFF → hold on the last frame and ask App to pause (the engine never writes `playing`)
        //
        // EVERY branch below that MOVES the playhead somewhere it did not travel to must also
        // re-baseline `prevPlayhead` — the FSM is ticked with (playhead, prevPlayhead) and reads that
        // pair as a window the playhead TRAVERSED. A jump left in it is a window of triggers that
        // never played, and firing one recalls its bound scene: the wrong scene goes on stage.
        // (This is what mainSeek() does for a deliberate seek; the clock has to do the same.)
        let t = (now - originMs) / 1000;
        const a = timelineStart(data), b = timelineEnd(data);
        if (t < a) {
          // Below the in-point (press Play at 0 on a region starting at 5s; or the in-point was
          // dragged past the playhead mid-show). This is a JUMP to the region start, NOT playback of
          // (playhead, a] — so re-baseline prev, or fsm.tick() takes its FORWARD branch over that
          // whole window and fires every atTime/onMarker in it, plus onClipEnd for every layer whose
          // clip was live at 0 and isn't at 5. Pressing Play would put the wrong scene on stage.
          t = a;
          originMs = now - t * 1000;
          prevPlayhead = t;
        }
        if (t >= b) {
          if (data.loop) {
            t = a + ((t - a) % (b - a));
            originMs = now - t * 1000;
            // The wrap is a BACKWARD jump, and crossed()'s backward branch is an OR (`T > prev ||
            // T <= cur`) — deliberately, but written assuming the wrap spans the WHOLE timeline
            // (end → 0). Over a partial region (in-point > 0), or with triggers authored past `end`,
            // that OR matches everything outside the region and re-fires it on EVERY pass, forever
            // (region [2,6) + an atTime at 1.0: prev=5.98, cur=2.02 → `1.0 <= 2.02` → fires, each lap).
            // Baselining prev at the region start turns the wrap frame into the small, real FORWARD
            // window (a, t] that was actually played.
            // KNOWN LIMITATION: a trigger authored in the region's final frame-time — between the last
            // sampled playhead and `end` — is missed on the wrap frame (a ~1-frame, ~33ms window).
            // That is vastly preferable to firing every out-of-region trigger on every lap. Do NOT
            // "fix" it by ticking the FSM twice: it evaluates at most ONE transition per frame by
            // design, and a double tick could fire two.
            prevPlayhead = a;
          } else {
            // Park on the LAST FRAME, not on `end` itself. activeClip() is half-open
            // (`t >= c.start && t < c.start + c.duration`), so a playhead sitting exactly ON the end
            // has NO clip under it: syncLayer nulls the layer, layerDrawable returns null and
            // buildProgram clears to black — every non-looping show would end with the projectors and
            // the LED output going black. One frame back, in the document's own timebase: the last
            // frame of a 10s/30fps timeline genuinely IS at 9.9667s (standard NLE semantics).
            const eps = frameSec(data);
            // Hold the RAW clock at the end boundary rather than at the parked playhead. If we
            // re-anchored to `t` (a frame BEFORE `b`), the next frame's raw time would be < b, the
            // clock would sail past the end again, and the playhead would sawtooth over the last frame
            // until App's pause round-trips — and each sawtooth step BACKWARD is exactly what
            // crossed() reads as a loop wrap. Anchoring at `b` re-parks deterministically instead.
            originMs = now - b * 1000;
            t = Math.max(a, b - eps);
            // Crossings are NOT suppressed here: reaching the end is real forward PLAYBACK, not a jump,
            // so an atTime at 9.95 must still fire on the frame that parks at 9.9667 — hence a clamp
            // and not a mainSeek-style `prevPlayhead = t`.
            //
            // But the park can still be a step BACKWARD, and that has to be caught. The last sampled
            // playhead before the clock passed `end` lands somewhere in [b - dt, b) (dt = one rAF, ~16ms)
            // — which is AHEAD of the parked b - eps (eps = one source frame, ~33ms). At 60Hz on a 30fps
            // document that is true on essentially every run: prev=9.9833 > cur=9.9667. crossed() would
            // then take its backward/wrap branch (`T > prev || T <= cur`) and fire the first trigger at
            // or below the parked time — an atTime at 3s would recall its scene as the show ends.
            // Clamping prev to the parked time makes that window empty instead. Nothing is lost: any
            // trigger in (t, prev] ALREADY fired on the frame that sampled prev. Only a trigger in the
            // never-sampled sub-frame window (prev, end) is missed — the same accepted ~1-frame gap as
            // the loop wrap above.
            prevPlayhead = Math.min(prevPlayhead, t);
            // ── HOLD vs STOP — the only thing Timeline.holdAtEnd changes. ────────────────────────
            // The park above is IDENTICAL either way, and deliberately so: every line of it (the
            // last-frame clamp, the re-anchor at `b`, the prevPlayhead clamp) encodes a shipped bug,
            // and a held show must hold the same picture a stopped one does — on the projectors and
            // on the LED output alike. What differs is what we TELL the rest of the app.
            //
            // A hold does not touch `playing`, so this branch is re-entered every frame: the raw
            // clock passes `b`, we re-anchor at `b` and re-park at `b - eps`. That is stable, not a
            // sawtooth (the re-anchor is exactly why), and it is what keeps `held` true without a
            // latch. `endLatched` still gates the ONE-FRAME hitEnd pulse, so 'onTimelineEnd' fires
            // exactly once on a hold too — a held state that HAS such an edge still auto-advances.
            const holding = !!data.holdAtEnd;
            if (holding) held = true;
            // Latch: emit ONCE, not every frame until App's state round-trips back to us.
            if (!endLatched) {
              endLatched = true;
              hitEnd = true;                 // consumed by the FSM tick below, this frame only
              // …but NEVER the pause when holding. `playing` is what the SHOW clock is gated on, so
              // pausing here is what stops the bed and the global automation in a room that is
              // waiting for a person to walk in. Holding writes nothing to the transport at all.
              if (!holding) pausePending = true; // NOT emitted here — deferred until after fsm.tick(). See below.
            }
          }
        }
        playhead = Math.max(0, t);
      } else {
        originMs = now - playhead * 1000; // keep the anchor live while paused so resume is seamless
      }
    }
    // ── THE SHOW CLOCK — a PARALLEL derivation on the same wall clock and the same `playing` flag.
    //
    // `!external` only — NOT `|| hapLocal`. A hapLocal projector runs the SCENE clock (so it plays at
    // full speed while the hidden main window's rAF is throttled), but nothing show-clock-driven exists
    // in a projector: the audio driver early-returns for non-main windows, and the transport bridge
    // streams only {playing, playhead}. This matches sampleAutomation and the FSM block below.
    //
    // Every branch that MOVES showTime re-anchors showOriginMs — the same rule the scene clock follows
    // for originMs. There is NO prevShowTime to re-baseline, because nothing crossing-detects on this
    // clock: fsm.tick() runs on `playhead` alone, by design (the show clock reaching the global loop's
    // end must NOT fire 'onTimelineEnd' — that would advance the machine behind the operator's back).
    //
    // AND NOTE THE ABSENCE, BELOW: no emitIntent, no hitEnd, no endLatched. The show clock is SILENT.
    if (!external) {
      if (playing) {
        let s = (now - showOriginMs) / 1000;
        const ga = timelineStart(globalDoc), gb = timelineEnd(globalDoc);
        if (s < ga) {                                   // underrun: below the GLOBAL in-point
          s = ga;
          showOriginMs = now - s * 1000;
        }
        if (s >= gb) {
          if (globalDoc.loop) {                         // THE SHOW LOOPS — and the bed restarts with it.
            // This wrap IS a big backward jump, and the audio driver's inferred-seek test will read it
            // as a seek and hard-resync the bed at the wrapped position. That is CORRECT: the show
            // looped. (The bug this whole clock exists to fix is a SCENE's loop/recall doing that — and
            // under showTime it no longer can, because a scene's clock never touches this number.)
            s = ga + ((s - ga) % (gb - ga));
            showOriginMs = now - s * 1000;
          } else {                                      // THE SHOW ENDED — park, silently.
            // Anchor at the RAW end boundary (gb), not at the parked value — the same reason the scene
            // clock does it (see the end-stop above): re-anchoring to a value BEFORE gb would let the raw
            // clock sail past the end again next frame and sawtooth over the last frame forever.
            showOriginMs = now - gb * 1000;
            s = Math.max(ga, gb - frameSec(globalDoc));
          }
        }
        showTime = Math.max(0, s);
      } else {
        showOriginMs = now - showTime * 1000; // keep the anchor live while paused so resume is seamless
      }
    } else if (playing) {
      // ── MIRROR WINDOWS: THE SHOW CLOCK IS TOLD, NOT RUN ──────────────────────────────────────────────
      // A projector does not derive showTime — it receives it over the transport bridge at ~30 Hz
      // (setExternalShowTime, below) and INTERPOLATES between messages here, so a 60 fps effect surface does
      // not judder at half the frame rate. Each bridge message re-anchors showOriginMs, so it cannot drift.
      //
      // No clamping, no wrap, no end-stop, no intent: the main window has already applied every one of those
      // and sent us the answer. This arm exists purely so a generative surface has a coherent time axis on
      // the projector — before Task 10 an effect surface there ran on the window's OWN performance.now(),
      // whose epoch is that window's navigation start, so the audience saw a different phase from the
      // operator's preview, permanently.
      showTime = Math.max(0, (now - showOriginMs) / 1000);
    }
    // Automation: sample the lanes and push what moved. Deliberately NOT a subscribe() callback — `subs`
    // is insertion-ordered and the audio driver is one of them, so a late subscriber's values would land
    // AFTER reconcile() had already run this frame, costing a permanent frame of latency. It also sits
    // OUTSIDE the `playing` gate above, so scrubbing while paused still moves the curve (which is what
    // makes the bed sound right the instant you hit play).
    if (!external) {
      try { sampleAutomation(playhead, showTime); } catch (e) { console.error('[timeline] automation error', e); }
    }
    // FSM control layer (main window only — mirrors receive the resulting transport via the bridge).
    // Ticks every frame regardless of `playing` so the standalone wall clock advances while stopped.
    if (!external) {
      frameNowSec = now / 1000;
      // `armed`: HELD during a cold start until the first look is resident — see the flag's own note.
      // Only the TICK is skipped. frameNowSec above still advances (getSmElapsedSec and any later
      // afterDelay measure from the arm, not from the load), and the deferred pause below still
      // emits: the end-stop can only have raised it under `playing`, and a transport that is running
      // during a boot hold is one a human started, which arms the gate anyway.
      if (armed) try { fsm.tick(projectSm, playhead, prevPlayhead, smContext()); } catch (e) { console.error('[timeline] fsm error', e); }
      // THE END-STOP'S `pause`, DEFERRED TO HERE — the whole point of the 'onTimelineEnd' feature.
      //
      // The end-stop and the FSM edge it feeds happen on the SAME frame: hitEnd is set up in the clock
      // and consumed by the tick above. If the pause were emitted where it is raised (~20 lines up), an
      // 'onTimelineEnd' transition would fire immediately AFTER it — and its destination's recall
      // (swap → mainSeek) re-seeks the clock but, correctly, never writes `playing` (App owns it). The
      // already-queued setIsVideoPlaying(false) would still land: the destination scene's look on the
      // projectors, its timeline parked at frame 0, and the transport STOPPED. The auto-advance chain
      // freezes after exactly one hop — with the show reporting itself healthy. That is the failure this
      // ordering exists to prevent.
      //
      // So: emit only if the tick did NOT re-arm the clock. `endLatched` is precisely that signal —
      // mainSeek() clears it, and every way the FSM can put the show back in motion goes through
      // mainSeek SYNCHRONOUSLY inside the tick above (recallScene → cueBus → App → swap(restart);
      // a `seek`/`jumpMarker` action → App → seek(); a `play` action → App → seek() when parked at the
      // end). If nothing re-seeked, the show really did end and the pause stands — which is the normal,
      // non-FSM case and must keep working.
      //
      // Mirror windows never reach here (`!external`), so they still cannot emit intents.
      if (pausePending && endLatched) emitIntent({ kind: 'pause' });
    }
    // Main window decodes everything; mirror windows decode only HAP locally (when hapLocal),
    // otherwise they consume streamed frames and skip decoding entirely.
    //
    // ⚠ AND A MIRROR DECODES ONLY WHAT IT SHOWS. A projector window renders exactly ONE surface, but
    // this loop used to walk EVERY layer in the document — so a wall of three outputs ran four decode
    // rings (main + three mirrors) over every HAP layer in the show, and a projector whose surface is
    // an IMAGE decoded the timeline's video anyway. Each ring is a real cost: native decode, disk
    // reads, IPC, and a GPU upload per frame. `localLayers` is the set that window actually draws
    // (ProjectorApp pushes it from its config); null = no filter, which is what the MAIN window wants
    // and what a mirror falls back to before its first config arrives.
    if (!external || hapLocal) for (const l of data.layers) {
      if (clipKindRegistry.get(l.kind ?? '')?.skipVideoSync) continue; // non-video lanes (e.g. tracking takes) — see the plugin's clip-kind contribution
      if (external && localLayers && !localLayers.has(l.id)) continue;
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
// ⚠ Returning null here is not "draw nothing" — buildProgram() has already CLEARED the canvas, so a
// null is BLACK ON THE OUTPUT. A seeking <video> reports readyState < 2 and is undrawable, which is
// why a scrub used to strobe black. Fall back to the last good frame (captureHold) rather than cutting
// to black: the docs promise the output holds a picture, and a venue would rather see a frame one or
// two late than a black projector. Only a layer with NO CLIP under the playhead is legitimately black.
function layerDrawable(layerId: string): CanvasImageSource | null {
  const lv = layerVideos.get(layerId);
  if (!lv || !lv.clipId) return null;
  if (lv.mode === 'content') return lv.content ? contentSource.getDrawable(layerKey(layerId), lv.content, lv.contentLocalTime ?? 0) : null;
  if (lv.mode === 'codec') return lv.codec ? lv.codec.canvas : null;
  if (lv.mode !== 'video') return null;
  return lv.el.readyState >= 2 ? lv.el : (lv.hold ?? null);
}

// Natural w/h of whatever a layer is showing right now, or null when nothing is under the playhead
// / it isn't measurable yet. A layer's drawable is a <video>, a codec canvas or a content drawable,
// and each reports its intrinsic size under a different property — hence the ordered probe.
// (`width`/`height` last: on an HTMLVideoElement those are the DISPLAY attributes, not the frame,
// so videoWidth has to win.)
function drawableAspect(d: CanvasImageSource | null): number | null {
  if (!d) return null;
  const anyD = d as unknown as { videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
  const w = anyD.videoWidth || anyD.naturalWidth || anyD.width || 0;
  const h = anyD.videoHeight || anyD.naturalHeight || anyD.height || 0;
  return w > 0 && h > 0 ? w / h : null;
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
    // A DOCUMENT EDIT MUST NEVER SYNTHESISE A TRANSPORT EVENT — the whole argument lives on
    // clampPlayheadIntoDoc above. setData is its ONLY caller: swap()'s click case is 'reconverge', which
    // carries its own copy of the latch-without-pulse guard.
    clampPlayheadIntoDoc(t);
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
  //
  // transport:
  //   'restart'    (default) — the incoming document plays from its first frame (a scene recall).
  //   'reconverge'           — RETURNING TO GLOBAL. The playhead SNAPS TO THE SHOW CLOCK, so the picture
  //                            rejoins the bed. While a scene was bound the two diverged; the show clock
  //                            is the one that never stopped, and it is BY CONSTRUCTION inside the global
  //                            doc's [start, end) (the clock wraps or parks it there). So — unlike the
  //                            'preserve' this replaces — there is normally nothing to clamp and NO
  //                            `pause` intent to emit. That emit is what used to kill the bed on a click
  //                            back to Global: clampPlayheadIntoDoc → emitIntent({kind:'pause'}) → App
  //                            sets playing=false → the audio driver's stopAllSounding().
  //
  // showClock:
  //   'preserve'   (default) — THE BED ROLLS ON. The defining requirement of the show clock: a scene
  //                            recall, an FSM hop, enterAuthor and handleCreateState all land here.
  //   'reset'                — project open. A recall, project open and handleCreateState ALL reach
  //                            swap() with transport:'restart' and cannot be told apart in here, so the
  //                            CALLER says which it is.
  swap(poolKey: string, t: Timeline, opts?: { transport?: 'restart' | 'reconverge'; showClock?: 'preserve' | 'reset'; holdMs?: number }): void {
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
    // Clean first-frame start — via the GUARDED start, never the raw in-point. mainSeek() feeds `playhead`,
    // `originMs` and `prevPlayhead` from this one number, so a scene whose timeline carries a junk inPoint
    // (hand-edit, bad import, plugin-written project — normalizeTimeline does not coerce it) would NaN the
    // whole clock: every activeClip(NaN) matches nothing, so the projectors and the LED output go black and
    // the transport stays dead until someone seeks.
    //
    // 'reconverge' RETURNS THE PICTURE TO THE BED. The show clock never stopped and is by construction
    // inside the global doc's [start, end), so snapping the playhead onto it cannot drop it outside the
    // incoming document — which is what the old 'preserve' path had to guard (and it guarded it by
    // emitting a `pause`, which killed the bed on a click back to Global).
    if ((opts?.transport ?? 'restart') === 'restart') mainSeek(timelineStart(t));
    else {
      // 'reconverge' — the picture rejoins the bed.
      mainSeek(showTime);
      // ⚠ THE BOUNDARY CASE, AND IT IS AN INVARIANT-5 BUG IF YOU SKIP IT.
      // A PARKED show clock sits at EXACTLY `globalEnd - frameSec` — one rAF INSIDE the end. mainSeek()
      // has just CLEARED endLatched, so within two frames the raw clock crosses `b`, takes the end-stop,
      // PULSES hitEnd and fires an 'onTimelineEnd' transition — FROM A MOUSE CLICK. (Reachable from the
      // pill → Global and from deleting the bound scene, once the show has run past its global Length
      // with a scene on air — which the default 60 s global Length makes easy.)
      // So: the same LATCH-WITHOUT-PULSE treatment clampPlayheadIntoDoc gives a document edit, and the
      // pause it also gives — the show really is over (stop + hold on the last frame). The machine is
      // never advanced by a click; the transport is simply told the truth.
      // In the NORMAL case showAtEndBound() is false, nothing latches, nothing pauses, and reconverge's
      // whole point survives intact.
      //
      // THE `pause` IS GATED ON `playing`, exactly as clampPlayheadIntoDoc gates its own. A `pause`
      // intent on an ALREADY-STOPPED transport is a lie on a channel that is PUBLIC — dispatchTransportIntent
      // opens it to OSC and to plugins, and a consumer that treats `pause` as an EVENT (a fade-out, a
      // cue, a log line, a DMX blackout) would fire it from a mouse click on a show that was not running.
      // App survives it today only because setIsVideoPlaying(false) on an already-false value is a React
      // bail-out; that is luck, not a contract.
      //
      // THE LATCH IS *NOT* GATED. It is what stops the next Play from pulsing hitEnd, and it costs
      // nothing when stopped (the end-stop branch only runs under `playing`). It is cleared by the next
      // mainSeek — including the one inside setPlaying(true)'s parked-end restart.
      if (showAtEndBound()) { endLatched = true; if (playing) emitIntent({ kind: 'pause' }); }
    }
    if (opts?.showClock === 'reset') showSeekInternal(timelineStart(globalDoc));
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
    if (p) {
      // Pressing play while parked at (or past) the end restarts from the top — otherwise we would reach
      // the end again within a frame or two, pause straight back, and the button would look dead.
      //
      // The test is POSITION-based, and deliberately NOT the `endLatched` flag. The latch says "the clock
      // stopped at the end" — but it says nothing about WHERE the end is NOW, and the end is a document
      // value the user can move while parked: play a 10s show out, then set Length to 20 (or drag the
      // out-point later). setData touches neither the playhead nor the latch, so a latch-gated test would
      // still read "at the end" and restart from 0 instead of playing on into the new 10–20s region.
      //
      // A plain `playhead >= timelineEnd(data)` doesn't work either: the end-stop parks a whole frame
      // SHORT of the end (parking exactly ON it leaves no clip under the playhead — activeClip is
      // half-open — and the show would end on black), so a slop-sized test never matches and Play would
      // replay the last frame and stop again. The park lands at EXACTLY `end - frameSec`, in the
      // document's own timebase, so a frame-aware bound is exact rather than slop-dependent.
      //   • parked at the end            → playhead == end - frameSec  → restarts ✓
      //   • Length moved out from under it → the bound moved with it, playhead is now short of it → resumes ✓
      //   • scrubbed to 30s on a 10s show → way past the bound          → restarts ✓ (no latch was ever set)
      //   • paused mid-show at 4s        → well short of the bound      → resumes ✓
      // Only needed when loop is OFF: a looping clock wraps an out-of-range playhead into the region itself.
      // (The test itself is atEndBound(), hoisted so App's 'play' intent can ask the same question.)
      if (!external && atEndBound()) mainSeek(timelineStart(data));
      // The SHOW clock has its own end — on the GLOBAL document — and needs its own restart. The test
      // above only ever looks at the BOUND doc, so without this a show whose global Length ran out while
      // a scene looped underneath would come back from a pause with a permanently dead bed.
      if (!external && showAtEndBound()) showSeekInternal(timelineStart(globalDoc));
      // Re-arm the end regardless: the latch's ONLY job is to keep the end-stop from re-emitting a `pause`
      // intent every frame while App's state round-trips. Leave it set on a resume that did NOT restart
      // (the Length-moved case above) and the next end-stop would park silently, never emitting `pause` and
      // never pulsing hitEnd — the show would run past its new end with the FSM's onTimelineEnd dead.
      endLatched = false;
      originMs = performance.now() - playhead * 1000;     // re-anchor the monotonic clock on resume
      showOriginMs = performance.now() - showTime * 1000; // …and the show clock's, identically
    }
  },
  setExternal(e: boolean): void { external = e; },
  setHapLocal(v: boolean): void { hapLocal = v; },
  // Restrict this window's local layer decode to the layers it draws (mirror windows). Pass null to
  // decode every layer — the main window's behaviour, and a mirror's default until its first config.
  // Layers dropped from the set release what they held, or a window that stops showing a layer keeps
  // its decoder and its <video> alive for the rest of the show.
  setLocalLayers(ids: string[] | null): void {
    const next = ids ? new Set(ids) : null;
    if (next && localLayers && next.size === localLayers.size && [...next].every(id => localLayers!.has(id))) return;
    const prev = localLayers;
    localLayers = next;
    if (!external || !next) return;
    for (const l of data.layers) {
      if (next.has(l.id) || (prev && !prev.has(l.id))) continue; // still shown, or already not decoded
      const lv = layerVideos.get(l.id);
      if (!lv) continue;
      lv.el.pause(); lv.el.removeAttribute('src');
      lv.srcPath = null; lv.clipId = null; lv.mode = null;
      for (const c of videoCodecRegistry.all()) c.releaseLayer(l.id);
      contentSource.release(layerKey(l.id));
    }
  },
  seek(sec: number): void {
    // PLAYBACK is bounded by [timelineStart, timelineEnd); SEEKING is not. Only the floor is enforced
    // here: the canvas still renders clips that overrun `Length`, so scrubbing past the end has to keep
    // working — it is how you find them. Pressing play from out there restarts from the top (setPlaying).
    const clamped = Math.max(0, sec); // time never goes negative — that is the only bound a seek gets
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
    // THE IDENTITY. While the two clocks ARE THE SAME NUMBER, a seek moves both — so a ruler scrub, an OSC
    // /transport/seek, the Home key, an AutomationLane click-to-seek and the Stop button all stay coherent
    // without any of them knowing the show clock exists. Once they have DIVERGED, a seek moves the playhead
    // only: seeking a scene must not move the bed.
    //
    // ⚠ clocksCoincident() — the full argument is on the function itself. The clocks are equal in exactly
    // one state, the Global pill; everywhere else they are diverged ON PURPOSE, and that divergence IS the
    // show clock. A seek gated on anything looser would drag showTime to a scene-relative number and
    // hard-restart a 20-minute bed on every entry to that scene.
    //
    // It has to be HERE, not in App: Timeline.tsx's seekTo() calls engine.seek() DIRECTLY (it does not go
    // through the TransportIntent funnel), so a rule living only in App's seek handler would let a ruler
    // scrub break the identity.
    //
    // `!external`: a projector that is NOT hapLocal falls through the mirror arm above into mainSeek, and
    // a mirror has no show clock at all. Guard it here rather than relying on the early return.
    if (!external && clocksCoincident()) showSeekInternal(clamped);
  },
  getPlayhead(): number { return playhead; },
  // The document's "Length" — guarded, so junk (NaN / "10" / null) can't leak out to a plugin status
  // readout. NOT the playable end: an out-point overrides Length — that's getEnd().
  getDuration(): number { return timelineDuration(data); },
  getEnd(): number { return timelineEnd(data); },
  getStart(): number { return timelineStart(data); },
  // THE BOUND DOCUMENT'S OWN AUDIO — the container that rides the PLAYHEAD (unlike the bed, which rides
  // the show clock). Read from `data`, i.e. from the ENGINE, NOT from React state, and that is the whole
  // point of it existing:
  //
  //   A scene recall runs SYNCHRONOUSLY inside one rAF frame — swap() repoints `data` and mainSeeks the
  //   playhead to the scene's in-point, and the audio driver's tick runs later IN THAT SAME FRAME (it is
  //   a `subs` callback). App's `activeTimeline` is React state and does not exist until the commit, a
  //   frame or more later. A driver reading the bound audio through a render-assigned ref would therefore
  //   spend that frame reconciling the OUTGOING document's clips against the INCOMING document's playhead
  //   — and since a recall lands the playhead on the scene's in-point (usually 0), an outgoing clip that
  //   starts at 0 would be START-ED, from its top, for one or two frames, before syncLoaded caught up and
  //   unloaded it. An audible click on every single GO. Sourcing it from `data` closes that window by
  //   construction: the doc and the playhead always move together, because swap() moves both.
  //
  // May be undefined (a project saved before Timeline.audio existed) — the caller defaults it.
  getBoundAudio(): TimelineAudio | undefined { return data.audio; },
  // THE BOUND DOCUMENT'S VIDEO-CLIP AUDIO — the same clock as getBoundAudio (the playhead), a different
  // owner. See videoAudioOf() for the whole argument; read from `data` for exactly the reason above.
  getBoundVideoAudio(): TimelineAudio { return videoAudioOf(data); },
  // The GLOBAL timeline document. `data` is always the BOUND doc, so this is the engine's only handle on
  // the global one — and the SHOW clock is bounded by it. Pushed by App on every global-timeline change.
  //
  // IT ALSO RE-ANCHORS THE SHOW CLOCK INTO THE NEW REGION. Lowering the global Length, or dragging its
  // out-handle left, while a SCENE is bound does NOT reach setData's clampPlayheadIntoDoc guard
  // (activeTimeline is the scene's) — and the show clock re-reads globalDoc every frame, so it would park
  // on the next frame anyway. Do it HERE, deterministically, in the same call: same doctrine as
  // clampPlayheadIntoDoc — REPOINTING A DOCUMENT UNDER A LIVE CLOCK MUST NEVER SYNTHESISE A TRANSPORT
  // EVENT. So: no intent, no hitEnd, no FSM crossing.
  //
  // BE HONEST ABOUT WHAT THE OPERATOR HEARS: shortening the global region below showTime IS a big
  // backward move, the audio driver reads it as a seek, and the bed hard-cuts (and then STOPS, because
  // isShowAtEndBound() is now true). That is correct — you just told the show it is over — but it is not
  // a no-op.
  //
  // ⚠ WHEN LOOPING, WRAP — DO NOT REWIND. The overrun branch used to send the show clock to `ga`, the
  // region start. But the PLAYHEAD is not rewound: setData's clampPlayheadIntoDoc RETURNS EARLY on a
  // looping doc, so the playhead is left where it was and the next rAF wraps it MODULO
  // (`t = (t - ga) % (gb - ga) + ga`). Shorten Length from 60 to 40 at playhead 45 and you get
  // playhead = 5 while showTime = 0 — and both then free-run over the same region with the same period,
  // so the five-second offset NEVER CLOSES. It opened on the GLOBAL PILL: the one and only state where
  // clocksCoincident() asserts the two clocks are the same number. Land the show clock exactly where the
  // playhead is about to land, by wrapping it the same way. (Loop OFF is unchanged: park one frame before
  // the end. An underrun is unchanged: clamp up to the in-point.)
  setGlobalDoc(t: Timeline): void {
    globalDoc = t;
    if (external) return;
    const ga = timelineStart(globalDoc), gb = timelineEnd(globalDoc);
    if (showTime < ga) showSeekInternal(ga);
    else if (showTime >= gb) {
      const span = gb - ga;
      showSeekInternal(
        globalDoc.loop && span > 0
          ? ((showTime - ga) % span) + ga           // wrap, exactly as the playhead is about to
          : Math.max(ga, gb - frameSec(globalDoc)), // not looping: park one frame before the end
      );
    }
  },
  // THE SHOW CLOCK, in seconds. In a MIRROR window this is the number the bridge last told us (plus the
  // frame-loop's interpolation), not a number this window derived — see setExternalShowTime.
  getShowTime(): number { return showTime; },
  // TELL A MIRROR WINDOW THE SHOW CLOCK. The counterpart to showSeek(), which deliberately REFUSES in a
  // mirror (`if (!external)`): a projector must never MOVE the show, only be told where it is. Called from
  // the transport bridge at ~30 Hz alongside setPlaying/seek; the frame loop interpolates between messages
  // so a 60 fps effect surface does not judder, and re-anchoring here on every message means it cannot drift.
  //
  // WITHOUT THIS, an effect surface on a projector would be frozen at 0: getShowTime() used to be
  // "always 0 in mirror windows", and surfaceMedia now reads it. It also fixes something that was ALWAYS
  // broken — each window ran its own performance.now(), whose epoch is that window's navigation start, so
  // the same generative effect sat at a different phase on the audience's projector than in the operator's
  // preview, and the drift was permanent.
  setExternalShowTime(sec: number): void {
    if (!external) return;                        // the main window DERIVES this clock; it is not told it
    const s = Number.isFinite(sec) ? Math.max(0, sec) : 0;
    showTime = s;
    showOriginMs = performance.now() - s * 1000;  // re-anchor, so the interpolation continues from here
  },
  getGlobalStart(): number { return timelineStart(globalDoc); },
  getGlobalEnd(): number { return timelineEnd(globalDoc); },
  // THE PARK, PUBLISHED. The audio driver MUST be able to ask this: a parked show clock is a FROZEN
  // NUMBER, and a drift re-lock against a frozen number re-seeks every sounding clip back to the same
  // source offset every ~50 ms — forever. That is a buzz, not silence. `playing` is not the signal (a
  // scene looping underneath keeps it true), and the park is deliberately silent on the intent channel —
  // so it is published as a READABLE STATE instead.
  isShowAtEndBound(): boolean { return showAtEndBound(); },
  // Move the SHOW clock explicitly. The POLICY lives at the call sites (Stop; project open; New Project)
  // — see the reset table in docs/TIMELINE.md. No-op in mirror windows, which have no show clock.
  showSeek(sec: number): void { if (!external) showSeekInternal(sec); },
  isPlaying(): boolean { return playing; },
  // Is the transport parked on the last frame with loop OFF (the non-looping end-stop's resting place)?
  // Exposed for App's 'play' intent handler, which must re-arm the clock IMPERATIVELY there: a `play`
  // that arrives while `playing` is already true (an FSM 'play' entry action on the end frame) is a
  // React no-op and would otherwise leave the engine latched at the end forever — playing, frozen, and
  // reporting itself healthy. Same position-based test the Play button uses (see setPlaying).
  isAtEndBound(): boolean { return atEndBound(); },
  // IS THE SCENE CLOCK HELD ON ITS LAST FRAME (Timeline.holdAtEnd) WHILE THE TRANSPORT RUNS ON?
  //
  // The twin of isShowAtEndBound(), asked of the BOUND document instead of the global one, and
  // published for the same non-obvious reason: A FROZEN CLOCK MUST NOT BE RECONCILED AGAINST. The
  // audio driver's drift re-lock compares each sounding clip's DESIRED offset (derived from the
  // clock) against its ESTIMATED one (derived from the wall clock) — park the clock and desired
  // freezes while estimated runs on, so it re-seeks every playhead-clocked clip back to the same
  // offset every ~50 ms, forever. That is a buzz, not silence.
  //
  // `playing` is NOT the signal (a hold deliberately leaves it true), and the hold is silent on the
  // intent channel by design — so, exactly like the show-clock park, it is published as a READABLE
  // STATE. Scoped to the PLAYHEAD-clocked containers (this timeline's own audio + video-clip
  // soundtracks); the BED rides the show clock and must play straight through a hold, which is the
  // whole point of holding instead of pausing.
  isBoundHeld(): boolean { return held; },
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
  // ── THE COLD-START ARM (services/bootGate owns the policy; this is only the seam) ──────────────
  // Hold the machine while a freshly-opened project's first look loads, then arm it. Deliberately NOT
  // `stateMachine.enabled`: that flag is PERSISTED PROJECT DATA, and flipping it off to wait would
  // write the show back to disk disabled the next time anything called buildProjectData().
  setArmed(a: boolean): void {
    if (a === armed) return;
    armed = a;
    armedSubs.forEach(cb => cb(a));
  },
  isArmed(): boolean { return armed; },
  subscribeArmed(cb: (armed: boolean) => void): () => void { armedSubs.add(cb); cb(armed); return () => { armedSubs.delete(cb); }; },
  // Is this pool's FIRST FRAME decoded and drawable? Re-drives the pre-roll as a side effect. See
  // poolReadiness — the boot gate polls it, and nothing else should need it.
  poolReady(poolKey: string, t: Timeline): { ready: boolean; pending: string[] } { return poolReadiness(poolKey, t); },
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
      // ⚠ A MIRROR DECIDES "NO CLIP → BLACK" FOR ITSELF. `layerBitmaps` only ever grows: the main
      // window's pump simply STOPS sending once a layer has nothing under the playhead, so a mirror
      // that trusted the last streamed frame kept a finished clip's finalframe on screen for the
      // rest of the show — and with several video tracks, whichever track ended first stayed frozen
      // over everything after it. Nothing in the stream says "now show nothing".
      //
      // It doesn't need to be told: a mirror holds the timeline (setData) and the playhead (seek),
      // so activeClip() answers this locally, with the same half-open predicate the main window
      // uses. Worst case at a clip boundary the two disagree by the mirror's slew error (sub-frame),
      // which is a frame early/late — not a frame held forever.
      if (!activeClip(layerId, playhead)) {
        const stale = layerBitmaps.get(layerId);
        if (stale) { stale.close(); layerBitmaps.delete(layerId); } // release the held frame too
        return null;
      }
      // Locally-decoded HAP wins (the projector decodes its own); else the streamed frame.
      const lv = layerVideos.get(layerId);
      if (hapLocal && lv && lv.clipId && lv.mode === 'codec' && lv.codec) return lv.codec.canvas;
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
  // Natural aspect (w/h) of what this layer is currently showing, or null when nothing is under the
  // playhead / it isn't measurable yet. Exists so a SURFACE fed by a timeline track can auto-fit its
  // rect the same way a direct VIDEO surface does — contentSource can't answer for LAYER (the
  // timeline owns it, not the content-source registry), so it returned null and LAYER surfaces
  // never adapted at all. Uses the same drawable the compositor draws, so it needs no clip lookup.
  getLayerAspect(layerId?: string): number | null {
    if (!layerId) return null;
    return drawableAspect(this.getLayerDrawable(layerId));
  },
  subscribe(cb: (playhead: number) => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; },
  start(): void {
    if (!raf) {
      originMs = performance.now() - playhead * 1000;
      showOriginMs = performance.now() - showTime * 1000;
      raf = requestAnimationFrame(frame);
    }
  },
};

timeline.start();
