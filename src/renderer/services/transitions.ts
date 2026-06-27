import type { CueTransition } from '../types';
import { StateView, FadeTarget, setByPath, isGeometryPath } from './paramPath';

// Render-free fade/crossfade engine for Scenes & Cues. Modeled on livePreview/dmxSignal: an
// imperative singleton the Stage frame pump samples each frame to lay interpolated values over the
// committed state — so a fade animates at display rate WITHOUT React re-renders. React state is
// committed once (by the caller) when the fade starts; the engine only overrides the fadeable
// numeric paths until they finish, then clears and fires onComplete. Each "leg" (one parameter)
// carries its own duration/easing, so cues can fade individual params at different rates.

const EASES: Record<CueTransition, (t: number) => number> = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t),            // smoothstep (ease-in-out)
  damper: (t) => 1 - Math.pow(1 - t, 3),         // cubic ease-out (exponential-ish approach)
  none: () => 1,                                  // snap (handled as duration 0)
};

// One animated parameter. Extends FadeTarget {path, from, to} with optional per-leg timing.
export interface FadeLeg extends FadeTarget { transition?: CueTransition; fadeSec?: number }

interface ActiveLeg { path: string; from: number; to: number; durMs: number; ease: (t: number) => number; geom: boolean }
interface ActiveFade { legs: ActiveLeg[]; startMs: number; onComplete?: () => void }

let active: ActiveFade | null = null;

// Subscribers notified when a fade starts/ends (e.g. UI progress). Render-free.
const subs = new Set<(active: boolean) => void>();
const notify = (): void => { subs.forEach(cb => cb(active != null)); };
export function subscribe(cb: (active: boolean) => void): () => void { subs.add(cb); cb(active != null); return () => { subs.delete(cb); }; }

export interface SampleResult {
  apply: (base: StateView) => StateView; // lay interpolated values over the committed state
  geometryAnimating: boolean;            // GPU mapper must rebuild LED geometry this frame
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

// Begin a fade. `targets` carry absolute from→to numerics; discrete params are expected to have
// already been committed to React state by the caller (they show their target immediately).
// `opts.fadeSec`/`opts.transition` are the batch defaults; a leg may override either.
export function start(targets: FadeLeg[], opts: { fadeSec: number; transition?: CueTransition; onComplete?: () => void }): void {
  const legs: ActiveLeg[] = targets.map((t) => {
    const trans = t.transition ?? opts.transition ?? 'smooth';
    const sec = t.fadeSec ?? opts.fadeSec;
    return {
      path: t.path, from: t.from, to: t.to,
      durMs: trans === 'none' ? 0 : Math.max(0, sec) * 1000,
      ease: EASES[trans] ?? EASES.smooth,
      geom: isGeometryPath(t.path),
    };
  });
  const willAnimate = legs.some((l) => l.durMs > 0);
  if (!willAnimate) {
    // Nothing to animate — run completion immediately (caller already committed target state).
    opts.onComplete?.();
    if (active) { active = null; notify(); }
    return;
  }
  active = { legs, startMs: performance.now(), onComplete: opts.onComplete };
  notify();
}

export function cancel(): void { if (active) { active = null; notify(); } }
export function isActive(): boolean { return active != null; }

// Called once per frame by the Stage pump. Returns null when idle. Fires onComplete and clears
// when every leg has finished (on the frame the last leg reaches progress 1).
export function sample(nowMs: number): SampleResult | null {
  const a = active;
  if (!a) return null;
  let allDone = true;
  let geomAnimating = false;
  for (const leg of a.legs) {
    const raw = leg.durMs <= 0 ? 1 : (nowMs - a.startMs) / leg.durMs;
    if (raw < 1) { allDone = false; if (leg.geom) geomAnimating = true; }
  }
  const apply = (base: StateView): StateView => {
    let v = base;
    for (const leg of a.legs) {
      const raw = leg.durMs <= 0 ? 1 : (nowMs - a.startMs) / leg.durMs;
      const val = raw >= 1 ? leg.to : leg.from + (leg.to - leg.from) * leg.ease(clamp01(raw));
      v = setByPath(v, leg.path, val);
    }
    return v;
  };
  const result: SampleResult = { apply, geometryAnimating: geomAnimating };
  if (allDone) { active = null; a.onComplete?.(); notify(); }
  return result;
}
