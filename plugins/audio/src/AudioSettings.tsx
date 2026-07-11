// Audio settings section (Preferences ▸ Audio). Shows the native engine status, lets the operator
// pick the output channel count (persisted under settings.plugins.audio), lists the available output
// devices, and renders a live master meter. Talks to the main-process engine via audioClient (IPC).
import React, { useEffect, useRef, useState } from 'react';
import { audioClient } from './audioClient';

interface AudioCfg { outputChannels?: number }

// Settings are the host AppSettings (generic/unknown at this SDK boundary) — typed loosely here, like
// the other first-party settings sections, and read/patched through the `plugins.audio` slice.
export const AudioSettings: React.FC<{ settings: any; onChange: (patch: any) => void }> = ({ settings, onChange }) => {
  const cfg: AudioCfg = settings?.plugins?.audio ?? {};
  const outCh = cfg.outputChannels ?? 2;

  const [devices, setDevices] = useState<string[]>([]);
  const [device, setDevice] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [meter, setMeter] = useState({ peak: 0, rms: 0 });
  const peakHold = useRef(0);

  // Enumerate devices + read the currently-open device once on mount.
  useEffect(() => {
    let live = true;
    audioClient.getDevices().then((d) => { if (live) setDevices(d ?? []); }).catch(() => {});
    // configure() is idempotent for the same channel count and returns the open device's name.
    audioClient.configure(outCh).then((name) => { if (live) { setDevice(name); setError(null); } })
      .catch((e) => { if (live) setError(String(e?.message ?? e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll the master meter ~10 Hz while the section is mounted.
  useEffect(() => {
    const iv = setInterval(() => {
      audioClient.getMeters().then((m) => {
        peakHold.current = Math.max(peakHold.current * 0.92, m.peak);
        setMeter({ peak: peakHold.current, rms: m.rms });
      }).catch(() => {});
    }, 100);
    return () => clearInterval(iv);
  }, []);

  const patchCfg = (p: AudioCfg) =>
    onChange({ plugins: { ...(settings?.plugins ?? {}), audio: { ...cfg, ...p } } });

  const setChannels = (ch: number) => {
    patchCfg({ outputChannels: ch });
    audioClient.configure(ch).then((name) => { setDevice(name); setError(null); })
      .catch((e) => setError(String(e?.message ?? e)));
  };

  const available = !error && !!device;
  const pct = (v: number) => `${Math.min(100, Math.round(v * 100))}%`;

  return (
    <div className="space-y-4">
      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Engine</div>
        {available ? (
          <div className="text-mini text-fg-3">Native JUCE engine active · output device: <span className="text-fg-1">{device || 'default'}</span></div>
        ) : (
          <div className="text-mini text-warn">Audio engine unavailable{error ? ` — ${error}` : ''}. Playback is disabled.</div>
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
        <div className="text-micro text-fg-3 mt-1">Uses the system default output device. Speaker-layout decode + device selection arrive with spatialisation.</div>
      </div>

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Master meter</div>
        <div className="h-2 w-full rounded bg-surface-2 overflow-hidden">
          <div className="h-full bg-accent transition-[width] duration-75" style={{ width: pct(meter.peak) }} />
        </div>
        <div className="text-micro text-fg-3 mt-1">peak {meter.peak.toFixed(3)} · rms {meter.rms.toFixed(3)}</div>
      </div>

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Detected output devices ({devices.length})</div>
        <div className="space-y-0.5 max-h-28 overflow-auto">
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
