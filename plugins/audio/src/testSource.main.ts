// THE COMMISSIONING SOURCE — a pink-noise file the engine can play as an ordinary clip.
//
// ── WHY A FILE, AND WHY NOT `setTestTone` ─────────────────────────────────────────────────────────
//
// `setTestTone(channel, gain)` writes pink noise straight into one device channel, AFTER the master
// chain and around the ambisonic decoder entirely. Its own comment in AudioSettings says so: it tests
// the WIRING. That is exactly the right tool for "is channel 5 the box behind me", and it is exactly
// the wrong tool for the question this file exists to answer:
//
//     does the speaker the POSITIONER DRAWS at 90° actually come out of the box on my right?
//
// Nothing in that chain is exercised by a direct channel write. Encode, B-format bus, decoder matrix,
// the speaker patch — all of it is skipped. So a mirrored angle convention (see shared/spatial.ts: the
// document's angle is clockwise, the ambisonic azimuth is anticlockwise) would leave the wiring test
// passing perfectly while every real source came out of the wrong side of the room. That is the single
// most expensive thing that can be wrong here and the existing test cannot see it.
//
// The fix is to make the test source an ORDINARY CLIP: load a file, place it with `setClipSpatial`, and
// play it. It then travels the identical path a show's audio travels — clip chain, encoder, B-format,
// decoder, patch, device — so if it comes out of the right box, so will everything else.
//
// ── WHY GENERATED RATHER THAN SHIPPED ─────────────────────────────────────────────────────────────
//
// It is 1.8 MB of noise. Deriving it costs ~30 ms once per machine and keeps a binary blob out of the
// repo. Cached in userData beside the conform cache, and keyed by the parameters that define it, so a
// change to the generator produces a different file rather than silently reusing the old one.

import { app } from 'electron';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { closeWav, openWav, writeWav } from './wavPcm';

const RATE = 48000;
const SECONDS = 20;      // longer than anyone holds a button; the transport simply runs out if they do
const CHANNELS = 1;      // MONO, and it must stay mono: the engine folds a spatial source to mono anyway
                         // (a spatial clip's chain is 1 ch — see docs/AUDIO.md), so stereo would be
                         // downmixed and the file would be twice the size for the same sound.

// ⚠ THE LEVEL IS THE DIRECT TONE'S OUTPUT LEVEL, NOT ITS PER-SAMPLE SCALING.
//
// engine.cpp writes `(pink) * 0.2f * toneGain` and AudioSettings holds toneGain at 0.5, so what the
// direct test actually puts on a channel is `pink * 0.1`. Baking only the 0.2 and leaving the 0.5 to
// playback gain CLIPPED: the Kellet sum reaches about ±5 for white input in [-1, 1], so ×0.2 lands on
// full scale and the 16-bit clamp fires — a file made to judge a speaker by, with distortion in it.
// Bake the whole 0.1 and play at unity instead. Measured peak after this: ~0.5 FS.
const SCALE = 0.2 * 0.5;

// ⚠ THE SAME NOISE THE DIRECT TEST MAKES, DELIBERATELY.
//
// Paul Kellet's economy pink filter, transcribed from engine.cpp's `setTestTone` including its 0.2
// scaling. The two tests are meant to be compared BY EAR, one after the other, on the same speaker —
// and an operator cannot compare two sounds that have different timbre. Identical source material means
// the only thing that can differ between them is WHICH BOX IT COMES OUT OF, which is the entire test.
//
// (Levels still will not match exactly: the placed source goes through the decoder, which applies its
// own per-speaker gains. Timbre is what the ear compares; loudness is not the question being asked.)
// ⚠ THE FILTER STATE AND THE SEED LIVE ACROSS BLOCKS, and that is not a detail.
//
// The file is written in blocks so it never allocates whole. Reset either of these per block and the
// result is not pink noise: the RNG replays the identical sequence every block (a 1.37-second loop,
// plainly audible as a pattern) and the three filter poles snap back to zero at every seam (a click,
// 15 times in a 20-second file). Both would show up exactly where they do most harm — an operator
// listening closely to decide whether a speaker is working.
function makePinkGenerator(): (frames: number) => Int16Array {
  let b0 = 0, b1 = 0, b2 = 0;
  // A FIXED SEED, so the file is byte-identical on every machine and across regenerations. Small
  // xorshift — Math.random() would make the artefact unreproducible.
  let s = 0x9e3779b9 >>> 0;
  const rnd = (): number => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
  return (frames: number): Int16Array => {
    const out = new Int16Array(frames * CHANNELS);
    for (let i = 0; i < frames; i++) {
      const w = rnd() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      const v = (b0 + b1 + b2 + w * 0.1848) * SCALE;
      // A BACKSTOP THAT SHOULD NEVER FIRE (see SCALE — it did, once). Pink noise is unbounded in
      // principle, and a wrap at 16 bits would be an audible click in a file used to judge a speaker.
      out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    }
    return out;
  };
}

let cached: string | null = null;

/**
 * The path of the pink-noise test source, generating it on first use.
 *
 * Returns null if it cannot be written — the caller must degrade rather than throw, because this is a
 * commissioning aid and a venue with a read-only userData still needs the rest of Preferences to work.
 */
export function testSourcePath(): string | null {
  if (cached && existsSync(cached)) return cached;
  try {
    const dir = join(app.getPath('userData'), 'audio-test');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Keyed by what defines the content, and THE VERSION IS PART OF THAT KEY. It went to v2 when the
    // scaling was fixed (see SCALE): a machine that had already generated the clipping v1 would
    // otherwise have gone on playing it forever, since the size check below would have passed. That is
    // exactly the stale-artefact failure a plain `pink.wav` produces, and it caught me once already.
    const file = join(dir, `pink-${RATE}-${SECONDS}s-v2.wav`);
    const frames = RATE * SECONDS;
    // 44-byte header + one 16-bit sample per frame. A short file means a truncated write (a full disk,
    // a crash mid-generate) and must be re-made rather than played as a click.
    const expect = 44 + frames * CHANNELS * 2;
    if (existsSync(file) && statSync(file).size === expect) { cached = file; return cached; }
    const sink = openWav(file, CHANNELS, RATE);
    // Written in blocks so a 20-second file never materialises as one large allocation. ONE generator
    // across all of them -- see makePinkGenerator for why per-block state would not be noise at all.
    const nextBlock = makePinkGenerator();
    const BLOCK = 1 << 16;
    for (let done = 0; done < frames; done += BLOCK) {
      writeWav(sink, nextBlock(Math.min(BLOCK, frames - done)));
    }
    cached = closeWav(sink);
    console.log(`[audio] test source generated: ${cached}`);
    return cached;
  } catch (e) {
    console.warn('[audio] could not generate the speaker test source:', e);
    return null;
  }
}
