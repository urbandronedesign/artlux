import React, { useEffect, useMemo, useState } from 'react';
import { Film, Image as ImageIcon, Box, FolderOpen, Link2, Trash2, Maximize2, MonitorPlay, Search } from 'lucide-react';
import { AssetEntry, AssetType, Surface, Timeline } from '../types';
import type { Scene3D } from '../../../shared/protocol';
import { AssetChip } from './AssetChip';
import { libraryItems, usageForPath, normPath } from '../services/assetLibrary';

interface Props {
  assets: AssetEntry[];
  timeline: Timeline;
  surfaces: Surface[];
  scene3D?: Scene3D | null;
  selectedSurfaceId: string | null;
  hasProjectFolder: boolean;
  onImport: (type: AssetType) => void;
  onRemoveAsset: (asset: AssetEntry) => void;
  onRelinkAsset: (asset: AssetEntry) => void;
  onUseOnSurface: (asset: AssetEntry) => void;
  onOpenManager: () => void;
}

type Filter = 'all' | AssetType;

// Left-sidebar media library. Lists imported assets + recorded takes; drag a tile onto the Stage
// or the Timeline to place it. Import copies files into the project's assets/ folder.
export const MediaPanel: React.FC<Props> = ({ assets, timeline, surfaces, scene3D, selectedSurfaceId, hasProjectFolder, onImport, onRemoveAsset, onRelinkAsset, onUseOnSurface, onOpenManager }) => {
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
  const usageOf = (a: AssetEntry) => usageForPath(a.path, { surfaces, scene3D, timeline }).count;

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
        <button onClick={onOpenManager} title="Open full Asset Manager" className="text-fg-3 hover:text-fg-1"><Maximize2 size={13} /></button>
      </div>

      {/* import + project-folder hint */}
      <div className="px-2 py-1.5 flex items-center gap-1 border-b border-line-1">
        <span className="text-micro text-fg-3 mr-1">Import</span>
        <button onClick={() => onImport('video')} disabled={!hasProjectFolder} title="Import video" className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40"><Film size={12} /></button>
        <button onClick={() => onImport('image')} disabled={!hasProjectFolder} title="Import image" className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40"><ImageIcon size={12} /></button>
        <button onClick={() => onImport('model')} disabled={!hasProjectFolder} title="Import 3D model" className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40"><Box size={12} /></button>
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

      {/* selected asset actions */}
      {selected && (
        <div className="border-t border-line-1 p-2 space-y-1.5 bg-surface-1 shrink-0">
          <div className="text-micro text-fg-2 truncate">{selected.name}</div>
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
        </div>
      )}
    </div>
  );
};
