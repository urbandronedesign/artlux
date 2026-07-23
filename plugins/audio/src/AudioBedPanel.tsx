// THE MIXER. Answers "how loud / what does it sound like"; the timeline's audio lanes answer "when".
//
// THE ARRANGEMENT/MIXER SPLIT IS FORCED BY THE ENGINE, NOT BY TASTE. Because of ambisonics there are
// exactly TWO insert points — the CLIP and the MASTER (types.ts AudioBus/AudioClip.effects). A spatial
// source is a point in a field, so it cannot be summed into a bus before it is placed; there is no
// per-track insert and there never will be. FX and mix are therefore STRIP material, not lane material.
//   · the LANES (Timeline's AudioLane) own placement, trim, blade, fades, mute/solo/gain per track.
//   · THIS PANEL owns level and character: track faders, the master strip, and a CLIP INSPECTOR that
//     follows whatever the operator last clicked on the timeline.
//
// TWO CONTAINERS, TWO CLOCKS — and the panel shows both, because the operator mixes both:
//   · THE BED (ProjectData.audio, host.audio.getMix()) rides the SHOW clock. It survives a scene recall.
//     Written whole, through host.audio.setMix.
//   · THE BOUND TIMELINE'S OWN AUDIO (Timeline.audio, host.audio.getTimelineAudio()) rides the PLAYHEAD
//     and restarts with its timeline. That document is CORE's, and WHICH one it is changes under you (the
//     global timeline, or the bound scene's) — so it is written ONE CLIP AT A TIME, BY ID, through
//     host.audio.patchTimelineClip, which resolves the id in the bound document and DROPS a miss.
//
// THE CLIP INSPECTOR NOW WRITES BOTH — and that is the whole reason patchTimelineClip exists. While a scene
// is bound the timeline panel draws NO bed lanes at all (App's timelineBedProp is `undefined` there — the
// bed rides the show clock and the ruler is the scene's), so the ONLY audio clip an operator can select
// while authoring a scene is a TIMELINE clip. When every one of those was read-only, this inspector — gain,
// mute, the orbit pad, the insert chain — was inert for 100% of the time the per-scene-audio feature was in
// use. The engine, the driver, the schema and the persistence were all already complete for it; the one
// missing piece was a write path from a plugin into a core document.
//
// THE TRACK STRIPS ARE A DIFFERENT QUESTION AND THEY STAY READ-ONLY. A timeline TRACK already has a live
// editor — its lane's gutter (name/mute/solo/gain). A timeline CLIP had none anywhere. Only the clip moved.
//
// TWO CONTAINERS, TWO WRITE PATHS, AND THEY DIFFER IN MORE THAN THE CALL:
//   · a BED clip is an AUTOMATION TARGET (lanes, and scene/cue fades that PERSIST over the authored value),
//     so every authored write there is also a TAKEOVER and must releaseFade() — see below.
//   · a TIMELINE clip is NOT: the audio automation provider's readMix() is the bed and only the bed
//     (automationTargets.ts), so there is no lane and no fade over it, and calling releaseFade() for one
//     would name a path in the BED's namespace — which, because clip ids ALIAS between the two containers,
//     could release a real fade on a real bed clip that shares the id. Its writes must NOT release.
//
// EVERY AUTHORED WRITE IS A NAMED, PATH-LABELLED FUNCTION (setMasterGain, setTrackGain, setClipGain,
// setClipSpatial*, setClipEffects, setMasterEffects). That is not a style choice: once the scene/cue fade
// layer lands, the driver reads `laneOverride ?? sceneFade ?? authored` and a fade's value PERSISTS — so
// the instant any recall touches a path, the control that writes it is DEAD unless it releases the fade.
// These functions are the one place that release goes.
//
// EVERY FADER DRAFTS LOCALLY AND COMMITS ONCE (invariant 7 — see Fader.tsx). A commit is
// host.audio.setMix → App re-render → recompileAutomation → the audio fan-out; per pointermove that is
// sixty of those a second, on the bound document of a running show.
//
// AND BECAUSE A GESTURE IS SPLIT IN TWO, IT CAN OUTLIVE ITS DOCUMENT — SO EVERY CONTINUOUS CONTROL THAT
// WRITES A TIMELINE CLIP IS KEYED ON `docKey` (gestureDocKey, below). Seconds pass between the pointerdown
// that opens a draft and the pointerup that writes it, and in that window a recall — the FSM, the scheduler,
// an OSC / tablet GO, the scene pill; all of them funnel into App.handleRecallScene and none of them checks
// for an in-flight edit — rebinds the document under this panel. Nothing else here can notice: the incoming
// scene is normally a Capture-Scene structuredClone, so its clip carries the SAME ID in the SAME container,
// selection.ts's `same()` suppresses the re-notify, and every id-keyed guard downstream (this panel's, and
// the host's "is the clip in the bound document") RESOLVES — against the wrong scene. The commit would then
// land the reverb the operator dialled on scene A onto scene B, silently, while scene B is on the
// projectors. The guard is IDENTITY, not value (the clone's values match too), it is the same string core
// mints for its own drags (Timeline.tsx:117), and a dead gesture writes NOTHING — losing an edit the
// operator must redo is the cheap failure. THE BED IS DELIBERATELY UNGUARDED: it is one document, owned by
// App, that survives every recall, so it has nothing to rebind to and its gestures must never be abandoned.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Plus, Music, Trash2, Volume2, VolumeX, Headphones, AlertTriangle, Play, Pause, SkipBack, Square, Orbit, Sliders } from 'lucide-react';
import { type PanelProps } from '@artlux/sdk/renderer';
import { getAudioHost } from './audioHost';
import { audioClient } from './audioClient';
import { EffectChain, type Effect, type FxParamRef } from './EffectChain';
import { Fader } from './Fader';
import { MASTER_BUS_ID } from './effectDefs';
import { releaseFade, drivenSnapshot, type Driven } from './automationTargets';

interface Spatial { x: number; y: number; z: number }
interface Clip { id: string; trackId: string; name: string; path: string; start: number; duration: number; inPoint: number; sourceDuration?: number; gain?: number; mute?: boolean; spatial?: Spatial; effects?: Effect[] }
interface Track { id: string; name: string; gain?: number; mute?: boolean; solo?: boolean }
interface Bus { id: string; name: string; gain?: number; effects?: Effect[] }
interface Mix { tracks: Track[]; clips: Clip[]; buses: Bus[] }
// The BOUND timeline's own audio — the same clip/track shapes, no buses (one output chain, project-global).
interface TlAudio { tracks: Track[]; clips: Clip[] }
// Just enough of core's `Scene` to put a NAME on the bound document (host.show.getScenes() is `unknown[]`
// in the SDK — the host's domain types are opaque to a plugin, so this is restated structurally like Mix
// and TlAudio above). Read for DISPLAY ONLY: the panel never writes a scene and never stores its name.
interface SceneRef { id: string; name: string }
// Which container a selected clip lives in. The union is the host's, restated structurally (the plugin
// cannot import core's types) — and it is DISCRIMINATED for a reason: the two containers commit through
// completely different paths, and a `source ?? 'bed'` guess would silently edit the bed, which survives
// every scene recall, under a live show.
type Sel = { kind: 'clip'; id: string } | { kind: 'audioClip'; id: string; source: 'bed' | 'timeline' } | null;

// Metres shown across the positioner pad (listener at the centre).
const RANGE = 3;

// Top-down positioner: horizontal = x (left/right), vertical = z (up = IN FRONT of the listener).
// Ambisonic encoding places the source from this; height (y) is a separate slider.
//
// INVARIANT 7 APPLIES TO A PAD JUST AS IT DOES TO A FADER: this used to patch the clip on every
// pointermove. It now DRAFTS (the parent paints the dot from the draft) and commits ONCE on pointerup.
//
// ⚠ AND THE PRICE OF GETTING THAT WRONG WENT UP WHEN THE PAD LEARNED TO WRITE A *TIMELINE* CLIP. A bed
// commit is host.audio.setMix; a timeline commit is a CORE DOCUMENT commit — engine.setData (clamp + warm +
// prune + compile) plus a structured-clone postMessage of the WHOLE document to EVERY projector port. Per
// pointermove that is sixty of those a second while an operator idly drags a source around the room.
//
// ⚠⚠ AND SO DID THE PRICE OF THE SECOND THING INVARIANT 7 COSTS YOU: A GESTURE THAT OUTLIVES ITS DOCUMENT.
// Draft-then-commit means seconds pass between the pointerdown and the write, and in that window a recall
// (the FSM, the scheduler, an OSC/tablet GO, the scene pill — all of them funnel into handleRecallScene,
// none of them checks for an in-flight edit) rebinds the document under this pad. The panel does NOT find
// out: core re-publishes the selection, but the incoming scene is usually a Capture-Scene CLONE, so the id
// AND the container name are byte-identical and selection.ts's `same()` suppresses the notify. Every
// downstream id guard then RESOLVES against the incoming scene — and the operator's position lands on scene
// B's clip while they are still looking at the dot they dragged on scene A's. `docKey` is the only thing
// that catches it, and it is IDENTITY, not value: the clone's values match too. (Core mints the same string
// and refuses the same way — Timeline.tsx:117, `endDrag`.)
const SpatialPad: React.FC<{
  x: number; z: number;
  /** Identity of the rebindable document this pad writes, or undefined for the BED (never rebound, never
   *  abandoned — see Fader.docKey). Read LIVE at both ends of the gesture, never from a polled mirror. */
  docKey?: () => string;
  onDraft: (x: number, z: number) => void;
  onCommit: (x: number, z: number) => void;
}> = ({ x, z, docKey, onDraft, onCommit }) => {
  const ref = useRef<HTMLDivElement>(null);
  // The last position the pointer produced. Read on pointerup — never the closure, which is a render behind.
  const pending = useRef<{ x: number; z: number } | null>(null);
  // The document the in-flight drag was started against. `null` when there is no doc to guard (the bed).
  const gestureDoc = useRef<string | null>(null);
  // A gesture whose document rebound under it is DEAD. It stops drafting and it never commits — the same
  // two refusals core makes (Timeline.tsx onDragMove: "don't re-arm the draft"; endDrag: "ABANDON").
  const dead = () => docKey != null && gestureDoc.current !== docKey();
  const set = (clientX: number, clientY: number) => {
    const el = ref.current; if (!el) return;
    if (dead()) return;                      // rebound mid-drag — do not paint the incoming scene's dot either
    const r = el.getBoundingClientRect();
    const px = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const py = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    const nx = Number(((px - 0.5) * 2 * RANGE).toFixed(2));
    const nz = Number(((0.5 - py) * 2 * RANGE).toFixed(2));
    pending.current = { x: nx, z: nz };
    onDraft(nx, nz);
  };
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    gestureDoc.current = docKey ? docKey() : null;
    set(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => set(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const p = pending.current; pending.current = null;
      const alive = !dead(); gestureDoc.current = null;
      if (p && alive) onCommit(p.x, p.z);   // ONE write per drag, and only into the document it was made on
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  return (
    <div ref={ref} onPointerDown={onDown}
      title="Drag to place the source (top-down; up = in front of the listener)"
      className="relative w-24 h-24 rounded border border-line-1 bg-surface-0 shrink-0 cursor-crosshair">
      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-line-1/60" />
      <div className="absolute top-1/2 left-0 right-0 h-px bg-line-1/60" />
      <div className="absolute left-1/2 top-1/2 w-1.5 h-1.5 -ml-[3px] -mt-[3px] rounded-full bg-fg-3" title="listener" />
      <span className="absolute top-0.5 left-1/2 -translate-x-1/2 text-micro leading-none text-fg-3/70">front</span>
      <div className="absolute w-2.5 h-2.5 -ml-[5px] -mt-[5px] rounded-full bg-accent"
        style={{ left: `${((x / RANGE) * 0.5 + 0.5) * 100}%`, top: `${(0.5 - (z / RANGE) * 0.5) * 100}%` }} />
    </div>
  );
};

// A track's name field. Drafts on keystroke, commits on blur / Enter, ABANDONS on Escape — and the ref is
// what makes the abandon real: `.blur()` fires onBlur synchronously inside the keydown stack, where the
// batched setState has not landed and the closure still holds the discarded text. (AudioLane's gutter
// documents the same trap; a per-keystroke commit here would be a full setMix per character.)
const TrackName: React.FC<{ value: string; disabled?: boolean; title?: string; onCommit: (s: string) => void }> = ({ value, disabled, title, onCommit }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const set = (v: string | null) => { draftRef.current = v; setDraft(v); };
  const commit = () => {
    const d = draftRef.current;
    set(null);
    if (d === null) return;
    const t = d.trim();
    if (t && t !== value) onCommit(t);   // an empty name is not an edit — keep the old one
  };
  return (
    <input value={draft ?? value} disabled={disabled} title={title}
      onChange={(e) => set(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { set(null); (e.target as HTMLInputElement).blur(); }
      }}
      className="flex-1 min-w-0 bg-transparent outline-none text-mini text-fg-1 truncate disabled:text-fg-2" />
  );
};

// WHO IS DRIVING THIS CONTROL — and, for a lane, WHY IT IS DEAD. Drawn beside any fader whose value is
// coming from a layer above the document, because until now the ONLY way to discover that was to notice the
// room did not match the number.
//
// The two layers differ in the one way the operator cares about — whether they can take the parameter back:
//   · FADE — yes, and the gesture is the obvious one. onCommit → releaseFade() drops the layer AND the leg.
//   · LANE — no. Only the automation engine may drop a lane (Fader.tsx:89), so a move would land in the
//     document, change nothing audible, and be overwritten on the next frame. The fader is disabled and this
//     badge is the whole explanation the operator gets — so it has to name the remedy, not just the state.
const DriveBadge: React.FC<{ d: Driven }> = ({ d }) => (
  <span
    className={`shrink-0 px-1 rounded text-micro uppercase tracking-wider ${d.by === 'lane' ? 'bg-accent/15 text-accent' : 'bg-surface-3 text-fg-2'}`}
    title={d.by === 'lane'
      ? 'An automation LANE owns this parameter. What you see is what the engine is playing — and it is why this fader is read-only: a move here would be silently overwritten on the next frame. To take it back, switch off the lane in the timeline (the ⚡ button in its gutter).'
      : 'A scene or cue FADE is holding this parameter. What you see is what the engine is playing, and it PERSISTS after the fade lands. The fader still works — move it to take the parameter back.'}>
    {d.by}
  </span>
);

const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `a-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
const emptyMix = (): Mix => ({ tracks: [], clips: [], buses: [] });
// A SHARED FROZEN FALLBACK, never a fresh literal: it lands in React state and feeds a useMemo dep, so a
// new `{}` per read would re-render (and re-derive the inspector) on every host fan-out for a document
// that has no audio at all. (The driver's EMPTY_CLIPS makes the same promise one layer down.)
const EMPTY_TL: TlAudio = Object.freeze({ tracks: Object.freeze([]) as unknown as Track[], clips: Object.freeze([]) as unknown as Clip[] });
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? 'audio';
// The name of the scene `id` names, or `null` for the global timeline (id null) and for an id with no scene
// behind it — A MISS MUST NOT SILENTLY BECOME "Global", it degrades to the generic phrase (see boundTitle).
// The `|| null` also catches a scene whose `name` is empty or absent: App's loader casts `data.scenes` to
// `Scene[]` with no normalizer, so the type's `name: string` is not a runtime guarantee. DISPLAY ONLY.
const sceneNameFor = (h: ReturnType<typeof getAudioHost>, id: string | null): string | null => {
  if (!h || id == null) return null;
  return (h.show.getScenes() as SceneRef[]).find((s) => s.id === id)?.name || null;
};
// The same, resolving the bound document itself. Takes its own getStatus() — for the SEED only; the two
// live callers already hold a status object and pass its id in, so the poll costs one getStatus(), not two.
const sceneNameOf = (h: ReturnType<typeof getAudioHost>): string | null =>
  sceneNameFor(h, h?.show.getStatus().activeSceneId ?? null);
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const g2 = (v: number) => v.toFixed(2);

// ── THE DOCUMENT FIELDS THAT REACH THIS PANEL WITH NO NORMALIZER ──────────────────────────────────────
// sanitizeAudioClip (types.ts) coerces start/duration/inPoint/sourceDuration/gain/mute/fadeIn/fadeOut and
// spreads `...c` for everything else, so a CLIP's `spatial` and `effects` arrive EXACTLY as the project
// file wrote them. normalizeAudioMix's buses are a SHAPE GUARD ONLY — its own comment says so — so a
// BUS's `gain` and `effects` do too. Four fields, no coercion, straight off the document.
//
// THE DRIVER ALREADY KNOWS THIS and guards all four at the engine door (plugin.renderer.ts: finiteVec3,
// fxOf, boundGain). The panel that RENDERS and AUTHORS them did not — and this is the worse place to
// find out, because the failure is not a bad number reaching an amplifier, it is a TYPEERROR THROWN IN
// THE RENDER OF A PLUGIN PANEL WITH NO ERRORBOUNDARY ABOVE IT: the project loads clean (invariant 6
// holds — no white screen on load) and then OPENING THE AUDIO BED, or merely SELECTING a clip, is what
// dies. EffectChain.tsx:118 already learned exactly this lesson for a bus's chain and wrote it down; the
// lesson just never made it to the vector, the gain, or the write path.
//
// ⚠ `?? x` IS NOT THIS GUARD. It substitutes only null/undefined, so a hand-edited or tool-generated
// `"effects": "x"` / `"gain": "1"` / `"spatial": true` sails straight through it — which is the whole
// reason finiteNum and boolOrAbsent exist one layer up.

// The panel's twin of types.ts's finiteNum: junk ⇒ ABSENT, and absent already means "the default" at every
// call site (`?? 1`). NOT boundGain — that is the ENGINE's door and it CLAMPS; restating a clamp here would
// print 1.50 over an authored 20 and tell the operator their document says something it does not. The
// document keeps whatever it says (boundGain's own note); the panel's only job is to refuse to crash on a
// value that is not a number at all. A finite gain — in range or not — displays exactly as it does today.
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// THE SAME PREDICATE AS THE DRIVER'S finiteVec3 — deliberately identical, not merely similar. A position is
// a position only if ALL THREE axes are finite numbers; anything else is NO position, i.e. the clip is simply
// non-spatial, which is what `spatial: undefined` means at every other call site.
//
// ⚠ IT MUST NOT BE THE ZERO-FILLING KIND OF COERCION (`{x: num(s.x) ?? 0, …}`) — that is the obvious fix and
// it is the wrong one. `{"x":0,"z":1}` (no y) would then render a TICKED "Spatial" box with a dot on the pad,
// while the DRIVER — which applies the strict test one layer down, and which is the authority on what is
// actually audible — plays that clip FLAT. A panel that claims a spatialisation the engine is not performing
// is the self-reporting-healthy failure this codebase kills on sight, and it is strictly worse than an honest
// "Off". Sharing the predicate means the checkbox can never disagree with the sound. The repair is then the
// obvious gesture and it is one click: tick the box, and setClipSpatialOn writes a clean {0,0,1} over the junk.
//
// Returns the value ITSELF when it is valid (never a rebuilt copy), so a sane document round-trips
// byte-for-byte through the panel's writes — invariant 6, the same way finiteVec3 hands `s` back.
const vec3 = (s: unknown): Spatial | undefined => {
  const v = s as Partial<Spatial> | null | undefined;
  return v && typeof v === 'object' && !Array.isArray(v)
    && typeof v.x === 'number' && Number.isFinite(v.x)
    && typeof v.y === 'number' && Number.isFinite(v.y)
    && typeof v.z === 'number' && Number.isFinite(v.z)
    ? (v as Spatial)
    : undefined;
};

// A non-array chain reads as an EMPTY chain — the same fallback EffectChain makes for its own render and the
// driver's fxOf makes for the engine. Needed on every RAW read of `effects`, and most of all on the ones that
// feed releaseChangedFx: `prev.find(...)` on a string is "prev.find is not a function", thrown from a click
// handler BEFORE the patch that would have repaired the document — so the junk chain is not merely broken,
// it is UNREPAIRABLE, defeating the self-repair EffectChain.tsx:118 promises in its own comment.
const fxOf = (fx: unknown): Effect[] => (Array.isArray(fx) ? (fx as Effect[]) : []);

export const AudioBedPanel: React.FC<PanelProps> = () => {
  const host = getAudioHost();
  // ── WHICH DOCUMENT IS BOUND, RIGHT NOW ───────────────────────────────────────────────────────────────
  // THE SAME STRING CORE MINTS (Timeline.tsx:117 — `author?.activeSceneId ?? '__global__'`), because it is
  // the same guard against the same hazard, and it must agree with core's exactly: it names WHERE A COMMIT
  // WILL LAND. host.audio.patchTimelineClip routes off activeSceneIdRef and nothing else (App.tsx), and
  // getStatus().activeSceneId reads that very ref — so this is not an approximation of the write target,
  // it IS the write target.
  //
  // A FUNCTION, READ LIVE, NEVER A POLLED MIRROR. Every guarded gesture below calls it twice — once when
  // the gesture opens, once when it commits — and the whole point is to catch a change that happened
  // BETWEEN those two moments. A value captured in a render would be exactly as stale as the closure it
  // is meant to police. (The `boundDoc` state below is a separate, cosmetic thing: it clears a stale
  // DRAFT. It may lag; the guard may not.)
  const docKeyOf = () => host?.show.getStatus().activeSceneId ?? '__global__';
  const [mix, setMixState] = useState<Mix>(() => (host?.audio.getMix() as Mix) ?? emptyMix());
  const [tlAudio, setTlAudio] = useState<TlAudio>(() => (host?.audio.getTimelineAudio() as TlAudio) ?? EMPTY_TL);
  const [sel, setSel] = useState<Sel>(() => host?.show.getSelection() ?? null);
  const [meter, setMeter] = useState({ peak: 0, rms: 0, peakL: 0, peakR: 0 });
  const [clipping, setClipping] = useState(false);
  const clipUntil = useRef(0); // hold the warning ~1.5 s — a transient overshoot would otherwise flash past
  // THE BED RIDES THE SHOW CLOCK — so this mirrors showTime/showEnd, never playhead/duration. `sceneBound`
  // gates the seek controls (see the scrub slider). `showEnded` is NOT decoration: when the show clock parks
  // (global Loop off, Length ran out) the driver correctly kills the bed, but `playing` STAYS TRUE if a scene
  // is looping underneath — so without this the panel shows a lit Play button over a frozen readout and dead
  // meters, and the only diagnosis available to a venue tech is "the audio engine crashed". See the badge.
  const [transport, setTransport] = useState({ playing: false, showTime: 0, showEnd: 0, sceneBound: false, showEnded: false });
  // ── WHAT THE ENGINE IS ACTUALLY PLAYING, PER PATH ────────────────────────────────────────────────────
  // Every fader below used to render the DOCUMENT's value. The driver plays `lane ?? fade ?? authored`
  // (plugin.renderer.ts), so a house fade slid the master from 1.0 to 0.32 and THE FADER NEVER MOVED —
  // a panel asserting a level the engine was not playing, which is the exact self-reporting-healthy
  // failure this file kills on sight two hundred lines up (see the `vec3` note). Fader.tsx:87 had already
  // written the bug down ("the fader can sit at 1.00 over a 0.2 room") and fixed only the WRITE half.
  //
  // Polled on the meter tick below (10 Hz — the same rate the meters move, and plenty for a fade), never
  // subscribed: `ovr` is rewritten by the automation engine EVERY FRAME, so a subscription would re-render
  // this panel 60×/s for the entire length of every fade in the show.
  //
  // Empty ⇒ drivenSnapshot() hands back a SHARED frozen map, so this setState bails out and a project with
  // no automation at all pays nothing.
  const [drive, setDrive] = useState<ReadonlyMap<string, Driven>>(drivenSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [openMaster, setOpenMaster] = useState(false);
  // The spatial pad's in-flight drag (invariant 7). LOCAL state — a draft is not a document.
  const [padDraft, setPadDraft] = useState<{ x: number; z: number } | null>(null);
  // A RENDERABLE mirror of docKeyOf(), for the ONE thing that needs a re-render when the binding changes:
  // dropping a stale pad draft (see the reset effect). It is NOT the guard — the guard is docKeyOf(), read
  // live — so this may lag by up to one meter tick without costing correctness. Refreshed from the audio
  // fan-out (which fires on `[audioMix, activeTimeline]`, i.e. in the recall render itself) with the meter
  // poll as the backstop for the one recall the fan-out cannot see: binding a scene that has no timeline of
  // its own leaves `activeTimeline` pointing at the same global document, so nothing in `audio` changes —
  // but the WRITE TARGET does (that scene now materializes its own timeline on the first edit), which is
  // precisely a gesture the guard must abandon.
  const [boundDoc, setBoundDoc] = useState<string>(docKeyOf);
  // THE BOUND SCENE'S NAME, RESOLVED AT DISPLAY TIME — `null` while the GLOBAL timeline is bound.
  //
  // This panel is the first surface in the app that renders TWO containers' track lists in one scroll, and
  // the mint counter is per-container (both the bed and every scene start at `Audio 1`), so "Tracks — this
  // timeline" over a column of `Audio 1, Audio 2` told the operator nothing about WHOSE they were.
  //
  // ⚠ RESOLVED, NEVER STORED. The alternative — baking the name into `AudioTrack.name` at the mint — rots
  // twice over: core's handleRenameScene patches `scene.name` and never walks the scene's audio tracks, and
  // handleCaptureScene structuredClones the timeline into a NEW scene (so the copy would carry the
  // ORIGINAL's name). A name read fresh from getScenes() every poll is stale for at most one tick.
  //
  // No new host API: `getStatus().activeSceneId` names the bound document (the very ref patchTimelineClip
  // routes off) and `getScenes()` carries the names. Refreshed on the 100 ms transport poll below, which
  // already reads getStatus() — a rename is a label, not a guard, so a tick of lag costs nothing, and a
  // setState with an unchanged string is a React bail-out.
  //
  // SEEDED FROM THE HOST, not from `null`: a panel OPENED while a scene is already bound would otherwise
  // spend its first tick captioned "Tracks — Global" over that scene's tracks — the one caption this label
  // must never show. (`transport` seeds sceneBound:false for the same tick, so the generic fallback would
  // not catch it either; the seed is what makes the very first paint honest.)
  const [boundName, setBoundName] = useState<string | null>(() => sceneNameOf(host));
  const peakHold = useRef(0);
  const holdL = useRef(0);
  const holdR = useRef(0);
  // Synchronously-fresh mirror of the bed. `host.audio.getMix()` reads App's audioMixRef, which only
  // refreshes on a React render — so two edits resolving in the same turn would both read the pre-edit
  // bed and the second would clobber the first. EVERY write path below patches from this ref, never from
  // the React `mix` (which is a render behind): patch a track's gain and then its mute in one turn and the
  // gain would snap back. Do not "simplify" it away.
  const mixRef = useRef<Mix>(mix);
  // The SAME discipline for the bound timeline's own audio, and it earns its keep for a second reason: a
  // patch here is FIRE-AND-FORGET into core (patchTimelineClip takes an id and a patch, and hands nothing
  // back), so the panel paints the result optimistically from this ref and lets the host's fan-out confirm
  // it a render later. Without the ref, an axis write would carry a stale copy of its siblings.
  const tlRef = useRef<TlAudio>(tlAudio);
  // Floating (non-blocking) window — draggable by its header so it can be moved clear of the Media library.

  // Defaults TRUE so no badge flashes while the probe is in flight. Only an explicit false lights it, and
  // a rejection lights nothing — see the badge below.
  const [engineUp, setEngineUp] = useState(true);
  useEffect(() => { audioClient.available().then(setEngineUp).catch(() => {}); }, []);
  // ⚠ AND THE OTHER WAY THE ROOM GOES SILENT, WHICH `engineUp` CANNOT SEE. The addon stays perfectly loaded
  // when the audio interface is UNPLUGGED — so `available()` keeps saying yes while there is no device and
  // no sound. Two failures, two questions, two badges. Defaults TRUE for the same reason as above.
  const [deviceLive, setDeviceLive] = useState(true);

  // Sync BOTH containers from the host (external edits / project load / a scene recall → a different bound
  // timeline). The fan-out fires on either one changing.
  useEffect(() => {
    if (!host) return;
    return host.audio.subscribe(() => {
      const m = (host.audio.getMix() as Mix) ?? emptyMix();
      mixRef.current = m;
      setMixState(m);
      const t = (host.audio.getTimelineAudio() as TlAudio) ?? EMPTY_TL;
      tlRef.current = t;   // THE HOST IS THE TRUTH — it overwrites any optimistic patch below, including a dropped one
      setTlAudio(t);
      // The fan-out fires on `[audioMix, activeTimeline]` — so a recall that rebinds the bound document
      // wakes it in the recall render. A primitive setState with an unchanged value is a React bail-out, so
      // this costs nothing on the (far commoner) bed-only fire.
      //
      // ⚠ THE NAME REBINDS HERE TOO, NOT ONLY IN THE 100 ms POLL. This callback is where `tlAudio` swaps to
      // the incoming scene's tracks — in the recall render. Leaving the name to the poll meant the heading,
      // the empty note and the inspector's note kept saying the scene the operator just LEFT, over the
      // tracks of the one they just entered, for up to a tick. Self-healing, but naming the wrong scene over
      // a live FX write is the exact ambiguity this label exists to kill. One getStatus() feeds both.
      const sid = host.show.getStatus().activeSceneId ?? null;
      setBoundDoc(sid ?? '__global__');
      setBoundName(sceneNameFor(host, sid));
    });
  }, [host]);

  // THE INSPECTOR FOLLOWS THE TIMELINE SELECTION. This is the whole point of the arrangement/mixer split:
  // you place the clip on the lane, you shape it here. The selection arrives through host.show — a
  // render-free channel core publishes and this panel subscribes to (services/selection.ts). It fires once
  // immediately, so a panel opened mid-show sees what is already selected. Core publishes only a RESOLVABLE
  // selection, so an id that arrives here names a clip that exists in the container it names — but the
  // lookup below still tolerates a miss, because the bound document can change between the notify and the
  // read (a recall, a delete).
  useEffect(() => {
    if (!host) return;
    return host.show.subscribeSelection(() => setSel(host.show.getSelection()));
  }, [host]);

  // Master meter (~10 Hz) with peak-hold decay.
  useEffect(() => {
    if (!host) return;
    const iv = setInterval(() => {
      audioClient.getMeters().then((m) => {
        peakHold.current = Math.max(peakHold.current * 0.9, m.peak);
        holdL.current = Math.max(holdL.current * 0.9, m.peakL ?? 0);
        holdR.current = Math.max(holdR.current * 0.9, m.peakR ?? 0);
        setMeter({ peak: peakHold.current, rms: m.rms, peakL: holdL.current, peakR: holdR.current });
        if (m.clipped) clipUntil.current = Date.now() + 1500; // engine-latched: catches every block, not 1 in 10
        setClipping(Date.now() < clipUntil.current);
        // ⚠ `!== false`, NOT a bare assignment. An OLD main process (or any degraded read) hands back a
        // meters object with no `deviceLive` at all — `undefined` is falsy, and a bare setDeviceLive(m.deviceLive)
        // would light a "no output device" alarm over a perfectly healthy rig. Only an EXPLICIT false lights it.
        setDeviceLive(m.deviceLive !== false);
      }).catch(() => {});   // a rejected poll lights NOTHING — see the badge
      // THE BED RIDES THE SHOW CLOCK — st.showTime, and NEVER the BOUND DOCUMENT'S PLAYHEAD (the other
      // number on this status object). Mirroring that one here was a LIE about the bed the moment a scene
      // was bound: the readout and the scrub slider would show the SCENE's time while the bed played on at
      // a completely different position. `duration` was the same lie one level down — it is the BOUND doc's
      // Length, so a 20 s scene pinned the bed's scrub slider at its maximum. Neither belongs in this file:
      // nothing here may read either of them, which is a grep-enforced gate, not a preference.
      const st = host.show.getStatus();
      setTransport({ playing: st.playing, showTime: st.showTime, showEnd: st.showEnd,
        sceneBound: st.activeSceneId != null, showEnded: st.showEnded });
      setBoundDoc(st.activeSceneId ?? '__global__');   // backstop for the fan-out (see boundDoc) — bails out unchanged
      // The bound document's NAME, for the labels only (see boundName). A RECALL already rebinds it in the
      // fan-out above (in the recall render); this poll is what carries a RENAME — handleRenameScene touches
      // the scene and nothing else, so no audio fan-out fires for it — which is exactly why the label is
      // drawn and not baked into the document at the mint. Off `st`, so the tick reads getStatus() ONCE.
      setBoundName(sceneNameFor(host, st.activeSceneId ?? null));
      // What the engine is applying to each automatable path, so the faders can DRAW it (see `drive`).
      setDrive(drivenSnapshot());
    }, 100);
    return () => clearInterval(iv);
  }, [host]);

  const selId = sel && sel.kind === 'audioClip' ? sel.id : null;
  const selSource: 'bed' | 'timeline' | null = sel?.kind === 'audioClip' ? sel.source : null;
  // A new selection — OR A REBOUND DOCUMENT — abandons any half-finished pad drag, or the draft would paint
  // the NEW clip's dot at the OLD clip's position.
  //
  // ALL THREE DEPS ARE LOAD-BEARING, AND THEY ARE THE THREE WAYS THE THING UNDER THE DOT CAN CHANGE WITHOUT
  // THE ID CHANGING:
  //   · `selId`   — the obvious one: a different clip was clicked.
  //   · `selSource` — the SAME id in the OTHER container. The two clip pools are independent id spaces (the
  //     Sel union is discriminated for exactly this reason), so `selId` alone cannot see a bed↔timeline flip.
  //   · `boundDoc` — the SAME id, the SAME container, a DIFFERENT DOCUMENT. Capture Scene structuredClones
  //     the timeline, so a recall to a cloned scene changes neither of the other two — this is the only dep
  //     that fires, and without it the outgoing scene's dragged position would sit painted over the incoming
  //     scene's clip. (The commit is already refused by the pad's own docKey guard; this is the PAINT.)
  useEffect(() => { setPadDraft(null); }, [selId, selSource, boundDoc]);

  // Every mutation builds a fresh bed and writes it back (host normalizes + persists + notifies the player).
  const commit = (next: Mix) => { mixRef.current = next; setMixState(next); host?.audio.setMix(next); };

  // ── WHICH CONTAINER IS THE INSPECTOR LOOKING AT (selSource, above) ───────────────────────────────────
  // THE ONE ROUTER for every clip write below. It is read off the SELECTION, never guessed: `sel.source` is
  // a discriminated field precisely because the same clip id can exist in both containers (Capture Scene
  // deep-clones the bound timeline into a scene, ids verbatim), and the two commit through completely
  // different paths at completely different costs. `null` = nothing (or a video clip) is selected.
  //
  // ── AND WHICH GESTURES ARE GUARDED BY THE DOCUMENT'S IDENTITY ────────────────────────────────────────
  // Handed to every CONTINUOUS control (the pad, the clip gain, the height, every FX param) — but ONLY for
  // a `timeline` selection, and the asymmetry is the whole point:
  //   · a TIMELINE clip lives in a document core REBINDS UNDER US (a recall). A gesture that started on
  //     scene A and commits after the recall must be ABANDONED, because every id-keyed guard between here
  //     and the document RESOLVES against scene B — Capture Scene aliases the ids — so the write would land,
  //     silently, in the scene that is on the projectors now. Losing the edit is the correct outcome: the
  //     operator is no longer looking at that clip.
  //   · a BED clip lives in ProjectData.audio: ONE document, owned by App, which SURVIVES every recall.
  //     There is nothing to rebind and nothing to alias, so a bed gesture must NOT be abandoned — guarding
  //     it would throw away an edit that had nowhere else to go.
  // `undefined` for the bed is therefore not an omission; it is the statement that the bed cannot rebind.
  const gestureDocKey = selSource === 'timeline' ? docKeyOf : undefined;
  // Patch ONE clip in the bound timeline's own audio. Optimistic locally (the host hands nothing back), and
  // guarded by the SAME rule the host applies: an id that is not in the container we are looking at is
  // DROPPED, not searched for. The host's fan-out is the truth and overwrites this a render later.
  //
  // ⚠ THIS GUARD CANNOT SEE A REBIND, AND IT IS NOT SUPPOSED TO. It catches a DELETED clip. It cannot catch
  // a recall, because the incoming scene is a structuredClone of the outgoing one and its clip carries the
  // SAME ID — `some(c => c.id === id)` finds it and waves the write through, into the wrong scene. Only
  // gestureDocKey above catches that, and it catches it BEFORE this is ever called. Do not "harden" this
  // into a rebind check by comparing values; the clone's values match too.
  const patchTlClip = (id: string, p: Partial<Clip>) => {
    const cur = tlRef.current;
    if (!cur.clips.some((c) => c.id === id)) return;   // the clip was deleted under the gesture — abandon the edit
    const next: TlAudio = { ...cur, clips: cur.clips.map((c) => (c.id === id ? { ...c, ...p } : c)) };
    tlRef.current = next;
    setTlAudio(next);
    host?.audio.patchTimelineClip(id, p);
  };
  // The selected clip's writer, and its container's read side. `mixRef`/`tlRef`, never the React render —
  // both are a render behind (see mixRef).
  const patchSelClip = (id: string, p: Partial<Clip>) => {
    if (selSource === 'timeline') patchTlClip(id, p); else patchClip(id, p);
  };
  const selClipIn = (id: string): Clip | undefined =>
    (selSource === 'timeline' ? tlRef.current.clips : mixRef.current.clips).find((c) => c.id === id);
  // ⚠ RELEASE ONLY THE BED'S PATHS. A takeover is a bed concept: the audio automation provider enumerates
  // the BED's tracks/clips/master and nothing else (automationTargets.ts readMix), so a Timeline.audio clip
  // has no lane and no scene/cue fade over it — there is nothing to take back. And `audio.clip.<id>.*` is
  // the BED's namespace: because clip ids ALIAS across containers, releasing one for a timeline clip could
  // drop a LIVE fade on a real bed clip that happens to share the id. Silence here is not laziness.
  const releaseSel = (path: string) => { if (selSource === 'bed') releaseFade(path); };
  // ⚠ THE READ-SIDE TWIN OF releaseSel, AND IT NEEDS THE SAME GATE FOR EXACTLY THE SAME REASON.
  // `drive` is keyed by BED paths — the audio automation provider enumerates the BED and only the bed
  // (automationTargets readMix), so a Timeline.audio clip or track has no lane and no fade over it, ever.
  // But clip and track ids ALIAS across the two containers (Capture Scene structuredClones the bound
  // timeline into a scene, ids verbatim), so looking a TIMELINE row's id up in this map RESOLVES — against
  // the wrong container. The fader would draw a BED lane's value, the badge would name a lane that does not
  // exist for it, and it would go READ-ONLY for that phantom lane. `bed` ⇒ read it; anything else ⇒ nobody
  // is driving this control, which is the truth.
  const drivenOn = (source: 'bed' | 'timeline' | null, path: string): Driven | undefined =>
    (source === 'bed' ? drive.get(path) : undefined);

  // ---- THE AUTHORED WRITES. Every one names its PATH. -------------------------------------------------
  // Once the scene/cue fade layer exists the driver reads `laneOverride ?? sceneFade ?? authored`, and a
  // fade's value PERSISTS by design — so the moment any scene or cue touches a path, the authored value
  // under it is shadowed FOREVER and the control that writes it is DEAD. A manual move is a TAKEOVER, and
  // these functions are the one place that release goes (one line each, no hunt). The master fader is the
  // headline case: `audio.master.gain` is precisely what a scene recall exists to fade.
  const patchTrack = (id: string, p: Partial<Track>) => {
    const cur = mixRef.current;
    commit({ ...cur, tracks: cur.tracks.map((t) => (t.id === id ? { ...t, ...p } : t)) });
  };
  const patchClip = (id: string, p: Partial<Clip>) => {
    const cur = mixRef.current;
    commit({ ...cur, clips: cur.clips.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  };
  // The master bus is materialised on FIRST EDIT, not by default — a project that never touches master
  // keeps `buses: []`, so an untouched bed persists exactly as it did before P3. The master bus is
  // PROJECT-GLOBAL and cannot be per-scene: there is exactly one output chain.
  const DEFAULT_MASTER: Bus = { id: MASTER_BUS_ID, name: 'Master', gain: 1, effects: [] };
  const master: Bus = mix.buses.find((b) => b.id === MASTER_BUS_ID) ?? DEFAULT_MASTER; // for RENDER only
  const patchMaster = (p: Partial<Bus>) => {
    const cur = mixRef.current;   // synchronously fresh — `master` above is a render behind (see mixRef)
    const has = cur.buses.some((b) => b.id === MASTER_BUS_ID);
    const next: Bus = { ...(cur.buses.find((b) => b.id === MASTER_BUS_ID) ?? DEFAULT_MASTER), ...p };
    commit({ ...cur, buses: has ? cur.buses.map((b) => (b.id === MASTER_BUS_ID ? next : b)) : [...cur.buses, next] });
  };

  // A MANUAL MOVE TAKES THE PARAM BACK from whatever scene or cue last faded it. WITHOUT THIS the fader
  // moves on screen, the value changes in the document, and NOTHING HAPPENS TO THE SOUND — the fade layer is
  // still winning the read (laneOvr ?? fade ?? authored), and it keeps winning for the rest of the session
  // and across every project opened in it. The house-volume fader would be dead the moment ANY scene or cue
  // touched audio.master.gain — which is precisely what an audio scene recall exists to do.
  //
  // Only the FADE layer is released, never the lane's: a lane is owned by the automation engine and only it
  // may drop one (moving a fader under a live lane is still shadowed, exactly as it is today, and the
  // authored value is what re-appears when the lane is disabled).
  //
  // An FX chain is written whole (EffectChain hands back the whole array), so the release is DIFFED against
  // the authored chain: only params whose value actually changed are taken back. Adding a delay must not
  // silently release a live filter-cutoff fade the operator never touched.
  //
  // ⚠ THE DIFF CANNOT SEE A GESTURE THAT LANDED BACK ON THE AUTHORED VALUE — and that gesture is a takeover
  // like any other (Fader.tsx: "put it back where it says it is" is the operator's one natural recovery
  // move, and it must WORK). Grab a shadowed cutoff, wiggle it, release it on the value the box already
  // shows: the chain handed back is byte-identical, the diff is empty, and without `touched` the fade would
  // keep sounding a value the panel says is not there. EffectChain names the param the gesture rode; that
  // one is released unconditionally, everything else still has to prove it moved.
  const releaseChangedFx = (prefix: string, next: Effect[], prev: Effect[], touched?: FxParamRef) => {
    if (touched) releaseFade(`${prefix}.fx.${touched.fxId}.${touched.key}`);
    for (const fx of next) {
      const before = prev.find((p) => p.id === fx.id);
      for (const [k, v] of Object.entries(fx.params ?? {})) {
        if (before?.params?.[k] !== v) releaseFade(`${prefix}.fx.${fx.id}.${k}`);
      }
    }
  };

  const setMasterGain = (g: number) => { releaseFade('audio.master.gain'); patchMaster({ gain: g }); };        // audio.master.gain
  const setMasterEffects = (fx: Effect[], touched?: FxParamRef) => {                                           // audio.master.fx.<fxId>.<key>
    // fxOf, not `?? []` — a BUS has no clip-grade normalizer at all (normalizeAudioMix's buses are a shape
    // guard), so `effects` here can be a string, and `prev.find` on one throws from inside this click.
    releaseChangedFx('audio.master', fx, fxOf(mixRef.current.buses.find((b) => b.id === MASTER_BUS_ID)?.effects), touched);
    patchMaster({ effects: fx });
  };
  const setTrackGain = (id: string, g: number) => { releaseFade(`audio.track.${id}.gain`); patchTrack(id, { gain: g }); }; // audio.track.<id>.gain
  const setTrackMute = (id: string, m: boolean) => patchTrack(id, { mute: m });              // (not fadeable — discrete)
  const setTrackSolo = (id: string, s: boolean) => patchTrack(id, { solo: s });              // (not fadeable — discrete)
  const setTrackName = (id: string, n: string) => patchTrack(id, { name: n });
  // ── THE SELECTED CLIP'S WRITES — the same six controls against EITHER container (see selSource). ──────
  const setClipGain = (id: string, g: number) => { releaseSel(`audio.clip.${id}.gain`); patchSelClip(id, { gain: g }); }; // audio.clip.<id>.gain
  // ⚠ THIS BUTTON IS THE ONLY WRITER OF AudioClip.mute IN THE WHOLE APPLICATION, and it must stay that way
  // or the field becomes UNAUTHORABLE — the exact hazard the plan raised for `@ N s`, landing on a different
  // field. The lane RENDERS a muted clip (AudioLane 40% opacity) but has no toggle: its gutter's mute/solo/
  // gain are the TRACK's (onPatchTrack), not the clip's. The driver HONOURS it (`if (clip.mute || tr?.mute)
  // → inaudible`) and the sanitizer PRESERVES it (boolOrAbsent). So with no writer, a project saved with a
  // muted clip loads silent FOREVER: drawn on its lane, refused by the driver, and unfixable except by
  // deleting the clip (losing its trim, fades, gain, spatial and FX) or hand-editing the project JSON.
  // (True in BOTH containers now — a muted clip in a scene's own audio was, until this write path, the
  // strictly worse case: not authorable anywhere at all.)
  // Discrete, not fadeable — a mute is a boolean, and the fade grammar admits only continuous paths.
  const setClipMute = (id: string, m: boolean) => patchSelClip(id, { mute: m });             // (not fadeable — discrete)
  const setClipEffects = (id: string, fx: Effect[], touched?: FxParamRef) => {               // audio.clip.<id>.fx.<fxId>.<key>
    // The diff+release is BED-ONLY (see releaseSel): a timeline clip has no fade layer over it, and its ids
    // alias into the bed's `audio.clip.<id>.*` namespace.
    // fxOf, not `?? []` — `effects` is one of the two clip fields sanitizeAudioClip does not coerce, and
    // releaseChangedFx calls `prev.find(...)` on this. A junk chain threw HERE, before the patch below that
    // would have written a real array back — so the chain EffectChain politely rendered as empty could never
    // actually be repaired: every add threw on the way to the fix.
    if (selSource === 'bed') releaseChangedFx(`audio.clip.${id}`, fx, fxOf(mixRef.current.clips.find((c) => c.id === id)?.effects), touched);
    patchSelClip(id, { effects: fx });
  };
  // A spatial AXIS is fadeable (audio.clip.<id>.spatial.<x|y|z>); the spatial FLAG is not — turning it on
  // or off changes the engine chain's channel count (2⇔1) and forces a rebuild, which is why the fade
  // grammar admits the axes and never the flag.
  //
  // The SIBLING AXES ARE READ FROM THE LIVE REF (mixRef / tlRef — selClipIn), not from the render — an axis
  // write must not carry a stale copy of the other two back into the document. A pad drag commits at
  // POINTERUP, so its closure is as old as the pointerdown; if the clip's spatial was turned off (or the
  // clip removed, or its document rebound) in between, the lookup misses and the write is DROPPED rather
  // than resurrecting a container the operator just deleted.
  // COERCED AT THE READ (vec3), not handed over raw: `{ ...cur, x, z }` below would otherwise SPREAD a
  // partial/junk vector straight back into the document, where the driver's finiteVec3 then makes the clip
  // permanently non-spatial while the panel's own checkbox went on insisting it was spatial. Sharing the
  // predicate with the driver means a junk vector reads as "not spatial" here too — so the pad is not even
  // rendered, these writers cannot be reached for it, and the one gesture that IS offered (tick the box)
  // writes a clean {0,0,1}. Whatever they do write is a fully-formed vec3, by construction.
  const spatialOf = (id: string): Spatial | undefined => vec3(selClipIn(id)?.spatial);
  const setClipSpatialXZ = (id: string, x: number, z: number) => {
    const cur = spatialOf(id); if (!cur) return;
    releaseSel(`audio.clip.${id}.spatial.x`); releaseSel(`audio.clip.${id}.spatial.z`);
    patchSelClip(id, { spatial: { ...cur, x, z } });
  };
  const setClipSpatialY = (id: string, y: number) => {
    const cur = spatialOf(id); if (!cur) return;
    releaseSel(`audio.clip.${id}.spatial.y`);
    patchSelClip(id, { spatial: { ...cur, y } });
  };
  // Flipping spatialisation REBUILDS the clip's container, so every axis fade over it is stale by
  // definition — a fade holding x = 2.4 from a scene recall must not silently re-shadow the fresh
  // {0,0,1} the operator just created. (The FLAG itself is not fadeable — it changes the chain's channel
  // count 2⇔1 — so there is no fade on it to release.)
  const setClipSpatialOn = (id: string, on: boolean) => {
    for (const ax of ['x', 'y', 'z'] as const) releaseSel(`audio.clip.${id}.spatial.${ax}`);
    patchSelClip(id, { spatial: on ? { x: 0, y: 0, z: 1 } : undefined });
  };

  // ⚠ `Audio N`, NOT `Track N` — AND IT MUST STAY THE SAME WORD CORE MINTS (Timeline.addAudioTrack). There
  // are two doors onto the SAME bed (this button, and the gutter's + on the bed lanes), and they used to
  // mint different words, so a bed built through both read `Track 1, Audio 2, Track 3`. `Audio` is the one
  // that survives: a Timeline document already calls its VIDEO layers `Track N` (Timeline.addLayer).
  const addTrack = () => {
    const cur = mixRef.current;
    commit({ ...cur, tracks: [...cur.tracks, { id: uid(), name: `Audio ${cur.tracks.length + 1}`, gain: 1, mute: false }] });
  };
  const removeTrack = (id: string) => {
    const cur = mixRef.current;
    commit({ ...cur, tracks: cur.tracks.filter((t) => t.id !== id), clips: cur.clips.filter((c) => c.trackId !== id) });
  };

  const addClip = async (trackId: string, asset: { type?: string; path?: string }) => {
    if (asset?.type !== 'audio' || !asset.path) return;
    // Dropped at the SHOW clock, because that is the container it lands in. (The bound document's playhead
    // would place it at the SCENE's time — under a bound scene, an arbitrary number with no relation to
    // where the bed is actually playing.)
    const start = Math.max(0, host?.show.getStatus().showTime ?? 0);
    const clipId = uid();
    let meta = null as { durationSec: number } | null;
    try {
      meta = await audioClient.loadClip(clipId, asset.path); // decode → real duration (also preloads it)
    } catch {
      meta = null; // loadClip REJECTS on an undecodable/missing source — never let it escape as a silent no-op
    }
    if (!meta || !(meta.durationSec > 0)) {
      setError(`Couldn't load "${baseName(asset.path)}" — the audio engine is unavailable, or the file is missing/undecodable.`);
      return;
    }
    const cur = mixRef.current; // synchronously-fresh bed (see mixRef)
    // The track may have been deleted while the file was decoding — don't orphan an invisible-but-audible clip.
    if (!cur.tracks.some((t) => t.id === trackId)) { audioClient.unloadClip(clipId); return; }
    setError(null);
    commit({ ...cur, clips: [...cur.clips, { id: clipId, trackId, name: baseName(asset.path), path: asset.path,
      start, duration: meta.durationSec, inPoint: 0,
      // THE TRIM CAP. Absent, `(c.sourceDuration ?? Infinity) - c.inPoint` is INFINITY — the lane's
      // right-trim handle would have no cap at all and would happily drag a 30 s clip out to 5 minutes of
      // source that does not exist (the driver's window test would then hold the show on silence).
      sourceDuration: meta.durationSec,
      gain: 1, mute: false }] });
  };

  const onDrop = (trackId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/artlux-asset');
    if (!raw) return;
    try { void addClip(trackId, JSON.parse(raw)); } catch { /* not an asset payload */ }
  };
  const allowDrop = (e: React.DragEvent) => { if (e.dataTransfer.types.includes('application/artlux-asset')) e.preventDefault(); };

  // THE SELECTED CLIP, RESOLVED IN THE CONTAINER THE SELECTION NAMES. `source` is load-bearing: the same id
  // can legitimately exist in both (handleAddScene captures the global doc's timeline with structuredClone,
  // so a scene's Timeline.audio inherits its clip ids verbatim). Guessing would edit the wrong document.
  const selClip: Clip | null = useMemo(() => {
    if (!sel || sel.kind !== 'audioClip') return null;
    const pool = sel.source === 'bed' ? mix.clips : tlAudio.clips;
    return pool.find((c) => c.id === sel.id) ?? null;
  }, [sel, mix, tlAudio]);
  // ⚠ THERE IS NO `selReadOnly` ANY MORE, AND THERE MUST NOT BE ONE AGAIN. It used to disable every control
  // below for `source === 'timeline'` because the panel had no write path into Timeline.audio. It has one
  // now (patchTlClip → host.audio.patchTimelineClip), and while a scene is bound a timeline clip is the ONLY
  // audio clip that can be selected at all — so that flag made this inspector dead for the entire duration
  // of a scene-authoring session. The container difference is now expressed where it actually lives: the
  // WRITE (selSource) and the RELEASE (releaseSel), not in a disabled attribute.
  const selTimeline = selSource === 'timeline';   // for the badge + the notes; NEVER for `disabled`
  // What the ENGINE is playing for the selected clip's gain. BED clips only — a timeline clip has no lane
  // and no fade over it, and its id aliases into the bed's namespace (see drivenOn).
  const selGainDrive = selClip ? drivenOn(selSource, `audio.clip.${selClip.id}.gain`) : undefined;

  // ── THE TWO SHAPES THE BOUND DOCUMENT'S NAME IS SPOKEN IN ────────────────────────────────────────────
  // `boundName` is null for the global timeline — and also for the (impossible-but-cheap-to-survive) case
  // of an activeSceneId with no scene behind it: fall back to the generic phrase there rather than call a
  // bound scene "Global".
  //
  // ⚠ THE FALLBACK DISCRIMINATES ON `boundDoc`, NOT ON `transport.sceneBound`. They answer the same
  // question — is a scene bound? — but they are refreshed by DIFFERENT CLOCKS, and mixing them makes the
  // labels contradict each other for a tick. `boundName` and `boundDoc` are set from ONE getStatus() in
  // the audio fan-out (the recall render itself); `transport.sceneBound` only refreshes on the 100 ms
  // meter poll. So on an EXIT TO GLOBAL the fan-out cleared `boundName` to null in the same render that
  // swapped `tlAudio` to the global document's tracks, while `sceneBound` was still true — and the heading
  // read "Tracks — the bound scene" and the inspector said "This clip belongs to the bound scene" OVER THE
  // GLOBAL TIMELINE'S CLIPS. Self-healing within a tick, and the WRITE was never wrong (patchTlClip routes
  // off the live docKeyOf(), not off any of this) — but a label that names the wrong container over a live
  // FX write is the exact ambiguity these strings were added to kill, and the fresh discriminator was
  // already in hand. Both phrases now derive from the SAME read that produced the name they fall back for.
  // (`seekLocked` below stays on `transport.sceneBound` on purpose: it is a GUARD on a control, not a
  // label, and it is allowed to be conservative for a tick.)
  const sceneBound = boundDoc !== '__global__';
  const boundTitle = boundName ?? (sceneBound ? 'the bound scene' : 'Global');
  const boundPhrase = boundName ? `the scene “${boundName}”` : sceneBound ? 'the bound scene' : 'the global timeline';

  if (!host) return null;
  const pct = (v: number) => `${Math.min(100, Math.round(v * 100))}%`;
  // Scrub range: the SHOW's length (the global doc's), not the bound doc's — a 20 s scene would otherwise
  // pin the slider at its maximum while the bed played on at 4:30. Always far enough to reach the last clip.
  const scrubMax = Math.max(10, transport.showEnd, ...mix.clips.map((c) => c.start + c.duration));
  // ⚠ SEEKING FROM HERE IS DISABLED WHILE A SCENE IS BOUND, AND THAT IS NOT COSMETIC. A seek dispatches
  // host.show.transport({kind:'seek'}) → timeline.seek(), whose show-clock identity rule only fires while
  // the GLOBAL doc is bound. Under a bound scene the same control would seek the SCENE — the operator
  // nudges a slider in the AUDIO BED panel and recalls the picture to an arbitrary point mid-show, while
  // the bed does not move at all. Scrub Global to move the bed. (STOP is exempt and stays enabled: it
  // resets BOTH clocks — App's stop handler seeks the bound doc to its in-point AND showSeeks the global.)
  const seekLocked = transport.sceneBound;
  const seekLockTitle = 'Scrub Global to move the bed — a seek inside a scene does not move the show clock.';
  // ⚠ vec3, NOT the raw field. `!!spatial` gates the whole positioner block below, and `spatial.y` feeds a
  // Fader whose readout is `v.toFixed(1)` — so a `"spatial": true` or a y-less `{"x":0,"z":1}` loaded clean,
  // passed the truthy gate, and threw `undefined.toFixed` IN RENDER the moment the clip was SELECTED. No
  // ErrorBoundary sits above a plugin panel: that is a white-screened Audio Bed, mid-show, from a click.
  // (`padX ?? 0` did not save it either — `??` does not catch a present-but-non-numeric `"0"`.)
  const spatial = vec3(selClip?.spatial);
  const padX = padDraft?.x ?? spatial?.x ?? 0;
  const padZ = padDraft?.z ?? spatial?.z ?? 0;
  // What the ENGINE is playing for the house level. The master bus is PROJECT-GLOBAL — one output chain —
  // so this path names one thing and cannot alias across containers; it needs no drivenOn gate.
  const masterDrive = drive.get('audio.master.gain');

  const trackRow = (t: Track, source: 'bed' | 'timeline') => {
    const ro = source === 'timeline';
    const roTitle = "Read-only here — edit this track on its timeline lane (the gutter carries its name, mute, solo and gain). It rides the PLAYHEAD and restarts with its timeline.";
    // What the ENGINE is playing for this track's gain. BED tracks only — a timeline track's id aliases into
    // the bed's namespace and would resolve against the wrong container (see drivenOn).
    const drv = drivenOn(source, `audio.track.${t.id}.gain`);
    return (
      <div key={t.id} onDrop={ro ? undefined : onDrop(t.id)} onDragOver={ro ? undefined : allowDrop}
        className={`px-2 py-1.5 rounded border border-line-1 ${t.solo ? 'bg-accent/5' : 'bg-surface-2'} ${t.mute ? 'opacity-60' : ''} ${ro ? 'border-dashed' : ''}`}>
        <div className="flex items-center gap-1.5">
          <Music size={11} className="text-fg-3 shrink-0" />
          <TrackName value={t.name} disabled={ro} title={ro ? roTitle : 'Rename (Enter commits, Escape abandons)'}
            onCommit={(n) => setTrackName(t.id, n)} />
          {!ro && (
            <button onClick={() => removeTrack(t.id)} title="Remove track (and its clips)"
              className="shrink-0 text-fg-3 hover:text-danger"><Trash2 size={12} /></button>
          )}
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <button onClick={() => setTrackMute(t.id, !t.mute)} disabled={ro} title={ro ? roTitle : (t.mute ? 'Unmute' : 'Mute')}
            className={`shrink-0 disabled:opacity-40 disabled:cursor-not-allowed ${t.mute ? 'text-danger' : 'text-fg-3 hover:text-fg-1'}`}>
            {t.mute ? <VolumeX size={12} /> : <Volume2 size={12} />}
          </button>
          <button onClick={() => setTrackSolo(t.id, !t.solo)} disabled={ro} title={ro ? roTitle : (t.solo ? 'Un-solo' : 'Solo — silences every other track in THIS container')}
            className={`shrink-0 disabled:opacity-40 disabled:cursor-not-allowed ${t.solo ? 'text-accent' : 'text-fg-3 hover:text-fg-1'}`}>
            <Headphones size={12} />
          </button>
          {drv && <DriveBadge d={drv} />}
          {/* `drv?.value ?? …` — THE LEVEL IN THE ROOM, not the level in the file. Disabled under a LANE,
              because a move there is silently overwritten on the next frame; live under a FADE, because
              there a move is a real takeover (setTrackGain → releaseFade). See DriveBadge. */}
          <Fader value={drv?.value ?? t.gain ?? 1} min={0} max={1.5} step={0.01} disabled={ro || drv?.by === 'lane'}
            ariaLabel={`${t.name} gain`}
            title={(v) => (ro ? roTitle
              : drv?.by === 'lane' ? `gain ${g2(v)} — an automation lane owns this. Switch the lane off in the timeline to take it back.`
              : drv ? `gain ${g2(v)} — a scene/cue fade is holding this. Move the fader to take it back.`
              : `gain ${g2(v)}`)}
            onCommit={(g) => setTrackGain(t.id, g)}
            className="flex-1 min-w-0"
            readout={g2} readoutClassName="text-micro text-fg-3 tabular-nums w-8 text-right shrink-0" />
        </div>
      </div>
    );
  };

  return (
    // The `audio` context's VIEWPORT. It was a floating window that deliberately let clicks through
    // (pointer-events-none) because authoring the bed means dragging audio assets in from the Media
    // library — as a context that is simply the layout: the library IS the browser column beside it,
    // and the mixer gets the whole work area instead of 880x70vh of it.
    <div className="w-full h-full flex flex-col bg-surface-1" aria-label="Audio Bed">
        <div className="h-11 px-3 flex items-center gap-2 border-b border-line-1 bg-surface-2 shrink-0 select-none">
          <Music size={14} className="text-fg-2 shrink-0" />
          <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider shrink-0">Audio Bed</span>

          {/* Transport. The bed has NO clock of its own — it rides the SHOW clock on the MAIN transport
              (Play/Pause are the same ones as the Timeline panel / Space). The SEEK controls are disabled
              under a bound scene: a seek there moves the scene, not the show. See seekLocked. */}
          <div className="flex items-center gap-1 ml-2 shrink-0">
            <button onClick={() => host.show.transport({ kind: 'seek', sec: 0 })} disabled={seekLocked}
              title={seekLocked ? seekLockTitle : 'Return to start'}
              className="p-1 rounded-sm bg-surface-3 text-fg-2 hover:text-fg-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-fg-2"><SkipBack size={12} /></button>
            <button onClick={() => host.show.transport({ kind: transport.playing ? 'pause' : 'play' })}
              title={transport.playing ? 'Pause (Space)' : 'Play (Space)'}
              className={`p-1 rounded-sm ${transport.playing ? 'bg-accent text-black' : 'bg-surface-3 text-fg-2 hover:text-fg-1'}`}>
              {transport.playing ? <Pause size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
            </button>
            {/* STOP IS NOT SEEK-LOCKED. App's stop handler resets BOTH clocks — the bound doc to its own
                in-point AND the show clock to the GLOBAL in-point — so it is meaningful (and the only way
                back from a parked show) even with a scene bound. */}
            <button onClick={() => host.show.transport({ kind: 'stop' })}
              title="Stop — returns the show clock to the global in-point (and the bound timeline to its own)"
              className="p-1 rounded-sm bg-surface-3 text-fg-2 hover:text-fg-1"><Square size={12} /></button>
            <span className="text-micro text-fg-2 tabular-nums shrink-0"
              title="The show clock — the bed's position. It does not restart when a scene is recalled.">
              ♪ {fmt(transport.showTime)}
            </span>
            {/* THE PARKED SHOW. The show clock is SILENT by design — it emits no intent and pulses no
                hitEnd — so when the global Length runs out with Loop off, NOTHING else in the app says so.
                The transport keeps reporting `playing` (a scene loops underneath), the Play button above
                stays lit, this readout freezes, and the bed goes correctly but INEXPLICABLY silent. Without
                this badge the state is undiagnosable from the mixer, and the default global doc is exactly
                {'{'}duration: 60, loop: false{'}'} — so an unattended install reaches it in one minute. */}
            {transport.showEnded && (
              <span className="shrink-0 px-1.5 h-5 inline-flex items-center rounded bg-warn/15 text-warn text-micro whitespace-nowrap"
                title="The global timeline's Length ran out (Loop off). The show clock is parked and the bed has stopped — this is not a fault. Raise the global Length, turn the global Loop on, or press Stop then Play.">
                show ended
              </span>
            )}
            {/* THE OTHER WAY THIS PANEL GOES SILENT-BUT-HEALTHY-LOOKING, and the worse one: there is no
                engine at all. `show ended` above has a badge; a dead engine had NOTHING, and the mixer
                drew a full, working-looking UI over a silent room. The startup modal is dismissible, so
                without this badge the app would look healthy again the moment it was closed. 0.3. */}
            {!engineUp && (
              <span className="shrink-0 px-1.5 h-5 inline-flex items-center rounded bg-warn/15 text-warn text-micro whitespace-nowrap"
                title="ArtLux started without its audio engine — there is no sound. Authoring and saving still work normally. Expected audio-engine.node in the app's resources; from source, run npm run build:audio.">
                no audio engine
              </span>
            )}
            {/* THE THIRD WAY THIS PANEL GOES SILENT-BUT-HEALTHY-LOOKING, AND THE ONE THAT HAPPENS IN A VENUE.
                The engine is loaded, the mixer is live, the transport is running — and the AUDIO INTERFACE IS
                GONE (a bumped USB cable, a driver reload, a Windows power cycle on the device). `engineUp`
                above cannot see it: the addon is still perfectly loaded, so `available()` says yes. Until now
                the ONLY symptom was silence, and Preferences actively said "engine active" and NAMED the dead
                device. The meters keep polling, so this clears by itself the moment a device is back.
                DANGER-coloured, not warn: the other two badges mean "you cannot make sound"; this one means
                "your show is running and the room cannot hear it." */}
            {!deviceLive && (
              <span className="shrink-0 px-1.5 h-5 inline-flex items-center rounded bg-danger/15 text-danger text-micro whitespace-nowrap"
                title="THE AUDIO OUTPUT DEVICE IS GONE — the room is silent, and the show is still running. Usually a bumped USB cable or a driver reload. Reconnect it, then open Preferences ▸ Audio and pick it again; sound returns with no restart. (ArtLux will not do this for you — it does not re-open a device on its own.)">
                <AlertTriangle size={10} className="mr-1" /> no output device
              </span>
            )}
          </div>
          {/* Scrub the SHOW clock (seek) — the bed re-syncs to it. Disabled under a bound scene (seekLocked).
              A scrub IS a transport command, not a document edit: it goes to timeline.seek(), never through
              setMix/setData, so invariant 7 has nothing to say about it and it stays live per input event. */}
          <input type="range" min={0} max={scrubMax} step={0.05} value={Math.min(transport.showTime, scrubMax)}
            onChange={(e) => host.show.transport({ kind: 'seek', sec: Number(e.target.value) })}
            disabled={seekLocked} title={seekLocked ? seekLockTitle : 'Scrub the show clock'}
            className="flex-1 min-w-[80px] accent-accent disabled:opacity-40 disabled:cursor-not-allowed" />

          {/* L / R meters — the stereo image visibly shifts as you drag a source around the pad. */}
          <div className="w-20 shrink-0 space-y-0.5" title={`L ${meter.peakL.toFixed(3)} · R ${meter.peakR.toFixed(3)}`}>
            <div className="h-1.5 rounded bg-surface-3 overflow-hidden"><div className="h-full bg-accent transition-[width] duration-75" style={{ width: pct(meter.peakL) }} /></div>
            <div className="h-1.5 rounded bg-surface-3 overflow-hidden"><div className="h-full bg-accent transition-[width] duration-75" style={{ width: pct(meter.peakR) }} /></div>
          </div>
          {/* `+ Bed`, NOT `+ Track` — there are TWO track lists in the column below (the bed's and the bound
              timeline's) and this button can only ever add to the first, so `Track` named neither. It is also
              the SAME WORD the gutter's twin door uses for the same act (Timeline's `+ Bed`), and the same
              word the section heading below uses. One act, one word, in both surfaces. */}
          <button onClick={addTrack} title="Add a track to the BED (it rides the SHOW clock — a scene recall does not restart it)"
            className="shrink-0 inline-flex items-center gap-1 px-2 h-7 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 text-mini"><Plus size={12} /> Bed</button>
        </div>

        {error && (
          <div className="px-3 py-1.5 flex items-center gap-2 border-b border-line-1 bg-warn/10 text-warn text-micro shrink-0">
            <AlertTriangle size={12} className="shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="hover:text-fg-1"><X size={12} /></button>
          </div>
        )}

        {/* body — TRACKS (left) | CLIP INSPECTOR (right) */}
        <div className="flex-1 min-h-0 flex">
          {/* ── TRACKS ─────────────────────────────────────────────────────────────────────────────── */}
          <div className="w-[300px] shrink-0 border-r border-line-1 overflow-auto p-2 space-y-3">
            <section className="space-y-1.5">
              <h3 className="text-micro font-semibold text-fg-2 uppercase tracking-wider px-0.5"
                title="The BED — ProjectData.audio. One per project. It rides the SHOW clock, so a scene recall does not restart it.">
                Tracks — the bed
              </h3>
              {mix.tracks.length === 0 ? (
                <p className="text-micro text-fg-3/70 italic px-0.5 py-2">
                  No bed tracks. Add one, then drag audio in from the Media library — onto the track here, or straight onto its lane in the timeline.
                </p>
              ) : mix.tracks.map((t) => trackRow(t, 'bed'))}
            </section>

            {/* ⚠ THE HEADING NAMES THE DOCUMENT, AND IT NAMES IT AT DISPLAY TIME (see boundName). The two
                lists in this column are the ONLY place in the app where two containers' tracks share a
                scroll, and every container mints its own `Audio 1` — so "Tracks — this timeline" over an
                `Audio 1` was the exact ambiguity the operator hit. The name is re-resolved every poll and
                stored nowhere: rename the scene and this follows; duplicate it and the copy says its own
                name, not the original's. */}
            <section className="space-y-1.5">
              {/* ⚠ THE NAME IS `normal-case`, THE LABEL IS NOT. The h3 is uppercase by house style, which is
                  fine for the word "TRACKS" and a lie about a scene the user named `Foyer` — it is not called
                  `FOYER`, and the same reasoning kept the name out of the clip badge. Caps the label, print
                  the name as the user typed it. (The tooltip says "The audio owned by <phrase>" rather than
                  "<phrase>'s own audio" for the same reason: the phrase ends in a curly quote, and a
                  possessive hung off it read as part of the scene's name.) */}
              <h3 className="text-micro font-semibold text-fg-2 uppercase tracking-wider px-0.5 truncate"
                title={sceneBound
                  ? `The audio owned by ${boundPhrase} (Timeline.audio). It rides the PLAYHEAD and restarts with its timeline. Read-only here — edit it on its lane.`
                  : "The GLOBAL timeline's own audio (Timeline.audio). It rides the PLAYHEAD and restarts with its timeline. Read-only here — edit it on its lane."}>
                Tracks — <span className="normal-case">{boundTitle}</span>
              </h3>
              {tlAudio.tracks.length === 0 ? (
                <p className="text-micro text-fg-3/70 italic px-0.5 py-2">
                  Nothing yet — {boundPhrase} has no audio tracks of its own.
                </p>
              ) : (
                <>
                  {tlAudio.tracks.map((t) => trackRow(t, 'timeline'))}
                  <p className="text-micro text-fg-3/70 italic px-0.5">
                    Read-only here — a timeline's own tracks are mixed on their lane (name, mute, solo, gain live in the gutter).
                  </p>
                </>
              )}
            </section>
          </div>

          {/* ── CLIP INSPECTOR — follows the timeline selection ───────────────────────────────────── */}
          <div className="flex-1 min-w-0 overflow-auto p-3 space-y-3">
            {!selClip ? (
              <div className="h-full flex flex-col items-center justify-center gap-1 text-center px-6">
                <Sliders size={18} className="text-fg-3/50" />
                <p className="text-mini text-fg-3">Select an audio clip on the timeline to shape it.</p>
                <p className="text-micro text-fg-3/70">
                  {sel?.kind === 'clip'
                    ? 'A video clip is selected — this inspector shapes audio (gain, spatial position, effects).'
                    : 'Gain, spatial position and the insert chain live here; placement, trim and fades live on the lane.'}
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Music size={13} className="text-fg-2 shrink-0" />
                  <span className="text-mini font-semibold text-fg-1 truncate" title={selClip.path}>{selClip.name}</span>
                  {/* THE CLIP'S MUTE. The lane draws a muted clip but cannot clear the flag (its gutter's mute
                      is the TRACK's) and the driver silences it, so this is the only control in the app that
                      can un-mute a bed clip. Deleting it would strand any project already carrying one. */}
                  <button onClick={() => setClipMute(selClip.id, !selClip.mute)}
                    title={selClip.mute ? 'Unmute this clip' : 'Mute this clip (the track keeps playing)'}
                    className={`shrink-0 ${selClip.mute ? 'text-danger' : 'text-fg-3 hover:text-fg-1'}`}>
                    {selClip.mute ? <VolumeX size={13} /> : <Volume2 size={13} />}
                  </button>
                  {/* WHICH CONTAINER — and therefore WHICH CLOCK. Both are writable; they differ in WHEN they
                      are heard, which is the one thing the operator cannot see from the controls below. */}
                  <span className={`shrink-0 px-1.5 h-5 inline-flex items-center rounded text-micro uppercase tracking-wider ${selTimeline ? 'bg-surface-3 text-fg-2' : 'bg-accent/15 text-accent'}`}
                    title={selTimeline
                      ? "This clip is on the BOUND TIMELINE's own audio (Timeline.audio) — it rides the playhead and restarts with its timeline."
                      : 'This clip is on the BED (ProjectData.audio) — it rides the show clock and survives a scene recall.'}>
                    {selTimeline ? 'this timeline' : 'bed'}
                  </span>
                </div>

                {/* ⚠ THIS NOTE MUST NAME ONLY CONTROLS THAT ACTUALLY EXIST — and it must never again claim
                    this clip is read-only. It said so honestly until the write path landed; the sentence it
                    ended on ("to ride one clip's level today, put it on the bed") told the operator to stop
                    using the per-scene audio feature, which for a spatialised per-scene sting is not a
                    workaround at all. Everything below now writes. What is left to say is the DIVISION OF
                    LABOUR (this panel shapes; the lane places) and the CLOCK — and the clock is the part
                    nothing else on screen tells them. */}
                {/* …and it NAMES the document, because this is the one panel that WRITES it. Every clip on
                    screen while a scene is bound is a timeline clip (App withholds the bed lanes there), and
                    a Capture-Scene clone gives two scenes byte-identical clip ids and names — so "the bound
                    timeline" left the operator no way to see WHICH scene the reverb they are dialling is
                    going into. Display-time, from getScenes(); never stored. */}
                {selTimeline && (
                  <p className="px-2 py-1.5 rounded border border-line-1 bg-surface-2 text-micro text-fg-3">
                    This clip belongs to {boundPhrase}, so it rides the PLAYHEAD and restarts whenever that
                    timeline does — it is not on the show clock. Gain, mute, position and FX are yours here;
                    its placement, trim and fades live on its lane, and its TRACK's mute, solo and gain live in
                    that lane's gutter.
                  </p>
                )}

                {/* gain — THE LEVEL IN THE ROOM, not the level in the file. See DriveBadge / drivenOn. */}
                <div className="flex items-center gap-2">
                  <span className="text-micro text-fg-3 w-16 shrink-0">gain</span>
                  {selGainDrive && <DriveBadge d={selGainDrive} />}
                  <Fader value={selGainDrive?.value ?? selClip.gain ?? 1} min={0} max={1.5} step={0.01}
                    disabled={selGainDrive?.by === 'lane'}
                    ariaLabel="clip gain"
                    docKey={gestureDocKey}
                    title={(v) => (selGainDrive?.by === 'lane' ? `gain ${g2(v)} — an automation lane owns this. Switch the lane off in the timeline to take it back.`
                      : selGainDrive ? `gain ${g2(v)} — a scene/cue fade is holding this. Move the fader to take it back.`
                      : `gain ${g2(v)}`)}
                    onCommit={(g) => setClipGain(selClip.id, g)}
                    className="flex-1 min-w-0"
                    readout={g2} readoutClassName="text-micro text-fg-2 tabular-nums w-16 text-right shrink-0" />
                </div>

                {/* Spatial positioner — ambisonic encode + binaural HRTF decode. Drag the pad to move the
                    source around the listener; you hear it move and the L/R meters shift. */}
                <section className="rounded border border-line-1 bg-surface-2 p-2 space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Orbit size={12} className={spatial ? 'text-accent' : 'text-fg-3'} />
                    <label className="flex items-center gap-1.5 text-micro text-fg-2">
                      <input type="checkbox" checked={!!spatial} className="accent-accent"
                        onChange={(e) => setClipSpatialOn(selClip.id, e.target.checked)} />
                      Spatial
                    </label>
                  </div>
                  {spatial ? (
                    <div className="flex items-center gap-3">
                      <SpatialPad x={padX} z={padZ} docKey={gestureDocKey}
                        onDraft={(x, z) => setPadDraft({ x, z })}
                        onCommit={(x, z) => { setPadDraft(null); setClipSpatialXZ(selClip.id, x, z); }} />
                      <div className="flex flex-col gap-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-micro text-fg-3 w-10 shrink-0">height</span>
                          <Fader value={spatial.y} min={-2} max={2} step={0.1}
                            ariaLabel="spatial height"
                            docKey={gestureDocKey}
                            title={(v) => `y ${v.toFixed(1)} m`}
                            onCommit={(y) => setClipSpatialY(selClip.id, y)}
                            className="w-24"
                            readout={(v) => `${v.toFixed(1)} m`}
                            readoutClassName="text-micro text-fg-2 tabular-nums w-12 shrink-0" />
                        </div>
                        <span className="text-micro text-fg-3 tabular-nums">
                          x {padX.toFixed(1)} · z {padZ.toFixed(1)} m
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-micro text-fg-3 italic">Off — the clip plays flat (unspatialised) into the mix.</p>
                  )}
                </section>

                {/* Insert chain on this source. It runs BEFORE spatialisation, so a reverb here puts the
                    source in a room and then the room is placed with it — which is what you want. */}
                <section className="rounded border border-line-1 bg-surface-2 p-2 space-y-2">
                  <div className="flex items-center gap-1.5">
                    {/* fxOf, so the COUNT is the count of the chain actually rendered below: `"effects":"abc"`
                        has a truthy `.length` of 3 and used to badge "FX (3)" over an empty chain. */}
                    <Sliders size={12} className={fxOf(selClip.effects).length ? 'text-accent' : 'text-fg-3'} />
                    <span className="text-micro font-semibold text-fg-2 uppercase tracking-wider">FX{fxOf(selClip.effects).length ? ` (${fxOf(selClip.effects).length})` : ''}</span>
                  </div>
                  {/* No `disabled` — the chain is live against BOTH containers now. The engine has exactly two
                      insert points and one of them is the clip; a container whose clips could not take that
                      insert was a container in which half the engine did not exist.
                      `docKey` guards the PARAM FADERS inside it: an FX knob is a split gesture like any
                      other, and EffectChain keys its rows on `fx.id` — which Capture Scene aliases too — so
                      a recall mid-drag does not even remount the row. See gestureDocKey. */}
                  <EffectChain scope="clip" effects={fxOf(selClip.effects)} docKey={gestureDocKey}
                    onChange={(fx, touched) => setClipEffects(selClip.id, fx, touched)} />
                </section>
              </>
            )}
          </div>
        </div>

        {/* Master strip — the fader + insert chain on the DECODED output (after the ambisonic field has
            been rendered to headphones or speakers). This is where a limiter to protect the rig goes.
            PROJECT-GLOBAL: there is one output chain, so it cannot be per-scene. */}
        <div className="border-t border-line-1 shrink-0">
          <div className="h-9 px-3 flex items-center gap-2">
            <span className="text-mini font-semibold text-fg-2 shrink-0">Master</span>
            <button onClick={() => setOpenMaster(!openMaster)} title="Master effects"
              className={`inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 text-micro ${fxOf(master.effects).length ? 'text-accent' : 'text-fg-3 hover:text-fg-1'}`}>
              <Sliders size={11} /> FX{fxOf(master.effects).length ? ` (${fxOf(master.effects).length})` : ''}
            </button>
            {/* ⚠ num(), not a bare `?? 1`. THIS STRIP RENDERS UNCONDITIONALLY — it is not behind a selection —
                and a bus's gain has NO normalizer (normalizeAudioMix's buses are a shape guard, its own
                comment says so). `??` does not catch a present-but-non-numeric `"gain": "1"`, which then went
                straight into g2 → `"1".toFixed(2)` → TypeError in render. That one did not need a clip
                selected or a panel scrolled: it white-screened the Audio Bed ON OPEN. The driver has guarded
                this same read since 643d3c5 (boundGain, at the engine door); the fader beside it had not. */}
            {/* THE HEADLINE CASE. `audio.master.gain` is precisely what a scene recall exists to fade and
                what an operator puts a lane on — so this is the fader that spent Wave 3 frozen at 1.00 over
                a room the engine had slid to 0.32. It draws the DRIVEN value now (see `drive`).
                No container gate: the master bus is PROJECT-GLOBAL (one output chain), so `audio.master.gain`
                names one thing and cannot alias — unlike the clip and track paths above. */}
            {masterDrive && <DriveBadge d={masterDrive} />}
            <Fader value={masterDrive?.value ?? num(master.gain) ?? 1} min={0} max={1.5} step={0.01}
              disabled={masterDrive?.by === 'lane'}
              ariaLabel="master gain"
              title={(v) => (masterDrive?.by === 'lane' ? `master gain ${g2(v)} — an automation lane owns the house level. Switch the lane off in the timeline to take it back.`
                : masterDrive ? `master gain ${g2(v)} — a scene/cue fade is holding the house level. Move the fader to take it back.`
                : `master gain ${g2(v)}`)}
              onCommit={setMasterGain}
              className="w-40"
              readout={g2} readoutClassName="text-micro text-fg-3 w-8 tabular-nums" />
            {/* A reverb with a big room and a hot wet level really can push past full scale — that clips
                the output. Better to see it here than to hear it on the amp. */}
            {clipping && (
              <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded bg-danger/15 text-danger text-micro">
                <AlertTriangle size={10} /> clipping
              </span>
            )}
            <span className="ml-auto text-micro text-fg-3 truncate">
              The bed plays when the SHOW clock is over it — a scene recall does not restart it.
            </span>
          </div>
          {openMaster && (
            <div className="px-3 pb-2">
              <EffectChain scope="master" effects={fxOf(master.effects)} onChange={setMasterEffects} />
            </div>
          )}
        </div>
    </div>
  );
};
