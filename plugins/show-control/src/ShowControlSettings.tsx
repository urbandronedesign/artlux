import React, { useEffect, useState } from 'react';
import { getIpc, DEFAULTS } from './showControlHost';
import type { ShowControlSettings as Cfg, LanInfo } from './types';

// Preferences → Show Control. Owns the plugin-private { enabled, port } (persisted under
// AppSettings.plugins['show-control']) and shows the LAN URL + PIN a tablet uses to connect. The
// server itself is (re)started by plugin.renderer when this config changes.

interface HostSettings { plugins?: Record<string, unknown> }

export const ShowControlSettings: React.FC<{ settings: unknown; onChange: (patch: Partial<HostSettings>) => void }> = ({ settings, onChange }) => {
  const s = settings as HostSettings;
  const cfg = { ...DEFAULTS, ...((s.plugins?.['show-control'] as Cfg) ?? {}) };
  const [lan, setLan] = useState<LanInfo | null>(null);

  const patch = (next: Partial<Cfg>) => {
    onChange({ plugins: { ...(s.plugins ?? {}), 'show-control': { ...cfg, ...next } } });
  };

  const refresh = () => { getIpc()?.invoke('showctl:lan-info').then((r) => setLan(r as LanInfo)).catch(() => {}); };
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, [cfg.enabled, cfg.port]);

  const regen = () => { getIpc()?.invoke('showctl:regen-pin').then((r) => setLan(r as LanInfo)).catch(() => {}); };

  return (
    <div className="space-y-2 text-xs text-fg-2">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        <span>Enable the tablet remote (HTTP server on the local network)</span>
      </label>
      <div className="flex items-center gap-2">
        <span>Port</span>
        <input type="number" className="num w-20 bg-bg-2 border border-line rounded px-1 py-0.5"
          value={cfg.port} min={1024} max={65535}
          onChange={(e) => patch({ port: parseInt(e.target.value, 10) || DEFAULTS.port })} />
        <span className="text-fg-3">default {DEFAULTS.port}</span>
      </div>
      {cfg.enabled && (
        <div className="rounded border border-line p-2 space-y-1 bg-bg-2/40">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${lan?.enabled ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            <span>{lan?.enabled ? 'Server running.' : 'Starting…'}</span>
          </div>
          <div>On the tablet's browser, open one of:</div>
          {(lan?.urls ?? []).length
            ? (lan!.urls.map((u) => <div key={u} className="num text-fg-1">{u}</div>))
            : <div className="text-fg-3">No LAN address found (check the network).</div>}
          <div className="flex items-center gap-2 pt-1">
            <span>PIN</span>
            <span className="num text-fg-1 text-base tracking-widest">{lan?.pin ?? '····'}</span>
            <button className="ml-auto text-fg-2 underline" onClick={regen}>Regenerate</button>
          </div>
          <p className="text-micro text-fg-3 leading-snug">
            The tablet pairs once with this PIN, then reconnects automatically. Regenerating the PIN
            only affects <b>new</b> pairings; use the Show Control panel to kick paired devices.
          </p>
        </div>
      )}
    </div>
  );
};
