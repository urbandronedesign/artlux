import { Timeline } from '../../types';

// Magnetic snapping: collect candidate snap times from the timeline, then snap a dragged value
// to the nearest one within a threshold. Pure — the component draws the guide imperatively.

export type SnapKind = 'clipEdge' | 'playhead' | 'marker' | 'trackStart' | 'inOut';
export interface SnapPoint { t: number; kind: SnapKind; }
export interface SnapResult { t: number; snapped: boolean; guideTime: number | null; }

// `excludeClipId` / `excludeRegion`: a dragged thing must never snap to ITS OWN current position, or
// the first 8 px of every drag land back on the value you started from — a dead zone the handle refuses
// to leave, followed by a jump once you clear it. The clip drag has always excluded itself; the loop
// region's in/out handles are dragged the same way and need the same exclusion.
// `extra`: snap points the CALLER supplies — audio clip edges, which live in a different array (the bed's
// AudioMix.clips, or Timeline.audio.clips) that this function has no business knowing about. The same
// exclusion rule applies to them: the caller must leave out the clip being dragged.
export function collectSnapPoints(tl: Timeline, playhead: number, excludeClipId?: string, excludeRegion?: 'in' | 'out', extra?: SnapPoint[]): SnapPoint[] {
  const pts: SnapPoint[] = [{ t: 0, kind: 'trackStart' }, { t: playhead, kind: 'playhead' }];
  if (tl.inPoint != null && excludeRegion !== 'in') pts.push({ t: tl.inPoint, kind: 'inOut' });
  if (tl.outPoint != null && excludeRegion !== 'out') pts.push({ t: tl.outPoint, kind: 'inOut' });
  for (const m of tl.markers ?? []) pts.push({ t: m.time, kind: 'marker' });
  for (const c of tl.clips) {
    if (c.id === excludeClipId) continue;
    pts.push({ t: c.start, kind: 'clipEdge' }, { t: c.start + c.duration, kind: 'clipEdge' });
  }
  if (extra) for (const p of extra) pts.push(p);
  return pts;
}

export function snap(value: number, points: SnapPoint[], thresholdSec: number): SnapResult {
  let best: SnapPoint | null = null;
  let bestD = thresholdSec;
  for (const p of points) {
    const d = Math.abs(p.t - value);
    if (d <= bestD) { bestD = d; best = p; }
  }
  return best ? { t: best.t, snapped: true, guideTime: best.t } : { t: value, snapped: false, guideTime: null };
}
