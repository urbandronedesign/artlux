import React, { useEffect, useState } from 'react';
import type { PanelProps } from '@artlux/sdk/renderer';
import { getIpc } from './showControlHost';
import { toSvg } from './qr';
import type { LanAdapter, LanInfo } from './types';

// Show Control operator panel (modal, toggled from View ▸ Show Control). The app-side companion to the
// tablet: shows the connect URL + PIN, an operator LOCK that freezes/kicks remotes mid-show, and the
// list of paired devices with per-device kick. Reads/writes go over the plugin IPC bridge to main.

interface Device { token: string; name: string; pairedAt: number }

export const ShowControlPanel: React.FC<PanelProps> = () => {
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

  // One-scan onboarding: each QR encodes its URL with ?pin= so the tablet PWA auto-pairs after scanning.
  //
  // A CODE PER ADAPTER, not one. There used to be a single QR built from urls[0], and which adapter
  // came first was the OS's enumeration order — on the owner's machine a VPN, which no tablet in the
  // room could reach. The operator cannot know which network the tablet is on; the tablet's owner can,
  // so put every reachable network on screen, named, and let them scan theirs. Real adapters are
  // shown; VPN / VM adapters fold away below, still scannable for the rare rig that needs them.
  const adapters = lan?.adapters ?? [];
  const physical = adapters.filter((a) => a.kind === 'physical');
  const virtual = adapters.filter((a) => a.kind === 'virtual');
  const qrFor = (a: LanAdapter) => (lan?.pin ? toSvg(`${a.url}/?pin=${encodeURIComponent(lan.pin)}`, { size: 150 }) : null);
  const qrCard = (a: LanAdapter) => {
    const svg = qrFor(a);
    return (
      <div key={a.url} className="flex flex-col items-center gap-1">
        {svg && <div className="rounded bg-white p-1.5 leading-[0]" dangerouslySetInnerHTML={{ __html: svg }} />}
        <div className="text-fg-1 font-medium">{a.name}</div>
        <div className="num text-fg-3">{a.url}</div>
      </div>
    );
  };

  return (
    <div className="w-full h-full overflow-y-auto bg-panel text-fg" aria-label="Show Control">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
          <span className="font-semibold text-sm">Show Control</span>
          <span className={`w-2 h-2 rounded-full ${lan?.enabled ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          <span className="text-xs text-fg-2">{lan?.enabled ? 'server running' : 'server off'}</span>
        </div>

        <div className="p-4 space-y-3 text-xs text-fg-2">
          <div className="rounded border border-line p-2 space-y-2">
            {adapters.length > 0 && (
              <div className="space-y-1">
                <div className="text-fg-1 font-medium">Scan to connect</div>
                <div className="text-fg-3 leading-snug">
                  {physical.length > 1
                    ? 'This machine is on more than one network. Scan the code for the network the tablet is on — it opens the remote and pairs automatically.'
                    : 'Point the tablet camera here — it opens the remote and pairs automatically.'}
                </div>
              </div>
            )}
            {physical.length > 0 && <div className="flex flex-wrap gap-4">{physical.map(qrCard)}</div>}
            {virtual.length > 0 && (
              <details open={physical.length === 0}>
                <summary className="cursor-pointer text-fg-3">
                  {virtual.length === 1 ? '1 virtual adapter' : `${virtual.length} virtual adapters`} (VPN, virtual machine) — tablets are rarely on these
                </summary>
                <div className="flex flex-wrap gap-4 pt-2">{virtual.map(qrCard)}</div>
              </details>
            )}
            {adapters.length === 0 && <div className="text-fg-3">No LAN address (enable the remote in Preferences ▸ Show Control).</div>}
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
  );
};
