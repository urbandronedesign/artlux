import { Timeline } from '../../types';

// Magnetic snapping: collect candidate snap times from the timeline, then snap a dragged value
// to the nearest one within a threshold. Pure — the component draws the guide imperatively.

export type SnapKind = 'clipEdge' | 'playhead' | 'marker' | 'trackStart' | 'inOut';
export interface SnapPoint { t: number; kind: SnapKind; }
export interface SnapResult { t: number; snapped: boolean; guideTime: number | null; }

export function collectSnapPoints(tl: Timeline, playhead: number, excludeClipId?: string): SnapPoint[] {
  const pts: SnapPoint[] = [{ t: 0, kind: 'trackStart' }, { t: playhead, kind: 'playhead' }];
  if (tl.inPoint != null) pts.push({ t: tl.inPoint, kind: 'inOut' });
  if (tl.outPoint != null) pts.push({ t: tl.outPoint, kind: 'inOut' });
  for (const m of tl.markers ?? []) pts.push({ t: m.time, kind: 'marker' });
  for (const c of tl.clips) {
    if (c.id === excludeClipId) continue;
    pts.push({ t: c.start, kind: 'clipEdge' }, { t: c.start + c.duration, kind: 'clipEdge' });
  }
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
