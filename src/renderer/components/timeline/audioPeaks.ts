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
import { ensureBlobUrl, mimeForPath } from '../../services/mediaCache';

const PEAK_BUCKETS = 2048;                       // fixed resolution; the lane downsamples to its pixel width
const peaks = new Map<string, Float32Array>();   // path → normalized |peak| per bucket
const durs = new Map<string, number>();          // path → the SOURCE's true length (s), straight off the decode
const pending = new Set<string>();               // decodes in flight (dedupe — a lane re-renders constantly)
const failed = new Set<string>();                // don't retry-storm an undecodable source on every render
const attempts = new Map<string, number>();      // see MAX_ATTEMPTS
const retryAfter = new Map<string, number>();    // path → the wall-clock ms before which a retry is NOT an attempt
const subs = new Set<() => void>();

// ensureBlobUrl DOES NOT WAIT ON A CONCURRENT LOAD — it returns `undefined` the moment another caller is
// already reading the same path (mediaCache: `if (loading.has(path)) return undefined`). On a drop we probe
// the duration and render the lane in the same tick, so that race is the NORMAL case, not an exotic one.
// Treating a missing url as "undecodable" would therefore blacklist a perfectly good file forever: flat
// waveform, and — far worse — `sourceDurationFor` stuck at null, which pins the right-trim cap to the
// clip's current duration for the rest of the session. So a missing url is RETRIED, and only a bounded
// number of times, so a genuinely unreadable path cannot storm IPC on every render either.
//
// ⚠ THE BUDGET MUST BE SPENT IN WALL-CLOCK TIME, NOT IN FRAMES — OR IT REINTRODUCES THE VERY BUG IT
// EXISTS TO PREVENT. `ensurePeaks` is reached from RENDER (`Wave`) and from EVERY POINTERMOVE OF A DRAG
// (Timeline.tsx's onAudioDragMove → sourceDurationFor, on any clip with no `sourceDuration` — i.e. every
// bed clip authored before this wave). `pending` dedupes only while a read is in flight, and each failed
// read clears it in its `finally` — so a caller firing at 60 Hz simply re-enters on the next frame. Six
// frames (~100 ms) of one drag would burn the entire budget against a transient concurrent read and
// `failed.add(path)` PERMANENTLY: flat waveform for the session, `sourceDurationFor` pinned to null, and
// the right-trim cap pinned to the clip's current duration. Exactly the failure the retry was written to
// avoid, re-entered through the drag path.
//
// So a retry serves a COOLDOWN. Six attempts now span ≥ 2.5 s of real time, which a concurrent
// mediaCache read finishes inside many times over — while a genuinely unreadable path still gives up
// after six, and still cannot storm IPC (the cooldown check runs before `pending.add`, so the frames in
// between cost one Map lookup and no IPC at all).
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

// ⚠ OfflineAudioContext, NOT AudioContext. A live AudioContext OPENS AN OUTPUT STREAM ON THE DEFAULT
// DEVICE — and this app's entire audio path is a native JUCE engine driving that same device
// (audioClient.configure(channels, mode, layout)). On a rig where the engine takes the device exclusively
// (or via ASIO), a stray Chromium output handle can make the engine's configure() fail to open it — and
// the failure surfaces as NO AUDIO AT ALL, with the waveforms drawing perfectly. Peaks need decoding, not
// output, and decodeAudioData lives on BaseAudioContext, so an offline context has it. Zero devices.
let ctx: OfflineAudioContext | null = null;      // lazily created: one per decode would be wasteful

// Kick off a decode for `path` if we don't have it. Fire-and-forget.
export function ensurePeaks(path: string): void {
  if (!path || peaks.has(path) || pending.has(path) || failed.has(path)) return;
  // A retry inside its cooldown is a WAIT, not an attempt: cost it nothing and take no IPC. This runs
  // before `pending.add` precisely so a 60 Hz caller falls straight through here (see RETRY_COOLDOWN_MS).
  const due = retryAfter.get(path);
  if (due !== undefined && Date.now() < due) return;
  pending.add(path);
  void (async () => {
    try {
      const url = await ensureBlobUrl(path, mimeForPath(path));
      if (!url) {
        // Not a failure yet — most likely a concurrent read of the same path (see MAX_ATTEMPTS).
        const n = (attempts.get(path) ?? 0) + 1;
        attempts.set(path, n);
        if (n >= MAX_ATTEMPTS) failed.add(path);
        else retryAfter.set(path, Date.now() + RETRY_COOLDOWN_MS);
        return;
      }
      const buf = await (await fetch(url)).arrayBuffer();
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
      const url = await ensureBlobUrl(path, mimeForPath(path));
      if (!url) return null;
      return await new Promise<number | null>((resolve) => {
        const el = document.createElement('audio');
        el.preload = 'metadata';
        el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
        el.onerror = () => resolve(null);
        el.src = url;
      });
    } catch { return null; }
  })();
}
