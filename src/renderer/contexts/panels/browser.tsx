import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Folder, Box, Users, Copy, Layers, Hash, ChevronUp, ChevronDown, Lightbulb, AlertTriangle } from 'lucide-react';
import type { Fixture } from '../../types';
import { Slider } from '../../components/ui';
import { Tooltip } from '../../components/ui/Tooltip';
import { help } from '../../services/helpBus';
import { livePreview } from '../../services/livePreview';
import { fixtureFootprint, resolveMode } from '../../services/addressing';
import {
  fixtureKind, groupKind, lightState, profileOf, KIND_LABEL, KIND_LABEL_PLURAL, type FixtureKind,
} from '../../services/fixtureKind';
import { useEditor, useEditorActions } from '../../state/EditorStore';
import { useRovingTabindex } from '../../hooks/useRovingTabindex';

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
  const roving = useRovingTabindex(ordered.length);

  return (
    <div className="p-1 space-y-0.5" ref={roving.containerRef} onKeyDown={roving.onKeyDown}>
      {ordered.map((s, idx, arr) => {
        const sel = s.id === selectedSurfaceId;
        return (
          <div
            key={s.id}
            role="button"
            aria-pressed={sel}
            aria-label={`Surface ${s.name}`}
            {...roving.getItemProps(idx)}
            onClick={() => a.selectSurface(s.id)}
            onDoubleClick={() => rename.start(s.id, s.name)}
            onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); a.selectSurface(s.id); } }}
            className={`pressable flex items-center group px-2 py-1.5 rounded cursor-pointer transition-colors ${sel ? 'bg-sel-surface/20 text-fg-1' : 'text-fg-2 hover:bg-surface-3'}`}
          >
            <Layers size={12} className={`mr-2 ${sel ? 'text-sel-surface' : 'text-fg-3'}`} />
            {rename.editingId === s.id
              ? rename.input('border-sel-surface')
              : <span className="flex-1 truncate select-none" title="Double-click to rename">{s.name}</span>}
            <span className="num text-micro text-fg-3 mr-1 uppercase">{s.content.type === 'NONE' ? '—' : s.content.type}</span>
            <div className="flex items-center text-fg-3">
              <Tooltip id="general.surface-forward">
                <button
                  className="p-0.5 hover:text-fg-1 disabled:opacity-20 disabled:hover:text-fg-3"
                  disabled={idx === 0}
                  onClick={(e) => { e.stopPropagation(); a.moveSurface(s.id, 'up'); }}
                  title="Bring forward"
                  {...help('general.surface-forward')}
                ><ChevronUp size={12} /></button>
              </Tooltip>
              <Tooltip id="general.surface-backward">
                <button
                  className="p-0.5 hover:text-fg-1 disabled:opacity-20 disabled:hover:text-fg-3"
                  disabled={idx === arr.length - 1}
                  onClick={(e) => { e.stopPropagation(); a.moveSurface(s.id, 'down'); }}
                  title="Send backward"
                  {...help('general.surface-backward')}
                ><ChevronDown size={12} /></button>
              </Tooltip>
              <button
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 p-0.5 hover:text-danger ml-0.5"
                onClick={(e) => { e.stopPropagation(); a.removeSurface(s.id); }}
                title="Remove Surface"
                aria-label={`Remove surface ${s.name}`}
              ><Trash2 size={10} /></button>
            </div>
          </div>
        );
      })}
      {surfaces.length === 0 && (
        <button type="button" onClick={a.addSurface} className="w-full text-left px-2 py-2 text-mini text-fg-2 hover:text-fg-1 rounded">
          No surfaces yet — <span className="text-accent">Add Surface</span>
        </button>
      )}
    </div>
  );
};

export const SurfacesHeaderActions: React.FC = () => {
  const a = useEditorActions();
  return (
    <Tooltip id="general.add-surface">
      <button onClick={a.addSurface} className="text-fg-2 hover:text-fg-1" title="Add Surface" {...help('general.add-surface')}><Plus size={14} /></button>
    </Tooltip>
  );
};

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────
// ── THE LIST TELLS YOU WHICH KIND, WITHOUT A CLICK ──────────────────────────────────────────
// This was one flat list where a 5-channel moving head and a 144-LED strip rendered identically:
// same <Box> icon, same green dot, one count. Two devices on two different wires, and the only way
// to tell them apart was to select one and read the inspector.
//
// The dot is gone too. It was `bg-ok` on EVERY row with the title "Patched", which is not a status —
// it is decoration that reads as one. The two states worth a marker are the two that are otherwise
// invisible and both mean "this fixture will not light": an unresolved profile (reserving zero
// channels) and a patch overflow (addressed past what its controller can send).
const KIND_ORDER = ['pixel', 'light'] as const;

export const FixturesPanel: React.FC = () => {
  const { fixtures, fixtureProfiles, selectedFixtureId, selectedFixtureIds } = useEditor();
  const a = useEditorActions();
  const rename = useRename(a.renameFixture);
  const [filter, setFilter] = useState<'all' | FixtureKind>('all');

  const shown = filter === 'all' ? fixtures : fixtures.filter((f) => fixtureKind(f) === filter);
  const counts = { pixel: 0, light: 0 };
  for (const f of fixtures) counts[fixtureKind(f)]++;

  // Shift-range walks the DISPLAYED order. Using the unfiltered array here would silently select a
  // span the operator cannot see — the rows between two visible ones are not the rows between them
  // in `fixtures` once the list is filtered and grouped.
  const onClick = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && selectedFixtureId) {
      const order = KIND_ORDER.flatMap((k) => shown.filter((f) => fixtureKind(f) === k)).map((f) => f.id);
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

  const roving = useRovingTabindex(shown.length);
  let rovingIdx = 0;

  const row = (f: Fixture, idx: number) => {
    const sel = selectedFixtureIds.includes(f.id);
    const state = lightState(f, fixtureProfiles);
    const light = state !== 'pixel';
    const profile = profileOf(f, fixtureProfiles);
    const mode = profile ? resolveMode(profile, f.profileMode) : undefined;
    // What this fixture IS, in one glance: a light reads as its model + mode + footprint, a strip as
    // its pixel count + the channels those pixels occupy. Both numbers come from the footprint owner.
    const detail = light
      ? (profile ? `${mode?.name ?? mode?.key ?? ''} · ${fixtureFootprint(f, fixtureProfiles)}ch`.replace(/^ · /, '') : 'no profile')
      : `${f.ledCount}px · ${fixtureFootprint(f, fixtureProfiles)}ch`;
    const warn = state === 'light-unresolved'
      ? 'Profile not found — this fixture reserves no channels and will not light'
      : f.patchOverflow
        ? "Past this controller's last universe — it will not light"
        : null;
    return (
      <div
        key={f.id}
        role="button"
        aria-pressed={sel}
        aria-label={`${KIND_LABEL[fixtureKind(f)]} ${f.name}`}
        {...roving.getItemProps(idx)}
        onClick={(e) => onClick(e, f.id)}
        onDoubleClick={() => rename.start(f.id, f.name)}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); a.selectFixture(f.id, false); } }}
        className={`pressable flex items-center group px-2 py-1.5 rounded cursor-pointer transition-colors ${sel ? 'bg-accent/20 text-white' : 'text-fg-2 hover:bg-surface-3'}`}
      >
        {light
          ? <Lightbulb size={12} className={`mr-2 shrink-0 ${sel ? 'text-accent' : 'text-fg-3'}`} />
          : <Box size={12} className={`mr-2 shrink-0 ${sel ? 'text-accent' : 'text-fg-3'}`} />}
        {rename.editingId === f.id
          ? rename.input('border-accent')
          : <span className="flex-1 truncate select-none" title="Double-click to rename">{f.name}</span>}
        <span className="ml-2 text-micro text-fg-3 num shrink-0 truncate max-w-[9rem] group-hover:hidden" title={detail}>{detail}</span>
        <div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 flex gap-1">
          <button
            className="p-0.5 hover:text-danger text-fg-3 focus-visible:opacity-100"
            onClick={(e) => { e.stopPropagation(); a.removeFixture(f.id); }}
            title="Remove Fixture"
            aria-label={`Remove fixture ${f.name}`}
          ><Trash2 size={10} /></button>
        </div>
        {warn && (
          <span className="ml-2 shrink-0 text-warn" title={warn} role="img" aria-label={warn}>
            <AlertTriangle size={11} />
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="p-1">
      {/* The filter is a PREFERENCE, not project data — it lives in component state on purpose. */}
      {counts.pixel > 0 && counts.light > 0 && (
        <div className="flex gap-0.5 mb-1.5 px-1">
          {(['all', 'pixel', 'light'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              aria-pressed={filter === k}
              className={`flex-1 flex items-center justify-center gap-1 text-micro py-0.5 rounded-sm border transition-colors ${filter === k ? 'bg-accent/10 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3'}`}
            >
              <span>{k === 'all' ? 'All' : k === 'pixel' ? 'LED' : 'Light'}</span>
              <span className="num opacity-60">{k === 'all' ? fixtures.length : counts[k]}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mb-1">
        <Tooltip id="general.select-all-fixtures">
          <div
            role="button"
            tabIndex={0}
            onClick={a.selectAllFixtures}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); a.selectAllFixtures(); } }}
            className="pressable flex items-center px-2 py-1 text-fg-2 hover:bg-surface-3 rounded cursor-pointer"
            title="Select all fixtures"
            {...help('general.select-all-fixtures')}
          >
            <Folder size={12} className="mr-2 text-fg-3" />
            <span className="font-medium">Master Layer</span>
            {fixtures.length > 0 && <span className="ml-auto text-micro text-fg-3">{fixtures.length}</span>}
          </div>
        </Tooltip>
        <div className="pl-4 border-l border-line-1 ml-2.5 mt-1 space-y-0.5" ref={roving.containerRef} onKeyDown={roving.onKeyDown}>
          {KIND_ORDER.map((kind) => {
            const rows = shown.filter((f) => fixtureKind(f) === kind);
            if (!rows.length) return null;
            return (
              <div key={kind} className="space-y-0.5">
                {/* The heading only earns its line when there is something to disambiguate. */}
                {counts.pixel > 0 && counts.light > 0 && filter === 'all' && (
                  <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-micro uppercase tracking-wider text-fg-3 select-none">
                    {kind === 'light' ? <Lightbulb size={10} /> : <Box size={10} />}
                    <span>{KIND_LABEL_PLURAL[kind]}</span>
                    <span className="ml-auto num">{rows.length}</span>
                  </div>
                )}
                {rows.map((f) => row(f, rovingIdx++))}
              </div>
            );
          })}
          {fixtures.length === 0 && (
            <button type="button" onClick={a.addFixture} className="w-full text-left px-2 py-2 text-mini text-fg-2 hover:text-fg-1 rounded">
              No fixtures yet — <span className="text-accent">Add Fixture</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export const FixturesHeaderActions: React.FC = () => {
  const a = useEditorActions();
  return (
    <>
      <Tooltip id="general.auto-patch">
        <button onClick={a.autoPatch} className="text-fg-2 hover:text-fg-1" title="Auto-patch (assign universes/addresses)" {...help('general.auto-patch')}><Hash size={13} /></button>
      </Tooltip>
      <Tooltip id="general.add-fixture">
        <button onClick={a.addFixture} className="text-fg-2 hover:text-fg-1" title="Add Fixture" {...help('general.add-fixture')}><Plus size={14} /></button>
      </Tooltip>
    </>
  );
};

// ── Groups ──────────────────────────────────────────────────────────────────────────────────
export const GroupsPanel: React.FC = () => {
  const { groups, fixtures } = useEditor();
  const a = useEditorActions();
  return (
    <div className="p-1 space-y-0.5 max-h-28 overflow-y-auto">
      {groups.map((g) => {
        // WHAT KIND OF GROUP IS THIS? Derived from the members, never stored — they are the truth.
        // `mixed` is the one worth surfacing: a lighting take is authored in ROLE space (pan in
        // degrees, dimmer 0..1), and a role value has nowhere to land on a pixel strip, so a clip
        // aimed at a mixed group silently drives only part of it.
        const kind = groupKind(g, fixtures);
        return (
        <div key={g.id} className="flex items-center group px-2 py-1 rounded hover:bg-surface-3 text-fg-2">
          {kind === 'light' ? <Lightbulb size={12} className="mr-2 text-fg-3" /> : <Users size={12} className="mr-2 text-fg-3" />}
          <button className="flex-1 text-left truncate" onClick={() => a.selectGroup(g)}>
            {g.name} <span className="text-fg-3">({g.fixtureIds.length})</span>
          </button>
          {kind === 'mixed' && (
            <span className="mr-1 shrink-0 text-warn" title="Mixed LED and light fixtures — a lighting take drives only the lights in this group">
              <AlertTriangle size={10} />
            </span>
          )}
          <div className="opacity-0 group-hover:opacity-100 flex gap-1.5">
            <Tooltip id="general.group-add-selected">
              <button title="Add selected fixture" onClick={() => a.addSelectedToGroup(g.id)} className="hover:text-accent text-fg-3" {...help('general.group-add-selected')}><Plus size={11} /></button>
            </Tooltip>
            <Tooltip id="general.group-apply-look">
              <button title="Apply selected look to group" onClick={() => a.applyLookToGroup(g)} className="hover:text-accent text-fg-3" {...help('general.group-apply-look')}><Copy size={11} /></button>
            </Tooltip>
            <button title="Delete group" onClick={() => a.removeGroup(g.id)} className="hover:text-danger text-fg-3"><Trash2 size={10} /></button>
          </div>
        </div>
        );
      })}
      {groups.length === 0 && <div className="text-fg-3 italic px-2 py-1">No groups</div>}
    </div>
  );
};

export const GroupsHeaderActions: React.FC = () => {
  const a = useEditorActions();
  return (
    <Tooltip id="general.new-group">
      <button onClick={a.createGroup} className="text-fg-2 hover:text-fg-1" title="New group from selection" {...help('general.new-group')}><Plus size={14} /></button>
    </Tooltip>
  );
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
