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

/** The param a single Fader gesture touched. See the note on `onChange` below. */
export interface FxParamRef { fxId: string; key: string }

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
//
// THE DRAFT/COMMIT SPLIT IS `Fader`, AND IT IS LOAD-BEARING TWICE OVER NOW THAT THIS CHAIN ALSO EDITS A CLIP
// IN A TIMELINE'S OWN AUDIO. That commit is not a setMix — it is a CORE DOCUMENT commit (engine.setData →
// clampPlayheadIntoDoc + warmMedia + pruneStaleLayers + compileAutomation) plus a structured-clone
// postMessage of the WHOLE document to EVERY projector port. Sixty of those a second, while an operator
// rides a reverb knob, is a frame-rate cliff on the projectors — i.e. on the picture in the venue. If you
// ever swap this Fader for a raw <input type="range" onChange={...}>, you have shipped that cliff.
//
// AND BECAUSE THE GESTURE IS SPLIT, IT CAN OUTLIVE ITS DOCUMENT — hence `docKey`, threaded straight down to
// the Fader. A recall lands between the pointerdown and the pointerup; React keys the node on `fx.id`, which
// Capture Scene ALIASES between the two scenes, so the row does not remount and its draft is still holding
// scene A's value when the commit fires against scene B's identically-id'd chain. See Fader.docKey.
const ParamRow: React.FC<{ p: ParamDef; value: number; disabled?: boolean; docKey?: () => string; onCommit: (v: number) => void }> = ({ p, value, disabled, docKey, onCommit }) => (
  <label className="flex items-center gap-2">
    <span className="text-micro text-fg-3 w-16 shrink-0">{p.label}</span>
    <Fader
      min={p.curve === 'log' ? 0 : p.min}
      max={p.curve === 'log' ? 1 : p.max}
      step={p.curve === 'log' ? 0.001 : p.step}
      value={toSlider(p, value)}
      disabled={disabled}
      docKey={docKey}
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
  /**
   * The whole chain, every time — the engine diffs it.
   *
   * `touched` NAMES THE PARAM A FADER GESTURE JUST RODE, and it exists because THE CHAIN ALONE CANNOT SAY.
   * A gesture that lands back ON the authored value (grab the cutoff, wiggle, put it back) hands back a
   * BYTE-IDENTICAL chain — and it is still a takeover: what the operator hears is the scene/cue FADE, which
   * persists over the authored value until releaseFade() drops it (Fader.tsx). The consumer's release is
   * DIFFED against the previous chain (adding a delay must not release a live filter fade nobody touched),
   * and a diff of an identical chain is empty. So the gesture says its own name.
   */
  onChange: (effects: Effect[], touched?: FxParamRef) => void;
  /**
   * Render every control inert.
   *
   * NOTHING PASSES THIS TODAY, and the reason it once did is worth keeping: the mixer's clip inspector used
   * to set it for a clip on the BOUND TIMELINE's own audio, because the panel had no write path into
   * Timeline.audio (that document is core's — it would need onChange(timeline), which no plugin can see).
   * It has one now (host.audio.patchTimelineClip), so BOTH insert points are live for BOTH containers. The
   * prop stays because "the host cannot write this document" is a state a plugin surface can be in again —
   * but if you reach for it, be sure the alternative is not simply plumbing the write.
   */
  disabled?: boolean;
  /**
   * Identity of the REBINDABLE document this chain edits, if it edits one — passed through to every param
   * Fader so a knob gesture straddling a scene recall is ABANDONED rather than committed into the incoming
   * scene's aliased effect id. See Fader.docKey.
   *
   * The MASTER bus and a BED clip pass nothing: neither document is rebindable, so neither gesture may be
   * abandoned. Only a clip in the bound timeline's own audio supplies it.
   *
   * The DISCRETE controls below (add / remove / reorder / bypass / a select) deliberately do NOT take it:
   * a click resolves in one task against the chain the panel is showing AT THAT INSTANT, so there is no
   * gesture to straddle a rebind. Only the continuous ones are split across time, and only they can lie.
   */
  docKey?: () => string;
}> = ({ scope, effects, onChange, disabled, docKey }) => {
  const available = defsFor(scope);

  // ⚠ SHAPE-GUARD THE CHAIN AT THE RENDER, because the document does not guarantee it. normalizeAudioMix
  // (types.ts) coerces the bed's tracks and clips but its BUSES are a shape guard only — its own comment
  // says so — so a hand-edited or bad-import `buses: [{ id: 'master', effects: "x" }]` SURVIVES load with
  // `effects` a string. `.map` on a string is a TypeError, thrown inside a plugin panel that has no
  // ErrorBoundary above it: the project loads clean and OPENING THE AUDIO BED PANEL is what dies, which is
  // the worst possible place to learn about it. Fall back to an empty chain — the operator sees "no
  // effects" and adding one writes a real array back, repairing the document. (The proper fix is to run
  // buses through the same coercion in normalizeAudioMix; that is a persist-a-coercion call and belongs
  // with the fade work, not here. This guard costs nothing and cannot regress valid data.)
  const fxs = Array.isArray(effects) ? effects : [];

  const patch = (i: number, e: Partial<Effect>, touched?: FxParamRef) => onChange(fxs.map((fx, j) => (j === i ? { ...fx, ...e } : fx)), touched);
  const remove = (i: number) => onChange(fxs.filter((_, j) => j !== i));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= fxs.length) return;
    const next = fxs.slice();
    [next[i], next[j]] = [next[j], next[i]]; // order is audible — a filter before a reverb ≠ after it
    onChange(next);
  };
  const add = (type: string) => { if (type) onChange([...fxs, makeEffect(type, uid())]); };

  return (
    <div className="space-y-1.5">
      {fxs.length === 0 ? (
        <div className="text-micro text-fg-3/70 italic">No effects. The signal passes through untouched.</div>
      ) : fxs.map((fx, i) => {
        const def = defOf(fx.type);
        if (!def) return null;
        return (
          <div key={fx.id} className={`rounded border border-line-1 bg-surface-1 ${fx.bypass ? 'opacity-50' : ''}`}>
            <div className="h-7 px-2 flex items-center gap-1.5 border-b border-line-1/60">
              <span className="text-micro font-semibold text-fg-1">{def.label}</span>
              <span className="text-micro text-fg-3/70 truncate flex-1" title={def.blurb}>{def.blurb}</span>
              <button onClick={() => move(i, -1)} disabled={disabled || i === 0} title="Move earlier in the chain"
                className="text-fg-3 hover:text-fg-1 disabled:opacity-25 disabled:hover:text-fg-3"><ChevronUp size={12} /></button>
              <button onClick={() => move(i, 1)} disabled={disabled || i === fxs.length - 1} title="Move later in the chain"
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
                <ParamRow key={p.key} p={p} value={fx.params?.[p.key] ?? p.def} disabled={disabled} docKey={docKey}
                  onCommit={(v) => patch(i, { params: { ...(fx.params ?? {}), [p.key]: v } }, { fxId: fx.id, key: p.key })} />
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
