// One automation lane: a keyframe curve over the same time axis as the clips.
//
// The polyline is drawn by sampling `sampleLane` — the SAME function the engine samples in its frame
// loop — so the curve you SEE is literally the curve you HEAR. A separate drawing routine would be free
// to disagree with the audio, and eventually would.
//
// Editing follows the clip conventions: drag with a local `draft` and commit ONCE on pointerup, never
// per pointermove (a commit re-enters App → setScenes → timelineEngine.setData → recompile + a full bed
// re-sync; doing that 60×/s while dragging would be brutal).
import React, { useRef, useState } from 'react';
import type { AutomationLane as Lane, Keyframe } from '../../types';
import type { AutomationTargetDef } from '@artlux/sdk/renderer';
import { sampleLane, normValue, denormValue, BEZ_DEFAULT } from '../../services/automation';
import { GUTTER, clamp } from './geometry';
import { Trash2, Zap, ZapOff, Diamond, AlertTriangle } from 'lucide-react';

export const AUTO_LANE_H = 64;
const PAD = 8; // px of headroom top/bottom so a keyframe at min/max is still grabbable

interface Props {
  lane: Lane;
  def?: AutomationTargetDef;       // absent ⇒ the target no longer exists (clip deleted, plugin off)
  pxPerSec: number;
  width: number;
  playhead: number;
  onChange: (lane: Lane) => void;
  onRemove: () => void;
  onSnap: (t: number) => number;   // reuse the timeline's snapping
  onSeek: (clientX: number) => void;
}

export const AutomationLane: React.FC<Props> = ({ lane, def, pxPerSec, width, playhead, onChange, onRemove, onSnap, onSeek }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Keyframe[] | null>(null);
  const [sel, setSel] = useState<number | null>(null);

  const h = lane.height ?? AUTO_LANE_H;
  const kfs = draft ?? lane.keyframes;
  const enabled = lane.enabled !== false;

  // A lane whose target vanished keeps its data (never silently dropped — that would be losing the
  // user's work), but it can't be drawn against an axis it no longer has.
  if (!def) {
    return (
      <div className="flex border-b border-line-1 bg-surface-1/40">
        <div className="sticky left-0 z-20 shrink-0 bg-surface-1 border-r border-line-1 flex items-center gap-1.5 px-2" style={{ width: GUTTER, height: 28 }}>
          <AlertTriangle size={12} className="text-warn shrink-0" />
          <span className="text-micro text-fg-3 truncate" title={lane.targetPath}>target missing</span>
          <button onClick={onRemove} className="ml-auto text-fg-3 hover:text-danger"><Trash2 size={12} /></button>
        </div>
        <div className="relative text-micro text-fg-3/70 italic px-2 flex items-center" style={{ width, height: 28 }}>
          {lane.targetPath} — the clip or effect it drives is gone. The curve is kept; delete the lane to discard it.
        </div>
      </div>
    );
  }

  const { min, max, log = false } = def;
  const valueToY = (v: number) => PAD + (1 - normValue(v, min, max, log)) * (h - 2 * PAD);
  const yToValue = (y: number) => denormValue(1 - (y - PAD) / (h - 2 * PAD), min, max, log);
  const quant = (v: number) => {
    const s = def.step ?? 0;
    return s > 0 ? Math.round(v / s) * s : v;
  };

  // Sample the curve across the visible width — the engine's own function, one x per 2px.
  const path = (() => {
    if (kfs.length === 0) return '';
    const cur = { i: -1 };
    const pts: string[] = [];
    for (let x = 0; x <= width; x += 2) {
      const v = sampleLane(kfs, x / pxPerSec, cur, log);
      pts.push(`${x},${valueToY(v).toFixed(1)}`);
    }
    return `M${pts.join(' L')}`;
  })();

  const commit = (next: Keyframe[]) => onChange({ ...lane, keyframes: next.slice().sort((a, b) => a.t - b.t) });

  const dragKf = (i: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return; // middle-drag pans the timeline
    e.stopPropagation();
    e.preventDefault();
    setSel(i);
    const el = bodyRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const base = lane.keyframes;
    const move = (ev: PointerEvent) => {
      const next = base.slice();
      // Clamp between the neighbours so the array stays sorted — the sampler's cursor depends on it.
      const lo = i > 0 ? base[i - 1].t + 0.001 : 0;
      const hi = i < base.length - 1 ? base[i + 1].t - 0.001 : Number.MAX_SAFE_INTEGER;
      const t = ev.shiftKey ? base[i].t : clamp(onSnap((ev.clientX - rect.left) / pxPerSec), lo, hi);
      const v = ev.altKey ? base[i].v : quant(clamp(yToValue(ev.clientY - rect.top), min, max));
      next[i] = { ...base[i], t: Math.max(0, t), v };
      setDraft(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDraft(d => { if (d) commit(d); return null; }); // ONE commit, on release
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const addAt = (e: React.MouseEvent) => {
    const el = bodyRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const t = Math.max(0, onSnap((e.clientX - rect.left) / pxPerSec));
    const v = quant(clamp(yToValue(e.clientY - rect.top), min, max));
    commit([...lane.keyframes, { t, v, curve: 'linear' }]);
  };

  const removeKf = (i: number) => {
    if (lane.keyframes.length <= 1) return; // a lane always holds at least one key — remove the lane instead
    commit(lane.keyframes.filter((_, j) => j !== i));
  };

  // Clicking a segment cycles the LEFT key's curve. Order: linear → hold → bezier.
  const cycleCurve = (i: number) => {
    const k = lane.keyframes[i];
    const next: Keyframe['curve'] = k.curve === 'linear' ? 'hold' : k.curve === 'hold' ? 'bezier' : 'linear';
    commit(lane.keyframes.map((x, j) => (j === i ? { ...x, curve: next, ...(next === 'bezier' ? BEZ_DEFAULT : {}) } : x)));
  };

  const live = kfs.length ? sampleLane(kfs, playhead, { i: -1 }, log) : def.def;
  const fmt = (v: number) => `${(def.step ?? 0) >= 1 ? Math.round(v) : Number(v.toFixed(2))}${def.unit ? ` ${def.unit}` : ''}`;

  return (
    <div className={`flex border-b border-line-1 ${enabled ? 'bg-surface-1/40' : 'bg-surface-1/20'}`}>
      {/* gutter */}
      <div className="sticky left-0 z-20 shrink-0 bg-surface-1 border-r border-line-1 flex flex-col justify-center gap-0.5 px-2 py-1" style={{ width: GUTTER, height: h }}>
        <div className="flex items-center gap-1">
          <button onClick={() => onChange({ ...lane, enabled: !enabled })}
            title={enabled ? 'Lane ON — it owns this parameter (click to release it back to manual)' : 'Lane OFF — the parameter is manual again'}
            className={enabled ? 'text-accent' : 'text-fg-3 hover:text-fg-1'}>
            {enabled ? <Zap size={11} /> : <ZapOff size={11} />}
          </button>
          <span className="text-micro text-fg-1 truncate" title={lane.targetPath}>{def.label}</span>
          <button onClick={() => commit([...lane.keyframes.filter(k => Math.abs(k.t - playhead) > 0.001), { t: Math.max(0, playhead), v: quant(live), curve: 'linear' }])}
            title="Add a keyframe at the playhead, holding the current value" className="ml-auto text-fg-3 hover:text-fg-1">
            <Diamond size={11} />
          </button>
          <button onClick={onRemove} title="Remove lane" className="text-fg-3 hover:text-danger"><Trash2 size={11} /></button>
        </div>
        <div className="text-[9px] leading-none text-fg-3 truncate" title={def.group}>{def.group}</div>
        <div className="text-[9px] leading-none text-fg-2 tabular-nums">{fmt(live)}</div>
      </div>

      {/* body */}
      <div ref={bodyRef} className="relative" style={{ width, height: h, opacity: enabled ? 1 : 0.4 }}
        onDoubleClick={addAt}
        onPointerDown={(e) => { if (e.button === 0 && e.detail === 1) onSeek(e.clientX); }}>
        <svg width={width} height={h} className="absolute inset-0 pointer-events-none">
          <line x1={0} y1={valueToY(max)} x2={width} y2={valueToY(max)} className="stroke-line-1/40" strokeWidth={1} />
          <line x1={0} y1={valueToY(min)} x2={width} y2={valueToY(min)} className="stroke-line-1/40" strokeWidth={1} />
          <path d={path} fill="none" stroke={lane.color ?? 'currentColor'} className="text-accent" strokeWidth={1.5} />
        </svg>
        {/* keyframes */}
        {kfs.map((k, i) => (
          <div key={i} onPointerDown={dragKf(i)}
            onContextMenu={(e) => { e.preventDefault(); removeKf(i); }}
            onClick={(e) => { if (e.altKey) { e.stopPropagation(); removeKf(i); } }}
            onDoubleClick={(e) => { e.stopPropagation(); cycleCurve(i); }}
            title={`${fmt(k.v)} @ ${k.t.toFixed(2)}s · ${k.curve ?? 'linear'}\ndrag to move (shift = value only, alt = time only) · double-click: curve · right-click: delete`}
            className={`absolute w-[9px] h-[9px] -ml-[4.5px] -mt-[4.5px] rotate-45 cursor-pointer ${sel === i ? 'bg-fg-1 border border-fg-1' : 'bg-accent border border-accent'}`}
            style={{ left: k.t * pxPerSec, top: valueToY(k.v) }} />
        ))}
      </div>
    </div>
  );
};
