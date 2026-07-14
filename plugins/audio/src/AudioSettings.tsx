// Audio settings section (Preferences ▸ Audio). Engine status, output channel count, how the ambisonic
// field is rendered (binaural HRTF for headphones, or a decode to a real speaker layout), a live
// per-channel meter, and the detected output devices. Talks to the main-process engine via audioClient.
import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
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
  // THE REAL SIGNAL. This used to be inferred from configure() returning an empty device name — a guess
  // derived from a side effect, and the reason a dead engine was never surfaced anywhere an operator
  // would look. Defaults true so the warning never flashes while the probe is in flight.
  const [engineUp, setEngineUp] = useState(true);
  // ⚠ A DIFFERENT QUESTION FROM `engineUp`, AND THE ONE THAT ACTUALLY HAPPENS IN A VENUE. `available()`
  // reports only that the .node LOADED — and the addon stays perfectly loaded when the audio interface is
  // UNPLUGGED. So this panel used to print "Native JUCE + ambisonic engine active · output device: <name>"
  // over a silent room, NAMING A DEVICE THAT WAS PHYSICALLY GONE. Read from JUCE's getCurrentAudioDevice()
  // and carried on the meters poll below, which already runs at 10 Hz. Defaults true (no flash on startup).
  const [deviceLive, setDeviceLive] = useState(true);
  const [meter, setMeter] = useState<{ peaks: number[]; speakers: number }>({ peaks: [], speakers: 0 });
  const holds = useRef<number[]>([]);

  const apply = (ch: number, m: OutputMode, l: SpeakerLayout) =>
    audioClient.configure(ch, m, l)
      .then((name) => { setDevice(name); setError(null); })
      .catch((e) => setError(String(e?.message ?? e)));

  useEffect(() => {
    let live = true;
    audioClient.available().then((v) => { if (live) setEngineUp(v); }).catch(() => {});
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
        // `!== false`, never a bare assignment: an old main process hands back a meters object with no
        // `deviceLive` field at all, and `undefined` is falsy — a bare read would raise a "no output device"
        // alarm over a perfectly healthy rig. Only an EXPLICIT false lights it.
        setDeviceLive(m.deviceLive !== false);
      }).catch(() => {});   // a rejected poll lights nothing
    }, 100);
    return () => clearInterval(iv);
  }, []);

  const patchCfg = (p: AudioCfg) =>
    onChange({ plugins: { ...(settings?.plugins ?? {}), audio: { ...cfg, ...p } } });

  const setChannels = (ch: number) => { patchCfg({ outputChannels: ch }); void apply(ch, mode, layout); };
  const setMode = (m: OutputMode) => { patchCfg({ outputMode: m }); void apply(outCh, m, layout); };
  const setLayout = (l: SpeakerLayout) => { patchCfg({ speakerLayout: l }); void apply(outCh, mode, l); };

  // `available` is GONE, and its removal is the fix. It was `engineUp && !error` — a single boolean standing
  // in for a question that has THREE answers (no addon / no device / running), and it collapsed the one that
  // matters in a venue into the one that never happens on a working install. The status block below asks the
  // three questions separately. Do not reintroduce a single "is audio ok" flag: there isn't one.
  const pct = (v: number) => `${Math.min(100, Math.round(v * 100))}%`;
  const need = LAYOUTS.find((l) => l.id === layout)?.speakers ?? 2;
  const shortChannels = mode === 'speakers' && need > outCh;

  return (
    <div className="space-y-4">
      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Engine</div>
        {/* ── THREE STATES, NOT TWO. The missing third one is the one that happens in a venue. ──────────
            This block used to ask ONE question — "did the addon load?" — and answer it with a sentence about
            the DEVICE. So when the audio interface was unplugged it went on printing "engine active · output
            device: Focusrite Scarlett 2i2", naming hardware that was physically gone, over a silent room,
            with the show still running. The operator's diagnosis, from the only screen that claims to know,
            was "the audio engine is fine."
            `!deviceLive` is checked FIRST because it is the more specific failure: with no addon there is
            also no device, and telling someone to check their USB cable when the real problem is a missing
            build would send them to the wrong end of the room. */}
        {!engineUp ? (
          <div className="text-mini text-warn">Audio engine unavailable{error ? ` — ${error}` : ''}. Playback is disabled.</div>
        ) : !deviceLive ? (
          <div className="space-y-1.5">
            <div className="text-mini text-danger flex items-center gap-1.5">
              <AlertTriangle size={12} className="shrink-0" />
              <span><strong>The output device is gone — the room is silent.</strong></span>
            </div>
            <div className="text-micro text-fg-3">
              The engine is loaded and the show is still running, but the audio interface it was playing
              through has disappeared — usually a bumped USB cable, a driver reload, or Windows power-cycling
              the device. <strong className="text-fg-2">ArtLux will not re-open it on its own.</strong>
            </div>
            <div className="text-micro text-fg-3">
              Reconnect the interface, then press Reconnect. Sound returns with no restart.
            </div>
            {/* THE RECOVERY GESTURE, WHICH DID NOT EXIST. configure() takes (channels, mode, layout) and opens
                the DEFAULT device — there is no device picker anywhere in this panel, so "just pick it again"
                was never actually possible. The only lever an operator had was to change the channel count and
                change it back, and even THAT did nothing until the `opened` guard learned to invalidate itself
                (engine.cpp). This button is that lever, named. */}
            <button onClick={() => void apply(outCh, mode, layout)}
              className="inline-flex items-center gap-1.5 px-2 h-7 rounded border border-danger/40 bg-danger/10 text-danger text-mini hover:bg-danger/20">
              <RefreshCw size={12} /> Reconnect
            </button>
            {error && <div className="text-micro text-warn">Last attempt failed — {error}</div>}
          </div>
        ) : error ? (
          <div className="text-mini text-warn">Audio engine unavailable — {error}. Playback is disabled.</div>
        ) : (
          <div className="text-mini text-fg-3">Native JUCE + ambisonic engine active · output device: <span className="text-fg-1">{device || 'default'}</span></div>
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
