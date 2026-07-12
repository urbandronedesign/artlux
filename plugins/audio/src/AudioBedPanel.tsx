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
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Plus, Music, Trash2, Volume2, VolumeX, Headphones, AlertTriangle, Play, Pause, SkipBack, Square, Orbit, Sliders } from 'lucide-react';
import { useDraggable, type PanelProps } from '@artlux/sdk/renderer';
import { getAudioHost } from './audioHost';
import { audioClient } from './audioClient';
import { EffectChain, type Effect, type FxParamRef } from './EffectChain';
import { Fader } from './Fader';
import { MASTER_BUS_ID } from './effectDefs';
import { releaseFade } from './automationTargets';

interface Spatial { x: number; y: number; z: number }
interface Clip { id: string; trackId: string; name: string; path: string; start: number; duration: number; inPoint: number; sourceDuration?: number; gain?: number; mute?: boolean; spatial?: Spatial; effects?: Effect[] }
interface Track { id: string; name: string; gain?: number; mute?: boolean; solo?: boolean }
interface Bus { id: string; name: string; gain?: number; effects?: Effect[] }
interface Mix { tracks: Track[]; clips: Clip[]; buses: Bus[] }
// The BOUND timeline's own audio — the same clip/track shapes, no buses (one output chain, project-global).
interface TlAudio { tracks: Track[]; clips: Clip[] }
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
const SpatialPad: React.FC<{
  x: number; z: number;
  onDraft: (x: number, z: number) => void;
  onCommit: (x: number, z: number) => void;
}> = ({ x, z, onDraft, onCommit }) => {
  const ref = useRef<HTMLDivElement>(null);
  // The last position the pointer produced. Read on pointerup — never the closure, which is a render behind.
  const pending = useRef<{ x: number; z: number } | null>(null);
  const set = (clientX: number, clientY: number) => {
    const el = ref.current; if (!el) return;
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
    set(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => set(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const p = pending.current; pending.current = null;
      if (p) onCommit(p.x, p.z);   // ONE write per drag
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

const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `a-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
const emptyMix = (): Mix => ({ tracks: [], clips: [], buses: [] });
// A SHARED FROZEN FALLBACK, never a fresh literal: it lands in React state and feeds a useMemo dep, so a
// new `{}` per read would re-render (and re-derive the inspector) on every host fan-out for a document
// that has no audio at all. (The driver's EMPTY_CLIPS makes the same promise one layer down.)
const EMPTY_TL: TlAudio = Object.freeze({ tracks: Object.freeze([]) as unknown as Track[], clips: Object.freeze([]) as unknown as Clip[] });
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? 'audio';
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const g2 = (v: number) => v.toFixed(2);

export const AudioBedPanel: React.FC<PanelProps> = ({ onClose }) => {
  const host = getAudioHost();
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
  const [error, setError] = useState<string | null>(null);
  const [openMaster, setOpenMaster] = useState(false);
  // The spatial pad's in-flight drag (invariant 7). LOCAL state — a draft is not a document.
  const [padDraft, setPadDraft] = useState<{ x: number; z: number } | null>(null);
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
  const { positionerStyle, handleProps } = useDraggable();

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
      }).catch(() => {});
      // THE BED RIDES THE SHOW CLOCK — st.showTime, and NEVER the BOUND DOCUMENT'S PLAYHEAD (the other
      // number on this status object). Mirroring that one here was a LIE about the bed the moment a scene
      // was bound: the readout and the scrub slider would show the SCENE's time while the bed played on at
      // a completely different position. `duration` was the same lie one level down — it is the BOUND doc's
      // Length, so a 20 s scene pinned the bed's scrub slider at its maximum. Neither belongs in this file:
      // nothing here may read either of them, which is a grep-enforced gate, not a preference.
      const st = host.show.getStatus();
      setTransport({ playing: st.playing, showTime: st.showTime, showEnd: st.showEnd,
        sceneBound: st.activeSceneId != null, showEnded: st.showEnded });
    }, 100);
    return () => clearInterval(iv);
  }, [host]);

  const selId = sel && sel.kind === 'audioClip' ? sel.id : null;
  // A new selection abandons any half-finished pad drag from the previous one — otherwise the draft would
  // paint the NEW clip's dot at the OLD clip's position for a frame.
  useEffect(() => { setPadDraft(null); }, [selId]);

  // Every mutation builds a fresh bed and writes it back (host normalizes + persists + notifies the player).
  const commit = (next: Mix) => { mixRef.current = next; setMixState(next); host?.audio.setMix(next); };

  // ── WHICH CONTAINER IS THE INSPECTOR LOOKING AT ──────────────────────────────────────────────────────
  // THE ONE ROUTER for every clip write below. It is read off the SELECTION, never guessed: `sel.source` is
  // a discriminated field precisely because the same clip id can exist in both containers (Capture Scene
  // deep-clones the bound timeline into a scene, ids verbatim), and the two commit through completely
  // different paths at completely different costs. `null` = nothing (or a video clip) is selected.
  const selSource: 'bed' | 'timeline' | null = sel?.kind === 'audioClip' ? sel.source : null;
  // Patch ONE clip in the bound timeline's own audio. Optimistic locally (the host hands nothing back), and
  // guarded by the SAME rule the host applies: an id that is not in the container we are looking at is
  // DROPPED, not searched for. The host's fan-out is the truth and overwrites this a render later.
  const patchTlClip = (id: string, p: Partial<Clip>) => {
    const cur = tlRef.current;
    if (!cur.clips.some((c) => c.id === id)) return;   // the doc rebound (a recall, a delete) — abandon the edit
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
    releaseChangedFx('audio.master', fx, mixRef.current.buses.find((b) => b.id === MASTER_BUS_ID)?.effects ?? [], touched);
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
    if (selSource === 'bed') releaseChangedFx(`audio.clip.${id}`, fx, mixRef.current.clips.find((c) => c.id === id)?.effects ?? [], touched);
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
  const spatialOf = (id: string): Spatial | undefined => selClipIn(id)?.spatial;
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

  const addTrack = () => {
    const cur = mixRef.current;
    commit({ ...cur, tracks: [...cur.tracks, { id: uid(), name: `Track ${cur.tracks.length + 1}`, gain: 1, mute: false }] });
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
  const spatial = selClip?.spatial;
  const padX = padDraft?.x ?? spatial?.x ?? 0;
  const padZ = padDraft?.z ?? spatial?.z ?? 0;

  const trackRow = (t: Track, source: 'bed' | 'timeline') => {
    const ro = source === 'timeline';
    const roTitle = "Read-only here — edit this track on its timeline lane (the gutter carries its name, mute, solo and gain). It rides the PLAYHEAD and restarts with its timeline.";
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
          <Fader value={t.gain ?? 1} min={0} max={1.5} step={0.01} disabled={ro}
            ariaLabel={`${t.name} gain`}
            title={(v) => (ro ? roTitle : `gain ${g2(v)}`)}
            onCommit={(g) => setTrackGain(t.id, g)}
            className="flex-1 min-w-0"
            readout={g2} readoutClassName="text-micro text-fg-3 tabular-nums w-8 text-right shrink-0" />
        </div>
      </div>
    );
  };

  return (
    // NOT a blocking modal: authoring the bed means dragging audio assets IN from the Media library, so the
    // full-screen container is pointer-events-none (the library + the rest of the editor stay live) and only
    // the window itself takes pointer events. Drag the header to move it clear of whatever it covers.
    <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center">
      <div style={positionerStyle} className="pointer-events-auto">
      <div role="dialog" aria-label="Audio Bed"
        className="w-[880px] max-w-[94vw] h-[70vh] max-h-[84vh] flex flex-col bg-surface-1 border border-line-2 rounded-lg shadow-e3 animate-modal-in">
        {/* header — drag handle */}
        <div {...handleProps} className="h-11 px-3 flex items-center gap-2 border-b border-line-1 bg-surface-2 shrink-0 cursor-move select-none">
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
          <button onClick={addTrack} title="Add a track to the BED"
            className="shrink-0 inline-flex items-center gap-1 px-2 h-7 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 text-mini"><Plus size={12} /> Track</button>
          <button onClick={onClose} className="text-fg-3 hover:text-fg-1 ml-1"><X size={16} /></button>
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

            <section className="space-y-1.5">
              <h3 className="text-micro font-semibold text-fg-2 uppercase tracking-wider px-0.5"
                title={transport.sceneBound
                  ? "The BOUND SCENE's own audio (Timeline.audio). It rides the PLAYHEAD and restarts with its timeline. Read-only here — edit it on its lane."
                  : "The GLOBAL timeline's own audio (Timeline.audio). It rides the PLAYHEAD and restarts with its timeline. Read-only here — edit it on its lane."}>
                Tracks — this timeline
              </h3>
              {tlAudio.tracks.length === 0 ? (
                <p className="text-micro text-fg-3/70 italic px-0.5 py-2">
                  {transport.sceneBound ? 'The bound scene' : 'The global timeline'} has no audio tracks of its own.
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
                {selTimeline && (
                  <p className="px-2 py-1.5 rounded border border-line-1 bg-surface-2 text-micro text-fg-3">
                    This clip belongs to the bound timeline, so it rides the PLAYHEAD and restarts whenever its
                    timeline does — it is not on the show clock. Gain, mute, position and FX are yours here;
                    its placement, trim and fades live on its lane, and its TRACK's mute, solo and gain live in
                    that lane's gutter.
                  </p>
                )}

                {/* gain */}
                <div className="flex items-center gap-2">
                  <span className="text-micro text-fg-3 w-16 shrink-0">gain</span>
                  <Fader value={selClip.gain ?? 1} min={0} max={1.5} step={0.01}
                    ariaLabel="clip gain"
                    title={(v) => `gain ${g2(v)}`}
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
                      <SpatialPad x={padX} z={padZ}
                        onDraft={(x, z) => setPadDraft({ x, z })}
                        onCommit={(x, z) => { setPadDraft(null); setClipSpatialXZ(selClip.id, x, z); }} />
                      <div className="flex flex-col gap-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-micro text-fg-3 w-10 shrink-0">height</span>
                          <Fader value={spatial.y} min={-2} max={2} step={0.1}
                            ariaLabel="spatial height"
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
                    <Sliders size={12} className={selClip.effects?.length ? 'text-accent' : 'text-fg-3'} />
                    <span className="text-micro font-semibold text-fg-2 uppercase tracking-wider">FX{selClip.effects?.length ? ` (${selClip.effects.length})` : ''}</span>
                  </div>
                  {/* No `disabled` — the chain is live against BOTH containers now. The engine has exactly two
                      insert points and one of them is the clip; a container whose clips could not take that
                      insert was a container in which half the engine did not exist. */}
                  <EffectChain scope="clip" effects={selClip.effects ?? []}
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
              className={`inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 text-micro ${master.effects?.length ? 'text-accent' : 'text-fg-3 hover:text-fg-1'}`}>
              <Sliders size={11} /> FX{master.effects?.length ? ` (${master.effects.length})` : ''}
            </button>
            <Fader value={master.gain ?? 1} min={0} max={1.5} step={0.01}
              ariaLabel="master gain"
              title={(v) => `master gain ${g2(v)}`}
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
              <EffectChain scope="master" effects={master.effects ?? []} onChange={setMasterEffects} />
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
};
