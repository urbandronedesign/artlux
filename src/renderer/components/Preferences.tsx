import React from 'react';
import { X, Cpu } from 'lucide-react';
import { AppSettings } from '../types';
import { Section, Field, NumberField, Toggle, Select, Slider, Button } from './ui';

interface Props {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

// Tabbed-modal-style Preferences (output + engine), replacing inline settings.
export const Preferences: React.FC<Props> = ({ open, onClose, settings, onChange }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[460px] max-h-[80vh] overflow-auto bg-surface-1 border border-line-2 rounded-[var(--r-lg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2">
          <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider">Preferences</span>
          <button onClick={onClose} className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
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
        </Section>

        <Section title="Engine" icon={<Cpu size={12} />}>
          <NumberField label="FPS" value={settings.fps} step={1} min={1} max={1000} onChange={(v) => onChange({ fps: Math.max(1, Math.min(1000, Math.round(v))) })} />
          <Toggle label="Keep-alive" checked={settings.keepAlive} onChange={(v) => onChange({ keepAlive: v })} title="Re-send last frame at FPS so receivers never starve" />
          <Slider label="Gamma" value={settings.gamma} min={1} max={3} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => onChange({ gamma: v })} />
        </Section>

        <div className="p-3 flex justify-end">
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
};
