import React, { useEffect, useState } from 'react';
import { Slider } from '@/components/ui'; // host UI primitive (pure presentational — no singleton)
import * as poseCamera from './poseCamera';
import type { MediaPipeSettings } from './poseEngine';

// The MediaPipe plugin's Preferences section. Registered into the host settingsSectionRegistry, which
// Preferences renders after the core sections. These prefs are plugin-LOCAL (only poseEngine reads
// them), so they live under AppSettings.plugins.mediapipe rather than as core fields — poseEngine reads
// the same path and restarts inference when any of them change.

interface HostSettings { plugins?: Record<string, unknown> }

const selCls = 'flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none';
const rowCls = 'flex items-center justify-between gap-2 text-xs';

export const PoseSettings: React.FC<{ settings: unknown; onChange: (patch: Partial<HostSettings>) => void }> = ({ settings, onChange }) => {
  const host = settings as HostSettings;
  const cfg = (host.plugins?.mediapipe as MediaPipeSettings | undefined) ?? {};
  const [devices, setDevices] = useState<poseCamera.CameraDevice[]>([]);

  // Enumerate cameras (labels populate only after permission has been granted once).
  useEffect(() => { let alive = true; void poseCamera.enumerate().then((d) => { if (alive) setDevices(d); }); return () => { alive = false; }; }, []);

  // Merge a patch into the plugin-local settings namespace, preserving other plugins' entries.
  const patch = (p: Partial<MediaPipeSettings>) =>
    onChange({ plugins: { ...host.plugins, mediapipe: { ...cfg, ...p } } });

  return (
    <div className="space-y-2">
      <div className={rowCls}>
        <label className="text-fg-2 w-24 truncate">Camera</label>
        <select className={selCls} value={cfg.cameraDeviceId ?? ''} onChange={(e) => patch({ cameraDeviceId: e.target.value || undefined })}>
          <option value="">Default camera</option>
          {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
        </select>
      </div>
      <div className={rowCls}>
        <label className="text-fg-2 w-24 truncate" title="Accuracy vs speed">Model</label>
        <select className={selCls} value={cfg.model ?? 'full'} onChange={(e) => patch({ model: e.target.value as MediaPipeSettings['model'] })}>
          <option value="lite">Lite (fastest)</option>
          <option value="full">Full (balanced)</option>
          <option value="heavy">Heavy (accurate)</option>
        </select>
      </div>
      <div className={rowCls}>
        <label className="text-fg-2 w-24 truncate" title="Inference backend">Delegate</label>
        <select className={selCls} value={cfg.delegate ?? 'GPU'} onChange={(e) => patch({ delegate: e.target.value as MediaPipeSettings['delegate'] })}>
          <option value="GPU">GPU (WebGL)</option>
          <option value="CPU">CPU</option>
        </select>
      </div>
      <div className={rowCls}>
        <label className="text-fg-2 w-24 truncate" title="Max people tracked">Max people</label>
        <select className={selCls} value={cfg.numPoses ?? 2} onChange={(e) => patch({ numPoses: parseInt(e.target.value, 10) })}>
          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <Slider label="Min confidence" value={cfg.minConfidence ?? 0.5} min={0.1} max={0.95} step={0.05}
        format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch({ minConfidence: v })} />
      <p className="text-micro text-fg-3 leading-snug pt-1">
        Camera pose tracking runs only while a surface uses the <b>MediaPipe</b> content source. Changing
        these settings restarts inference. Requires the offline model assets (see docs/MEDIAPIPE.md).
      </p>
    </div>
  );
};
