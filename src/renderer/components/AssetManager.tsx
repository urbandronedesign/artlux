import React, { useEffect, useMemo, useState } from 'react';
import { X, Film, Image as ImageIcon, Box, Music, FolderOpen, Link2, Trash2, MonitorPlay, PackageCheck, Search } from 'lucide-react';
import { AssetEntry, AssetType, Surface, Timeline } from '../types';
import type { Scene3D } from '../../../shared/protocol';
import { AssetChip } from './AssetChip';
import { libraryItems, usageIndex, normPath, typeLabel } from '../services/assetLibrary';
import { useDraggableModal } from '../hooks/useDraggableModal';

interface Props {
  open: boolean;
  onClose: () => void;
  assets: AssetEntry[];
  timeline: Timeline;      // the GLOBAL doc — the take library lives on it (libraryItems)
  timelines: Timeline[];   // EVERY timeline (global + each scene's) — usage counting must see them all
  surfaces: Surface[];
  scene3D?: Scene3D | null;
  selectedSurfaceId: string | null;
  hasProjectFolder: boolean;
  onImport: (type: AssetType) => void;
  onRemoveAsset: (asset: AssetEntry) => void;
  onRelinkAsset: (asset: AssetEntry) => void;
  onUseOnSurface: (asset: AssetEntry) => void;
  onSelectSurface: (id: string) => void;
  onConsolidate: () => void;
}

type Filter = 'all' | AssetType;

const fmtBytes = (n?: number) => n == null ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

// Full-screen asset manager: browse media, inspect usage + metadata, relink/reveal/remove, and
// consolidate everything into the project folder. Reuses the modal/overlay pattern (z-50).
export const AssetManager: React.FC<Props> = (p) => {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());

  const items = useMemo(() => libraryItems(p.assets, p.timeline), [p.assets, p.timeline]);
  // One index built per render instead of one usageForPath() scan per asset per grid cell — see
  // usageIndex's comment in assetLibrary.ts.
  const usageMap = useMemo(
    () => usageIndex({ surfaces: p.surfaces, scene3D: p.scene3D, timelines: p.timelines }),
    [p.surfaces, p.scene3D, p.timelines],
  );

  useEffect(() => {
    if (!p.open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p.open, p.onClose]);

  useEffect(() => {
    if (!p.open) return;
    let live = true;
    const paths = items.map(i => i.path);
    if (!paths.length) { setMissing(new Set()); return; }
    void window.artlux?.assetExists?.(paths).then((res) => {
      if (!live || !res) return;
      const m = new Set<string>();
      paths.forEach((path, i) => { if (res[i] === false) m.add(normPath(path)); });
      setMissing(m);
    });
    return () => { live = false; };
  }, [items, p.open]);

  const { positionerStyle, handleProps } = useDraggableModal('assets');

  if (!p.open) return null;

  const filtered = items.filter(a =>
    (filter === 'all' || a.type === filter) &&
    (!query || a.name.toLowerCase().includes(query.toLowerCase())));
  const selected = items.find(a => a.id === selectedId) ?? null;
  const usage = selected ? usageMap.get(normPath(selected.path)) ?? null : null;

  const surfName = (id: string) => p.surfaces.find(s => s.id === id)?.name ?? id;
  // Usage now spans every timeline, so a clip id can come from a scene's own doc — look through them all.
  const clipName = (id: string) => {
    for (const tl of p.timelines) { const c = tl.clips.find(cl => cl.id === id); if (c) return c.name; }
    return id;
  };
  const modelName = (id: string) => p.scene3D?.models?.find(m => m.id === id)?.name ?? id;

  const filterBtn = (label: string, value: Filter) => (
    <button onClick={() => setFilter(value)}
      className={`px-2 h-6 rounded text-mini border ${filter === value ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}>{label}</button>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/60 animate-overlay-in flex items-center justify-center" onClick={p.onClose}>
      <div style={positionerStyle}>
      <div role="dialog" aria-modal="true" aria-label="Asset Manager"
        className="w-[1000px] max-w-[96vw] h-[80vh] max-h-[88vh] flex flex-col bg-surface-1 border border-line-2 rounded-lg shadow-e3 animate-modal-in"
        onClick={(e) => e.stopPropagation()}>
        {/* header — drag handle */}
        <div {...handleProps} className="h-11 px-3 flex items-center gap-2 border-b border-line-1 bg-surface-2 shrink-0 cursor-move select-none">
          <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider">Asset Manager</span>
          <div className="flex items-center gap-1 ml-3">
            <button onClick={() => p.onImport('video')} disabled={!p.hasProjectFolder} className="inline-flex items-center gap-1 px-2 h-7 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40 text-mini"><Film size={12} /> Video</button>
            <button onClick={() => p.onImport('image')} disabled={!p.hasProjectFolder} className="inline-flex items-center gap-1 px-2 h-7 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40 text-mini"><ImageIcon size={12} /> Image</button>
            <button onClick={() => p.onImport('model')} disabled={!p.hasProjectFolder} className="inline-flex items-center gap-1 px-2 h-7 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40 text-mini"><Box size={12} /> Model</button>
            <button onClick={() => p.onImport('audio')} disabled={!p.hasProjectFolder} className="inline-flex items-center gap-1 px-2 h-7 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40 text-mini"><Music size={12} /> Audio</button>
          </div>
          <button onClick={p.onConsolidate} disabled={!p.hasProjectFolder} title="Copy every asset into the project folder + relink"
            className="inline-flex items-center gap-1 px-2 h-7 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40 text-mini ml-auto"><PackageCheck size={13} /> Consolidate</button>
          <button onClick={p.onClose} className="text-fg-3 hover:text-fg-1 ml-1"><X size={16} /></button>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* grid */}
          <div className="flex-1 min-w-0 flex flex-col border-r border-line-1">
            <div className="px-3 py-2 flex items-center gap-1 border-b border-line-1">
              {filterBtn('All', 'all')}{filterBtn('Video', 'video')}{filterBtn('Image', 'image')}{filterBtn('Model', 'model')}{filterBtn('Take', 'take')}{filterBtn('Audio', 'audio')}
              <div className="flex items-center gap-1 ml-auto bg-surface-2 border border-line-1 rounded px-1.5 h-6">
                <Search size={11} className="text-fg-3" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search" className="bg-transparent outline-none text-mini w-32 text-fg-1" />
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-3">
              {filtered.length === 0 ? <div className="text-fg-3 italic px-1 py-2">No media.</div> : (
                <div className="grid grid-cols-4 gap-3">
                  {filtered.map(a => (
                    <AssetChip key={a.id} asset={a} usageCount={usageMap.get(normPath(a.path))?.count ?? 0}
                      missing={missing.has(normPath(a.path))} selected={selectedId === a.id} onClick={() => setSelectedId(a.id)} />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* detail */}
          <div className="w-72 shrink-0 flex flex-col overflow-auto">
            {!selected ? (
              <div className="text-fg-3 italic text-mini p-3">Select an asset to inspect.</div>
            ) : (
              <div className="p-3 space-y-3">
                <div className="text-sm text-fg-1 break-words">{selected.name}</div>
                <div className="text-mini text-fg-3 space-y-0.5">
                  <div>{typeLabel[selected.type]}{selected.size ? ` · ${fmtBytes(selected.size)}` : ''}</div>
                  {selected.durationSec != null && <div>{selected.durationSec.toFixed(1)}s{selected.fps ? ` · ${selected.fps}fps` : ''}</div>}
                  {(selected.width && selected.height) ? <div>{selected.width}×{selected.height}</div> : null}
                  <div className="break-all text-fg-3/80">{selected.path}</div>
                  {missing.has(normPath(selected.path)) && <div className="text-warn">Missing on disk — relink to fix.</div>}
                </div>

                <div className="flex flex-wrap gap-1">
                  {(selected.type === 'video' || selected.type === 'image') && (
                    <button onClick={() => p.onUseOnSurface(selected)} disabled={!p.selectedSurfaceId} className="inline-flex items-center gap-1 px-2 h-7 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40 text-mini"><MonitorPlay size={12} /> Use</button>
                  )}
                  <button onClick={() => window.artlux?.showItemInFolder?.(selected.path)} className="inline-flex items-center gap-1 px-2 h-7 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 text-mini"><FolderOpen size={12} /> Reveal</button>
                  <button onClick={() => p.onRelinkAsset(selected)} className="inline-flex items-center gap-1 px-2 h-7 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 text-mini"><Link2 size={12} /> Relink</button>
                  <button onClick={() => p.onRemoveAsset(selected)} className="inline-flex items-center gap-1 px-2 h-7 rounded border border-line-1 bg-surface-2 hover:bg-danger/20 hover:text-danger text-mini"><Trash2 size={12} /> Remove</button>
                </div>

                <div>
                  <div className="text-mini font-semibold text-fg-2 mb-1">Usage {usage ? `(${usage.count})` : ''}</div>
                  {usage && usage.count === 0 && <div className="text-mini text-fg-3 italic">Not used anywhere.</div>}
                  <div className="space-y-0.5">
                    {usage?.surfaceIds.map(id => (
                      <button key={`s${id}`} onClick={() => { p.onSelectSurface(id); }} className="block w-full text-left text-mini px-1.5 py-1 rounded bg-surface-2 hover:bg-surface-3 text-fg-1 truncate">Surface · {surfName(id)}</button>
                    ))}
                    {usage?.clipIds.map(id => (
                      <div key={`c${id}`} className="text-mini px-1.5 py-1 rounded bg-surface-2 text-fg-2 truncate">Clip · {clipName(id)}</div>
                    ))}
                    {usage?.modelIds.map(id => (
                      <div key={`m${id}`} className="text-mini px-1.5 py-1 rounded bg-surface-2 text-fg-2 truncate">Scene model · {modelName(id)}</div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
};
