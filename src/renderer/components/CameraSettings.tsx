import React, { useEffect, useState } from 'react';
import type { SurfaceContent } from '../types';
import { Slider } from './ui';
import { Tooltip } from './ui/Tooltip';
import { help } from '../services/helpBus';
import { listCameras, getCameraInfo, retryCamera, previewCameraControl, type CameraDevice, type CameraInfo } from '../services/contentSource';

// The CAMERA content inspector: which device, at what format, with which picture controls.
//
// A camera surface used to open whatever Chromium called the DEFAULT video input, with no way to say
// otherwise and no settings at all. On a machine that also has a virtual camera (NDI Webcam Input,
// OBS, a vendor overlay) the default is usually not the webcam, so the surface stayed empty while
// the very same camera worked in the MediaPipe / calibration wizards — which have always had a
// picker. That asymmetry was the bug.
//
// ⚠ THE CONTROL LIST IS NOT OURS — IT IS THE DEVICE'S. Everything below the format comes from
// `track.getCapabilities()`, so a webcam that exposes exposure and white balance gets those rows and
// a PTZ head gets pan/tilt/zoom, with no code change here. We only supply the NAMES, in the order an
// operator reaches for them; a capability we have no name for is not shown, because an unlabelled
// slider called `torch` on a stage camera is worse than nothing.

const selCls = 'flex-1 min-w-0 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none';
const rowCls = 'flex items-center gap-1';

// A webcam publishes RANGES, not a menu of modes, so there is no list to read off the device: these
// are the standard sizes, filtered to what its range admits. They are asked as `ideal` (see
// contentSource.startCamera), which is why "Actual" below can differ from what is chosen here — ask
// 1080p60 of a camera that only does 1080p30 and you get 30, with nothing else to tell you so.
const RESOLUTIONS: Array<{ w: number; h: number; label: string }> = [
  { w: 640, h: 480, label: '640 × 480' },
  { w: 960, h: 540, label: '960 × 540' },
  { w: 1280, h: 720, label: '1280 × 720 · 720p' },
  { w: 1920, h: 1080, label: '1920 × 1080 · 1080p' },
  { w: 2560, h: 1440, label: '2560 × 1440 · 1440p' },
  { w: 3840, h: 2160, label: '3840 × 2160 · 4K' },
];
const RATES = [15, 24, 25, 30, 50, 60, 120];

// Picture controls we know how to name, in reach-for order. Rendered only when the device advertises
// them. Deliberately excludes the plumbing every camera reports (deviceId, groupId, aspectRatio,
// resizeMode, facingMode) — those are not pictures.
const CONTROLS: Array<{ key: string; label: string; hint?: string }> = [
  { key: 'exposureMode', label: 'Exposure', hint: 'Auto exposure hunts under stage light — set manual for a stable picture' },
  { key: 'exposureTime', label: 'Exp. time', hint: 'Only bites once Exposure is manual' },
  { key: 'exposureCompensation', label: 'Exp. comp.' },
  { key: 'iso', label: 'ISO' },
  { key: 'whiteBalanceMode', label: 'White bal.', hint: 'Auto white balance drifts as the show colours change — set manual' },
  { key: 'colorTemperature', label: 'Temperature', hint: 'Only bites once White bal. is manual' },
  { key: 'brightness', label: 'Brightness' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'sharpness', label: 'Sharpness' },
  { key: 'focusMode', label: 'Focus' },
  { key: 'focusDistance', label: 'Focus dist.' },
  { key: 'zoom', label: 'Zoom' },
  { key: 'pan', label: 'Pan' },
  { key: 'tilt', label: 'Tilt' },
];

type Range = { min?: number; max?: number; step?: number };
const asRange = (v: unknown): Range | null =>
  v && typeof v === 'object' && !Array.isArray(v) && ('max' in (v as object)) ? (v as Range) : null;
const asChoices = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

// Everything the UI reacts to, flattened. Compared as a string so a 2 Hz poll only re-renders when
// something actually moved — see the poll below.
const signature = (i: CameraInfo): string =>
  `${i.state}|${i.error}|${JSON.stringify(i.settings)}|${i.capabilities ? Object.keys(i.capabilities).sort().join(',') : ''}`;

export const CameraSettings: React.FC<{ content: SurfaceContent; onChange: (patch: Partial<SurfaceContent>) => void }> = ({ content, onChange }) => {
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const id = content.cameraDeviceId ?? '';
  const [info, setInfo] = useState<CameraInfo>(() => getCameraInfo(id));

  // Re-enumerate on mount AND on 'devicechange' — plugging a camera in mid-session is ordinary, and a
  // list that only ever loads once is how a picker comes to disagree with the machine.
  useEffect(() => {
    let alive = true;
    const refresh = () => { void listCameras().then((d) => { if (alive) setDevices(d); }); };
    refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => { alive = false; navigator.mediaDevices?.removeEventListener?.('devicechange', refresh); };
  }, []);

  // The capture opens asynchronously and out of band — it is not React state, so it has to be asked.
  // Poll slowly (half a second is quicker than an operator can look) and — load-bearing — keep the
  // PREVIOUS object when nothing changed. A fresh object every tick would re-render this inspector
  // twice a second and tear down an open native <select> mid-choice, the same hazard that made
  // ContentEditor memoized in the first place.
  useEffect(() => {
    const read = () => setInfo((prev) => {
      const next = getCameraInfo(id);
      return signature(prev) === signature(next) ? prev : next;
    });
    read();
    const t = window.setInterval(read, 500);
    return () => window.clearInterval(t);
  }, [id]);

  const caps = info.capabilities;
  const settings = info.settings;
  // Chromium withholds device LABELS until a capture has succeeded once, so a first run lists
  // "Camera 1/2/3". Say why rather than letting the operator wonder which anonymous entry is theirs.
  const unlabeled = devices.length > 0 && devices.every((d) => /^Camera \d+$/.test(d.label));
  const missing = !!id && devices.length > 0 && !devices.some((d) => d.deviceId === id);

  const maxW = num(asRange(caps?.width)?.max) ?? Infinity;
  const maxH = num(asRange(caps?.height)?.max) ?? Infinity;
  const maxFps = num(asRange(caps?.frameRate)?.max) ?? Infinity;
  const sizes = RESOLUTIONS.filter((r) => r.w <= maxW && r.h <= maxH);
  const rates = RATES.filter((r) => r <= maxFps);

  const sizeValue = content.cameraWidth && content.cameraHeight ? `${content.cameraWidth}x${content.cameraHeight}` : '';
  const setSize = (v: string) => {
    const [w, h] = v.split('x').map(Number);
    onChange(v ? { cameraWidth: w, cameraHeight: h } : { cameraWidth: undefined, cameraHeight: undefined });
  };

  // Removing a key means "back to whatever the camera does on its own" — which the engine can only
  // honour by re-opening the device, since applyConstraints has no way to un-set a value.
  const setControl = (k: string, v: number | string | undefined) => {
    const next = { ...(content.cameraControls ?? {}) };
    if (v === undefined || v === '') delete next[k]; else next[k] = v;
    onChange({ cameraControls: Object.keys(next).length ? next : undefined });
  };

  const shown = caps ? CONTROLS.filter((c) => caps[c.key] !== undefined) : [];
  const actual = settings && num(settings.width) && num(settings.height)
    ? `${settings.width} × ${settings.height}${num(settings.frameRate) ? ` @ ${Math.round(num(settings.frameRate)!)} fps` : ''}`
    : null;

  return (
    <div className="space-y-1.5 pt-1">
      <div className={rowCls}>
        <label className="text-fg-2 w-12 text-micro">Device</label>
        <Tooltip id="content.camera-device">
          <select value={id} onChange={(e) => onChange({ cameraDeviceId: e.target.value || undefined })} {...help('content.camera-device')} className={selCls}>
            <option value="">Default camera</option>
            {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
            {/* A project carried from another machine keeps an id this profile cannot resolve. Show it
                rather than silently snapping the <select> back to "Default camera", which would look
                like the choice had been saved when it had not. */}
            {missing && <option value={id}>(saved camera — not connected)</option>}
          </select>
        </Tooltip>
      </div>

      <div className={rowCls}>
        <label className="text-fg-2 w-12 text-micro">Size</label>
        <Tooltip id="content.camera-format">
          <select value={sizeValue} onChange={(e) => setSize(e.target.value)} {...help('content.camera-format')} className={selCls}>
            <option value="">Camera default</option>
            {sizes.map((r) => <option key={r.label} value={`${r.w}x${r.h}`}>{r.label}</option>)}
          </select>
        </Tooltip>
      </div>

      <div className={rowCls}>
        <label className="text-fg-2 w-12 text-micro">Rate</label>
        <select value={content.cameraFps ?? ''} onChange={(e) => onChange({ cameraFps: e.target.value ? Number(e.target.value) : undefined })} className={selCls}>
          <option value="">Camera default</option>
          {rates.map((r) => <option key={r} value={r}>{r} fps</option>)}
        </select>
      </div>

      {/* What the device actually negotiated — the only honest answer to "what am I getting", and
          routinely not what was asked for. */}
      {actual && <div className="text-micro text-fg-3">Actual: <span className="num text-fg-2">{actual}</span></div>}

      {info.state === 'error' ? (
        <div className="flex items-center gap-1.5 text-micro text-danger">
          <span className="flex-1">{info.error}</span>
          <button onClick={() => retryCamera(id)} className="px-1.5 py-0.5 rounded border border-line-1 text-fg-2">Retry</button>
        </div>
      ) : info.error ? (
        <div className="text-micro text-warn">{info.error}</div>
      ) : info.state === 'live' ? (
        <div className="text-micro text-fg-3">Live.</div>
      ) : (
        <div className="text-micro text-fg-3">Opening the camera…</div>
      )}
      {devices.length === 0 && <div className="text-micro text-fg-3 italic">No camera detected.</div>}
      {unlabeled && <div className="text-micro text-fg-3 italic">Names appear once a camera has opened successfully.</div>}

      {shown.length > 0 && (
        <details className="pt-0.5">
          <summary className="text-micro text-fg-2 cursor-pointer select-none">Camera controls</summary>
          <div className="space-y-1.5 pt-1.5">
            {shown.map((c) => {
              const cap = caps![c.key];
              const choices = asChoices(cap);
              const range = asRange(cap);
              const saved = content.cameraControls?.[c.key];
              if (choices) {
                return (
                  <div key={c.key} className={rowCls} title={c.hint}>
                    <label className="text-fg-2 w-16 shrink-0 truncate text-micro">{c.label}</label>
                    <select value={(saved as string) ?? ''} onChange={(e) => setControl(c.key, e.target.value)} className={selCls}>
                      <option value="">Camera default</option>
                      {choices.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                );
              }
              if (!range || range.max === undefined) return null;
              const min = range.min ?? 0;
              const max = range.max;
              const step = range.step && range.step > 0 ? range.step : (max - min) / 100;
              // Falls back to what the DEVICE currently reports, so an untouched slider sits where the
              // picture actually is instead of at an invented zero.
              const value = (saved as number) ?? num(settings?.[c.key]) ?? min;
              return (
                <div key={c.key} title={c.hint}>
                  <Slider
                    label={c.label} value={Math.min(max, Math.max(min, value))} min={min} max={max} step={step}
                    format={(v) => (step >= 1 ? String(Math.round(v)) : v.toFixed(2))}
                    // onInput goes STRAIGHT to the device (no document write, no re-render); onChange
                    // commits the released value into the project. See previewCameraControl.
                    onInput={(v) => previewCameraControl(id, c.key, v)}
                    onChange={(v) => setControl(c.key, v)}
                  />
                </div>
              );
            })}
            {content.cameraControls && (
              <button onClick={() => onChange({ cameraControls: undefined })} className="w-full px-1.5 py-1 rounded border border-line-1 text-micro text-fg-2">
                Reset to camera defaults
              </button>
            )}
          </div>
        </details>
      )}
    </div>
  );
};
