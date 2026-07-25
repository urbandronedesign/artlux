import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Film, Image as ImageIcon, Box, Music, FolderOpen, Link2, Trash2, MonitorPlay, Search, RefreshCw, X, LayoutGrid, Grid3x3, List, Loader2 } from 'lucide-react';
import { AssetEntry, AssetType, MediaView, Timeline, timelineAudioClips } from '../types';
import { AssetChip } from './AssetChip';
import { libraryItems, usageIndex, normPath, typeLabel, type ProjectRefs } from '../services/assetLibrary';
import { layoutStore } from '../services/layoutStore';
import { useLayoutValue } from '../hooks/useLayout';
import { Tooltip } from './ui/Tooltip';
import { help } from '../services/helpBus';

interface Props {
  assets: AssetEntry[];
  timeline: Timeline;      // the GLOBAL doc — the take library lives on it (libraryItems)
  // EVERY place a path can be referenced (live + every scene's snapshot + every timeline + the audio
  // bed). Built once in App; usage counting must see all of it or the badge under-reports and the
  // delete confirmation never fires.
  refs: ProjectRefs;
  selectedSurfaceId: string | null;
  hasProjectFolder: boolean;
  onImport: (type: AssetType) => void | Promise<void>; // may be awaited to show a busy state
  /** Adopt media copied into assets/ by hand; resolves with how many entries were added. */
  onScan: () => Promise<number>;
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
export const MediaPanel: React.FC<Props> = ({ assets, timeline, refs, selectedSurfaceId, hasProjectFolder, onImport, onScan, onRemoveAsset, onRelinkAsset, onUseOnSurface, onSelectSurface }) => {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  // Scan result. "Found nothing" and "haven't scanned" must not look the same — an operator who copied
  // files into the wrong folder needs to see that the scan RAN and came back empty, or they'll click
  // again forever. Cleared on unmount so a stale count can't outlive the panel.
  const [scan, setScan] = useState<{ busy: boolean; added: number | null }>({ busy: false, added: null });
  // Which import is in flight (video/image/model/audio) — a large file copy can take several seconds,
  // and a frozen toolbar with no feedback reads as "nothing happened". onImport resolves when the copy
  // finishes; the active button spins and all four are disabled meanwhile.
  const [importing, setImporting] = useState<AssetType | null>(null);
  // Tile density, straight off the layout store (prefs-backed) rather than local state — it must
  // survive a restart and a trip through another context, like every other view ergonomic. Read with
  // the single-value selector: this panel is always mounted and rebuilds a usage index per render, so
  // it must not wake up for every dock-resize tick. (See useLayoutValue.)
  const view = useLayoutValue(l => l.mediaView);

  const items = useMemo(() => libraryItems(assets, timeline), [assets, timeline]);

  // The scan is a main-process directory walk, so it can outlive this panel (context switch, project
  // close). Guard the state write — re-armed on mount so StrictMode's double-invoke doesn't leave the
  // flag stuck false.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // The result line is transient — it answers "did that do anything?" and then gets out of the way,
  // rather than holding a row of a narrow column for the rest of the session.
  const scanMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (scanMsgTimer.current) clearTimeout(scanMsgTimer.current); }, []);
  const doImport = async (type: AssetType) => {
    if (importing) return;
    setImporting(type);
    try { await onImport(type); } finally { if (alive.current) setImporting(null); }
  };
  const runScan = async () => {
    if (scan.busy) return;
    if (scanMsgTimer.current) clearTimeout(scanMsgTimer.current);
    setScan({ busy: true, added: null });
    try {
      const added = await onScan();
      if (!alive.current) return;
      setScan({ busy: false, added });
      scanMsgTimer.current = setTimeout(() => { if (alive.current) setScan({ busy: false, added: null }); }, 6000);
    } catch (e) {
      console.error('[media] scan failed', e);
      if (alive.current) setScan({ busy: false, added: null });
    }
  };

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

  const viewBtn = (v: MediaView, icon: React.ReactNode, label: string, helpId: string) => (
    <Tooltip id={helpId}>
      <button onClick={() => layoutStore.set({ mediaView: v })} title={`${label} view`} aria-pressed={view === v} {...help(helpId)}
        className={`inline-flex items-center justify-center w-6 h-5 ${view === v ? 'bg-accent text-black' : 'bg-surface-2 text-fg-3 hover:text-fg-1'}`}>
        {icon}
      </button>
    </Tooltip>
  );

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

      {/* SEARCH — first thing under the title and the full width of the column. It used to be a 80px
          box wedged at the end of the wrapping filter row, which is where you look last and the
          narrowest it could possibly be, for the control that answers "where is that file". */}
      <div className="px-2 py-1.5 border-b border-line-1">
        <div className="flex items-center gap-1.5 bg-surface-2 border border-line-1 rounded px-1.5 h-6">
          <Search size={11} className="text-fg-3 shrink-0" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search media"
            className="bg-transparent outline-none text-mini w-full min-w-0 text-fg-1" />
          {query && (
            <button onClick={() => setQuery('')} title="Clear search"
              className="shrink-0 text-fg-3 hover:text-fg-1 no-press"><X size={11} /></button>
          )}
        </div>
      </div>

      {/* import + project-folder hint */}
      <div className="px-2 py-1.5 flex items-center gap-1 border-b border-line-1">
        <span className="text-micro text-fg-3 mr-1">Import</span>
        <Tooltip id="media.import-video"><button onClick={() => void doImport('video')} disabled={!hasProjectFolder || !!importing} title="Import video" {...help('media.import-video')} className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40">{importing === 'video' ? <Loader2 size={12} className="animate-spin" /> : <Film size={12} />}</button></Tooltip>
        <Tooltip id="media.import-image"><button onClick={() => void doImport('image')} disabled={!hasProjectFolder || !!importing} title="Import image" {...help('media.import-image')} className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40">{importing === 'image' ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />}</button></Tooltip>
        <Tooltip id="media.import-model"><button onClick={() => void doImport('model')} disabled={!hasProjectFolder || !!importing} title="Import 3D model" {...help('media.import-model')} className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40">{importing === 'model' ? <Loader2 size={12} className="animate-spin" /> : <Box size={12} />}</button></Tooltip>
        <Tooltip id="media.import-audio"><button onClick={() => void doImport('audio')} disabled={!hasProjectFolder || !!importing} title="Import audio" {...help('media.import-audio')} className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40">{importing === 'audio' ? <Loader2 size={12} className="animate-spin" /> : <Music size={12} />}</button></Tooltip>
        {/* Scan — for media copied into assets/ outside the app (Explorer, a USB drive, a sync tool).
            Import is the supported route; this is the one that rescues everything that came the other
            way, which on a venue machine is most of it. */}
        <Tooltip id="media.scan"><button onClick={() => void runScan()} disabled={!hasProjectFolder || scan.busy}
          title="Scan the project's assets folder for media added outside ARTLux" {...help('media.scan')}
          className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40 text-micro text-fg-2 ml-auto">
          <RefreshCw size={12} className={scan.busy ? 'animate-spin' : undefined} /> Scan
        </button></Tooltip>
      </div>
      {!hasProjectFolder && (
        <div className="px-2 py-1 text-micro text-warn border-b border-line-1">Create a project folder (File → New Project) to import media.</div>
      )}
      {/* Scan feedback — an empty result must read as "ran, found nothing", not as nothing happening. */}
      {scan.added != null && (
        <div className="px-2 py-1 text-micro text-fg-3 border-b border-line-1">
          {scan.added > 0 ? `Scan: added ${scan.added} file${scan.added === 1 ? '' : 's'}.` : 'Scan: no new media in the project’s assets folder.'}
        </div>
      )}

      {/* type filter + view density */}
      <div className="px-2 py-1.5 flex flex-wrap items-center gap-1 border-b border-line-1">
        {chip('All', 'all')}
        {chip('Video', 'video', <Film size={10} />)}
        {chip('Image', 'image', <ImageIcon size={10} />)}
        {chip('Model', 'model', <Box size={10} />)}
        {chip('Take', 'take')}
        {chip('Audio', 'audio', <Music size={10} />)}
        {/* Explorer's large / medium / list. Persisted in the workspace layout, so the density an
            operator picked for their screen is still there tomorrow. */}
        <div className="flex items-center ml-auto rounded border border-line-1 overflow-hidden">
          {viewBtn('large', <LayoutGrid size={11} />, 'Large icons', 'media.view-large')}
          {viewBtn('medium', <Grid3x3 size={11} />, 'Medium icons', 'media.view-medium')}
          {viewBtn('list', <List size={11} />, 'List', 'media.view-list')}
        </div>
      </div>

      {/* grid / list */}
      <div className="flex-1 min-h-0 overflow-auto p-2">
        {filtered.length === 0 ? (
          <div className="text-fg-3 italic text-mini px-1 py-2">
            {items.length ? 'No media matches this filter.' : 'No media. Import files, scan the assets folder, or record a take.'}
          </div>
        ) : (
          // auto-fill rather than a fixed column count: the browser column is resizable, so a fixed
          // `grid-cols-2` meant tiny tiles when narrow and two absurd ones when wide. Tile WIDTH is what
          // the view picks; how many fit is the column's business.
          <div className={view === 'list' ? 'flex flex-col gap-px' : 'grid gap-2'}
            style={view === 'list' ? undefined : { gridTemplateColumns: `repeat(auto-fill, minmax(${view === 'large' ? 132 : 74}px, 1fr))` }}>
            {filtered.map(a => (
              <AssetChip key={a.id} asset={a} usageCount={usageOf(a)} missing={missing.has(normPath(a.path))}
                selected={selectedId === a.id} view={view}
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
              <Tooltip id="media.use-on-surface"><button onClick={() => onUseOnSurface(selected)} disabled={!selectedSurfaceId} title={selectedSurfaceId ? 'Set as the selected surface’s content' : 'Select a surface first'} {...help('media.use-on-surface')}
                className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40 text-micro"><MonitorPlay size={11} /> Use</button></Tooltip>
            )}
            <Tooltip id="media.reveal-in-folder"><button onClick={() => window.artlux?.showItemInFolder?.(selected.path)} title="Reveal in folder" {...help('media.reveal-in-folder')}
              className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 text-micro"><FolderOpen size={11} /></button></Tooltip>
            <Tooltip id="media.relink"><button onClick={() => onRelinkAsset(selected)} title="Relink (locate the file)" {...help('media.relink')}
              className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 text-micro"><Link2 size={11} /></button></Tooltip>
            <Tooltip id="media.remove"><button onClick={() => onRemoveAsset(selected)} title="Remove from library" {...help('media.remove')}
              className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 hover:bg-danger/20 hover:text-danger text-micro ml-auto"><Trash2 size={11} /></button></Tooltip>
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
                <div key={`c${id}`} title={`Clip · ${clipName(id)}`} className="text-micro px-1.5 py-1 rounded bg-surface-2 text-fg-2 truncate">Clip · {clipName(id)}</div>
              ))}
              {selUsage?.modelIds.map(id => (
                <div key={`m${id}`} title={`Scene model · ${modelName(id)}`} className="text-micro px-1.5 py-1 rounded bg-surface-2 text-fg-2 truncate">Scene model · {modelName(id)}</div>
              ))}
              {selUsage?.audioClipIds.map(id => (
                <div key={`a${id}`} title={`Audio clip · ${audioClipName(id)}`} className="text-micro px-1.5 py-1 rounded bg-surface-2 text-fg-2 truncate">Audio clip · {audioClipName(id)}</div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
