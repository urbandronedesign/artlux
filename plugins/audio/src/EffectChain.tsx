// The effect-chain editor — add / remove / reorder / bypass nodes and ride their params. Used at both
// insert points: on a clip (before it is spatialised) and on the master bus (after the ambisonic field
// is decoded). The offered effect list differs by scope — reverb is clip-only, see effectDefs.ts.
//
// Every edit replaces the whole chain; the engine diffs it, so moving a slider updates the running DSP
// in place rather than rebuilding it (no click, no dropout).
import React from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, Power } from 'lucide-react';
import { defsFor, defOf, makeEffect, toSlider, fromSlider, type EffectScope, type ParamDef } from './effectDefs';
import { Fader } from './Fader';

export interface Effect {
  id: string;
  type: string;
  bypass?: boolean;
  params: Record<string, number>;
  opts?: Record<string, string>;
}

const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `fx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

const fmt = (p: ParamDef, v: number) => {
  const n = p.step >= 1 ? Math.round(v) : Number(v.toFixed(p.step >= 0.1 ? 1 : 2));
  return `${n}${p.unit ? ` ${p.unit}` : ''}`;
};

// The slider rides in SLIDER SPACE (0..1 for a log param, the raw range otherwise) and is mapped back on
// commit — so a Fader draft is a slider position, and the readout maps it through fromSlider to show the
// value the operator is actually dialling.
//
// ⚠ INVARIANT 7. This used to call onChange() per DOM input event — i.e. per pointermove — and one of those
// is a whole host.audio.setMix → App re-render → recompileAutomation → audio fan-out (an engine lock per
// clip, per frame). Dragging a cutoff was paying that 60×/s on a running show. Draft, then commit once.
const ParamRow: React.FC<{ p: ParamDef; value: number; disabled?: boolean; onCommit: (v: number) => void }> = ({ p, value, disabled, onCommit }) => (
  <label className="flex items-center gap-2">
    <span className="text-micro text-fg-3 w-16 shrink-0">{p.label}</span>
    <Fader
      min={p.curve === 'log' ? 0 : p.min}
      max={p.curve === 'log' ? 1 : p.max}
      step={p.curve === 'log' ? 0.001 : p.step}
      value={toSlider(p, value)}
      disabled={disabled}
      ariaLabel={p.label}
      onCommit={(s) => onCommit(fromSlider(p, s))}
      className="flex-1 min-w-0"
      readout={(s) => fmt(p, fromSlider(p, s))}
      readoutClassName="text-micro text-fg-2 tabular-nums w-16 text-right shrink-0"
    />
  </label>
);

export const EffectChain: React.FC<{
  scope: EffectScope;
  effects: Effect[];
  onChange: (effects: Effect[]) => void;
  /** Read-only display (the mixer's inspector shows a TIMELINE clip's chain but cannot write to it — the
   *  panel has no write path into Timeline.audio; that document is core's). Every control is inert. */
  disabled?: boolean;
}> = ({ scope, effects, onChange, disabled }) => {
  const available = defsFor(scope);

  const patch = (i: number, e: Partial<Effect>) => onChange(effects.map((fx, j) => (j === i ? { ...fx, ...e } : fx)));
  const remove = (i: number) => onChange(effects.filter((_, j) => j !== i));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= effects.length) return;
    const next = effects.slice();
    [next[i], next[j]] = [next[j], next[i]]; // order is audible — a filter before a reverb ≠ after it
    onChange(next);
  };
  const add = (type: string) => { if (type) onChange([...effects, makeEffect(type, uid())]); };

  return (
    <div className="space-y-1.5">
      {effects.length === 0 ? (
        <div className="text-micro text-fg-3/70 italic">No effects. The signal passes through untouched.</div>
      ) : effects.map((fx, i) => {
        const def = defOf(fx.type);
        if (!def) return null;
        return (
          <div key={fx.id} className={`rounded border border-line-1 bg-surface-1 ${fx.bypass ? 'opacity-50' : ''}`}>
            <div className="h-7 px-2 flex items-center gap-1.5 border-b border-line-1/60">
              <span className="text-micro font-semibold text-fg-1">{def.label}</span>
              <span className="text-micro text-fg-3/70 truncate flex-1" title={def.blurb}>{def.blurb}</span>
              <button onClick={() => move(i, -1)} disabled={disabled || i === 0} title="Move earlier in the chain"
                className="text-fg-3 hover:text-fg-1 disabled:opacity-25 disabled:hover:text-fg-3"><ChevronUp size={12} /></button>
              <button onClick={() => move(i, 1)} disabled={disabled || i === effects.length - 1} title="Move later in the chain"
                className="text-fg-3 hover:text-fg-1 disabled:opacity-25 disabled:hover:text-fg-3"><ChevronDown size={12} /></button>
              <button onClick={() => patch(i, { bypass: !fx.bypass })} disabled={disabled} title={fx.bypass ? 'Enable' : 'Bypass'}
                className={`disabled:opacity-40 ${fx.bypass ? 'text-fg-3 hover:text-fg-1' : 'text-accent'}`}><Power size={12} /></button>
              <button onClick={() => remove(i)} disabled={disabled} title="Remove"
                className="text-fg-3 hover:text-danger disabled:opacity-25 disabled:hover:text-fg-3"><Trash2 size={12} /></button>
            </div>
            <div className="px-2 py-1.5 space-y-1">
              {(def.opts ?? []).map((o) => (
                <label key={o.key} className="flex items-center gap-2">
                  <span className="text-micro text-fg-3 w-16 shrink-0">{o.label}</span>
                  <select
                    value={fx.opts?.[o.key] ?? o.def}
                    disabled={disabled}
                    onChange={(e) => patch(i, { opts: { ...(fx.opts ?? {}), [o.key]: e.target.value } })}
                    className="bg-surface-2 border border-line-1 rounded px-1 h-5 text-micro text-fg-1 outline-none disabled:opacity-40">
                    {o.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </label>
              ))}
              {def.params.map((p) => (
                <ParamRow key={p.key} p={p} value={fx.params?.[p.key] ?? p.def} disabled={disabled}
                  onCommit={(v) => patch(i, { params: { ...(fx.params ?? {}), [p.key]: v } })} />
              ))}
            </div>
          </div>
        );
      })}

      <select value="" onChange={(e) => add(e.target.value)} disabled={disabled}
        className="w-full bg-surface-2 border border-line-1 rounded px-1.5 h-6 text-micro text-fg-2 outline-none hover:text-fg-1 disabled:opacity-40 disabled:cursor-not-allowed">
        <option value="">+ Add effect…</option>
        {available.map((d) => <option key={d.type} value={d.type}>{d.label}</option>)}
      </select>
      {scope === 'master' && (
        <div className="text-micro text-fg-3/70 flex items-center gap-1">
          <Plus size={10} className="opacity-0" />
          Reverb is not offered here — it only works on 1–2 channels, so on a speaker decode it would pass dry.
        </div>
      )}
    </div>
  );
};
