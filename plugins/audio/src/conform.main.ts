// MAIN-PROCESS AUDIO CONFORM — a video file's soundtrack, decoded ONCE into a plain WAV the JUCE engine
// can already open, cached per machine.
//
// THE ENGINE CANNOT OPEN AN MP4. `formats()` (native/audio-engine/src/engine.cpp) registers WAV/AIFF/FLAC/
// Ogg and nothing that reads an ISO-BMFF container, so `loadClip("movie.mp4")` answers "no decoder for …".
// There were two ways to close that: teach the engine to stream MP4 (Media Foundation on the audio read
// thread), or decode once to a WAV and change nothing in the engine at all. This is the second, and it is
// the better trade FOR A SHOW: the import pays the cost, and what plays in the venue at 3am is a WAV — no
// decoder on the read thread, and a drift re-lock (plugin.renderer.ts, playClip at a new offset) is a file
// seek rather than a seek plus a decode-and-discard.
//
// WHAT DECODES WHAT, and why this is not simply "hand the file to Chromium" (measured — see
// plans/video-clip-audio.md §WS0):
//
//   PCM  (in24/sowt/twos/…)  → RIGHT HERE, no decoder. This is the HAP `.mov` case, and Chromium REFUSES
//                              those files (EncodingError). The format ArtLux exists to play would
//                              otherwise have been the one format with no sound.
//   AAC  (mp4a)              → the renderer, via WebCodecs AudioDecoder, streamed through the pull
//                              protocol below (conformFrames → conformAppend → conformFinish).
//   anything else            → the renderer's last-resort whole-file decodeAudioData.
//
// Nothing here reads a whole movie: movDemux returns byte ranges, and a HAP master's audio is ~2% of it.

import { createHash } from 'node:crypto';
import { app } from 'electron';
import {
  closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { demuxAudio, type AudioTrack } from './movDemux';
import {
  abortWav, closeWav, conformPcm, isPcmCodec, openWav, writeWav, type WavSink,
} from './wavPcm';

/** Containers worth demuxing. Anything else is not a video file we conform. */
const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm)$/i;
export const isVideoContainer = (p: string): boolean => VIDEO_EXT.test(p);

const cacheDir = (): string => {
  const dir = join(app.getPath('userData'), 'audio-conform');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * The cache key is the SOURCE, not its name: path + mtime + size. Re-encode a file in place and it
 * re-conforms; move a project and an untouched file does not. (Keying on the path alone would go on
 * playing last week's audio out of a file that has since been replaced — silently, and forever.)
 */
function cacheKey(src: string): string | null {
  try {
    const st = statSync(src);
    return createHash('sha1').update(`${src} ${st.mtimeMs} ${st.size}`).digest('hex').slice(0, 24);
  } catch { return null; }
}

// A source with no audio at all is a NORMAL answer (one of the WS0 HAP samples is picture-only) and it must
// be REMEMBERED, or every project load re-demuxes every silent file forever. A zero-byte `.none` marker
// beside the wav says "asked, answered", and the same key invalidates it.
const wavPathFor = (key: string) => join(cacheDir(), `${key}.wav`);
const nonePathFor = (key: string) => join(cacheDir(), `${key}.none`);
const markNone = (key: string): void => { try { closeSync(openSync(nonePathFor(key), 'w')); } catch { /* best effort */ } };

// ── The renderer-driven branch (AAC + last resort) ─────────────────────────────────────────────────
// A job exists only while the renderer is decoding. Main holds the file handle and the wav sink; the
// renderer pulls encoded frames and pushes back finished 16-bit PCM. Every step is an `invoke`, never a
// `send`: an awaited round trip is both ordering and backpressure, and a fire-and-forget append could
// otherwise overtake the finish on a different IPC channel.
interface Job { src: string; key: string; fd: number; track: AudioTrack | null; sink: WavSink | null; cursor: number }
const jobs = new Map<string, Job>();
let jobSeq = 0;

/** How much encoded audio one pull returns. Bounded, so a two-hour film never materialises in one message. */
const PULL_BYTES = 4 * 1024 * 1024;

export interface ConformStart {
  kind: 'ready' | 'aac' | 'raw' | 'none';
  wavPath?: string;            // 'ready' — already conformed (cache hit, or PCM done inline)
  token?: string;              // 'aac' | 'raw'
  asc?: Uint8Array | null;     // 'aac' — the AudioSpecificConfig for AudioDecoder's `description`
  sampleRate?: number;
  channels?: number;
  durationSec?: number;
}

/**
 * Ask for a source's conform. Answers a cache hit immediately; conforms PCM inline (fast, no IPC, no
 * decoder); hands anything else back to the renderer as a job.
 */
export function conformStart(src: string): ConformStart {
  if (!src || !isVideoContainer(src)) return { kind: 'none' };
  const key = cacheKey(src);
  if (!key) return { kind: 'none' };
  const wav = wavPathFor(key);
  if (existsSync(wav)) return { kind: 'ready', wavPath: wav };
  if (existsSync(nonePathFor(key))) return { kind: 'none' };

  const track = demuxAudio(src);
  if (!track) {
    // No audio track — OR a container this demuxer does not read (mkv/webm, fragmented mp4). The first is
    // final; the second deserves the renderer's whole-file fallback before the source is written off. So
    // only a *parsed* ISO file gets the marker, and everything else is asked once more, the slow way.
    if (/\.(mp4|m4v|mov)$/i.test(src)) { markNone(key); return { kind: 'none' }; }
    return { kind: 'raw', token: startJob(src, key, null) };
  }
  if (isPcmCodec(track.codec)) {
    const done = conformPcm(src, track, wav);
    if (done) {
      // Worth a line: this is the branch that makes a HAP master audible, and the gain it chose is the
      // one number that explains the conform's level if anyone ever asks why a clip sounds quieter than
      // the file does elsewhere. Once per source, never per play.
      console.log(`[audio] conformed ${track.codec} ${track.channels}ch ${track.durationSec.toFixed(1)}s` +
        ` peak=${done.peak.toFixed(3)} gain=${done.gain.toFixed(3)} clamped=${done.clamped} → ${done.path}`);
      return { kind: 'ready', wavPath: done.path };
    }
    markNone(key);
    return { kind: 'none' };
  }
  if (track.codec === 'mp4a' && track.asc) {
    return {
      kind: 'aac', token: startJob(src, key, track), asc: track.asc,
      sampleRate: Math.round(track.sampleRate), channels: track.channels, durationSec: track.durationSec,
    };
  }
  return { kind: 'raw', token: startJob(src, key, track) };
}

function startJob(src: string, key: string, track: AudioTrack | null): string {
  const token = `c${++jobSeq}`;
  let fd = -1;
  if (track) { try { fd = openSync(src, 'r'); } catch { fd = -1; } }
  jobs.set(token, { src, key, fd, track, sink: null, cursor: 0 });
  return token;
}

/** The source path behind a token — the 'raw' branch needs it to read the whole file itself. */
export const conformSource = (token: string): string | null => jobs.get(token)?.src ?? null;

/** Pull the next bounded run of ENCODED frames: the bytes, plus each frame's size so the renderer can cut them. */
export function conformFrames(token: string): { bytes: Uint8Array; sizes: number[]; done: boolean } {
  const job = jobs.get(token);
  if (!job || job.fd < 0 || !job.track) return { bytes: new Uint8Array(0), sizes: [], done: true };
  const parts: Buffer[] = [];
  const sizes: number[] = [];
  let total = 0;
  while (job.cursor < job.track.ranges.length && total < PULL_BYTES) {
    const r = job.track.ranges[job.cursor++];
    const buf = Buffer.alloc(r.size);
    readSync(job.fd, buf, 0, r.size, r.offset);
    parts.push(buf);
    total += r.size;
    for (let i = 0; i < r.count; i++) {
      sizes.push(job.track.sampleSizes ? job.track.sampleSizes[r.firstSample + i] : job.track.uniformSize);
    }
  }
  return { bytes: new Uint8Array(Buffer.concat(parts)), sizes, done: job.cursor >= job.track.ranges.length };
}

/**
 * Rewind a job's frame cursor to the top of the track. The renderer's AAC branch decodes TWICE — once to
 * measure the fold's peak, once to write — and this is how the second pass gets the same frames back
 * without re-demuxing or re-opening anything.
 */
export function conformRewind(token: string): void {
  const job = jobs.get(token);
  if (job) job.cursor = 0;
}

/** Append decoded 16-bit interleaved PCM. The first call fixes the wav's format. */
export function conformAppend(token: string, pcm: Int16Array, channels: number, rate: number): boolean {
  const job = jobs.get(token);
  if (!job) return false;
  if (!job.sink) job.sink = openWav(wavPathFor(job.key), channels, rate);
  writeWav(job.sink, pcm);
  return true;
}

/** Finish (or abandon) a job. Returns the wav path when anything was actually written. */
export function conformFinish(token: string, ok: boolean): string | null {
  const job = jobs.get(token);
  if (!job) return null;
  jobs.delete(token);
  if (job.fd >= 0) { try { closeSync(job.fd); } catch { /* already gone */ } }
  if (!job.sink) {
    if (!ok) markNone(job.key); // the renderer could not decode it either — stop asking
    return null;
  }
  if (!ok || job.sink.bytes === 0) { abortWav(job.sink); markNone(job.key); return null; }
  return closeWav(job.sink);
}

/**
 * Trim the cache to a byte ceiling, most-recently-touched kept. Called after a conform lands, never on a
 * hot path. A conform is derivable — deleting one costs a re-decode, never data.
 */
export function pruneCache(maxBytes: number): void {
  try {
    const dir = cacheDir();
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.wav'))
      .map((f) => { const p = join(dir, f); const s = statSync(p); return { p, size: s.size, at: s.mtimeMs }; })
      .sort((a, b) => b.at - a.at);
    let total = 0;
    for (const f of files) {
      total += f.size;
      if (total > maxBytes) { try { unlinkSync(f.p); } catch { /* held open; next sweep */ } }
    }
  } catch { /* the cache is best-effort by definition */ }
}
