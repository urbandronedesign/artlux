import React, { useEffect, useMemo, useState } from 'react';
import { Film, Image as ImageIcon, Box, Music, FolderOpen, Link2, Trash2, MonitorPlay, Search } from 'lucide-react';
import { AssetEntry, AssetType, Timeline, timelineAudioClips } from '../types';
import { AssetChip } from './AssetChip';
import { libraryItems, usageIndex, normPath, typeLabel, type ProjectRefs } from '../services/assetLibrary';

interface Props {
  assets: AssetEntry[];
  timeline: Timeline;      // the GLOBAL doc — the take library lives on it (libraryItems)
  // EVERY place a path can be referenced (live + every scene's snapshot + every timeline + the audio
  // bed). Built once in App; usage counting must see all of it or the badge under-reports and the
  // delete confirmation never fires.
  refs: ProjectRefs;
  selectedSurfaceId: string | null;
  hasProjectFolder: boolean;
  onImport: (type: AssetType) => void;
  onRemoveAsset: (asset: AssetEntry) => void;
  onRelinkAsset: (asset: AssetEntry) => void;
  onUseOnSurface: (asset: AssetEntry) => void;
  /** Jump to a surface from the usage list. */
  onSelectSurface: (id: string) => void;
}

type Filter = 'all' | AssetType;

const fmtBytes = (n?: number) => n == null ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

// Left-sidebar media library. Lists imported assets + recorded takes; drag a tile onto the Stage
// or the Timeline to place it. Import copies files into the project's assets/ folder.
//
// Selecting a tile opens the INSPECTOR at the bottom: metadata plus the resolved Usage list. That was
// a separate full-width "Asset Manager" panel until 2026-07-23; carrying both meant the same grid on
// screen twice, so the manager was deleted and the one part it uniquely had — this inspector — moved
// here. The usage rows resolve names across EVERY timeline / surface list / scene3D the index was
// built from, because an id can come from a captured scene rather than the live doc.
export const MediaPanel: React.FC<Props> = ({ assets, timeline, refs, selectedSurfaceId, hasProjectFolder, onImport, onRemoveAsset, onRelinkAsset, onUseOnSurface, onSelectSurface }) => {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());

  const items = useMemo(() => libraryItems(assets, timeline), [assets, timeline]);

  // Missing-on-disk detection (batched).
  useEffect(() => {
    let live = true;
    const paths = items.map(i => i.path);
    if (!paths.length) { setMissing(new Set()); return; }
    void window.artlux?.assetExists?.(paths).then((res) => {
      if (!live || !res) return;
      const m = new Set<string>();
      paths.forEach((p, i) => { if (res[i] === false) m.add(normPath(p)); });
      setMissing(m);
    });
    return () => { live = false; };
  }, [items]);

  const filtered = items.filter(a =>
    (filter === 'all' || a.type === filter) &&
    (!query || a.name.toLowerCase().includes(query.toLowerCase())));

  const selected = items.find(a => a.id === selectedId) ?? null;
  // One index built per render (not one usageForPath() scan per asset) — MediaPanel is an
  // always-mounted sidebar, so this recomputes on every App state change; Capture Scene cloning the
  // timeline into each scene made the per-asset scan cost scale with (1 + #scenes).
  const usage = useMemo(() => usageIndex(refs), [refs]);
  const usageOf = (a: AssetEntry) => usage.get(normPath(a.path))?.count ?? 0;
  const selUsage = selected ? usage.get(normPath(selected.path)) ?? null : null;

  // Usage spans every timeline, every surface list and every scene3D, so an id can come from a
  // CAPTURED SCENE rather than the live doc — resolve names across the same lists the index was built
  // from, or a scene-only reference renders as a raw uuid in the very audit that justifies an
  // irreversible Delete/Relink click.
  const surfName = (id: string) => refs.surfaces.find(s => s.id === id)?.name ?? id;
  const clipName = (id: string) => {
    for (const tl of refs.timelines) { const c = tl.clips.find(cl => cl.id === id); if (c) return c.name; }
    return id;
  };
  const modelName = (id: string) => {
    for (const sc of refs.scene3D) { const m = sc?.models?.find(mm => mm.id === id); if (m) return m.name; }
    return id;
  };
  // An audio usage row can be a BED clip (refs.audioClips) OR a clip on any timeline's own audio —
  // both land in the same `audioClipIds` bucket, so resolve across both lists.
  const audioClipName = (id: string) => {
    const bed = refs.audioClips.find(c => c.id === id);
    if (bed) return bed.name;
    for (const tl of refs.timelines) { const c = timelineAudioClips(tl).find(cl => cl.id === id); if (c) return c.name; }
    return id;
  };

  const chip = (label: string, value: Filter, icon?: React.ReactNode) => (
    <button onClick={() => setFilter(value)}
      className={`inline-flex items-center gap-1 px-1.5 h-5 rounded text-micro border ${filter === value ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}>
      {icon}{label}
    </button>
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-1 text-xs">
      {/* header */}
      <div className="h-8 px-2 flex items-center justify-between border-b border-line-1 bg-surface-2 shrink-0">
        <span className="text-mini font-semibold text-fg-1">Media Library</span>
      </div>

      {/* import + project-folder hint */}
      <div className="px-2 py-1.5 flex items-center gap-1 border-b border-line-1">
        <span className="text-micro text-fg-3 mr-1">Import</span>
        <button onClick={() => onImport('video')} disabled={!hasProjectFolder} title="Import video" className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40"><Film size={12} /></button>
        <button onClick={() => onImport('image')} disabled={!hasProjectFolder} title="Import image" className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40"><ImageIcon size={12} /></button>
        <button onClick={() => onImport('model')} disabled={!hasProjectFolder} title="Import 3D model" className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40"><Box size={12} /></button>
        <button onClick={() => onImport('audio')} disabled={!hasProjectFolder} title="Import audio" className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40"><Music size={12} /></button>
      </div>
      {!hasProjectFolder && (
        <div className="px-2 py-1 text-micro text-warn border-b border-line-1">Create a project folder (File → New Project) to import media.</div>
      )}

      {/* filter + search */}
      <div className="px-2 py-1.5 flex flex-wrap items-center gap-1 border-b border-line-1">
        {chip('All', 'all')}
        {chip('Video', 'video', <Film size={10} />)}
        {chip('Image', 'image', <ImageIcon size={10} />)}
        {chip('Model', 'model', <Box size={10} />)}
        {chip('Take', 'take')}
        {chip('Audio', 'audio', <Music size={10} />)}
        <div className="flex items-center gap-1 ml-auto bg-surface-2 border border-line-1 rounded px-1 h-5">
          <Search size={10} className="text-fg-3" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search"
            className="bg-transparent outline-none text-micro w-20 text-fg-1" />
        </div>
      </div>

      {/* grid */}
      <div className="flex-1 min-h-0 overflow-auto p-2">
        {filtered.length === 0 ? (
          <div className="text-fg-3 italic text-mini px-1 py-2">No media. Import files or record a take.</div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {filtered.map(a => (
              <AssetChip key={a.id} asset={a} usageCount={usageOf(a)} missing={missing.has(normPath(a.path))}
                selected={selectedId === a.id}
                onClick={() => setSelectedId(a.id)}
                onDoubleClick={() => { if ((a.type === 'video' || a.type === 'image') && selectedSurfaceId) onUseOnSurface(a); }} />
            ))}
          </div>
        )}
      </div>

      {/* Selected-asset INSPECTOR — metadata, actions, and where the asset is actually used.
          This is what the separate Asset Manager panel used to show; it lives here now so there is one
          media surface instead of two showing the same grid. Capped height + its own scroll so a
          heavily-used asset can never squeeze the library above it out of view. */}
      {selected && (
        <div className="border-t border-line-1 p-2 space-y-1.5 bg-surface-1 shrink-0 max-h-[46%] overflow-y-auto">
          <div className="text-mini text-fg-1 break-words">{selected.name}</div>
          <div className="text-micro text-fg-3 space-y-0.5">
            <div>{typeLabel[selected.type]}{selected.size ? ` · ${fmtBytes(selected.size)}` : ''}</div>
            {selected.durationSec != null && <div>{selected.durationSec.toFixed(1)}s{selected.fps ? ` · ${selected.fps}fps` : ''}</div>}
            {(selected.width && selected.height) ? <div className="num">{selected.width}×{selected.height}</div> : null}
            <div className="break-all text-fg-3/80" title={selected.path}>{selected.path}</div>
            {missing.has(normPath(selected.path)) && <div className="text-warn">Missing on disk — relink to fix.</div>}
          </div>
          <div className="flex items-center gap-1">
            {(selected.type === 'video' || selected.type === 'image') && (
              <button onClick={() => onUseOnSurface(selected)} disabled={!selectedSurfaceId} title={selectedSurfaceId ? 'Set as the selected surface’s content' : 'Select a surface first'}
                className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40 text-micro"><MonitorPlay size={11} /> Use</button>
            )}
            <button onClick={() => window.artlux?.showItemInFolder?.(selected.path)} title="Reveal in folder"
              className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 text-micro"><FolderOpen size={11} /></button>
            <button onClick={() => onRelinkAsset(selected)} title="Relink (locate the file)"
              className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 text-micro"><Link2 size={11} /></button>
            <button onClick={() => onRemoveAsset(selected)} title="Remove from library"
              className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-danger/20 hover:text-danger text-micro ml-auto"><Trash2 size={11} /></button>
          </div>

          <div>
            <div className="text-micro font-semibold text-fg-2 mb-1">Usage {selUsage ? `(${selUsage.count})` : ''}</div>
            {selUsage && selUsage.count === 0 && <div className="text-micro text-fg-3 italic">Not used anywhere.</div>}
            <div className="space-y-0.5">
              {selUsage?.surfaceIds.map(id => (
                <button key={`s${id}`} onClick={() => onSelectSurface(id)} title="Select this surface"
                  className="block w-full text-left text-micro px-1.5 py-1 rounded bg-surface-2 hover:bg-surface-3 text-fg-1 truncate">Surface · {surfName(id)}</button>
              ))}
              {selUsage?.clipIds.map(id => (
                <div key={`c${id}`} className="text-micro px-1.5 py-1 rounded bg-surface-2 text-fg-2 truncate">Clip · {clipName(id)}</div>
              ))}
              {selUsage?.modelIds.map(id => (
                <div key={`m${id}`} className="text-micro px-1.5 py-1 rounded bg-surface-2 text-fg-2 truncate">Scene model · {modelName(id)}</div>
              ))}
              {selUsage?.audioClipIds.map(id => (
                <div key={`a${id}`} className="text-micro px-1.5 py-1 rounded bg-surface-2 text-fg-2 truncate">Audio clip · {audioClipName(id)}</div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
