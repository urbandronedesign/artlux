import { VideoClip } from '../../types';

// Pure clip-array mutations for the NLE timeline. Each returns a new array; callers wrap the
// result in onChange({ ...timeline, clips }). None of these touch the playback engine.

const EPS = 1e-4;
const uid = () => crypto.randomUUID();

// The blade and the lift are structurally generic over "a clip on a time axis": they only ever read
// id/start/duration/inPoint. AudioClip satisfies that — it calls its owner `trackId`, not `layerId`, but
// neither of these two functions reads the owner. rippleDelete and bladeAt DO read `layerId` and stay
// VideoClip-typed: audio has no ripple and no playhead-blade in Wave B.
export interface TimeClip { id: string; start: number; duration: number; inPoint: number }

// Split a clip at absolute timeline time t into two clips sharing the source. No-op if t isn't
// strictly inside the clip.
export function splitClipAt<T extends TimeClip>(clips: T[], clipId: string, t: number): T[] {
  const c = clips.find(x => x.id === clipId);
  if (!c || t <= c.start + EPS || t >= c.start + c.duration - EPS) return clips;
  const leftDur = t - c.start;
  const left: T = { ...c, duration: leftDur };
  const right: T = { ...c, id: uid(), start: t, inPoint: c.inPoint + leftDur, duration: c.duration - leftDur };
  return clips.flatMap(x => (x.id === clipId ? [left, right] : [x]));
}

// Blade every clip crossing time t (optionally restricted to one layer).
export function bladeAt(clips: VideoClip[], t: number, layerId?: string): VideoClip[] {
  let out = clips;
  for (const c of clips) {
    if (layerId && c.layerId !== layerId) continue;
    if (t > c.start + EPS && t < c.start + c.duration - EPS) out = splitClipAt(out, c.id, t);
  }
  return out;
}

// Remove a clip, leaving a gap.
export function liftDelete<T extends TimeClip>(clips: T[], clipId: string): T[] {
  return clips.filter(c => c.id !== clipId);
}

// Remove a clip and slide later clips on the same layer left to close the gap.
export function rippleDelete(clips: VideoClip[], clipId: string): VideoClip[] {
  const c = clips.find(x => x.id === clipId);
  if (!c) return clips;
  const end = c.start + c.duration;
  return clips
    .filter(x => x.id !== clipId)
    .map(x => (x.layerId === c.layerId && x.start >= end - EPS ? { ...x, start: Math.max(0, x.start - c.duration) } : x));
}

// ── OCCUPANCY: ONE TRACK, ONE CLIP AT A TIME ─────────────────────────────────────────────────────
// A track is a set of half-open spans [start, start+duration). Two clips may TOUCH (one ends exactly
// where the next begins) but never OVERLAP — the engine's activeClip() resolves an overlap by taking
// the LAST matching clip, so a stacked clip does not corrupt playback, it just becomes invisible and
// unpickable while still living in the document, saved and reloaded forever. That is what an
// accidental double-drop leaves behind, and the timeline must not be able to author it.
//
// These are pure and generic over TimeClip, so the audio lanes can adopt them unchanged.
// Callers pass ONLY the other clips on the same track (the moving/incoming clip excluded).

// Touching is not overlapping — but floats never land exactly on each other, so compare with slop.
const isFree = <T extends TimeClip>(others: T[], start: number, duration: number): boolean =>
  !others.some(o => start < o.start + o.duration - EPS && o.start < start + duration - EPS);

/**
 * The start nearest to `desired` at which a clip of `duration` fits between `others`.
 *
 * Never fails: the span after the last clip is unbounded, so there is always at least one gap that
 * fits. A drag therefore SLIDES against its neighbour instead of stopping dead, and a drop into a
 * fully-occupied region lands after the last clip rather than on top of it.
 */
export function nearestFreeStart<T extends TimeClip>(others: T[], desired: number, duration: number): number {
  const want = Math.max(0, desired);
  if (isFree(others, want, duration)) return want;
  const sorted = others.slice().sort((a, b) => a.start - b.start);
  // Candidate gaps: before the first clip, between consecutive clips, and after the last.
  let best = Number.NaN, bestDist = Infinity;
  const consider = (from: number, to: number) => {
    if (to - from < duration - EPS) return;                    // too small to hold this clip
    const c = Math.min(Math.max(want, from), to - duration);   // clamp into the gap
    const d = Math.abs(c - want);
    if (d < bestDist) { bestDist = d; best = c; }
  };
  let cursor = 0;
  for (const o of sorted) {
    consider(cursor, o.start);
    cursor = Math.max(cursor, o.start + o.duration);
  }
  consider(cursor, Infinity);
  return Number.isNaN(best) ? cursor : best;                   // `cursor` = after everything
}

/**
 * The maximal free interval containing time `t` — the room a clip sitting there may grow into.
 * Trimming reads this so an edge stops against the neighbour instead of sliding under it. `to` is
 * Infinity when nothing follows.
 */
export function freeSpanAt<T extends TimeClip>(others: T[], t: number): { from: number; to: number } {
  let from = 0, to = Infinity;
  for (const o of others) {
    const end = o.start + o.duration;
    if (end <= t + EPS && end > from) from = end;
    if (o.start >= t - EPS && o.start < to) to = o.start;
  }
  return { from, to };
}

// Apply a trim (newClip replaces clipId) and ripple later same-layer clips by the change in end.
export function rippleTrimResult(clips: VideoClip[], clipId: string, newClip: VideoClip): VideoClip[] {
  const old = clips.find(x => x.id === clipId);
  if (!old) return clips.map(x => (x.id === clipId ? newClip : x));
  const delta = (newClip.start + newClip.duration) - (old.start + old.duration);
  const oldEnd = old.start + old.duration;
  return clips.map(x => {
    if (x.id === clipId) return newClip;
    if (x.layerId === old.layerId && x.start >= oldEnd - EPS) return { ...x, start: Math.max(0, x.start + delta) };
    return x;
  });
}
