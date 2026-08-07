// Helpers for the managed media library. The library is the union of imported assets
// (Timeline-independent video/image/model/audio in ProjectData.assets) and recorded LiDAR takes
// (Timeline.trackingTakes). Usage is computed by path equality against EVERY place an asset path can
// be referenced: surfaces (live + every captured scene's look snapshot), scene3D models (same), clips
// on every timeline (the global one plus each scene's own; video paths, content urls, and that
// timeline's own audio clips), and the audio bed's clips.
import type { AssetEntry, AssetType, AudioClip, Surface, Timeline, TrackingTakeRef } from '../types';
import type { Scene3D } from '../../../shared/protocol';
import { SourceType, timelineAudioClips } from '../types';

// Normalize a path for cross-reference equality (Windows: backslashes + case-insensitive).
export const normPath = (p: string): string => (p || '').replace(/\\/g, '/').toLowerCase();

export interface AssetUsage {
  surfaceIds: string[];
  modelIds: string[];
  clipIds: string[];
  audioClipIds: string[];
  count: number;
}

// EVERY place a path can live. This is what gates deletion (App.handleRemoveAsset only raises its
// confirm dialog when `count > 0`), so anything missing from here is an asset the app will delete with
// NO WARNING AT ALL — losing missing-file detection, Relink and Collect Assets coverage for a file that
// is still on air.
export interface ProjectRefs {
  // The LIVE surfaces, followed by each captured Scene's `surfaces` look snapshot — flattened. Ids WILL
  // repeat across these lists (see the Set dedupe in usageIndex).
  surfaces: Surface[];
  // The LIVE scene3D, followed by each Scene's own. Same aliasing, same dedupe.
  scene3D: (Scene3D | null | undefined)[];
  // The GLOBAL timeline + every scene's own — an asset used only inside a scene's timeline used to read
  // as UNUSED. Every path-bearing field of each one is counted: a video clip's `path`, a generalized
  // content clip's `content.url`, and (Wave B) that timeline's OWN audio clips (Timeline.audio.clips).
  timelines: Timeline[];
  // The global audio bed's clips (ProjectData.audio.clips — the BED, not a timeline's own audio, which
  // arrives through `timelines` above). An audio file used only on the bed had no field to be counted
  // in at all, so it read as 0 uses and was deleted silently.
  audioClips: AudioClip[];
}

// Build a usage map for every distinct path referenced across the project in ONE pass over
// surfaces/models/timelines/audio, instead of one pass per asset. Panels that render usage for a whole
// asset list (MediaPanel) should call this once per render and look each asset up in
// the result, rather than calling usageForPath per asset — see those files for the useMemo wiring.
//
// EVERY id bucket is a Set. Capture Scene deep-clones the active timeline into a new scene
// (`structuredClone(activeTimeline)` in App.handleCaptureScene, which PRESERVES ids) and stashes the
// live `surfaces`/`scene3D` arrays onto the Scene BY REFERENCE (buildSceneSnapshot), so the same clip,
// surface and model ids legitimately appear in the global doc AND in every scene captured from it.
// Counting raw pushes would multiply one authored reference by (1 + #scenes) — an inflated badge, and
// duplicate React keys in a usage list. (This exact defect was found and fixed once for
// clip ids in this branch; widening ProjectRefs to the scene snapshots re-exposes it for surfaces and
// models, hence the Set on all four.)
export function usageIndex(refs: ProjectRefs): Map<string, AssetUsage> {
  type Buckets = { s: Set<string>; m: Set<string>; c: Set<string>; a: Set<string> };
  const sets = new Map<string, Buckets>();
  const at = (key: string): Buckets => {
    let b = sets.get(key);
    if (!b) { b = { s: new Set(), m: new Set(), c: new Set(), a: new Set() }; sets.set(key, b); }
    return b;
  };
  for (const s of refs.surfaces) {
    const url = (s.content as { url?: string })?.url;
    if (url) at(normPath(url)).s.add(s.id);
  }
  for (const sc of refs.scene3D) {
    for (const m of sc?.models ?? []) if (m.path) at(normPath(m.path)).m.add(m.id);
  }
  for (const tl of refs.timelines) {
    for (const c of tl.clips ?? []) {
      if (c.path) at(normPath(c.path)).c.add(c.id);
      // A generalized content clip carries its file on `content.url` — mapAssetPaths maps it, this index
      // never counted it. An image placed by drag-and-drop was deletable with NO warning at all.
      const cu = (c.content as { url?: string } | undefined)?.url;
      if (cu) at(normPath(cu)).c.add(c.id);
    }
    // NB: `trackingTakes[].path` is deliberately NOT counted here, even though mapAssetPaths maps it.
    // A take's library entry IS its trackingTakes row (takeToAsset), so counting the row would make
    // every take report a use OF ITSELF: the delete confirm would fire for an unplaced take, and
    // a usage list would render the take's own id as one of its "clip" rows. A take that is
    // actually USED is a clip, and a take clip carries `path: ref.path` (Timeline.tsx's take drop), so
    // it is already counted by the loop above — which is what gates the confirm.
    // Wave B: this timeline's OWN audio. Derived from `timelines` rather than a new ProjectRefs field,
    // because the list App passes already spans the global doc + every scene's timeline.
    for (const c of timelineAudioClips(tl)) if (c.path) at(normPath(c.path)).a.add(c.id);
  }
  for (const c of refs.audioClips) {
    if (c.path) at(normPath(c.path)).a.add(c.id);
  }
  const map = new Map<string, AssetUsage>();
  for (const [key, b] of sets) {
    const u: AssetUsage = {
      surfaceIds: [...b.s], modelIds: [...b.m], clipIds: [...b.c], audioClipIds: [...b.a], count: 0,
    };
    // count is derived from the DEDUPED id lists, so it always equals the number of usage ROWS
    // a consumer renders — the count and the list it summarizes must never disagree.
    u.count = u.surfaceIds.length + u.modelIds.length + u.clipIds.length + u.audioClipIds.length;
    map.set(key, u);
  }
  return map;
}

const EMPTY_USAGE: Readonly<AssetUsage> = { surfaceIds: [], modelIds: [], clipIds: [], audioClipIds: [], count: 0 };

// Where is this file path referenced across the project? Single-path convenience wrapper around
// usageIndex — fine for one-off lookups (e.g. App.handleRemoveAsset's delete-confirm, which only
// ever checks the one asset being removed). Callers that need usage for many assets in the same
// render (asset-list panels) should call usageIndex() once instead; see its comment for why.
//
// What COUNT means: this number answers "will deleting this asset break something?" for the
// confirm-before-delete prompt (and the badge that hints at it). A clip/surface/model that was cloned
// into N scenes by Capture Scene is still the ONE thing the user placed — deleting the underlying file
// breaks that one authored reference everywhere it was cloned, which reads to the user as "used in 1
// place", not N. Counting deduped ids also keeps `count` equal to the number of usage ROWS
// a consumer renders — the count and the list it summarizes must never disagree.
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
//
// ⚠ That was ASPIRATIONAL until 2026-08-06 and this file was the only place saying it. The recorder
// committed through the bound document, so a take recorded while a scene was on air went into THAT
// SCENE — invisible here, and unplaceable on any other timeline. services/takeRecorder now writes the
// ref to the global doc explicitly (host.commitGlobal), and App hoists any stranded ones on open. Pass
// this the GLOBAL timeline, never the bound one.
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
