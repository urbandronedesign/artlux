import React, { useEffect, useRef, useState } from 'react';
import { Surface, SourceType } from '../types';
import { defaultCornerPin, defaultSoftEdge, type CornerPin, type BezierWarp, type SoftEdge, type Scene3D, type ProjectorCalibration } from '../../../shared/protocol';
import { ProjectorScene } from './ProjectorScene';
import { syncSurfaces, getDrawable } from '../services/surfaceMedia';
import { timeline as engine } from '../services/timeline';
import * as trackingStore from '../services/trackingStore';
import * as trackingRenderer from '../services/trackingRenderer';
import { ProjectorGL } from './ProjectorGL';
import { squareToQuad, applyH } from './homography';
import { makeBezierWarp, tessellateBezier, evalBezier, BEZIER_CORNERS } from './warp';
import type { MainToProjector, ProjectorToMain, ProjectorRender } from './bridge';
import { fillPattern, type CalibPatternKind } from '../calib/graycode';

type CalibMode = 'idle' | 'pattern' | 'crosshair' | 'render';

// IMAGE (one cheap decode) + EFFECT (procedural) render locally. Everything HW-decoded —
// camera/Spout/DMX-in/NDI AND file video / timeline layers — is decoded once in the main
// window and streamed here as ImageBitmaps, so the same media isn't decoded per window.
const SELF_RENDER = new Set<SourceType | 'EFFECT'>([SourceType.IMAGE, 'EFFECT', SourceType.TRACKING]);
const STREAMED = new Set<SourceType | 'EFFECT'>([SourceType.CAMERA, SourceType.SPOUT, SourceType.DMX_IN, SourceType.NDI, SourceType.VIDEO, SourceType.LAYER]);
const CORNER_KEYS: (keyof CornerPin)[] = ['tl', 'tr', 'br', 'bl'];
const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'];
const AA_SAMPLES = 4;
const RENDER_TESS = 24; // patch → render mesh subdivisions per axis
const NDI_MAX_W = 1280, NDI_MAX_H = 720; // cap NDI capture for light readback + IPC
const NDI_BCAST_W = 1920, NDI_BCAST_H = 1080; // broadcast mode: send NDI at up to 1080p

// One fullscreen projector output for a Surface. Renders content through a corner-pin or a
// bicubic Bézier warp (tessellated to a mesh) with soft-edge + gamma, MSAA-resolved. Edit
// mode overlays draggable handles (4 corners, or the 16 Bézier control points) + a curved
// calibration grid.
export const ProjectorApp: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<ProjectorGL | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const surfaceRef = useRef<Surface | null>(null);
  const frameRef = useRef<ImageBitmap | null>(null);
  const playingRef = useRef(true);

  const pinRef = useRef<CornerPin>(defaultCornerPin());
  const warpRef = useRef<BezierWarp | null>(null);
  const softRef = useRef<SoftEdge>(defaultSoftEdge());
  const gammaRef = useRef(1);
  const brightnessRef = useRef(1);
  const fpsCapRef = useRef(0);
  const ndiSendRef = useRef(false);
  const ndiFullResRef = useRef(false);
  const lastNdiRef = useRef(0);
  const draggingRef = useRef<number | null>(null);
  const commitTimer = useRef<number | null>(null);

  // Calibration: structured-light pattern display (raw 2D overlay) + mode gate.
  const calibModeRef = useRef<CalibMode>('idle');
  const patternRef = useRef<{ kind: CalibPatternKind; index: number } | null>(null);
  const patternCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [calibMode, setCalibMode] = useState<CalibMode>('idle');
  // Pose capture: an aim crosshair (normalized) the operator points at a known venue feature.
  const crosshairRef = useRef<[number, number]>([0.5, 0.5]);
  const [crosshair, setCrosshairState] = useState<[number, number]>([0.5, 0.5]);
  const setCrosshair = (p: [number, number]) => { crosshairRef.current = p; setCrosshairState(p); };
  // Render-from-projector: the venue scene + this output's calibration (intrinsics + pose).
  const [scene3D, setScene3D] = useState<Scene3D | null>(null);
  const [calibration, setCalibration] = useState<ProjectorCalibration | null>(null);
  const [modelUrls, setModelUrls] = useState<Record<string, string>>({});
  const urlCacheRef = useRef<Record<string, string>>({});

  const [pin, setPinState] = useState<CornerPin>(defaultCornerPin());
  const [warp, setWarpState] = useState<BezierWarp | null>(null);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(0);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [connected, setConnected] = useState(false);
  const [name, setName] = useState('');

  const setPin = (n: CornerPin) => { pinRef.current = n; setPinState(n); };
  const setWarp = (n: BezierWarp | null) => { warpRef.current = n; setWarpState(n); };
  const send = (m: ProjectorToMain) => portRef.current?.postMessage(m);
  const commit = () => { if (warpRef.current) send({ t: 'warp', warp: warpRef.current }); else send({ t: 'cornerPin', cornerPin: pinRef.current }); };
  const commitDebounced = () => {
    if (commitTimer.current) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(commit, 250);
  };

  const applyRender = (r: ProjectorRender) => {
    if (!draggingRef.current) {
      setPin(r.cornerPin ?? defaultCornerPin());
      setWarp(r.warp ?? null);
    }
    softRef.current = r.softEdge ?? defaultSoftEdge();
    gammaRef.current = r.gamma ?? 1;
    brightnessRef.current = r.brightness ?? 1;
    fpsCapRef.current = r.fpsCap ?? 0;
    trackingRenderer.configure(r.trackingSmoothing ?? 0.6, r.trackingPredictMs ?? 50);
    ndiSendRef.current = !!r.ndiSend;
    ndiFullResRef.current = !!r.ndiFullRes;
  };

  // External mirror, but decode HAP layers locally: this window is visible/full-speed, so it
  // plays HAP smoothly even when the hidden broadcast main window throttles its frame pump.
  useEffect(() => { engine.setExternal(true); engine.setHapLocal(true); }, []);

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // --- MessagePort handshake ---
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.kind !== 'artlux:projector-port' || !e.ports[0]) return;
      const port = e.ports[0];
      portRef.current = port;
      port.onmessage = (ev: MessageEvent) => {
        const m = ev.data as MainToProjector;
        if (m.t === 'config') {
          surfaceRef.current = m.surface;
          playingRef.current = m.playing;
          setName(m.surface.name);
          setConnected(true);
          applyRender(m.render);
          const self = SELF_RENDER.has(m.surface.content.type);
          syncSurfaces(self ? [m.surface] : [], m.playing);
          if (!STREAMED.has(m.surface.content.type)) { frameRef.current?.close(); frameRef.current = null; }
        } else if (m.t === 'frame') {
          frameRef.current?.close();
          frameRef.current = m.bitmap;
        } else if (m.t === 'layerFrame') {
          engine.setLayerBitmap(m.layerId, m.bitmap); // TRACKING background video
        } else if (m.t === 'timeline') {
          engine.setData(m.timeline);
        } else if (m.t === 'transport') {
          playingRef.current = m.playing;
          engine.setPlaying(m.playing); engine.seek(m.playhead);
          const s = surfaceRef.current;
          if (s) syncSurfaces(SELF_RENDER.has(s.content.type) ? [s] : [], m.playing);
        } else if (m.t === 'brightness') {
          brightnessRef.current = m.value;
        } else if (m.t === 'tracking') {
          trackingStore.applySnapshot(m.snap);
        } else if (m.t === 'edit') {
          setEditing(m.on);
          if (m.on) window.focus();
        } else if (m.t === 'calib') {
          calibModeRef.current = m.mode;
          setCalibMode(m.mode);
          if (m.mode !== 'pattern') patternRef.current = null;
          if (m.calibration !== undefined) setCalibration(m.calibration);
        } else if (m.t === 'calibPattern') {
          patternRef.current = { kind: m.kind, index: m.index };
        } else if (m.t === 'scene') {
          setScene3D(m.scene3D);
        }
      };
      port.start();
      (port.postMessage as (m: ProjectorToMain) => void)({ t: 'ready' });
    };
    window.addEventListener('message', onMsg);
    window.postMessage('artlux:projector-ready', '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // --- render loop (refs only; fps-capped for performance mode) ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let gl: ProjectorGL;
    try { gl = new ProjectorGL(canvas); } catch (err) { console.error(err); return; }
    glRef.current = gl;
    let raf = 0; let lastDraw = -1e9;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const cap = fpsCapRef.current;
      if (cap > 0 && now - lastDraw < 1000 / cap - 0.5) return;
      lastDraw = now;
      gl.setSize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
      const s = surfaceRef.current;
      const mesh = warpRef.current ? tessellateBezier(warpRef.current, RENDER_TESS) : null;
      const opts = { cornerPin: pinRef.current, warp: mesh, softEdge: softRef.current, gamma: gammaRef.current, brightness: brightnessRef.current, aa: AA_SAMPLES };
      if (s && s.content.type === SourceType.TRACKING && s.content.trackingSource) {
        // GPU path: composite bg + blobs + overlay into the source FBO, then warp — no CPU canvas.
        const { w: srcW, h: srcH } = trackingRenderer.sourceSize(s.content.trackingSource);
        const bg = s.content.bgLayerId ? engine.getLayerDrawable(s.content.bgLayerId) : null;
        const trails = s.content.trail !== false ? trackingRenderer.trails(s, now, s.content.trailSeconds ?? 1.2) : null;
        gl.drawTracking({
          srcW, srcH,
          bgSource: bg as TexImageSource | null,
          trails,
          blobs: trackingRenderer.instances(s, now),
          overlaySource: trackingRenderer.overlayCanvas(s, srcW, srcH),
        }, opts);
      } else {
        // For HAP LAYER content getDrawable returns this window's locally-decoded canvas; for
        // other streamed sources it's null, so we fall back to the frame pushed from main.
        let src: CanvasImageSource | ImageBitmap | null = null;
        if (s) {
          if (SELF_RENDER.has(s.content.type)) src = getDrawable(s);
          else if (STREAMED.has(s.content.type)) src = getDrawable(s) ?? frameRef.current;
        }
        gl.draw(src as TexImageSource | null, opts);
      }
      // Publish this output as NDI (~30 fps, capped resolution) when enabled.
      if (ndiSendRef.current && now - lastNdiRef.current >= 33) {
        lastNdiRef.current = now;
        const id = surfaceRef.current?.id;
        if (id) {
          const mw = ndiFullResRef.current ? NDI_BCAST_W : NDI_MAX_W;
          const mh = ndiFullResRef.current ? NDI_BCAST_H : NDI_MAX_H;
          const shot = gl.captureRGBA(mw, mh);
          if (shot) window.artlux?.sendNdiFrame?.(id, shot.width, shot.height, shot.data.buffer as ArrayBuffer);
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); gl.dispose(); glRef.current = null; frameRef.current?.close(); frameRef.current = null; };
  }, []);

  // Structured-light: draw the requested pattern raw (no GL warp/gamma — bits must be pixel-exact)
  // into an opaque 2D overlay at native resolution, then ack patternShown after it is actually on
  // screen (double-rAF) so the main window grabs the camera in sync. Reports the projector raster so
  // main knows the resolution for decode + calibrateProjector.
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
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const img = ctx.createImageData(w, h);
      fillPattern(img.data, w, h, pat.kind, pat.index);
      ctx.putImageData(img, 0, 0);
      requestAnimationFrame(() => requestAnimationFrame(() => send({ t: 'patternShown', index: pat.index, projW: w, projH: h })));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pose capture: drag / arrow-nudge the aim crosshair (Shift ×10 px, Shift+Alt = 0.1 px fine), and
  // report its projector-raster pixel live; Enter confirms the current aim. Reuses the window's input
  // like the corner-pin editor but for a single point.
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
    const models = (scene3D?.models ?? []).filter(m => m.kind !== 'plane' && m.path);
    let alive = true;
    (async () => {
      const paths = Array.from(new Set(models.map(m => m.path)));
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

  // Editable handles: the 16 Bézier control points, or the 4 corner-pin points.
  const handlePoints: [number, number][] = warp ? warp.points : [pin.tl, pin.tr, pin.br, pin.bl];
  const setHandle = (i: number, p: [number, number]) => {
    if (warpRef.current) {
      const pts = warpRef.current.points.slice(); pts[i] = p;
      setWarp({ points: pts });
    } else {
      setPin({ ...pinRef.current, [CORNER_KEYS[i]]: p });
    }
  };

  // --- dragging ---
  useEffect(() => {
    if (!editing) return;
    const norm = (e: PointerEvent): [number, number] => [
      Math.min(1, Math.max(0, e.clientX / window.innerWidth)),
      Math.min(1, Math.max(0, e.clientY / window.innerHeight)),
    ];
    const onMove = (e: PointerEvent) => { if (draggingRef.current != null) setHandle(draggingRef.current, norm(e)); };
    const onUp = () => { if (draggingRef.current != null) { draggingRef.current = null; commit(); } };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, warp]);

  // --- keyboard: nudge / reset / dismiss ---
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setEditing(false); send({ t: 'editOff' }); return; }
      if (e.key === 'r' || e.key === 'R') {
        if (warpRef.current) setWarp(makeBezierWarp(pinRef.current));
        else setPin(defaultCornerPin());
        commit(); return;
      }
      const dir: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const dxy = dir[e.key];
      if (!dxy) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const pts = warpRef.current ? warpRef.current.points : [pinRef.current.tl, pinRef.current.tr, pinRef.current.br, pinRef.current.bl];
      const idx = Math.min(selected, pts.length - 1);
      const [cx, cy] = pts[idx];
      setHandle(idx, [
        Math.min(1, Math.max(0, cx + (dxy[0] * step) / window.innerWidth)),
        Math.min(1, Math.max(0, cy + (dxy[1] * step) / window.innerHeight)),
      ]);
      commitDebounced();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, selected, warp]);

  // Calibration overlay: curved iso-lines for the Bézier patch, or the homography grid.
  const px = (p: [number, number]) => `${(p[0] * size.w).toFixed(1)},${(p[1] * size.h).toFixed(1)}`;
  const curveLines = (): string[] => {
    const lines: string[] = [];
    if (warp) {
      const LINES = 4, STEPS = 24;
      for (let a = 0; a <= LINES; a++) {
        const v = a / LINES, u = a / LINES;
        lines.push(Array.from({ length: STEPS + 1 }, (_, k) => px(evalBezier(warp, k / STEPS, v))).join(' '));
        lines.push(Array.from({ length: STEPS + 1 }, (_, k) => px(evalBezier(warp, u, k / STEPS))).join(' '));
      }
    } else {
      const m = squareToQuad(pin), N = 4;
      const seg = (uF: number | null, vF: number | null) => Array.from({ length: N + 1 }, (_, i) => { const t = i / N; return px(applyH(m, uF ?? t, vF ?? t)); }).join(' ');
      for (let i = 0; i <= N; i++) { lines.push(seg(i / N, null)); lines.push(seg(null, i / N)); }
    }
    return lines;
  };
  // Faint Bézier control net (rows + columns of the 4×4 net).
  const netLines = (): string[] => {
    if (!warp) return [];
    const out: string[] = [];
    for (let j = 0; j < 4; j++) out.push([0, 1, 2, 3].map(i => px(warp.points[j * 4 + i])).join(' '));
    for (let i = 0; i < 4; i++) out.push([0, 1, 2, 3].map(j => px(warp.points[j * 4 + i])).join(' '));
    return out;
  };

  const sel = Math.min(selected, handlePoints.length - 1);
  const cornerOf = (i: number) => warp ? BEZIER_CORNERS.indexOf(i) : i; // -1 if interior/edge control point

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#000', overflow: 'hidden', cursor: editing ? 'default' : 'none' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />

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

      {!connected && <div style={overlayCenter}>Waiting for the main window… {name}</div>}

      {editing && (
        <>
          <svg width={size.w} height={size.h} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {netLines().map((pts, i) => (
              <polyline key={`n${i}`} points={pts} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={1} strokeDasharray="4 4" />
            ))}
            {curveLines().map((pts, i) => (
              <polyline key={`c${i}`} points={pts} fill="none" stroke="rgba(0,255,170,0.55)" strokeWidth={1} />
            ))}
          </svg>
          {handlePoints.map(([nx, ny], i) => {
            const active = sel === i;
            const ci = cornerOf(i);
            const r = ci >= 0 ? 14 : 8;
            return (
              <div
                key={i}
                onPointerDown={(e) => { e.preventDefault(); setSelected(i); draggingRef.current = i; }}
                style={{
                  position: 'absolute', left: nx * size.w - r, top: ny * size.h - r, width: r * 2, height: r * 2,
                  borderRadius: '50%', border: `2px solid ${active ? '#00ffaa' : ci >= 0 ? '#ffffff' : 'rgba(255,255,255,0.7)'}`,
                  background: active ? 'rgba(0,255,170,0.25)' : 'rgba(255,255,255,0.12)',
                  cursor: 'grab', touchAction: 'none', boxSizing: 'border-box',
                }}
              >
                {ci >= 0 && (
                  <span style={{ position: 'absolute', left: r * 2 + 2, top: 2, font: '11px system-ui', color: active ? '#00ffaa' : '#fff', textShadow: '0 1px 2px #000', whiteSpace: 'nowrap' }}>
                    {CORNER_LABELS[ci]}
                  </span>
                )}
              </div>
            );
          })}
          <div style={hintBox}>
            {warp ? 'Drag Bézier points (corners + curve handles)' : 'Drag corners'} · arrows nudge (Shift ×10) · <b>R</b> reset · <b>Esc</b> done
          </div>
        </>
      )}
    </div>
  );
};

const overlayCenter: React.CSSProperties = {
  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: '#666', font: '12px system-ui', pointerEvents: 'none',
};
const hintBox: React.CSSProperties = {
  position: 'absolute', left: '50%', bottom: 24, transform: 'translateX(-50%)',
  padding: '6px 12px', borderRadius: 6, background: 'rgba(0,0,0,0.7)', color: '#ddd',
  font: '12px system-ui', whiteSpace: 'nowrap', pointerEvents: 'none',
};
