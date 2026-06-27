import { StateView, FadeTarget, setByPath, isGeometryPath } from './paramPath';

// Render-free fade/crossfade engine for Scenes & Cues. Modeled on livePreview/dmxSignal: an
// imperative singleton the Stage frame pump samples each frame to lay interpolated values over the
// committed state — so a fade animates at display rate WITHOUT React re-renders. React state is
// committed once (by the caller) when the fade starts; the engine only overrides the fadeable
// numeric paths until the fade completes, then clears and fires onComplete.

export type CueTransition = 'linear' | 'smooth' | 'damper' | 'none';

interface ActiveFade {
  targets: FadeTarget[];
  startMs: number;
  durMs: number;
  ease: (t: number) => number;
  geometry: boolean;
  onComplete?: () => void;
}

const EASES: Record<CueTransition, (t: number) => number> = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t),            // smoothstep (ease-in-out)
  damper: (t) => 1 - Math.pow(1 - t, 3),         // cubic ease-out (exponential-ish approach)
  none: () => 1,                                  // snap (handled as instant)
};

let active: ActiveFade | null = null;

// Subscribers notified when a fade starts/ends (e.g. UI progress). Render-free.
const subs = new Set<(active: boolean) => void>();
const notify = (): void => { subs.forEach(cb => cb(active != null)); };
export function subscribe(cb: (active: boolean) => void): () => void { subs.add(cb); cb(active != null); return () => { subs.delete(cb); }; }

export interface SampleResult {
  apply: (base: StateView) => StateView; // lay interpolated values over the committed state
  geometryAnimating: boolean;            // GPU mapper must rebuild LED geometry this frame
}

// Begin a fade. `targets` carry absolute from→to numerics; discrete params are expected to have
// already been committed to React state by the caller (they show their target immediately).
export function start(targets: FadeTarget[], opts: { fadeSec: number; transition?: CueTransition; onComplete?: () => void }): void {
  const dur = Math.max(0, opts.fadeSec) * 1000;
  const trans = opts.transition ?? 'smooth';
  if (dur <= 0 || trans === 'none' || targets.length === 0) {
    // Nothing to animate — run completion immediately (caller already committed target state).
    opts.onComplete?.();
    if (active) { active = null; notify(); }
    return;
  }
  active = {
    targets,
    startMs: performance.now(),
    durMs: dur,
    ease: EASES[trans] ?? EASES.smooth,
    geometry: targets.some(t => isGeometryPath(t.path)),
    onComplete: opts.onComplete,
  };
  notify();
}

export function cancel(): void { if (active) { active = null; notify(); } }
export function isActive(): boolean { return active != null; }

// Called once per frame by the Stage pump. Returns null when idle. Fires onComplete and clears
// when the fade finishes (on the frame progress reaches 1).
export function sample(nowMs: number): SampleResult | null {
  const a = active;
  if (!a) return null;
  const raw = (nowMs - a.startMs) / a.durMs;
  const done = raw >= 1;
  const e = a.ease(Math.min(1, Math.max(0, raw)));
  const apply = (base: StateView): StateView => {
    let v = base;
    for (const t of a.targets) {
      const val = done ? t.to : t.from + (t.to - t.from) * e;
      v = setByPath(v, t.path, val);
    }
    return v;
  };
  const result: SampleResult = { apply, geometryAnimating: a.geometry && !done };
  if (done) { active = null; a.onComplete?.(); notify(); }
  return result;
}
