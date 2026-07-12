import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, ChevronDown, Film, Plus, Save, ChevronLeft, ChevronRight } from 'lucide-react';
import { Timeline as TL, VideoClip, VideoLayer, SurfaceContent, SourceType, StateMachine, defaultStateMachine, isContentClip, timelineEnd, type AssetEntry } from '../../types';
import { timeline as engine } from '../../services/timeline';
import { ContentEditor } from '../ContentEditor';
import { GUTTER, RULER_H, LANE_H, MIN_LANE_H, MAX_LANE_H, PAGE_SECS, laneHeight, clamp, fmtTimecode } from './geometry';
import { splitClipAt, bladeAt, rippleDelete, liftDelete } from './operations';
import { collectSnapPoints, snap } from './snapping';
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
export const Timeline: React.FC<Props> = ({ timeline, onChange, stateMachine, onStateMachineChange, playing, onTogglePlay, maximized = false, onToggleMax, projectPath, onRegisterAsset, scenes = [], cues = [], author }) => {
  const [pxPerSec, setPxPerSec] = useState(40);
  const [pillOpen, setPillOpen] = useState(false); // scene/state selector dropdown
  const [selected, setSelected] = useState<string | null>(null);
  const [pickerAt, setPickerAt] = useState<{ x: number; y: number } | null>(null); // automation picker anchor
  const [defsTick, setDefsTick] = useState(0);           // forces a target re-enumeration (~1 Hz)
  const [autoPlayhead, setAutoPlayhead] = useState(0);   // ~10 Hz playhead for the lanes' live readouts
  const [tool, setTool] = useState<'select' | 'blade'>('select');
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [draft, setDraft] = useState<VideoClip | null>(null);
  const [resizeDraft, setResizeDraft] = useState<{ id: string; height: number } | null>(null);
  const [pages, setPages] = useState(0); // infinite-timeline growth: content spans (pages+1) PAGE_SECS at least
  const [smEditorOpen, setSmEditorOpen] = useState(false);

  const layers = timeline.layers;
  const dur = timeline.duration;
  const fps = timeline.fps ?? 30;
  const sm = stateMachine ?? defaultStateMachine();
  // Infinite timeline: content width grows with the furthest content end AND the explored viewport
  // (pages bumped imperatively as the playhead/scroll approaches the right edge — never per frame).
  const contentEnd = useMemo(
    () => Math.max(dur, timeline.outPoint ?? 0, ...timeline.clips.map(c => c.start + c.duration)),
    [timeline.clips, dur, timeline.outPoint],
  );
  const viewEnd = Math.max(contentEnd, (pages + 1) * PAGE_SECS);
  const width = viewEnd * pxPerSec;
  // Distinct from contentEnd: this is where PLAYBACK stops (the readout's denominator), not how far
  // the canvas scrolls. A clip overrunning Length must still be visible/editable — contentEnd stays
  // for that; `end` must NOT be conflated with it.
  const end = useMemo(() => timelineEnd(timeline), [timeline.duration, timeline.inPoint, timeline.outPoint]);

  // Live refs so stable (window-listener / engine-subscription / memoized-child) handlers see
  // current values without re-subscribing or breaking React.memo on clips/headers.
  const pxRef = useRef(pxPerSec); pxRef.current = pxPerSec;
  const viewEndRef = useRef(viewEnd); viewEndRef.current = viewEnd;
  const contentEndRef = useRef(contentEnd); contentEndRef.current = contentEnd;
  const endRef = useRef(end); endRef.current = end;
  const fpsRef = useRef(fps); fpsRef.current = fps;
  const snapRefEnabled = useRef(snapEnabled); snapRefEnabled.current = snapEnabled;
  const draftRef = useRef<VideoClip | null>(null); draftRef.current = draft;
  const timelineRef = useRef(timeline); timelineRef.current = timeline;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const hoverRef = useRef(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const snapGuideRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const dragRef = useRef<{ mode: DragMode; clip: VideoClip; x0: number; points: ReturnType<typeof collectSnapPoints> } | null>(null);

  // Render-free playhead + timecode (engine ticks every frame, even when paused). Also grows the
  // infinite content width by whole pages when the playhead nears the current right edge — quantized
  // so this never setStates per frame (only on page crossings).
  useEffect(() => engine.subscribe((ph) => {
    const px = pxRef.current;
    if (playheadRef.current) playheadRef.current.style.left = `${GUTTER + ph * px}px`;
    if (timeRef.current) timeRef.current.textContent = `${fmtTimecode(ph, fpsRef.current)} / ${fmtTimecode(endRef.current, fpsRef.current)}`;
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

  const setLanes = (next: AutoLane[]) => onChangeRef.current({ ...timelineRef.current, automation: next });
  const addLane = (d: AutomationTargetDef) => {
    setPickerAt(null);
    // Seed with ONE keyframe at the playhead holding the target's CURRENT authored value, so creating a
    // lane never changes the sound. A single-keyframe lane is a constant — safe, and it immediately takes
    // ownership of the path (the authoring slider goes read-only, visibly).
    const cur = automationTargetRegistry.get(d.path.split('.')[0])?.get(d.path) ?? d.def;
    setLanes([...lanes, {
      id: `au-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      targetPath: d.path,
      enabled: true,
      keyframes: [{ t: Math.max(0, engine.getPlayhead()), v: cur, curve: 'linear' }],
    }]);
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
  const startSeekDrag = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return; // left button only; middle is reserved for panning
    seekTo(e.clientX);
    const move = (ev: PointerEvent) => seekTo(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
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
      const move = (ev: PointerEvent) => { el.scrollLeft = sl0 - (ev.clientX - x0); el.scrollTop = st0 - (ev.clientY - y0); };
      const up = () => { el.style.cursor = prevCursor; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
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

  // --- clip drag (move / trim) with snapping — stable handlers read from refs ---
  const onDragMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current; if (!d) return;
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
  const onDragUp = useCallback(() => {
    const f = draftRef.current;
    if (dragRef.current && f) onChangeRef.current({ ...timelineRef.current, clips: timelineRef.current.clips.map(c => c.id === f.id ? f : c) });
    setDraft(null); dragRef.current = null; showGuide(null);
    window.removeEventListener('pointermove', onDragMove); window.removeEventListener('pointerup', onDragUp);
  }, [onDragMove, showGuide]);
  const onStartDrag = useCallback((e: React.PointerEvent, clip: VideoClip, mode: DragMode) => {
    e.stopPropagation(); e.preventDefault();
    setSelected(clip.id);
    dragRef.current = { mode, clip: { ...clip }, x0: e.clientX, points: collectSnapPoints(timelineRef.current, engine.getPlayhead(), clip.id) };
    window.addEventListener('pointermove', onDragMove); window.addEventListener('pointerup', onDragUp);
  }, [onDragMove, onDragUp]);

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
  const startReorder = useCallback((e: React.PointerEvent, index: number) => {
    e.stopPropagation(); e.preventDefault();
    const el = scrollRef.current; if (!el) return;
    const id = timelineRef.current.layers[index]?.id; if (!id) return;
    const move = (ev: PointerEvent) => {
      const tl = timelineRef.current; const ls = tl.layers;
      const r = el.getBoundingClientRect();
      const y = ev.clientY - r.top + el.scrollTop - RULER_H;
      let target = 0, acc = 0;
      for (let i = 0; i < ls.length; i++) { const h = laneHeight(ls[i]); if (y > acc + h / 2) target = i + 1; acc += h; }
      target = clamp(target, 0, ls.length - 1);
      const cur = ls.findIndex(l => l.id === id);
      if (cur < 0 || target === cur) return;
      const next = ls.slice(); const [m] = next.splice(cur, 1); next.splice(target, 0, m);
      onChangeRef.current({ ...tl, layers: next });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }, []);
  const startResize = useCallback((e: React.PointerEvent, layer: VideoLayer) => {
    e.stopPropagation(); e.preventDefault();
    const h0 = laneHeight(layer); const y0 = e.clientY;
    setResizeDraft({ id: layer.id, height: h0 });
    const move = (ev: PointerEvent) => setResizeDraft({ id: layer.id, height: clamp(h0 + (ev.clientY - y0), MIN_LANE_H, MAX_LANE_H) });
    const up = (ev: PointerEvent) => {
      const nh = clamp(h0 + (ev.clientY - y0), MIN_LANE_H, MAX_LANE_H);
      setResizeDraft(null);
      onChangeRef.current({ ...timelineRef.current, layers: timelineRef.current.layers.map(l => l.id === layer.id ? { ...l, height: nh } : l) });
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }, []);

  // --- non-stable mutations (toolbar / lane / ruler / keyboard) read fresh closure state ---
  const addLayer = () => onChange({ ...timeline, layers: [...layers, { id: crypto.randomUUID(), name: `Track ${layers.length + 1}`, enabled: true }] });
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
  // Stop goes through the SAME TransportIntent funnel the FSM and OSC use, so App stays the single
  // writer of `playing`. (A 'stop' intent has existed since OSC landed; no UI ever emitted one.)
  const stop = () => engine.dispatchTransportIntent({ kind: 'stop' });
  const deleteSelected = (ripple: boolean) => { if (!selected) return; onChange({ ...timeline, clips: ripple ? rippleDelete(timeline.clips, selected) : liftDelete(timeline.clips, selected) }); setSelected(null); };
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
    setSelected(clip.id);
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
  // "Empty" means nothing on the canvas at all — no tracks, no clips, AND no automation lanes.
  // Counting clips alone left the hint card sitting over a timeline full of audio curves.
  const isEmpty = layers.length === 0 && timeline.clips.length === 0 && (timeline.automation?.length ?? 0) === 0;
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
                    {s.hasTimeline
                      ? <Film size={11} className="text-fg-3" />
                      : <span className="text-micro text-fg-3 italic">global</span>}
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
        duration={dur} onChangeDuration={(d) => onChange({ ...timeline, duration: d })}
        fps={fps} onChangeFps={(f) => onChange({ ...timeline, fps: f })}
        tool={tool} onSetTool={setTool}
        snapEnabled={snapEnabled} onToggleSnap={() => setSnapEnabled(v => !v)}
        onAddMarker={addMarker} onSetIn={setIn} onSetOut={setOut}
        hasRegion={timeline.inPoint != null && timeline.outPoint != null && timeline.outPoint > timeline.inPoint}
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
              markers={timeline.markers ?? []} inPoint={timeline.inPoint ?? null} outPoint={timeline.outPoint ?? null}
              onSeekDown={startSeekDrag}
              onMarkerSeek={(t) => engine.seek(t)}
              onMarkerDelete={(id) => onChange({ ...timeline, markers: (timeline.markers ?? []).filter(m => m.id !== id) })}
              onMarkerNote={(id, note) => onChange({ ...timeline, markers: (timeline.markers ?? []).map(m => m.id === id ? { ...m, note } : m) })}
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

          {/* Automation lanes — keyframe curves over the same time axis. Like StateLane they are not
              VideoLayers (they hold keyframes, not clips), so they mount here rather than in layers.map. */}
          {lanes.map((lane, i) => (
            <AutomationLane
              key={lane.id}
              lane={lane}
              def={laneDefs.get(lane.targetPath)}
              pxPerSec={pxPerSec}
              width={Math.max(width, 100)}
              playhead={autoPlayhead}
              onSnap={(t) => snap(t, collectSnapPoints(timelineRef.current, engine.getPlayhead()), 8 / pxRef.current).t}
              onSeek={seekTo}
              onChange={(next) => setLanes(lanes.map((l, j) => (j === i ? next : l)))}
              onRemove={() => setLanes(lanes.filter((_, j) => j !== i))}
            />
          ))}

          {/* add an automation lane */}
          <div className="flex border-b border-line-1">
            <div className="sticky left-0 z-20 shrink-0 bg-surface-1 border-r border-line-1 flex items-center px-2 relative" style={{ width: GUTTER, height: 26 }}>
              <button onClick={(e) => { const r = (e.target as HTMLElement).getBoundingClientRect(); setPickerAt({ x: r.left, y: r.bottom }); }}
                className="text-micro text-fg-3 hover:text-fg-1 inline-flex items-center gap-1">
                <Plus size={11} /> Automation
              </button>
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
