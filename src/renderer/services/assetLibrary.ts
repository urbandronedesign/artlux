// Helpers for the managed media library. The library is the union of imported assets
// (Timeline-independent video/image/model in ProjectData.assets) and recorded LiDAR takes
// (Timeline.trackingTakes). Usage is computed by path equality against everywhere an asset path
// can be referenced — surfaces, scene models, and clips on EVERY timeline (the global one plus each
// scene's own; video + tracking).
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
  timelines: Timeline[];   // the GLOBAL timeline + every scene's own — an asset used only inside a
                           // scene's timeline used to read as UNUSED, and that count gates deletion.
}

// Build a usage map for every distinct path referenced across the project in ONE pass over
// surfaces/models/timelines, instead of one pass per asset. Panels that render usage for a whole
// asset list (MediaPanel, AssetManager) should call this once per render and look each asset up in
// the result, rather than calling usageForPath per asset — see those files for the useMemo wiring.
export function usageIndex(refs: ProjectRefs): Map<string, AssetUsage> {
  const map = new Map<string, AssetUsage>();
  const at = (key: string): AssetUsage => {
    let u = map.get(key);
    if (!u) { u = { surfaceIds: [], modelIds: [], clipIds: [], count: 0 }; map.set(key, u); }
    return u;
  };
  for (const s of refs.surfaces) {
    const url = (s.content as { url?: string })?.url;
    // Surfaces and scene3D are always the single CURRENT doc here (ProjectRefs has no per-scene
    // surfaces/scene3D lists — only `timelines` is widened to span every scene), so unlike clips
    // below there is no cross-scene cloning path that could hand us the same surface/model id twice.
    // Capture Scene's buildSceneSnapshot() does stash `surfaces`/`scene3D` by reference onto each
    // Scene, but usageForPath/usageIndex never read Scene.surfaces or Scene.scene3D — only the live
    // ones passed in via ProjectRefs — so that aliasing is unreachable from here. No Set needed.
    if (url) at(normPath(url)).surfaceIds.push(s.id);
  }
  for (const m of refs.scene3D?.models ?? []) {
    if (m.path) at(normPath(m.path)).modelIds.push(m.id);
  }
  // Clip ids DO need deduping: Capture Scene deep-clones the active timeline into a new scene
  // (`structuredClone(activeTimeline)` in App.handleCaptureScene) and structuredClone preserves ids,
  // so the same clip id legitimately appears in the global timeline AND every scene it was captured
  // into. Lazy materialization can even leave scene.timeline.clips as the *same array object* as the
  // global timeline's, until the scene's timeline is first edited. Collect ids into a Set per path so
  // one authored clip that was cloned into N scenes is counted/rendered once, not N times.
  const clipSets = new Map<string, Set<string>>();
  for (const tl of refs.timelines) {
    for (const c of tl.clips ?? []) {
      if (!c.path) continue;
      const key = normPath(c.path);
      let set = clipSets.get(key);
      if (!set) { set = new Set<string>(); clipSets.set(key, set); }
      set.add(c.id);
    }
  }
  for (const [key, set] of clipSets) {
    const u = at(key);
    u.clipIds = Array.from(set);
  }
  // count is derived last so it reflects the deduped clip totals, not raw push counts.
  for (const u of map.values()) u.count = u.surfaceIds.length + u.modelIds.length + u.clipIds.length;
  return map;
}

const EMPTY_USAGE: Readonly<AssetUsage> = { surfaceIds: [], modelIds: [], clipIds: [], count: 0 };

// Where is this file path referenced across the project? Single-path convenience wrapper around
// usageIndex — fine for one-off lookups (e.g. App.handleRemoveAsset's delete-confirm, which only
// ever checks the one asset being removed). Callers that need usage for many assets in the same
// render (asset-list panels) should call usageIndex() once instead; see its comment for why.
//
// What COUNT means: this number answers "will deleting this asset break something?" for the
// confirm-before-delete prompt (and the badge that hints at it). A clip that was cloned into N
// scenes by Capture Scene is still the ONE clip the user placed — deleting the underlying file
// breaks that one authored clip everywhere it was cloned, which reads to the user as "used in 1
// place", not N. Counting deduped ids also keeps `count` equal to the number of usage ROWS
// AssetManager renders (surfaceIds.length + modelIds.length + clipIds.length after dedup) — the
// count and the list it summarizes must never disagree.
export function usageForPath(path: string, refs: ProjectRefs): AssetUsage {
  return usageIndex(refs).get(normPath(path)) ?? EMPTY_USAGE;
}

// A recorded take presented as an AssetEntry (so the library renders one unified list).
export const takeToAsset = (t: TrackingTakeRef): AssetEntry => ({
  id: t.id, name: t.name, type: 'take', path: t.path, durationSec: t.duration, fps: t.fps,
});

// The unified library list: imported assets + recorded takes. Single-timeline ON PURPOSE — tracking
// takes are recorded into the GLOBAL timeline's trackingTakes, so the library is a global-doc list.
// (Usage counting is the thing that must span every timeline; see usageForPath.)
export function libraryItems(assets: AssetEntry[] | undefined, timeline: Timeline): AssetEntry[] {
  const imported = assets ?? [];
  const takes = (timeline.trackingTakes ?? []).map(takeToAsset);
  // De-dupe by path in case a take was also imported.
  const seen = new Set(imported.map(a => normPath(a.path)));
  return [...imported, ...takes.filter(t => !seen.has(normPath(t.path)))];
}

export const ASSET_TYPES: AssetType[] = ['video', 'image', 'model', 'take', 'audio'];

export const typeLabel: Record<AssetType, string> = {
  video: 'Video', image: 'Image', model: '3D Model', take: 'Take', audio: 'Audio',
};

// Map a library asset to the SurfaceContent type it can fill (video/image only).
export const surfaceTypeFor = (type: AssetType): SourceType | null =>
  type === 'video' ? SourceType.VIDEO : type === 'image' ? SourceType.IMAGE : null;
