// Controls generated from the shader's own header.
//
// The author declares a knob; this draws it. Nothing here is per-shader code — add an input to a
// header and the control appears, which is the entire point of declaring rather than hardcoding.
//
// Every control writes the AUTHORED value onto the surface. An automation lane writes somewhere else
// (a live override the plugin owns), so a lane and a slider never fight over the same storage and
// switching a lane off returns the picture to whatever the operator set.

import React from 'react';
import type { SurfaceContent } from '@/types';
import { PALETTE_NAMES } from '@/gpu/palettes';
import type { ShaderInput } from './header';

const NUM =
  'w-16 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-right text-fg-1 text-micro num focus:border-accent focus:outline-none';
const SELECT =
  'flex-1 min-w-0 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-fg-1 text-micro focus:border-accent focus:outline-none';

function toHex(c: number[]): string {
  const b = (v: number) => Math.max(0, Math.min(255, Math.round((v ?? 0) * 255))).toString(16).padStart(2, '0');
  return `#${b(c[0])}${b(c[1])}${b(c[2])}`;
}
function fromHex(hex: string, alpha: number): number[] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}

export function ShaderParamControls({
  inputs,
  content,
  onChange,
}: {
  inputs: ShaderInput[];
  content: SurfaceContent;
  onChange: (patch: Partial<SurfaceContent>) => void;
}): React.ReactElement | null {
  if (!inputs.length) return null;

  const value = (i: ShaderInput): number | number[] => {
    const v = content.shaderParams?.[i.name];
    if (v === undefined) return i.def;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v as number | number[];
  };

  // Merge, never replace: two inputs on one surface must not overwrite each other, and a param the
  // header dropped keeps its stored value in case it comes back on the next edit.
  const set = (name: string, v: number | boolean | number[]) =>
    onChange({ shaderParams: { ...(content.shaderParams ?? {}), [name]: v } });

  return (
    <div className="space-y-1 pt-1">
      {inputs.map((i) => {
        const v = value(i);
        return (
          <div key={i.name} className="flex items-center gap-1">
            <label className="text-fg-2 w-16 shrink-0 truncate text-micro" title={`${i.name} · ${i.type}`}>{i.label}</label>

            {/* A damper reads as a TIME, so it says so. Same slider as a float otherwise — the
                difference is what the plugin does with the number, not how it is set. */}
            {i.type === 'beatDamp' && (
              <>
                <input type="range" className="flex-1 min-w-0 accent-accent"
                  min={i.min} max={i.max} step={0.01}
                  value={v as number} onChange={(e) => set(i.name, +e.target.value)} />
                <span className="w-12 shrink-0 text-right text-micro text-fg-2 num">{(v as number).toFixed(2)} s</span>
              </>
            )}

            {i.type === 'float' && (
              <>
                <input type="range" className="flex-1 min-w-0 accent-accent"
                  min={i.min} max={i.max} step={i.step ?? (i.max - i.min) / 200}
                  value={v as number} onChange={(e) => set(i.name, +e.target.value)} />
                <input type="number" className={NUM} step={i.step ?? (i.max - i.min) / 200}
                  value={+(v as number).toFixed(4)} onChange={(e) => set(i.name, +e.target.value)} />
              </>
            )}

            {i.type === 'bool' && (
              <input type="checkbox" className="accent-accent"
                checked={(v as number) >= 0.5} onChange={(e) => set(i.name, e.target.checked)} />
            )}

            {i.type === 'long' && (
              <select className={SELECT} value={v as number} onChange={(e) => set(i.name, +e.target.value)}>
                {(i.labels ?? []).map((label, n) => (
                  <option key={label} value={i.values?.[n] ?? n}>{label}</option>
                ))}
                {/* A `long` with no LABELS is legal and means "a plain integer" — give it a number box
                    rather than an empty dropdown the operator cannot use. */}
                {!i.labels?.length && <option value={v as number}>{String(v)}</option>}
              </select>
            )}

            {/* The palette list comes from the app's own gradients, so an operator's shader offers the
                same choices as the built-in effects rather than an invented set. */}
            {i.type === 'palette' && (
              <select className={SELECT} value={v as number} onChange={(e) => set(i.name, +e.target.value)}>
                {PALETTE_NAMES.map((name, n) => <option key={name} value={n}>{name}</option>)}
              </select>
            )}

            {i.type === 'color' && (
              <input type="color" className="h-5 w-10 bg-transparent border border-line-1 rounded"
                value={toHex(v as number[])}
                onChange={(e) => set(i.name, fromHex(e.target.value, (v as number[])[3] ?? 1))} />
            )}

            {i.type === 'point2D' && (
              <div className="flex flex-1 min-w-0 gap-1">
                {[0, 1].map((axis) => (
                  <input key={axis} type="number" className={NUM} step={0.01}
                    value={+(((v as number[])[axis] ?? 0)).toFixed(3)}
                    onChange={(e) => {
                      const next = [...(v as number[])];
                      next[axis] = +e.target.value;
                      set(i.name, next);
                    }} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
