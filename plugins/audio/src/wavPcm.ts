// The PURE half of the conform: WAV writing, channel folding, and uncompressed-PCM conversion.
//
// Split out of conform.main.ts deliberately — that module reaches for `electron`'s `app.getPath`, and
// everything here is the part worth testing on its own, with `node --experimental-strip-types`, against
// real media and no app. (Same discipline as the rest of the repo: there is no unit runner, so the logic
// that can be exercised standalone is kept where a throwaway script can reach it.)

import { closeSync, existsSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import type { AudioTrack } from './movDemux';
import { gainFor, newFoldStats, outChannelsFor, toInt16, measureFold } from './audioFold';

// ── WAV writing ────────────────────────────────────────────────────────────────────────────────────
// 16-bit PCM at the source's NATIVE sample rate. Not resampled to 48 k on purpose: AudioTransportSource is
// constructed with the reader's own rate (engine.cpp, `setSource(…, rawReader->sampleRate)`) and resamples
// at playback for free — a resampler here would be code to maintain and a generation of quality to lose
// for nothing.

export interface WavSink { fd: number; tmp: string; final: string; channels: number; rate: number; bytes: number }

export function openWav(final: string, channels: number, rate: number): WavSink {
  const tmp = `${final}.part`;
  const fd = openSync(tmp, 'w');
  writeSync(fd, Buffer.alloc(44)); // header patched in closeWav, once the length is known
  return { fd, tmp, final, channels, rate, bytes: 0 };
}

export function writeWav(sink: WavSink, pcm: Int16Array): void {
  if (!pcm.length) return;
  const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  writeSync(sink.fd, buf);
  sink.bytes += buf.length;
}

/** Patch the RIFF header, then ATOMICALLY rename into place — a reader never sees a half-written wav. */
export function closeWav(sink: WavSink): string {
  const h = Buffer.alloc(44);
  const bytesPerFrame = sink.channels * 2;
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + sink.bytes, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);                                  // PCM
  h.writeUInt16LE(sink.channels, 22);
  h.writeUInt32LE(sink.rate, 24);
  h.writeUInt32LE(sink.rate * bytesPerFrame, 28);          // byte rate
  h.writeUInt16LE(bytesPerFrame, 32);                      // block align
  h.writeUInt16LE(16, 34);                                 // bits
  h.write('data', 36, 'latin1'); h.writeUInt32LE(sink.bytes, 40);
  writeSync(sink.fd, h, 0, 44, 0);
  closeSync(sink.fd);
  try { if (existsSync(sink.final)) unlinkSync(sink.final); } catch { /* replaced by the rename anyway */ }
  renameSync(sink.tmp, sink.final);
  return sink.final;
}

export function abortWav(sink: WavSink): void {
  try { closeSync(sink.fd); } catch { /* already closed */ }
  try { if (existsSync(sink.tmp)) unlinkSync(sink.tmp); } catch { /* nothing to clean */ }
}

// ── Uncompressed sources ───────────────────────────────────────────────────────────────────────────
/**
 * The uncompressed fourccs. Note what this map does NOT decide: BYTE ORDER. `in24` is big-endian per the
 * QuickTime spec and the WS1a HAP master stores it little-endian, flagged by an `enda` atom — so the
 * reader is chosen from what movDemux READ OUT OF THE FILE (bits/float/endianness), and the fourcc only
 * says how wide a sample is and whether we can read it at all. Getting this wrong is not subtle: the
 * byte-swapped reading of that master measures a 4.8 dB crest factor, i.e. full-scale hash, where the
 * correct one is a near-silent movie opening at 15 dB.
 */
const PCM_WIDTH: Record<string, number> = {
  'sowt': 2, 'twos': 2, 'in24': 3, 'in32': 4, 'fl32': 4, 'fl64': 8, 'raw ': 1, 'NONE': 1, 'lpcm': 0,
};

export const isPcmCodec = (codec: string): boolean => codec in PCM_WIDTH;

type PcmReader = (buf: Buffer, byteOffset: number) => number;

/** Bytes-per-sample and a reader, from the format the container actually declares. */
export function pcmReaderFor(track: AudioTrack): { bytes: number; read: PcmReader } | null {
  // 'lpcm' (a v2 sample entry) describes itself entirely through bits/float/endianness, so width comes
  // from `bitsPerSample`; the fixed-fourcc formats carry their width in the table.
  const bytes = PCM_WIDTH[track.codec] || Math.ceil(track.bitsPerSample / 8);
  const le = track.littleEndian;
  if (track.pcmFloat) {
    if (bytes === 4) return { bytes, read: le ? (b, o) => b.readFloatLE(o) : (b, o) => b.readFloatBE(o) };
    if (bytes === 8) return { bytes, read: le ? (b, o) => b.readDoubleLE(o) : (b, o) => b.readDoubleBE(o) };
    return null;
  }
  if (track.pcmUnsigned && bytes === 1) return { bytes, read: (b, o) => (b[o] - 128) / 128 };
  switch (bytes) {
    case 1: return { bytes, read: (b, o) => b.readInt8(o) / 128 };
    case 2: return { bytes, read: le ? (b, o) => b.readInt16LE(o) / 32768 : (b, o) => b.readInt16BE(o) / 32768 };
    // 24-bit: assemble into the TOP three bytes of a 32-bit word so the sign extends for free.
    case 3: return {
      bytes,
      read: le
        ? (b, o) => ((b[o + 2] << 24) | (b[o + 1] << 16) | (b[o] << 8)) / 2147483648
        : (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8)) / 2147483648,
    };
    case 4: return { bytes, read: le ? (b, o) => b.readInt32LE(o) / 2147483648 : (b, o) => b.readInt32BE(o) / 2147483648 };
    default: return null;
  }
}

/**
 * Convert an uncompressed track straight to WAV, reading ONLY the audio byte ranges movDemux found. No
 * decoder is involved and none exists to fail — which is why the HAP `.mov` case, the one Chromium refused
 * outright, is the simplest path in this file.
 */
export interface ConformResult { path: string; peak: number; gain: number; clamped: number; frames: number }

export function conformPcm(src: string, track: AudioTrack, out: string): ConformResult | null {
  const fmt = pcmReaderFor(track);
  if (!fmt || !fmt.bytes || !track.channels || !track.sampleRate) return null;
  const ch = track.channels;
  const outCh = outChannelsFor(ch);
  const frameBytes = fmt.bytes * ch;
  if (!frameBytes) return null;

  const fd = openSync(src, 'r');
  // TWO PASSES, and only for a source that can actually overflow. Measuring costs a second read of ~2% of
  // the file (movDemux gives ranges, not the movie) and buys a downmix that provably never clips — paid
  // once, at import, for a file that will be played in a venue for the next year. A stereo or mono source
  // folds to itself and cannot exceed unity, so it skips the measure pass entirely.
  const eachRange = (fn: (flat: Float32Array, frames: number) => void): void => {
    for (const r of track.ranges) {
      if (r.size <= 0) continue;
      const buf = Buffer.alloc(r.size);
      const got = readSync(fd, buf, 0, r.size, r.offset);
      const frames = Math.floor(got / frameBytes);
      if (frames <= 0) continue;
      const flat = new Float32Array(frames * ch);
      for (let i = 0, o = 0; i < frames * ch; i++, o += fmt.bytes) flat[i] = fmt.read(buf, o);
      fn(flat, frames);
    }
  };

  const measure = newFoldStats();
  const sink = openWav(out, outCh, Math.round(track.sampleRate));
  try {
    if (ch > 2) eachRange((flat, frames) => { measureFold(flat, ch, frames, measure); });
    const gain = gainFor(measure.peak);
    const stats = newFoldStats();
    eachRange((flat, frames) => { writeWav(sink, toInt16(flat, ch, frames, outCh, gain, stats)); });
    closeSync(fd);
    if (sink.bytes <= 0) { abortWav(sink); return null; }
    return { path: closeWav(sink), peak: measure.peak || stats.peak, gain, clamped: stats.clamped, frames: stats.frames };
  } catch {
    abortWav(sink);
    try { closeSync(fd); } catch { /* already closed */ }
    return null;
  }
}
