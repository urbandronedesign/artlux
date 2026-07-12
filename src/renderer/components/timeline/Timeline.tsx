import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, ChevronDown, Film, Plus, Save, ChevronLeft, ChevronRight } from 'lucide-react';
import { Timeline as TL, VideoClip, VideoLayer, SurfaceContent, SourceType, StateMachine, defaultStateMachine, isContentClip, timelineEnd, timelineStart, timelineDuration, hasTimelineRegion, timelineAudioClips, timelineAudioTracks, type AudioClip, type AudioMix, type AudioTrack, type AssetEntry } from '../../types';
import { timeline as engine } from '../../services/timeline';
import * as selection from '../../services/selection';
import { ContentEditor } from '../ContentEditor';
import { GUTTER, RULER_H, LANE_H, MIN_LANE_H, MAX_LANE_H, PAGE_SECS, laneHeight, clamp, fmtClock, fmtTimecode } from './geometry';
import { splitClipAt, bladeAt, rippleDelete, liftDelete } from './operations';
import { collectSnapPoints, snap, type SnapPoint } from './snapping';
import { AudioLane, type AudioDragMode } from './AudioLane';
import { ensurePeaks, probeAudioDuration, sourceDurationFor } from './audioPeaks';
import { TimelineToolbar } from './TimelineToolbar';
import { TimelineRuler } from './TimelineRuler';
import { TrackHeader } from './TrackHeader';
import { Lane } from './Lane';
import { StateLane } from './StateLane';
import { AutomationLane, AUTO_LANE_H } from './AutomationLane';
import { AutomationTargetPicker } from './AutomationTargetPicker';
import { automationTargetRegistry } from '../../host/registries';
import type { AutomationLane as AutoLane } from '../../types';
import type { AutomationTargetDef } from '@artlux/sdk/renderer';
import { TakesBin } from './TakesBin';
import { trackingRecorder, trackingTake } from '@artlux/plugin-lidar-tracking';
import { ensureBlobUrl, mimeForPath } from '../../services/mediaCache';
import { StateGraphEditor } from './StateGraphEditor';
import { DragMode } from './ClipBlock';
import { useTimelineKeys } from './hooks/useTimelineKeys';

// Fallback length for an audio file the browser cannot decode (some .aiff): place a trimmable clip rather
// than refuse the drop. A decodable file gets its real length from probeAudioDuration.
const DEFAULT_AUDIO_DURATION = 10;

interface Props {
  timeline: TL;
  onChange: (t: TL) => void;
  stateMachine: StateMachine;                          // project-level show graph (lives in App, not the timeline)
  onStateMachineChange: (sm: StateMachine) => void;
  playing: boolean;
  onTogglePlay: () => void;
  maximized?: boolean;
  onToggleMax?: () => void;
  projectPath?: string | null; // when set, recorded takes are copied into the project's assets/tracking
  onRegisterAsset?: (entry: AssetEntry) => void; // a file dropped onto a lane is imported + added to the library
  scenes?: { id: string; name: string }[]; // for the FSM 'recallScene' action picker
  cues?: { id: string; name: string }[];   // for the FSM 'fireCue' action picker
  // Per-state authoring context: which scene's timeline is bound to the editor, the scene list for the
  // pill, and the trigger→build→save→continue handlers. Absent → plain global-timeline editing.
  author?: AuthorContext;
  // The GLOBAL audio bed (ProjectData.audio). Passed straight down from App, because the bed's lanes are
  // drawn on THIS ruler while Global is bound — there, show clock ≡ playhead, so the ruler is honest.
  // ABSENT while a scene is bound (App decides): the two clocks have diverged and drawing the bed against
  // a scene-relative ruler would be a lie. The header shows a `♪ BED mm:ss` readout instead.
  audio?: { mix: AudioMix; onChangeMix: (m: AudioMix) => void };
}

export interface AuthorContext {
  activeSceneId: string | null;                 // null = editing the shared global timeline
  activeName: string;                           // 'Global' or the scene name
  activeAccent: string;                         // identity colour of the active context
  index: number;                                // 0-based position of the active scene (−1 for global)
  total: number;                                // number of scenes (for "State N of M")
  scenes: { id: string; name: string; accent?: string; hasTimeline: boolean; clipCount?: number }[];
  onSelect: (sceneId: string | null) => void;   // enter author for a scene, or null → global
  onSave: () => void;                           // Save to State (re-capture look)
  onPrev: () => void;                           // ◂ Prev state
  onNext: () => void;                           // Next ▸ state
  onNew: () => void;                            // ＋ New state (empty timeline)
}

// DaVinci-style NLE timeline. Tracks (layers) hold clips placed by time; the unified transport
// (top-bar play) drives the engine — the playback clock. Edits commit to project state via
// onChange; the live playhead/time are read from the engine render-free. Layout is a single
// vertical scroller with a sticky track-header gutter and a sticky timecode ruler.
export const Timeline: React.FC<Props> = ({ timeline, onChange, stateMachine, onStateMachineChange, playing, onTogglePlay, maximized = false, onToggleMax, projectPath, onRegisterAsset, scenes = [], cues = [], author, audio: audioProp }) => {
  const [pxPerSec, setPxPerSec] = useState(40);
  const [pillOpen, setPillOpen] = useState(false); // scene/state selector dropdown
  const [selected, setSelected] = useState<string | null>(null);
  // WHICH ARRAY the single `selected` id lives in. It names an id in one of THREE arrays now (the video
  // clips, the bed's clips, this timeline's audio clips), and every consumer of it has to be told which —
  // see deleteSelected, which is a live bug without it.
  const [selectedSource, setSelectedSource] = useState<'video' | 'bed' | 'timeline'>('video');
  const [pickerAt, setPickerAt] = useState<{ x: number; y: number } | null>(null); // automation picker anchor
  const [defsTick, setDefsTick] = useState(0);           // forces a target re-enumeration (~1 Hz)
  const [autoPlayhead, setAutoPlayhead] = useState(0);   // ~10 Hz playhead for the lanes' live readouts
  const [tool, setTool] = useState<'select' | 'blade'>('select');
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [draft, setDraft] = useState<VideoClip | null>(null);
  // ONE draft for a dragged audio clip, tagged with its container so the single commit on pointerup knows
  // which array to write back (the bed's, or this timeline's).
  const [audioDraft, setAudioDraft] = useState<{ clip: AudioClip; source: 'bed' | 'timeline' } | null>(null);
  const [resizeDraft, setResizeDraft] = useState<{ id: string; height: number } | null>(null);
  // The lane REORDER's draft: the layer ids in their dragged order. It used to commit a whole document
  // per lane crossing, INSIDE pointermove (invariant 7) — six full setData + projector fan-outs per drag.
  const [orderDraft, setOrderDraft] = useState<string[] | null>(null);
  const [regionDrag, setRegionDrag] = useState<{ edge: 'in' | 'out'; t: number } | null>(null); // loop-region handle drag (draft; commits once on pointerup)
  const [pages, setPages] = useState(0); // infinite-timeline growth: content spans (pages+1) PAGE_SECS at least
  const [smEditorOpen, setSmEditorOpen] = useState(false);

  // ⚠ THE BOUND-DOCUMENT KEY. A GESTURE MUST LAND ON THE DOCUMENT IT STARTED ON, OR ON NOTHING.
  //
  // <TimelinePanel> carries NO React `key`, so it does NOT remount when the bound scene changes (see
  // TimelineToolbar's NumField, which fixed exactly this for Length/fps): a recall simply repoints
  // `timeline`, `timelineRef.current` and `onChange` under the SAME component instance — under a live
  // pointer, mid-drag. And `handleRecallScene` (App.tsx) is the single funnel for the FSM, the cueBus
  // (OSC / tablet GO), the scheduler, `enterAuthor` and the scene pill, with no in-flight-edit check.
  // So the rebind is not exotic: in an unattended install it is what the show DOES, on schedule.
  //
  // THIS EXACT STRING IS THE WRITE TARGET. App.handleTimelineChange switches on `activeSceneId` and
  // nothing else: truthy → setScenes(that scene), null → setTimeline (global). So keying a gesture on
  // it is keying it on where its commit will actually LAND.
  //
  // DO NOT KEY THE DISCARD ON THE DOCUMENT'S VALUE (or on the dragged clip's value). Capture Scene does
  // `timeline: structuredClone(activeTimeline)` — the clone's clips, tracks and automation lanes carry
  // the SAME IDS and usually the same values — so a value-keyed guard never fires on the swap it exists
  // to catch, and the edit lands in the incoming scene's identically-named clip. That is the inert fix.
  // Identity, not value.
  const docKey = author?.activeSceneId ?? '__global__';
  const docKeyRef = useRef(docKey); docKeyRef.current = docKey;

  // The rendered track order = the bound document's, with the reorder draft applied. RESOLVED BY ID
  // AGAINST THE BOUND DOCUMENT on every render: if a recall rebinds mid-drag, the ids stop resolving and
  // the preview falls straight back to what is actually bound — a draft can never paint the outgoing
  // document's tracks over the incoming one.
  const layers = useMemo(() => {
    const ls = timeline.layers;
    if (!orderDraft || orderDraft.length !== ls.length) return ls;
    const out: VideoLayer[] = [];
    for (const id of orderDraft) {
      const l = ls.find(x => x.id === id);
      if (!l) return ls;                  // the document rebound under the drag — show what is bound
      out.push(l);
    }
    return out;
  }, [timeline.layers, orderDraft]);

  const dur = timeline.duration;
  const fps = timeline.fps ?? 30;
  const sm = stateMachine ?? defaultStateMachine();
  // --- the two audio containers (see the `audio` prop, and Timeline.audio in types.ts) ---
  const bedTracks = audioProp?.mix.tracks ?? [];
  const bedClips = audioProp?.mix.clips ?? [];
  const tlTracks = timelineAudioTracks(timeline);
  const tlClips = timelineAudioClips(timeline);

  // Mirror the selection into the render-free store a plugin panel (the audio mixer's clip inspector)
  // subscribes to through host.show. An EFFECT, not a call inside setSelected: an updater is invoked
  // twice under StrictMode and may be replayed, while an effect commits exactly once per committed
  // selection. The store itself is idempotent, so a re-render with an unchanged selection wakes nobody.
  // Nothing here enters the `Timeline` data type or App state — the selection stays ephemeral.
  // It sits BELOW the two containers on purpose: they are in its dep array, and a dep array is evaluated
  // during render, so reading them from above would be a temporal-dead-zone throw on the FIRST render.
  //
  // PUBLISH ONLY A RESOLVABLE SELECTION. `selected` OUTLIVES A DOCUMENT REBIND — see onAudioRemoveClip
  // below, which exists precisely because of it: select an audio clip on scene A's lane, let the FSM or
  // the scheduler recall scene B, and `selected`/`selectedSource` still name a clip that is in NO array of
  // the now-bound document. The on-screen highlight is already gone (AudioLane gets a selectedId it cannot
  // match), but an unfiltered channel would keep telling a mixer that clip is live — and any edit it made
  // would fire onChange(timeline) → setData → warmMedia + pruneStaleLayers + compileAutomation + a
  // structured-clone postMessage to every projector port, on the bound document of a running show, for a
  // change that lands nowhere. Filtering HERE fixes it once, instead of in every consumer that will ever
  // subscribe. The store is idempotent, so the widened deps add zero wakeups.
  useEffect(() => {
    if (!selected) { selection.setSelection(null); return; }
    if (selectedSource === 'video') {
      selection.setSelection(timeline.clips.some(c => c.id === selected) ? { kind: 'clip', id: selected } : null);
      return;
    }
    const pool = selectedSource === 'bed' ? bedClips : tlClips;
    selection.setSelection(pool.some(c => c.id === selected) ? { kind: 'audioClip', id: selected, source: selectedSource } : null);
  }, [selected, selectedSource, timeline.clips, bedClips, tlClips]);
  // Unmounting the panel (dock ↔ fullscreen, or the timeline tab being left) must not strand a stale
  // selection in a mixer that outlives it — an inspector would keep offering to edit a clip nobody can see.
  useEffect(() => () => { selection.setSelection(null); }, []);
  // Infinite timeline: content width grows with the furthest content end AND the explored viewport
  // (pages bumped imperatively as the playhead/scroll approaches the right edge — never per frame).
  //
  // CANVAS EXTENT ONLY — how far the view scrolls, NOT where playback stops (that is `end`, below).
  // Audio counts here: a 5-minute bed clip on a 60 s timeline must be visible and editable, or you cannot
  // reach the thing you just dropped. It does NOT count toward `Length` (see `overrunAt`).
  const contentEnd = useMemo(
    () => Math.max(dur, timeline.outPoint ?? 0,
      ...timeline.clips.map(c => c.start + c.duration),
      ...tlClips.map(c => c.start + c.duration),
      ...bedClips.map(c => c.start + c.duration)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline.clips, dur, timeline.outPoint, tlClips, bedClips],
  );
  const viewEnd = Math.max(contentEnd, (pages + 1) * PAGE_SECS);
  const width = viewEnd * pxPerSec;
  // Distinct from contentEnd: this is where PLAYBACK stops (the readout's denominator), not how far
  // the canvas scrolls. A clip overrunning Length must still be visible/editable — contentEnd stays
  // for that; `end` must NOT be conflated with it.
  const end = useMemo(() => timelineEnd(timeline), [timeline.duration, timeline.inPoint, timeline.outPoint]);

  // CONTENT PAST THE END must not be silently unplayable. `Length` bounds playback (Wave A), and an audio
  // clip does NOT extend it (D8: Length stays purely authored) — so a clip beyond the document's reach is
  // authored content that will never be heard or seen. Say so on the ruler, and offer the one-click fix.
  //
  // ⚠ THE THRESHOLD IS *LENGTH*, NOT `timelineEnd` — AND MEASURING IT AGAINST `timelineEnd` MAKES THE
  // ONE-CLICK FIX DESTROY THE THING IT WARNS ABOUT. `timelineEnd` returns the OUT-POINT when a region is
  // set (types.ts), and setting an out-point to loop a section is a first-class shipped feature (the
  // `Set Out` button, the `O` key, the Loop button's own tooltip). So on a 60 s show with clips to 60 s,
  // one click of `Set Out` at 20 would instantly: paint a permanent warn-hatched band over 20→60 — the
  // operator's own loop region — and raise a badge reading "past the end", inviting them to clear a
  // defect that is not one. Clicking it wrote `outPoint: 60`, WIDENING THE LOOP THEY WERE WORKING IN,
  // silently and with no undo: THE SHOW THEN LOOPS THE WRONG SECTION. Content outside a deliberately
  // narrowed region is not past the end — it is outside the loop you are working in.
  //
  // So the threshold is how far this document can reach WITHOUT anyone touching Length:
  //   max(Length, timelineEnd) — the second term because an out-point BEYOND Length is a supported,
  //   honoured shape (see timelineStart's note: `in: 70, out: 90` over a Length of 60 is a real region),
  //   and content inside it is perfectly playable, so it must not raise a false alarm.
  // Both readers COERCE junk (NaN / "10" / null), so a hand-edited document cannot silently disable the
  // badge by making the comparison NaN.
  const lengthEnd = useMemo(
    () => Math.max(timelineDuration(timeline), timelineEnd(timeline)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline.duration, timeline.inPoint, timeline.outPoint],
  );
  const overrunAt = useMemo(() => {
    const far = Math.max(0,
      ...timeline.clips.map(c => c.start + c.duration),
      ...tlClips.map(c => c.start + c.duration),
      ...bedClips.map(c => c.start + c.duration));
    return far > lengthEnd + 1e-6 ? far : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline.clips, tlClips, bedClips, lengthEnd]);
  // RAISE `duration`, AND TOUCH NOTHING ELSE. The fix's own copy is "Length → X" and the overrun is
  // measured against Length, so Length is the only field it has any business writing. It must NOT move
  // the out-point: that is the user's authored playable region (a deliberate in 10 / out 40), and moving
  // it destroys the region with no signal and no undo — the exact failure the threshold above exists to
  // stop. Raising Length alone is also idempotent: it lifts the threshold past `far`, so the badge clears.
  const fixLength = () => {
    if (overrunAt == null) return;
    onChange({ ...timeline, duration: overrunAt });
  };

  // Live refs so stable (window-listener / engine-subscription / memoized-child) handlers see
  // current values without re-subscribing or breaking React.memo on clips/headers.
  const pxRef = useRef(pxPerSec); pxRef.current = pxPerSec;
  const viewEndRef = useRef(viewEnd); viewEndRef.current = viewEnd;
  const contentEndRef = useRef(contentEnd); contentEndRef.current = contentEnd;
  const endRef = useRef(end); endRef.current = end;
  const fpsRef = useRef(fps); fpsRef.current = fps;
  const snapRefEnabled = useRef(snapEnabled); snapRefEnabled.current = snapEnabled;
  const draftRef = useRef<VideoClip | null>(null); draftRef.current = draft;
  const regionDragRef = useRef<{ edge: 'in' | 'out'; t: number } | null>(null); regionDragRef.current = regionDrag;
  const timelineRef = useRef(timeline); timelineRef.current = timeline;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const audioDraftRef = useRef<{ clip: AudioClip; source: 'bed' | 'timeline' } | null>(null); audioDraftRef.current = audioDraft;
  const audioRef = useRef(audioProp); audioRef.current = audioProp;
  const hoverRef = useRef(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const snapGuideRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const bedTimeRef = useRef<HTMLSpanElement>(null);
  // Each drag carries the docKey it STARTED on (see docKey above) — the commit is refused across a rebind.
  const dragRef = useRef<{ mode: DragMode; clip: VideoClip; docKey: string; x0: number; points: ReturnType<typeof collectSnapPoints> } | null>(null);
  const audioDragRef = useRef<{ mode: AudioDragMode; clip: AudioClip; source: 'bed' | 'timeline'; docKey: string; x0: number; points: SnapPoint[] } | null>(null);
  // The window listeners of the two ref-held drags, torn down as a unit (pointerup AND pointercancel).
  const dragAbort = useRef<AbortController | null>(null);
  const audioDragAbort = useRef<AbortController | null>(null);

  // Render-free playhead + timecode (engine ticks every frame, even when paused). Also grows the
  // infinite content width by whole pages when the playhead nears the current right edge — quantized
  // so this never setStates per frame (only on page crossings).
  useEffect(() => engine.subscribe((ph) => {
    const px = pxRef.current;
    if (playheadRef.current) playheadRef.current.style.left = `${GUTTER + ph * px}px`;
    if (timeRef.current) timeRef.current.textContent = `${fmtTimecode(ph, fpsRef.current)} / ${fmtTimecode(endRef.current, fpsRef.current)}`;
    // The bed rides the SHOW clock, which diverged from this ruler the moment a scene was bound. Its lanes
    // are not drawn then (that would be a lie), so this readout is the only honest sign that it is still
    // running. Painted imperatively, like the playhead — invariant 3: neither ever enters React state.
    if (bedTimeRef.current) bedTimeRef.current.textContent = `♪ BED ${fmtClock(engine.getShowTime())}`;
    if (ph + PAGE_SECS > viewEndRef.current) setPages(p => Math.max(p, Math.ceil((ph + PAGE_SECS) / PAGE_SECS)));
  }), []);

  // --- automation lanes ---
  const lanes: AutoLane[] = timeline.automation ?? [];
  // Resolve each lane's target definition (label / range / units / log axis) from whichever provider
  // owns its path head. A lane whose target has vanished resolves to undefined and renders as such —
  // it is never dropped, because that would silently discard the user's work.
  const laneDefs = useMemo(() => {
    const defs = new Map<string, AutomationTargetDef>();
    for (const p of automationTargetRegistry.all()) {
      try { for (const d of p.enumerate()) defs.set(d.path, d); } catch { /* a provider in a bad state must not break the timeline */ }
    }
    return defs;
    // defsTick, not autoPlayhead: a stopped transport returns an identical playhead, so the memo would
    // never invalidate and a lane whose target was just deleted would keep rendering as if still bound.
  }, [timeline, defsTick]);

  // ⚠ EVERY LANE WRITE RESOLVES THE LANE **BY ID, OUT OF THE BOUND DOCUMENT**, AT COMMIT TIME.
  //
  // This used to be `setLanes(lanes.map((l, j) => (j === i ? next : l)))` — a WHOLE-ARRAY REPLACEMENT
  // built from the `lanes` array of the render that started the gesture, merged into whatever document is
  // bound when it ends. AutomationLane's keyframe drag commits from a `window` pointerup handler that is
  // removed only inside itself, so unmounting the lane does not even save it: drag a keyframe on the
  // global doc's `audio.master.gain` curve, let the state machine hop to scene S mid-drag, release —
  // and S's ENTIRE `automation` array was replaced by the global document's. S then carries a master-gain
  // curve authored for another timeline, an automation lane OWNS its path (lane ?? fade ?? authored), so
  // it drives the house volume; any automation S did have is destroyed. handleTimelineChange does not
  // recordHistory(), so THERE IS NO UNDO.
  //
  // By-id, against `timelineRef.current`, with a bail when the lane is not there, makes a cross-document
  // clobber structurally impossible — even if a future rebind path forgets AutomationLane's docKey guard.
  const patchLane = useCallback((laneId: string, next: AutoLane | null) => {
    const tl = timelineRef.current;
    const cur = tl.automation ?? [];
    if (!cur.some(l => l.id === laneId)) return;    // not a lane of the bound document → discard
    onChangeRef.current({
      ...tl,
      automation: next ? cur.map(l => (l.id === laneId ? next : l)) : cur.filter(l => l.id !== laneId),
    });
  }, []);
  const addLane = (d: AutomationTargetDef) => {
    setPickerAt(null);
    // Seed with ONE keyframe at the playhead holding the target's CURRENT authored value, so creating a
    // lane never changes the sound. A single-keyframe lane is a constant — safe, and it immediately takes
    // ownership of the path (the authoring slider goes read-only, visibly).
    const cur = automationTargetRegistry.get(d.path.split('.')[0])?.get(d.path) ?? d.def;
    const tl = timelineRef.current;                 // the BOUND document, never a captured array
    onChangeRef.current({
      ...tl,
      automation: [...(tl.automation ?? []), {
        id: `au-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        targetPath: d.path,
        enabled: true,
        keyframes: [{ t: Math.max(0, engine.getPlayhead()), v: cur, curve: 'linear' }],
      }],
    });
  };

  // The lanes show a live value readout at the playhead. The 60 Hz playhead above is deliberately
  // render-free (it writes styles directly), so sample it at ~10 Hz here rather than re-rendering the
  // whole timeline every frame.
  useEffect(() => {
    const iv = setInterval(() => setAutoPlayhead(engine.getPlayhead()), 100);
    const dv = setInterval(() => setDefsTick(t => t + 1), 1000); // re-enumerate targets (the bed can change)
    return () => { clearInterval(iv); clearInterval(dv); };
  }, []);

  // --- coordinate helpers (stable) ---
  const clientXToTime = useCallback((clientX: number) => {
    const el = scrollRef.current; if (!el) return 0;
    const r = el.getBoundingClientRect();
    const x = clientX - r.left + el.scrollLeft - GUTTER;
    return clamp(x / pxRef.current, 0, viewEndRef.current); // unbounded up to the explored view edge
  }, []);
  const seekTo = useCallback((clientX: number) => engine.seek(clientXToTime(clientX)), [clientXToTime]);
  // The scrub drag needs `pointercancel` MORE than the edit drags do, not less: its `move` SEEKS THE
  // RUNNING SHOW. A touch taken over as a pan on a kiosk never delivers `pointerup`, so the listener
  // stayed attached and every later mouse move — with no button held — scrubbed the transport.
  const startSeekDrag = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return; // left button only; middle is reserved for panning
    seekTo(e.clientX);
    const ac = new AbortController();
    window.addEventListener('pointermove', (ev: PointerEvent) => seekTo(ev.clientX), { signal: ac.signal });
    window.addEventListener('pointerup', () => ac.abort(), { signal: ac.signal });
    window.addEventListener('pointercancel', () => ac.abort(), { signal: ac.signal });
  }, [seekTo]);

  // --- mouse navigation: wheel = cursor-anchored zoom (Shift = horizontal scroll); middle-drag = pan ---
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey) { el.scrollLeft += e.deltaY; e.preventDefault(); return; }
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const screenX = e.clientX - r.left - GUTTER;            // px from the t=0 column, in viewport
      const tUnder = (screenX + el.scrollLeft) / pxRef.current; // time under the cursor
      const next = clamp(pxRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 5, 300);
      setPxPerSec(next);
      // Keep the time-under-cursor fixed on screen. Defer until the new (larger) width lays out so
      // scrollLeft isn't clamped to the old scrollWidth.
      requestAnimationFrame(() => { el.scrollLeft = tUnder * next - screenX; });
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 1) return; // middle button → pan both axes
      e.preventDefault();
      const x0 = e.clientX, y0 = e.clientY, sl0 = el.scrollLeft, st0 = el.scrollTop;
      const prevCursor = el.style.cursor; el.style.cursor = 'grabbing';
      const ac = new AbortController();
      const end = () => { el.style.cursor = prevCursor; ac.abort(); };
      window.addEventListener('pointermove', (ev: PointerEvent) => { el.scrollLeft = sl0 - (ev.clientX - x0); el.scrollTop = st0 - (ev.clientY - y0); }, { signal: ac.signal });
      window.addEventListener('pointerup', end, { signal: ac.signal });
      window.addEventListener('pointercancel', end, { signal: ac.signal });   // a cancelled pan must not leave the view glued to the cursor
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown);
    return () => { el.removeEventListener('wheel', onWheel); el.removeEventListener('pointerdown', onPointerDown); };
  }, []);

  const showGuide = useCallback((t: number | null) => {
    const g = snapGuideRef.current; if (!g) return;
    if (t == null) { g.style.display = 'none'; }
    else { g.style.display = 'block'; g.style.left = `${GUTTER + t * pxRef.current}px`; }
  }, []);

  // A REBIND KILLS EVERY IN-FLIGHT VISUAL DRAFT. The commits are already refused across a rebind (each
  // gesture carries the docKey it started on and abandons if it changed) — this is about what is on
  // SCREEN: the incoming scene's clips/tracks/lanes share their ids with the outgoing document's (Capture
  // Scene deep-clones), so a surviving draft would be painted over the INCOMING document's identically-
  // id'd clip. The operator would watch scene S's stinger slide under their cursor. Each drag's `move`
  // also refuses to re-arm the draft once the document has changed, so this fires once, not per frame.
  useEffect(() => {
    setDraft(null); setAudioDraft(null); setResizeDraft(null); setRegionDrag(null); setOrderDraft(null);
    showGuide(null);
  }, [docKey, showGuide]);

  // --- clip drag (move / trim) with snapping — stable handlers read from refs ---
  const onDragMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    if (d.docKey !== docKeyRef.current) return;   // rebound mid-drag — the gesture is dead; don't re-arm the draft
    const px = pxRef.current; const ds = (e.clientX - d.x0) / px; const c = d.clip;
    const thr = 8 / px; const en = snapRefEnabled.current; const pts = d.points;
    const srcCap = (c.sourceDuration ?? Infinity) - c.inPoint;
    if (d.mode === 'move') {
      const rawStart = Math.max(0, c.start + ds);
      let st = rawStart, guide: number | null = null;
      if (en) {
        let s = snap(rawStart, pts, thr);
        if (!s.snapped) { const e2 = snap(rawStart + c.duration, pts, thr); if (e2.snapped) s = { t: e2.t - c.duration, snapped: true, guideTime: e2.guideTime }; }
        if (s.snapped) { st = Math.max(0, s.t); guide = s.guideTime; }
      }
      setDraft({ ...c, start: st }); showGuide(guide);
    } else if (d.mode === 'r') {
      let dur = clamp(c.duration + ds, 0.1, srcCap); let guide: number | null = null;
      if (en) { const e2 = snap(c.start + dur, pts, thr); if (e2.snapped) { dur = clamp(e2.t - c.start, 0.1, srcCap); guide = e2.guideTime; } }
      setDraft({ ...c, duration: dur }); showGuide(guide);
    } else {
      let delta = clamp(ds, -c.inPoint, c.duration - 0.1); let guide: number | null = null;
      if (en) { const s = snap(c.start + delta, pts, thr); if (s.snapped) { delta = clamp(s.t - c.start, -c.inPoint, c.duration - 0.1); guide = s.guideTime; } }
      setDraft({ ...c, start: Math.max(0, c.start + delta), inPoint: Math.max(0, c.inPoint + delta), duration: c.duration - delta }); showGuide(guide);
    }
  }, [showGuide]);
  // THE ONE COMMIT — and it lands on the document the gesture STARTED on, or on NOTHING.
  //
  // `pointercancel` ABANDONS. It is not a completed gesture: on a touchscreen kiosk the browser fires it
  // when the scroll container takes the touch over as a pan, and `pointerup` then NEVER ARRIVES. Before
  // this, the window listeners and the draft both stayed live, so the clip kept following an UNPRESSED
  // cursor across the lane and the operator's next click anywhere committed it wherever the mouse had
  // wandered — into whatever document was bound by then. Discarding an unfinished gesture can only cost
  // an edit the user must redo; committing one writes a move nobody made.
  const endDrag = useCallback((commit: boolean) => {
    const d = dragRef.current, f = draftRef.current;
    dragRef.current = null;
    dragAbort.current?.abort(); dragAbort.current = null;
    setDraft(null); showGuide(null);
    if (!commit || !d || !f) return;
    if (d.docKey !== docKeyRef.current) return;   // a recall rebound the panel mid-drag → ABANDON
    onChangeRef.current({ ...timelineRef.current, clips: timelineRef.current.clips.map(c => c.id === f.id ? f : c) });
  }, [showGuide]);
  const onDragUp = useCallback(() => endDrag(true), [endDrag]);
  const onDragCancel = useCallback(() => endDrag(false), [endDrag]);
  const onStartDrag = useCallback((e: React.PointerEvent, clip: VideoClip, mode: DragMode) => {
    e.stopPropagation(); e.preventDefault();
    setSelected(clip.id); setSelectedSource('video');
    dragRef.current = { mode, clip: { ...clip }, docKey: docKeyRef.current, x0: e.clientX, points: collectSnapPoints(timelineRef.current, engine.getPlayhead(), clip.id) };
    dragAbort.current?.abort();
    const ac = new AbortController(); dragAbort.current = ac;
    window.addEventListener('pointermove', onDragMove, { signal: ac.signal });
    window.addEventListener('pointerup', onDragUp, { signal: ac.signal });
    window.addEventListener('pointercancel', onDragCancel, { signal: ac.signal });
  }, [onDragMove, onDragUp, onDragCancel]);

  // --- audio: TWO CONTAINERS, TWO COMMIT PATHS, TWO VERY DIFFERENT COSTS ---
  //   bed      → onChangeMix → App.setAudioMix → recompileAutomation() + the audio host fan-out.
  //   timeline → onChange(timeline) → App.handleTimelineChange → setScenes/setTimeline → engine.setData →
  //              clampPlayheadIntoDoc + warmMedia + pruneStaleLayers + compileAutomation + a
  //              structured-clone postMessage of the WHOLE doc to EVERY projector port.
  // Both are called EXACTLY ONCE, on pointerup. Never per pointermove. (Invariant 7.)
  const commitAudioClips = useCallback((source: 'bed' | 'timeline', clips: AudioClip[]) => {
    if (source === 'bed') {
      const a = audioRef.current; if (!a) return;
      a.onChangeMix({ ...a.mix, clips });
    } else {
      const t = timelineRef.current;
      onChangeRef.current({ ...t, audio: { tracks: timelineAudioTracks(t), clips } });
    }
  }, []);
  const audioClipsOf = useCallback((source: 'bed' | 'timeline'): AudioClip[] =>
    (source === 'bed' ? (audioRef.current?.mix.clips ?? []) : timelineAudioClips(timelineRef.current)), []);

  const onAudioDragMove = useCallback((e: PointerEvent) => {
    const d = audioDragRef.current; if (!d) return;
    if (d.docKey !== docKeyRef.current) return;   // rebound mid-drag — the gesture is dead; don't re-arm the draft
    const px = pxRef.current; const ds = (e.clientX - d.x0) / px; const c = d.clip;
    const thr = 8 / px; const en = snapRefEnabled.current; const pts = d.points;
    // THE RIGHT-TRIM CAP. Never `Infinity`: a clip with no `sourceDuration` (every bed clip authored
    // before this wave) would then have NO cap at all — drag its right edge from 30 s to 5 minutes and the
    // lane draws it happily, the driver's window test calls it "in window" for 4½ minutes of source that
    // does not exist, and the show HOLDS ON SILENCE. Ask the decode (`sourceDurationFor`); if the source
    // length is still unknown, the cap is the clip's CURRENT duration — you may shorten it, you may not
    // invent source you cannot prove exists.
    const srcLen = c.sourceDuration ?? sourceDurationFor(c.path);
    const srcCap = srcLen != null ? Math.max(0.1, srcLen - c.inPoint) : Math.max(0.1, c.duration);
    // A shorter clip cannot carry longer fades than it has room for — clamp them WITH it, or the driver
    // computes a ramp longer than the clip and hands the engine a gain that never reaches 1.
    const fitFades = (dur: number) => ({
      fadeIn: Math.min(c.fadeIn ?? 0, dur) || undefined,
      fadeOut: Math.min(c.fadeOut ?? 0, dur) || undefined,
    });
    if (d.mode === 'move') {
      const raw = Math.max(0, c.start + ds);
      let st = raw, guide: number | null = null;
      if (en) {
        let s = snap(raw, pts, thr);
        if (!s.snapped) { const e2 = snap(raw + c.duration, pts, thr); if (e2.snapped) s = { t: e2.t - c.duration, snapped: true, guideTime: e2.guideTime }; }
        if (s.snapped) { st = Math.max(0, s.t); guide = s.guideTime; }
      }
      setAudioDraft({ clip: { ...c, start: st }, source: d.source }); showGuide(guide);
    } else if (d.mode === 'r') {
      let dur = clamp(c.duration + ds, 0.1, srcCap); let guide: number | null = null;
      if (en) { const e2 = snap(c.start + dur, pts, thr); if (e2.snapped) { dur = clamp(e2.t - c.start, 0.1, srcCap); guide = e2.guideTime; } }
      setAudioDraft({ clip: { ...c, duration: dur, ...fitFades(dur) }, source: d.source }); showGuide(guide);
    } else if (d.mode === 'l') {
      // A TRUE SOURCE TRIM: start, inPoint AND duration move together (same as the video 'l' branch).
      let delta = clamp(ds, -c.inPoint, c.duration - 0.1); let guide: number | null = null;
      if (en) { const s = snap(c.start + delta, pts, thr); if (s.snapped) { delta = clamp(s.t - c.start, -c.inPoint, c.duration - 0.1); guide = s.guideTime; } }
      const dur = c.duration - delta;
      setAudioDraft({ clip: { ...c, start: Math.max(0, c.start + delta), inPoint: Math.max(0, c.inPoint + delta), duration: dur, ...fitFades(dur) }, source: d.source }); showGuide(guide);
    } else if (d.mode === 'fadeIn') {
      // D9. Fades do NOT snap: they are a gain envelope, not a time edit — snapping them to clip edges and
      // markers would make short fades impossible to author at any sane zoom.
      const fi = clamp((c.fadeIn ?? 0) + ds, 0, c.duration);
      setAudioDraft({ clip: { ...c, fadeIn: fi > 0 ? fi : undefined }, source: d.source }); showGuide(null);
    } else { // 'fadeOut' — drag LEFT to lengthen, hence the negated delta
      const fo = clamp((c.fadeOut ?? 0) - ds, 0, c.duration);
      setAudioDraft({ clip: { ...c, fadeOut: fo > 0 ? fo : undefined }, source: d.source }); showGuide(null);
    }
  }, [showGuide]);
  // THE ONE COMMIT. Outside any state updater (a commit inside setAudioDraft(d => …) would be a
  // render-phase update to App, which React 19 StrictMode double-invokes — see AutomationLane).
  //
  // AND IT LANDS ON THE DOCUMENT THE GESTURE STARTED ON, OR ON NOTHING. `audioClipsOf('timeline')` reads
  // `timelineRef.current` — WHATEVER IS BOUND RIGHT NOW. Drag a music clip on Global from 0:10 toward
  // 0:25, let the FSM's onTimelineEnd hop (or a tablet GO, or the scheduler) recall scene S mid-drag, and
  // the commit read S's clips — which, because Capture Scene deep-clones, hold a clip with the SAME ID.
  // The operator's global edit vanished and S's stinger silently moved 15 s late, persisted, over the
  // wrong beat, every night. `source === 'bed'` cannot rebind (the bed is one container, and its lanes
  // are only drawn while Global is bound), but the guard is uniform: one rule, no exception to get wrong.
  // `pointercancel` abandons — see endDrag.
  const endAudioDrag = useCallback((commit: boolean) => {
    const dr = audioDragRef.current, d = audioDraftRef.current;
    audioDragRef.current = null;
    audioDragAbort.current?.abort(); audioDragAbort.current = null;
    setAudioDraft(null); showGuide(null);
    if (!commit || !dr || !d) return;
    if (dr.docKey !== docKeyRef.current) return;                 // rebound mid-drag → ABANDON
    const clips = audioClipsOf(d.source);
    if (!clips.some(c => c.id === d.clip.id)) return;            // the clip is not in the bound container
    commitAudioClips(d.source, clips.map(c => (c.id === d.clip.id ? d.clip : c)));
  }, [showGuide, commitAudioClips, audioClipsOf]);
  const onAudioDragUp = useCallback(() => endAudioDrag(true), [endAudioDrag]);
  const onAudioDragCancel = useCallback(() => endAudioDrag(false), [endAudioDrag]);
  const onAudioStartDrag = useCallback((e: React.PointerEvent, clip: AudioClip, mode: AudioDragMode, source: 'bed' | 'timeline') => {
    if (e.button !== 0) return;            // middle-drag pans the timeline
    e.stopPropagation(); e.preventDefault();
    // Snap points are captured ONCE at pointerdown (same as the video drag). Audio clip edges come in via
    // the new `extra` parameter — collectSnapPoints is Timeline-typed and cannot see them. The clip being
    // dragged is EXCLUDED, or the first 8 px of every drag land back on the value you started from.
    const extra: SnapPoint[] = [...audioClipsOf('bed'), ...timelineAudioClips(timelineRef.current)]
      .filter(c => c.id !== clip.id)
      .flatMap(c => ([{ t: c.start, kind: 'clipEdge' as const }, { t: c.start + c.duration, kind: 'clipEdge' as const }]));
    audioDragRef.current = {
      mode, clip: { ...clip }, source, docKey: docKeyRef.current, x0: e.clientX,
      points: collectSnapPoints(timelineRef.current, engine.getPlayhead(), undefined, undefined, extra),
    };
    audioDragAbort.current?.abort();
    const ac = new AbortController(); audioDragAbort.current = ac;
    window.addEventListener('pointermove', onAudioDragMove, { signal: ac.signal });
    window.addEventListener('pointerup', onAudioDragUp, { signal: ac.signal });
    window.addEventListener('pointercancel', onAudioDragCancel, { signal: ac.signal });
  }, [onAudioDragMove, onAudioDragUp, onAudioDragCancel, audioClipsOf]);

  // Blade an audio clip. splitClipAt is structurally generic and copies EVERY field to both halves —
  // which is right for a source trim and wrong for a gain envelope: the left half would inherit the
  // fade-OUT (an audible dip at the cut) and the right half the fade-IN. Give each half only the fade
  // that still belongs to it, clamped to its own length.
  const onAudioBlade = useCallback((clip: AudioClip, clientX: number, source: 'bed' | 'timeline') => {
    const before = audioClipsOf(source);
    const after = splitClipAt(before, clip.id, clientXToTime(clientX));
    if (after.length === before.length) return;   // the cut fell outside the clip — no-op, and NO commit
    const i = after.findIndex(c => c.id === clip.id);          // splitClipAt keeps the left half's id
    if (i < 0 || i + 1 >= after.length) { commitAudioClips(source, after); return; }
    const left = after[i], right = after[i + 1];
    const next = after.slice();
    next[i] = { ...left, fadeIn: Math.min(left.fadeIn ?? 0, left.duration) || undefined, fadeOut: undefined };
    next[i + 1] = { ...right, fadeIn: undefined, fadeOut: Math.min(right.fadeOut ?? 0, right.duration) || undefined };
    commitAudioClips(source, next);
  }, [clientXToTime, commitAudioClips, audioClipsOf]);

  // BAIL IF THE ID IS NOT THERE — `liftDelete` is `Array.filter`, which ALWAYS returns a new array, so
  // without this a delete that removes nothing still fires a full commit.
  //
  // That is not hypothetical: a SELECTION OUTLIVES A DOCUMENT REBIND. Select an audio clip on the global
  // doc (selected = X, selectedSource = 'timeline'), recall a scene with its own timeline, press Delete →
  // liftDelete(timelineAudioClips(sceneTL), X) finds nothing, and the new array still rides
  // onChange(timeline) → setData → warmMedia + pruneStaleLayers + compileAutomation + a structured-clone
  // postMessage to every projector port, for a document that did not change. Invariant 7's entire cost,
  // paid on a no-op, ON THE BOUND DOCUMENT OF A RUNNING SHOW. The selection is still cleared (it named a
  // clip that is not in this document — that is precisely what makes it stale).
  const onAudioRemoveClip = useCallback((id: string, source: 'bed' | 'timeline') => {
    const before = audioClipsOf(source);
    if (before.some(c => c.id === id)) commitAudioClips(source, liftDelete(before, id));
    setSelected(s => (s === id ? null : s));
  }, [commitAudioClips, audioClipsOf]);

  // --- blade / delete (stable for memoized children) ---
  const onBlade = useCallback((clip: VideoClip, clientX: number) => {
    const t = clientXToTime(clientX);
    onChangeRef.current({ ...timelineRef.current, clips: splitClipAt(timelineRef.current.clips, clip.id, t) });
  }, [clientXToTime]);
  const onRemoveClip = useCallback((id: string) => {
    onChangeRef.current({ ...timelineRef.current, clips: liftDelete(timelineRef.current.clips, id) });
    setSelected(s => (s === id ? null : s));
  }, []);

  // --- track header ops (stable for memoized TrackHeader) ---
  const patchLayer = useCallback((id: string, patch: Partial<VideoLayer>) => {
    onChangeRef.current({ ...timelineRef.current, layers: timelineRef.current.layers.map(l => l.id === id ? { ...l, ...patch } : l) });
  }, []);
  const removeLayer = useCallback((id: string) => {
    const tl = timelineRef.current;
    onChangeRef.current({ ...tl, layers: tl.layers.filter(l => l.id !== id), clips: tl.clips.filter(c => c.layerId !== id) });
    setSelected(null);
  }, []);
  // DRAFT THE ORDER, COMMIT ONCE (invariant 7). This was the last drag in the file still writing the
  // document from INSIDE pointermove: dragging a track header from position 6 to position 1 fired SIX
  // full onChange → setData → clampPlayheadIntoDoc + warmMedia + pruneStaleLayers + compileAutomation +
  // a structured-clone postMessage to EVERY projector port, during the gesture, on the bound document of
  // a running show. Now the gesture moves a local list of ids and lands one commit on pointerup — on the
  // document it started on (docKey), or on nothing.
  const startReorder = useCallback((e: React.PointerEvent, index: number) => {
    e.stopPropagation(); e.preventDefault();
    const el = scrollRef.current; if (!el) return;
    const tl0 = timelineRef.current;
    const id = tl0.layers[index]?.id; if (!id) return;
    const doc = docKeyRef.current;
    let order = tl0.layers.map(l => l.id);
    setOrderDraft(order);
    const move = (ev: PointerEvent) => {
      if (doc !== docKeyRef.current) return;                  // rebound mid-drag — the gesture is dead
      // Heights come from the BOUND document, resolved by id — never from a stale captured array.
      const byId = new Map(timelineRef.current.layers.map(l => [l.id, l] as const));
      const rows = order.map(i => byId.get(i));
      if (rows.some(l => !l)) return;                       // rebound under the drag → freeze the preview
      const r = el.getBoundingClientRect();
      const y = ev.clientY - r.top + el.scrollTop - RULER_H;
      let target = 0, acc = 0;
      for (let i = 0; i < rows.length; i++) { const h = laneHeight(rows[i]!); if (y > acc + h / 2) target = i + 1; acc += h; }
      target = clamp(target, 0, rows.length - 1);
      const cur = order.indexOf(id);
      if (cur < 0 || target === cur) return;
      const next = order.slice(); const [m] = next.splice(cur, 1); next.splice(target, 0, m);
      order = next;
      setOrderDraft(next);                                  // DRAFT ONLY — no document write mid-gesture
    };
    const done = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      setOrderDraft(null);
      if (!commit || doc !== docKeyRef.current) return;     // cancelled, or rebound mid-drag → ABANDON
      const tl = timelineRef.current;
      const byId = new Map(tl.layers.map(l => [l.id, l] as const));
      const next = order.map(i => byId.get(i));
      // The layer set changed under the drag (a delete elsewhere): committing `order` would DROP a layer
      // and every clip on it. Abandon instead.
      if (next.length !== tl.layers.length || next.some(l => !l)) return;
      if (next.every((l, i) => l!.id === tl.layers[i].id)) return;   // nothing moved → no commit at all
      onChangeRef.current({ ...tl, layers: next as VideoLayer[] });
    };
    const up = () => done(true);
    const cancel = () => done(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }, []);
  const startResize = useCallback((e: React.PointerEvent, layer: VideoLayer) => {
    e.stopPropagation(); e.preventDefault();
    const h0 = laneHeight(layer); const y0 = e.clientY;
    const doc = docKeyRef.current;
    setResizeDraft({ id: layer.id, height: h0 });
    const move = (ev: PointerEvent) => {
      if (doc !== docKeyRef.current) return;                  // rebound mid-drag — the gesture is dead
      setResizeDraft({ id: layer.id, height: clamp(h0 + (ev.clientY - y0), MIN_LANE_H, MAX_LANE_H) });
    };
    const done = (commit: boolean, ev?: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      setResizeDraft(null);
      if (!commit || !ev || doc !== docKeyRef.current) return;   // cancelled, or rebound mid-drag → ABANDON
      const nh = clamp(h0 + (ev.clientY - y0), MIN_LANE_H, MAX_LANE_H);
      const tl = timelineRef.current;
      if (!tl.layers.some(l => l.id === layer.id)) return;       // the track is gone — no no-op fan-out
      onChangeRef.current({ ...tl, layers: tl.layers.map(l => l.id === layer.id ? { ...l, height: nh } : l) });
    };
    const up = (ev: PointerEvent) => done(true, ev);
    const cancel = () => done(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }, []);

  // --- non-stable mutations (toolbar / lane / ruler / keyboard) read fresh closure state ---
  const addLayer = () => onChange({ ...timeline, layers: [...layers, { id: crypto.randomUUID(), name: `Track ${layers.length + 1}`, enabled: true }] });

  // --- audio track ops. Discrete edits (one commit each) — the CONTINUOUS ones (gain fader, name field)
  // draft inside AudioLane and land here once, on release/blur. ---
  const patchAudioTrack = (source: 'bed' | 'timeline', id: string, patch: Partial<AudioTrack>) => {
    if (source === 'bed') {
      const a = audioRef.current; if (!a) return;
      // A MANUAL MOVE IS A TAKEOVER — the same rule the mixer's own faders follow (AudioBedPanel's
      // setTrackGain). This gutter is the SECOND authored writer of `audio.track.<id>.gain`, a fully
      // enumerated, fadeable target: without the release, a scene that faded this track to 0.2 keeps
      // shadowing it forever (the driver reads lane ?? sceneFade ?? authored), so the operator drags the
      // fader back to 1.0, the slider moves, the document says 1.0 — and the sound stays at 0.2, for the
      // rest of the session and across every project opened in it. Core cannot reach the plugin's fade map
      // directly; the provider contract is the sanctioned door.
      // (The 'timeline' arm below needs none of this: enumerate() offers only the BED, so no Timeline.audio
      // track can carry a fade. Track name/mute/solo are discrete — the fade grammar admits neither.)
      if (patch.gain !== undefined) automationTargetRegistry.get('audio')?.releaseFade?.(`audio.track.${id}.gain`);
      a.onChangeMix({ ...a.mix, tracks: a.mix.tracks.map(t => (t.id === id ? { ...t, ...patch } : t)) });
    } else {
      const t = timelineRef.current;
      onChangeRef.current({ ...t, audio: { tracks: timelineAudioTracks(t).map(x => (x.id === id ? { ...x, ...patch } : x)), clips: timelineAudioClips(t) } });
    }
  };
  const removeAudioTrack = (source: 'bed' | 'timeline', id: string) => {
    if (source === 'bed') {
      const a = audioRef.current; if (!a) return;
      a.onChangeMix({ ...a.mix, tracks: a.mix.tracks.filter(t => t.id !== id), clips: a.mix.clips.filter(c => c.trackId !== id) });
    } else {
      const t = timelineRef.current;
      onChangeRef.current({ ...t, audio: { tracks: timelineAudioTracks(t).filter(x => x.id !== id), clips: timelineAudioClips(t).filter(c => c.trackId !== id) } });
    }
  };
  const addAudioTrack = (source: 'bed' | 'timeline') => {
    const track: AudioTrack = { id: crypto.randomUUID(), name: `Audio ${(source === 'bed' ? bedTracks.length : tlTracks.length) + 1}`, gain: 1, mute: false };
    if (source === 'bed') {
      const a = audioRef.current; if (!a) return;
      a.onChangeMix({ ...a.mix, tracks: [...a.mix.tracks, track] });
    } else {
      const t = timelineRef.current;
      onChangeRef.current({ ...t, audio: { tracks: [...timelineAudioTracks(t), track], clips: timelineAudioClips(t) } });
    }
  };
  // Drop a library AUDIO asset onto an audio lane → a clip AT THE DROP X (not at the playhead: on a
  // show-clock container the playhead is not even the same clock). Today such a drop dies silently on a
  // video lane (onDropFile rejects everything that is not video/image).
  const onDropAudioAsset = (e: React.DragEvent, trackId: string, source: 'bed' | 'timeline') => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/artlux-asset');
    if (!raw) return;
    let asset: { type?: string; path?: string };
    try { asset = JSON.parse(raw); } catch { return; }
    if (asset.type !== 'audio' || !asset.path) return;
    const path = asset.path;
    const start = clientXToTime(e.clientX);
    const name = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? 'audio';
    // ⚠ `d === null` MEANS "THE PROBE DID NOT LEARN THE SOURCE'S LENGTH" — IT DOES NOT MEAN "THE SOURCE IS
    // 30 s LONG". So the fallback feeds `duration` (a layout choice: give the clip a body the user can
    // trim) and NOT `sourceDuration` (a factual claim ABOUT THE FILE, which gets SAVED INTO THE DOCUMENT).
    // Fabricating one from a failed probe would be the invariant-6 family: persist a value nobody
    // authored, and lie with it forever. `sourceDuration` is the right-trim cap (onAudioDragMove) and the
    // waveform's time base (AudioLane's Wave) — write 30 for a 6-minute file and the operator can NEVER
    // extend that clip past 30 s, in any session, while the native engine happily plays all six minutes,
    // and the wave is drawn against a source that does not exist. Leaving it ABSENT is what lets the
    // decode (`sourceDurationFor`) supply the truth later — which matters, because the commonest null
    // here is not an undecodable .aiff at all, it is the probe LOSING A RACE with a concurrent read of
    // the same path (ensureBlobUrl returns undefined while another caller is mid-read). That clip
    // recovers its cap the moment the peaks land; a fabricated 30 never would.
    // ⚠ `place` RUNS AFTER AN AWAIT — an IPC file read and a decode. The world moves under it.
    //
    // Appending unconditionally MINTS AN ORPHAN: a clip whose `trackId` names a track that no longer
    // exists in the container it lands in. No AudioLane draws it (every lane filters c.trackId === t.id),
    // but the driver PLAYS it — allClips() has no track filter, `audibleIn` reads `tracks.find(...)` →
    // undefined → `tr?.mute` falsy → AUDIBLE, and `effGain` falls through to `?? 1` → AT UNITY GAIN.
    // For a 'timeline' orphan the mixer's inspector is read-only and has no write path into
    // Timeline.audio at all: it is a permanent, unmutable sound in the show, fixable only by hand-editing
    // the project JSON. Two ordinary windows: drop a big wav on the wrong track and hit the gutter trash
    // before the probe lands; or have a scene recalled during the probe, so the clip is appended to the
    // NEWLY BOUND document, on a track id that document does not have.
    //
    // The mixer's own addClip already guards exactly this (AudioBedPanel: "the track may have been
    // deleted while the file was decoding — don't orphan an invisible-but-audible clip"). Core's drop did
    // not. Both doors are checked here: the document it was dropped on, then the track it was dropped on.
    const dropDocKey = docKeyRef.current;
    const place = (d: number | null) => {
      if (docKeyRef.current !== dropDocKey) return;                       // recalled mid-probe → drop it
      const tracks = source === 'bed' ? (audioRef.current?.mix.tracks ?? []) : timelineAudioTracks(timelineRef.current);
      if (!tracks.some(t => t.id === trackId)) return;                    // track deleted mid-probe → drop it
      const clip: AudioClip = { id: crypto.randomUUID(), trackId, name, path, start, duration: d ?? DEFAULT_AUDIO_DURATION, inPoint: 0, sourceDuration: d ?? undefined, gain: 1, mute: false };
      commitAudioClips(source, [...audioClipsOf(source), clip]);
      setSelected(clip.id); setSelectedSource(source);
      ensurePeaks(path);
    };
    // Core probes the duration with the browser; the native engine loads the file for playback itself
    // (the audio driver's syncLoaded). A source Chromium cannot decode (some .aiff) still gets a clip —
    // a default-length one the user can trim — rather than a drop that silently does nothing.
    void probeAudioDuration(path).then(d => place(d && d > 0 ? d : null));
  };
  // --- tracking takes: record the live blob feed, place takes on a special lane ---
  const hasTrackingLane = layers.some(l => l.kind === 'tracking');
  const addTrackingLane = () => { if (!hasTrackingLane) onChange({ ...timeline, layers: [...layers, { id: crypto.randomUUID(), name: 'Tracking', kind: 'tracking', color: '#7ed321', enabled: true }] }); };
  const startRecord = () => { if (!trackingRecorder.start()) console.warn('[timeline] cannot record now (a take is playing)'); };
  const stopRecord = async () => {
    const tk = trackingRecorder.stop();
    if (!tk) return;
    tk.name = `Take ${(timelineRef.current.trackingTakes?.length ?? 0) + 1}`;
    let path = await window.artlux?.saveTrackingTake?.(tk.id, trackingTake.serialize(tk));
    if (!path) return;
    // Copy-in policy: relocate the take into the project's assets/tracking when we have a folder.
    if (projectPath) {
      const entry = await window.artlux?.importAssetFile?.(projectPath, path, 'take', tk.name);
      if (entry?.path) path = entry.path;
    }
    trackingTake.putCache(path, tk); // so replay/sparkline don't re-read disk
    const ref = { id: tk.id, name: tk.name, path, duration: tk.duration, fps: tk.fps };
    const tl = timelineRef.current;
    onChangeRef.current({ ...tl, trackingTakes: [...(tl.trackingTakes ?? []), ref], layers: tl.layers.some(l => l.kind === 'tracking') ? tl.layers : [...tl.layers, { id: crypto.randomUUID(), name: 'Tracking', kind: 'tracking' as const, color: '#7ed321', enabled: true }] });
  };
  const removeTake = (id: string) => onChange({ ...timeline, trackingTakes: (timeline.trackingTakes ?? []).filter(t => t.id !== id) });
  const onZoom = (f: number) => setPxPerSec(p => clamp(p * f, 5, 300));
  const onZoomFit = () => { const el = scrollRef.current; const avail = (el ? el.clientWidth : 800) - GUTTER - 24; setPxPerSec(clamp(avail / Math.max(1, contentEnd), 5, 300)); };
  const toggleLoop = () => onChange({ ...timeline, loop: !timeline.loop });
  const toggleSm = () => onStateMachineChange({ ...sm, enabled: !sm.enabled });
  const setStateMachine = (next: StateMachine) => onStateMachineChange(next);
  const addMarker = () => onChange({ ...timeline, markers: [...(timeline.markers ?? []), { id: crypto.randomUUID(), time: engine.getPlayhead(), color: '#f5a623' }] });
  const setIn = () => { const t = engine.getPlayhead(); const out = timeline.outPoint != null && timeline.outPoint <= t ? null : timeline.outPoint ?? null; onChange({ ...timeline, inPoint: t, outPoint: out }); };
  const setOut = () => { const t = engine.getPlayhead(); const inp = timeline.inPoint != null && timeline.inPoint >= t ? null : timeline.inPoint ?? null; onChange({ ...timeline, inPoint: inp, outPoint: t }); };
  // Region handles (ruler drag). Snapped like everything else, and kept ordered: an in past the out
  // (or vice versa) would make timelineEnd() ignore the region — clamp instead of relying on that.
  // The loop region is now LIVE (the clock wraps over it), and onChange is not cheap here: it re-enters
  // App → setScenes/setTimeline → engine.setData → warmMedia/pruneStaleLayers/compileAutomation (see
  // services/timeline.ts setData). Committing that per pointermove would be brutal, so — same as
  // ClipBlock and AutomationLane — the drag holds a local draft (regionDrag) and commits ONCE on
  // pointerup. clientXToTime (not a fresh rect capture) is reused for the px→time conversion: it
  // already accounts for GUTTER and scrollLeft, and re-measures on every call, so it stays correct
  // even if the panel is scrolled mid-drag.
  // Snapping here EXCLUDES the handle being dragged (the equivalent of the clip drag's excludeClipId):
  // collectSnapPoints emits tl.inPoint/tl.outPoint, so without it the handle snapped to its OWN current
  // position — an 8-pixel dead zone in which it simply would not move, then jumped. It also honours the
  // toolbar's Snap toggle, which it never read.
  const regionCandidate = (edge: 'in' | 'out', raw: number) => {
    const tl = timelineRef.current;
    const s = snapRefEnabled.current
      ? snap(raw, collectSnapPoints(tl, engine.getPlayhead(), undefined, edge), 8 / pxRef.current).t
      : raw;
    if (edge === 'in') {
      const out = tl.outPoint;
      return clamp(s, 0, out != null ? out - 0.05 : Number.MAX_SAFE_INTEGER);
    }
    const inp = tl.inPoint ?? 0;
    return Math.max(s, inp + 0.05);
  };
  const startRegionDrag = (edge: 'in' | 'out') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // don't also scrub the playhead — the ruler root has onPointerDown={startSeekDrag}
    e.preventDefault();
    const doc = docKeyRef.current;
    const move = (ev: PointerEvent) => {
      if (doc !== docKeyRef.current) return;                  // rebound mid-drag — the gesture is dead
      setRegionDrag({ edge, t: regionCandidate(edge, clientXToTime(ev.clientX)) });
    };
    const done = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      const d = regionDragRef.current;
      setRegionDrag(null);
      // A loop region is LIVE (the clock wraps over it). Committing one across a rebind would write the
      // operator's in/out onto the INCOMING scene — silently narrowing what that scene plays, forever.
      if (!commit || !d || doc !== docKeyRef.current) return;
      onChangeRef.current(d.edge === 'in' ? { ...timelineRef.current, inPoint: d.t } : { ...timelineRef.current, outPoint: d.t });
    };
    const up = () => done(true);
    const cancel = () => done(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };
  const regionInPoint = regionDrag?.edge === 'in' ? regionDrag.t : (timeline.inPoint ?? null);
  const regionOutPoint = regionDrag?.edge === 'out' ? regionDrag.t : (timeline.outPoint ?? null);
  // The SHADED BAND on the ruler = the range the engine will actually play, drag-draft included. It used
  // to require BOTH points and so drew nothing for the single-point regions the engine honours perfectly
  // well (start = inPoint ?? 0, end = outPoint ?? Length) — one click of Set In puts you there. Asking
  // timelineStart/timelineEnd instead of the raw fields also means a degenerate in/out point, which those
  // two now ignore, doesn't paint a band over a region that does not exist.
  const draftTimeline = useMemo(
    () => ({ ...timeline, inPoint: regionInPoint, outPoint: regionOutPoint }),
    [timeline, regionInPoint, regionOutPoint],
  );
  const bandOn = hasTimelineRegion(draftTimeline);
  // Stop goes through the SAME TransportIntent funnel the FSM and OSC use, so App stays the single
  // writer of `playing`. (A 'stop' intent has existed since OSC landed; no UI ever emitted one.)
  const stop = () => engine.dispatchTransportIntent({ kind: 'stop' });
  // `selected` names an id in ONE OF THREE ARRAYS (the video clips, the bed's clips, this timeline's audio
  // clips), and this used to filter `timeline.clips` unconditionally. Selecting an audio clip and pressing
  // Delete would: leave the clip exactly where it is (liftDelete finds nothing to remove), CLEAR the
  // selection so it LOOKS like something happened, and still fire a full onChange — liftDelete always
  // returns a NEW array — driving setData → warmMedia + pruneStaleLayers + compileAutomation + a
  // structured-clone postMessage to every projector port, for a document that did not change. Invariant
  // 7's entire cost, paid for nothing, on a no-op.
  const deleteSelected = (ripple: boolean) => {
    if (!selected) return;
    // No ripple for audio: rippleDelete is layerId-bound and audio has no ripple in Wave B (operations.ts).
    if (selectedSource !== 'video') { onAudioRemoveClip(selected, selectedSource); return; }
    onChange({ ...timeline, clips: ripple ? rippleDelete(timeline.clips, selected) : liftDelete(timeline.clips, selected) });
    setSelected(null);
  };
  const bladeAtPlayhead = () => onChange({ ...timeline, clips: bladeAt(timeline.clips, engine.getPlayhead()) });

  // --- drop a video (or a recorded take) onto a lane → create a clip ---
  const onDropFile = (e: React.DragEvent, layerId: string) => {
    e.preventDefault();
    const tl = timelineRef.current;
    const layer = tl.layers.find(l => l.id === layerId);
    const takeId = e.dataTransfer.getData('application/artlux-take');
    // Tracking lane: only accepts take chips from the bin (no video files).
    if (layer?.kind === 'tracking') {
      if (!takeId) return;
      const ref = (tl.trackingTakes ?? []).find(t => t.id === takeId);
      if (!ref) return;
      const start = clientXToTime(e.clientX);
      onChangeRef.current({ ...tl, clips: [...tl.clips, { id: crypto.randomUUID(), layerId, name: ref.name, path: ref.path, kind: 'tracking', takeId: ref.id, start, duration: ref.duration, inPoint: 0, sourceDuration: ref.duration }] });
      return;
    }
    if (takeId) return; // a take can't go on a video lane
    // A library asset dragged from the Media panel (video only on a video lane).
    const assetRaw = e.dataTransfer.getData('application/artlux-asset');
    if (assetRaw) {
      let asset: { type: string; path: string }; try { asset = JSON.parse(assetRaw); } catch { return; }
      const start = clientXToTime(e.clientX);
      const name = asset.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? 'clip';
      // Images have no intrinsic duration → place a default-length IMAGE content clip.
      if (asset.type === 'image') {
        onChangeRef.current({ ...timelineRef.current, clips: [...timelineRef.current.clips, { id: crypto.randomUUID(), layerId, name, content: { type: SourceType.IMAGE, url: asset.path }, path: asset.path, start, duration: DEFAULT_CONTENT_DURATION, inPoint: 0 }] });
        return;
      }
      // Audio goes on an AUDIO lane (AudioLane's own onDrop → onDropAudioAsset); a video lane genuinely
      // cannot hold it, and a take was already rejected above.
      if (asset.type !== 'video') return;
      const addClip = (d: number) => onChangeRef.current({ ...timelineRef.current, clips: [...timelineRef.current.clips, { id: crypto.randomUUID(), layerId, name, path: asset.path, start, duration: d, inPoint: 0, sourceDuration: d }] });
      void (async () => {
        const url = await ensureBlobUrl(asset.path, mimeForPath(asset.path));
        if (!url) { addClip(5); return; }
        const probe = document.createElement('video'); probe.preload = 'metadata';
        probe.onloadedmetadata = () => addClip(probe.duration && isFinite(probe.duration) ? probe.duration : 5);
        probe.onerror = () => addClip(5);
        probe.src = url;
      })();
      return;
    }
    const file = Array.from(e.dataTransfer.files).find(f =>
      f.type.startsWith('video') || /\.(mp4|webm|mov|mkv)$/i.test(f.name) ||
      f.type.startsWith('image') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name));
    if (!file) return;
    const srcPath = window.artlux?.getPathForFile?.(file);
    if (!srcPath) return;
    const start = clientXToTime(e.clientX);
    const name = file.name.replace(/\.[^.]+$/, '');
    const isImage = file.type.startsWith('image') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name);
    void (async () => {
      // Drop = import + place: copy the file into the project's assets/ and register a library entry,
      // so it shows in the Media tab (same as an explicit import). Without a project folder, reference
      // the file in place — there's nowhere to collect it and no library to add it to.
      let path = srcPath;
      if (projectPath) {
        const entry = await window.artlux?.importAssetFile?.(projectPath, srcPath, isImage ? 'image' : 'video', name);
        if (entry) { path = entry.path; onRegisterAsset?.(entry); }
      }
      // Images have no intrinsic duration → place a default-length IMAGE content clip.
      if (isImage) {
        onChangeRef.current({ ...timelineRef.current, clips: [...timelineRef.current.clips, { id: crypto.randomUUID(), layerId, name, content: { type: SourceType.IMAGE, url: path }, path, start, duration: DEFAULT_CONTENT_DURATION, inPoint: 0 }] });
        return;
      }
      // Video: probe duration from the dropped File in memory (independent of where we stored it).
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      const place = (d: number) => { URL.revokeObjectURL(url); onChangeRef.current({ ...timelineRef.current, clips: [...timelineRef.current.clips, { id: crypto.randomUUID(), layerId, name, path, start, duration: d, inPoint: 0, sourceDuration: d }] }); };
      v.onloadedmetadata = () => place(v.duration && isFinite(v.duration) ? v.duration : 5);
      v.onerror = () => place(5);
      v.src = url;
    })();
  };

  // --- generalized content clips (any surface source type scheduled on a layer) ---
  const CONTENT_LABELS: Record<string, string> = {
    CAMERA: 'Camera', VIDEO: 'Video', IMAGE: 'Image', DMX_IN: 'DMX In', SPOUT: 'Spout',
    NDI: 'NDI', EFFECT: 'Effect', TRACKING: 'Tracking', LAYER: 'Layer', NONE: 'Empty',
  };
  const contentLabel = (c: SurfaceContent): string => CONTENT_LABELS[c.type] ?? c.type;
  const DEFAULT_CONTENT_DURATION = 5;
  // Right-click an empty lane → source-picker popover anchored at the cursor.
  const [contentMenu, setContentMenu] = useState<{ layerId: string; start: number; x: number; y: number } | null>(null);
  const openContentMenu = (e: React.MouseEvent, layerId: string) => {
    const layer = timelineRef.current.layers.find(l => l.id === layerId);
    if (!layer || layer.kind === 'tracking' || layer.locked) return; // tracking lanes take recorded takes only
    e.preventDefault();
    setContentMenu({ layerId, start: Math.max(0, clientXToTime(e.clientX)), x: e.clientX, y: e.clientY });
  };
  const createContentClip = (layerId: string, start: number, content: SurfaceContent) => {
    const clip: VideoClip = {
      id: crypto.randomUUID(), layerId, name: contentLabel(content), content,
      path: content.url ?? '', start: Math.max(0, start), duration: DEFAULT_CONTENT_DURATION, inPoint: 0,
    };
    onChangeRef.current({ ...timelineRef.current, clips: [...timelineRef.current.clips, clip] });
    setSelected(clip.id); setSelectedSource('video');
    setContentMenu(null);
  };
  // Edit the selected content clip's source config from the clip inspector.
  const patchClipContent = (id: string, patch: Partial<SurfaceContent>) => onChangeRef.current({
    ...timelineRef.current,
    clips: timelineRef.current.clips.map(c => c.id === id
      ? { ...c, content: { ...(c.content ?? { type: SourceType.NONE }), ...patch }, ...(patch.url !== undefined ? { path: patch.url ?? '' } : {}) }
      : c),
  });
  const changeClipContentType = (id: string, type: SurfaceContent['type']) => onChangeRef.current({
    ...timelineRef.current,
    clips: timelineRef.current.clips.map(c => c.id === id ? { ...c, content: { type }, name: contentLabel({ type }), path: '' } : c),
  });

  // Badge clips that contend for a single-instance live receiver (Spout/NDI) with a different sender
  // while overlapping in time — the last one under the playhead wins (see contentSource reconcilers).
  const conflictIds = useMemo(() => {
    const ids = new Set<string>();
    const live = timeline.clips.filter(c => c.content && (c.content.type === SourceType.SPOUT || c.content.type === SourceType.NDI));
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (a.content!.type !== b.content!.type) continue;
      if (!(a.start < b.start + b.duration && b.start < a.start + a.duration)) continue; // no time overlap
      const an = a.content!.type === SourceType.SPOUT ? a.content!.spoutName : a.content!.ndiName;
      const bn = b.content!.type === SourceType.SPOUT ? b.content!.spoutName : b.content!.ndiName;
      if ((an ?? '') !== (bn ?? '')) { ids.add(a.id); ids.add(b.id); }
    }
    return ids;
  }, [timeline.clips]);
  const selectedClip = useMemo(() => timeline.clips.find(c => c.id === selected) ?? null, [timeline.clips, selected]);

  // --- keyboard shortcuts (scoped to panel hover/focus) ---
  useTimelineKeys({
    togglePlay: onTogglePlay,
    play: () => { if (!playing) onTogglePlay(); },
    pause: () => { if (playing) onTogglePlay(); },
    setSelectTool: () => setTool('select'),
    setBladeTool: () => setTool('blade'),
    bladeAtPlayhead,
    toggleSnap: () => setSnapEnabled(v => !v),
    addMarker, setIn, setOut,
    deleteSelected,
    zoom: onZoom,
    seekHome: () => engine.seek(0),
    seekEnd: () => engine.seek(contentEnd),
    toggleMax: () => onToggleMax?.(),
    toggleLoop,
  }, () => !!panelRef.current && (hoverRef.current || panelRef.current.contains(document.activeElement)));

  const laneHeightOf = (l: VideoLayer) => (resizeDraft && resizeDraft.id === l.id ? resizeDraft.height : laneHeight(l));

  const authoring = !!author?.activeSceneId;
  // "Empty" means nothing on the canvas at all — no tracks, no clips, no automation lanes AND no audio
  // lanes. Counting clips alone left the hint card sitting over a timeline full of audio curves.
  const isEmpty = layers.length === 0 && timeline.clips.length === 0 && (timeline.automation?.length ?? 0) === 0
    && tlTracks.length === 0 && bedTracks.length === 0;
  return (
    <div ref={panelRef} tabIndex={0} onMouseEnter={() => { hoverRef.current = true; }} onMouseLeave={() => { hoverRef.current = false; }}
      className="relative h-full flex flex-col bg-surface-0 text-fg-1 text-xs select-none outline-none"
      style={{ borderTop: authoring ? `2px solid ${author!.activeAccent}` : undefined }}>
      {author && (
        <div className="shrink-0 flex items-center gap-2 px-3 h-8 border-b border-line-1 bg-surface-1 relative">
          {/* Scene/state selector pill — the always-visible "which timeline am I editing" indicator. */}
          <button onClick={() => setPillOpen(o => !o)} title="Choose which timeline to edit"
            className="flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-sm bg-surface-2 border border-line-1 hover:bg-surface-3 text-mini">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: author.activeAccent }} />
            <span className="text-fg-3">Editing:</span>
            <span className="text-fg-1 font-medium max-w-[160px] truncate">{author.activeName}</span>
            <ChevronDown size={12} className="text-fg-3" />
          </button>
          {authoring
            ? <span className="text-micro text-fg-3">its own timeline · {timeline.clips.length} clip{timeline.clips.length === 1 ? '' : 's'}</span>
            : <span className="text-micro text-fg-3">shared default — used by states without their own</span>}

          {/* Author strip — the trigger→build→save→continue loop (only while authoring a state). */}
          {authoring && (
            <div className="ml-auto flex items-center gap-1.5">
              <button onClick={author.onPrev} title="Previous state" className="p-1 rounded text-fg-2 hover:text-fg-1 hover:bg-surface-2"><ChevronLeft size={14} /></button>
              <span className="text-micro text-fg-3 tabular-nums">State {author.index + 1} of {author.total}</span>
              <button onClick={author.onSave} title="Save to State (re-capture look)"
                className="flex items-center gap-1 px-2 py-1 rounded-sm bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-mini"><Save size={12} /> Save</button>
              <button onClick={author.onNext} title="Next state" className="p-1 rounded text-fg-2 hover:text-fg-1 hover:bg-surface-2"><ChevronRight size={14} /></button>
            </div>
          )}

          {pillOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setPillOpen(false)} />
              <div className="absolute z-50 top-full left-3 mt-1 w-64 bg-surface-1 border border-line-1 rounded-md p-1 shadow-e2 max-h-80 overflow-auto">
                {/* Picking a scene here is NOT a quiet rebind: onSelect → enterAuthor → handleRecallScene,
                    which recalls the look, starts the fade and restarts the transport. Say so. */}
                <div className="px-2 pt-1 pb-1.5 text-micro text-fg-3 border-b border-line-1 mb-1">
                  Selecting a scene <span className="text-fg-2">recalls it live</span> — its look, its fade and its timeline.
                </div>
                <button onClick={() => { author.onSelect(null); setPillOpen(false); }}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-mini text-left hover:bg-surface-2 ${!author.activeSceneId ? 'bg-surface-2' : ''}`}>
                  <span className="inline-block w-2.5 h-2.5 rounded-full border border-line-2" />
                  <span className="flex-1 text-fg-1">Global timeline</span>
                  <span className="text-micro text-fg-3">shared</span>
                </button>
                <div className="h-px bg-line-1 my-1" />
                {author.scenes.map(s => (
                  <button key={s.id} onClick={() => { author.onSelect(s.id); setPillOpen(false); }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-mini text-left hover:bg-surface-2 ${author.activeSceneId === s.id ? 'bg-surface-2' : ''}`}>
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: s.accent ?? '#8b94a3' }} />
                    <span className="flex-1 text-fg-1 truncate">{s.name}</span>
                    {s.hasTimeline && <Film size={11} className="text-fg-3 shrink-0" />}
                    {/* A scene with no timeline of its own silently plays the GLOBAL one (swapTimelineForScene) —
                        a genuinely surprising rule that appeared nowhere in the UI. */}
                    <span className="ml-auto text-micro text-fg-3 shrink-0">
                      {s.hasTimeline ? `${s.clipCount ?? 0} clip${(s.clipCount ?? 0) === 1 ? '' : 's'}` : 'plays global'}
                    </span>
                  </button>
                ))}
                <div className="h-px bg-line-1 my-1" />
                <button onClick={() => { author.onNew(); setPillOpen(false); }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-mini text-left text-fg-1 hover:bg-surface-2"><Plus size={12} /> New state…</button>
              </div>
            </>
          )}
        </div>
      )}
      <TimelineToolbar
        playing={playing} onTogglePlay={onTogglePlay} onStop={stop} timeRef={timeRef}
        // The bed's readout is only shown when its lanes are NOT drawn — i.e. while a scene is bound and
        // the show clock has diverged from this ruler.
        bedTimeRef={authoring ? bedTimeRef : undefined}
        overrun={overrunAt != null ? { at: overrunAt, length: lengthEnd, onFix: fixLength } : undefined}
        // Which document the number fields are editing. It must change on EVERY rebind — including one
        // where the incoming scene's Length/fps happen to EQUAL the outgoing doc's, which is the normal
        // case (Capture Scene clones the timeline, and fps is 30 nearly everywhere). See NumField.
        docKey={docKey}
        duration={dur} onChangeDuration={(d) => onChange({ ...timeline, duration: d })}
        fps={fps} onChangeFps={(f) => onChange({ ...timeline, fps: f })}
        tool={tool} onSetTool={setTool}
        snapEnabled={snapEnabled} onToggleSnap={() => setSnapEnabled(v => !v)}
        onAddMarker={addMarker} onSetIn={setIn} onSetOut={setOut}
        // EITHER point alone is a region — the engine honours it. Requiring both made the Loop tooltip
        // lie ("loops the whole timeline") when only an in-point was set.
        hasRegion={hasTimelineRegion(timeline)}
        onZoom={onZoom} onZoomFit={onZoomFit} onAddTrack={addLayer}
        loop={!!timeline.loop} onToggleLoop={toggleLoop}
        smEnabled={sm.enabled} onToggleSm={toggleSm} onEditLogic={() => setSmEditorOpen(true)}
        maximized={maximized} onToggleMax={() => onToggleMax?.()}
      />

      <TakesBin
        takes={timeline.trackingTakes ?? []} hasTrackingLane={hasTrackingLane}
        onStartRecord={startRecord} onStopRecord={stopRecord}
        onAddTrackingLane={addTrackingLane} onRemoveTake={removeTake}
      />

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto relative">
        <div className="relative" style={{ width: GUTTER + Math.max(width, 100) }}>
          {/* header row: timecode ruler (sticky top), corner cell (sticky left) */}
          <div className="flex sticky top-0 z-30">
            <div className="sticky left-0 z-40 shrink-0 bg-surface-1 border-b border-r border-line-1 flex items-center px-2 text-micro text-fg-3" style={{ width: GUTTER, height: RULER_H }}>Tracks</div>
            <TimelineRuler
              pxPerSec={pxPerSec} width={Math.max(width, 100)} height={RULER_H} fps={fps}
              markers={timeline.markers ?? []} inPoint={regionInPoint} outPoint={regionOutPoint}
              bandStart={bandOn ? timelineStart(draftTimeline) : null}
              bandEnd={bandOn ? timelineEnd(draftTimeline) : null}
              overrunFrom={overrunAt != null ? lengthEnd : null} overrunTo={overrunAt}
              onSeekDown={startSeekDrag}
              onMarkerSeek={(t) => engine.seek(t)}
              onMarkerDelete={(id) => onChange({ ...timeline, markers: (timeline.markers ?? []).filter(m => m.id !== id) })}
              onMarkerNote={(id, note) => onChange({ ...timeline, markers: (timeline.markers ?? []).map(m => m.id === id ? { ...m, note } : m) })}
              onMoveInDown={startRegionDrag('in')}
              onMoveOutDown={startRegionDrag('out')}
            />
          </div>

          {/* always-present state-machine control lane */}
          <StateLane sm={sm} pxPerSec={pxPerSec} width={Math.max(width, 100)}
            onTrigger={(id) => engine.triggerSmTransition(id)} onEdit={() => setSmEditorOpen(true)} onToggle={toggleSm} />

          {layers.length === 0 && (
            <div className="flex">
              <div className="sticky left-0 z-20 shrink-0 bg-surface-1 border-r border-line-1" style={{ width: GUTTER, height: LANE_H }} />
              <div className="text-fg-3 italic px-3 py-2 text-mini">Add a track, then drop a video onto its lane →</div>
            </div>
          )}

          {layers.map((l, i) => {
            const h = laneHeightOf(l);
            const laneClips = timeline.clips.filter(c => c.layerId === l.id).map(c => (draft && draft.id === c.id ? draft : c));
            return (
              <div key={l.id} className="flex">
                <div className="sticky left-0 z-20 shrink-0" style={{ width: GUTTER }}>
                  <TrackHeader layer={l} index={i} height={h} onPatch={patchLayer} onRemove={removeLayer} onStartReorder={startReorder} onStartResize={startResize} />
                </div>
                <Lane
                  layer={l} clips={laneClips} selectedId={selected} tool={tool} pxPerSec={pxPerSec}
                  width={Math.max(width, 100)} laneH={h} conflictIds={conflictIds}
                  onSeek={seekTo} onDropFile={onDropFile} onAddContent={openContentMenu} onStartDrag={onStartDrag} onBlade={onBlade} onRemoveClip={onRemoveClip}
                />
              </div>
            );
          })}

          {/* AUDIO LANES. The bed's tracks are drawn ONLY while Global is bound (App passes `audio`
              undefined otherwise): there, show clock ≡ playhead, so the ruler is honest. Inside a scene
              the two clocks diverge and drawing the bed against a scene-relative ruler would be a lie —
              the `♪ BED` readout in the author strip carries it instead. */}
          {audioProp && bedTracks.map(t => (
            <AudioLane key={`bed-${t.id}`} track={t} source="bed" docKey={docKey}
              clips={bedClips.filter(c => c.trackId === t.id).map(c => (audioDraft?.source === 'bed' && audioDraft.clip.id === c.id ? audioDraft.clip : c))}
              selectedId={selectedSource === 'bed' ? selected : null} tool={tool} pxPerSec={pxPerSec} width={Math.max(width, 100)}
              onPatchTrack={(p) => patchAudioTrack('bed', t.id, p)} onRemoveTrack={() => removeAudioTrack('bed', t.id)}
              onStartDrag={onAudioStartDrag} onBlade={onAudioBlade} onRemoveClip={onAudioRemoveClip}
              onSelect={(id, src) => { setSelected(id); setSelectedSource(src); }} onSeek={seekTo} onDropAsset={onDropAudioAsset} />
          ))}
          {/* ⚠ THE KEY IS THE TRACK ID, AND A CLONED SCENE'S TRACK CARRIES THE SAME ONE (Capture Scene
              deep-clones) — so a rebind RECONCILES TO THE SAME COMPONENT INSTANCE and its gutter drafts
              (gain, name) survive it. `docKey` is what tells the lane to throw them away. See AudioLane. */}
          {tlTracks.map(t => (
            <AudioLane key={`tl-${t.id}`} track={t} source="timeline" docKey={docKey}
              clips={tlClips.filter(c => c.trackId === t.id).map(c => (audioDraft?.source === 'timeline' && audioDraft.clip.id === c.id ? audioDraft.clip : c))}
              selectedId={selectedSource === 'timeline' ? selected : null} tool={tool} pxPerSec={pxPerSec} width={Math.max(width, 100)}
              onPatchTrack={(p) => patchAudioTrack('timeline', t.id, p)} onRemoveTrack={() => removeAudioTrack('timeline', t.id)}
              onStartDrag={onAudioStartDrag} onBlade={onAudioBlade} onRemoveClip={onAudioRemoveClip}
              onSelect={(id, src) => { setSelected(id); setSelectedSource(src); }} onSeek={seekTo} onDropAsset={onDropAudioAsset} />
          ))}

          {/* Automation lanes — keyframe curves over the same time axis. Like StateLane they are not
              VideoLayers (they hold keyframes, not clips), so they mount here rather than in layers.map. */}
          {lanes.map((lane) => (
            <AutomationLane
              key={lane.id}
              lane={lane}
              def={laneDefs.get(lane.targetPath)}
              pxPerSec={pxPerSec}
              width={Math.max(width, 100)}
              playhead={autoPlayhead}
              docKey={docKey}
              onSnap={(t) => snap(t, collectSnapPoints(timelineRef.current, engine.getPlayhead()), 8 / pxRef.current).t}
              onSeek={seekTo}
              onChange={(next) => patchLane(lane.id, next)}
              onRemove={() => patchLane(lane.id, null)}
            />
          ))}

          {/* add an automation lane / an audio lane */}
          <div className="flex border-b border-line-1">
            <div className="sticky left-0 z-20 shrink-0 bg-surface-1 border-r border-line-1 flex items-center gap-2 px-2 relative" style={{ width: GUTTER, height: 26 }}>
              <button onClick={(e) => { const r = (e.target as HTMLElement).getBoundingClientRect(); setPickerAt({ x: r.left, y: r.bottom }); }}
                className="text-micro text-fg-3 hover:text-fg-1 inline-flex items-center gap-1">
                <Plus size={11} /> Automation
              </button>
              <button onClick={() => addAudioTrack('timeline')} title="Add an audio track to THIS timeline (rides the playhead; restarts when the timeline does)"
                className="text-micro text-fg-3 hover:text-fg-1 inline-flex items-center gap-1"><Plus size={11} /> Audio</button>
              {audioProp && (
                <button onClick={() => addAudioTrack('bed')} title="Add a BED track (rides the show clock; it does NOT restart on a scene recall)"
                  className="text-micro text-fg-3 hover:text-fg-1 inline-flex items-center gap-1"><Plus size={11} /> Bed</button>
              )}
              {pickerAt && (
                <AutomationTargetPicker
                  taken={new Set(lanes.map(l => l.targetPath))}
                  anchor={pickerAt}
                  onPick={addLane}
                  onClose={() => setPickerAt(null)}
                />
              )}
            </div>
            <div style={{ width: Math.max(width, 100), height: 26 }} />
          </div>

          {/* snap guide + playhead overlay (content coords; scroll with the tracks) */}
          <div ref={snapGuideRef} className="absolute w-px bg-accent z-10 pointer-events-none" style={{ left: GUTTER, top: RULER_H, bottom: 0, display: 'none' }} />
          <div ref={playheadRef} className="absolute w-px bg-sel-fixture z-10 pointer-events-none" style={{ left: GUTTER, top: RULER_H, bottom: 0 }}>
            <div className="absolute top-0 -left-[3px] w-[7px] h-[7px] bg-sel-fixture rotate-45" />
          </div>
        </div>

        {/* Empty-timeline hint. STRICTLY pointer-events-none, all the way down: this used to be a
            pointer-events-auto card with no onDrop, sitting dead-centre over the lane area — so the
            card that said "drag a video onto a lane" physically SWALLOWED the drop inside its own
            rectangle, and ate click-to-seek with it.
            The condition counts LANES, not just clips: a timeline holding tracks and automation
            curves (the audio case) is plainly not empty, but `clips.length === 0` said it was and
            kept the card up forever. */}
        {author && isEmpty && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0" style={{ paddingLeft: GUTTER }}>
            <div className="text-center px-6 py-4 rounded-lg border border-dashed border-line-2 bg-surface-1/50">
              <Film size={20} className="mx-auto text-fg-3 mb-1.5" />
              <div className="text-fg-2 text-mini">
                {layers.length === 0
                  ? <>Add a track, then drag media onto its lane{authoring ? <> to build “{author!.activeName}”</> : null}.</>
                  : <>Drag video, images or effects onto a lane{authoring ? <> to build “{author!.activeName}”</> : null}.</>}
              </div>
            </div>
          </div>
        )}
      </div>

      {smEditorOpen && (
        <StateGraphEditor sm={sm} markers={timeline.markers ?? []} layers={layers}
          scenes={author ? author.scenes.map(s => ({ id: s.id, name: s.name, hasTimeline: s.hasTimeline, clipCount: s.clipCount })) : scenes}
          cues={cues}
          onChange={setStateMachine} onClose={() => setSmEditorOpen(false)}
          onEditTimeline={author ? author.onSelect : undefined} />
      )}

      {/* Right-click an empty lane → source-type picker → places a default-length content clip. */}
      {contentMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setContentMenu(null)} onContextMenu={(e) => { e.preventDefault(); setContentMenu(null); }} />
          <div className="fixed z-50 w-56 bg-surface-1 border border-line-1 rounded-md p-2 shadow-e2"
            style={{ left: Math.min(contentMenu.x, window.innerWidth - 236), top: Math.min(contentMenu.y, window.innerHeight - 200) }}>
            <div className="text-micro font-bold uppercase tracking-wider text-fg-3 mb-1.5 px-0.5">Add clip</div>
            <ContentEditor
              content={{ type: SourceType.NONE }}
              layers={layers}
              showLayerOption={false}
              onTypeChange={(type) => { if (type !== SourceType.NONE) createContentClip(contentMenu.layerId, contentMenu.start, { type }); }}
              onChange={(patch) => { if (patch.type && patch.url !== undefined) createContentClip(contentMenu.layerId, contentMenu.start, { type: patch.type, url: patch.url }); }}
            />
          </div>
        </>
      )}

      {/* Inspector for a selected generalized-content clip (reuses the surface content editor). */}
      {selectedClip && isContentClip(selectedClip) && (
        <div className="absolute top-2 right-2 z-30 w-60 bg-surface-1/95 backdrop-blur-sm border border-line-1 rounded-md p-2.5 shadow-e2 space-y-2"
          onPointerDown={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between">
            <span className="text-micro font-bold uppercase tracking-wider text-fg-3 truncate">{selectedClip.name}</span>
            <button onClick={() => setSelected(null)} className="text-fg-3 hover:text-fg-1" title="Close"><X size={12} /></button>
          </div>
          <ContentEditor
            content={selectedClip.content!}
            layers={layers}
            showLayerOption={false}
            onChange={(patch) => patchClipContent(selectedClip.id, patch)}
            onTypeChange={(type) => changeClipContentType(selectedClip.id, type)}
          />
        </div>
      )}
    </div>
  );
};
