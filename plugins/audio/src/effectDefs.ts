// The effect param registry — one source of truth for what each effect exposes, and the ranges the UI
// offers. Pure data, no imports, no module-level mutation: the plugin declares "sideEffects": false, so
// a self-registering registry would be tree-shaken away.
//
// THESE RANGES MIRROR THE ENGINE'S CLAMPS in native/audio-engine/src/effects.h. The engine clamps
// independently (it must — a hand-edited project file can carry anything), so the two tables must agree
// or the UI will offer a value the engine silently refuses. If you change one, change the other.

// Mirrors MASTER_BUS_ID in src/renderer/types.ts. The plugin can't import core renderer types, so the
// constant is restated here rather than duplicated by accident.
export const MASTER_BUS_ID = 'master';

export type EffectScope = 'clip' | 'master';

export interface ParamDef {
  key: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  step: number;
  def: number;
  /** Log-ish response for a slider whose useful range is bunched at the bottom (cutoff, delay time). */
  curve?: 'log';
}
export interface OptDef {
  key: string;
  label: string;
  choices: { value: string; label: string }[];
  def: string;
}
export interface EffectDef {
  type: string;
  label: string;
  blurb: string;
  params: ParamDef[];
  opts?: OptDef[];
  /** Which insert points may host it. Reverb is CLIP-ONLY — see below. */
  scopes: EffectScope[];
}

export const EFFECT_DEFS: EffectDef[] = [
  {
    type: 'gain',
    label: 'Gain',
    blurb: 'A simple level trim, smoothed so it never clicks.',
    scopes: ['clip', 'master'],
    params: [{ key: 'gainDb', label: 'Gain', unit: 'dB', min: -60, max: 12, step: 0.5, def: 0 }],
  },
  {
    type: 'filter',
    label: 'Filter',
    blurb: '12 dB/oct low-, high- or band-pass. No peaking EQ — the filter has no gain stage.',
    scopes: ['clip', 'master'],
    opts: [{
      key: 'mode',
      label: 'Mode',
      def: 'lowpass',
      choices: [
        { value: 'lowpass', label: 'Low-pass' },
        { value: 'highpass', label: 'High-pass' },
        { value: 'bandpass', label: 'Band-pass' },
      ],
    }],
    params: [
      { key: 'cutoff', label: 'Cutoff', unit: 'Hz', min: 20, max: 20000, step: 1, def: 1000, curve: 'log' },
      { key: 'resonance', label: 'Resonance', min: 0.1, max: 10, step: 0.01, def: 0.707 },
    ],
  },
  {
    type: 'reverb',
    label: 'Reverb',
    // Not a UI limitation — juce::dsp::Reverb is a <=2 channel processor, and above that it silently
    // passes the DRY signal. On a speaker-layout decode that would look wired, meter normally, and do
    // nothing. The engine refuses it on the master too. A master reverb here needs a diffuse B-format
    // design (it has to live IN the ambisonic field, not after it), which is a later phase.
    blurb: 'Puts the source in a room. Clip inserts only: a master reverb in an ambisonic rig has to be a diffuse B-format reverb, which this is not.',
    scopes: ['clip'],
    params: [
      { key: 'roomSize', label: 'Room size', min: 0, max: 1, step: 0.01, def: 0.5 },
      { key: 'damping', label: 'Damping', min: 0, max: 1, step: 0.01, def: 0.5 },
      { key: 'wet', label: 'Wet', min: 0, max: 1, step: 0.01, def: 0.33 },
      { key: 'dry', label: 'Dry', min: 0, max: 1, step: 0.01, def: 0.4 },
      { key: 'width', label: 'Width', min: 0, max: 1, step: 0.01, def: 1 },
    ],
  },
  {
    type: 'delay',
    label: 'Delay',
    blurb: 'Echo with feedback. Feedback is capped at 0.95 — 1.0 is an unbounded runaway.',
    scopes: ['clip', 'master'],
    params: [
      { key: 'timeMs', label: 'Time', unit: 'ms', min: 1, max: 2000, step: 1, def: 250, curve: 'log' },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01, def: 0.35 },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.3 },
    ],
  },
  {
    type: 'compressor',
    label: 'Compressor',
    blurb: 'Channel-linked: one envelope drives every channel, so it never shifts the spatial image.',
    scopes: ['clip', 'master'],
    params: [
      { key: 'thresholdDb', label: 'Threshold', unit: 'dB', min: -60, max: 0, step: 0.5, def: -18 },
      { key: 'ratio', label: 'Ratio', unit: ':1', min: 1, max: 20, step: 0.1, def: 4 },
      { key: 'attackMs', label: 'Attack', unit: 'ms', min: 0.1, max: 200, step: 0.1, def: 10, curve: 'log' },
      { key: 'releaseMs', label: 'Release', unit: 'ms', min: 5, max: 2000, step: 1, def: 100, curve: 'log' },
      { key: 'makeupDb', label: 'Makeup', unit: 'dB', min: 0, max: 24, step: 0.5, def: 0 },
    ],
  },
];

export const defsFor = (scope: EffectScope): EffectDef[] => EFFECT_DEFS.filter((d) => d.scopes.includes(scope));
export const defOf = (type: string): EffectDef | undefined => EFFECT_DEFS.find((d) => d.type === type);

/** A new effect node, with every param at its default (so the engine never has to guess). */
export const makeEffect = (type: string, id: string): { id: string; type: string; params: Record<string, number>; opts?: Record<string, string> } => {
  const def = defOf(type);
  const params: Record<string, number> = {};
  for (const p of def?.params ?? []) params[p.key] = p.def;
  const opts: Record<string, string> = {};
  for (const o of def?.opts ?? []) opts[o.key] = o.def;
  return def?.opts?.length ? { id, type, params, opts } : { id, type, params };
};

// Sliders are linear in position; a cutoff or a delay time is not useful that way (half the travel of a
// 20 Hz–20 kHz linear slider is above 10 kHz). These map slider position 0..1 ↔ value for `curve: 'log'`.
export const toSlider = (p: ParamDef, v: number): number => {
  if (p.curve !== 'log') return v;
  const lo = Math.log(Math.max(p.min, 1e-4)), hi = Math.log(p.max);
  return (Math.log(Math.min(Math.max(v, p.min), p.max)) - lo) / (hi - lo);
};
export const fromSlider = (p: ParamDef, s: number): number => {
  if (p.curve !== 'log') return s;
  const lo = Math.log(Math.max(p.min, 1e-4)), hi = Math.log(p.max);
  const v = Math.exp(lo + s * (hi - lo));
  return p.step >= 1 ? Math.round(v) : Number(v.toFixed(3));
};
