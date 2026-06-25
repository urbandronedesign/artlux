// Helpers for the managed media library. The library is the union of imported assets
// (Timeline-independent video/image/model in ProjectData.assets) and recorded LiDAR takes
// (Timeline.trackingTakes). Usage is computed by path equality against everywhere an asset path
// can be referenced — surfaces, scene models, and timeline clips (video + tracking).
import type { AssetEntry, AssetType, Surface, Timeline, TrackingTakeRef } from '../types';
import type { Scene3D } from '../../../shared/protocol';
import { SourceType } from '../types';

// Normalize a path for cross-reference equality (Windows: backslashes + case-insensitive).
export const normPath = (p: string): string => (p || '').replace(/\\/g, '/').toLowerCase();

export interface AssetUsage {
  surfaceIds: string[];
  modelIds: string[];
  clipIds: string[];
  count: number;
}

export interface ProjectRefs {
  surfaces: Surface[];
  scene3D?: Scene3D | null;
  timeline: Timeline;
}

// Where is this file path referenced across the project?
export function usageForPath(path: string, refs: ProjectRefs): AssetUsage {
  const key = normPath(path);
  const surfaceIds: string[] = [];
  const modelIds: string[] = [];
  const clipIds: string[] = [];
  for (const s of refs.surfaces) {
    const url = (s.content as { url?: string })?.url;
    if (url && normPath(url) === key) surfaceIds.push(s.id);
  }
  for (const m of refs.scene3D?.models ?? []) {
    if (m.path && normPath(m.path) === key) modelIds.push(m.id);
  }
  for (const c of refs.timeline.clips ?? []) {
    if (c.path && normPath(c.path) === key) clipIds.push(c.id);
  }
  return { surfaceIds, modelIds, clipIds, count: surfaceIds.length + modelIds.length + clipIds.length };
}

// A recorded take presented as an AssetEntry (so the library renders one unified list).
export const takeToAsset = (t: TrackingTakeRef): AssetEntry => ({
  id: t.id, name: t.name, type: 'take', path: t.path, durationSec: t.duration, fps: t.fps,
});

// The unified library list: imported assets + recorded takes.
export function libraryItems(assets: AssetEntry[] | undefined, timeline: Timeline): AssetEntry[] {
  const imported = assets ?? [];
  const takes = (timeline.trackingTakes ?? []).map(takeToAsset);
  // De-dupe by path in case a take was also imported.
  const seen = new Set(imported.map(a => normPath(a.path)));
  return [...imported, ...takes.filter(t => !seen.has(normPath(t.path)))];
}

export const ASSET_TYPES: AssetType[] = ['video', 'image', 'model', 'take'];

export const typeLabel: Record<AssetType, string> = {
  video: 'Video', image: 'Image', model: '3D Model', take: 'Take',
};

// Map a library asset to the SurfaceContent type it can fill (video/image only).
export const surfaceTypeFor = (type: AssetType): SourceType | null =>
  type === 'video' ? SourceType.VIDEO : type === 'image' ? SourceType.IMAGE : null;
