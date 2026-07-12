import type { CueTransition } from '../types';
import { StateView, FadeTarget, setByPath, getByPath, isGeometryPath } from './paramPath';
import * as automationOverlay from './automationOverlay';
import { automationTargetRegistry } from '../host/registries';

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
// `log`: interpolate in LOG space (a filter cutoff is 20 Hz–20 kHz with curve:'log', and so are a delay's
// timeMs and a compressor's attack/release). Only PLUGIN-namespaced legs carry it — core legs never set it,
// so their behaviour is byte-identical. See the plugin arm of apply() below (DC15).
export interface FadeLeg extends FadeTarget { transition?: CueTransition; fadeSec?: number; log?: boolean }

interface ActiveLeg { path: string; from: number; to: number; durMs: number; ease: (t: number) => number; geom: boolean; log: boolean }
interface ActiveFade { legs: ActiveLeg[]; startMs: number; onComplete?: () => void }

// The heads that live on the StateView. Everything else is a PLUGIN NAMESPACE and is written through its
// AutomationTargetProvider — setByPath would silently no-op on it (paramPath's `return view`).
const CORE_HEADS = new Set(['globalBrightness', 'surfaces', 'fixtures']);

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
      log: t.log ?? false,
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
  // PRECEDENCE — the one rule: THE LANE OWNS THE PATH, AND A FADE LANDS ON IT.
  //
  // `base` here has already had the automation overlay applied (Stage lays it down first), so for an
  // automated path `getByPath(base, ...)` IS the live curve value. Re-reading `to` from it each frame
  // means the fade glides onto the moving curve and, at progress 1, its value already equals the curve's.
  //
  // The alternatives are both visibly wrong on a real desk: sampling automation AFTER the fade would make
  // every automated param SNAP the instant a scene is recalled (a 5s crossfade becomes an instant jump on
  // exactly the params the operator cares most about), while freezing `to` at recall would hold the param
  // static for the fade and then STEP onto the curve the frame the leg completes. Neither is shippable.
  // For a path with no lane, toDynamic is false and this is byte-identical to what it always did.
  const apply = (base: StateView): StateView => {
    let v = base;
    for (const leg of a.legs) {
      const raw = leg.durMs <= 0 ? 1 : (nowMs - a.startMs) / leg.durMs;
      const head = leg.path.split('.')[0];
      if (!CORE_HEADS.has(head)) {
        // A PLUGIN-NAMESPACED LEG (today: audio.*). It does NOT live on the StateView and setByPath would
        // silently no-op on it (paramPath.ts's `return view`). It goes to the namespace's owner, into a
        // LIVE FADE LAYER the provider keeps SEPARATE from its automation-override layer.
        //
        // NO owns() QUERY, AND NONE IS POSSIBLE: automationOverlay.owns() is a CORE-ONLY map, and core
        // never reaches inside a plugin's override layer (automationOverlay.ts states the boundary).
        // "A lane always wins over a scene fade" is enforced STRUCTURALLY instead, by the provider's READ
        // ORDER — laneOverride ?? fadeOverride ?? authored — so the fade simply lands UNDERNEATH a live
        // lane and becomes visible the instant that lane is disabled. That is the same "nothing is ever
        // restored, because nothing was ever overwritten" doctrine core already follows, one layer deeper.
        //
        // No re-targeting either (the getByPath(base, …) glide below): base carries no audio, so there is
        // nothing to read. The fade runs its authored from→to and lands under whatever owns the path.
        //
        // LOG-CURVE PARAMS INTERPOLATE IN LOG SPACE (DC15). A filter cutoff is 20 Hz–20 kHz with
        // `curve: 'log'`; so are a delay's timeMs and a compressor's attack/release. The AUTOMATION engine
        // honours that (LaneRT.log → sampleLane) and the SDK contract states it — so a linear fade of the
        // same move would be past 4 kHz in the first 700 ms of a 3 s sweep and would sound nothing like the
        // identical curve drawn on a lane, which is the comparison the operator makes in the room. Guarded:
        // a hand-authored 0 endpoint falls back to linear rather than producing Math.log(0) = -Infinity →
        // NaN → setClipEffects(NaN).
        const t = leg.ease(clamp01(raw));
        const val = raw >= 1 ? leg.to
          : (leg.log && leg.from > 0 && leg.to > 0)
            ? Math.exp(Math.log(leg.from) + (Math.log(leg.to) - Math.log(leg.from)) * t)
            : leg.from + (leg.to - leg.from) * t;
        automationTargetRegistry.get(head)?.writeFade?.(leg.path, val);
        continue;
      }
      // Whether a lane owns this path is asked EVERY FRAME, not captured at start(). Two things would
      // break a snapshot: a scene recall starts the fade BEFORE it swaps the timeline (so the lane set
      // at start() is the OUTGOING scene's), and a lane can be enabled or disabled mid-fade. It's a
      // Map.has — cheaper than being wrong.
      const to = automationOverlay.owns(leg.path)
        ? ((getByPath(base, leg.path) as number | undefined) ?? leg.to)
        : leg.to;
      const val = raw >= 1 ? to : leg.from + (to - leg.from) * leg.ease(clamp01(raw));
      v = setByPath(v, leg.path, val);
    }
    return v;
  };
  const result: SampleResult = { apply, geometryAnimating: geomAnimating };
  if (allDone) { active = null; a.onComplete?.(); notify(); }
  return result;
}
