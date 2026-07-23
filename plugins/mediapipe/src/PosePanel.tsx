import React, { useEffect, useRef, useState } from 'react';
import { type PanelProps } from '@artlux/sdk/renderer';
import * as poseEngine from './poseEngine';
import * as poseCamera from './poseCamera';
import * as poseStore from './poseStore';

// Pose Monitor — a diagnostic modal that shows the live webcam feed, the inference status (running /
// disabled / error), fps, and the current tracked-people count. Registered as a 'modal' panel toggled
// by the 'pose-monitor' menu action; App mounts it from the panel registry. Mirrors the LiDAR plugin's
// OscMonitor. Read-only: it observes poseEngine/poseStore, it doesn't drive them.

export const PosePanel: React.FC<PanelProps> = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState(() => poseEngine.status());
  const [people, setPeople] = useState(0);

  // Poll engine status (fps/count/running) + attach the camera stream to the preview once it exists.
  useEffect(() => {
    const id = window.setInterval(() => {
      setStatus(poseEngine.status());
      const v = videoRef.current;
      const stream = poseCamera.getStream();
      if (v && stream && v.srcObject !== stream) { v.srcObject = stream; v.play().catch(() => {}); }
      if (v && !stream && v.srcObject) v.srcObject = null;
    }, 300);
    return () => window.clearInterval(id);
  }, []);

  // Live people count straight from the store (fires per pose frame, coalesced to rAF).
  useEffect(() => poseStore.subscribe(() => setPeople(poseStore.getDetections().length)), []);

  const state = status.disabled ? 'Disabled' : status.running ? 'Running' : status.consumers > 0 ? 'Starting…' : 'Idle';
  const stateColor = status.disabled ? 'text-red-400' : status.running ? 'text-emerald-400' : 'text-fg-3';

  return (
    <div className="w-full h-full overflow-y-auto bg-surface-1" aria-label="Pose Monitor">
        <div className="flex items-center justify-between px-3 py-2 border-b border-line-1 bg-surface-2 select-none">
          <span className="text-mini font-bold text-fg-1">Pose Monitor</span>
        </div>
        <div className="p-3 space-y-3">
          <div className="relative aspect-video w-full rounded bg-surface-0 overflow-hidden border border-line-1">
            <video ref={videoRef} muted playsInline className="w-full h-full object-contain" />
            {!poseCamera.getStream() && (
              <div className="absolute inset-0 flex items-center justify-center text-micro text-fg-3">
                No camera — add a MediaPipe surface to start tracking
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Status" value={state} valueCls={stateColor} />
            <Stat label="FPS" value={String(status.fps)} />
            <Stat label="People" value={String(people)} />
          </div>
          {status.error && (
            <div className="text-micro text-red-400 break-words border border-red-500/30 bg-red-500/10 rounded px-2 py-1">
              {status.error}
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
