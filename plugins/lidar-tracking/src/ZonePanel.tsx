import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2, Plus, Users, Eye, EyeOff } from 'lucide-react';
import type { TrackingZone } from '../../../shared/protocol';
import type { PanelProps } from '@artlux/sdk/renderer';
import { nextNumberedName } from '@artlux/sdk/renderer';
import * as trackingStore from './trackingStore';
import * as zones from './zones';
import { useHostScene3D, setZones, setActiveZoneIds } from './trackingHost';

// TRIGGER ZONES — the authoring surface. A dock tab on the `tracking` workspace context (registered
// by the plugin; the host declares that context and knows nothing about zones).
//
// A zone is a normalized rect on a tracking surface, so it is drawn on a FLAT MAP of that surface, not
// in the 3D scene: dragging a rectangle is a 2D gesture, and (u,v) is exactly what the map's pixels
// are. The 3D scene shows the result (TrackingViz draws the same zones, labelled, against the venue) —
// draw here, verify there.
//
// ⚠ THE MAP IS Y-UP. Blobs arrive with the origin BOTTOM-LEFT (the tracker's convention) while a DOM
// box is top-left, so every conversion in this file flips v. Getting this wrong does not throw — it
// silently mirrors every zone vertically, and the show then reacts to the wrong half of the room.
//
// ── TWO SCOPES ON ONE SCREEN, AND THEY ARE NOT THE SAME THING ────────────────────────────────────
//   the ZONES      — the room. Project scope. Drawn once; a scene recall never changes them.
//   ACTIVE in this scene — which of them the CURRENT look listens to (Scene3D.activeZoneIds). This
//                    travels with the scene, so "the welcome state watches the entrance, the
//                    performance state watches the stage" is authored here, per scene, with the eye
//                    toggle. Absent ⇒ all live, which is what every existing project has.
//
// Perf: blob positions, occupancy and the live drag are HIGH-RATE. They are drawn to a <canvas> from a
// requestAnimationFrame loop reading the stores and a ref — never React state, so a person walking
// across the room (or a rectangle being dragged) re-renders nothing. Only the zone LIST is React.

const SURFACES = ['SOL', 'MUR', 'SOL_MUR'];
const PALETTE = ['#f5a623', '#22d3ee', '#a855f7', '#7ed957', '#ef4444', '#38bdf8'];
const MIN_SIZE = 0.02;   // a rect smaller than this is a mis-click, not a zone
const HANDLE_PX = 9;     // corner grab radius, in screen px

const uid = (): string => crypto.randomUUID();
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
type Rect = { u0: number; v0: number; u1: number; v1: number };
const norm = (r: Rect): Rect => ({ u0: Math.min(r.u0, r.u1), v0: Math.min(r.v0, r.v1), u1: Math.max(r.u0, r.u1), v1: Math.max(r.v0, r.v1) });

// What a pointerdown started. `draw` = a new rect; `move` = drag the body; `resize` = drag one corner
// (the OPPOSITE corner is pinned, so the rect can be inverted through it and normalised on commit).
type Drag =
  | { kind: 'draw'; rect: Rect }
  | { kind: 'move'; id: string; rect: Rect; grabU: number; grabV: number; orig: Rect }
  | { kind: 'resize'; id: string; rect: Rect; anchorU: number; anchorV: number };

export const ZonePanel: React.FC<PanelProps> = () => {
  const scene = useHostScene3D();
  const list = useMemo(() => scene.trackingZones ?? [], [scene.trackingZones]);
  const active = scene.activeZoneIds;                    // undefined ⇒ every zone is live
  const [surface, setSurface] = useState('SOL');
  const [selId, setSelId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // THE LIVE DRAG LIVES IN A REF, NOT IN STATE. Committing per pointermove would write Scene3D — an App
  // state write, a re-render of every scene consumer, and a zones.configure() — on every mouse sample.
  // Same discipline as the timeline's loop-region drag: draft in a ref, ONE commit on release.
  const dragRef = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);       // for the hint text only

  const listRef = useRef(list); listRef.current = list;
  const surfaceRef = useRef(surface); surfaceRef.current = surface;
  const selRef = useRef(selId); selRef.current = selId;
  const activeRef = useRef(active); activeRef.current = active;

  const commit = (next: TrackingZone[]): void => setZones(next);
  const patchZone = (id: string, p: Partial<TrackingZone>): void =>
    commit(list.map((z) => (z.id === id ? { ...z, ...p } : z)));
  const isLive = (id: string): boolean => !active || active.includes(id);
  // Toggling "active in this scene" MATERIALISES the list on first use: absent means "all", so the
  // first time anything is switched off the implicit set has to become an explicit one.
  const toggleActive = (id: string): void => {
    const base = active ?? list.map((z) => z.id);
    setActiveZoneIds(base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
  };

  // ── The live map. One rAF loop, zero React. ─────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    const paint = (): void => {
      raf = requestAnimationFrame(paint);
      const cvs = canvasRef.current, box = boxRef.current;
      if (!cvs || !box) return;
      const w = box.clientWidth, h = box.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) {
        cvs.width = Math.round(w * dpr); cvs.height = Math.round(h * dpr);
        cvs.style.width = `${w}px`; cvs.style.height = `${h}px`;
      }
      const g = cvs.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      const X = (u: number): number => u * w;              // v is flipped here, once, for everything below
      const Y = (v: number): number => (1 - v) * h;

      g.fillStyle = '#0d0f13'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        g.beginPath(); g.moveTo((i / 4) * w, 0); g.lineTo((i / 4) * w, h); g.stroke();
        g.beginPath(); g.moveTo(0, (i / 4) * h); g.lineTo(w, (i / 4) * h); g.stroke();
      }

      const d = dragRef.current;
      for (const z of listRef.current) {
        if (z.surface !== surfaceRef.current) continue;
        // While this zone is being dragged, paint the DRAFT — the committed value is still the old one.
        const live = d && d.kind !== 'draw' && d.id === z.id ? norm(d.rect) : norm(z);
        const st = zones.getState(z.id);
        const sel = z.id === selRef.current;
        const inScene = !activeRef.current || activeRef.current.includes(z.id);
        const x0 = X(live.u0), x1 = X(live.u1), y0 = Y(live.v1), y1 = Y(live.v0);
        const col = z.color || PALETTE[0];
        // OCCUPIED IS THE STATE THAT MATTERS — it is what a trigger fires on, so it is what the
        // rectangle shouts. A zone this scene does not listen to is drawn hollow and dim: it exists in
        // the room but cannot fire here, and that has to be visible or an operator debugs the wrong thing.
        g.fillStyle = !inScene ? 'transparent' : st?.occupied ? `${col}44` : `${col}18`;
        if (inScene) g.fillRect(x0, y0, x1 - x0, y1 - y0);
        g.globalAlpha = inScene ? 1 : 0.35;
        g.strokeStyle = col; g.lineWidth = st?.occupied ? 2.5 : sel ? 2 : 1;
        g.setLineDash(inScene ? (sel ? [4, 3] : []) : [2, 4]);
        g.strokeRect(x0, y0, x1 - x0, y1 - y0);
        g.setLineDash([]);
        g.fillStyle = col; g.font = '10px system-ui, sans-serif';
        g.fillText(`${z.name}${st?.count ? ` · ${st.count}` : ''}`, x0 + 4, y0 + 12);
        // Corner handles, on the selected zone only — four small squares beat eight tiny ones at this size.
        if (sel && inScene) {
          g.fillStyle = col;
          for (const [hx, hy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) g.fillRect(hx - 3, hy - 3, 6, 6);
        }
        g.globalAlpha = 1;
      }

      if (d?.kind === 'draw') {
        const r = norm(d.rect);
        g.strokeStyle = '#ffffff'; g.setLineDash([5, 4]); g.lineWidth = 1.5;
        g.strokeRect(X(r.u0), Y(r.v1), X(r.u1) - X(r.u0), Y(r.v0) - Y(r.v1));
        g.setLineDash([]);
      }

      // Live blobs, raw (NOT people-merged): this is a diagnostic view, and an operator drawing a zone
      // needs to see what the tracker actually reports — including the venue's two-blobs-per-person, so
      // "why does minBlobs 2 fire for one visitor" is visible rather than mysterious.
      const track = trackingStore.getSurfaceTrack(surfaceRef.current);
      if (track) {
        g.fillStyle = '#22d3ee';
        for (const b of track.blobs.values()) {
          if (b.id === 0) continue;
          g.beginPath(); g.arc(X(b.u), Y(b.v), 4, 0, Math.PI * 2); g.fill();
        }
      }
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Pointer: draw a new zone, move one, or resize it by a corner ────────────────────────────────
  const toUV = (e: { clientX: number; clientY: number }): { u: number; v: number } => {
    const r = boxRef.current!.getBoundingClientRect();
    return { u: clamp01((e.clientX - r.left) / r.width), v: clamp01(1 - (e.clientY - r.top) / r.height) };
  };
  // Which corner of the selected zone is under the pointer? Returns the OPPOSITE corner (the anchor the
  // resize pivots around), or null. Measured in screen px so the grab area is the same at any zoom.
  const cornerAnchor = (z: TrackingZone, u: number, v: number): { au: number; av: number } | null => {
    const box = boxRef.current; if (!box) return null;
    const w = box.clientWidth, h = box.clientHeight;
    const r = norm(z);
    for (const [cu, cv, au, av] of [
      [r.u0, r.v0, r.u1, r.v1], [r.u1, r.v0, r.u0, r.v1],
      [r.u0, r.v1, r.u1, r.v0], [r.u1, r.v1, r.u0, r.v0],
    ]) {
      if (Math.abs((u - cu) * w) <= HANDLE_PX && Math.abs((v - cv) * h) <= HANDLE_PX) return { au, av };
    }
    return null;
  };
  const zoneAt = (u: number, v: number): TrackingZone | undefined =>
    // Last match wins, so the most recently drawn zone is on top — the same rule the compositor and the
    // timeline's overlapping clips use.
    [...list].reverse().find((z) => z.surface === surface && u >= Math.min(z.u0, z.u1) && u <= Math.max(z.u0, z.u1) && v >= Math.min(z.v0, z.v1) && v <= Math.max(z.v0, z.v1));

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    const p = toUV(e);
    const sel = list.find((z) => z.id === selId);
    // A corner of the SELECTED zone wins over everything — it is a deliberate 9px target.
    const anchor = sel && sel.surface === surface ? cornerAnchor(sel, p.u, p.v) : null;
    if (sel && anchor) dragRef.current = { kind: 'resize', id: sel.id, rect: { u0: anchor.au, v0: anchor.av, u1: p.u, v1: p.v }, anchorU: anchor.au, anchorV: anchor.av };
    else {
      const hit = zoneAt(p.u, p.v);
      if (hit) { setSelId(hit.id); dragRef.current = { kind: 'move', id: hit.id, rect: norm(hit), grabU: p.u, grabV: p.v, orig: norm(hit) }; }
      else { setSelId(null); dragRef.current = { kind: 'draw', rect: { u0: p.u, v0: p.v, u1: p.u, v1: p.v } }; }
    }
    setDragging(true);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current; if (!d) return;
    const p = toUV(e);
    if (d.kind === 'draw' || d.kind === 'resize') d.rect = { ...d.rect, u1: p.u, v1: p.v };
    else {
      // Translate, clamped so the WHOLE rect stays on the surface — clamping each corner independently
      // would squash the zone against the edge instead of stopping it there.
      const du = p.u - d.grabU, dv = p.v - d.grabV;
      const w = d.orig.u1 - d.orig.u0, h = d.orig.v1 - d.orig.v0;
      const u0 = Math.max(0, Math.min(1 - w, d.orig.u0 + du));
      const v0 = Math.max(0, Math.min(1 - h, d.orig.v0 + dv));
      d.rect = { u0, v0, u1: u0 + w, v1: v0 + h };
    }
  };
  const onPointerUp = (): void => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!d) return;
    const r = norm(d.rect);
    const tooSmall = r.u1 - r.u0 < MIN_SIZE || r.v1 - r.v0 < MIN_SIZE;
    if (d.kind === 'draw') {
      // A click, not a drag: silently ignored. Creating a zero-area zone would make a trigger that can
      // never fire and an operator who cannot see why.
      if (tooSmall) return;
      // NO dwell baked in: a fresh zone FOLLOWS THE VENUE-WIDE dwell (the on-site knob in the tracking
      // parameters). It only carries enterSec/exitSec once the operator deliberately overrides it below.
      const z: TrackingZone = {
        // The NAME is numbered from what is taken (zones get drawn, judged and re-drawn on site, so
        // deletions are the norm — and a duplicate `Zone 2` is picked from a dropdown in the Show
        // Machine, where it is unreadable). The COLOUR still cycles on the count: that is a palette
        // walk, and two zones sharing a hue is a cosmetic collision, not an ambiguous identity.
        id: uid(), name: nextNumberedName('Zone', list), surface, ...r,
        color: PALETTE[list.length % PALETTE.length], minBlobs: 1,
      };
      commit([...list, z]);
      setSelId(z.id);
      return;
    }
    // A resize dragged past the minimum is a mis-grab, not "make it disappear" — keep the old rect.
    if (tooSmall) return;
    patchZone(d.id, r);
  };

  const sel = list.find((z) => z.id === selId) ?? null;
  const track = trackingStore.getSurfaceTrack(surface);
  const dims = track && track.scaleX && track.scaleY ? `${track.scaleX.toFixed(2)} × ${track.scaleY.toFixed(2)} m` : 'size unknown';
  const hint = dragging ? 'release to apply'
    : sel ? 'drag the body to move · drag a corner to resize · drag empty space for a new zone'
      : 'drag on the map to draw a zone · click one to select it';

  return (
    <div className="h-full flex text-mini">
      {/* the map */}
      <div className="flex-1 min-w-0 flex flex-col p-2 gap-2">
        <div className="flex items-center gap-2">
          <span className="text-fg-3 text-micro">Surface</span>
          <select value={surface} onChange={(e) => setSurface(e.target.value)}
            className="bg-surface-0 border border-line-1 rounded px-1.5 py-0.5 text-fg-1 focus:border-accent outline-none">
            {[...new Set([...SURFACES, ...trackingStore.getSurfaces()])].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <span className="text-fg-3 text-micro">{dims}</span>
          <span className="ml-auto text-fg-3 text-micro truncate">{hint}</span>
        </div>
        <div ref={boxRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          className="flex-1 min-h-0 relative rounded border border-line-1 overflow-hidden cursor-crosshair">
          <canvas ref={canvasRef} className="absolute inset-0" />
        </div>
        <div className="text-fg-3 text-micro">
          Origin is bottom-left, matching the tracker. Zones are normalized and belong to the ROOM — they
          are not captured into a scene, so a GO never changes them; the eye toggle sets which ones the
          current scene listens to.
        </div>
      </div>

      {/* the list + the selected zone's rules */}
      <div className="w-64 shrink-0 border-l border-line-1 p-2 space-y-2 overflow-auto">
        <div className="flex items-center gap-1">
          <span className="text-fg-2 font-medium">Zones</span>
          <span className="text-fg-3 text-micro">{list.length}</span>
        </div>
        {!list.length && <div className="text-fg-3 italic text-micro">None yet — drag a rectangle on the map.</div>}
        {list.map((z) => {
          const st = zones.getState(z.id);
          const live = isLive(z.id);
          return (
            <div key={z.id} className={`flex items-center gap-1.5 px-1.5 py-1 rounded border ${z.id === selId ? 'border-accent bg-surface-2' : 'border-line-1 bg-surface-1'}`}>
              <button onClick={() => { setSelId(z.id); setSurface(z.surface); }} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: z.color || PALETTE[0], opacity: live ? 1 : 0.3 }} />
                <span className={`truncate ${live ? 'text-fg-1' : 'text-fg-3'}`}>{z.name}</span>
                <span className="ml-auto text-micro text-fg-3">{z.surface}</span>
              </button>
              {st?.occupied && <Users size={11} className="text-warn shrink-0" />}
              {/* PER-SCENE: does the CURRENT look listen to this zone? A rule naming a zone that is off
                  here is inert in this scene — the trigger inspector says so too. */}
              <button onClick={() => toggleActive(z.id)} title={live ? 'Active in this scene — click to ignore it here' : 'Ignored in this scene — click to listen to it'}
                className={`shrink-0 ${live ? 'text-accent' : 'text-fg-3'}`}>
                {live ? <Eye size={12} /> : <EyeOff size={12} />}
              </button>
            </div>
          );
        })}

        {sel && (
          <div className="pt-2 mt-2 border-t border-line-1 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-fg-2 font-medium">Zone</span>
              <button onClick={() => { commit(list.filter((z) => z.id !== sel.id)); setSelId(null); }}
                className="text-fg-3 hover:text-red-400"><Trash2 size={12} /></button>
            </div>
            <label className="block">
              <span className="text-fg-3 text-micro">Name</span>
              <input value={sel.name} onChange={(e) => patchZone(sel.id, { name: e.target.value })}
                className="w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none" />
            </label>
            <label className="block">
              <span className="text-fg-3 text-micro">People needed</span>
              <input type="number" min={1} step={1} value={sel.minBlobs ?? 1}
                onChange={(e) => patchZone(sel.id, { minBlobs: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
                className="w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none" />
            </label>
            {/* DWELL: venue-wide by default, per-zone only if the operator deliberately overrides. The
                on-site knob lives in the tracking parameters (Smoothing / Merge radius / Zone dwell) so
                the whole room can be tuned at once; this override is for the odd zone that needs to be
                quicker or slower than the rest. Toggling the override ON seeds the fields from the venue
                value (so it is a starting point, not a jump); toggling OFF clears both back to inherit. */}
            {(() => {
              const overriding = sel.enterSec != null || sel.exitSec != null;
              const venue = zones.getVenueDwell();
              return (
                <div className="space-y-1.5">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={overriding}
                      onChange={(e) => patchZone(sel.id, e.target.checked
                        ? { enterSec: venue.enterSec, exitSec: venue.exitSec }
                        : { enterSec: undefined, exitSec: undefined })} />
                    <span className="text-fg-2">Override dwell for this zone</span>
                  </label>
                  {overriding ? (
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="text-fg-3 text-micro">Enter dwell (s)</span>
                        <input type="number" min={0} step={0.1} value={sel.enterSec ?? venue.enterSec}
                          onChange={(e) => patchZone(sel.id, { enterSec: Math.max(0, Number(e.target.value) || 0) })}
                          className="w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none" />
                      </label>
                      <label className="block">
                        <span className="text-fg-3 text-micro">Exit dwell (s)</span>
                        <input type="number" min={0} step={0.1} value={sel.exitSec ?? venue.exitSec}
                          onChange={(e) => patchZone(sel.id, { exitSec: Math.max(0, Number(e.target.value) || 0) })}
                          className="w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none" />
                      </label>
                    </div>
                  ) : (
                    <div className="text-fg-3 text-micro">
                      Following venue: enter {venue.enterSec}s · exit {venue.exitSec}s
                      <span className="text-fg-2"> (tracking parameters)</span>
                    </div>
                  )}
                </div>
              );
            })()}
            {/* The dwells are the difference between a trigger and a tripwire — say what they are FOR,
                because their right values are venue-specific and nobody guesses them from the label. */}
            <div className="text-fg-3 italic text-micro">
              Enter dwell debounces a flickering tracker into one arrival; exit dwell keeps a person who
              briefly disappears from ending the state they are standing in.
            </div>
            <div className="text-fg-3 text-micro">
              Use it from a transition: trigger <span className="text-fg-2">LiDAR zone</span> in the Show Machine.
            </div>
          </div>
        )}

        {/* Escape hatch for a surface the tracker has not announced yet (nothing to drag on). */}
        <button onClick={() => {
          const z: TrackingZone = { id: uid(), name: nextNumberedName('Zone', list), surface, u0: 0.35, v0: 0.35, u1: 0.65, v1: 0.65, color: PALETTE[list.length % PALETTE.length], minBlobs: 1 };
          commit([...list, z]); setSelId(z.id);
        }} className="w-full inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3">
          <Plus size={12} /> Zone in the centre
        </button>
      </div>
    </div>
  );
};
