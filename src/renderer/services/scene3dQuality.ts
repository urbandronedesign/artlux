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

// The THIRD knob: do the fixtures follow the transform gizmo while it is being dragged?
//
// ON by default, because a handle you drag blind is not a placement tool — that was the state before
// the preview channel existed and it is what makes precise work impossible. It is a preference at all
// because the preview recomputes the dragged fixtures' LED positions every frame, and the whole reason
// the gizmo commits on release is that doing this for the WHOLE rig at pointer rate is ruinous. The
// preview's own budget (fixturePreview.PREVIEW_LED_BUDGET) already drops to bodies-only on a huge
// selection, so this switch is the blunt escape hatch under that: off = exactly the old behaviour, one
// jump on release, reachable by an operator on a weak machine without a build.
let livePreview = true;

// The FOURTH knob, and the only one that is not about cost: which axes the transform gizmo's handles
// follow. 'world' is the room — what you want for hanging things level, and what this viewport has
// always drawn. 'local' turns the handles to the selected fixture, so a bar angled across a truss can
// be slid along its OWN length instead of along a room axis you then have to correct for.
//
// It lives here, with the per-machine settings, rather than in Scene3D: it describes how this operator
// likes to work, not anything about the show, and a handle orientation travelling to the venue inside
// a project file would be surprising in both directions.
let gizmoSpace: 'world' | 'local' = 'world';

// THE GRID A DRAG LANDS ON. A rigger works in round numbers — 250 mm along the truss, 15° of tilt —
// and a free drag can only approach one by eye. Snapping is three numbers plus a switch, and OFF by
// default because free-dragging is what this viewport has always done and is still the right tool for
// roughing a rig in. Hold Ctrl during a drag to invert whichever state it is in (see FixtureGizmo).
//
// `rotate` is DEGREES here and converted at the one place three wants radians. Storing radians would
// mean every reader — the header select, the nudge step, the readout — converting back.
export interface SnapSettings {
  on: boolean;
  /** Metres per step for a move. */
  move: number;
  /** Degrees per step for a rotate. */
  rotate: number;
  /** Factor per step for a scale (0.1 = 10% notches). */
  scale: number;
}

const SNAP_DEFAULT: SnapSettings = { on: false, move: 0.05, rotate: 15, scale: 0.1 };
let snap: SnapSettings = { ...SNAP_DEFAULT };

/** The steps offered in the viewport header. Free-typing is not worth a text field up there. */
export const SNAP_MOVE_CHOICES = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1] as const;
export const SNAP_ROTATE_CHOICES = [1, 5, 10, 15, 30, 45, 90] as const;
export const SNAP_SCALE_CHOICES = [0.01, 0.05, 0.1, 0.25, 0.5] as const;

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
        const lp = p?.scene3dLivePreview;
        if (typeof lp === 'boolean') livePreview = lp;
        const gs = p?.scene3dGizmoSpace;
        if (gs === 'world' || gs === 'local') gizmoSpace = gs;
        const sn = p?.scene3dSnap;
        if (sn) {
          snap = {
            on: typeof sn.on === 'boolean' ? sn.on : SNAP_DEFAULT.on,
            move: num(sn.move, SNAP_DEFAULT.move),
            rotate: num(sn.rotate, SNAP_DEFAULT.rotate),
            scale: num(sn.scale, SNAP_DEFAULT.scale),
          };
        }
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

/** Read by the gizmo at grab time, NOT through a hook: the drag must not depend on a component having
 *  re-rendered, and flipping this mid-gesture would change what that gesture means half way through. */
export function getLivePreview(): boolean { return livePreview; }

/** Set + persist. Applies to the NEXT gesture. */
export function setLivePreview(v: boolean): void {
  if (v === livePreview) return;
  livePreview = v;
  subs.forEach((f) => f());
  void window.artlux?.setPrefs?.({ scene3dLivePreview: v });
}

/** A saved step of 0 or NaN would freeze every drag on one spot; fall back rather than trust it. */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

export function getGizmoSpace(): 'world' | 'local' { return gizmoSpace; }

export function getSnap(): SnapSettings { return snap; }

/** Set + persist. Applies to the next drag AND to the next arrow-key nudge, which shares the step. */
export function setSnap(patch: Partial<SnapSettings>): void {
  const next = { ...snap, ...patch };
  if (next.on === snap.on && next.move === snap.move && next.rotate === snap.rotate && next.scale === snap.scale) return;
  snap = next;
  subs.forEach((f) => f());
  void window.artlux?.setPrefs?.({ scene3dSnap: next });
}

/** Set + persist. Applies live — the handles reorient on the next frame. */
export function setGizmoSpace(v: 'world' | 'local'): void {
  if (v === gizmoSpace) return;
  gizmoSpace = v;
  subs.forEach((f) => f());
  void window.artlux?.setPrefs?.({ scene3dGizmoSpace: v });
}

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

/** Drives the viewport header's World/Object button — and, through it, the gizmo. */
export function useGizmoSpace(): 'world' | 'local' {
  const [v, setV] = useState(gizmoSpace);
  useEffect(() => {
    const off = subscribe(() => setV(getGizmoSpace()));
    void ensureLoaded().then(() => setV(getGizmoSpace()));
    return off;
  }, []);
  return v;
}

/** Drives the header's magnet + step selects, and through them the gizmo. */
export function useSnap(): SnapSettings {
  const [v, setV] = useState(snap);
  useEffect(() => {
    const off = subscribe(() => setV(getSnap()));
    void ensureLoaded().then(() => setV(getSnap()));
    return off;
  }, []);
  return v;
}

/** For the Preferences toggle only — the 3D scene itself reads getLivePreview() at grab time. */
export function useLivePreview(): boolean {
  const [v, setV] = useState(livePreview);
  useEffect(() => {
    const off = subscribe(() => setV(getLivePreview()));
    void ensureLoaded().then(() => setV(getLivePreview()));
    return off;
  }, []);
  return v;
}
