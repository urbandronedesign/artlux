// RENDERER SIDE OF THE CONFORM — the half main cannot do, and only that half.
//
// Main demuxes, caches, folds PCM and writes the WAV (conform.main.ts). It comes here only when the track
// needs a DECODER: AAC via WebCodecs, or — for a container the demuxer does not read — a whole-file
// `decodeAudioData` as the last resort. Chromium's codecs live in this process and nowhere else, which is
// the entire reason this file exists.
//
// ⚠ NEVER ON THE FRAME PATH. A conform is kicked from import / a project sweep, and the audio driver only
// ever does a synchronous cache read. Decoding a 15-minute soundtrack takes seconds; doing it from `tick()`
// would drop frames on a live show.

import type { PluginIpc } from '@artlux/sdk/renderer';
import { gainFor, measureFold, newFoldStats, outChannelsFor, toInt16, type FoldStats } from './audioFold';

interface ConformStart {
  kind: 'ready' | 'aac' | 'raw' | 'none';
  wavPath?: string;
  token?: string;
  asc?: Uint8Array | null;
  sampleRate?: number;
  channels?: number;
  durationSec?: number;
}
interface FramePull { bytes: Uint8Array; sizes: number[]; done: boolean }

let ipc: PluginIpc | null = null;
export function setConformIpc(i: PluginIpc): void { ipc = i; }

// One conform per SOURCE, ever — five clips can point at one file, and a project sweep will ask for all of
// them in the same tick. Shares the in-flight promise, exactly as mediaCache's `ensureBlobUrl` does for
// blob reads.
const inFlight = new Map<string, Promise<string | null>>();
const resolved = new Map<string, string | null>();

/** Synchronous cache read — what the per-frame derivation is allowed to call. */
export const conformOf = (src: string): string | null | undefined => resolved.get(src);

/** A monotonically-bumped counter: something landed, so any memo keyed on conform state must re-derive. */
let generation = 0;
export const conformGeneration = (): number => generation;

export function conformAudio(src: string): Promise<string | null> {
  const hit = inFlight.get(src);
  if (hit) return hit;
  const job = run(src).then((wav) => {
    resolved.set(src, wav);
    generation++;
    inFlight.delete(src);
    return wav;
  }).catch(() => {
    resolved.set(src, null);   // a failed conform is an answer: silent, and not retried every frame
    generation++;
    inFlight.delete(src);
    return null;
  });
  inFlight.set(src, job);
  return job;
}

async function run(src: string): Promise<string | null> {
  if (!ipc) return null;
  const start = (await ipc.invoke('audio:conformStart', src)) as ConformStart | null;
  if (!start || start.kind === 'none') return null;
  if (start.kind === 'ready') return start.wavPath ?? null;
  if (!start.token) return null;
  try {
    return start.kind === 'aac' ? await runAac(start) : await runWholeFile(src, start.token);
  } catch (e) {
    console.warn('[audio] conform failed:', src, e);
    await ipc.invoke('audio:conformFinish', start.token, false);
    return null;
  }
}

/**
 * The AAC object type lives in the first 5 bits of the AudioSpecificConfig, and the codec string must
 * match it: 2 = AAC-LC (`mp4a.40.2`), 5 = HE-AAC, 29 = HE-AACv2. Guessing LC for an HE stream configures a
 * decoder that then rejects every chunk — silently, since there is nobody to reject to.
 */
const codecStringFor = (asc: Uint8Array | null | undefined): string => {
  const objType = asc && asc.length ? (asc[0] >> 3) & 0x1f : 2;
  return `mp4a.40.${objType || 2}`;
};

/**
 * Decode an AAC track frame by frame with ONE decoder for the whole stream — not chunked
 * `decodeAudioData` calls, which would each re-prime and leave a seam every few seconds.
 *
 * TWO PASSES, for the same reason the PCM branch has them: the fold's gain must be known before the first
 * sample is written, and a multichannel AAC track (WS0 measured a `.mp4` whose `stsd` claims stereo and
 * which decodes to SIX channels) can overflow it. Pass 1 measures and writes nothing — so it costs decode
 * time and no IPC. It is SKIPPED the moment the first decoded block turns out to be ≤2 channels, which is
 * most files: those fold to themselves and cannot clip.
 */
async function runAac(start: ConformStart): Promise<string | null> {
  const token = start.token!;
  const codec = codecStringFor(start.asc);
  const config: AudioDecoderConfig = {
    codec,
    sampleRate: start.sampleRate || 48000,
    numberOfChannels: start.channels || 2,
    ...(start.asc ? { description: start.asc } : {}),
  };
  const support = await AudioDecoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) {
    await ipc!.invoke('audio:conformFinish', token, false);
    return null;
  }

  const measure = newFoldStats();
  let multichannel: boolean | null = null;   // null until the first decoded block says

  // PASS 1 — measure (bailed out of as soon as we learn the source is ≤2 ch).
  await decodePass(token, config, async (flat, ch, frames) => {
    if (multichannel === null) multichannel = ch > 2;
    if (!multichannel) return 'stop';
    measureFold(flat, ch, frames, measure);
    return 'continue';
  });

  const gain = gainFor(measure.peak);
  await ipc!.invoke('audio:conformRewind', token);

  // PASS 2 — write.
  const stats = newFoldStats();
  let wrote = false;
  await decodePass(token, config, async (flat, ch, frames, rate) => {
    const outCh = outChannelsFor(ch);
    const pcm = toInt16(flat, ch, frames, outCh, gain, stats);
    await ipc!.invoke('audio:conformAppend', token, pcm, outCh, rate);
    wrote = true;
    return 'continue';
  });

  const wav = (await ipc!.invoke('audio:conformFinish', token, wrote)) as string | null;
  if (wav) {
    console.log(`[audio] conformed ${start.durationSec?.toFixed(1) ?? '?'}s ${codec}` +
      ` peak=${measure.peak.toFixed(3)} gain=${gain.toFixed(3)} clamped=${stats.clamped}`);
  }
  return wav;
}

type BlockFn = (flat: Float32Array, ch: number, frames: number, rate: number) => Promise<'continue' | 'stop'>;

/**
 * Pull encoded frames from main and run them through one decoder, applying `onBlock` to each decoded
 * block. Back-pressured by construction: every pull and every append is an awaited round trip, so a fast
 * decoder can never outrun the disk writer.
 */
async function decodePass(token: string, config: AudioDecoderConfig, onBlock: BlockFn): Promise<void> {
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  let failure: unknown = null;

  const decoder = new AudioDecoder({
    output: (data) => {
      // Chain the handlers: `output` is sync, but onBlock awaits an IPC round trip, and the blocks must
      // reach the wav IN ORDER.
      pending = pending.then(async () => {
        if (stopped) { data.close(); return; }
        const ch = data.numberOfChannels;
        const frames = data.numberOfFrames;
        const flat = new Float32Array(frames * ch);
        // 'f32-planar' is what Chromium hands back for AAC; copy plane by plane and interleave. Ask for
        // the format explicitly rather than trusting `data.format`, which may be planar or interleaved.
        const plane = new Float32Array(frames);
        for (let c = 0; c < ch; c++) {
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          for (let i = 0; i < frames; i++) flat[i * ch + c] = plane[i];
        }
        const rate = data.sampleRate;
        data.close();
        if ((await onBlock(flat, ch, frames, rate)) === 'stop') stopped = true;
      }).catch((e) => { failure = e; stopped = true; });
    },
    error: (e) => { failure = e; stopped = true; },
  });
  decoder.configure(config);

  const rate = config.sampleRate;
  let frameIndex = 0;
  let done = false;
  while (!done && !stopped) {
    const pull = (await ipc!.invoke('audio:conformFrames', token)) as FramePull;
    done = pull.done;
    let off = 0;
    for (const size of pull.sizes) {
      if (stopped) break;
      if (size > 0 && off + size <= pull.bytes.length) {
        decoder.decode(new EncodedAudioChunk({
          type: 'key',                                   // every AAC access unit is independently decodable
          timestamp: Math.round((frameIndex * 1024 * 1e6) / rate), // µs; 1024 samples per AAC frame
          data: pull.bytes.subarray(off, off + size),
        }));
      }
      off += size;
      frameIndex++;
    }
    // Let the decoder drain rather than queueing the whole track: the pull is already bounded, but a slow
    // writer plus a fast pull would still grow the decode queue without this.
    await pending;
  }
  if (!stopped) { try { await decoder.flush(); } catch { /* a stopped decoder has nothing to flush */ } }
  await pending;
  try { decoder.close(); } catch { /* already closed by an error */ }
  if (failure && !stopped) throw failure;
}

/**
 * LAST RESORT — a container movDemux does not read (mkv/webm, fragmented mp4). Hands the whole file to
 * Chromium. THE ONLY BRANCH THAT IS NOT CONSTANT-MEMORY: `decodeAudioData` materialises the entire decoded
 * track (WS0 measured 325 MB for a 15-minute mp4), so it is also the only branch with a size refusal.
 */
const RAW_MAX_BYTES = 512 * 1024 * 1024;

async function runWholeFile(src: string, token: string): Promise<string | null> {
  const bytes = await window.artlux?.readFile?.(src);
  if (!bytes || bytes.byteLength > RAW_MAX_BYTES) {
    if (bytes) console.warn(`[audio] conform skipped (${(bytes.byteLength / 1048576) | 0} MB > fallback limit):`, src);
    await ipc!.invoke('audio:conformFinish', token, false);
    return null;
  }
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  let buf: AudioBuffer;
  try {
    buf = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(ab);
  } catch {
    await ipc!.invoke('audio:conformFinish', token, false); // no audio track, or a codec Chromium lacks
    return null;
  }
  const ch = buf.numberOfChannels;
  const outCh = outChannelsFor(ch);
  const planes: Float32Array[] = [];
  for (let c = 0; c < ch; c++) planes.push(buf.getChannelData(c));

  // Interleave and hand over in blocks, so the IPC payload stays bounded even though the decode was not.
  const BLOCK = 1 << 17; // frames
  const measure: FoldStats = newFoldStats();
  if (ch > 2) {
    for (let start = 0; start < buf.length; start += BLOCK) {
      const frames = Math.min(BLOCK, buf.length - start);
      measureFold(interleave(planes, ch, start, frames), ch, frames, measure);
    }
  }
  const gain = gainFor(measure.peak);
  const stats = newFoldStats();
  for (let start = 0; start < buf.length; start += BLOCK) {
    const frames = Math.min(BLOCK, buf.length - start);
    const pcm = toInt16(interleave(planes, ch, start, frames), ch, frames, outCh, gain, stats);
    await ipc!.invoke('audio:conformAppend', token, pcm, outCh, buf.sampleRate);
  }
  return (await ipc!.invoke('audio:conformFinish', token, buf.length > 0)) as string | null;
}

function interleave(planes: Float32Array[], ch: number, start: number, frames: number): Float32Array {
  const flat = new Float32Array(frames * ch);
  for (let c = 0; c < ch; c++) {
    const p = planes[c];
    for (let i = 0; i < frames; i++) flat[i * ch + c] = p[start + i];
  }
  return flat;
}
