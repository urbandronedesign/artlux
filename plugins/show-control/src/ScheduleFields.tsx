import React from 'react';
import type { RepeatMode, Recurring } from './types';
import { repeatOf, describeRepeat, isSpent, ymd } from './recurrence';

// The scheme editor, shared by the desktop Schedule and Playlist panels.
//
// Both panels schedule "a thing at a time on a scheme", and both previously offered the same
// half-control: a time box and seven day chips, on the ADD row only. Neither could edit what was
// already scheduled, and neither could express a one-off. One component now, so the two cannot
// drift from each other or from the tablet — and all three read the scheme through recurrence.ts.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MODES: { v: RepeatMode; label: string }[] = [
  { v: 'daily', label: 'Daily' },
  { v: 'weekly', label: 'Weekly' },
  { v: 'once', label: 'Once' },
];

export interface Draft extends Recurring {
  enabled: boolean;
  name?: string;
}

export const ScheduleFields = <T extends Draft>({ draft, onChange }: {
  draft: T;
  onChange: (next: T) => void;
}): React.ReactElement => {
  const mode = repeatOf(draft);
  const days = draft.days ?? [];

  // Switching scheme REWRITES the fields the other schemes own, so a saved entry never carries a
  // contradiction (weekdays on a one-off, a date on a weekly) — `days` is still read as the scheme
  // by anything that predates `repeat`.
  const setMode = (v: RepeatMode) => onChange({
    ...draft,
    repeat: v,
    days: v === 'weekly' ? (days.length ? days : [new Date().getDay()]) : [],
    date: v === 'once' ? (draft.date || ymd(new Date())) : undefined,
  });

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1">
        {MODES.map((m) => (
          <button
            key={m.v} onClick={() => setMode(m.v)}
            className={`flex-1 h-6 rounded text-micro font-semibold border ${mode === m.v
              ? 'bg-accent text-black border-transparent'
              : 'bg-surface-1 text-fg-2 border-line-1 hover:text-fg-1'}`}
          >{m.label}</button>
        ))}
      </div>

      {mode === 'weekly' && (
        <div className="flex flex-wrap gap-1">
          {DAYS.map((d, i) => (
            <button
              key={d}
              onClick={() => onChange({ ...draft, days: days.includes(i) ? days.filter((x) => x !== i) : [...days, i] })}
              className={`px-1.5 h-5 rounded text-micro border ${days.includes(i)
                ? 'bg-accent text-black border-transparent'
                : 'bg-surface-1 text-fg-2 border-line-1 hover:text-fg-1'}`}
            >{d}</button>
          ))}
          {days.length === 0 && <span className="text-micro text-warn self-center">pick at least one day</span>}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        {mode === 'once' && (
          <input
            type="date" value={draft.date || ''} onChange={(e) => onChange({ ...draft, date: e.target.value })}
            className="bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 num"
          />
        )}
        <input
          type="time" value={draft.time} onChange={(e) => onChange({ ...draft, time: e.target.value })}
          className="bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 num"
        />
        <input
          value={draft.name ?? ''} onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder="label (optional)"
          className="flex-1 min-w-0 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 outline-none focus:border-accent"
        />
      </div>

      {mode === 'once' && isSpent(draft) && (
        <div className="text-micro text-warn">That moment has passed — this will not fire.</div>
      )}
    </div>
  );
};

// The scheme, on one line of a list row. Same wording everywhere (the tablet included).
export const schemeLabel = (e: Recurring): string => describeRepeat(e);
