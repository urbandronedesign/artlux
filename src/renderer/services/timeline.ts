import { Timeline, VideoClip, defaultTimeline } from '../types';
import { getBlobUrl, ensureBlobUrl } from './mediaCache';
import * as hapDecode from './hapDecode';
import * as hapGL from './hapGL';
import * as fsm from './stateMachine';
import type { TransportIntent, SmContext } from './stateMachine';

// Per-window video-layer timeline engine. The single source of playback time so React
// never re-renders per frame (mirrors dmxSignal/livePreview). One <video> per layer
// (track); as the playhead crosses clip boundaries the layer video's source is swapped.
// The main window advances the playhead itself; the Scene window runs in `external` mode
// and is driven by the bridged transport.
//
// HAP clips can't be decoded by the browser <video>, so for those we pull the exact frame
// for the playhead from the native decoder (hapDecode) and paint it onto a per-layer canvas.

// A layer's playback state: a browser <video> for normal clips, plus a lazily-created canvas
// fed by the native HAP decoder for HAP clips. `mode` says which is live this frame.
type HapState = { path: string; canvas: HTMLCanvasElement | null; index: number };
type LayerVid = { el: HTMLVideoElement; clipId: string | null; srcPath: string | null; mode: 'video' | 'hap' | null; hap: HapState | null };

const layerVideos = new Map<string, LayerVid>();
// External mirror windows (Scene / projector) don't decode: the main window decodes once
// and streams each layer's frame here as a transferable ImageBitmap (keeps concurrent
// hardware-decode sessions to one — see App.tsx scene/projector frame pumps).
const layerBitmaps = new Map<string, ImageBitmap>();
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

// Is a clip live under the playhead on this layer? (for the FSM 'onClipEnd' trigger)
const clipActive = (layerId: string, t: number): boolean => activeClip(layerId, t) != null;
// Per-frame context handed to the FSM runtime.
const smContext = (): SmContext => ({ markers: data.markers ?? [], clipActive, emit: emitIntent });

const ensureBlob = (path: string): void => { void ensureBlobUrl(path, 'video/mp4'); };

function getLayerVideo(layerId: string): LayerVid {
  let lv = layerVideos.get(layerId);
  if (!lv) {
    const el = document.createElement('video');
    el.muted = true; el.playsInline = true; el.loop = false; el.crossOrigin = 'anonymous';
    lv = { el, clipId: null, srcPath: null, mode: null, hap: null };
    layerVideos.set(layerId, lv);
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

function syncLayer(layerId: string, t: number): void {
  const lv = getLayerVideo(layerId);
  const clip = activeClip(layerId, t);
  if (!clip) {
    if (!lv.el.paused) lv.el.pause();
    lv.clipId = null; lv.mode = null;
    return;
  }

  // HAP clips can't go through the <video>; pull the playhead's frame from the native decoder.
  if (hapDecode.isHapCandidate(clip.path)) {
    const known = hapDecode.isHap(clip.path);
    if (known === undefined) { void hapDecode.ensureOpen(clip.path); return; } // still probing
    if (known) { syncHapLayer(layerId, lv, clip, t); return; } // decode locally (any window)
    // known === false → a non-HAP .mov (e.g. H.264); fall through to the <video> path.
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

function syncHapLayer(layerId: string, lv: LayerVid, clip: VideoClip, t: number): void {
  const info = hapDecode.getInfo(clip.path);
  if (!info) return;
  if (!lv.el.paused) lv.el.pause(); // not using the <video> for this clip
  if (!lv.hap || lv.hap.path !== clip.path) {
    lv.hap = { path: clip.path, canvas: null, index: -1 };
  }
  lv.clipId = clip.id;
  lv.mode = 'hap';
  // Frame index for this playhead position within the clip's source (clamped). Show the best
  // available decoded frame; upload it to the GPU (blocks → compressed texture) when it advances.
  const target = t - clip.start + clip.inPoint;
  const idx = Math.max(0, Math.min(Math.round(target * info.fps), info.frameCount - 1));
  const h = lv.hap;
  const got = hapDecode.getFrame(clip.path, idx);
  if (got && got.index !== h.index) {
    h.canvas = hapGL.uploadFrame(layerId, got.frame);
    h.index = got.index;
  }
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
    // FSM control layer (main window only — mirrors receive the resulting transport via the bridge).
    if (!external) {
      try { fsm.tick(data.stateMachine, playhead, prevPlayhead, smContext()); } catch (e) { console.error('[timeline] fsm error', e); }
    }
    // Main window decodes everything; mirror windows decode only HAP locally (when hapLocal),
    // otherwise they consume streamed frames and skip decoding entirely.
    if (!external || hapLocal) for (const l of data.layers) {
      try { syncLayer(l.id, playhead); } catch (e) { console.error('[timeline] syncLayer error', e); }
    }
    prevPlayhead = playhead;
    subs.forEach(cb => cb(playhead));
  } catch (e) {
    console.error('[timeline] frame error', e);
  }
}

export const timeline = {
  setData(t: Timeline): void {
    data = t;
    if (external) return; // mirror windows don't decode — no blobs / video elements to manage
    // Pre-warm: open HAP clips natively; preload blob URLs for normal clips.
    for (const c of t.clips) {
      if (hapDecode.isHapCandidate(c.path)) void hapDecode.ensureOpen(c.path);
      else ensureBlob(c.path);
    }
    for (const id of [...layerVideos.keys()]) {
      if (!t.layers.find(l => l.id === id)) { const lv = layerVideos.get(id)!; lv.el.pause(); lv.el.removeAttribute('src'); layerVideos.delete(id); hapGL.release(id); }
    }
  },
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
    playhead = clamped;
    originMs = performance.now() - clamped * 1000;
    prevPlayhead = clamped; // don't fire FSM crossings across a deliberate jump
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
  // Fire a manual FSM transition out of the current state (wired to the state-lane buttons).
  triggerSmTransition(id: string): void { if (!external) fsm.triggerManual(data.stateMachine, id, playhead, smContext()); },
  // Store the latest streamed frame for a layer (mirror windows only). Closes the prior
  // bitmap it replaces so transferred frames don't leak.
  setLayerBitmap(layerId: string, bmp: ImageBitmap): void {
    const prev = layerBitmaps.get(layerId);
    if (prev && prev !== bmp) prev.close();
    layerBitmaps.set(layerId, bmp);
  },
  // The live drawable for a layer: a streamed ImageBitmap in mirror windows, else the HAP
  // canvas (HAP clips) or the decoding <video>. Null when nothing is under the playhead / ready.
  getLayerDrawable(layerId?: string): HTMLVideoElement | HTMLCanvasElement | ImageBitmap | null {
    if (!layerId) return null;
    if (external) {
      // Locally-decoded HAP wins (the projector decodes its own); else the streamed frame.
      const lv = layerVideos.get(layerId);
      if (hapLocal && lv && lv.mode === 'hap' && lv.hap && lv.hap.index >= 0) return lv.hap.canvas;
      return layerBitmaps.get(layerId) ?? null;
    }
    const lv = layerVideos.get(layerId);
    if (!lv || !lv.clipId) return null;
    if (lv.mode === 'hap') return lv.hap && lv.hap.index >= 0 ? lv.hap.canvas : null;
    return lv.mode === 'video' && lv.el.readyState >= 2 ? lv.el : null;
  },
  subscribe(cb: (playhead: number) => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; },
  start(): void { if (!raf) { originMs = performance.now() - playhead * 1000; raf = requestAnimationFrame(frame); } },
};

timeline.start();
