// Calibration's projector-window rendering — a projector-panel contribution (Stage 3).
//
// Moved wholesale out of the host ProjectorApp. This full-window overlay mounts on top of the projector
// window's base GL canvas (the base warp/output loop never reads calib mode, so the overlays just sit
// above it) and owns the three calibration display modes:
//   • 'pattern'   — a raw structured-light field at native resolution into an opaque 2D canvas (NO GL
//                   warp/gamma — the bits must be pixel-exact), then a double-rAF `patternShown` ack so
//                   main grabs the camera in sync + learns the projector raster.
//   • 'crosshair' — an aim crosshair the operator drags/nudges onto a known venue feature; reports its
//                   projector-raster pixel live and confirms on Enter (→ pose pairing in calibWorkspace).
//   • 'render'    — render-from-projector: the venue 3D scene from the matched virtual projector.
// It talks to main over the projector bridge via the panel context (onMessage / send) — the same
// MessagePort the base window uses — so nothing here goes through the host.

import React, { useEffect, useRef, useState } from 'react';
import type { ProjectorPanelContext } from '@artlux/sdk/renderer';
import type { MainToProjector, ProjectorToMain } from '@/projector/bridge'; // host bridge types — transitional
import type { Scene3D, ProjectorCalibration } from '../../../shared/protocol';
import { fillPattern, type CalibPatternKind } from './graycode';
import { ProjectorScene } from './ProjectorScene';

type CalibMode = 'idle' | 'pattern' | 'crosshair' | 'render';

export const CalibProjector: React.FC<{ ctx: ProjectorPanelContext; size: { w: number; h: number } }> = ({ ctx, size }) => {
  const send = (m: ProjectorToMain) => ctx.send(m);

  const calibModeRef = useRef<CalibMode>('idle');
  const [calibMode, setCalibMode] = useState<CalibMode>('idle');
  const patternRef = useRef<{ kind: CalibPatternKind; index: number; rgb?: [number, number, number] } | null>(null);
  const patternCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const crosshairRef = useRef<[number, number]>([0.5, 0.5]);
  const [crosshair, setCrosshairState] = useState<[number, number]>([0.5, 0.5]);
  const setCrosshair = (p: [number, number]) => { crosshairRef.current = p; setCrosshairState(p); };

  const [scene3D, setScene3D] = useState<Scene3D | null>(null);
  const [calibration, setCalibration] = useState<ProjectorCalibration | null>(null);
  const [modelUrls, setModelUrls] = useState<Record<string, string>>({});
  const urlCacheRef = useRef<Record<string, string>>({});

  // Subscribe to the main→projector calib messages over the panel context.
  useEffect(() => {
    return ctx.onMessage((raw) => {
      const m = raw as MainToProjector;
      if (m.t === 'calib') {
        calibModeRef.current = m.mode;
        setCalibMode(m.mode);
        if (m.mode !== 'pattern') patternRef.current = null;
        if (m.calibration !== undefined) setCalibration(m.calibration);
      } else if (m.t === 'calibPattern') {
        patternRef.current = { kind: m.kind, index: m.index, rgb: m.rgb };
      } else if (m.t === 'scene') {
        setScene3D(m.scene3D);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Structured-light: draw the requested pattern raw (no GL warp/gamma — bits must be pixel-exact) into
  // an opaque 2D overlay at native resolution, then ack patternShown after it is actually on screen
  // (double-rAF) so the main window grabs the camera in sync. Reports the projector raster so main knows
  // the resolution for decode + calibrateProjector.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const pat = patternRef.current;
      const cv = patternCanvasRef.current;
      if (calibModeRef.current !== 'pattern' || !pat || !cv) return;
      patternRef.current = null; // consume
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(window.innerWidth * dpr));
      const h = Math.max(1, Math.round(window.innerHeight * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const g = cv.getContext('2d');
      if (!g) return;
      const img = g.createImageData(w, h);
      fillPattern(img.data, w, h, pat.kind, pat.index, pat.rgb);
      g.putImageData(img, 0, 0);
      requestAnimationFrame(() => requestAnimationFrame(() => send({ t: 'patternShown', index: pat.index, projW: w, projH: h })));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pose capture: drag / arrow-nudge the aim crosshair (Shift ×10 px, Shift+Alt = 0.1 px fine), and
  // report its projector-raster pixel live; Enter confirms the current aim.
  const reportCrosshair = () => {
    const dpr = window.devicePixelRatio || 1;
    const [cx, cy] = crosshairRef.current;
    send({ t: 'calibCrosshair', pixel: [cx * window.innerWidth * dpr, cy * window.innerHeight * dpr] });
  };
  useEffect(() => {
    if (calibMode !== 'crosshair') return;
    const dpr = window.devicePixelRatio || 1;
    const place = (clientX: number, clientY: number) => {
      setCrosshair([Math.min(1, Math.max(0, clientX / window.innerWidth)), Math.min(1, Math.max(0, clientY / window.innerHeight))]);
      reportCrosshair();
    };
    const onPointer = (e: PointerEvent) => { if (e.type === 'pointerdown' || e.buttons === 1) place(e.clientX, e.clientY); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); send({ t: 'calibConfirm' }); return; }
      const dir: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const d = dir[e.key];
      if (!d) return;
      e.preventDefault();
      const step = (e.shiftKey && e.altKey) ? 0.1 : e.shiftKey ? 10 : 1; // projector px
      const [cx, cy] = crosshairRef.current;
      setCrosshair([
        Math.min(1, Math.max(0, cx + (d[0] * step) / (window.innerWidth * dpr))),
        Math.min(1, Math.max(0, cy + (d[1] * step) / (window.innerHeight * dpr))),
      ]);
      reportCrosshair();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('pointermove', onPointer);
    window.addEventListener('keydown', onKey);
    window.focus();
    reportCrosshair();
    return () => { window.removeEventListener('pointerdown', onPointer); window.removeEventListener('pointermove', onPointer); window.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calibMode]);

  // Render-from-projector: load the venue GLBs (same readModel→Blob path as the Scene window) so the
  // R3F ProjectorScene can render them from the calibrated camera.
  useEffect(() => {
    const models = (scene3D?.models ?? []).filter((m) => m.kind !== 'plane' && m.path);
    let alive = true;
    (async () => {
      const paths = Array.from(new Set(models.map((m) => m.path)));
      for (const path of paths) {
        if (urlCacheRef.current[path]) continue;
        const bytes = await window.artlux?.readModel?.(path);
        if (!alive || !bytes) continue;
        urlCacheRef.current[path] = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'model/gltf-binary' }));
      }
      if (!alive) return;
      const next: Record<string, string> = {};
      for (const m of models) { const u = urlCacheRef.current[m.path]; if (u) next[m.id] = u; }
      setModelUrls(next);
    })();
    return () => { alive = false; };
  }, [scene3D]);

  return (
    <>
      {/* Render-from-projector: the venue 3D scene from the matched virtual projector (true mapping). */}
      {calibMode === 'render' && calibration && scene3D && (
        <div style={{ position: 'absolute', inset: 0 }}>
          <ProjectorScene scene3D={scene3D} modelUrls={modelUrls} calibration={calibration} />
        </div>
      )}

      {/* Structured-light pattern overlay — opaque, on top, raw pixels (no GL). */}
      <canvas
        ref={patternCanvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: '#000', display: calibMode === 'pattern' ? 'block' : 'none' }}
      />

      {/* Pose-capture aim crosshair — point it at a known venue feature, Enter to confirm. */}
      {calibMode === 'crosshair' && (
        <>
          <svg width={size.w} height={size.h} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            <line x1={0} y1={crosshair[1] * size.h} x2={size.w} y2={crosshair[1] * size.h} stroke="rgba(0,255,170,0.5)" strokeWidth={1} />
            <line x1={crosshair[0] * size.w} y1={0} x2={crosshair[0] * size.w} y2={size.h} stroke="rgba(0,255,170,0.5)" strokeWidth={1} />
            <circle cx={crosshair[0] * size.w} cy={crosshair[1] * size.h} r={10} fill="none" stroke="#00ffaa" strokeWidth={1.5} />
            <circle cx={crosshair[0] * size.w} cy={crosshair[1] * size.h} r={1.5} fill="#00ffaa" />
          </svg>
          <div style={hintBox}>Aim at a known feature · drag / arrows (Shift ×10, Shift+Alt ×0.1 px) · <b>Enter</b> confirm</div>
        </>
      )}
    </>
  );
};

const hintBox: React.CSSProperties = {
  position: 'absolute', left: '50%', bottom: 24, transform: 'translateX(-50%)',
  padding: '6px 12px', borderRadius: 6, background: 'rgba(0,0,0,0.7)', color: '#ddd',
  font: '12px system-ui', whiteSpace: 'nowrap', pointerEvents: 'none',
};
