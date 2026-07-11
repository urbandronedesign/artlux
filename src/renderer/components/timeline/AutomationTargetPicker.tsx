// "What do you want to automate?" — a popover listing every parameter any registered provider exposes,
// grouped. Core contributes surfaces/fixtures/brightness; the audio plugin contributes the bed's gains,
// positions and effect params. Core doesn't know which is which: it just asks the registry.
//
// A target that already has a lane is shown as taken, so one path can never end up with two lanes
// fighting over it (which would also break the sampler's per-lane change detection).
import React, { useMemo, useState } from 'react';
import type { AutomationTargetDef } from '@artlux/sdk/renderer';
import { automationTargetRegistry } from '../../host/registries';
import { Search, X } from 'lucide-react';

interface Props {
  taken: Set<string>;
  anchor: { x: number; y: number };  // viewport coords of the button that opened it
  onPick: (def: AutomationTargetDef) => void;
  onClose: () => void;
}

export const AutomationTargetPicker: React.FC<Props> = ({ taken, anchor, onPick, onClose }) => {
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const all = automationTargetRegistry.all().flatMap(p => {
      try { return p.enumerate(); } catch { return []; }
    });
    const needle = q.trim().toLowerCase();
    const hit = needle
      ? all.filter(d => `${d.group} ${d.label}`.toLowerCase().includes(needle))
      : all;
    const byGroup = new Map<string, AutomationTargetDef[]>();
    for (const d of hit) {
      const g = byGroup.get(d.group) ?? [];
      g.push(d);
      byGroup.set(d.group, g);
    }
    return [...byGroup.entries()];
  }, [q]);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      {/* FIXED, not absolute: the timeline gutter lives inside an overflow-auto scroller, which would
          clip an absolutely-positioned popover to a 26px-tall row — the list would be invisible. */}
      <div className="fixed z-50 w-80 max-h-96 flex flex-col rounded-lg border border-line-2 bg-surface-1 shadow-e3"
        style={{ left: Math.min(anchor.x, window.innerWidth - 336), top: Math.max(8, anchor.y - 400) }}>
        <div className="h-8 px-2 flex items-center gap-1.5 border-b border-line-1 shrink-0">
          <Search size={12} className="text-fg-3 shrink-0" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Automate…"
            className="flex-1 bg-transparent outline-none text-mini text-fg-1" />
          <button onClick={onClose} className="text-fg-3 hover:text-fg-1"><X size={12} /></button>
        </div>
        <div className="flex-1 overflow-auto p-1">
          {groups.length === 0 ? (
            <div className="text-micro text-fg-3 italic px-2 py-3 text-center">
              Nothing to automate yet. Add a bed clip or an effect, or a surface/fixture.
            </div>
          ) : groups.map(([group, defs]) => (
            <div key={group} className="mb-1">
              <div className="text-[9px] uppercase tracking-wider text-fg-3 px-1.5 py-0.5">{group}</div>
              {defs.map(d => {
                const has = taken.has(d.path);
                return (
                  <button key={d.path} disabled={has} onClick={() => onPick(d)}
                    title={has ? 'Already automated' : d.path}
                    className={`w-full text-left px-1.5 py-1 rounded text-mini flex items-center gap-2 ${has ? 'text-fg-3/50 cursor-default' : 'text-fg-1 hover:bg-surface-2'}`}>
                    <span className="flex-1 truncate">{d.label}</span>
                    <span className="text-micro text-fg-3 tabular-nums shrink-0">
                      {has ? 'automated' : `${d.min}–${d.max}${d.unit ? ` ${d.unit}` : ''}`}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
};
