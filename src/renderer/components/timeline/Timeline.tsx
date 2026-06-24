import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Timeline as TL, VideoClip, VideoLayer } from '../../types';
import { timeline as engine } from '../../services/timeline';
import { GUTTER, RULER_H, LANE_H, MIN_LANE_H, MAX_LANE_H, laneHeight, clamp, fmtTimecode } from './geometry';
import { splitClipAt, bladeAt, rippleDelete, liftDelete } from './operations';
import { collectSnapPoints, snap } from './snapping';
import { TimelineToolbar } from './TimelineToolbar';
import { TimelineRuler } from './TimelineRuler';
import { TrackHeader } from './TrackHeader';
import { Lane } from './Lane';
import { DragMode } from './ClipBlock';
import { useTimelineKeys } from './hooks/useTimelineKeys';

interface Props {
  timeline: TL;
  onChange: (t: TL) => void;
  playing: boolean;
  onTogglePlay: () => void;
}

// DaVinci-style NLE timeline. Tracks (layers) hold clips placed by time; the unified transport
// (top-bar play) drives the engine — the playback clock. Edits commit to project state via
// onChange; the live playhead/time are read from the engine render-free. Layout is a single
// vertical scroller with a sticky track-header gutter and a sticky timecode ruler.
export const Timeline: React.FC<Props> = ({ timeline, onChange, playing, onTogglePlay }) => {
  const [pxPerSec, setPxPerSec] = useState(40);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<'select' | 'blade'>('select');
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [draft, setDraft] = useState<VideoClip | null>(null);
  const [resizeDraft, setResizeDraft] = useState<{ id: string; height: number } | null>(null);

  const layers = timeline.layers;
  const dur = timeline.duration;
  const fps = timeline.fps ?? 30;
  const width = dur * pxPerSec;

  // Live refs so stable (window-listener / engine-subscription / memoized-child) handlers see
  // current values without re-subscribing or breaking React.memo on clips/headers.
  const pxRef = useRef(pxPerSec); pxRef.current = pxPerSec;
  const durRef = useRef(dur); durRef.current = dur;
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

  // Render-free playhead + timecode (engine ticks every frame, even when paused).
  useEffect(() => engine.subscribe((ph) => {
    const px = pxRef.current;
    if (playheadRef.current) playheadRef.current.style.left = `${GUTTER + ph * px}px`;
    if (timeRef.current) timeRef.current.textContent = `${fmtTimecode(ph, fpsRef.current)} / ${fmtTimecode(durRef.current, fpsRef.current)}`;
  }), []);

  // --- coordinate helpers (stable) ---
  const clientXToTime = useCallback((clientX: number) => {
    const el = scrollRef.current; if (!el) return 0;
    const r = el.getBoundingClientRect();
    const x = clientX - r.left + el.scrollLeft - GUTTER;
    return clamp(x / pxRef.current, 0, durRef.current);
  }, []);
  const seekTo = useCallback((clientX: number) => engine.seek(clientXToTime(clientX)), [clientXToTime]);
  const startSeekDrag = useCallback((e: React.PointerEvent) => {
    seekTo(e.clientX);
    const move = (ev: PointerEvent) => seekTo(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }, [seekTo]);

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
  const onZoom = (f: number) => setPxPerSec(p => clamp(p * f, 5, 300));
  const onZoomFit = () => { const el = scrollRef.current; const avail = (el ? el.clientWidth : 800) - GUTTER - 24; setPxPerSec(clamp(avail / Math.max(1, dur), 5, 300)); };
  const addMarker = () => onChange({ ...timeline, markers: [...(timeline.markers ?? []), { id: crypto.randomUUID(), time: engine.getPlayhead(), color: '#f5a623' }] });
  const setIn = () => { const t = engine.getPlayhead(); const out = timeline.outPoint != null && timeline.outPoint <= t ? null : timeline.outPoint ?? null; onChange({ ...timeline, inPoint: t, outPoint: out }); };
  const setOut = () => { const t = engine.getPlayhead(); const inp = timeline.inPoint != null && timeline.inPoint >= t ? null : timeline.inPoint ?? null; onChange({ ...timeline, inPoint: inp, outPoint: t }); };
  const deleteSelected = (ripple: boolean) => { if (!selected) return; onChange({ ...timeline, clips: ripple ? rippleDelete(timeline.clips, selected) : liftDelete(timeline.clips, selected) }); setSelected(null); };
  const bladeAtPlayhead = () => onChange({ ...timeline, clips: bladeAt(timeline.clips, engine.getPlayhead()) });

  // --- drop a video onto a lane → create a clip ---
  const onDropFile = (e: React.DragEvent, layerId: string) => {
    e.preventDefault();
    const file = Array.from(e.dataTransfer.files).find(f => f.type.startsWith('video') || /\.(mp4|webm|mov|mkv)$/i.test(f.name));
    if (!file) return;
    const path = window.artlux?.getPathForFile?.(file);
    if (!path) return;
    const start = clientXToTime(e.clientX);
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      const d = v.duration && isFinite(v.duration) ? v.duration : 5;
      URL.revokeObjectURL(url);
      onChangeRef.current({ ...timelineRef.current, clips: [...timelineRef.current.clips, { id: crypto.randomUUID(), layerId, name: file.name.replace(/\.[^.]+$/, ''), path, start, duration: d, inPoint: 0, sourceDuration: d }] });
    };
    v.src = url;
  };

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
    seekEnd: () => engine.seek(dur),
  }, () => !!panelRef.current && (hoverRef.current || panelRef.current.contains(document.activeElement)));

  const laneHeightOf = (l: VideoLayer) => (resizeDraft && resizeDraft.id === l.id ? resizeDraft.height : laneHeight(l));

  return (
    <div ref={panelRef} tabIndex={0} onMouseEnter={() => { hoverRef.current = true; }} onMouseLeave={() => { hoverRef.current = false; }}
      className="h-full flex flex-col bg-surface-0 text-fg-1 text-xs select-none outline-none">
      <TimelineToolbar
        playing={playing} onTogglePlay={onTogglePlay} timeRef={timeRef}
        duration={dur} onChangeDuration={(d) => onChange({ ...timeline, duration: d })}
        fps={fps} onChangeFps={(f) => onChange({ ...timeline, fps: f })}
        tool={tool} onSetTool={setTool}
        snapEnabled={snapEnabled} onToggleSnap={() => setSnapEnabled(v => !v)}
        onAddMarker={addMarker} onZoom={onZoom} onZoomFit={onZoomFit} onAddTrack={addLayer}
      />

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto relative">
        <div className="relative" style={{ width: GUTTER + Math.max(width, 100) }}>
          {/* header row: timecode ruler (sticky top), corner cell (sticky left) */}
          <div className="flex sticky top-0 z-30">
            <div className="sticky left-0 z-40 shrink-0 bg-surface-1 border-b border-r border-line-1 flex items-center px-2 text-[10px] text-fg-3" style={{ width: GUTTER, height: RULER_H }}>Tracks</div>
            <TimelineRuler
              duration={dur} pxPerSec={pxPerSec} width={Math.max(width, 100)} height={RULER_H} fps={fps}
              markers={timeline.markers ?? []} inPoint={timeline.inPoint ?? null} outPoint={timeline.outPoint ?? null}
              onSeekDown={startSeekDrag}
              onMarkerSeek={(t) => engine.seek(t)}
              onMarkerDelete={(id) => onChange({ ...timeline, markers: (timeline.markers ?? []).filter(m => m.id !== id) })}
              onMarkerNote={(id, note) => onChange({ ...timeline, markers: (timeline.markers ?? []).map(m => m.id === id ? { ...m, note } : m) })}
            />
          </div>

          {layers.length === 0 && (
            <div className="flex">
              <div className="sticky left-0 z-20 shrink-0 bg-surface-1 border-r border-line-1" style={{ width: GUTTER, height: LANE_H }} />
              <div className="text-fg-3 italic px-3 py-2 text-[11px]">Add a track, then drop a video onto its lane →</div>
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
                  width={Math.max(width, 100)} laneH={h}
                  onSeek={seekTo} onDropFile={onDropFile} onStartDrag={onStartDrag} onBlade={onBlade} onRemoveClip={onRemoveClip}
                />
              </div>
            );
          })}

          {/* snap guide + playhead overlay (content coords; scroll with the tracks) */}
          <div ref={snapGuideRef} className="absolute w-px bg-accent z-10 pointer-events-none" style={{ left: GUTTER, top: RULER_H, bottom: 0, display: 'none' }} />
          <div ref={playheadRef} className="absolute w-px bg-sel-fixture z-10 pointer-events-none" style={{ left: GUTTER, top: RULER_H, bottom: 0 }}>
            <div className="absolute top-0 -left-[3px] w-[7px] h-[7px] bg-sel-fixture rotate-45" />
          </div>
        </div>
      </div>
    </div>
  );
};
