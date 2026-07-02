import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Box, Hand, MousePointer } from 'lucide-react';
import type { CamMask } from '../../../../shared/protocol';
import type { ColorFrame } from '../calibCapture';

// A large, zoomable RGB camera viewport for precise calibration point-picking. The owning wizard runs
// the camera grab loop and pushes each colour frame in via the imperative `paint()` handle; this
// component owns the pan/zoom transform, the marker / mask / board-detect overlays, the magnifier
// loupe, and the transform-aware click→camera-pixel mapping. It replaces the old object-contain
// thumbnail + clickToCamPx so picking stays exact at any zoom level.

export type Detect = { found: true; corners: number[]; w: number; h: number } | { found: false };

export interface CameraViewportHandle {
  /** Push a colour frame to display (called from the wizard's grab loop). */
  paint: (frame: ColorFrame) => void;
}

interface Props {
  active: boolean;                                   // camera is on (frames arriving)
  pickActive?: boolean;                              // clicking places a calibration point
  maskMode?: boolean;                                // clicking adds a mask-polygon vertex
  picks?: { camPx: [number, number] }[];             // placed picks → numbered cyan markers
  pending?: [number, number] | null;                // point awaiting its model match → dashed ring
  selectedPick?: number | null;                      // index of the correspondence being edited
  mask?: CamMask | null;                             // committed exclusion polygons
  maskDraft?: [number, number][];                    // in-progress polygon
  detect?: Detect;                                   // board-detect corners (board flow)
  onPick?: (camPx: [number, number]) => void;
  onSelectPick?: (i: number | null) => void;         // a placed marker was clicked → select it for editing
  onMovePick?: (i: number, camPx: [number, number]) => void; // selected marker dragged / nudged → new camera pixel
  onMaskPoint?: (camPx: [number, number]) => void;
  onMaskClose?: () => void;
  placeholder?: string;
}

const MARKER = '#00e5ff';
const PENDING = '#ffaa00';
const MIN_SCALE = 0.05, MAX_SCALE = 64;
const LOUPE = 132;       // loupe box size (css px)
const LOUPE_MAG = 6;     // loupe magnification

export const CameraViewport = forwardRef<CameraViewportHandle, Props>((props, ref) => {
  const { active, pickActive, maskMode, picks, pending, selectedPick, mask, maskDraft, detect,
    onPick, onSelectPick, onMovePick, onMaskPoint, onMaskClose, placeholder = 'start the camera' } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);     // displayed image
  const overlayRef = useRef<HTMLCanvasElement | null>(null);  // markers / mask / detect / loupe

  // Latest frame kept on an offscreen canvas at native resolution (also the loupe sample source).
  const imgRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<{ w: number; h: number } | null>(null);

  // View transform: image-pixel → css-pixel `scale`, with the image top-left at (tx, ty) css px.
  const view = useRef({ scale: 1, tx: 0, ty: 0, fitted: false });
  const [zoomPct, setZoomPct] = useState(100);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null); // live source size (feed confirmation)
  const cursor = useRef<{ x: number; y: number } | null>(null); // css px in host, for the loupe
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const dragMarker = useRef<number | null>(null); // index of the marker being dragged (edit), or null

  // Mirror overlay props into refs so the rAF redraw always reads the latest without re-subscribing.
  const od = useRef({ picks, pending, mask, maskDraft, detect, pickActive, maskMode, selectedPick });
  od.current = { picks, pending, mask, maskDraft, detect, pickActive, maskMode, selectedPick };

  const hostSize = () => {
    const h = hostRef.current;
    return { w: h?.clientWidth ?? 0, h: h?.clientHeight ?? 0 };
  };

  const camToScreen = (u: number, v: number): [number, number] => {
    const { scale, tx, ty } = view.current;
    return [tx + u * scale, ty + v * scale];
  };
  const screenToCam = (x: number, y: number): [number, number] => {
    const { scale, tx, ty } = view.current;
    return [(x - tx) / scale, (y - ty) / scale];
  };

  const fit = useCallback(() => {
    const f = frameRef.current; if (!f) return;
    const { w, h } = hostSize(); if (!w || !h) return;
    const scale = Math.min(w / f.w, h / f.h);
    view.current = { scale, tx: (w - f.w * scale) / 2, ty: (h - f.h * scale) / 2, fitted: true };
    setZoomPct(Math.round(scale * 100));
    redraw();
  }, []);

  const setScaleAbout = (next: number, cx: number, cy: number) => {
    const f = frameRef.current; if (!f) return;
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    const [cu, cv] = screenToCam(cx, cy);
    view.current.scale = clamped;
    view.current.tx = cx - cu * clamped;
    view.current.ty = cy - cv * clamped;
    setZoomPct(Math.round(clamped * 100));
    redraw();
  };

  // --- drawing ---------------------------------------------------------------
  const drawBase = () => {
    const cv = baseRef.current, img = imgRef.current, f = frameRef.current;
    if (!cv || !img || !f) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = hostSize();
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = view.current.scale < 3; // crisp pixels when zoomed in
    ctx.clearRect(0, 0, w, h);
    const { scale, tx, ty } = view.current;
    ctx.drawImage(img, tx, ty, f.w * scale, f.h * scale);
  };

  const drawOverlay = () => {
    const cv = overlayRef.current, f = frameRef.current;
    if (!cv || !f) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = hostSize();
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { picks: ps, pending: pend, mask: mk, maskDraft: draft, detect: det } = od.current;

    // Camera exclusion mask (filled committed polys + dashed draft) — fixed screen line widths.
    const ring = (pts: [number, number][], close: boolean) => {
      if (!pts.length) return;
      ctx.beginPath();
      const [x0, y0] = camToScreen(pts[0][0], pts[0][1]); ctx.moveTo(x0, y0);
      for (let i = 1; i < pts.length; i++) { const [x, y] = camToScreen(pts[i][0], pts[i][1]); ctx.lineTo(x, y); }
      if (close) ctx.closePath();
    };
    ctx.lineWidth = 1.5;
    for (const poly of mk?.polys ?? []) {
      if (poly.length < 3) continue;
      ring(poly, true); ctx.fillStyle = 'rgba(255,40,40,0.28)'; ctx.fill();
      ctx.strokeStyle = '#ff5050'; ctx.stroke();
    }
    if (draft?.length) {
      ring(draft, false); ctx.strokeStyle = '#ff8080'; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ff8080';
      for (const [u, v] of draft) { const [x, y] = camToScreen(u, v); ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }
    }

    // Board-detect corners (board flow).
    if (det?.found) {
      ctx.fillStyle = '#00ffaa';
      for (let i = 0; i < det.corners.length; i += 2) {
        const [x, y] = camToScreen(det.corners[i], det.corners[i + 1]);
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Numbered pick markers (screen-constant size) + pending dashed ring. The selected one is drawn
    // larger in white with a filled centre dot so it reads as the editable handle.
    const r = 8;
    const sel = od.current.selectedPick;
    ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    (ps ?? []).forEach((p, i) => {
      const [x, y] = camToScreen(p.camPx[0], p.camPx[1]);
      const on = i === sel;
      const rr = on ? r * 1.35 : r;
      ctx.strokeStyle = on ? '#ffffff' : MARKER; ctx.lineWidth = on ? 2.5 : 2;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - rr * 1.7, y); ctx.lineTo(x + rr * 1.7, y); ctx.moveTo(x, y - rr * 1.7); ctx.lineTo(x, y + rr * 1.7); ctx.stroke();
      if (on) { ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill(); }
      const lx = x + rr * 2.2, ly = y - rr * 2.2, label = String(i + 1);
      ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(label, lx, ly);
      ctx.fillStyle = on ? '#ffffff' : MARKER; ctx.fillText(label, lx, ly);
    });
    if (pend) {
      const [x, y] = camToScreen(pend[0], pend[1]);
      ctx.strokeStyle = PENDING; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.arc(x, y, r * 1.25, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x - r * 1.9, y); ctx.lineTo(x + r * 1.9, y); ctx.moveTo(x, y - r * 1.9); ctx.lineTo(x, y + r * 1.9); ctx.stroke();
    }

    // Magnifier loupe — only while picking and hovering, to place sub-pixel points precisely.
    if ((od.current.pickActive || od.current.maskMode) && cursor.current) drawLoupe(ctx, w, h);
  };

  const drawLoupe = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const img = imgRef.current, f = frameRef.current, c = cursor.current;
    if (!img || !f || !c) return;
    const [cu, cv] = screenToCam(c.x, c.y);
    if (cu < 0 || cv < 0 || cu > f.w || cv > f.h) return;
    // Loupe sits in the corner farthest from the cursor so it never hides the point.
    const lx = c.x < w / 2 ? w - LOUPE - 12 : 12;
    const ly = c.y < h / 2 ? h - LOUPE - 12 : 12;
    const srcHalf = LOUPE / (2 * LOUPE_MAG); // half-width of the sampled region, in cam px
    ctx.save();
    ctx.beginPath(); ctx.rect(lx, ly, LOUPE, LOUPE); ctx.clip();
    ctx.fillStyle = '#000'; ctx.fillRect(lx, ly, LOUPE, LOUPE);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, cu - srcHalf, cv - srcHalf, srcHalf * 2, srcHalf * 2, lx, ly, LOUPE, LOUPE);
    // crosshair at the loupe centre (= cursor cam-pixel)
    ctx.strokeStyle = PENDING; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(lx + LOUPE / 2, ly); ctx.lineTo(lx + LOUPE / 2, ly + LOUPE);
    ctx.moveTo(lx, ly + LOUPE / 2); ctx.lineTo(lx + LOUPE, ly + LOUPE / 2); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#000a'; ctx.lineWidth = 2; ctx.strokeRect(lx, ly, LOUPE, LOUPE);
    ctx.fillStyle = '#fff'; ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(`${cu.toFixed(0)},${cv.toFixed(0)}`, lx + 3, ly + LOUPE - 2);
  };

  const rafPending = useRef(false);
  const redraw = () => {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => { rafPending.current = false; drawBase(); drawOverlay(); });
  };

  useImperativeHandle(ref, () => ({
    paint: (frame: ColorFrame) => {
      let img = imgRef.current;
      if (!img) { img = document.createElement('canvas'); imgRef.current = img; }
      if (img.width !== frame.w || img.height !== frame.h) { img.width = frame.w; img.height = frame.h; }
      const ctx = img.getContext('2d'); if (!ctx) return;
      ctx.putImageData(new ImageData(frame.data, frame.w, frame.h), 0, 0);
      const sizeChanged = !frameRef.current || frameRef.current.w !== frame.w || frameRef.current.h !== frame.h;
      frameRef.current = { w: frame.w, h: frame.h };
      if (sizeChanged) setDims({ w: frame.w, h: frame.h });
      // Fit until it succeeds (host may not be laid out yet) or the native resolution changes; once the
      // user has zoomed/panned (fitted=true) we keep their view across frames.
      if (!view.current.fitted || sizeChanged) fit(); else redraw();
    },
  }), [fit]);

  // Redraw overlays when their data changes (markers, pending, selection, mask, detect).
  useEffect(() => { redraw(); }, [picks, pending, selectedPick, mask, maskDraft, detect]);

  // Refit on container resize (only while the user hasn't taken manual control via zoom/pan).
  useEffect(() => {
    const el = hostRef.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- interaction -----------------------------------------------------------
  const onWheel = (e: React.WheelEvent) => {
    if (!frameRef.current) return;
    const r = hostRef.current!.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    setScaleAbout(view.current.scale * factor, e.clientX - r.left, e.clientY - r.top);
  };

  const localXY = (e: React.PointerEvent | React.MouseEvent): [number, number] => {
    const r = hostRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const clampedCam = (x: number, y: number): [number, number] | null => {
    const f = frameRef.current; if (!f) return null;
    const [u, v] = screenToCam(x, y);
    if (u < 0 || v < 0 || u > f.w || v > f.h) return null;
    return [u, v];
  };

  const picking = !!(pickActive || maskMode);

  // Closest placed marker within ~11 px of the cursor (screen space), or null. Used to select/grab an
  // already-placed point for editing instead of placing a new one or panning.
  const hitMarker = (x: number, y: number): number | null => {
    const ps = od.current.picks; if (!ps?.length) return null;
    let best = -1, bestD = 12;
    for (let i = 0; i < ps.length; i++) {
      const [mx, my] = camToScreen(ps[i].camPx[0], ps[i].camPx[1]);
      const d = Math.hypot(mx - x, my - y);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best < 0 ? null : best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const [x, y] = localXY(e);
    // Left-click on an existing marker → select it and start dragging it (edit its camera pixel).
    if (e.button === 0 && onMovePick) {
      const hit = hitMarker(x, y);
      if (hit != null) {
        dragMarker.current = hit; onSelectPick?.(hit);
        (e.target as Element).setPointerCapture?.(e.pointerId); e.preventDefault();
        return;
      }
    }
    // Middle-button, or any drag when not in a picking mode, pans the view.
    if (e.button === 1 || (!picking && e.button === 0)) {
      drag.current = { x, y, tx: view.current.tx, ty: view.current.ty, moved: false };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      e.preventDefault();
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const [x, y] = localXY(e);
    cursor.current = { x, y };
    if (dragMarker.current != null) {
      const f = frameRef.current;
      if (f) {
        const [u, v] = screenToCam(x, y);
        onMovePick?.(dragMarker.current, [Math.max(0, Math.min(f.w, u)), Math.max(0, Math.min(f.h, v))]);
      }
      redraw(); return;
    }
    if (drag.current) {
      const dx = x - drag.current.x, dy = y - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.current.moved = true;
      view.current.tx = drag.current.tx + dx;
      view.current.ty = drag.current.ty + dy;
    }
    redraw();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragMarker.current != null) { dragMarker.current = null; redraw(); return; }
    const wasDrag = drag.current?.moved;
    drag.current = null;
    if (wasDrag || !picking || e.button !== 0) { redraw(); return; }
    const [x, y] = localXY(e);
    const cam = clampedCam(x, y);
    if (!cam) return;
    if (maskMode) onMaskPoint?.(cam); else onPick?.(cam);
  };
  const onPointerLeave = () => { cursor.current = null; drag.current = null; dragMarker.current = null; redraw(); };
  const onDblClick = () => { if (maskMode) onMaskClose?.(); };

  // Arrow-key nudge of the selected marker (sub-pixel precision), active while the pointer is over the
  // viewport so it doesn't fight the 3D orbit/keyboard. Shift = 5 px.
  useEffect(() => {
    if (selectedPick == null || !onMovePick) return;
    const onKey = (e: KeyboardEvent) => {
      if (!cursor.current) return;
      let dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -1; else if (e.key === 'ArrowRight') dx = 1;
      else if (e.key === 'ArrowUp') dy = -1; else if (e.key === 'ArrowDown') dy = 1; else return;
      const mul = e.shiftKey ? 5 : 1;
      const p = od.current.picks?.[selectedPick]; const f = frameRef.current;
      if (!p || !f) return;
      e.preventDefault();
      onMovePick(selectedPick, [Math.max(0, Math.min(f.w, p.camPx[0] + dx * mul)), Math.max(0, Math.min(f.h, p.camPx[1] + dy * mul))]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedPick, onMovePick]);

  return (
    <div className="absolute inset-0 bg-black select-none">
      <div
        ref={hostRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDblClick}
        className={`absolute inset-0 overflow-hidden ${picking ? 'cursor-crosshair' : 'cursor-grab'}`}
      >
        <canvas ref={baseRef} className="absolute inset-0 w-full h-full" />
        <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
        {!active && (
          <div className="absolute inset-0 grid place-items-center text-fg-3 text-xs">
            <span className="flex items-center gap-1.5"><Box size={16} /> {placeholder}</span>
          </div>
        )}
      </div>

      {/* Zoom toolbar */}
      {active && (
        <div className="absolute top-2 right-2 flex items-center gap-1 bg-surface-2/80 backdrop-blur-sm border border-line-1 rounded-[var(--r-sm)] px-1 py-0.5 text-fg-2">
          <button title="Zoom out" onClick={() => { const { w, h } = hostSize(); setScaleAbout(view.current.scale / 1.3, w / 2, h / 2); }} className="p-1 hover:text-fg-1"><ZoomOut size={14} /></button>
          <span className="num text-[10px] w-10 text-center tabular-nums">{zoomPct}%</span>
          <button title="Zoom in" onClick={() => { const { w, h } = hostSize(); setScaleAbout(view.current.scale * 1.3, w / 2, h / 2); }} className="p-1 hover:text-fg-1"><ZoomIn size={14} /></button>
          <button title="Fit" onClick={fit} className="p-1 hover:text-fg-1"><Maximize2 size={14} /></button>
        </div>
      )}

      {/* Live source readout (confirms the RGB feed is arriving) */}
      {active && dims && (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-surface-2/80 backdrop-blur-sm border border-line-1 rounded-[var(--r-sm)] px-2 py-0.5 text-[10px] text-fg-2 num">
          <span className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse" /> {dims.w}×{dims.h} RGB
        </div>
      )}

      {/* Mode hint */}
      {active && picking && (
        <div className="absolute bottom-2 left-2 flex items-center gap-1.5 bg-surface-2/80 backdrop-blur-sm border border-line-1 rounded-[var(--r-sm)] px-2 py-1 text-[10px] text-fg-2">
          {maskMode ? <><Hand size={12} className="text-danger" /> click to outline · double-click to close</> : <><MousePointer size={12} className="text-accent" /> scroll to zoom · drag (no pick) to pan · click to place</>}
        </div>
      )}
    </div>
  );
});

CameraViewport.displayName = 'CameraViewport';
