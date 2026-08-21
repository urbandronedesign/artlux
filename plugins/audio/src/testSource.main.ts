// THE COMMISSIONING SOURCE — a blip the engine can play as an ordinary clip.
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
// It is a few MB of blips. Deriving it costs ~50 ms once per machine and keeps a binary blob out of the
// repo. Cached in userData beside the conform cache, and keyed by the parameters that define it, so a
// change to the generator produces a different file rather than silently reusing the old one.

import { app } from 'electron';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { closeWav, openWav, writeWav } from './wavPcm';

const RATE = 48000;
// EXACTLY 90 BEATS at 90 BPM, and the whole number is what makes the loop work. The renderer restarts
// the clip when it runs out (the engine has no looping transport), and a whole number of beats means the
// restart lands ON a beat. It also lands in the ~0.6 s of silence between blips, so even a few
// milliseconds of timer drift is inaudible — the beat is either exactly right or imperceptibly late,
// never a doubled or clipped blip.
const SECONDS = 60;
const CHANNELS = 1;      // MONO, and it must stay mono: the engine folds a spatial source to mono anyway
                         // (a spatial clip's chain is 1 ch — see docs/AUDIO.md), so stereo would be
                         // downmixed and the file would be twice the size for the same sound.

// ⚠ THE LEVEL IS THE DIRECT TONE'S OUTPUT LEVEL, NOT ITS PER-SAMPLE SCALING.
//
// engine.cpp writes `sin * env * 0.5f * toneGain`, and AudioSettings holds toneGain at 0.5 — so what the
// direct test actually puts on a channel peaks at 0.25. Bake the whole thing and play at unity, rather
// than baking half of it and leaving the rest to playback gain. (Doing exactly that with the pink noise
// this replaced put the file ON full scale and made the 16-bit clamp fire: a file for judging a speaker,
// with distortion in it.)
const SCALE = 0.5 * 0.5;

// ⚠ THE SAME BLIP THE DIRECT TEST MAKES, DELIBERATELY — same numbers, transcribed from engine.cpp's
// kTone* constants. The two tests are meant to be compared BY EAR, one after the other, on the same
// speaker, and an operator cannot compare two sounds of different timbre. Identical source material means
// the only thing that can differ between them is WHICH BOX IT COMES OUT OF, which is the entire test.
//
// A REPEATING TRANSIENT rather than a continuous tone, because that is what the ear localises: two
// speakers a metre apart both playing steady hiss are genuinely hard to tell apart — there is no onset to
// compare — while a blip at a walking tempo lets you stand between them and hear which starts first.
//
// (Levels still will not match exactly: the placed source goes through the decoder, which applies its own
// per-speaker gains. Timbre is what the ear compares; loudness is not the question being asked.)
const TONE_HZ = 660;
const TONE_BPM = 90;
const ATTACK_SEC = 0.005;
const DECAY_SEC = 0.050;
// ⚠ THE SAMPLE COUNTER LIVES ACROSS BLOCKS. The file is written in blocks so it never allocates whole,
// and the beat phase is derived from an absolute sample index — reset it per block and every block would
// restart the pattern, putting a blip 1.37 s apart from the previous one instead of 0.67 s. (The pink
// noise this replaced had the same hazard in a nastier form: a per-block seed made the whole file a
// short repeating loop with a click at every seam.)
function makeBeepGenerator(): (frames: number) => Int16Array {
  let pos = 0;
  const period = 60 / TONE_BPM;
  return (frames: number): Int16Array => {
    const out = new Int16Array(frames * CHANNELS);
    for (let i = 0; i < frames; i++, pos++) {
      const t = pos / RATE;
      const beat = t % period;
      let env = 0;
      if (beat < ATTACK_SEC) env = beat / ATTACK_SEC;
      else if (beat < ATTACK_SEC + DECAY_SEC) env = 1 - (beat - ATTACK_SEC) / DECAY_SEC;
      if (env <= 0) continue;                      // the silence between blips: leave the zeros
      const v = Math.sin(2 * Math.PI * TONE_HZ * t) * env * SCALE;
      // A backstop that should never fire — a sine at SCALE cannot reach full scale. Kept because the
      // pink generator this replaced DID overflow, and the clamp is what made that audible rather than
      // a wrap. (See SCALE.)
      out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    }
    return out;
  };
}

let cached: string | null = null;

/**
 * The path of the blip test source, generating it on first use.
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
    const file = join(dir, `blip-${TONE_HZ}hz-${TONE_BPM}bpm-${SECONDS}s-v1.wav`);
    const frames = RATE * SECONDS;
    // 44-byte header + one 16-bit sample per frame. A short file means a truncated write (a full disk,
    // a crash mid-generate) and must be re-made rather than played as a click.
    const expect = 44 + frames * CHANNELS * 2;
    if (existsSync(file) && statSync(file).size === expect) { cached = file; return cached; }
    const sink = openWav(file, CHANNELS, RATE);
    // Written in blocks so a 20-second file never materialises as one large allocation. ONE generator
    // across all of them -- see makePinkGenerator for why per-block state would not be noise at all.
    const nextBlock = makeBeepGenerator();
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
