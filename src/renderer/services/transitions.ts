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
const isCore = (path: string): boolean => CORE_HEADS.has(path.split('.')[0]);

// ── WHY THIS IS A LIST AND NOT ONE SLOT ─────────────────────────────────────────────────────────
// A 0.5 s look cue and a 20 s music duck are INDEPENDENT FADES. With a single slot, firing either one
// terminated the other: start() finalized every in-flight leg the incoming batch did not re-target
// straight to its endpoint, so an FSM- or scheduler-fired look cue that touches no audio at all snapped a
// running 20-second duck from ~0.95 to 0.3 IN ONE FRAME, mid-sentence, on the house PA — on schedule,
// every night, with nobody there to hear it happen. One fade slot for independent fades WAS the bug.
//
// Each batch keeps its OWN startMs, so every leg runs its own authored duration to completion. Paths never
// collide across batches: an incoming batch RE-TARGETS the paths it names (retarget() strips them out of
// the live batches, so the newest writer of a path is its only writer) and leaves every other leg alone.
//
// THE ONE THING A LEG CANNOT SURVIVE IS ITS TARGET BEING REPLACED. A core leg has no layer of its own: it
// interpolates OVER the committed StateView, so it is only valid while the document still holds the value
// it is heading for. A CUE patches the paths it names and nothing else, so its start() invalidates nothing
// but those paths (retarget covers them) — every other leg is still gliding toward a value the document
// still holds, which is why an unrelated cue no longer snaps a running crossfade to its endpoint either.
// A SCENE RECALL replaces the whole look, so every core leg is stale by definition and the recall says so
// itself: dropCoreLegs(). (A plugin leg owns a separate fade layer that nothing else writes — which is
// exactly why it can outlive both.)
let actives: ActiveFade[] = [];

// ── FINALIZING AN ABANDONED LEG ─────────────────────────────────────────────────────────────────
// A CORE leg needs nothing when a fade is dropped: its caller COMMITTED the target into React state
// before calling start(), so abandoning the animation simply snaps the param to the value the document
// already holds.
//
// A PLUGIN leg has NO committed target. The provider's fade layer IS the target, and that layer only ever
// holds whatever the last apply() frame happened to write. Abandon the animation without finalizing and
// the param is STRANDED at an arbitrary mid-glide value — not the outgoing scene's, not the incoming
// one's, but a number that depends on WHEN the operator pressed GO — and it stays there, because a fade's
// value persists by design and nothing ever "restores" it. (Recall A: master 1.0 → 0.2 over 5 s. Load a
// project at t = 2 s → cancel() → the house would sit at ≈0.6 for the rest of the show.)
//
// Finalizing to `leg.to` reproduces exactly what would have happened had the fade been allowed to finish:
// the outgoing recall's authored audio state, held in the layer, waiting to be shadowed or replaced.
//
// ⚠ THIS IS FOR *ABANDONING* A FADE (cancel: project open / new / reset — "this show is over"), NOT for
// making room for the next one. start() no longer calls it on the live batches: a batch the incoming one
// does not name simply KEEPS RUNNING now, which is the whole point of the leg list above. Finalizing an
// unrelated leg is an audible hard cut, and it was firing on every cue.
function finalizePluginLegs(legs: readonly ActiveLeg[]): void {
  for (const leg of legs) {
    if (isCore(leg.path)) continue;
    const head = leg.path.split('.')[0];
    automationTargetRegistry.get(head)?.writeFade?.(leg.path, leg.to);
  }
}

// An incoming batch OWNS the paths it names. Strip them out of every live batch — not finalized (the
// incoming leg's `from` was read from the LIVE layer, so leaving the old value in place is what makes the
// hand-off continuous), just removed, so one path never has two writers.
function retarget(paths: ReadonlySet<string>): void {
  if (!paths.size) return;
  for (const b of actives) b.legs = b.legs.filter((l) => !paths.has(l.path));
  actives = actives.filter((b) => b.legs.length > 0);
}

// Every CORE leg is stale the moment a caller replaces the whole committed look — i.e. on a SCENE RECALL,
// which is the one caller of this. See the note on `actives`. It leaves PLUGIN legs (the audio fades)
// running: a scene that binds no audio expresses no opinion about the sound, and finalizing a running duck
// to its endpoint on that basis is an audible hard cut on the house PA.
// A batch stripped bare this way is SUPERSEDED, not completed — its onComplete must not fire.
export function dropCoreLegs(): void {
  if (!actives.length) return;
  const was = actives.length > 0;
  for (const b of actives) b.legs = b.legs.filter((l) => !isCore(l.path));
  actives = actives.filter((b) => b.legs.length > 0);
  if ((actives.length > 0) !== was) notify();
}

// Subscribers notified when a fade starts/ends (e.g. UI progress). Render-free.
const subs = new Set<(active: boolean) => void>();
const notify = (): void => { subs.forEach(cb => cb(actives.length > 0)); };
export function subscribe(cb: (active: boolean) => void): () => void { subs.add(cb); cb(actives.length > 0); return () => { subs.delete(cb); }; }

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
  const was = actives.length > 0;
  // This batch takes the paths it names, AND NOTHING ELSE. Every other leg keeps running on its own clock:
  // a look cue does not end a music duck, and it does not snap a running crossfade to its endpoint either.
  // (A caller that replaced the whole committed look — a scene recall — must say so with dropCoreLegs().)
  retarget(new Set(legs.map((l) => l.path)));
  if (!willAnimate) {
    // Nothing to animate. Core needs nothing (the caller already committed the target state) — but a SNAP
    // on a PLUGIN leg (fadeSec 0 / transition 'none') still has to be WRITTEN: apply() is the only other
    // writer of the fade layer and it never runs on this path, so bailing here without this would make a
    // zero-length audio recall silently INERT — the cue fires, the log says so, the sound never changes.
    // (It is written AFTER the retarget above, so a leg abandoned on the same path cannot overwrite it.)
    finalizePluginLegs(legs);
    opts.onComplete?.();
    if ((actives.length > 0) !== was) notify();
    return;
  }
  actives.push({ legs, startMs: performance.now(), onComplete: opts.onComplete });
  if (!was) notify();
}

// ABANDON EVERY FADE. This is "the show is over" — project open / new / reset — and NOT "a new cue arrived":
// it WRITES the plugin fade layer (finalizePluginLegs), so calling it on an ordinary GO is what used to
// hard-cut a running duck to its endpoint in one frame. A recall that commits a look but names no legs
// wants dropCoreLegs(), not this.
export function cancel(): void {
  if (!actives.length) return;
  for (const b of actives) finalizePluginLegs(b.legs);
  actives = [];
  notify();
}
export function isActive(): boolean { return actives.length > 0; }

// ── THE TAKEOVER, ON THE CORE SIDE ──────────────────────────────────────────────────────────────
// An operator grabbing a control mid-fade takes that param back. The PLUGIN side of that (dropping the
// path from its fade layer) is releaseFade() — but on its own that is UNDONE WITHIN 16 ms and then made
// PERMANENT, because apply() below re-writes EVERY plugin leg, unconditionally, EVERY frame while the fade
// is live. The layer is deleted; the next frame puts it straight back; the leg then lands on `leg.to` and
// SITS THERE FOREVER (a fade's value persists by design). Net effect: the operator's move is erased, the
// house keeps sliding to the scene's value, and the fader reads 1.0 over a silent room — the exact shadow
// releaseFade exists to prevent, reached through the other door.
//
// So a takeover has to ALSO remove the leg from the animation. That is this. It does NOT finalize the leg
// (finalizing would write `leg.to` — the very value being taken over) and it does NOT fire onComplete: an
// abandoned leg is not a completed fade, and inventing a completion here could pulse a caller's callback.
//
// ⚠ CORE LEGS REACH HERE TOO, AND THE COMMENT THAT USED TO SIT ON THIS LINE — "core has no takeover
// problem, its target is committed in React state, so a manual move simply wins" — WAS FALSE, in exactly
// the way that gets an audience the wrong picture for eight seconds. A manual move commits into React
// state, yes; but apply() below lays the interpolation back OVER that committed state EVERY FRAME
// (Stage rebuilds `base` from surfacesRef/fixturesRef and hands it to us), and for a path with no
// automation lane `to` is the leg's frozen endpoint, not the live document. So pulling a surface's
// content.opacity to 0 two seconds into a 10 s crossfade did this: the slider read 0, the document held 0,
// and the projector KEPT SHOWING THE IMAGE for the remaining eight seconds — then snapped to 0 the instant
// the leg landed. The control appeared to have worked. It had not.
//
// Core's manual writers therefore drop their own legs, the same way the audio provider's releaseFade()
// does (App.tsx: dropTakenOverLegs, on every surface / fixture / brightness commit). This function has
// always been head-agnostic; only the comment claimed otherwise.
export function dropLeg(path: string): void {
  if (!actives.length) return;
  let hit = false;
  for (const b of actives) {
    const rest = b.legs.filter((l) => l.path !== path);
    if (rest.length === b.legs.length) continue;   // this batch isn't fading the path
    b.legs = rest;                                 // mutate in place: sample()'s apply() closes over the batch
    hit = true;
  }
  if (!hit) return;                                // not fading this path at all — nothing to do
  actives = actives.filter((b) => b.legs.length > 0);
  if (!actives.length) notify();
}

// Called once per frame by the Stage pump. Returns null when idle. Fires onComplete and clears
// when every leg has finished (on the frame the last leg reaches progress 1).
export function sample(nowMs: number): SampleResult | null {
  if (!actives.length) return null;
  // THE FRAME'S SNAPSHOT. apply() closes over it, so a batch that finishes on this frame still gets to
  // write its endpoint below before it is removed — and a dropLeg() landing between sample() and apply()
  // still takes effect, because a batch's `legs` array is replaced in place.
  const batches = actives.slice();
  const done: ActiveFade[] = [];
  let geomAnimating = false;
  for (const b of batches) {
    let allDone = true;
    for (const leg of b.legs) {
      const raw = leg.durMs <= 0 ? 1 : (nowMs - b.startMs) / leg.durMs;
      if (raw < 1) { allDone = false; if (leg.geom) geomAnimating = true; }
    }
    if (allDone) done.push(b);
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
    // EVERY BATCH RUNS ON ITS OWN CLOCK — `b.startMs`, not one global one. That is what lets a 20 s duck
    // fired at 0:00 and a 0.5 s look cue fired at 0:03 both be exactly as long as they were authored.
    for (const b of batches) for (const leg of b.legs) {
      const raw = leg.durMs <= 0 ? 1 : (nowMs - b.startMs) / leg.durMs;
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
  // A batch is retired the frame its LAST leg reaches progress 1 — independently of every other batch, and
  // AFTER `apply` has closed over it, so its endpoint is still written on this frame.
  if (done.length) {
    actives = actives.filter((b) => !done.includes(b));
    for (const b of done) b.onComplete?.();   // `actives` is already settled: an onComplete may start() again
    notify();
  }
  return result;
}
