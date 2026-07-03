import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, SlidersHorizontal, RotateCcw } from 'lucide-react';
import * as cam from '../calibCapture';

// Full camera-parameter panel for the calibration workspace. Exposes every capture property the
// addon / browser can drive (exposure, gain, gamma, brightness, contrast, white balance, focus,
// saturation, hue, sharpness, zoom) plus resolution + fps (a camera re-open). Props the live source
// can't drive are greyed out (browser: from getCapabilities; native: shown, driver may no-op).
//
// Native exposure/wb/focus only take effect once their AUTO mode is disabled, so each auto toggle
// gates its manual sliders and writes the matching auto prop first (autoexposure=0.25 is the DShow
// "manual" sentinel; auto_wb/autofocus use 0/1).

interface SliderDef { prop: string; label: string; min: number; max: number; step: number; def: number }

// Generic raw-value ranges (used as-is for native; browser overrides from getCapabilities).
const SIMPLE: SliderDef[] = [
  { prop: 'gamma', label: 'Gamma', min: 1, max: 500, step: 1, def: 100 },
  { prop: 'brightness', label: 'Brightness', min: 0, max: 255, step: 1, def: 128 },
  { prop: 'contrast', label: 'Contrast', min: 0, max: 255, step: 1, def: 128 },
  { prop: 'saturation', label: 'Saturation', min: 0, max: 255, step: 1, def: 128 },
  { prop: 'hue', label: 'Hue', min: -180, max: 180, step: 1, def: 0 },
  { prop: 'sharpness', label: 'Sharpness', min: 0, max: 255, step: 1, def: 128 },
  { prop: 'zoom', label: 'Zoom', min: 100, max: 800, step: 10, def: 100 },
];
const EXPOSURE: SliderDef = { prop: 'exposure', label: 'Exposure', min: -13, max: 0, step: 1, def: -6 };
const GAIN: SliderDef = { prop: 'gain', label: 'Gain', min: 0, max: 100, step: 1, def: 0 };
const WB_TEMP: SliderDef = { prop: 'wb_temperature', label: 'Temp (K)', min: 2000, max: 10000, step: 100, def: 4600 };
const FOCUS: SliderDef = { prop: 'focus', label: 'Focus', min: 0, max: 255, step: 1, def: 0 };

const RESOLUTIONS: [number, number][] = [[640, 480], [800, 600], [1280, 720], [1920, 1080]];
const FPS_OPTS = [15, 30, 60, 75, 120];

interface Props {
  camOn: boolean;
  /** Bump to re-seed values + capabilities (e.g. after (re)starting the camera). */
  sessionKey: number;
  width: number; height: number; fps: number;
  /** Re-open the camera at a new mode (resolution / fps). */
  onReopen: (width: number, height: number, fps: number) => void;
}

export const CameraParamsPanel: React.FC<Props> = ({ camOn, sessionKey, width, height, fps, onReopen }) => {
  const [open, setOpen] = useState(true);
  const [vals, setVals] = useState<Record<string, number>>({});
  const [autoExp, setAutoExp] = useState(true);
  const [autoWb, setAutoWb] = useState(true);
  const [autoFocus, setAutoFocus] = useState(true);
  const [supported, setSupported] = useState<Set<string> | null>(null); // null = all (native)
  const [ranges, setRanges] = useState<Record<string, cam.PropRange>>({});
  const seeded = useRef(false);

  // (Re)seed capabilities, ranges and current values when the camera (re)starts.
  useEffect(() => {
    if (!camOn) { seeded.current = false; return; }
    let alive = true;
    (async () => {
      const [sup, rng] = await Promise.all([cam.supportedProps(), cam.propRanges()]);
      if (!alive) return;
      setSupported(sup);
      setRanges(rng ?? {});
      const all = [EXPOSURE, GAIN, WB_TEMP, FOCUS, ...SIMPLE];
      const next: Record<string, number> = {};
      for (const d of all) {
        const cur = await cam.getProp(d.prop);
        next[d.prop] = cur != null ? cur : d.def;
      }
      if (alive) { setVals(next); seeded.current = true; }
    })();
    return () => { alive = false; };
  }, [camOn, sessionKey]);

  const isSupported = (prop: string) => supported == null || supported.has(prop);
  const rangeFor = (d: SliderDef): SliderDef => {
    const r = ranges[d.prop];
    return r ? { ...d, min: r.min, max: r.max, step: r.step || d.step } : d;
  };

  const apply = (prop: string, value: number) => {
    setVals((v) => ({ ...v, [prop]: value }));
    void cam.setProp(prop, value);
  };

  const toggleAuto = async (which: 'exp' | 'wb' | 'focus', on: boolean) => {
    if (which === 'exp') { setAutoExp(on); await cam.setProp('autoexposure', on ? 1 : 0.25); if (!on) { apply('exposure', vals.exposure ?? EXPOSURE.def); apply('gain', vals.gain ?? GAIN.def); } }
    if (which === 'wb') { setAutoWb(on); await cam.setProp('auto_wb', on ? 1 : 0); if (!on) apply('wb_temperature', vals.wb_temperature ?? WB_TEMP.def); }
    if (which === 'focus') { setAutoFocus(on); await cam.setProp('autofocus', on ? 1 : 0); if (!on) apply('focus', vals.focus ?? FOCUS.def); }
  };

  const Slider: React.FC<{ d: SliderDef; disabled?: boolean }> = ({ d, disabled }) => {
    const def = rangeFor(d);
    const off = !isSupported(d.prop) || disabled;
    const val = vals[d.prop] ?? def.def;
    return (
      <label className={`flex items-center gap-1.5 text-micro ${off ? 'opacity-40' : 'text-fg-3'}`}>
        <span className="w-16 shrink-0">{d.label}</span>
        <input type="range" min={def.min} max={def.max} step={def.step} value={val} disabled={off}
          onChange={(e) => apply(d.prop, parseFloat(e.target.value))} className="flex-1" />
        <span className="w-10 text-right num tabular-nums">{off ? 'n/a' : Number.isInteger(val) ? val : val.toFixed(1)}</span>
      </label>
    );
  };

  return (
    <div className="border-t border-line-1 pt-2">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 w-full text-fg-2 hover:text-fg-1">
        <ChevronRight size={13} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        <SlidersHorizontal size={12} /> <span className="text-mini font-medium">Camera parameters</span>
      </button>

      {open && (
        <div className={`mt-2 space-y-2 ${camOn ? '' : 'opacity-50 pointer-events-none'}`}>
          {/* Exposure + gain */}
          <div className="space-y-1">
            <label className="flex items-center gap-1.5 text-micro text-fg-3 cursor-pointer">
              <input type="checkbox" checked={autoExp} disabled={!isSupported('autoexposure')} onChange={(e) => toggleAuto('exp', e.target.checked)} />
              <span>Auto exposure</span>
            </label>
            {!autoExp && (<><Slider d={EXPOSURE} /><Slider d={GAIN} /></>)}
          </div>

          {/* White balance */}
          <div className="space-y-1 border-t border-line-1 pt-1">
            <label className="flex items-center gap-1.5 text-micro text-fg-3 cursor-pointer">
              <input type="checkbox" checked={autoWb} disabled={!isSupported('auto_wb')} onChange={(e) => toggleAuto('wb', e.target.checked)} />
              <span>Auto white balance</span>
            </label>
            {!autoWb && <Slider d={WB_TEMP} />}
          </div>

          {/* Focus */}
          <div className="space-y-1 border-t border-line-1 pt-1">
            <label className="flex items-center gap-1.5 text-micro text-fg-3 cursor-pointer">
              <input type="checkbox" checked={autoFocus} disabled={!isSupported('autofocus')} onChange={(e) => toggleAuto('focus', e.target.checked)} />
              <span>Auto focus</span>
            </label>
            {!autoFocus && <Slider d={FOCUS} />}
          </div>

          {/* Image controls */}
          <div className="space-y-1 border-t border-line-1 pt-1">
            {SIMPLE.map((d) => <Slider key={d.prop} d={d} />)}
          </div>

          {/* Resolution + fps (re-open) */}
          <div className="space-y-1 border-t border-line-1 pt-1">
            <div className="flex items-center gap-1.5 text-micro text-fg-3">
              <span className="w-16 shrink-0">Resolution</span>
              <select value={`${width}x${height}`} onChange={(e) => { const [w, h] = e.target.value.split('x').map(Number); onReopen(w, h, fps); }}
                className="flex-1 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-fg-1 focus:border-accent focus:outline-none">
                {RESOLUTIONS.map(([w, h]) => <option key={`${w}x${h}`} value={`${w}x${h}`}>{w}×{h}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1.5 text-micro text-fg-3">
              <span className="w-16 shrink-0">FPS</span>
              <select value={fps} onChange={(e) => onReopen(width, height, parseInt(e.target.value, 10))}
                className="flex-1 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-fg-1 focus:border-accent focus:outline-none">
                {FPS_OPTS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1 text-fg-4 text-micro"><RotateCcw size={9} /> changing resolution / fps restarts the camera</div>
          </div>
        </div>
      )}
    </div>
  );
};
