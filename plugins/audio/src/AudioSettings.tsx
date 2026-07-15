// Audio settings section (Preferences ▸ Audio). Engine status, an output device picker (grouped by driver
// type), sample rate / buffer size, how the ambisonic field is rendered (binaural HRTF for headphones, or a
// decode to a real speaker layout), and a live per-channel meter. Talks to the main-process engine via
// audioClient. Every readout renders what the engine ACTUALLY OPENED, not what was requested.
import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { audioClient } from './audioClient';
import type { DeviceEntry, OpenedCfg, OutputMode, SpeakerLayout } from './audioManager';

interface AudioCfg {
  outputChannels?: number; outputMode?: OutputMode; speakerLayout?: SpeakerLayout;
  deviceType?: string; deviceName?: string; sampleRate?: number; bufferSize?: number;
}

const SAMPLE_RATES = [0, 44100, 48000, 88200, 96000];
const BUFFER_SIZES = [0, 128, 256, 512, 1024];

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

  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [device, setDevice] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  // WHAT WE ACTUALLY GOT, not what we asked for. A stereo card asked for 8 channels opens with 2, and a
  // panel that renders the REQUEST describes a rig that does not exist. Every readout below reads this.
  const [opened, setOpened] = useState<OpenedCfg | null>(null);
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

  const apply = (c: AudioCfg) =>
    audioClient.configure({
      deviceType: c.deviceType, deviceName: c.deviceName,
      channels: c.outputChannels ?? 2, sampleRate: c.sampleRate ?? 0, bufferSize: c.bufferSize ?? 0,
      mode: c.outputMode ?? 'binaural', layout: c.speakerLayout ?? 'stereo',
    })
      .then((got) => { setOpened(got); setDevice(got.deviceName); setError(null); })
      .catch((e) => setError(String(e?.message ?? e)));

  useEffect(() => {
    let live = true;
    audioClient.available().then((v) => { if (live) setEngineUp(v); }).catch(() => {});
    audioClient.getDevices().then((d) => { if (live) setDevices(d ?? []); }).catch(() => {});
    void apply(cfg); // idempotent engine-side; returns the setup actually opened
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

  // Every picker patches the cfg and re-applies the WHOLE thing — the engine's guard now keys on the whole
  // setup, so it reopens only when something actually changed.
  const patchAndApply = (p: AudioCfg) => { patchCfg(p); void apply({ ...cfg, ...p }); };

  const setChannels = (ch: number) => patchAndApply({ outputChannels: ch });
  const setMode = (m: OutputMode) => patchAndApply({ outputMode: m });
  const setLayout = (l: SpeakerLayout) => patchAndApply({ speakerLayout: l });

  // `available` is GONE, and its removal is the fix. It was `engineUp && !error` — a single boolean standing
  // in for a question that has THREE answers (no addon / no device / running), and it collapsed the one that
  // matters in a venue into the one that never happens on a working install. The status block below asks the
  // three questions separately. Do not reintroduce a single "is audio ok" flag: there isn't one.
  const pct = (v: number) => `${Math.min(100, Math.round(v * 100))}%`;
  const need = LAYOUTS.find((l) => l.id === layout)?.speakers ?? 2;
  const shortChannels = mode === 'speakers' && need > outCh;

  // ── OPTION VALUES ARE INDICES, NOT `${type} ${name}` STRINGS ────────────────────────────────────────
  // Driver type names and device names ROUTINELY CONTAIN SPACES — "Windows Audio (Exclusive Mode)",
  // "Focusrite Scarlett 2i2 USB" — so a space-joined value split back on ' ' silently shreds both fields
  // (`"Windows Audio (Exclusive Mode) Focusrite Scarlett 2i2 USB".split(' ')` gives type "Windows", name
  // "Audio"). That sends configure() a device that matches nothing, the native side rolls back to
  // whatever was already open, and the corrupted {type,name} still gets persisted — so the picker looks
  // wired while silently reopening the wrong box. An index into a flat array can't be corrupted by any
  // character in a name, so that's what the <option value> carries instead.
  //
  // `deviceGroups` is the SAME structure rendered as optgroups below; `flatDevices` is that structure
  // flattened, not a second grouping of `devices` that could put things in a different order.
  const deviceGroups = Object.entries(devices.reduce<Record<string, DeviceEntry[]>>((acc, d) => {
    (acc[d.type] ??= []).push(d); return acc;
  }, {}));
  const flatDevices = deviceGroups.flatMap(([, ds]) => ds);
  const selectedIndex = flatDevices.findIndex((d) => d.type === cfg.deviceType && d.name === cfg.deviceName);
  // 'default' is not a valid array index and can never collide with a real flat-index value — it means
  // "no device picked yet" as well as the explicit "System default" choice, both of which resolve to
  // {deviceType: undefined, deviceName: undefined} (today's "that driver type's default device").
  const selectValue = selectedIndex >= 0 ? String(selectedIndex) : 'default';

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
            {/* ⚠ "GONE" AND "NEVER THERE" ARE DIFFERENT SENTENCES, AND ONLY THIS PANEL CAN TELL THEM APART.
                `device` holds the name of the last device we successfully OPENED, and `apply()` never clears
                it on failure — so a non-empty name means we HAD one and lost it. Empty means configure() has
                never succeeded on this machine: there is no audio hardware (a DMX-only or headless install is
                a real deployment for this app). Printing "usually a bumped USB cable" at someone whose machine
                has no sound card at all sends them hunting for a cable that never existed. The Audio Bed's
                badge stays the neutral "no output device", which is true either way; this panel knows more,
                so it says more. */}
            <div className="text-mini text-danger flex items-center gap-1.5">
              <AlertTriangle size={12} className="shrink-0" />
              <span><strong>{device
                ? 'The output device is gone — the room is silent.'
                : 'No audio output device — there is no sound.'}</strong></span>
            </div>
            <div className="text-micro text-fg-3">
              {device ? (
                <>The engine is loaded and the show is still running, but <span className="text-fg-2">{device}</span> —
                the interface it was playing through — has disappeared. Usually a bumped USB cable, a driver
                reload, or Windows power-cycling the device.{' '}
                <strong className="text-fg-2">ArtLux will not re-open it on its own.</strong></>
              ) : (
                <>The engine is loaded, but no output device could be opened on this machine. Authoring, saving
                and every non-audio output (DMX, projectors, OSC) work normally — there is simply nowhere to
                send sound.</>
              )}
            </div>
            <div className="text-micro text-fg-3">
              {device
                ? 'Reconnect the interface, then press Reconnect. Sound returns with no restart.'
                : 'Connect an output device, then press Reconnect.'}
            </div>
            {/* THE RECOVERY GESTURE, WHICH DID NOT EXIST. configure() used to take (channels, mode, layout) and
                open the DEFAULT device — there was no device picker anywhere in this panel, so "just pick it
                again" was never actually possible. It now re-opens the NAMED device (cfg.deviceType/deviceName),
                so the recovery gesture finally reaches the interface that actually vanished. */}
            <button onClick={() => void apply(cfg)}
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
        <div className="text-mini font-semibold text-fg-2 mb-1">Output device</div>
        <select
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'default') { patchAndApply({ deviceType: undefined, deviceName: undefined }); return; }
            const d = flatDevices[Number(v)];
            if (d) patchAndApply({ deviceType: d.type, deviceName: d.name });
          }}
          className="w-full bg-surface-2 border border-line-1 rounded px-1.5 h-6 text-mini text-fg-1 outline-none"
        >
          <option value="default">System default</option>
          {(() => {
            let offset = 0;
            return deviceGroups.map(([type, ds]) => {
              const start = offset;
              offset += ds.length;
              return (
                <optgroup key={type} label={type}>
                  {ds.map((d, j) => (
                    <option key={start + j} value={String(start + j)}>
                      {d.name}{d.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </optgroup>
              );
            });
          })()}
        </select>
        {/* ── THE SENTENCE THAT MAKES MULTICHANNEL POSSIBLE ────────────────────────────────────────────────
            An operator cannot be expected to know that "Windows Audio" and "Windows Audio (Exclusive Mode)"
            are the difference between a stereo downmix and eight discrete outputs. The dropdown groups by
            driver type; this says what the groups MEAN. Do not shorten it to "choose a device". */}
        <div className="text-micro text-fg-3 mt-1">
          Devices are grouped by <span className="text-fg-2">driver type</span>. For a multichannel interface
          choose <span className="text-fg-2">Exclusive Mode</span> — it hands ArtLux the card's discrete outputs.
          Shared mode routes through the Windows mixer and will usually give you stereo, whatever the card can do.
        </div>
        {opened && (
          <div className="text-micro text-fg-3 mt-1">
            Open: <span className="text-fg-1">{opened.deviceName || 'default'}</span> ·{' '}
            {opened.channels} ch · {(opened.sampleRate / 1000).toFixed(1)} kHz · {opened.bufferSize} samples
          </div>
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
        <div className="text-micro text-fg-3 mt-1">Requested — see &quot;Open:&quot; above for what the device actually gave.</div>
      </div>

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Sample rate</div>
        <div className="flex items-center gap-1">
          {SAMPLE_RATES.map((r) => (
            <button key={r} onClick={() => patchAndApply({ sampleRate: r })}
              className={`px-2 h-6 rounded text-mini border ${(cfg.sampleRate ?? 0) === r ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}>
              {r === 0 ? 'Device default' : `${(r / 1000).toFixed(1)} kHz`}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Buffer size</div>
        <div className="flex items-center gap-1">
          {BUFFER_SIZES.map((b) => (
            <button key={b} onClick={() => patchAndApply({ bufferSize: b })}
              className={`px-2 h-6 rounded text-mini border ${(cfg.bufferSize ?? 0) === b ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}>
              {b === 0 ? 'Device default' : `${b} samples`}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Meters</div>
        <div className="space-y-0.5">
          {Array.from({ length: Math.max(2, Math.min(opened?.channels ?? outCh, 8)) }).map((_, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-micro text-fg-3 w-4 tabular-nums">{i + 1}</span>
              <div className="flex-1 h-1.5 rounded bg-surface-2 overflow-hidden">
                <div className="h-full bg-accent transition-[width] duration-75" style={{ width: pct(meter.peaks[i] ?? 0) }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
