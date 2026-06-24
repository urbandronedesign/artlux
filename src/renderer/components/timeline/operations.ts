import { VideoClip } from '../../types';

// Pure clip-array mutations for the NLE timeline. Each returns a new array; callers wrap the
// result in onChange({ ...timeline, clips }). None of these touch the playback engine.

const EPS = 1e-4;
const uid = () => crypto.randomUUID();

// Split a clip at absolute timeline time t into two clips sharing the source. No-op if t isn't
// strictly inside the clip.
export function splitClipAt(clips: VideoClip[], clipId: string, t: number): VideoClip[] {
  const c = clips.find(x => x.id === clipId);
  if (!c || t <= c.start + EPS || t >= c.start + c.duration - EPS) return clips;
  const leftDur = t - c.start;
  const left: VideoClip = { ...c, duration: leftDur };
  const right: VideoClip = { ...c, id: uid(), start: t, inPoint: c.inPoint + leftDur, duration: c.duration - leftDur };
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
export function liftDelete(clips: VideoClip[], clipId: string): VideoClip[] {
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
