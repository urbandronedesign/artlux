// Channel folding + 16-bit conversion — the ONE copy, shared by both processes.
//
// Main folds uncompressed PCM (wavPcm.ts); the renderer folds whatever WebCodecs hands back from an AAC
// track (conformClient.ts). Same coefficients, same gain policy, same clamp — because a file's sound must
// not depend on which branch of the conform happened to decode it. Deliberately free of `node:` and of DOM
// imports so it can live in both bundles.

const M = Math.SQRT1_2; // −3 dB
const clamp1 = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);

/** Running loudness bookkeeping for a conform — see `gainFor`. */
export interface FoldStats { peak: number; clamped: number; frames: number }
export const newFoldStats = (): FoldStats => ({ peak: 0, clamped: 0, frames: 0 });

/** The engine's non-spatial path is stereo; a mono source stays mono, everything else folds to 2. */
export const outChannelsFor = (ch: number): number => (ch === 1 ? 1 : 2);

/**
 * DOWNMIX, NEVER TRUNCATE — a correctness rule, not a nicety. Both WS0 test files carry SIX channels, and
 * a naive "take channels 0 and 1" drops the CENTRE channel: in a 5.1 mix that is the dialogue. ITU-R
 * BS.775 coefficients (C and the surrounds at −3 dB), assuming the conventional L R C LFE Ls Rs order —
 * the layout AAC and virtually every `.mov` use. (A `chan` box could refine it; nothing met so far needs
 * that.) LFE is dropped, as every downmix does.
 *
 * Returns L/R BEFORE any gain or clamp, so a caller can measure the true peak: a conform that silently
 * clipped would be indistinguishable from one that did not, and it is written once and lived with.
 */
function fold(src: Float32Array, b: number, ch: number): [number, number] {
  if (ch >= 6) {
    const exL = ch >= 8 ? src[b + 6] : 0; // 7.1: Lrs/Rrs fold into the surrounds
    const exR = ch >= 8 ? src[b + 7] : 0;
    return [src[b] + M * src[b + 2] + M * (src[b + 4] + exL),
            src[b + 1] + M * src[b + 2] + M * (src[b + 5] + exR)];
  }
  if (ch === 4) return [src[b] + M * src[b + 2], src[b + 1] + M * src[b + 3]]; // quad: L R Ls Rs
  if (ch >= 2) return [src[b], src[b + 1]];
  return [src[b], src[b]];
}

/** Accumulate the pre-gain peak over a block without producing output (the measure pass). */
export function measureFold(flat: Float32Array, ch: number, frames: number, stats: FoldStats): void {
  for (let i = 0; i < frames; i++) {
    const [l, r] = ch === 1 ? [flat[i], 0] : fold(flat, i * ch, ch);
    const m = Math.max(Math.abs(l), Math.abs(r));
    if (m > stats.peak) stats.peak = m;
    stats.frames++;
  }
}

/**
 * Interleaved float → interleaved 16-bit, folded to `outCh` (≤2), with `gain` applied. `stats`, when
 * given, counts frames that still had to be clamped — which should be zero once `gainFor` has been used.
 */
export function toInt16(flat: Float32Array, ch: number, frames: number, outCh: number, gain = 1, stats?: FoldStats): Int16Array {
  const pcm = new Int16Array(frames * outCh);
  for (let i = 0; i < frames; i++) {
    const [l, r] = outCh === 1 ? [flat[i * ch], 0] : fold(flat, i * ch, ch);
    if (stats) {
      const m = Math.max(Math.abs(l), Math.abs(r));
      if (m > stats.peak) stats.peak = m;
      if (m * gain > 1) stats.clamped++;
      stats.frames++;
    }
    if (outCh === 1) {
      pcm[i] = clamp1(l * gain) * 32767;
    } else {
      pcm[i * 2] = clamp1(l * gain) * 32767;
      pcm[i * 2 + 1] = clamp1(r * gain) * 32767;
    }
  }
  return pcm;
}

/**
 * THE DOWNMIX GAIN, chosen from what the material actually measures rather than from the worst case.
 *
 * The ITU fold can reach 2.41× full scale (L + 0.707·C + 0.707·Ls, all three at once, in phase), so a gain
 * that is safe *by construction* is 1/2.41 — i.e. −7.7 dB on every multichannel file, forever, to protect
 * against a coincidence most mixes never produce. That is too expensive to pay blind.
 *
 * So the conform MEASURES first and then writes with `1/peak` — leaving nothing on the table for a mix
 * that never approaches full scale — capped at unity so a quiet file is never *boosted* into a louder-
 * than-authored conform. Stereo and mono sources fold to themselves and always come back exactly 1, which
 * is why they skip the measure pass entirely.
 *
 * WS1a measured `hapbig-buck-bunny…mov` (in24, 6 ch) at **peak 2.401 — the worst case, near enough
 * exactly**, and that is itself the finding: 2.414 is only reachable when L, C and Ls carry the SAME
 * signal in phase, i.e. that file is duplicated stereo wearing a 5.1 layout, not a mix. A real surround
 * master measures far lower and keeps most of its level. Both are served by measuring; neither is served
 * by a constant. (Consequence worth knowing: the fold is peak-normalised, so two clips can sit at slightly
 * different levels relative to their sources. The clip's own gain is where that is reconciled — a conform
 * must never clip, and must never invent loudness.)
 */
export const gainFor = (peak: number): number => (peak > 1 ? 1 / peak : 1);
