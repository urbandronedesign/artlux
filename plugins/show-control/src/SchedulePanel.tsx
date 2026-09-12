import React, { useEffect, useState } from 'react';
import { Clock, Plus, Trash2, Check, Pencil } from 'lucide-react';
import type { PanelProps } from '@artlux/sdk/renderer';
import type { ScheduleEntry, ShowCommand } from './types';
import { isSpent, describeRepeat } from './recurrence';
import { ScheduleFields } from './ScheduleFields';
import { getHost } from './showControlHost';

// The in-project SCHEDULE, on the desktop.
//
// This existed only on the tablet. An operator sitting at the machine could arm an unattended show
// from a phone but not from the app in front of them, which is backwards — the schedule is project
// data (ProjectData.schedule, saved with the show), so it belongs in the Show workbench.
//
// Same store, same shape as the tablet edits: host.show.getSchedule/setSchedule. Both surfaces write
// the one array, so a change here appears on a connected tablet on its next snapshot — and both read
// the scheme through recurrence.ts, so "every Monday" and "once on the 20th" mean the same thing in
// the app, on the tablet, and in the main-process playlist resolver.

const ACTIONS: { label: string; needsRef: 'scene' | 'cue' | null; make(ref: string): ShowCommand }[] = [
  { label: 'Transport: Play', needsRef: null, make: () => ({ kind: 'transport', action: 'play' }) },
  { label: 'Transport: Pause', needsRef: null, make: () => ({ kind: 'transport', action: 'pause' }) },
  { label: 'Transport: Stop', needsRef: null, make: () => ({ kind: 'transport', action: 'stop' }) },
  { label: 'Recall scene', needsRef: 'scene', make: (ref) => ({ kind: 'recallScene', ref }) },
  { label: 'Fire cue', needsRef: 'cue', make: (ref) => ({ kind: 'fireCue', ref }) },
];

// Which ACTIONS row an existing command came from — so opening an entry shows what it actually does
// rather than resetting it to the first option in the list.
const actionIndexOf = (a: ShowCommand): number => {
  if (a.kind === 'transport') return ACTIONS.findIndex((x) => x.label === `Transport: ${a.action[0].toUpperCase()}${a.action.slice(1)}`);
  if (a.kind === 'recallScene') return 3;
  if (a.kind === 'fireCue') return 4;
  return 2;
};
const refOf = (a: ShowCommand): string => ('ref' in a && typeof a.ref === 'string' ? a.ref : '');

const rid = () => Math.random().toString(36).slice(2, 10);
const byWhen = (a: ScheduleEntry, b: ScheduleEntry) =>
  (isSpent(a) ? 1 : 0) - (isSpent(b) ? 1 : 0) || a.time.localeCompare(b.time);

export const SchedulePanel: React.FC<PanelProps> = () => {
  const host = getHost();
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [scenes, setScenes] = useState<{ id: string; name: string }[]>([]);
  const [cues, setCues] = useState<{ id: string; name: string }[]>([]);

  // The entry being edited (a copy) plus the two fields the action select is made of.
  const [draft, setDraft] = useState<ScheduleEntry | null>(null);
  const [actionIdx, setActionIdx] = useState(0);
  const [ref, setRef] = useState('');

  const pull = () => {
    if (!host) return;
    setEntries(((host.show.getSchedule() as ScheduleEntry[]) ?? []).slice());
    setScenes(((host.show.getScenes() as { id: string; name: string }[]) ?? []).map((s) => ({ id: s.id, name: s.name })));
    const banks = (host.show.getCueBanks() as { cues?: { id: string; name: string }[] }[]) ?? [];
    setCues(banks.flatMap((b) => (b.cues ?? []).map((c) => ({ id: c.id, name: c.name }))));
  };
  useEffect(() => { pull(); return host?.show.subscribe(pull); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  const commit = (next: ScheduleEntry[]) => { setEntries(next); host?.show.setSchedule(next); };
  const toggle = (id: string) => commit(entries.map((e) => e.id === id ? { ...e, enabled: !e.enabled } : e));
  const remove = (id: string) => { if (draft?.id === id) setDraft(null); commit(entries.filter((e) => e.id !== id)); };

  const open = (e: ScheduleEntry) => {
    if (draft?.id === e.id) { setDraft(null); return; }
    setDraft({ ...e });
    setActionIdx(Math.max(0, actionIndexOf(e.action)));
    setRef(refOf(e.action));
  };
  const startAdd = () => {
    setDraft({ id: rid(), enabled: true, time: '09:00', days: [], repeat: 'daily', action: { kind: 'transport', action: 'stop' } });
    setActionIdx(0); setRef('');
  };

  const spec = ACTIONS[actionIdx];
  const refList = spec.needsRef === 'scene' ? scenes : spec.needsRef === 'cue' ? cues : [];
  const commitDraft = () => {
    if (!draft) return;
    if (spec.needsRef && !ref) return;
    const next = { ...draft, action: spec.make(ref) };
    const i = entries.findIndex((e) => e.id === next.id);
    setDraft(null);
    commit(i < 0 ? [...entries, next] : entries.map((e) => (e.id === next.id ? next : e)));
  };

  const describe = (a: ShowCommand): string => {
    if (a.kind === 'transport') return `Transport ${a.action}`;
    if (a.kind === 'recallScene') return `Recall ${scenes.find((s) => s.id === a.ref)?.name ?? a.ref}`;
    if (a.kind === 'fireCue') return `Fire ${cues.find((c) => c.id === a.ref)?.name ?? a.ref}`;
    return a.kind;
  };

  const editor = draft && (
    <div className="rounded border border-accent/40 bg-surface-1 p-2 space-y-2">
      <div className="flex items-center gap-2">
        <select value={actionIdx} onChange={(e) => { setActionIdx(+e.target.value); setRef(''); }}
          className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1">
          {ACTIONS.map((a, i) => <option key={a.label} value={i}>{a.label}</option>)}
        </select>
        {spec.needsRef && (
          <select value={ref} onChange={(e) => setRef(e.target.value)}
            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1">
            <option value="">— pick one —</option>
            {refList.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        )}
      </div>
      <ScheduleFields draft={draft} onChange={(d) => setDraft(d)} />
      <div className="flex gap-1.5">
        <button onClick={() => setDraft(null)}
          className="px-2 h-6 rounded border border-line-1 bg-surface-2 text-fg-2 hover:text-fg-1 text-micro">Cancel</button>
        <button onClick={commitDraft} disabled={!!spec.needsRef && !ref}
          className="ml-auto px-2 h-6 rounded bg-accent text-black hover:bg-accent-hover disabled:opacity-40 text-micro font-medium">Save</button>
      </div>
    </div>
  );

  const isNew = !!draft && !entries.some((e) => e.id === draft.id);

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3 text-xs">
      <div className="flex items-center gap-1.5 text-fg-2">
        <Clock size={13} className="text-accent" />
        <span className="text-mini font-semibold uppercase tracking-wider">Schedule</span>
        <span className="text-micro text-fg-3">— wall-clock actions inside this project</span>
        <button onClick={startAdd} title="Add a scheduled action"
          className="ml-auto inline-flex items-center gap-1 px-2 h-6 rounded bg-accent text-black hover:bg-accent-hover text-micro font-medium">
          <Plus size={11} /> Add
        </button>
      </div>

      {entries.length === 0 && !draft
        ? <div className="text-fg-3 italic text-mini px-1">Nothing scheduled. Times are local, and fire while this project is loaded.</div>
        : <div className="space-y-1">
            {entries.slice().sort(byWhen).map((e) => (
              <React.Fragment key={e.id}>
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded border border-line-1 bg-surface-2 ${isSpent(e) ? 'opacity-50' : ''}`}>
                  <button onClick={() => toggle(e.id)} title={e.enabled ? 'Disable' : 'Enable'}
                    className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 ${e.enabled ? 'bg-accent border-transparent text-black' : 'border-line-2 text-transparent'}`}>
                    <Check size={10} />
                  </button>
                  <span className="num text-fg-1 shrink-0">{e.time}</span>
                  <button onClick={() => open(e)} className="flex-1 min-w-0 text-left truncate text-fg-2 hover:text-fg-1">
                    {e.name || describe(e.action)}
                  </button>
                  <span className="text-micro text-fg-3 shrink-0">{describeRepeat(e)}</span>
                  <button onClick={() => open(e)} title="Edit" className="text-fg-3 hover:text-accent shrink-0"><Pencil size={11} /></button>
                  <button onClick={() => remove(e.id)} title="Remove" className="text-fg-3 hover:text-danger shrink-0"><Trash2 size={11} /></button>
                </div>
                {draft?.id === e.id && editor}
              </React.Fragment>
            ))}
          </div>}

      {isNew && editor}
    </div>
  );
};
