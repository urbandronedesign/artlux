// MAIN-PROCESS ISO-BMFF / QuickTime demuxer — the AUDIO track only, metadata only.
//
// WHY THIS EXISTS AT ALL, when Chromium is sitting right there with a full ffmpeg in it: it was measured,
// and Chromium declines the file that matters most. `decodeAudioData` over a whole HAP `.mov` fails with
// EncodingError (WS0, plans/video-clip-audio.md) — so the format ArtLux exists to play would have been the
// one format with no sound. It also reads the whole file to find the audio: 1048 MB of HAP master to reach
// 24 MB of PCM, and 325 MB of decoded float sitting in the renderer for a 15-minute mp4.
//
// So: read the `moov` box (small, metadata), find the `soun` track, and hand back WHERE ITS BYTES ARE. The
// caller then reads only those ranges — ~2% of a HAP master — and either converts them (PCM: no decoder
// exists or is needed) or frames them for a decoder (AAC).
//
// This is the same box walk as native/hap/src/mov.rs, which filters `hdlr == 'vide'`; this is its 'soun'
// sibling, in TS, in main. Kept deliberately separate from that crate: the HAP plugin's demuxer is about
// finding GPU frames in a file it already owns, and coupling "is there sound in this movie" to a native
// addon that graceful-degrades to absent would make audio depend on a video codec being installed.
//
// NOT A GENERAL DEMUXER. It reads what a conform needs and nothing else — no edit lists, no fragmented
// MP4 (`moof`), no MKV. Anything it does not understand returns null, and the conform falls to its
// last-resort branch rather than guessing.

import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

/** One contiguous run of audio bytes in the file (a `stco`/`co64` chunk). Reads happen per range. */
export interface AudioRange {
  offset: number;      // absolute byte offset in the file
  size: number;        // total bytes of audio samples in this chunk
  firstSample: number; // index of the first media sample in this chunk (for per-frame sizes)
  count: number;       // media samples in this chunk
}

export interface AudioTrack {
  codec: string;         // the `stsd` fourcc: 'in24' | 'sowt' | 'twos' | 'lpcm' | 'mp4a' | …
  sampleRate: number;    // from the sample entry (16.16 fixed, or a double in a v2 entry)
  channels: number;      // ⚠ from the sample entry. AUTHORITATIVE FOR PCM ONLY — see the AAC note below.
  bitsPerSample: number; // ditto — for AAC the `stsd` fields describe the *output* loosely at best
  /**
   * ⚠ PCM BYTE ORDER, AND IT IS NOT IMPLIED BY THE FOURCC. `in24` is big-endian *by the QuickTime spec*,
   * but a file may carry an `enda` atom (inside `wave`) that flips it — and the WS1a HAP master does
   * exactly that. Reading it the spec's way produced full-scale hash: crest factor 4.8 dB and RMS −4.8
   * dBFS where the movie's opening is near-silent. Endianness here is READ FROM THE FILE, never assumed.
   */
  littleEndian: boolean;
  pcmFloat: boolean;     // v2 `lpcm` entries describe float vs integer in formatSpecificFlags
  pcmUnsigned: boolean;  // 8-bit 'raw ' is unsigned; everything else is signed
  durationSec: number;
  ranges: AudioRange[];
  /** Per-sample byte sizes, or null when every sample is `uniformSize` bytes (the PCM case). */
  sampleSizes: Uint32Array | null;
  uniformSize: number;
  /** AAC only: the AudioSpecificConfig out of `esds`, i.e. WebCodecs' `description`. */
  asc: Uint8Array | null;
}

const be16 = (b: Buffer, o: number) => b.readUInt16BE(o);
const be32 = (b: Buffer, o: number) => b.readUInt32BE(o);

/** Iterate immediate child boxes of `buf`, calling `fn(type, payload)`. Stops on a malformed size. */
function forEachBox(buf: Buffer, fn: (type: string, payload: Buffer) => void): void {
  let p = 0;
  while (p + 8 <= buf.length) {
    let size = be32(buf, p);
    let header = 8;
    if (size === 1) {
      if (p + 16 > buf.length) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = buf.length - p; // "to the end of the enclosing box"
    }
    if (size < header || p + size > buf.length) break;
    fn(buf.toString('latin1', p + 4, p + 8), buf.subarray(p + header, p + size));
    p += size;
  }
}

function findBox(buf: Buffer, type: string): Buffer | undefined {
  let found: Buffer | undefined;
  forEachBox(buf, (t, payload) => { if (!found && t === type) found = payload; });
  return found;
}

/**
 * Read the top-level `moov` WITHOUT touching `mdat`. The whole point of this module: a 1 GB movie costs a
 * few hundred KB to inspect. `moov` is at the tail in a file written by a non-streaming encoder, which is
 * why this walks the top level rather than assuming a position.
 */
function readMoov(fd: number, fileSize: number): Buffer | null {
  let pos = 0;
  const hdr = Buffer.alloc(16);
  while (pos + 8 <= fileSize) {
    if (readSync(fd, hdr, 0, 8, pos) < 8) break;
    let size = be32(hdr, 0);
    let header = 8;
    if (size === 1) {
      readSync(fd, hdr, 8, 8, pos + 8);
      size = Number(hdr.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) {
      size = fileSize - pos;
    }
    if (size < header) break;
    if (hdr.toString('latin1', 4, 8) === 'moov') {
      const buf = Buffer.alloc(size - header);
      readSync(fd, buf, 0, buf.length, pos + header);
      return buf;
    }
    pos += size;
  }
  return null;
}

/**
 * The MPEG-4 descriptor tag/length coding used inside `esds`: a tag byte, then a length in 1–4 bytes,
 * each carrying 7 bits with the top bit meaning "another byte follows". Walk to tag 0x05
 * (DecoderSpecificInfo) — for AAC that payload IS the AudioSpecificConfig, which is exactly what
 * WebCodecs wants as `description`.
 */
function findAsc(esds: Buffer): Uint8Array | null {
  let p = 4; // version + flags
  const readLen = (): number => {
    let len = 0;
    for (let i = 0; i < 4 && p < esds.length; i++) {
      const b = esds[p++];
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return len;
  };
  while (p < esds.length) {
    const tag = esds[p++];
    const len = readLen();
    if (len < 0 || p + len > esds.length) return null;
    if (tag === 0x03) { p += 3; continue; }        // ES_Descriptor: ES_ID(2) + flags(1), then children
    if (tag === 0x04) { p += 13; continue; }       // DecoderConfigDescriptor: 13 bytes, then children
    if (tag === 0x05) return new Uint8Array(esds.subarray(p, p + len)); // DecoderSpecificInfo — the ASC
    p += len;                                       // anything else: skip wholesale
  }
  return null;
}

/**
 * Demux the first audio track's metadata. Returns null when there is no audio track (a perfectly normal
 * answer — one of the WS0 HAP samples is picture-only), or when the container is one this does not read.
 */
export function demuxAudio(path: string): AudioTrack | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const moov = readMoov(fd, fstatSync(fd).size);
    if (!moov) return null;

    let track: AudioTrack | null = null;
    forEachBox(moov, (t, trak) => {
      if (track || t !== 'trak') return;
      const mdia = findBox(trak, 'mdia'); if (!mdia) return;
      const hdlr = findBox(mdia, 'hdlr'); if (!hdlr || hdlr.length < 12) return;
      if (hdlr.toString('latin1', 8, 12) !== 'soun') return;   // not the audio track

      const mdhd = findBox(mdia, 'mdhd'); if (!mdhd || mdhd.length < 20) return;
      const v1 = mdhd[0] === 1;
      const timescale = v1 ? be32(mdhd, 20) : be32(mdhd, 12);
      const rawDur = v1 ? Number(mdhd.readBigUInt64BE(24)) : be32(mdhd, 16);
      if (!timescale) return;

      const minf = findBox(mdia, 'minf'); const stbl = minf && findBox(minf, 'stbl');
      if (!stbl) return;
      const stsd = findBox(stbl, 'stsd'); const stsz = findBox(stbl, 'stsz');
      const stsc = findBox(stbl, 'stsc');
      const stco = findBox(stbl, 'stco'); const co64 = findBox(stbl, 'co64');
      if (!stsd || !stsz || !stsc || (!stco && !co64)) return;
      if (stsd.length < 16 || stsz.length < 12) return;

      // --- the sample entry: fourcc + AudioSampleEntry fields ---------------------------------------
      // stsd payload: version/flags(4) + entry_count(4) + entry box{ size(4) fourcc(4) payload… }
      const entry = stsd.subarray(8);
      const codec = entry.toString('latin1', 4, 8);
      const se = entry.subarray(8); // AudioSampleEntry payload
      if (se.length < 28) return;
      // reserved(6) dref(2) version(2) revision(2) vendor(4) channels(2) bits(2) compID(2) packet(2) rate(4:16.16)
      const version = be16(se, 8);
      let channels = be16(se, 16);
      let bits = be16(se, 18);
      let sampleRate = be32(se, 24) / 65536;
      // 'sowt' IS 'twos' spelled backwards, and that is not a joke — it is how QuickTime names
      // little-endian 16-bit. Every other integer fourcc defaults to big-endian, and `enda` below may
      // still overrule all of it.
      let littleEndian = codec === 'sowt';
      let pcmFloat = codec === 'fl32' || codec === 'fl64';

      // WHERE THE EXTENSION BOXES START depends on the sample entry's version, and getting it wrong means
      // scanning sample data as if it were boxes: v0 is the bare 28 bytes, v1 adds 4 uint32
      // (samplesPerPacket, bytesPerPacket, bytesPerFrame, bytesPerSample), v2 adds a 36-byte struct that
      // *re-declares* rate/channels/bits properly and carries the format flags.
      let extOffset = 28;
      if (version === 1) {
        extOffset = 44;
      } else if (version === 2 && se.length >= 64) {
        extOffset = 64;
        sampleRate = se.readDoubleBE(32);
        channels = be32(se, 40);
        bits = be32(se, 48);
        const flags = be32(se, 52);
        pcmFloat = !!(flags & 1);
        littleEndian = !(flags & 2); // bit 1 SET means big-endian
      }

      const ext = se.subarray(Math.min(extOffset, se.length));
      const wave = findBox(ext, 'wave');
      // `enda` — the atom that decides byte order, and the reason the WS1a HAP master's `in24` is not
      // big-endian. It sits inside `wave` in every file seen so far; accept a bare one too.
      const enda = findBox(ext, 'enda') ?? (wave ? findBox(wave, 'enda') : undefined);
      if (enda && enda.length >= 2) littleEndian = be16(enda, 0) === 1;

      // ⚠ FOR AAC, `channels`/`bits` LIE, AND IT IS NOT AN EDGE CASE. WS0's `big-buck-bunny-1080p-30sec.mp4`
      // declares `channels = 2` here and decodes to SIX. The truth for AAC lives in the
      // AudioSpecificConfig (and ultimately in what the decoder reports), never in `stsd`. Callers must
      // treat these as authoritative for PCM only — which is safe, because PCM has no other description.
      const esds = findBox(ext, 'esds') ?? (wave ? findBox(wave, 'esds') : undefined);
      const asc = esds ? findAsc(esds) : null;

      // --- sizes ------------------------------------------------------------------------------------
      const uniformSize = be32(stsz, 4);
      const sampleCount = be32(stsz, 8);
      let sampleSizes: Uint32Array | null = null;
      if (!uniformSize) {
        if (stsz.length < 12 + sampleCount * 4) return;
        sampleSizes = new Uint32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) sampleSizes[i] = be32(stsz, 12 + i * 4);
      }
      const sizeOf = (i: number) => (sampleSizes ? sampleSizes[i] : uniformSize);

      // --- chunk offsets + the stsc run-length map --------------------------------------------------
      const chunkCount = co64 ? be32(co64, 4) : be32(stco!, 4);
      const chunkOffset = (i: number) => (co64 ? Number(co64.readBigUInt64BE(8 + i * 8)) : be32(stco!, 8 + i * 4));
      const stscCount = be32(stsc, 4);

      // ONE RANGE PER CHUNK, NOT PER SAMPLE — and for PCM that is the difference between a usable module
      // and a pathological one. The WS0 HAP master has 1 440 768 audio samples of 18 bytes each; a
      // per-sample range list would be 1.4 million objects to describe bytes that are CONTIGUOUS inside
      // their chunk. Per chunk it is a few thousand ranges and a handful of reads.
      const ranges: AudioRange[] = [];
      let sampleIdx = 0;
      for (let chunk = 0; chunk < chunkCount && sampleIdx < sampleCount; chunk++) {
        let spc = 0;
        for (let e = 0; e < stscCount; e++) {
          const o = 8 + e * 12;
          if (o + 8 > stsc.length) break;
          const firstChunk = be32(stsc, o);
          if (firstChunk <= chunk + 1) spc = be32(stsc, o + 4); else break;
        }
        if (spc <= 0) continue;
        const count = Math.min(spc, sampleCount - sampleIdx);
        let bytes = 0;
        for (let i = 0; i < count; i++) bytes += sizeOf(sampleIdx + i);
        ranges.push({ offset: chunkOffset(chunk), size: bytes, firstSample: sampleIdx, count });
        sampleIdx += count;
      }
      if (!ranges.length) return;

      track = {
        codec, sampleRate, channels, bitsPerSample: bits,
        littleEndian, pcmFloat, pcmUnsigned: codec === 'raw ' || codec === 'NONE',
        durationSec: rawDur / timescale,
        ranges, sampleSizes, uniformSize, asc,
      };
    });
    return track;
  } catch {
    return null; // a malformed container is "no audio", never a throw into the conform
  } finally {
    closeSync(fd);
  }
}
