// "What do you want to automate?" — a popover listing every parameter any registered provider exposes,
// grouped. Core contributes surfaces/fixtures/brightness; the audio plugin contributes the bed's gains,
// positions and effect params. Core doesn't know which is which: it just asks the registry.
//
// A target that already has a lane is shown as taken, so one path can never end up with two lanes
// fighting over it (which would also break the sampler's per-lane change detection).
//
// PORTALLED TO document.body ON PURPOSE. `position: fixed` changes painting, not the DOM tree — so
// while this lived inside the timeline's scroller, every wheel event bubbled to that scroller's
// NON-PASSIVE listener (Timeline.tsx), which preventDefault()s and zooms. The list could not scroll:
// you spun the wheel and the timeline zoomed underneath the menu. A portal takes it out of that
// subtree, so the native listener never sees the event.
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AutomationTargetDef } from '@artlux/sdk/renderer';
import { automationTargetRegistry } from '../../host/registries';
import { Search, X } from 'lucide-react';

interface Props {
  taken: Set<string>;
  anchor: { x: number; y: number };  // viewport coords of the button that opened it
  onPick: (def: AutomationTargetDef) => void;
  onClose: () => void;
}

const W = 320;        // must match w-80
const MAX_H = 384;    // must match max-h-96
const M = 8;          // viewport margin

export const AutomationTargetPicker: React.FC<Props> = ({ taken, anchor, onPick, onClose }) => {
  const [q, setQ] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  // Placement is MEASURED, not guessed. The old code hard-coded `anchor.y - 400` for a 384px panel,
  // which flew off the top of short windows and left a gap on tall ones.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });

  useLayoutEffect(() => {
    const h = Math.min(boxRef.current?.offsetHeight ?? MAX_H, MAX_H);
    const left = Math.max(M, Math.min(anchor.x, window.innerWidth - W - M));
    // Prefer opening ABOVE the button (it sits at the bottom of the timeline); flip below only when
    // there isn't room, and clamp so we can never render off-screen either way.
    const above = anchor.y - h - M;
    const top = above >= M ? above : Math.min(anchor.y + M, window.innerHeight - h - M);
    setPos({ left, top: Math.max(M, top) });
  }, [anchor.x, anchor.y, q]);

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

  // BOTH LAYERS SIT ON THE `popover` TIER, not on local z-40/z-50. The portal above moves this out of
  // the timeline panel and into the ROOT stacking context, where App's own overlays live — and the
  // maximised-timeline wrapper is `fixed inset-0 z-50` there. A z-40 backdrop loses to it outright: the
  // popover could not be dismissed (the backdrop was UNDER the wrapper) and the dismissal click fell
  // through onto the timeline and seeked/scrubbed/deselected instead. F-maximise is the most likely
  // place to author automation, so that was the common case. The box is painted over the backdrop by DOM
  // order (equal z, later sibling wins) — keep it second.
  return createPortal(
    <>
      <div className="fixed inset-0 z-popover" onClick={onClose} />
      <div
        ref={boxRef}
        className="fixed z-popover flex flex-col rounded-lg border border-line-2 bg-surface-1 shadow-e3"
        style={{ left: pos.left, top: pos.top, width: W, maxHeight: MAX_H }}
        // The portal removes us from the scroller's DOM subtree (which kills the native wheel-zoom
        // listener). This stops React's SYNTHETIC wheel from travelling the React tree as well.
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="h-8 px-2 flex items-center gap-1.5 border-b border-line-1 shrink-0">
          <Search size={12} className="text-fg-3 shrink-0" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Automate…"
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
            className="flex-1 bg-transparent outline-none text-mini text-fg-1" />
          <button onClick={onClose} className="text-fg-3 hover:text-fg-1"><X size={12} /></button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain p-1">
          {groups.length === 0 ? (
            <div className="text-micro text-fg-3 italic px-2 py-3 text-center">
              Nothing to automate yet. Add a bed clip or an effect, or a surface/fixture.
            </div>
          ) : groups.map(([group, defs]) => (
            <div key={group} className="mb-1">
              <div className="text-micro uppercase tracking-wider text-fg-3 px-1.5 py-0.5">{group}</div>
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
    </>,
    document.body,
  );
};
