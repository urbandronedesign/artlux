import MP4Box, { type MP4File, type MP4Info, type MP4Sample, type MP4VideoTrack } from 'mp4box';
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource } from 'mediabunny';
import * as dec from '@plugin-mp4/mp4Decoder';

const NL = String.fromCharCode(10);

// ── THE PAYLOAD ─────────────────────────────────────────────────────────────────────────────────
// Every frame is a FLAT grey whose level encodes its own index: level = BASE + i*STEP. Flat frames
// survive H.264 almost exactly, and a step of 4 leaves room for the RGB->YUV limited-range round trip
// to be off by one and still decode to the right index. That makes the ground truth INDEPENDENT of
// the decoder under test: we are not asking it whether it agrees with itself, we are reading the
// frame's own serial number out of its pixels.
const W = 320, H = 240, FPS = 30, COUNT = 48, BASE = 10, STEP = 4;
const levelOf = (i: number) => BASE + i * STEP;
const indexOfLevel = (v: number) => Math.round((v - BASE) / STEP);

async function makeMp4(): Promise<ArrayBuffer> {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new CanvasSource(cv, {
    codec: 'avc',
    bitrate: 8_000_000,        // generous: quantisation error must not eat the serial number
    keyFrameInterval: 0.5,      // ~15 frames at 30fps -> several GOPs, so seeking is exercised
  });
  output.addVideoTrack(source, { frameRate: FPS });
  await output.start();
  for (let i = 0; i < COUNT; i++) {
    const v = levelOf(i);
    ctx.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
    ctx.fillRect(0, 0, W, H);
    await source.add(i / FPS, 1 / FPS);
  }
  await output.finalize();
  return target.buffer!;
}

// Independent demux: the presentation times, straight from the container.
async function truth(url: string): Promise<{ cts: number[]; w: number; h: number; durSec: number }> {
  const buf = await (await fetch(url)).arrayBuffer();
  return await new Promise((resolve, reject) => {
    const file: MP4File = MP4Box.createFile();
    const cts: number[] = [];
    let w = 0, h = 0, durSec = 0;
    file.onError = (e: unknown) => reject(new Error('demux failed ' + String(e)));
    file.onReady = (mp4: MP4Info) => {
      const t: MP4VideoTrack | undefined = mp4.videoTracks?.[0];
      if (!t) { reject(new Error('no video track')); return; }
      w = t.video.width; h = t.video.height; durSec = t.duration / t.timescale;
      file.onSamples = (_id: number, _u: unknown, samples: MP4Sample[]) => {
        for (const s of samples) cts.push(Math.round((s.cts / s.timescale) * 1e6));
      };
      file.setExtractionOptions(t.id, null, { nbSamples: 1000000 });
      file.start();
      setTimeout(() => resolve({ cts: cts.slice().sort((a, b) => a - b), w, h, durSec }), 0);
    };
    (buf as ArrayBuffer & { fileStart?: number }).fileStart = 0;
    file.appendBuffer(buf as ArrayBuffer & { fileStart: number });
    file.flush();
  });
}

// Draw a returned drawable and read its serial number back.
function readIndex(d: CanvasImageSource): number {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(d as CanvasImageSource, 0, 0, W, H);
  const px = ctx.getImageData(W >> 1, H >> 1, 1, 1).data;
  return indexOfLevel(px[0]);
}

(globalThis as unknown as { __run: unknown }).__run = async (path: string, writeFile: (b: ArrayBuffer) => string) => {
  const out: string[] = [];
  let failed = 0;
  const ok = (name: string, cond: boolean, extra?: string) => {
    out.push((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' - ' + extra : ''));
    if (!cond) failed++;
  };

  const mp4 = await makeMp4();
  out.push('generated ' + COUNT + ' frames, ' + W + 'x' + H + ', ' + mp4.byteLength + ' bytes');
  const file = writeFile(mp4);
  const url = URL.createObjectURL(new Blob([mp4]));
  (globalThis as unknown as { __mediaUrls: Record<string, string> }).__mediaUrls = { [file]: url };

  const T = await truth(url);
  ok('the generated file demuxes', T.cts.length === COUNT, T.cts.length + ' samples, ' + T.durSec.toFixed(3) + 's');

  ok('ensureOpen resolves', !!(await dec.ensureOpen(file)));

  const si = dec.sourceInfo(file);
  ok('sourceInfo answers', !!si, si ? JSON.stringify({ ...si, fps: +si.fps.toFixed(2) }) : 'null');
  if (si) {
    ok('sourceInfo size matches', si.width === W && si.height === H, si.width + 'x' + si.height);
    ok('sourceInfo fps matches', Math.abs(si.fps - FPS) < 0.6, si.fps.toFixed(3));
  }

  // ── FORWARD, then BACKWARD, then RANDOM. The backward pass is the one that breaks a forward-only
  // feed, and the random pass is what an operator scrubbing a bake range actually does.
  const fwd = Array.from({ length: COUNT }, (_, i) => i);
  const bwd = fwd.slice().reverse();
  let seed = 12345;
  const rnd = fwd.slice().sort(() => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 2) - 0.5);

  for (const [label, order] of [['forward', fwd], ['backward', bwd], ['random', rnd]] as [string, number[]][]) {
    let miss = 0;
    const bad: string[] = [];
    for (const i of order) {
      const t = (i + 0.5) / FPS;   // mid-frame: unambiguous which frame is on screen
      const d = await dec.layerFrameExact('harness', file, t);
      if (!d) { miss++; if (bad.length < 4) bad.push('@' + i + ' null'); continue; }
      const got = readIndex(d);
      if (got !== i) { miss++; if (bad.length < 4) bad.push('@' + i + ' got ' + got); }
    }
    ok('frameExact returns the RIGHT frame, ' + label + ' (' + (COUNT - miss) + '/' + COUNT + ')', miss === 0, bad.join(', '));
  }

  // ── exact or nothing ──
  ok('frameExact(-1s) is null', (await dec.layerFrameExact('harness', file, -1)) === null);
  ok('frameExact(past the end) is null', (await dec.layerFrameExact('harness', file, T.durSec + 5)) === null);

  // ── the contrast that justifies the whole method ──
  let thumbMiss = 0;
  const thumbBad: string[] = [];
  for (const i of bwd) {
    const d = await dec.thumbnail(file, (i + 0.5) / FPS);
    if (!d) { thumbMiss++; continue; }
    const got = readIndex(d);
    if (got !== i) { thumbMiss++; if (thumbBad.length < 4) thumbBad.push('@' + i + ' got ' + got); }
  }
  out.push('  note  thumbnail() returned the wrong frame ' + thumbMiss + '/' + COUNT + ' times on the same backward pass' +
           (thumbBad.length ? ' (' + thumbBad.join(', ') + ')' : '') + ' - this is why frameExact exists');

  dec.releaseLayer('harness');
  out.push(failed ? String(failed) + ' FAILED' : 'all passed');
  return { text: out.join(NL), failed };
};
