// Preferences ▸ Shaders — the dampers.
//
// Sound-reactive values have one setting that decides whether they feel right, and it is not a
// threshold: it is how long a value takes to LET GO. Too short and a kick is a strobe; too long and
// the room never goes dark between hits. The right number depends on the music and on the size of the
// thing being lit — a wall wants a slower fall than a strip — so it is a knob, not a constant, and it
// is here rather than in each shader because it is a property of the ROOM, not of the effect.
//
// Machine-scoped, like the rest of AppSettings.plugins: it does not travel with the project. That is
// the right scope for the same reason the engine rate is — the same show in a bigger room deserves a
// different fall — but it does mean an operator setting this on a laptop finds it back at default at
// the venue. Said plainly in the panel rather than discovered.

import React from 'react';
import { DEFAULT_BAND_FALL_SEC, DEFAULT_BEAT_FALL_SEC } from './audioTap';

export interface ShaderCfg {
  bandFallSec?: number;
  beatFallSec?: number;
}

/** Read the plugin's slice out of AppSettings. One accessor so the panel and the plugin agree. */
export function readCfg(settings: unknown): ShaderCfg {
  const s = settings as { plugins?: Record<string, unknown> } | undefined;
  return (s?.plugins?.shader as ShaderCfg | undefined) ?? {};
}

function Row({
  label, hint, value, def, min, max, onChange,
}: {
  label: string; hint: string; value: number; def: number; min: number; max: number;
  onChange: (v: number) => void;
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label className="text-fg-2 w-28 shrink-0 text-xs">{label}</label>
        <input type="range" className="min-w-0 flex-1 accent-accent"
          min={min} max={max} step={0.01} value={value}
          onChange={(e) => onChange(+e.target.value)} />
        <span className="w-14 text-right text-micro text-fg-1 num">{value.toFixed(2)} s</span>
        <button
          onClick={() => onChange(def)} title="Back to the default"
          className="px-1.5 py-0.5 rounded border border-line-1 text-micro text-fg-3"
        >Reset</button>
      </div>
      <div className="pl-32 text-micro text-fg-3">{hint}</div>
    </div>
  );
}

export function ShaderSettings({
  settings, onChange,
}: {
  settings: unknown;
  onChange: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  const cfg = readCfg(settings);
  const host = (settings as { plugins?: Record<string, unknown> } | undefined)?.plugins ?? {};
  const set = (p: Partial<ShaderCfg>) => onChange({ plugins: { ...host, shader: { ...cfg, ...p } } });

  return (
    <div className="space-y-3">
      <Row
        label="Beat fall"
        hint="How long a beat flash takes to fade. Short is a strobe on every kick; long is a swell that is still fading when the next one lands."
        value={cfg.beatFallSec ?? DEFAULT_BEAT_FALL_SEC} def={DEFAULT_BEAT_FALL_SEC}
        min={0.05} max={2} onChange={(v) => set({ beatFallSec: v })}
      />
      <Row
        label="Spectrum fall"
        hint="How long the sixteen bands take to come back down. Raise it to calm a busy mix, lower it to follow fast material."
        value={cfg.bandFallSec ?? DEFAULT_BAND_FALL_SEC} def={DEFAULT_BAND_FALL_SEC}
        min={0.05} max={2} onChange={(v) => set({ bandFallSec: v })}
      />
      <div className="text-micro text-fg-3">
        Both apply to every shader on this machine, and take effect immediately — set them while the
        music is playing. They are a property of this computer and the room, so they stay here rather
        than travelling with the project.
      </div>
    </div>
  );
}
