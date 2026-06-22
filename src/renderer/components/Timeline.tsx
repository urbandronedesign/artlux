import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Timeline as TL, VideoClip } from '../types';
import { timeline as engine } from '../services/timeline';
import { Play, Pause, Plus, Trash2, ZoomIn, ZoomOut, Film } from 'lucide-react';

interface Props {
  timeline: TL;
  onChange: (t: TL) => void;
  playing: boolean;
  onTogglePlay: () => void;
}

const LANE_H = 34;
const GUTTER = 128;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// NLE-style video-layer timeline. Tracks (layers) hold clips placed by time; the unified
// transport (top-bar play) drives the engine — the playback clock. Edits update project
// state via onChange; the live playhead is read from the engine render-free.
export const Timeline: React.FC<Props> = ({ timeline, onChange, playing, onTogglePlay }) => {
  const [pxPerSec, setPxPerSec] = useState(40);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<VideoClip | null>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);

  const layers = timeline.layers;
  const dur = timeline.duration;
  const width = dur * pxPerSec;

  // Live values for the stable (window-listener) handlers.
  const pxRef = useRef(pxPerSec); pxRef.current = pxPerSec;
  const durRef = useRef(dur); durRef.current = dur;
  const draftRef = useRef<VideoClip | null>(null); draftRef.current = draft;
  const dragRef = useRef<{ mode: 'move' | 'l' | 'r'; clip: VideoClip; x0: number } | null>(null);
  const seekRef = useRef(false);
  const commitRef = useRef<(c: VideoClip) => void>(() => {});
  commitRef.current = (f) => onChange({ ...timeline, clips: timeline.clips.map(c => c.id === f.id ? f : c) });

  // Render-free playhead marker + time readout (engine ticks every frame).
  useEffect(() => engine.subscribe((ph) => {
    if (playheadRef.current) playheadRef.current.style.left = `${ph * pxPerSec}px`;
    if (timeRef.current) timeRef.current.textContent = `${fmt(ph)} / ${fmt(dur)}`;
  }), [pxPerSec, dur]);

  // --- mutations ---
  const addLayer = () => onChange({ ...timeline, layers: [...layers, { id: crypto.randomUUID(), name: `Layer ${layers.length + 1}` }] });
  const removeLayer = (id: string) => onChange({ ...timeline, layers: layers.filter(l => l.id !== id), clips: timeline.clips.filter(c => c.layerId !== id) });
  const removeClip = (id: string) => { onChange({ ...timeline, clips: timeline.clips.filter(c => c.id !== id) }); if (selected === id) setSelected(null); };

  // --- seek ---
  const seekAt = useCallback((clientX: number) => {
    const el = lanesRef.current; if (!el) return;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
    engine.seek(clamp(x / pxRef.current, 0, durRef.current));
  }, []);
  const onSeekMove = useCallback((e: PointerEvent) => { if (seekRef.current) seekAt(e.clientX); }, [seekAt]);
  const onSeekUp = useCallback(() => {
    seekRef.current = false;
    window.removeEventListener('pointermove', onSeekMove);
    window.removeEventListener('pointerup', onSeekUp);
  }, [onSeekMove]);

  // --- clip drag (move / trim) — stable handlers read from refs ---
  const onDragMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    const ds = (e.clientX - d.x0) / pxRef.current; const c = d.clip;
    if (d.mode === 'move') setDraft({ ...c, start: Math.max(0, c.start + ds) });
    else if (d.mode === 'r') setDraft({ ...c, duration: clamp(c.duration + ds, 0.1, (c.sourceDuration ?? Infinity) - c.inPoint) });
    else { const delta = clamp(ds, -c.inPoint, c.duration - 0.1); setDraft({ ...c, start: Math.max(0, c.start + delta), inPoint: Math.max(0, c.inPoint + delta), duration: c.duration - delta }); }
  }, []);
  const onDragUp = useCallback(() => {
    if (dragRef.current && draftRef.current) commitRef.current(draftRef.current);
    setDraft(null); dragRef.current = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
  }, [onDragMove]);
  const startClipDrag = (e: React.PointerEvent, clip: VideoClip, mode: 'move' | 'l' | 'r') => {
    e.stopPropagation(); e.preventDefault();
    setSelected(clip.id);
    dragRef.current = { mode, clip: { ...clip }, x0: e.clientX };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp);
  };
  const startSeek = (e: React.PointerEvent) => {
    seekRef.current = true; seekAt(e.clientX);
    window.addEventListener('pointermove', onSeekMove);
    window.addEventListener('pointerup', onSeekUp);
  };

  // --- drop an MP4 onto a lane → create a clip ---
  const onDrop = (e: React.DragEvent, layerId: string) => {
    e.preventDefault();
    const file = Array.from(e.dataTransfer.files).find(f => f.type.startsWith('video') || /\.(mp4|webm|mov|mkv)$/i.test(f.name));
    if (!file) return;
    const path = window.artlux?.getPathForFile?.(file);
    if (!path) return;
    const el = lanesRef.current;
    const start = el ? clamp((e.clientX - el.getBoundingClientRect().left + el.scrollLeft) / pxPerSec, 0, dur) : 0;
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      const d = v.duration && isFinite(v.duration) ? v.duration : 5;
      URL.revokeObjectURL(url);
      onChange({ ...timeline, clips: [...timeline.clips, { id: crypto.randomUUID(), layerId, name: file.name.replace(/\.[^.]+$/, ''), path, start, duration: d, inPoint: 0, sourceDuration: d }] });
    };
    v.src = url;
  };

  const ticks = Math.ceil(dur);

  return (
    <div className="h-full flex flex-col bg-surface-0 text-fg-1 text-xs select-none">
      {/* transport */}
      <div className="shrink-0 flex items-center gap-3 px-3 h-9 border-b border-line-1 bg-surface-1">
        <button onClick={onTogglePlay} className={`p-1.5 rounded-[var(--r-sm)] ${playing ? 'bg-accent text-black' : 'bg-surface-2 text-fg-2 hover:text-fg-1'}`}>
          {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
        </button>
        <span ref={timeRef} className="num text-[11px] text-fg-2 w-24">0:00 / {fmt(dur)}</span>
        <div className="flex items-center gap-1">
          <span className="text-fg-3 text-[10px]">Length</span>
          <input type="number" min={1} step={1} value={dur} onChange={(e) => onChange({ ...timeline, duration: Math.max(1, parseFloat(e.target.value) || 1) })}
            className="w-14 bg-surface-0 border border-line-1 rounded px-1.5 py-0.5 text-right num text-[11px] focus:border-accent focus:outline-none" />
          <span className="text-fg-3 text-[10px]">s</span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setPxPerSec(p => clamp(p / 1.5, 5, 300))} className="p-1 rounded text-fg-2 hover:text-fg-1" title="Zoom out"><ZoomOut size={13} /></button>
          <button onClick={() => setPxPerSec(p => clamp(p * 1.5, 5, 300))} className="p-1 rounded text-fg-2 hover:text-fg-1" title="Zoom in"><ZoomIn size={13} /></button>
          <button onClick={addLayer} className="flex items-center gap-1 px-2 py-1 rounded-[var(--r-sm)] bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-[11px]"><Plus size={12} /> Track</button>
        </div>
      </div>

      {/* tracks */}
      <div className="flex-1 min-h-0 flex">
        <div className="shrink-0 border-r border-line-1 bg-surface-1" style={{ width: GUTTER }}>
          <div className="h-6 border-b border-line-1" />
          {layers.map(l => (
            <div key={l.id} className="flex items-center gap-1 px-2 border-b border-line-1" style={{ height: LANE_H }}>
              <Film size={11} className="text-fg-3 shrink-0" />
              <input value={l.name} onChange={(e) => onChange({ ...timeline, layers: layers.map(x => x.id === l.id ? { ...x, name: e.target.value } : x) })}
                className="flex-1 min-w-0 bg-transparent text-[11px] text-fg-1 focus:bg-surface-0 rounded px-1 outline-none" />
              <button onClick={() => removeLayer(l.id)} className="text-fg-3 hover:text-danger"><Trash2 size={11} /></button>
            </div>
          ))}
          {layers.length === 0 && <div className="text-fg-3 italic px-2 py-2 text-[11px]">Add a track →</div>}
        </div>

        <div ref={lanesRef} className="flex-1 min-w-0 overflow-x-auto relative">
          <div style={{ width: Math.max(width, 100) }}>
            {/* ruler (seek) */}
            <div className="h-6 border-b border-line-1 relative bg-surface-1/40 cursor-text" onPointerDown={startSeek}>
              {Array.from({ length: ticks + 1 }).map((_, i) => (
                <div key={i} className="absolute top-0 bottom-0 border-l border-line-1/60" style={{ left: i * pxPerSec }}>
                  <span className="absolute top-0.5 left-1 num text-[9px] text-fg-3">{i}s</span>
                </div>
              ))}
            </div>
            {/* lanes */}
            {layers.map(l => (
              <div key={l.id} className="relative border-b border-line-1" style={{ height: LANE_H }}
                onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, l.id)}
                onPointerDown={(e) => { if (e.target === e.currentTarget) seekAt(e.clientX); }}>
                {timeline.clips.filter(c => c.layerId === l.id).map(c => {
                  const cc = draft && draft.id === c.id ? draft : c;
                  const sel = selected === c.id;
                  return (
                    <div key={c.id}
                      onPointerDown={(e) => startClipDrag(e, cc, 'move')}
                      className={`absolute top-1 bottom-1 rounded-[var(--r-sm)] border overflow-hidden cursor-grab ${sel ? 'border-accent bg-accent/25' : 'border-line-2 bg-surface-3'}`}
                      style={{ left: cc.start * pxPerSec, width: Math.max(6, cc.duration * pxPerSec) }}
                      title={`${cc.name} — ${fmt(cc.duration)}`}
                    >
                      <div className="px-1.5 pt-0.5 text-[10px] truncate text-fg-1 pointer-events-none">{cc.name}</div>
                      <div onPointerDown={(e) => startClipDrag(e, cc, 'l')} className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-black/30 hover:bg-accent" />
                      <div onPointerDown={(e) => startClipDrag(e, cc, 'r')} className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-black/30 hover:bg-accent" />
                      {sel && <button onPointerDown={(e) => e.stopPropagation()} onClick={() => removeClip(c.id)} className="absolute top-0.5 right-2 text-fg-3 hover:text-danger"><Trash2 size={10} /></button>}
                    </div>
                  );
                })}
              </div>
            ))}
            {/* playhead */}
            <div ref={playheadRef} className="absolute top-0 bottom-0 w-px bg-sel-fixture z-20 pointer-events-none" style={{ left: 0 }}>
              <div className="absolute top-0 -left-1 w-2 h-2 bg-sel-fixture rotate-45" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
