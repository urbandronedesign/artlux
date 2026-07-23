import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Folder, Box, Users, Copy, Layers, Hash, ChevronUp, ChevronDown } from 'lucide-react';
import { Slider } from '../../components/ui';
import { livePreview } from '../../services/livePreview';
import { useEditor, useEditorActions } from '../../state/EditorStore';

// Browser-column panels — the outliners. These are the four sections `ScenePanel` used to render as
// one 25-prop component; each is now an independently placeable panel that reads the editor store,
// so a context can take the Fixtures tree without dragging Surfaces and the brightness sliders along
// with it (LED wants fixtures + groups; Map wants surfaces; Show wants only the globals).
//
// The markup is deliberately unchanged from ScenePanel — this is a decomposition, not a restyle.
// Section chrome (header, chevron, the header buttons below) is supplied by the shell.

// Shared inline-rename hook. Each panel owns its own editing state now; ScenePanel used one pair of
// `editingId`/`editKind` across surfaces AND fixtures, which is exactly the coupling being removed.
function useRename(commit: (id: string, name: string) => void) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editingId]);

  const start = (id: string, current: string) => { setEditingId(id); setName(current); };
  const done = () => { if (editingId && name.trim()) commit(editingId, name.trim()); setEditingId(null); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') done();
    if (e.key === 'Escape') setEditingId(null);
  };
  const input = (borderClass: string) => (
    <input
      ref={inputRef} type="text" value={name}
      onChange={(e) => setName(e.target.value)} onBlur={done} onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      className={`flex-1 bg-black text-white border ${borderClass} text-xs px-1 py-0.5 rounded outline-none min-w-0`}
    />
  );
  return { editingId, start, input };
}

// ── Surfaces ────────────────────────────────────────────────────────────────────────────────
export const SurfacesPanel: React.FC = () => {
  const { surfaces, selectedSurfaceId } = useEditor();
  const a = useEditorActions();
  const rename = useRename(a.renameSurface);

  // Front-most on top (the stage draws low→high zIndex). ▲/▼ restack.
  const ordered = [...surfaces].sort((x, y) => (y.zIndex - x.zIndex) || (surfaces.indexOf(y) - surfaces.indexOf(x)));

  return (
    <div className="p-1 space-y-0.5">
      {ordered.map((s, idx, arr) => {
        const sel = s.id === selectedSurfaceId;
        return (
          <div
            key={s.id}
            onClick={() => a.selectSurface(s.id)}
            onDoubleClick={() => rename.start(s.id, s.name)}
            className={`pressable flex items-center group px-2 py-1.5 rounded cursor-pointer transition-colors ${sel ? 'bg-sel-surface/20 text-fg-1' : 'text-fg-2 hover:bg-surface-3'}`}
          >
            <Layers size={12} className={`mr-2 ${sel ? 'text-sel-surface' : 'text-fg-3'}`} />
            {rename.editingId === s.id
              ? rename.input('border-sel-surface')
              : <span className="flex-1 truncate select-none" title="Double-click to rename">{s.name}</span>}
            <span className="num text-micro text-fg-3 mr-1 uppercase">{s.content.type === 'NONE' ? '—' : s.content.type}</span>
            <div className="flex items-center text-fg-3">
              <button
                className="p-0.5 hover:text-fg-1 disabled:opacity-20 disabled:hover:text-fg-3"
                disabled={idx === 0}
                onClick={(e) => { e.stopPropagation(); a.moveSurface(s.id, 'up'); }}
                title="Bring forward"
              ><ChevronUp size={12} /></button>
              <button
                className="p-0.5 hover:text-fg-1 disabled:opacity-20 disabled:hover:text-fg-3"
                disabled={idx === arr.length - 1}
                onClick={(e) => { e.stopPropagation(); a.moveSurface(s.id, 'down'); }}
                title="Send backward"
              ><ChevronDown size={12} /></button>
              <button
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-danger ml-0.5"
                onClick={(e) => { e.stopPropagation(); a.removeSurface(s.id); }}
                title="Remove Surface"
              ><Trash2 size={10} /></button>
            </div>
          </div>
        );
      })}
      {surfaces.length === 0 && <div className="text-fg-3 italic px-2 py-1">No surfaces</div>}
    </div>
  );
};

export const SurfacesHeaderActions: React.FC = () => {
  const a = useEditorActions();
  return <button onClick={a.addSurface} className="text-fg-2 hover:text-fg-1" title="Add Surface"><Plus size={14} /></button>;
};

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────
export const FixturesPanel: React.FC = () => {
  const { fixtures, selectedFixtureId, selectedFixtureIds } = useEditor();
  const a = useEditorActions();
  const rename = useRename(a.renameFixture);

  // Plain click = single, ctrl/cmd = toggle, shift = range from the primary selection.
  const onClick = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && selectedFixtureId) {
      const order = fixtures.map((f) => f.id);
      const from = order.indexOf(selectedFixtureId);
      const to = order.indexOf(id);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        a.selectFixtures(order.slice(lo, hi + 1));
        return;
      }
    }
    a.selectFixture(id, e.ctrlKey || e.metaKey);
  };

  return (
    <div className="p-1">
      <div className="mb-1">
        <div
          onClick={a.selectAllFixtures}
          className="pressable flex items-center px-2 py-1 text-fg-2 hover:bg-surface-3 rounded cursor-pointer"
          title="Select all fixtures"
        >
          <Folder size={12} className="mr-2 text-fg-3" />
          <span className="font-medium">Master Layer</span>
          {fixtures.length > 0 && <span className="ml-auto text-micro text-fg-3">{fixtures.length}</span>}
        </div>
        <div className="pl-4 border-l border-line-1 ml-2.5 mt-1 space-y-0.5">
          {fixtures.map((f) => {
            const sel = selectedFixtureIds.includes(f.id);
            return (
              <div
                key={f.id}
                onClick={(e) => onClick(e, f.id)}
                onDoubleClick={() => rename.start(f.id, f.name)}
                className={`pressable flex items-center group px-2 py-1.5 rounded cursor-pointer transition-colors ${sel ? 'bg-accent/20 text-white' : 'text-fg-2 hover:bg-surface-3'}`}
              >
                <Box size={12} className={`mr-2 ${sel ? 'text-accent' : 'text-fg-3'}`} />
                {rename.editingId === f.id
                  ? rename.input('border-accent')
                  : <span className="flex-1 truncate select-none" title="Double-click to rename">{f.name}</span>}
                <div className="opacity-0 group-hover:opacity-100 flex gap-1">
                  <button
                    className="p-0.5 hover:text-danger text-fg-3"
                    onClick={(e) => { e.stopPropagation(); a.removeFixture(f.id); }}
                    title="Remove Fixture"
                  ><Trash2 size={10} /></button>
                </div>
                <div className="w-1 h-1 rounded-full bg-ok ml-2 shadow-[0_0_4px_rgba(63,185,80,0.5)]" />
              </div>
            );
          })}
          {fixtures.length === 0 && <div className="text-fg-3 italic px-2 py-1">No fixtures</div>}
        </div>
      </div>
    </div>
  );
};

export const FixturesHeaderActions: React.FC = () => {
  const a = useEditorActions();
  return (
    <>
      <button onClick={a.autoPatch} className="text-fg-2 hover:text-fg-1" title="Auto-patch (assign universes/addresses)"><Hash size={13} /></button>
      <button onClick={a.addFixture} className="text-fg-2 hover:text-fg-1" title="Add Fixture"><Plus size={14} /></button>
    </>
  );
};

// ── Groups ──────────────────────────────────────────────────────────────────────────────────
export const GroupsPanel: React.FC = () => {
  const { groups } = useEditor();
  const a = useEditorActions();
  return (
    <div className="p-1 space-y-0.5 max-h-28 overflow-y-auto">
      {groups.map((g) => (
        <div key={g.id} className="flex items-center group px-2 py-1 rounded hover:bg-surface-3 text-fg-2">
          <Users size={12} className="mr-2 text-fg-3" />
          <button className="flex-1 text-left truncate" onClick={() => a.selectGroup(g)}>
            {g.name} <span className="text-fg-3">({g.fixtureIds.length})</span>
          </button>
          <div className="opacity-0 group-hover:opacity-100 flex gap-1.5">
            <button title="Add selected fixture" onClick={() => a.addSelectedToGroup(g.id)} className="hover:text-accent text-fg-3"><Plus size={11} /></button>
            <button title="Apply selected look to group" onClick={() => a.applyLookToGroup(g)} className="hover:text-accent text-fg-3"><Copy size={11} /></button>
            <button title="Delete group" onClick={() => a.removeGroup(g.id)} className="hover:text-danger text-fg-3"><Trash2 size={10} /></button>
          </div>
        </div>
      ))}
      {groups.length === 0 && <div className="text-fg-3 italic px-2 py-1">No groups</div>}
    </div>
  );
};

export const GroupsHeaderActions: React.FC = () => {
  const a = useEditorActions();
  return <button onClick={a.createGroup} className="text-fg-2 hover:text-fg-1" title="New group from selection"><Plus size={14} /></button>;
};

// ── Global params ───────────────────────────────────────────────────────────────────────────
// Both sliders drive a RENDER-FREE live channel while dragging (`onInput`) and commit React state
// only on release (`onChange`) — see services/livePreview.ts. Do not "simplify" that into onChange.
export const GlobalParamsPanel: React.FC = () => {
  const { globalBrightness, projectorBrightness } = useEditor();
  const a = useEditorActions();
  return (
    <div className="p-3 space-y-4">
      <Slider
        label="LED Brightness"
        value={globalBrightness}
        min={0} max={1} step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        onInput={(v) => livePreview.setBrightness(v)}
        onChange={a.setMasterBrightness}
      />
      <Slider
        label="Projector Brightness"
        value={projectorBrightness}
        min={0} max={1} step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        onInput={a.pushProjectorBrightness}
        onChange={a.setProjectorBrightness}
      />
    </div>
  );
};
