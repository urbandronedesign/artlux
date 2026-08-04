import React, { useEffect, useState } from 'react';
import { Cpu, Radar, Check, Radio, Monitor, ShieldAlert } from 'lucide-react';
import { AppSettings } from '../types';
import type { ArtNetDevice, UnattendedPrefs, WatchdogStatus } from '../../../shared/protocol';
import { Section, Field, NumberField, Toggle, Select, Slider, Button, useConfirm } from './ui';
import { Tooltip } from './ui/Tooltip';
import { help } from '../services/helpBus';
import { settingsSectionRegistry } from '../host/registries';
import { ErrorBoundary } from './ErrorBoundary';
import { layoutStore } from '../services/layoutStore';
import {
  useRenderScale, setRenderScale, RENDER_SCALE_MIN, RENDER_SCALE_MAX,
  useMaxFps, setMaxFps, MAX_FPS_CHOICES,
} from '../services/scene3dQuality';
import { useLayout } from '../hooks/useLayout';

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

// One tile in the settings mosaic. `Section` is the shared collapsible used by every panel column in
// the app, and it is built to STACK — it draws only a bottom rule and expects a bordered parent. Tiled,
// each one has to become its own card, so the wrapper supplies the border/radius and suppresses that
// rule (`[&>div]` is Section's root). `break-inside-avoid` is what keeps a section whole: without it the
// column algorithm splits a card across two columns, chopping the Watchdog log or the device list in half.
// Label column for this screen's rows. The shared default (`w-16`) is sized for the 260px inspector
// column and truncates "Min relaunch gap (s)" to "Min relau…" — harmless when a tooltip is a hover away
// in a dense inspector, wrong on the screen whose whole job is being read. A tile is twice that wide.
const LBL = 'w-36';

const Tile: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="break-inside-avoid mb-3 rounded-md border border-line-1 bg-surface-1 overflow-hidden [&>div]:border-b-0">
    {children}
  </div>
);

const WATCHDOG_UI_DEFAULTS: UnattendedPrefs = {
  enabled: false, crashRecovery: true, outputDownSec: 15, renderStallSec: 10,
  minRelaunchGapSec: 30, maxRelaunchesPerHour: 6, always: false,
};

// Unattended self-healing config. Lives on Prefs.unattended (not AppSettings), so this section reads
// and writes it directly through getPrefs/setPrefs and shows live status from the main-side watchdog.
// Changes take effect on the next launch/relaunch (the watchdog arms + attaches its detectors at
// process start), so we make that explicit in the UI.
const WatchdogSection: React.FC = () => {
  const [cfg, setCfg] = useState<UnattendedPrefs>(WATCHDOG_UI_DEFAULTS);
  const [status, setStatus] = useState<WatchdogStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refreshStatus = () => { window.artlux?.getWatchdogStatus?.().then(setStatus).catch(() => {}); };
  useEffect(() => {
    window.artlux?.getPrefs?.().then((p) => {
      if (p?.unattended) setCfg({ ...WATCHDOG_UI_DEFAULTS, ...p.unattended });
    }).catch(() => {});
    refreshStatus();
  }, []);

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
      <NumberField label="Output-down (s)" labelWidth={LBL} value={cfg.outputDownSec} step={1} min={2} max={600}
                   onChange={(v) => update({ outputDownSec: Math.max(2, Math.round(v)) })} />
      <NumberField label="Render-stall (s)" labelWidth={LBL} value={cfg.renderStallSec} step={1} min={2} max={600}
                   onChange={(v) => update({ renderStallSec: Math.max(2, Math.round(v)) })} />
      <NumberField label="Min relaunch gap (s)" labelWidth={LBL} value={cfg.minRelaunchGapSec} step={1} min={0} max={600}
                   onChange={(v) => update({ minRelaunchGapSec: Math.max(0, Math.round(v)) })} />
      <NumberField label="Max relaunches / hour" labelWidth={LBL} value={cfg.maxRelaunchesPerHour} step={1} min={1} max={60}
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
const GpuSection: React.FC = () => {
  const [forced, setForced] = useState(false);
  const [active, setActive] = useState('');
  const [probe, setProbe] = useState('');
  const [probing, setProbing] = useState(false);
  const [scene3dGpu, setScene3dGpu] = useState(false);
  const renderScale = useRenderScale();
  const maxFps = useMaxFps();

  useEffect(() => {
    try { setForced(localStorage.getItem('artlux.forceWebGL') === '1'); } catch { /* ignore */ }
    try { setActive(localStorage.getItem('artlux.activeBackend') || ''); } catch { /* ignore */ }
    // Absence means ON — the key is named for the opt-out. See renderer3d.ts for why.
    try { setScene3dGpu(localStorage.getItem('artlux.scene3dWebGL') !== '1'); } catch { /* ignore */ }
  }, []);

  const toggleForce = (v: boolean) => {
    setForced(v);
    try { if (v) localStorage.setItem('artlux.forceWebGL', '1'); else localStorage.removeItem('artlux.forceWebGL'); } catch { /* ignore */ }
  };

  // Same door and the same storage as the flag itself (renderer3d.ts reads it SYNCHRONOUSLY at module
  // load, before prefs IPC could have answered, which is why this one knob is localStorage and not a
  // Prefs field like its two neighbours). Reload to apply: the renderer is constructed once, at mount.
  //
  // The stored key is the OPT-OUT (`scene3dWebGL`), so absence = WebGPU. Ticking the box therefore
  // REMOVES a key rather than writing one. Note this is per-origin, so a value set in a dev run does
  // not carry to a packaged install — which is exactly why the default had to flip rather than stay
  // an opt-in nobody outside a dev build could reach.
  const toggleScene3dGpu = (v: boolean) => {
    setScene3dGpu(v);
    try { if (v) localStorage.removeItem('artlux.scene3dWebGL'); else localStorage.setItem('artlux.scene3dWebGL', '1'); } catch { /* ignore */ }
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
      <Slider label="3D render scale" value={renderScale} min={RENDER_SCALE_MIN} max={RENDER_SCALE_MAX} step={0.05}
              format={(v) => `${v.toFixed(2)}×`} onChange={setRenderScale} />
      <div className="text-micro text-fg-3 px-0.5">
        Resolution the 3D Scene renders at, applied live. Cost scales with the SQUARE — 0.5× is a quarter
        of the pixels. Lower it first when the 3D view is slow. Per-machine, so it never travels with a project.
      </div>
      <Field label="3D frame rate" labelWidth={LBL}>
        <Select value={String(maxFps)} onChange={(e) => setMaxFps(Number(e.target.value))}>
          {MAX_FPS_CHOICES.map((f) => (
            <option key={f} value={f}>{f === 0 ? 'Display rate (uncapped)' : `${f} fps`}</option>
          ))}
        </Select>
      </Field>
      <div className="text-micro text-fg-3 px-0.5">
        Ceiling on how often the 3D Scene redraws, applied live. It does <strong>not</strong> touch the
        show: mapping, LED sampling and Art-Net keep running at the engine FPS, so capping the preview
        gives the output GPU time back rather than costing it any. Reach for this when the 3D view is
        slow and the render scale did not help — that means whole frames are expensive, not pixels.
      </div>
      <Toggle label="3D Scene on WebGPU" checked={scene3dGpu} onChange={toggleScene3dGpu}
              title="Render the 3D Scene viewport with WebGPU instead of WebGL. ON by default — turning it off is a diagnostic. Per-machine (localStorage), reload to apply, and it falls back to WebGL by itself if WebGPU is unavailable." />
      <div className="text-micro text-fg-3 px-0.5">
        <strong>On by default</strong>; applies on the next reload (Ctrl+R). Turn it off only to compare —
        on the WebGL path a scene holding just two venue screens measured here at <strong>32 fps with the
        GPU process 99.8% saturated</strong>, against 60 fps on WebGPU. If this machine has no usable
        WebGPU adapter the viewport falls back on its own, so the worst case is the old behaviour.
      </div>
    </Section>
  );
};

// Preferences — the `settings` context's viewport (it was a draggable modal until it grew past
// output+engine into appearance, watchdog, GPU and every plugin's own SettingsSection).
export const Preferences: React.FC<Props> = ({ settings, onChange }) => {
  const layout = useLayout();
  const confirm = useConfirm();
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [devices, setDevices] = useState<ArtNetDevice[]>([]);
  const [localAddrs, setLocalAddrs] = useState<string[]>([]);
  const [uiScaleValue, setUiScaleValue] = useState(1); // main-window zoom factor; applied in main
  const [showSplash, setShowSplash] = useState(true);  // Prefs.showSplash; absent = on (main's default)

  useEffect(() => {
    window.artlux?.listLocalAddrs?.().then((a) => setLocalAddrs(a ?? [])).catch(() => setLocalAddrs([]));
    // Show the scale in effect: the saved value, else the auto-detected default for this display.
    (async () => {
      const p = await window.artlux?.getPrefs?.();
      const s = typeof p?.uiScale === 'number' ? p.uiScale : await window.artlux?.detectUiScale?.();
      if (typeof s === 'number') setUiScaleValue(s);
      setShowSplash(p?.showSplash !== false); // main reads it the same way — only an explicit false is off
    })();
  }, []);

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


  return (
    // The `settings` context's viewport, laid out as a MOSAIC rather than one column. A settings screen
    // is read and compared — you tune Engine FPS against the Watchdog's render-stall threshold, or the
    // DMX target against the OSC bind address — and a 620px column made that scrolling instead of
    // looking. Tiles let the whole surface be visible at once.
    //
    // The count is driven by `column-width`, not by viewport breakpoints: the shell can give this
    // viewport any width (a browser/parameter column may be reopened over it, and the window itself is
    // UI-scaled 80–200%), so the layout has to respond to the space it actually got. The `4` caps it —
    // on a 4K panel an unbounded fill would produce a dozen columns and a header-only mosaic.
    // Column flow is column-major and heights balance, which is what packs ragged sections tightly.
    //
    // No title bar: the ActionBar above already carries the context icon + "Preferences".
    <div className="w-full h-full overflow-y-auto bg-surface-0 p-3" aria-label="Preferences">
      <div style={{ columns: '19rem 5', columnGap: '0.75rem' }}>
        <Tile><Section title="Appearance" icon={<Monitor size={12} />}>
          <Slider label="UI scale" value={uiScaleValue} min={0.8} max={2} step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`} onChange={applyScale} />
          <div className="flex items-center justify-between">
            <span className="text-mini text-fg-3">Scales the whole editor. Also Ctrl +/− / 0.</span>
            <Button variant="tonal" size="sm" onClick={async () => {
              const d = await window.artlux?.detectUiScale?.();
              if (typeof d === 'number') applyScale(d);
            }}>Reset to detected</Button>
          </div>
          {/* Editor-only by construction: broadcast/headless never open the splash whatever this says
              (main/splashWindow.ts), so an unattended venue PC is unaffected either way. */}
          <Toggle label="Startup splash" checked={showSplash} onChange={(v) => {
            setShowSplash(v);
            window.artlux?.setPrefs?.({ showSplash: v });
          }} title="Show the credits + plugin/native load report at launch" />
          {/* The way back to the fixed shell, without editing prefs by hand. Deliberately a PREFERENCE
              rather than a view option: the two paths are different renderers, so switching remounts the
              panels. Output is unaffected either way — the frame loop has not lived in the UI since
              Phase 1, which is the whole reason this feature could be built at all. */}
          <Toggle label="Dockable workspace" checked={!layout.dockingOff}
            onChange={(v) => layoutStore.set({ dockingOff: !v })}
            title="Drag panels into tabs and splits, per workbench. Off restores the fixed browser / viewport / dock / parameters layout." />
        </Section></Tile>

        <Tile><Section title="DMX Output" icon={<Cpu size={12} />}>
          <Field label="Protocol" labelWidth={LBL}>
            <Select value={settings.protocol} onChange={(e) => onChange({ protocol: e.target.value as AppSettings['protocol'] })}>
              <option value="artnet">Art-Net</option>
              <option value="sacn">sACN (E1.31)</option>
            </Select>
          </Field>
          {/* Guarded: turning this off stops ALL Art-Net/sACN output — a live stage goes dark. Confirm
              before killing it; turning it back on is unguarded. */}
          <Toggle label="Output enabled" checked={settings.outputEnabled} onChange={async (v) => {
            if (!v && !(await confirm({
              title: 'Disable all DMX output?',
              message: 'This stops every Art-Net / sACN frame — any live fixtures and projectors driven by DMX go dark.',
              confirmLabel: 'Disable output', danger: true,
            }))) return;
            onChange({ outputEnabled: v });
          }} />
          <Field label="Target IP" labelWidth={LBL}>
            <Tooltip id="general.dmx-target-ip">
              <input
                type="text"
                value={settings.artNetIp}
                onChange={(e) => onChange({ artNetIp: e.target.value })}
                title="The default address DMX frames are sent to (unicast, or broadcast/multicast per the toggle)."
                className="num flex-1 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none"
                {...help('general.dmx-target-ip')}
              />
            </Tooltip>
          </Field>
          <NumberField label="Port" labelWidth={LBL} value={settings.artNetPort} step={1} onChange={(v) => onChange({ artNetPort: v })} />
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
        </Section></Tile>

        <Tile><Section title="Engine" icon={<Cpu size={12} />}>
          <NumberField label="FPS" labelWidth={LBL} value={settings.fps} step={1} min={1} max={1000} onChange={(v) => onChange({ fps: Math.max(1, Math.min(1000, Math.round(v))) })} />
          <Toggle label="Keep-alive" checked={settings.keepAlive} onChange={(v) => onChange({ keepAlive: v })} title="Re-send last frame at FPS so receivers never starve" />
          <Toggle label="Synchronous output (ArtSync)" checked={settings.artNetSync} onChange={(v) => onChange({ artNetSync: v })} title="Send ArtSync (0x5200) after each frame so nodes latch + output simultaneously (tear-free multi-universe)" />
          <Slider label="Gamma" value={settings.gamma} min={1} max={3} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => onChange({ gamma: v })} />
          {/* Cold start: how long to wait for the opening content to decode before the show machine is
              armed anyway. The gate ALWAYS fails open — this is the venue's patience for a slow disk or
              a missing asset, not a choice about whether to wait forever. See services/bootGate.ts. */}
          <NumberField label="Preload wait (s)" labelWidth={LBL} value={settings.bootPreloadSec ?? 15} step={1} min={1} max={120}
            onChange={(v) => onChange({ bootPreloadSec: Math.max(1, Math.min(120, Math.round(v))) })} />
        </Section></Tile>

        <Tile><GpuSection /></Tile>

        <Tile><Section title="OSC / Tracking" icon={<Radio size={12} />}>
          <Toggle label="OSC receive" checked={settings.oscEnabled} onChange={(v) => onChange({ oscEnabled: v })} title="Bind a UDP listener for external control + LiDAR blob tracking" />
          <NumberField label="Listen port" labelWidth={LBL} value={settings.oscListenPort} step={1} min={1} max={65535} onChange={(v) => onChange({ oscListenPort: Math.max(1, Math.min(65535, Math.round(v))) })} />
          <Field label="Bind address" labelWidth={LBL}>
            <Tooltip id="general.osc-bind-address">
              <input
                type="text"
                value={settings.oscListenAddress}
                placeholder="All interfaces"
                onChange={(e) => onChange({ oscListenAddress: e.target.value.trim() })}
                title="Bind the OSC receiver to one local network card (this machine's IP, e.g. its 192.168.61.x address). Leave blank to listen on all interfaces."
                className="num flex-1 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none"
                {...help('general.osc-bind-address')}
              />
            </Tooltip>
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
          <Field label="Control prefix" labelWidth={LBL}>
            <Tooltip id="general.osc-control-prefix">
              <input
                type="text"
                value={settings.oscControlPrefix}
                onChange={(e) => onChange({ oscControlPrefix: e.target.value })}
                title="Namespace for external control (e.g. /artlux/transport/play). LiDAR blob addresses (/SOL, /MUR, /SOL_MUR) are handled separately."
                className="num flex-1 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none"
                {...help('general.osc-control-prefix')}
              />
            </Tooltip>
          </Field>
        </Section></Tile>

        <Tile><WatchdogSection /></Tile>

        {/* Plugin-contributed settings sections (e.g. the mp4 plugin's "Video"). Each owns its fields;
            the host passes the shared settings + onChange. Keeps plugin settings out of core. They tile
            with the core ones — a plugin's section is not a second-class citizen here. */}
        {/* Contained INSIDE the section, so a throwing plugin settings panel leaves the rest of
            Preferences usable — including the Unattended/Watchdog section, which is where an
            operator goes when things are already going wrong. */}
        {settingsSectionRegistry.all().map((s) => (
          <Tile key={s.id}>
            <Section title={s.title} icon={s.icon ?? <Cpu size={12} />}>
              <ErrorBoundary variant="panel" scope={`plugin:${s.id}`} pluginId={s.id} label={s.title}>
                <s.Component settings={settings} onChange={onChange} />
              </ErrorBoundary>
            </Section>
          </Tile>
        ))}
      </div>
    </div>
  );
};
