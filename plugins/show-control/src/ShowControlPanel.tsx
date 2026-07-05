import React, { useEffect, useState } from 'react';
import type { PanelProps } from '@artlux/sdk/renderer';
import { getIpc } from './showControlHost';
import { toSvg } from './qr';
import type { LanInfo } from './types';

// Show Control operator panel (modal, toggled from View ▸ Show Control). The app-side companion to the
// tablet: shows the connect URL + PIN, an operator LOCK that freezes/kicks remotes mid-show, and the
// list of paired devices with per-device kick. Reads/writes go over the plugin IPC bridge to main.

interface Device { token: string; name: string; pairedAt: number }

export const ShowControlPanel: React.FC<PanelProps> = ({ onClose }) => {
  const [lan, setLan] = useState<LanInfo | null>(null);
  const [locked, setLocked] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);

  const refresh = () => {
    const ipc = getIpc(); if (!ipc) return;
    ipc.invoke('showctl:lan-info').then((r) => setLan(r as LanInfo)).catch(() => {});
    ipc.invoke('showctl:devices').then((r) => setDevices((r as Device[]) ?? [])).catch(() => {});
    ipc.invoke('showctl:is-locked').then((r) => setLocked(!!r)).catch(() => {});
  };
  useEffect(() => { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, []);

  const toggleLock = () => { const v = !locked; setLocked(v); getIpc()?.send('showctl:set-lock', v); };
  const kick = (token?: string) => { getIpc()?.send('showctl:revoke', token); setTimeout(refresh, 150); };
  const regen = () => { getIpc()?.invoke('showctl:regen-pin').then((r) => setLan(r as LanInfo)).catch(() => {}); };

  // One-scan onboarding: encode the URL with ?pin= so the tablet PWA auto-pairs after scanning.
  const pairUrl = lan && lan.urls.length && lan.pin ? `${lan.urls[0]}/?pin=${encodeURIComponent(lan.pin)}` : null;
  const qrSvg = pairUrl ? toSvg(pairUrl, { size: 176 }) : null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[420px] max-w-[92vw] rounded-xl border border-line bg-panel text-fg shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
          <span className="font-semibold text-sm">Show Control</span>
          <span className={`w-2 h-2 rounded-full ${lan?.enabled ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          <span className="text-xs text-fg-2">{lan?.enabled ? 'server running' : 'server off'}</span>
          <button className="ml-auto text-fg-2 hover:text-fg text-lg leading-none" onClick={onClose}>×</button>
        </div>

        <div className="p-4 space-y-3 text-xs text-fg-2">
          <div className="rounded border border-line p-2 space-y-2">
            {qrSvg && (
              <div className="flex items-center gap-3">
                <div className="rounded bg-white p-1.5 leading-[0]" dangerouslySetInnerHTML={{ __html: qrSvg }} />
                <div className="space-y-1">
                  <div className="text-fg-1 font-medium">Scan to connect</div>
                  <div className="text-fg-3 leading-snug">Point the tablet camera here — it opens the remote and pairs automatically.</div>
                </div>
              </div>
            )}
            <div className="text-fg-3">Or open on the tablet browser:</div>
            {(lan?.urls ?? []).length
              ? lan!.urls.map((u) => <div key={u} className="num text-fg-1 text-sm">{u}</div>)
              : <div className="text-fg-3">No LAN address (enable the remote in Preferences ▸ Show Control).</div>}
            <div className="flex items-center gap-2 pt-1">
              <span>PIN</span>
              <span className="num text-fg-1 text-lg tracking-[0.3em]">{lan?.pin ?? '····'}</span>
              <button className="ml-auto underline" onClick={regen}>Regenerate</button>
            </div>
          </div>

          <button
            className={`w-full rounded py-2 font-semibold text-sm ${locked ? 'bg-amber-500 text-black' : 'bg-bg-2 border border-line text-fg'}`}
            onClick={toggleLock}>
            {locked ? '🔒 Remotes LOCKED — tap to unlock' : 'Lock remotes (freeze all tablets)'}
          </button>

          <div>
            <div className="flex items-center mb-1">
              <span className="text-fg-3 uppercase tracking-wide">Paired devices ({devices.length})</span>
              {devices.length > 0 && <button className="ml-auto text-bad underline" onClick={() => kick()}>Kick all</button>}
            </div>
            {devices.length === 0 && <div className="text-fg-3">No devices paired yet.</div>}
            {devices.map((d) => (
              <div key={d.token} className="flex items-center gap-2 py-1 border-b border-line/50">
                <span className="text-fg-1">{d.name}</span>
                <span className="text-fg-3 num">{new Date(d.pairedAt).toLocaleDateString()}</span>
                <button className="ml-auto text-bad underline" onClick={() => kick(d.token)}>Kick</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
