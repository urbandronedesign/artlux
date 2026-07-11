// Audio settings section (Preferences ▸ Audio). Engine status, output channel count, how the ambisonic
// field is rendered (binaural HRTF for headphones, or a decode to a real speaker layout), a live
// per-channel meter, and the detected output devices. Talks to the main-process engine via audioClient.
import React, { useEffect, useRef, useState } from 'react';
import { audioClient } from './audioClient';
import type { OutputMode, SpeakerLayout } from './audioManager';

interface AudioCfg { outputChannels?: number; outputMode?: OutputMode; speakerLayout?: SpeakerLayout }

// name → speaker count, so the UI can warn when a layout needs more channels than the device is opened with.
const LAYOUTS: { id: SpeakerLayout; label: string; speakers: number }[] = [
  { id: 'stereo', label: 'Stereo', speakers: 2 },
  { id: 'quad', label: 'Quad', speakers: 4 },
  { id: '5.0', label: '5.0', speakers: 5 },
  { id: '5.1', label: '5.1', speakers: 6 },
  { id: '7.0', label: '7.0', speakers: 7 },
  { id: '7.1', label: '7.1', speakers: 8 },
  { id: 'hexagon', label: 'Hexagon (6, ring)', speakers: 6 },
  { id: 'octagon', label: 'Octagon (8, ring)', speakers: 8 },
  { id: 'cube', label: 'Cube (8, 3D)', speakers: 8 },
];

// Settings are the host AppSettings (generic/unknown at this SDK boundary) — typed loosely here, like the
// other first-party settings sections, and read/patched through the `plugins.audio` slice.
export const AudioSettings: React.FC<{ settings: any; onChange: (patch: any) => void }> = ({ settings, onChange }) => {
  const cfg: AudioCfg = settings?.plugins?.audio ?? {};
  const outCh = cfg.outputChannels ?? 2;
  const mode: OutputMode = cfg.outputMode ?? 'binaural';
  const layout: SpeakerLayout = cfg.speakerLayout ?? 'stereo';

  const [devices, setDevices] = useState<string[]>([]);
  const [device, setDevice] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [meter, setMeter] = useState<{ peaks: number[]; speakers: number }>({ peaks: [], speakers: 0 });
  const holds = useRef<number[]>([]);

  const apply = (ch: number, m: OutputMode, l: SpeakerLayout) =>
    audioClient.configure(ch, m, l)
      .then((name) => { setDevice(name); setError(null); })
      .catch((e) => setError(String(e?.message ?? e)));

  useEffect(() => {
    let live = true;
    audioClient.getDevices().then((d) => { if (live) setDevices(d ?? []); }).catch(() => {});
    void apply(outCh, mode, layout); // idempotent engine-side; returns the open device
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const iv = setInterval(() => {
      audioClient.getMeters().then((m) => {
        const peaks = m.peaks ?? [];
        holds.current = peaks.map((v, i) => Math.max((holds.current[i] ?? 0) * 0.92, v));
        setMeter({ peaks: holds.current.slice(), speakers: m.speakers ?? 0 });
      }).catch(() => {});
    }, 100);
    return () => clearInterval(iv);
  }, []);

  const patchCfg = (p: AudioCfg) =>
    onChange({ plugins: { ...(settings?.plugins ?? {}), audio: { ...cfg, ...p } } });

  const setChannels = (ch: number) => { patchCfg({ outputChannels: ch }); void apply(ch, mode, layout); };
  const setMode = (m: OutputMode) => { patchCfg({ outputMode: m }); void apply(outCh, m, layout); };
  const setLayout = (l: SpeakerLayout) => { patchCfg({ speakerLayout: l }); void apply(outCh, mode, l); };

  const available = !error && !!device;
  const pct = (v: number) => `${Math.min(100, Math.round(v * 100))}%`;
  const need = LAYOUTS.find((l) => l.id === layout)?.speakers ?? 2;
  const shortChannels = mode === 'speakers' && need > outCh;

  return (
    <div className="space-y-4">
      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Engine</div>
        {available ? (
          <div className="text-mini text-fg-3">Native JUCE + ambisonic engine active · output device: <span className="text-fg-1">{device || 'default'}</span></div>
        ) : (
          <div className="text-mini text-warn">Audio engine unavailable{error ? ` — ${error}` : ''}. Playback is disabled.</div>
        )}
      </div>

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Spatial output</div>
        <div className="flex items-center gap-1">
          <button onClick={() => setMode('binaural')}
            className={`px-2 h-6 rounded text-mini border ${mode === 'binaural' ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}>Binaural (headphones)</button>
          <button onClick={() => setMode('speakers')}
            className={`px-2 h-6 rounded text-mini border ${mode === 'speakers' ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}>Speaker layout</button>
        </div>
        <div className="text-micro text-fg-3 mt-1">
          {mode === 'binaural'
            ? 'The ambisonic field is decoded to stereo with an HRTF — a true 3D image, but only over headphones.'
            : 'The same ambisonic field is decoded to a real speaker array. This is the mode for an installation.'}
        </div>

        {mode === 'speakers' && (
          <div className="mt-2 flex items-center gap-2">
            <select value={layout} onChange={(e) => setLayout(e.target.value as SpeakerLayout)}
              className="bg-surface-2 border border-line-1 rounded px-1.5 h-6 text-mini text-fg-1 outline-none">
              {LAYOUTS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
            <span className="text-micro text-fg-3">decoding to {meter.speakers || need} speakers</span>
          </div>
        )}
        {shortChannels && (
          <div className="text-micro text-warn mt-1">
            This layout needs {need} channels but the device is open with {outCh} — only the first {outCh} speakers will be heard. Raise the channel count below.
          </div>
        )}
      </div>

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Output channels</div>
        <div className="flex items-center gap-1">
          {[1, 2, 4, 6, 8].map((ch) => (
            <button key={ch} onClick={() => setChannels(ch)}
              className={`px-2 h-6 rounded text-mini border ${outCh === ch ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}>
              {ch === 1 ? 'Mono' : ch === 2 ? 'Stereo' : `${ch}ch`}
            </button>
          ))}
        </div>
        <div className="text-micro text-fg-3 mt-1">Uses the system default output device.</div>
      </div>

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Meters</div>
        <div className="space-y-0.5">
          {Array.from({ length: Math.max(2, Math.min(outCh, 8)) }).map((_, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-micro text-fg-3 w-4 tabular-nums">{i + 1}</span>
              <div className="flex-1 h-1.5 rounded bg-surface-2 overflow-hidden">
                <div className="h-full bg-accent transition-[width] duration-75" style={{ width: pct(meter.peaks[i] ?? 0) }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Detected output devices ({devices.length})</div>
        <div className="space-y-0.5 max-h-24 overflow-auto">
          {devices.length === 0 ? (
            <div className="text-micro text-fg-3 italic">None enumerated.</div>
          ) : devices.map((d) => (
            <div key={d} className={`text-micro px-1.5 py-0.5 rounded ${d === device ? 'bg-accent/20 text-fg-1' : 'text-fg-3'}`}>{d}</div>
          ))}
        </div>
      </div>
    </div>
  );
};
