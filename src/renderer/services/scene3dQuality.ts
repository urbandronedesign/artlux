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

// The SECOND knob: a ceiling on how often the viewport redraws, in Hz. 0 = the display's own rate.
//
// This is a different lever from render scale and they do not overlap. Scale is a per-FRAGMENT cut —
// it helps only when the viewport is fill-rate bound, and measurement said this one is not (a 16×
// change in pixel count moved the frame rate by 0.3 fps). A rate cap cuts whole FRAMES: every draw
// call, every state change, every content upload the scene makes, all of it, proportionally.
//
// The reason it is worth having even on a viewport that never reaches 60 is that the 3D scene and the
// frame engine share one GPU and the engine is the one that feeds the wire. Measured on this project:
// the editor ran at 17.8–19.1 fps with the 3D viewport hidden and 10.6–11.6 with it visible, so the
// preview was taking roughly half the machine. Capping it at 15 hands most of that back to the show
// while leaving the viewport perfectly usable for placing fixtures.
//
// 0 (uncapped) is the default because it is exactly today's behaviour, and because the right value is
// a property of the machine and the rig — nothing here can guess it.
const FPS_CHOICES = [0, 60, 30, 24, 15, 10] as const;
const FPS_DEFAULT = 0;

let maxFps: number = FPS_DEFAULT;

function clampFps(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(240, Math.max(1, Math.round(v)));
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
        const f = p?.scene3dMaxFps;
        if (typeof f === 'number') maxFps = clampFps(f);
        subs.forEach((fn) => fn());
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

/** 0 = uncapped (the display's rate). */
export function getMaxFps(): number { return maxFps; }

/** Set + persist. Applies live: the Canvas swaps its frameloop through useMaxFps. */
export function setMaxFps(v: number): void {
  const next = clampFps(v);
  if (next === maxFps) return;
  maxFps = next;
  subs.forEach((f) => f());
  void window.artlux?.setPrefs?.({ scene3dMaxFps: next });
}

export const MAX_FPS_CHOICES = FPS_CHOICES;

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

/** Same binding for the rate cap. Separate hook so a slider drag on one does not re-render the other. */
export function useMaxFps(): number {
  const [v, setV] = useState(maxFps);
  useEffect(() => {
    const off = subscribe(() => setV(getMaxFps()));
    void ensureLoaded().then(() => setV(getMaxFps()));
    return off;
  }, []);
  return v;
}
