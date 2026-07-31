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
import { ProjectorScene, type BlendLook } from './ProjectorScene';
import { setSurfaceFrame, clearSurfaceFrame } from './surfaceFrameChannel';

type CalibMode = 'idle' | 'pattern' | 'crosshair' | 'render';

// Value equality for the blend look. `blend` is compared by IDENTITY on purpose: it is a solved map
// of thousands of numbers that only ever changes by being re-solved, so a deep compare would cost
// more than the texture upload it is protecting against.
const sameTriple = (a?: readonly number[], b?: readonly number[]): boolean =>
  a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
function sameLook(a: BlendLook, b: BlendLook): boolean {
  const x = a.softEdge, y = b.softEdge;
  const softSame = x === y || (!!x && !!y && x.left === y.left && x.right === y.right
    && x.top === y.top && x.bottom === y.bottom && x.gamma === y.gamma);
  return softSame && sameTriple(a.colorGain, b.colorGain) && sameTriple(a.blackLift, b.blackLift)
    && (a.blend ?? null) === (b.blend ?? null);
}

export const CalibProjector: React.FC<{ ctx: ProjectorPanelContext; size: { w: number; h: number } }> = ({ ctx, size }) => {
  const send = (m: ProjectorToMain) => ctx.send(m);

  const calibModeRef = useRef<CalibMode>('idle');
  const [calibMode, setCalibMode] = useState<CalibMode>('idle');
  const patternRef = useRef<{ kind: CalibPatternKind; index: number; rgb?: [number, number, number]; dots?: [number, number][] } | null>(null);
  const patternCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const crosshairRef = useRef<[number, number]>([0.5, 0.5]);
  const [crosshair, setCrosshairState] = useState<[number, number]>([0.5, 0.5]);
  const setCrosshair = (p: [number, number]) => { crosshairRef.current = p; setCrosshairState(p); };

  const [scene3D, setScene3D] = useState<Scene3D | null>(null);
  const [calibration, setCalibration] = useState<ProjectorCalibration | null>(null);
  // Placed pose picks (raster px) + which one is being edited, pushed by the wizard so the operator
  // sees the already-anchored features numbered ON the projection itself.
  const [points, setPoints] = useState<[number, number][]>([]);
  const [predicted, setPredicted] = useState<([number, number] | null)[]>([]);
  const [selectedPt, setSelectedPt] = useState<number | null>(null);
  const [meshLook, setMeshLook] = useState<'shaded' | 'edges' | 'wireframe'>('shaded');
  const surfaceIdRef = useRef<string | null>(null); // which surface this window renders (from `config`)
  // The output's blend look. Read off the SAME `config` message the base window uses — this panel
  // already sees every main→projector message and simply ignored that one. Without it, render mode
  // (an opaque overlay above the base canvas) drops the soft edge the operator set. See ProjectorScene.
  const [look, setLook] = useState<BlendLook>({});
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
        if (m.points !== undefined) setPoints(m.points);
        if (m.predicted !== undefined) setPredicted(m.predicted);
        if (m.selected !== undefined) setSelectedPt(m.selected);
        if (m.meshLook !== undefined) setMeshLook(m.meshLook);
        // Jump the crosshair (re-aiming an existing point starts FROM that point, not from wherever
        // the crosshair last was) and report it, so main's pending aim matches what is on screen.
        if (m.crosshair) {
          const dpr = window.devicePixelRatio || 1;
          const p: [number, number] = [
            Math.min(1, Math.max(0, m.crosshair[0] / (window.innerWidth * dpr))),
            Math.min(1, Math.max(0, m.crosshair[1] / (window.innerHeight * dpr))),
          ];
          crosshairRef.current = p; setCrosshairState(p);
          send({ t: 'calibCrosshair', pixel: [p[0] * window.innerWidth * dpr, p[1] * window.innerHeight * dpr] });
        }
      } else if (m.t === 'calibPattern') {
        patternRef.current = { kind: m.kind, index: m.index, rgb: m.rgb, dots: m.dots };
      } else if (m.t === 'frame') {
        // This window's own surface picture. ProjectorApp has already taken it for the base canvas
        // (panels are fanned out after its own handling) and owns closing it — we only publish the
        // current reference so a mesh BOUND to this surface can texture from it. See
        // surfaceFrameChannel: no React state, this arrives ~30×/s.
        if (surfaceIdRef.current) setSurfaceFrame(surfaceIdRef.current, m.bitmap);
      } else if (m.t === 'frameIdle') {
        if (surfaceIdRef.current) setSurfaceFrame(surfaceIdRef.current, null);
      } else if (m.t === 'scene') {
        setScene3D(m.scene3D);
      } else if (m.t === 'config') {
        surfaceIdRef.current = m.surface.id; // which surface this window IS — the mesh binding target
        // ONLY ON A REAL CHANGE OF LOOK. This used to take the new object every time, on the stated
        // assumption that "config arrives on an operator edit, never per frame" — and BlendEffect
        // rebuilds its textures whenever this identity changes. Dragging a calibration point breaks
        // that assumption: it writes the document at pointer rate, every write re-pushes config to
        // every projector window, and each push re-uploaded the blend maps for a look nobody
        // touched. Comparing by value costs a handful of numbers and restores the invariant.
        const r = m.render;
        const next: BlendLook = { softEdge: r.softEdge, colorGain: r.colorGain, blackLift: r.blackLift, blend: r.blend ?? null };
        setLook((prev) => (sameLook(prev, next) ? prev : next));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The channel outlives React, so a closed window must not leave a dead bitmap reference behind.
  useEffect(() => () => clearSurfaceFrame(), []);

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
      fillPattern(img.data, w, h, pat.kind, pat.index, pat.rgb, pat.dots);
      g.putImageData(img, 0, 0);
      requestAnimationFrame(() => requestAnimationFrame(() => send({ t: 'patternShown', index: pat.index, projW: w, projH: h })));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pose capture: drag / arrow-nudge the aim crosshair (Shift ×10 px, Shift+Alt = 0.1 px fine) and
  // report its projector-raster pixel live. A press that lands ON a placed point grabs THAT point
  // instead — dragging streams `calibPointDrag` so the pick (and the solve, and the wireframe
  // underlay) follows the pointer; the crosshair stays where it was.
  const pointsRef = useRef(points); pointsRef.current = points;
  const dragPointRef = useRef<number | null>(null);
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
    const GRAB_PX = 14; // css px — same order as the wizard's 3D marker (a target a hand can hit)
    const onPointer = (e: PointerEvent) => {
      if (e.type === 'pointerdown') {
        const hit = pointsRef.current.findIndex((p) =>
          Math.hypot(p[0] / dpr - e.clientX, p[1] / dpr - e.clientY) <= GRAB_PX);
        if (hit >= 0) { dragPointRef.current = hit; return; }
      }
      if (dragPointRef.current != null) {
        const i = dragPointRef.current;
        const px: [number, number] = [e.clientX * dpr, e.clientY * dpr];
        setPoints((prev) => prev.map((p, j) => (j === i ? px : p))); // optimistic — main echoes it back
        send({ t: 'calibPointDrag', index: i, pixel: px });
        return;
      }
      if (e.type === 'pointerdown' || e.buttons === 1) place(e.clientX, e.clientY);
    };
    const onUp = () => { dragPointRef.current = null; };
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
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    window.focus();
    reportCrosshair();
    return () => { window.removeEventListener('pointerdown', onPointer); window.removeEventListener('pointermove', onPointer); window.removeEventListener('pointerup', onUp); window.removeEventListener('keydown', onKey); };
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
          <ProjectorScene scene3D={scene3D} modelUrls={modelUrls} calibration={calibration} look={look} meshLook={meshLook} />
        </div>
      )}

      {/* Structured-light pattern overlay — opaque, on top, raw pixels (no GL). */}
      <canvas
        ref={patternCanvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: '#000', display: calibMode === 'pattern' ? 'block' : 'none' }}
      />

      {/* Pose-capture aim crosshair — point it at a known venue feature, Enter to confirm. The placed
          picks render numbered (same numbers as the 3D markers and the wizard's list/raster map), so
          the operator standing at the object can see which features are already anchored — and which
          one is selected for re-aiming. Raster px → css px is a ÷dpr (the ack/report convention). */}
      {/* Wireframe underlay while PICKING: once a pose has solved, project the live wireframe (+ vertex
          dots) so the operator sees, on the real object, where the model currently thinks its vertices
          are — every added or edited point visibly pulls it into alignment. Opaque (black bg) is
          deliberate: high contrast beats the faint content for aiming. */}
      {calibMode === 'crosshair' && meshLook !== 'shaded' && calibration?.poseRms != null && scene3D && (
        <div style={{ position: 'absolute', inset: 0 }}>
          <ProjectorScene scene3D={scene3D} modelUrls={modelUrls} calibration={calibration} meshLook={meshLook} frameloop="demand" />
        </div>
      )}

      {calibMode === 'crosshair' && (() => {
        const dpr = window.devicePixelRatio || 1;
        return (
        <>
          <svg width={size.w} height={size.h} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {points.map((p, i) => {
              const x = p[0] / dpr, y = p[1] / dpr;
              const sel = i === selectedPt;
              const col = sel ? '#ffffff' : '#00e5ff'; // same palette as the 3D AnchorMarker
              // The residual, drawn where you can see it: a leader line from the pick to where the
              // CURRENT solve puts that vertex. Its length IS this point's reprojection error — a
              // long line on the object says "this pair disagrees with the other pairs", which a
              // number in a list on another screen never conveys while you are standing at the wall.
              const q = predicted[i];
              const dx = q ? q[0] / dpr - x : 0, dy = q ? q[1] / dpr - y : 0;
              const showLead = q != null && Math.hypot(dx, dy) > 2;
              return (
                <g key={i}>
                  {showLead && (
                    <>
                      <line x1={x} y1={y} x2={q![0] / dpr} y2={q![1] / dpr} stroke="#ff4d4d" strokeWidth={1.5} strokeDasharray="4 3" />
                      <circle cx={q![0] / dpr} cy={q![1] / dpr} r={3} fill="none" stroke="#ff4d4d" strokeWidth={1.5} />
                    </>
                  )}
                  <circle cx={x} cy={y} r={sel ? 9 : 7} fill="none" stroke={col} strokeWidth={sel ? 2 : 1.5} />
                  <circle cx={x} cy={y} r={1.5} fill={col} />
                  <text x={x + 11} y={y - 8} fill={col} style={{ font: 'bold 13px system-ui', paintOrder: 'stroke', stroke: '#000', strokeWidth: 3 }}>{i + 1}</text>
                </g>
              );
            })}
            {/* White: the crosshair must read on any real-world surface color — and it is the AIM,
                visually distinct from the cyan placed points. */}
            <line x1={0} y1={crosshair[1] * size.h} x2={size.w} y2={crosshair[1] * size.h} stroke="rgba(255,255,255,0.55)" strokeWidth={1} />
            <line x1={crosshair[0] * size.w} y1={0} x2={crosshair[0] * size.w} y2={size.h} stroke="rgba(255,255,255,0.55)" strokeWidth={1} />
            <circle cx={crosshair[0] * size.w} cy={crosshair[1] * size.h} r={10} fill="none" stroke="#ffffff" strokeWidth={1.5} />
            <circle cx={crosshair[0] * size.w} cy={crosshair[1] * size.h} r={1.5} fill="#ffffff" />
          </svg>
          <div style={hintBox}>Aim at a feature (drag / arrows · Shift ×10 · Shift+Alt ×0.1 px), then click the matching point in the 3D view — no confirm needed</div>
        </>
        );
      })()}
    </>
  );
};

const hintBox: React.CSSProperties = {
  position: 'absolute', left: '50%', bottom: 24, transform: 'translateX(-50%)',
  padding: '6px 12px', borderRadius: 6, background: 'rgba(0,0,0,0.7)', color: '#ddd',
  font: '12px system-ui', whiteSpace: 'nowrap', pointerEvents: 'none',
};
