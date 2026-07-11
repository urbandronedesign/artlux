import React, { useEffect, useState } from 'react';
import { X, Cpu, Radar, Check, Radio, Monitor, ShieldAlert } from 'lucide-react';
import { AppSettings } from '../types';
import type { ArtNetDevice, UnattendedPrefs, WatchdogStatus } from '../../../shared/protocol';
import { Section, Field, NumberField, Toggle, Select, Slider, Button } from './ui';
import { settingsSectionRegistry } from '../host/registries';
import { useDraggableModal } from '../hooks/useDraggableModal';

interface Props {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

const WATCHDOG_UI_DEFAULTS: UnattendedPrefs = {
  enabled: false, crashRecovery: true, outputDownSec: 15, renderStallSec: 10,
  minRelaunchGapSec: 30, maxRelaunchesPerHour: 6, always: false,
};

// Unattended self-healing config. Lives on Prefs.unattended (not AppSettings), so this section reads
// and writes it directly through getPrefs/setPrefs and shows live status from the main-side watchdog.
// Changes take effect on the next launch/relaunch (the watchdog arms + attaches its detectors at
// process start), so we make that explicit in the UI.
const WatchdogSection: React.FC<{ open: boolean }> = ({ open }) => {
  const [cfg, setCfg] = useState<UnattendedPrefs>(WATCHDOG_UI_DEFAULTS);
  const [status, setStatus] = useState<WatchdogStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refreshStatus = () => { window.artlux?.getWatchdogStatus?.().then(setStatus).catch(() => {}); };
  useEffect(() => {
    if (!open) return;
    window.artlux?.getPrefs?.().then((p) => {
      if (p?.unattended) setCfg({ ...WATCHDOG_UI_DEFAULTS, ...p.unattended });
    }).catch(() => {});
    refreshStatus();
  }, [open]);

  // Persist a patch to Prefs.unattended. Applies on the next launch/relaunch.
  const update = (patch: Partial<UnattendedPrefs>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    window.artlux?.setPrefs?.({ unattended: next });
  };

  const runTask = async (fn?: () => Promise<{ ok: boolean; message: string }>) => {
    if (!fn) return;
    setBusy(true); setMsg('');
    try { const r = await fn(); setMsg(r?.message ?? ''); }
    catch (e) { setMsg(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); setTimeout(refreshStatus, 1500); }
  };

  return (
    <Section title="Unattended / Watchdog" icon={<ShieldAlert size={12} />}>
      <Toggle label="Self-heal (watchdog)" checked={cfg.enabled} onChange={(v) => update({ enabled: v })}
              title="Auto-relaunch the show if the renderer/GPU crashes, the window hangs, the render loop freezes, or Art-Net output dies. Armed in broadcast mode." />
      <Toggle label="Crash + hang recovery" checked={cfg.crashRecovery} onChange={(v) => update({ crashRecovery: v })}
              title="Tier-1: relaunch on render-process-gone / GPU crash / unresponsive window / frozen render loop" />
      <Toggle label="Arm outside broadcast" checked={!!cfg.always} onChange={(v) => update({ always: v })}
              title="By default the watchdog only arms in --broadcast (so it never surprises you in the editor). Enable to arm everywhere." />
      <NumberField label="Output-down (s)" value={cfg.outputDownSec} step={1} min={2} max={600}
                   onChange={(v) => update({ outputDownSec: Math.max(2, Math.round(v)) })} />
      <NumberField label="Render-stall (s)" value={cfg.renderStallSec} step={1} min={2} max={600}
                   onChange={(v) => update({ renderStallSec: Math.max(2, Math.round(v)) })} />
      <NumberField label="Min relaunch gap (s)" value={cfg.minRelaunchGapSec} step={1} min={0} max={600}
                   onChange={(v) => update({ minRelaunchGapSec: Math.max(0, Math.round(v)) })} />
      <NumberField label="Max relaunches / hour" value={cfg.maxRelaunchesPerHour} step={1} min={1} max={60}
                   onChange={(v) => update({ maxRelaunchesPerHour: Math.max(1, Math.round(v)) })} />

      {/* Live status from the main-side watchdog */}
      <div className="flex flex-wrap gap-1.5 pt-1 text-micro">
        <span className={`px-1.5 py-0.5 rounded-sm border num ${status?.enabled ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-3'}`}>
          {status?.enabled ? 'armed' : 'idle'}
        </span>
        {status?.tripped && <span className="px-1.5 py-0.5 rounded-sm border num bg-danger/15 border-danger text-danger">breaker tripped</span>}
        <span className="px-1.5 py-0.5 rounded-sm border num bg-surface-2 border-line-1 text-fg-3">{status?.relaunchesLastHour ?? 0} relaunch/h</span>
        <span className="px-1.5 py-0.5 rounded-sm border num bg-surface-2 border-line-1 text-fg-3">task {status?.taskInstalled ? 'installed' : 'off'}</span>
      </div>

      {/* Tier-2 OS supervisor (Windows Scheduled Task) — needs elevation */}
      <div className="flex gap-1.5 pt-1">
        <Button variant="tonal" size="sm" disabled={busy} className="flex-1"
                onClick={() => runTask(window.artlux?.installWatchdogTask)}>Install OS task</Button>
        <Button variant="tonal" size="sm" disabled={busy} className="flex-1"
                onClick={() => runTask(window.artlux?.uninstallWatchdogTask)}>Remove OS task</Button>
      </div>
      {msg && <div className="text-micro text-fg-3 italic px-0.5">{msg}</div>}
      <div className="text-micro text-fg-3 px-0.5">Applies on next launch/relaunch. The OS task relaunches the app after a full crash or reboot (Windows only).</div>

      {/* Recent self-heal events (tail of the persistent log; survives relaunches) */}
      {status && status.recent.length > 0 && (
        <div className="border border-line-1 rounded-sm divide-y divide-line-1 max-h-32 overflow-auto mt-1">
          {status.recent.slice(0, 12).map((e, i) => (
            <div key={i} className="flex items-center justify-between gap-2 px-2 py-1 text-micro">
              <span className="min-w-0">
                <span className="block text-fg-1 truncate">{e.trigger} · <span className="text-fg-3">{e.action}</span></span>
                <span className="block num text-micro text-fg-3 truncate">{e.detail}</span>
              </span>
              <span className="num text-micro text-fg-3 shrink-0">{new Date(e.ts).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
};

// GPU rendering diagnostics. WebGPU (compute) is primary; the WebGL fallback does NOT do strict
// per-surface sampling. This section reports which backend is live (recorded to localStorage by Stage),
// probes WebGPU on demand, and lets a tester force the WebGL fallback on this machine to compare — a
// per-machine localStorage flag (`artlux.forceWebGL`), deliberately not a project/prefs field.
const GpuSection: React.FC<{ open: boolean }> = ({ open }) => {
  const [forced, setForced] = useState(false);
  const [active, setActive] = useState('');
  const [probe, setProbe] = useState('');
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    if (!open) return;
    try { setForced(localStorage.getItem('artlux.forceWebGL') === '1'); } catch { /* ignore */ }
    try { setActive(localStorage.getItem('artlux.activeBackend') || ''); } catch { /* ignore */ }
  }, [open]);

  const toggleForce = (v: boolean) => {
    setForced(v);
    try { if (v) localStorage.setItem('artlux.forceWebGL', '1'); else localStorage.removeItem('artlux.forceWebGL'); } catch { /* ignore */ }
  };

  const testWebGPU = async () => {
    setProbing(true); setProbe('');
    try {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
      if (!gpu) { setProbe('navigator.gpu unavailable — this machine can only run the WebGL fallback.'); return; }
      const adapter = await gpu.requestAdapter() as { info?: { vendor?: string; architecture?: string; description?: string } } | null;
      if (!adapter) { setProbe('requestAdapter() returned null — no usable WebGPU adapter (fallback path).'); return; }
      const info = adapter.info;
      const name = info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ').trim() : '';
      setProbe(`WebGPU OK${name ? ' — ' + name : ' — adapter available'}.`);
    } catch (e) {
      setProbe('WebGPU probe threw: ' + String((e as Error)?.message ?? e));
    } finally { setProbing(false); }
  };

  return (
    <Section title="GPU rendering" icon={<Cpu size={12} />}>
      <div className="flex items-center justify-between text-mini">
        <span className="text-fg-3">Active backend</span>
        <span className={`px-1.5 py-0.5 rounded-sm border num ${active === 'webgpu' ? 'bg-accent/15 border-accent text-accent' : active === 'webgl' ? 'bg-warn/15 border-warn text-warn' : 'bg-surface-2 border-line-1 text-fg-3'}`}>
          {active === 'webgpu' ? 'WebGPU (compute)' : active === 'webgl' ? 'WebGL (fallback)' : 'unknown'}
        </span>
      </div>
      <Button variant="tonal" size="sm" className="w-full" disabled={probing} onClick={testWebGPU}>
        {probing ? 'Testing…' : 'Test WebGPU support'}
      </Button>
      {probe && <div className="text-micro text-fg-3 px-0.5 break-words">{probe}</div>}
      <Toggle label="Force WebGL fallback" checked={forced} onChange={toggleForce}
              title="Force the WebGL fallback to test reduced-mode rendering on a machine that has WebGPU. Per-machine only (localStorage) — never travels with the project. Reload to apply." />
      <div className="text-micro text-fg-3 px-0.5">Force-WebGL applies on the next reload (Ctrl+R). The Stage shows a banner while the fallback is active.</div>
    </Section>
  );
};

// Tabbed-modal-style Preferences (output + engine), replacing inline settings.
export const Preferences: React.FC<Props> = ({ open, onClose, settings, onChange }) => {
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [devices, setDevices] = useState<ArtNetDevice[]>([]);
  const [localAddrs, setLocalAddrs] = useState<string[]>([]);
  const [uiScaleValue, setUiScaleValue] = useState(1); // main-window zoom factor; applied in main

  useEffect(() => {
    if (!open) return;
    window.artlux?.listLocalAddrs?.().then((a) => setLocalAddrs(a ?? [])).catch(() => setLocalAddrs([]));
    // Show the scale in effect: the saved value, else the auto-detected default for this display.
    (async () => {
      const p = await window.artlux?.getPrefs?.();
      const s = typeof p?.uiScale === 'number' ? p.uiScale : await window.artlux?.detectUiScale?.();
      if (typeof s === 'number') setUiScaleValue(s);
    })();
  }, [open]);

  // Apply immediately (main persists + zooms) and reflect in the slider readout.
  const applyScale = (v: number) => { setUiScaleValue(v); window.artlux?.setUiScale?.(v); };

  const scan = async () => {
    setScanning(true);
    try {
      setDevices((await window.artlux?.discoverDevices?.()) ?? []);
    } finally {
      setScanning(false);
      setScanned(true);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const { positionerStyle, handleProps } = useDraggableModal('preferences');

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 animate-overlay-in" onClick={onClose}>
      <div style={positionerStyle}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Preferences"
        className="w-[460px] max-h-[80vh] overflow-auto bg-surface-1 border border-line-2 rounded-lg shadow-e3 animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div {...handleProps} className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2 cursor-move select-none">
          <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider">Preferences</span>
          <button onClick={onClose} aria-label="Close preferences" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
        </div>

        <Section title="Appearance" icon={<Monitor size={12} />}>
          <Slider label="UI scale" value={uiScaleValue} min={0.8} max={2} step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`} onChange={applyScale} />
          <div className="flex items-center justify-between">
            <span className="text-mini text-fg-3">Scales the whole editor. Also Ctrl +/− / 0.</span>
            <Button variant="tonal" size="sm" onClick={async () => {
              const d = await window.artlux?.detectUiScale?.();
              if (typeof d === 'number') applyScale(d);
            }}>Reset to detected</Button>
          </div>
        </Section>

        <Section title="DMX Output" icon={<Cpu size={12} />}>
          <Field label="Protocol">
            <Select value={settings.protocol} onChange={(e) => onChange({ protocol: e.target.value as AppSettings['protocol'] })}>
              <option value="artnet">Art-Net</option>
              <option value="sacn">sACN (E1.31)</option>
            </Select>
          </Field>
          <Toggle label="Output enabled" checked={settings.outputEnabled} onChange={(v) => onChange({ outputEnabled: v })} />
          <Field label="Target IP">
            <input
              type="text"
              value={settings.artNetIp}
              onChange={(e) => onChange({ artNetIp: e.target.value })}
              className="num flex-1 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none"
            />
          </Field>
          <NumberField label="Port" value={settings.artNetPort} step={1} onChange={(v) => onChange({ artNetPort: v })} />
          <Toggle label="Broadcast / multicast" checked={settings.broadcast} onChange={(v) => onChange({ broadcast: v })} />

          {/* Art-Net device discovery (ArtPoll) */}
          <div className="space-y-1.5 pt-1">
            <Button variant="tonal" size="sm" onClick={scan} disabled={scanning} className="w-full">
              <Radar size={13} className={scanning ? 'animate-spin' : ''} /> {scanning ? 'Scanning…' : 'Discover devices'}
            </Button>
            {devices.length > 0 && (
              <div className="border border-line-1 rounded-sm divide-y divide-line-1 max-h-32 overflow-auto">
                {devices.map((d) => {
                  const active = settings.artNetIp === d.ip;
                  return (
                    <button
                      key={d.ip}
                      onClick={() => onChange({ artNetIp: d.ip })}
                      title={d.longName || d.shortName}
                      className={`w-full flex items-center justify-between gap-2 px-2 py-1 text-left transition-colors hover:bg-surface-3 ${active ? 'bg-accent/10' : ''}`}
                    >
                      <span className="min-w-0">
                        <span className="block text-mini text-fg-1 truncate">{d.shortName || d.longName || 'Art-Net node'}</span>
                        <span className="block num text-micro text-fg-3">{d.ip}{d.mac ? ` · ${d.mac}` : ''}</span>
                      </span>
                      {active && <Check size={12} className="text-accent shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}
            {scanned && !scanning && devices.length === 0 && (
              <div className="text-micro text-fg-3 italic px-0.5">No Art-Net nodes replied.</div>
            )}
          </div>
        </Section>

        <Section title="Engine" icon={<Cpu size={12} />}>
          <NumberField label="FPS" value={settings.fps} step={1} min={1} max={1000} onChange={(v) => onChange({ fps: Math.max(1, Math.min(1000, Math.round(v))) })} />
          <Toggle label="Keep-alive" checked={settings.keepAlive} onChange={(v) => onChange({ keepAlive: v })} title="Re-send last frame at FPS so receivers never starve" />
          <Toggle label="Synchronous output (ArtSync)" checked={settings.artNetSync} onChange={(v) => onChange({ artNetSync: v })} title="Send ArtSync (0x5200) after each frame so nodes latch + output simultaneously (tear-free multi-universe)" />
          <Slider label="Gamma" value={settings.gamma} min={1} max={3} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => onChange({ gamma: v })} />
        </Section>

        <GpuSection open={open} />

        <Section title="OSC / Tracking" icon={<Radio size={12} />}>
          <Toggle label="OSC receive" checked={settings.oscEnabled} onChange={(v) => onChange({ oscEnabled: v })} title="Bind a UDP listener for external control + LiDAR blob tracking" />
          <NumberField label="Listen port" value={settings.oscListenPort} step={1} min={1} max={65535} onChange={(v) => onChange({ oscListenPort: Math.max(1, Math.min(65535, Math.round(v))) })} />
          <Field label="Bind address">
            <input
              type="text"
              value={settings.oscListenAddress}
              placeholder="All interfaces"
              onChange={(e) => onChange({ oscListenAddress: e.target.value.trim() })}
              title="Bind the OSC receiver to one local network card (this machine's IP, e.g. its 192.168.61.x address). Leave blank to listen on all interfaces."
              className="num flex-1 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none"
            />
          </Field>
          {/* Quick-pick the local NIC to bind (this machine's addresses). */}
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => onChange({ oscListenAddress: '' })}
              className={`px-1.5 py-0.5 rounded-sm border num text-micro transition-colors ${settings.oscListenAddress === '' ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:text-fg-1'}`}
            >All</button>
            {localAddrs.map((ip) => (
              <button
                key={ip}
                onClick={() => onChange({ oscListenAddress: ip })}
                className={`px-1.5 py-0.5 rounded-sm border num text-micro transition-colors ${settings.oscListenAddress === ip ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:text-fg-1'}`}
              >{ip}</button>
            ))}
          </div>
          <Field label="Control prefix">
            <input
              type="text"
              value={settings.oscControlPrefix}
              onChange={(e) => onChange({ oscControlPrefix: e.target.value })}
              title="Namespace for external control (e.g. /artlux/transport/play). LiDAR blob addresses (/SOL, /MUR, /SOL_MUR) are handled separately."
              className="num flex-1 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none"
            />
          </Field>
        </Section>

        <WatchdogSection open={open} />

        {/* Plugin-contributed settings sections (e.g. the mp4 plugin's "Video"). Each owns its fields;
            the host passes the shared settings + onChange. Keeps plugin settings out of core. */}
        {settingsSectionRegistry.all().map((s) => (
          <Section key={s.id} title={s.title} icon={s.icon ?? <Cpu size={12} />}>
            <s.Component settings={settings} onChange={onChange} />
          </Section>
        ))}

        <div className="p-3 flex justify-end">
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </div>
      </div>
    </div>
  );
};
