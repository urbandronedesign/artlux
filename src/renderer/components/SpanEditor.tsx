import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Columns3, Link, Link2Off, Plus, RefreshCw, Trash2, Frame } from 'lucide-react';
import { Surface, SourceType } from '../types';
import { FULL_RECT, defaultOutputSpan, type OutputSpan, type ProjectorOutput, type SrcRect } from '../../../shared/protocol';
import { clampCount, clampOverlap, clampRect } from '../services/outputSpan';
import { getDrawable } from '../services/surfaceMedia';

// Spanning one picture across several projectors.
//
// The wizard cuts a source surface into cols×rows overlapping SLICE surfaces; each piece is an
// ordinary Surface, so it already owns a projector output with its own corner-pin/Bézier homography,
// soft edge, gamma and colour match — this panel only decides WHERE each piece is cut from and how
// wide the shared band is. The map below draws the cut over the live source so the overlaps are
// something you look at rather than something you compute.
//
// See services/outputSpan.ts for the geometry and shared/protocol OutputSpan for why a span is
// authoring metadata and never consulted at runtime.

interface Props {
  surfaces: Surface[];
  spans: OutputSpan[];
  outputs: ProjectorOutput[];
  editingOutputIds: string[];
  onApplySpan: (span: OutputSpan) => void;   // create / regenerate the members from the grid
  onUpdateSpan: (span: OutputSpan) => void;  // metadata only (name, linked)
  onRemoveSpan: (id: string) => void;
  onSetSliceRect: (surfaceId: string, rect: SrcRect) => void;
  onToggleEditMany: (surfaceIds: string[]) => void;
}

const numCell = 'w-12 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-right text-fg-1 num text-micro focus:border-accent focus:outline-none';
const MAP_H = 132;       // map height in px; the width follows the source's aspect
const EDGE_GRAB = 6;     // px within an edge that starts a resize instead of a move

type DragMode = { id: string; kind: 'move' | 'edge'; l: boolean; r: boolean; t: boolean; b: boolean };

// Live thumbnail of the source surface, drawn behind the cut map so the overlaps sit on real pixels.
const SourcePreview: React.FC<{ source: Surface | undefined; w: number; h: number }> = ({ source, w, h }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!source) return;
    let raf = 0; let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 100) return; // 10 fps — this is a thumbnail, not an output
      last = now;
      const c = ref.current;
      const ctx = c?.getContext('2d');
      if (!c || !ctx) return;
      const d = getDrawable(source);
      ctx.clearRect(0, 0, c.width, c.height);
      if (d) { try { ctx.drawImage(d, 0, 0, c.width, c.height); } catch { /* not decodable this frame */ } }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [source]);
  return <canvas ref={ref} width={w} height={h} className="absolute inset-0 w-full h-full" />;
};

export const SpanEditor: React.FC<Props> = ({
  surfaces, spans, outputs, editingOutputIds,
  onApplySpan, onUpdateSpan, onRemoveSpan, onSetSliceRect, onToggleEditMany,
}) => {
  const [newSourceId, setNewSourceId] = useState('');
  const drag = useRef<DragMode | null>(null);
  const mapRef = useRef<HTMLDivElement | null>(null);

  // A slice can't be a span source (slices don't nest — see SurfaceContent.sliceOf).
  const sources = useMemo(() => surfaces.filter(s => s.content.type !== SourceType.SLICE), [surfaces]);

  const addSpan = () => {
    const src = sources.find(s => s.id === newSourceId);
    if (!src) return;
    onApplySpan(defaultOutputSpan(Math.random().toString(36).slice(2, 11), src.id, `${src.name} span`));
    setNewSourceId('');
  };

  // Pointer drag over the map: move a piece, or drag an edge to resize it. Both write the piece's
  // crop directly (which unlinks the span — the grid no longer describes it).
  useEffect(() => {
    const norm = (e: PointerEvent): [number, number] => {
      const box = mapRef.current?.getBoundingClientRect();
      if (!box) return [0, 0];
      return [(e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height];
    };
    let start: { px: number; py: number; rect: SrcRect } | null = null;
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || !start) return;
      const [px, py] = norm(e);
      const dx = px - start.px, dy = py - start.py;
      const r = start.rect;
      let next: SrcRect;
      if (d.kind === 'move') next = { ...r, x: r.x + dx, y: r.y + dy };
      else {
        // Dragging an edge moves that edge only: the opposite one stays put, so the piece grows or
        // shrinks into the overlap instead of sliding.
        const x = d.l ? r.x + dx : r.x;
        const y = d.t ? r.y + dy : r.y;
        const w = d.l ? r.w - dx : d.r ? r.w + dx : r.w;
        const h = d.t ? r.h - dy : d.b ? r.h + dy : r.h;
        next = { x, y, w, h };
      }
      onSetSliceRect(d.id, clampRect(next));
    };
    const onUp = () => { drag.current = null; start = null; };
    const onDown = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const s = surfaces.find(x => x.id === d.id);
      const [px, py] = norm(e);
      start = { px, py, rect: s?.content.sliceRect ?? FULL_RECT };
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [surfaces, onSetSliceRect]);

  return (
    <div className="border border-line-1 rounded-md">
      <div className="px-2 py-1 flex items-center gap-2 text-micro uppercase tracking-wider text-fg-3 border-b border-line-1">
        <Columns3 size={12} /> Spans
        <span className="normal-case tracking-normal text-fg-3">— one picture across several projectors</span>
      </div>

      <div className="px-2 py-1.5 flex items-center gap-2 text-mini border-b border-line-1">
        <select value={newSourceId} onChange={(e) => setNewSourceId(e.target.value)}
          className="flex-1 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-fg-1 text-mini focus:border-accent focus:outline-none">
          <option value="">— surface to span —</option>
          {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button onClick={addSpan} disabled={!newSourceId}
          className="flex items-center gap-1 px-2 py-1 rounded-sm bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 disabled:opacity-40">
          <Plus size={12} /> New span
        </button>
      </div>

      {spans.length === 0 && (
        <div className="px-2 py-2 text-mini text-fg-3 italic">
          No spans. Pick a surface and press New span — it cuts overlapping pieces, routes each to a
          display and sets the soft edges to match.
        </div>
      )}

      {spans.map((span) => {
        const src = surfaces.find(s => s.id === span.sourceSurfaceId);
        const members = span.sliceIds.map(id => surfaces.find(s => s.id === id)).filter((s): s is Surface => !!s);
        const aspect = src && src.height > 0 ? (src.width / src.height) : 16 / 9;
        const mapW = Math.round(MAP_H * Math.max(0.5, Math.min(4, aspect)));
        const aligning = members.length > 0 && members.every(m => editingOutputIds.includes(m.id));
        const set = (patch: Partial<OutputSpan>) => {
          const next = { ...span, ...patch };
          // A linked span re-cuts on every grid change; an unlinked one keeps hand-tuned crops and
          // only stores the numbers until Regenerate is pressed.
          if (next.linked) onApplySpan(next); else onUpdateSpan(next);
        };
        return (
          <div key={span.id} className="px-2 py-2 space-y-2 border-b border-line-1 last:border-b-0">
            <div className="flex items-center gap-2 text-mini flex-wrap">
              <input value={span.name} onChange={(e) => onUpdateSpan({ ...span, name: e.target.value })}
                className="w-36 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-fg-1 text-mini focus:border-accent focus:outline-none" />
              <span className="text-fg-3">{src ? src.name : <span className="text-danger">source missing</span>}</span>
              <div className="flex-1" />
              <button onClick={() => onToggleEditMany(members.map(m => m.id))} disabled={members.length === 0}
                title="Put the alignment grid up on every projector of this span at once"
                className={`flex items-center gap-1 px-1.5 py-1 rounded-sm text-micro disabled:opacity-30 ${aligning ? 'bg-accent text-black' : 'bg-surface-2 text-fg-2 hover:text-fg-1'}`}>
                <Frame size={12} /> {aligning ? 'Aligning' : 'Align span'}
              </button>
              <button onClick={() => onUpdateSpan({ ...span, linked: !span.linked })}
                title={span.linked ? 'Linked: grid changes re-cut the pieces' : 'Unlinked: pieces keep their hand-tuned crops'}
                className={`p-1 rounded-sm ${span.linked ? 'text-accent' : 'text-fg-3 hover:text-fg-1'}`}>
                {span.linked ? <Link size={12} /> : <Link2Off size={12} />}
              </button>
              <button onClick={() => onApplySpan(span)} disabled={!src} title="Re-cut the pieces from the grid (discards hand-tuned crops)"
                className="p-1 rounded-sm text-fg-3 hover:text-fg-1 disabled:opacity-30"><RefreshCw size={12} /></button>
              <button onClick={() => onRemoveSpan(span.id)} title="Delete the span and the pieces it made"
                className="p-1 rounded-sm text-fg-3 hover:text-danger"><Trash2 size={12} /></button>
            </div>

            <div className="flex items-center gap-2 text-mini flex-wrap">
              <label className="flex items-center gap-1 text-fg-2">Cols
                <input type="number" min={1} max={16} value={span.cols}
                  onChange={(e) => set({ cols: clampCount(+e.target.value) })} className={numCell} />
              </label>
              <label className="flex items-center gap-1 text-fg-2">Rows
                <input type="number" min={1} max={16} value={span.rows}
                  onChange={(e) => set({ rows: clampCount(+e.target.value) })} className={numCell} />
              </label>
              <label className="flex items-center gap-1 text-fg-2" title="Fraction of one piece shared with its horizontal neighbour">
                Overlap X %
                <input type="number" min={0} max={50} value={Math.round(span.overlapX * 100)}
                  onChange={(e) => set({ overlapX: clampOverlap((+e.target.value) / 100) })} className={numCell} />
              </label>
              {span.rows > 1 && (
                <label className="flex items-center gap-1 text-fg-2" title="Fraction of one piece shared with its vertical neighbour">
                  Overlap Y %
                  <input type="number" min={0} max={50} value={Math.round(span.overlapY * 100)}
                    onChange={(e) => set({ overlapY: clampOverlap((+e.target.value) / 100) })} className={numCell} />
                </label>
              )}
              <span className="text-fg-3">{members.length} piece{members.length === 1 ? '' : 's'}</span>
            </div>

            {/* The cut, over the live source. Drag a piece to move it, drag its edge to resize. */}
            <div ref={mapRef} className="relative bg-black border border-line-1 rounded-sm overflow-hidden select-none"
              style={{ width: mapW, height: MAP_H }}>
              <SourcePreview source={src} w={mapW} h={MAP_H} />
              {members.map((m, i) => {
                const r = m.content.sliceRect ?? FULL_RECT;
                const out = outputs.find(o => o.surfaceId === m.id);
                const live = !!out?.enabled && out.displayId != null;
                const onPointerDown = (e: React.PointerEvent) => {
                  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const l = e.clientX - box.left < EDGE_GRAB, rr = box.right - e.clientX < EDGE_GRAB;
                  const t = e.clientY - box.top < EDGE_GRAB, b = box.bottom - e.clientY < EDGE_GRAB;
                  drag.current = { id: m.id, kind: (l || rr || t || b) ? 'edge' : 'move', l, r: rr, t, b };
                };
                return (
                  <div key={m.id} onPointerDown={onPointerDown}
                    title={`${m.name}${live ? '' : ' — no display'}`}
                    className={`absolute border-2 ${live ? 'border-accent' : 'border-fg-3'} bg-accent/5 cursor-move`}
                    style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}>
                    <span className="absolute left-0.5 top-0.5 px-1 rounded-sm bg-black/70 text-micro num text-fg-1">{i + 1}</span>
                  </div>
                );
              })}
            </div>
            <div className="text-micro text-fg-3 italic">
              Drag a piece to move it, drag an edge to resize — either one unlinks the span so the grid
              stops overwriting it. Per-piece homography lives in the row below (Align + gear).
            </div>
          </div>
        );
      })}
    </div>
  );
};
