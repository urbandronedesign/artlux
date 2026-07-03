import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDraggable, type PanelProps } from '@artlux/sdk/renderer';
import type { MediapipeFloor } from '../../../shared/protocol';
import * as poseEngine from './poseEngine';
import * as poseCamera from './poseCamera';
import { getHost } from './poseHost';

// Pose Floor Calibration — the quick 4-point wizard that relates the webcam feed to real floor space.
// Point the camera at the floor, drag the four handles onto a rectangle of known real size, enter its
// width × depth (metres), and Save. A floor is a plane, so 4 corners fully determine the image→floor
// homography (poseHomography). The result persists in Scene3D.mediapipeFloor and drives the 3D floor
// preview in PoseViz. Read-only otherwise: it acquires the camera engine while open so there's a live
// feed even with no MediaPipe surface.
//
// Handles are stored on screen (top-left origin, 0..1 of the video box) for direct DOM placement, and
// converted to the store's bottom-left normalized space (v = 1 − yScreen) on Save to match the landmarks.

type Pt = [number, number];
const CORNERS = ['tl', 'tr', 'br', 'bl'] as const;
// A perspective-looking default trapezoid (top edge = far, narrower) as a starting hint.
const DEFAULT_HANDLES: [Pt, Pt, Pt, Pt] = [[0.28, 0.30], [0.72, 0.30], [0.9, 0.82], [0.1, 0.82]];

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export const PoseCalibration: React.FC<PanelProps> = ({ onClose }) => {
  const { positionerStyle, handleProps } = useDraggable();
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(16 / 9);

  const host = getHost();
  const existing = (host?.scene3D.get() as { mediapipeFloor?: MediapipeFloor } | undefined)?.mediapipeFloor;

  // Screen-space (top-left) handles, seeded from any saved calibration (bottom-left → screen: y=1−v).
  const [handles, setHandles] = useState<[Pt, Pt, Pt, Pt]>(() =>
    existing ? (existing.imageQuad.map(([u, v]) => [u, 1 - v]) as [Pt, Pt, Pt, Pt]) : DEFAULT_HANDLES);
  const [width, setWidth] = useState(existing?.width ?? 4);
  const [depth, setDepth] = useState(existing?.depth ?? 3);
  const [dragging, setDragging] = useState<number | null>(null);

  // Run the camera engine while the wizard is open (even without a MediaPipe surface).
  useEffect(() => { poseEngine.acquire('pose-calibrate'); return () => poseEngine.release('pose-calibrate'); }, []);

  // Attach the live stream + learn the camera aspect (poll — the stream starts a moment after acquire).
  useEffect(() => {
    const id = window.setInterval(() => {
      const v = videoRef.current, stream = poseCamera.getStream();
      if (v && stream && v.srcObject !== stream) { v.srcObject = stream; v.play().catch(() => {}); }
      if (v && !stream && v.srcObject) v.srcObject = null;
      const a = poseCamera.aspect(); if (a && Math.abs(a - aspect) > 1e-3) setAspect(a);
    }, 300);
    return () => window.clearInterval(id);
  }, [aspect]);

  // Corner-handle drag in normalized box coords.
  useEffect(() => {
    if (dragging == null) return;
    const move = (e: PointerEvent) => {
      const box = boxRef.current; if (!box) return;
      const r = box.getBoundingClientRect();
      const x = clamp01((e.clientX - r.left) / r.width);
      const y = clamp01((e.clientY - r.top) / r.height);
      setHandles((h) => { const n = h.slice() as [Pt, Pt, Pt, Pt]; n[dragging] = [x, y]; return n; });
    };
    const up = () => setDragging(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [dragging]);

  const polyPoints = useMemo(() => handles.map(([x, y]) => `${x * 100},${y * 100}`).join(' '), [handles]);

  const save = () => {
    // Screen top-left → store bottom-left (v = 1 − y). Order stays tl,tr,br,bl.
    const imageQuad = handles.map(([x, y]) => [x, 1 - y]) as MediapipeFloor['imageQuad'];
    host?.scene3D.patch({ mediapipeFloor: { imageQuad, width: Math.max(0.1, width), depth: Math.max(0.1, depth) } } as never);
    onClose?.();
  };
  const clear = () => { host?.scene3D.patch({ mediapipeFloor: undefined } as never); setHandles(DEFAULT_HANDLES); };

  const hasStream = !!poseCamera.getStream();

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div style={positionerStyle} onClick={(e) => e.stopPropagation()}
        className="w-[560px] max-w-[94vw] rounded-lg border border-line-1 bg-surface-1 shadow-2xl overflow-hidden">
        <div {...handleProps} className="flex items-center justify-between px-3 py-2 border-b border-line-1 bg-surface-2 cursor-move select-none">
          <span className="text-mini font-bold text-fg-1">Pose Floor Calibration</span>
          <button onClick={onClose} className="text-fg-3 hover:text-fg-1 text-mini">✕</button>
        </div>

        <div className="p-3 space-y-3">
          <p className="text-micro text-fg-3 leading-snug">
            Point the camera at the floor. Drag the four handles onto the corners of a floor rectangle
            whose real size you know, then enter its width and depth. Order: top-left, top-right,
            bottom-right, bottom-left — the top edge is the far side of the floor.
          </p>

          {/* Live feed + draggable corner handles (normalized to the video box). */}
          <div ref={boxRef} className="relative w-full rounded overflow-hidden border border-line-1 bg-surface-0 select-none"
            style={{ aspectRatio: String(aspect) }}>
            <video ref={videoRef} muted playsInline className="absolute inset-0 w-full h-full" style={{ objectFit: 'fill' }} />
            {!hasStream && (
              <div className="absolute inset-0 flex items-center justify-center text-micro text-fg-3 text-center px-4">
                Camera unavailable — check the MediaPipe model assets (docs/MEDIAPIPE.md) and camera permission.
              </div>
            )}
            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polygon points={polyPoints} fill="rgba(56,189,248,0.12)" stroke="#38bdf8" strokeWidth={0.4} vectorEffect="non-scaling-stroke" />
            </svg>
            {handles.map(([x, y], i) => (
              <div key={CORNERS[i]} onPointerDown={() => setDragging(i)}
                className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full border-2 border-white bg-sky-400 cursor-grab active:cursor-grabbing shadow"
                style={{ left: `${x * 100}%`, top: `${y * 100}%` }} title={CORNERS[i].toUpperCase()} />
            ))}
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-fg-2">
              Width (m)
              <input type="number" min={0.1} step={0.1} value={width} onChange={(e) => setWidth(parseFloat(e.target.value) || 0)}
                className="num w-20 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none" />
            </label>
            <label className="flex items-center gap-2 text-xs text-fg-2">
              Depth (m)
              <input type="number" min={0.1} step={0.1} value={depth} onChange={(e) => setDepth(parseFloat(e.target.value) || 0)}
                className="num w-20 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none" />
            </label>
          </div>

          <p className="text-micro text-fg-3 leading-snug">
            After saving, enable <b>Camera pose markers (MediaPipe)</b> in the 3D scene panel to preview
            tracked people on the calibrated floor.
          </p>

          <div className="flex justify-between pt-1">
            <button onClick={clear} className="text-mini px-3 py-1.5 rounded border border-line-1 text-fg-2 hover:bg-surface-3">Clear</button>
            <div className="flex gap-2">
              <button onClick={onClose} className="text-mini px-3 py-1.5 rounded border border-line-1 text-fg-2 hover:bg-surface-3">Cancel</button>
              <button onClick={save} className="text-mini px-3 py-1.5 rounded bg-accent text-white hover:opacity-90">Save calibration</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
