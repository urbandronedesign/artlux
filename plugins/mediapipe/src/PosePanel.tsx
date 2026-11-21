import React, { useEffect, useRef } from 'react';
import { type PanelProps, useLiveValue } from '@artlux/sdk/renderer';
import { liveView, previewStream, NO_MONITOR, type PoseMonitorView } from './uiLink';

// Pose Monitor — a diagnostic panel that shows the live webcam feed, the inference status (running /
// disabled / error), fps, and the current tracked-people count. A dock tab on the `3d` context, toggled
// by the 'pose-monitor' menu action. Mirrors the LiDAR plugin's OscMonitor. Read-only: it observes the
// engine, it doesn't drive it.
//
// The plugin's UI HALF (E5/W5): it may open in its own window. The numbers come from the runtime's
// 'mediapipe.monitor' stream in both windows; the picture only where the camera is (uiLink.ts).

export const PosePanel: React.FC<PanelProps> = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const m = useLiveValue<PoseMonitorView>(liveView(), 'mediapipe.monitor', null, NO_MONITOR);
  const here = previewStream() !== undefined;   // false in a panel window: the picture is the editor's

  // Attach the camera stream to the preview once it exists (and let go when it closes).
  useEffect(() => {
    if (!here) return;
    const id = window.setInterval(() => {
      const v = videoRef.current;
      const stream = previewStream() ?? null;
      if (v && stream && v.srcObject !== stream) { v.srcObject = stream; v.play().catch(() => {}); }
      if (v && !stream && v.srcObject) v.srcObject = null;
    }, 300);
    return () => window.clearInterval(id);
  }, [here]);

  const state = m.disabled ? 'Disabled' : m.running ? 'Running' : m.consumers > 0 ? 'Starting…' : 'Idle';
  const stateColor = m.disabled ? 'text-red-400' : m.running ? 'text-emerald-400' : 'text-fg-3';

  return (
    <div className="w-full h-full overflow-y-auto bg-surface-1" aria-label="Pose Monitor">
        <div className="flex items-center justify-between px-3 py-2 border-b border-line-1 bg-surface-2 select-none">
          <span className="text-mini font-bold text-fg-1">Pose Monitor</span>
        </div>
        <div className="p-3 space-y-3">
          <div className="relative aspect-video w-full rounded bg-surface-0 overflow-hidden border border-line-1">
            {here && <video ref={videoRef} muted playsInline className="w-full h-full object-contain" />}
            {!m.hasCamera ? (
              <div className="absolute inset-0 flex items-center justify-center text-micro text-fg-3">
                No camera — add a MediaPipe surface to start tracking
              </div>
            ) : !here && (
              <div data-pose-picture-elsewhere className="absolute inset-0 flex items-center justify-center px-4 text-center text-micro text-fg-3">
                The camera picture is shown in the editor's Pose Monitor — the camera is open there.
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Status" value={state} valueCls={stateColor} />
            <Stat label="FPS" value={String(m.fps)} />
            <Stat label="People" value={String(m.people)} />
          </div>
          {m.error && (
            <div className="text-micro text-red-400 break-words border border-red-500/30 bg-red-500/10 rounded px-2 py-1">
              {m.error}
            </div>
          )}
        </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; valueCls?: string }> = ({ label, value, valueCls }) => (
  <div className="rounded bg-surface-2 border border-line-1 py-1.5">
    <div className="text-micro text-fg-3 uppercase tracking-wider">{label}</div>
    <div className={`text-mini font-bold ${valueCls ?? 'text-fg-1'}`}>{value}</div>
  </div>
);
