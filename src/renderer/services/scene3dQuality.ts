// 3D viewport quality — the per-MACHINE knobs that trade fidelity in the Scene view for GPU headroom.
//
// Why a service and not `Scene3D` in the project: `Scene3D.glow` / `gridVisible` / `reflectiveFloor`
// describe what the scene SHOWS, so they belong to the document and travel with it. Render scale
// describes what this computer can afford. A show authored on the workstation must not arrive at the
// venue carrying the laptop's half-resolution setting, and the laptop must not have to re-set it for
// every project it opens. So it lives in Prefs (userData), like uiScale.
//
// Why a subscribe channel and not props: the Canvas is mounted deep inside the shell and the setting is
// changed in Preferences, a different context entirely. Threading it through App would mean a state
// field that re-renders the whole tree on a slider drag — the thing this file exists to avoid paying.
// Same shape as dmxSignal/fixtureSignal: a module singleton with a value and a subscriber set.

import { useEffect, useState } from 'react';

// The renderer's device-pixel ratio for the 3D canvas. 1 = one canvas pixel per CSS pixel.
//
// The default is deliberately 1 and NOT the previous `[1, 2]`. On a hiDPI display `[1, 2]` means the
// scene renders at twice the linear resolution — FOUR times the pixels, and therefore four times every
// per-fragment cost in the viewport (the ground grid's shader plane, beam overdraw, every textured
// screen). That is the single largest fill-rate lever available here and it was not previously
// reachable. 1 looks marginally softer on a hiDPI panel and roughly doubles the frame rate on a weak
// GPU; a workstation that wants the sharpness can set 2.
const MIN = 0.5;
const MAX = 2;
const DEFAULT = 1;

let renderScale = DEFAULT;
const subs = new Set<() => void>();

function clamp(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT;
  return Math.min(MAX, Math.max(MIN, v));
}

// Read the saved value once, on first use rather than at module load. Both consumers (the Canvas and
// the Preferences slider) call this from their own mount, so there is no boot-order coupling to get
// wrong and no import side effect — and the 3D canvas mounts lazily anyway, so the read still lands
// before the first 3D frame.
let loading: Promise<void> | null = null;
export function ensureLoaded(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        const p = await window.artlux?.getPrefs?.();
        const v = p?.scene3dRenderScale;
        if (typeof v === 'number') renderScale = clamp(v);
        subs.forEach((f) => f());
      } catch { /* prefs unavailable — keep the default */ }
    })();
  }
  return loading;
}

export function getRenderScale(): number { return renderScale; }


/** Set + persist. Applies live: the Canvas re-reads it through useRenderScale. */
export function setRenderScale(v: number): void {
  const next = clamp(v);
  if (next === renderScale) return;
  renderScale = next;
  subs.forEach((f) => f());
  void window.artlux?.setPrefs?.({ scene3dRenderScale: next });
}

export function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

export const RENDER_SCALE_MIN = MIN;
export const RENDER_SCALE_MAX = MAX;


/** React binding for the Canvas. Re-renders only the component that asks — not the tree. */
export function useRenderScale(): number {
  const [v, setV] = useState(renderScale);
  useEffect(() => {
    const off = subscribe(() => setV(getRenderScale()));
    void ensureLoaded().then(() => setV(getRenderScale()));
    return off;
  }, []);
  return v;
}
