import React, { useEffect, useRef, useState } from 'react';
import { Surface, SourceType } from '../types';
import { defaultCornerPin, type CornerPin } from '../../../shared/protocol';
import { syncSurfaces, getDrawable } from '../services/surfaceMedia';
import { timeline as engine } from '../services/timeline';
import { ProjectorGL } from './ProjectorGL';
import { squareToQuad, applyH } from './homography';
import type { MainToProjector, ProjectorToMain } from './bridge';

// Content the projector renders on its own (no frame transfer). Singular live sources
// (CAMERA / SPOUT / DMX_IN) only exist in the main renderer — Phase 3 transfers their
// frames; until then they show black here.
const SELF_RENDER = new Set<SourceType | 'EFFECT'>([
  SourceType.VIDEO, SourceType.IMAGE, SourceType.LAYER, 'EFFECT',
]);

type CornerKey = keyof CornerPin;
const CORNERS: CornerKey[] = ['tl', 'tr', 'br', 'bl'];
const CORNER_LABEL: Record<CornerKey, string> = { tl: 'TL', tr: 'TR', br: 'BR', bl: 'BL' };

// A single fullscreen projector output for one Surface. Renders the surface content
// independently and corner-pin warps it onto black. In edit mode it overlays draggable
// corner handles + a perspective-correct calibration grid for aligning to the real surface.
export const ProjectorApp: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<ProjectorGL | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const surfaceRef = useRef<Surface | null>(null);
  const pinRef = useRef<CornerPin>(defaultCornerPin());
  const playingRef = useRef(true);
  const draggingRef = useRef<CornerKey | null>(null);
  const commitTimer = useRef<number | null>(null);

  const [pin, setPinState] = useState<CornerPin>(defaultCornerPin());
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<CornerKey>('tl');
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [connected, setConnected] = useState(false);
  const [name, setName] = useState('');

  const setPin = (next: CornerPin) => { pinRef.current = next; setPinState(next); };
  const send = (m: ProjectorToMain) => portRef.current?.postMessage(m);
  const commit = () => send({ t: 'cornerPin', cornerPin: pinRef.current });
  const commitDebounced = () => {
    if (commitTimer.current) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(commit, 250);
  };

  // The main window owns the clock; this window's timeline engine follows the transport.
  useEffect(() => { engine.setExternal(true); }, []);

  // Track window size for the edit overlay.
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // --- MessagePort handshake (mirrors SceneApp) ---
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
          // Don't let an echo of our own commit fight an in-progress drag.
          if (!draggingRef.current) setPin(m.cornerPin ?? defaultCornerPin());
          playingRef.current = m.playing;
          setName(m.surface.name);
          setConnected(true);
          const self = SELF_RENDER.has(m.surface.content.type);
          syncSurfaces(self ? [m.surface] : [], m.playing);
        } else if (m.t === 'timeline') {
          engine.setData(m.timeline);
        } else if (m.t === 'transport') {
          playingRef.current = m.playing;
          engine.setPlaying(m.playing);
          engine.seek(m.playhead);
          const s = surfaceRef.current;
          if (s) syncSurfaces(SELF_RENDER.has(s.content.type) ? [s] : [], m.playing);
        } else if (m.t === 'edit') {
          setEditing(m.on);
          if (m.on) window.focus();
        }
      };
      port.start();
      (port.postMessage as (m: ProjectorToMain) => void)({ t: 'ready' });
    };
    window.addEventListener('message', onMsg);
    window.postMessage('artlux:projector-ready', '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // --- render loop (outside React; refs drive it) ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let gl: ProjectorGL;
    try { gl = new ProjectorGL(canvas); } catch (err) { console.error(err); return; }
    glRef.current = gl;
    let raf = 0;
    const frame = () => {
      gl.setSize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
      const s = surfaceRef.current;
      const src = s && SELF_RENDER.has(s.content.type) ? getDrawable(s) : null;
      gl.draw(src as TexImageSource | null, pinRef.current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); gl.dispose(); glRef.current = null; };
  }, []);

  // --- corner dragging ---
  useEffect(() => {
    if (!editing) return;
    const norm = (e: PointerEvent): [number, number] => [
      Math.min(1, Math.max(0, e.clientX / window.innerWidth)),
      Math.min(1, Math.max(0, e.clientY / window.innerHeight)),
    ];
    const onMove = (e: PointerEvent) => {
      const key = draggingRef.current;
      if (!key) return;
      setPin({ ...pinRef.current, [key]: norm(e) });
    };
    const onUp = () => { if (draggingRef.current) { draggingRef.current = null; commit(); } };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // --- keyboard: arrow nudge, reset, dismiss ---
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setEditing(false); send({ t: 'editOff' }); return; }
      if (e.key === 'r' || e.key === 'R') { setPin(defaultCornerPin()); commit(); return; }
      const map: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
      };
      const d = map[e.key];
      if (!d) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const [cx, cy] = pinRef.current[selected];
      const nx = Math.min(1, Math.max(0, cx + (d[0] * step) / window.innerWidth));
      const ny = Math.min(1, Math.max(0, cy + (d[1] * step) / window.innerHeight));
      setPin({ ...pinRef.current, [selected]: [nx, ny] });
      commitDebounced();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, selected]);

  // Perspective-correct calibration grid (matches the GL warp exactly).
  const gridLines = (): string[] => {
    const m = squareToQuad(pin);
    const N = 4;
    const pts = (uFix: number | null, vFix: number | null) => {
      const out: string[] = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const [x, y] = applyH(m, uFix ?? t, vFix ?? t);
        out.push(`${(x * size.w).toFixed(1)},${(y * size.h).toFixed(1)}`);
      }
      return out.join(' ');
    };
    const lines: string[] = [];
    for (let i = 0; i <= N; i++) lines.push(pts(i / N, null)); // verticals (u fixed)
    for (let i = 0; i <= N; i++) lines.push(pts(null, i / N)); // horizontals (v fixed)
    return lines;
  };

  const cursor = editing ? 'default' : 'none';

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#000', overflow: 'hidden', cursor }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />

      {!connected && (
        <div style={overlayCenter}>Waiting for the main window… {name}</div>
      )}

      {editing && (
        <>
          <svg width={size.w} height={size.h} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {gridLines().map((pts, i) => (
              <polyline key={i} points={pts} fill="none" stroke="rgba(0,255,170,0.5)" strokeWidth={1} />
            ))}
          </svg>
          {CORNERS.map((key) => {
            const [nx, ny] = pin[key];
            const x = nx * size.w, y = ny * size.h;
            const active = selected === key;
            return (
              <div
                key={key}
                onPointerDown={(e) => { e.preventDefault(); setSelected(key); draggingRef.current = key; }}
                style={{
                  position: 'absolute', left: x - 14, top: y - 14, width: 28, height: 28,
                  borderRadius: '50%', border: `2px solid ${active ? '#00ffaa' : '#ffffff'}`,
                  background: active ? 'rgba(0,255,170,0.25)' : 'rgba(255,255,255,0.12)',
                  cursor: 'grab', touchAction: 'none', boxSizing: 'border-box',
                }}
              >
                <span style={{
                  position: 'absolute', left: 30, top: 4, font: '11px system-ui',
                  color: active ? '#00ffaa' : '#fff', textShadow: '0 1px 2px #000', whiteSpace: 'nowrap',
                }}>{CORNER_LABEL[key]}</span>
              </div>
            );
          })}
          <div style={hintBox}>
            Drag corners to align · arrows nudge (Shift ×10) · <b>R</b> reset · <b>Esc</b> done
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
