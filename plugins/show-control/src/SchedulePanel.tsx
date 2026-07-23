import React, { useEffect, useState } from 'react';
import { Clock, Plus, Trash2, Check } from 'lucide-react';
import type { PanelProps } from '@artlux/sdk/renderer';
import type { ScheduleEntry, ShowCommand } from './types';
import { getHost } from './showControlHost';

// The in-project SCHEDULE, on the desktop.
//
// This existed only on the tablet. An operator sitting at the machine could arm an unattended show
// from a phone but not from the app in front of them, which is backwards — the schedule is project
// data (ProjectData.schedule, saved with the show), so it belongs in the Show workbench.
//
// Same store, same shape as the tablet edits: host.show.getSchedule/setSchedule. Both surfaces write
// the one array, so a change here appears on a connected tablet on its next snapshot.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ACTIONS: { label: string; make(ref: string): ShowCommand }[] = [
  { label: 'Transport: Play', make: () => ({ kind: 'transport', action: 'play' }) },
  { label: 'Transport: Pause', make: () => ({ kind: 'transport', action: 'pause' }) },
  { label: 'Transport: Stop', make: () => ({ kind: 'transport', action: 'stop' }) },
  { label: 'Recall scene', make: (ref) => ({ kind: 'recallScene', ref }) },
  { label: 'Fire cue', make: (ref) => ({ kind: 'fireCue', ref }) },
];

const rid = () => Math.random().toString(36).slice(2, 10);

export const SchedulePanel: React.FC<PanelProps> = () => {
  const host = getHost();
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [scenes, setScenes] = useState<{ id: string; name: string }[]>([]);
  const [cues, setCues] = useState<{ id: string; name: string }[]>([]);

  // draft row
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState<number[]>([]);
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
  const remove = (id: string) => commit(entries.filter((e) => e.id !== id));

  const needsRef = actionIdx >= 3;
  const refList = actionIdx === 3 ? scenes : cues;
  const add = () => {
    if (needsRef && !ref) return;
    const action = ACTIONS[actionIdx].make(ref);
    commit([...entries, { id: rid(), enabled: true, time, days: [...days], action }]);
  };

  const describe = (a: ShowCommand): string => {
    if (a.kind === 'transport') return `Transport ${a.action}`;
    if (a.kind === 'recallScene') return `Recall ${scenes.find((s) => s.id === a.ref)?.name ?? a.ref}`;
    if (a.kind === 'fireCue') return `Fire ${cues.find((c) => c.id === a.ref)?.name ?? a.ref}`;
    return a.kind;
  };
  const dayLabel = (d: number[]) => d.length === 0 ? 'every day' : d.slice().sort().map((i) => DAYS[i]).join(' ');

  const dayChip = (i: number, on: boolean, set: (v: number[]) => void, cur: number[]) => (
    <button
      key={i}
      onClick={() => set(cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i])}
      className={`px-1.5 h-5 rounded text-micro border ${on ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}
    >{DAYS[i]}</button>
  );

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3 text-xs">
      <div className="flex items-center gap-1.5 text-fg-2">
        <Clock size={13} className="text-accent" />
        <span className="text-mini font-semibold uppercase tracking-wider">Schedule</span>
        <span className="text-micro text-fg-3">— wall-clock actions inside this project</span>
      </div>

      {/* add row */}
      <div className="rounded border border-line-1 bg-surface-2 p-2 space-y-2">
        <div className="flex items-center gap-2">
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
            className="bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 num" />
          <select value={actionIdx} onChange={(e) => { setActionIdx(+e.target.value); setRef(''); }}
            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1">
            {ACTIONS.map((a, i) => <option key={a.label} value={i}>{a.label}</option>)}
          </select>
        </div>
        {needsRef && (
          <select value={ref} onChange={(e) => setRef(e.target.value)}
            className="w-full bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1">
            <option value="">— pick one —</option>
            {refList.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        )}
        <div className="flex flex-wrap items-center gap-1">
          {DAYS.map((_, i) => dayChip(i, days.includes(i), setDays, days))}
          <span className="text-micro text-fg-3 ml-1">{days.length === 0 ? 'every day' : ''}</span>
          <button onClick={add} disabled={needsRef && !ref}
            className="ml-auto inline-flex items-center gap-1 px-2 h-6 rounded bg-accent text-black hover:bg-accent-hover disabled:opacity-40 text-micro font-medium">
            <Plus size={11} /> Add
          </button>
        </div>
      </div>

      {/* list */}
      {entries.length === 0
        ? <div className="text-fg-3 italic text-mini px-1">Nothing scheduled. Times are local, and fire while this project is loaded.</div>
        : <div className="space-y-1">
            {entries.slice().sort((a, b) => a.time.localeCompare(b.time)).map((e) => (
              <div key={e.id} className="flex items-center gap-2 px-2 py-1.5 rounded border border-line-1 bg-surface-2">
                <button onClick={() => toggle(e.id)} title={e.enabled ? 'Disable' : 'Enable'}
                  className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 ${e.enabled ? 'bg-accent border-transparent text-black' : 'border-line-2 text-transparent'}`}>
                  <Check size={10} />
                </button>
                <span className="num text-fg-1 shrink-0">{e.time}</span>
                <span className="flex-1 truncate text-fg-2">{describe(e.action)}</span>
                <span className="text-micro text-fg-3 shrink-0">{dayLabel(e.days)}</span>
                <button onClick={() => remove(e.id)} title="Remove" className="text-fg-3 hover:text-danger shrink-0"><Trash2 size={11} /></button>
              </div>
            ))}
          </div>}
    </div>
  );
};
