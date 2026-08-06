// Waveform peaks + the source-duration probe for audio clips on a lane.
//
// BOTH ARE CORE, AND BOTH USE THE BROWSER, NOT THE NATIVE ENGINE — deliberately.
// `audioClient.loadClip()` (the only thing that knows a file's real duration in the native engine) lives
// in the AUDIO PLUGIN, and core must not reach into a plugin. AssetEntry.durationSec is not an option
// either: it is never populated on import (projectFolder's copyIntoAssets mints {id,name,type,path,size,
// addedAt} — no durationSec).
//
// So core probes with the browser, exactly as Timeline.tsx already probes a dropped VIDEO's duration with
// an offscreen <video> — and the native engine still loads the file ITSELF for playback (the audio
// driver's syncLoaded → audioClient.loadClip). Core decides WHERE the clip sits; the engine decides how
// it sounds. Chromium decodes wav/flac/ogg/mp3 natively; mimeForPath (services/mediaCache.ts) maps them.
import { resolveMediaUrl } from '../../services/mediaCache';
import * as bootGate from '../../services/bootGate';

// ⚠ A WAVEFORM MUST NEVER PULL A WHOLE VIDEO INTO MEMORY.
//
// `decodeAudioData` needs every byte of its source, so this is the one media path that still
// materialises a whole file — which for a clip's own soundtrack meant decoding the VIDEO. Measured on
// a real show: a 1 GB HAP `.mov` read whole in 2.3 s, main's RSS from 125 MB to 3.7 GB (the size of
// the whole assets folder), the main process's event loop stalled 1.7 s, and — because every HAP
// frame decode is answered on that same thread — the playback ring starved for its first ten seconds.
// All to draw a waveform nobody had asked to see yet.
//
// Streaming (artlux-media://) removed the IPC copy and the permanently-retained Blob, but NOT the
// fundamental cost: the bytes still have to arrive to be decoded. So the container guard below is as
// load-bearing as it ever was.
//
// A video's sound is not core's to decode anyway: the audio plugin CONFORMS it (main-side demux → a
// cached WAV) precisely because Chromium's ffmpeg refuses a HAP `.mov` outright (docs/CODECS.md). So
// core decodes peaks for AUDIO CONTAINERS only; a video source gets no waveform rather than a
// gigabyte of I/O. Nothing else changes — the clip still plays, still trims, still shows its name.
const AUDIO_CONTAINER = /\.(wav|aiff?|flac|ogg|oga|mp3|m4a|aac)$/i;

const PEAK_BUCKETS = 2048;                       // fixed resolution; the lane downsamples to its pixel width
const peaks = new Map<string, Float32Array>();   // path → normalized |peak| per bucket
const durs = new Map<string, number>();          // path → the SOURCE's true length (s), straight off the decode
const pending = new Set<string>();               // decodes in flight (dedupe — a lane re-renders constantly)
const failed = new Set<string>();                // don't retry-storm an undecodable source on every render
const attempts = new Map<string, number>();      // see MAX_ATTEMPTS
const retryAfter = new Map<string, number>();    // path → the wall-clock ms before which a retry is NOT an attempt
const subs = new Set<() => void>();

// ⚠ THE ORIGINAL REASON FOR THIS RETRY IS DEAD. It said: `ensureBlobUrl` does not wait on a concurrent
// load, it returns `undefined` the moment another caller is already reading the same path
// (`if (loading.has(path)) return undefined`) — so on a drop, where we probe the duration and render the
// lane in the same tick, losing that race was the NORMAL case. mediaCache now JOINS the in-flight read
// and returns the same promise to every caller, so that race no longer exists.
//
// THE RETRY STAYS ANYWAY, on a narrower and still-true claim: a read can fail for ordinary reasons (a
// file being written, a network volume blinking, a permission hiccup), and treating one failure as
// "undecodable" blacklists a good file for the session — flat waveform, and far worse
// `sourceDurationFor` stuck at null, which pins the right-trim cap to the clip's current duration.
// A bounded retry costs nothing when reads succeed and rescues the transient case. Keep it; just do
// not repeat the dead premise to justify it.
//
// ⚠ THE BUDGET MUST BE SPENT IN WALL-CLOCK TIME, NOT IN FRAMES. `ensurePeaks` can be reached from EVERY
// POINTERMOVE OF A DRAG (Timeline.tsx's onAudioDragMove → sourceDurationFor, on any clip with no
// `sourceDuration` — i.e. every bed clip authored before this wave). `pending` dedupes only while a read
// is in flight, and each failed read clears it in its `finally` — so a caller firing at 60 Hz would
// simply re-enter on the next frame. Six frames (~100 ms) of one drag would burn the entire budget
// against a transient concurrent read and `failed.add(path)` PERMANENTLY: flat waveform for the session,
// `sourceDurationFor` pinned to null, and the right-trim cap pinned to the clip's current duration.
// Exactly the failure the retry was written to avoid, re-entered through the drag path.
//
// So a retry serves a COOLDOWN: six attempts span ≥ 2.5 s of real time, which a concurrent mediaCache
// read finishes inside many times over — while a genuinely unreadable path still gives up after six, and
// still cannot storm IPC (the cooldown check runs before `pending.add`, so the frames in between cost one
// Map lookup and no IPC at all).
//
// ⚠ AND THE RETRY MUST DRIVE ITSELF — A COOLDOWN NOBODY WAKES UP IS JUST A PERMANENT FAILURE WITH A
// FRIENDLY NAME. DO NOT remove the setTimeout below on the theory that "some render will come along and
// call us again". IT WILL NOT. `Wave` memoizes its call on [path, inPoint, duration, sourceDuration,
// widthPx, peakTick]; for a clip sitting still NONE of those move, and `peakTick` is bumped by `notify()`,
// which fires on SUCCESSFUL DECODE ONLY. So after a `!url` arm sets a cooldown, no render recomputes, no
// tick advances, and nothing re-enters ensurePeaks — the flat waveform and the pinned trim cap would last
// the whole session (only an unrelated trim/zoom, or a drag, would happen to pump it). The timer makes
// the retry independent of whether anything renders at all. It is bounded by MAX_ATTEMPTS, so an
// unreadable path still cannot storm IPC.
const MAX_ATTEMPTS = 6;
const RETRY_COOLDOWN_MS = 500;

// A decode landing must repaint the lanes. Nothing else would: Timeline.tsx's ~10 Hz `autoPlayhead`
// setState bails out when the transport is paused (same value in, no re-render), so a waveform decoded
// while paused would not appear until some unrelated edit happened to re-render. One notify per decode,
// not per frame — this is not a render loop.
export function subscribePeaks(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}
const notify = () => { for (const cb of subs) { try { cb(); } catch { /* a bad subscriber must not break a decode */ } } };

// Peaks asked for while the cold-start gate held. Kicked once it arms — see ensurePeaks.
const deferred = new Set<string>();
bootGate.subscribe((p) => {
  if (p.booting || deferred.size === 0) return;
  const paths = [...deferred];
  deferred.clear();
  for (const path of paths) ensurePeaks(path);
  notify();
});

// ⚠ OfflineAudioContext, NOT AudioContext. A live AudioContext OPENS AN OUTPUT STREAM ON THE DEFAULT
// DEVICE — and this app's entire audio path is a native JUCE engine driving that same device
// (audioClient.configure({ deviceType, deviceName, channels, sampleRate, bufferSize, mode, layout })).
// On a rig where the engine takes the device exclusively (or via ASIO), a stray Chromium output handle
// can make the engine's configure() fail to open it — and the failure surfaces as NO AUDIO AT ALL, with
// the waveforms drawing perfectly. Peaks need decoding, not output, and decodeAudioData lives on
// BaseAudioContext, so an offline context has it. Zero devices.
let ctx: OfflineAudioContext | null = null;      // lazily created: one per decode would be wasteful

// Kick off a decode for `path` if we don't have it. Fire-and-forget.
export function ensurePeaks(path: string): void {
  if (!path || peaks.has(path) || pending.has(path) || failed.has(path)) return;
  // Audio containers only — see AUDIO_CONTAINER. `failed` (not a silent return) so the lane asks once
  // and never again, and so sourceDurationFor stops retrying a file it will never decode here.
  if (!AUDIO_CONTAINER.test(path)) { failed.add(path); return; }
  // A COSMETIC DECODE NEVER COMPETES WITH A SHOW STARTING. While the cold-start gate holds, the whole
  // machine is trying to get the first frame on stage (services/bootGate); a waveform can wait the two
  // seconds. `deferred` + the subscription below is what brings it back: a lane asks from its RENDER,
  // and a stopped timeline does not repaint on its own.
  if (bootGate.isBooting()) { deferred.add(path); return; }
  // A retry inside its cooldown is a WAIT, not an attempt: cost it nothing and take no IPC. This runs
  // before `pending.add` precisely so a 60 Hz caller falls straight through here (see RETRY_COOLDOWN_MS).
  const due = retryAfter.get(path);
  if (due !== undefined && Date.now() < due) return;
  pending.add(path);
  void (async () => {
    try {
      // decodeAudioData genuinely needs the whole file in hand, so this is the one media path that
      // still materialises all the bytes. What it no longer does is keep them: fetching over
      // artlux-media:// yields an ArrayBuffer the GC reclaims after the decode, where ensureBlobUrl
      // handed back a Blob URL that lived in mediaCache for the session with nothing to revoke it.
      const res = await fetch(resolveMediaUrl(path));
      if (!res.ok) {
        // A read can fail transiently (a file being written, a network volume blinking). Treating one
        // failure as "undecodable" would blacklist a good file for the session — see MAX_ATTEMPTS.
        const n = (attempts.get(path) ?? 0) + 1;
        attempts.set(path, n);
        if (n >= MAX_ATTEMPTS) { failed.add(path); return; }
        // The cooldown blocks re-entry until `due`; THIS TIMER IS THE ONLY THING THAT LIFTS IT AND TRIES
        // AGAIN (see RETRY_COOLDOWN_MS — no render path will). `retryAfter` is still set, so a 60 Hz drag
        // caller arriving in the meantime falls through at zero cost instead of racing us.
        retryAfter.set(path, Date.now() + RETRY_COOLDOWN_MS);
        setTimeout(() => { retryAfter.delete(path); ensurePeaks(path); }, RETRY_COOLDOWN_MS);
        return;
      }
      const buf = await res.arrayBuffer();
      ctx ??= new OfflineAudioContext(1, 1, 44100);
      const audio = await ctx.decodeAudioData(buf);
      // THE SOURCE DURATION, FOR FREE. Every bed clip minted before this wave has NO `sourceDuration`
      // (AudioBedPanel.addClip never wrote one), and sanitizeAudioClip deliberately does not fabricate one.
      // Without it the lane's trim cap would be unbounded and the waveform would re-squeeze the whole file
      // into the visible window on every trim. The decode already knows the answer — cache it, and require
      // NO migration write to anyone's project on load. (decodeAudioData resamples to the context's rate;
      // the duration in SECONDS is preserved.)
      durs.set(path, audio.duration);
      const ch = audio.getChannelData(0);
      const per = Math.max(1, Math.floor(ch.length / PEAK_BUCKETS));
      const out = new Float32Array(PEAK_BUCKETS);
      for (let b = 0; b < PEAK_BUCKETS; b++) {
        let m = 0;
        const s = b * per, e = Math.min(ch.length, s + per);
        for (let i = s; i < e; i++) { const v = Math.abs(ch[i]); if (v > m) m = v; }
        out[b] = m;
      }
      peaks.set(path, out);
      // The decode landed — retire this path's retry bookkeeping rather than leaving a spent budget
      // lying around. (`peaks.has(path)` short-circuits ensurePeaks from here on, so this is hygiene
      // rather than correctness — but a half-spent budget surviving a SUCCESS is exactly the kind of
      // state that makes the next bug in here invisible.)
      attempts.delete(path);
      retryAfter.delete(path);
      notify();
    } catch {
      failed.add(path);   // undecodable / missing — the lane draws a flat bar; the driver reports the load failure
    } finally {
      pending.delete(path);
    }
  })();
}

// The SOURCE's true length, recovered from the decode. Null while decoding / undecodable.
//
// This is the trim cap and the waveform's time base for a clip that carries NO `sourceDuration` — i.e.
// every clip on every bed authored before this wave. The alternative (a load-time backfill) would write to
// the user's document on open, which this codebase does not do.
export function sourceDurationFor(path: string): number | null {
  const d = durs.get(path);
  if (d === undefined) { ensurePeaks(path); return null; }
  return d > 0 ? d : null;
}

// The cached peaks, downsampled to AT MOST `buckets`. Null while decoding (or if it failed) — draw a
// flat bar.
//
// NOTE WHAT THE LANE ACTUALLY ASKS FOR, so nobody "optimizes" this into a lie: `Wave` passes
// PEAK_BUCKETS and therefore always takes the `buckets >= full.length` short-circuit — it wants the FULL
// array and resamples it itself. It has to: a clip shows the window [inPoint, inPoint + duration) of the
// source, and downsampling to the clip's pixel width HERE would average across the whole file, not
// across that window. So this downsample path is unused by the only caller today; it is kept because it
// is the correct general answer for a caller that wants fewer buckets than the cache holds (an overview
// strip, a thumbnail), and it is the reason the parameter exists at all.
export function peaksFor(path: string, buckets: number): Float32Array | null {
  const full = peaks.get(path);
  if (!full) { ensurePeaks(path); return null; }
  if (buckets >= full.length) return full;
  const out = new Float32Array(buckets);
  const per = full.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    const s = Math.floor(b * per), e = Math.max(s + 1, Math.floor((b + 1) * per));
    for (let i = s; i < e && i < full.length; i++) if (full[i] > m) m = full[i];
    out[b] = m;
  }
  return out;
}

// A dropped file's real length, for the clip's initial `duration`/`sourceDuration`. Resolves null when the
// browser can't decode it (an .aiff, say) — the caller then places a default-length clip the user can trim,
// which is strictly better than refusing the drop.
export function probeAudioDuration(path: string): Promise<number | null> {
  return (async () => {
    try {
      // `preload='metadata'` over the streaming scheme reads the header and stops — this used to pull
      // an entire album-length file over IPC to learn one number.
      return await new Promise<number | null>((resolve) => {
        const el = document.createElement('audio');
        el.preload = 'metadata';
        el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
        el.onerror = () => resolve(null);
        el.src = resolveMediaUrl(path);
      });
    } catch { return null; }
  })();
}
