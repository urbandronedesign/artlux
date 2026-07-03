import React from 'react';
import { Slider, Toggle } from '@/components/ui'; // host UI primitives (pure presentational)
import type { SurfaceContent } from '@/types';

// The per-surface inspector fragment for MEDIAPIPE content, rendered by the host ContentEditor via the
// content-source provider's `editor` hook. Configures the marker viz + orientation calibration (the
// same flip/rotate fields the TRACKING content reuses) — so a camera-pose surface tunes like a LiDAR one.

const selCls = 'flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none';

export const PoseContentEditor: React.FC<{ content: SurfaceContent; onChange: (patch: Partial<SurfaceContent>) => void }> = ({ content: c, onChange }) => (
  <div className="space-y-2 pt-1">
    <Slider label="Marker size" value={c.blobSize ?? 0.05} min={0.01} max={0.2} step={0.005}
      format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onChange({ blobSize: v })} />
    <Toggle label="Skeleton" checked={c.poseSkeleton ?? false} onChange={(v) => onChange({ poseSkeleton: v })} />
    <Toggle label="Show IDs" checked={c.showIds ?? false} onChange={(v) => onChange({ showIds: v })} />
    <Toggle label="Trails" checked={c.trail !== false} onChange={(v) => onChange({ trail: v })} />
    <div className="flex items-center justify-between gap-2 text-xs">
      <label className="text-fg-2 w-20 truncate" title="Rotate the camera frame">Rotate</label>
      <select className={selCls} value={c.rotate ?? 0} onChange={(e) => onChange({ rotate: parseInt(e.target.value, 10) })}>
        {[0, 90, 180, 270].map((d) => <option key={d} value={d}>{d}°</option>)}
      </select>
    </div>
    <div className="flex gap-3">
      <Toggle label="Flip H" checked={c.flipH ?? false} onChange={(v) => onChange({ flipH: v })} />
      <Toggle label="Flip V" checked={c.flipV ?? false} onChange={(v) => onChange({ flipV: v })} />
    </div>
  </div>
);
