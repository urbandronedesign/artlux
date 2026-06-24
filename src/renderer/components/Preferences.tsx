import React, { useEffect, useState } from 'react';
import { X, Cpu, Radar, Check, Radio } from 'lucide-react';
import { AppSettings } from '../types';
import type { ArtNetDevice } from '../../../shared/protocol';
import { Section, Field, NumberField, Toggle, Select, Slider, Button } from './ui';

interface Props {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

// Tabbed-modal-style Preferences (output + engine), replacing inline settings.
export const Preferences: React.FC<Props> = ({ open, onClose, settings, onChange }) => {
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [devices, setDevices] = useState<ArtNetDevice[]>([]);
  const [localAddrs, setLocalAddrs] = useState<string[]>([]);

  useEffect(() => {
    if (open) window.artlux?.listLocalAddrs?.().then((a) => setLocalAddrs(a ?? [])).catch(() => setLocalAddrs([]));
  }, [open]);

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

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 animate-overlay-in" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Preferences"
        className="w-[460px] max-h-[80vh] overflow-auto bg-surface-1 border border-line-2 rounded-[var(--r-lg)] shadow-2xl animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2">
          <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider">Preferences</span>
          <button onClick={onClose} aria-label="Close preferences" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
        </div>

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
              className="num flex-1 bg-surface-0 border border-line-1 rounded-[var(--r-sm)] px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none"
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
              <div className="border border-line-1 rounded-[var(--r-sm)] divide-y divide-line-1 max-h-32 overflow-auto">
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
                        <span className="block text-[11px] text-fg-1 truncate">{d.shortName || d.longName || 'Art-Net node'}</span>
                        <span className="block num text-[10px] text-fg-3">{d.ip}{d.mac ? ` · ${d.mac}` : ''}</span>
                      </span>
                      {active && <Check size={12} className="text-accent shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}
            {scanned && !scanning && devices.length === 0 && (
              <div className="text-[10px] text-fg-3 italic px-0.5">No Art-Net nodes replied.</div>
            )}
          </div>
        </Section>

        <Section title="Engine" icon={<Cpu size={12} />}>
          <NumberField label="FPS" value={settings.fps} step={1} min={1} max={1000} onChange={(v) => onChange({ fps: Math.max(1, Math.min(1000, Math.round(v))) })} />
          <Toggle label="Keep-alive" checked={settings.keepAlive} onChange={(v) => onChange({ keepAlive: v })} title="Re-send last frame at FPS so receivers never starve" />
          <Toggle label="Synchronous output (ArtSync)" checked={settings.artNetSync} onChange={(v) => onChange({ artNetSync: v })} title="Send ArtSync (0x5200) after each frame so nodes latch + output simultaneously (tear-free multi-universe)" />
          <Slider label="Gamma" value={settings.gamma} min={1} max={3} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => onChange({ gamma: v })} />
        </Section>

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
              className="num flex-1 bg-surface-0 border border-line-1 rounded-[var(--r-sm)] px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none"
            />
          </Field>
          {/* Quick-pick the local NIC to bind (this machine's addresses). */}
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => onChange({ oscListenAddress: '' })}
              className={`px-1.5 py-0.5 rounded-[var(--r-sm)] border num text-[10px] transition-colors ${settings.oscListenAddress === '' ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:text-fg-1'}`}
            >All</button>
            {localAddrs.map((ip) => (
              <button
                key={ip}
                onClick={() => onChange({ oscListenAddress: ip })}
                className={`px-1.5 py-0.5 rounded-[var(--r-sm)] border num text-[10px] transition-colors ${settings.oscListenAddress === ip ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:text-fg-1'}`}
              >{ip}</button>
            ))}
          </div>
          <Field label="Control prefix">
            <input
              type="text"
              value={settings.oscControlPrefix}
              onChange={(e) => onChange({ oscControlPrefix: e.target.value })}
              title="Namespace for external control (e.g. /artlux/transport/play). LiDAR blob addresses (/SOL, /MUR, /SOL_MUR) are handled separately."
              className="num flex-1 bg-surface-0 border border-line-1 rounded-[var(--r-sm)] px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none"
            />
          </Field>
        </Section>

        <div className="p-3 flex justify-end">
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
};
