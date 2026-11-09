import React, { useSyncExternalStore } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { AppSettings, OscSender } from '../types';
import * as oscInbox from '../services/smOscInbox';

// Preferences ▸ OSC / Tracking ▸ STATE TRIGGER SENDERS — the devices allowed to drive the state
// machine over OSC (a TouchOSC tablet, an Arduino, a LiDAR box, a show PC), several at once.
//
// MACHINE-SCOPED on purpose: these are IPs on THIS venue's network. A project's OSC bindings name an
// entry here, so the same project on the build PC and the venue PC relinks to each machine's own
// "Tablet". A blank port accepts any source port from that IP — most OSC apps send from a random port,
// which is why "Seen recently" exists: it shows the IP:port traffic actually arrives from, so the
// operator copies the truth instead of guessing.

const inputCls = 'num min-w-0 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none';

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

export const OscSendersBlock: React.FC<Props> = ({ settings, onChange }) => {
  useSyncExternalStore(oscInbox.subscribe, oscInbox.getVersion); // re-render on new traffic (throttled)
  const senders = settings.oscSenders ?? [];
  const seen = oscInbox.getSeenSources().slice(0, 8);
  const set = (list: OscSender[]) => onChange({ oscSenders: list });
  const patchAt = (i: number, p: Partial<OscSender>) => set(senders.map((s, j) => (j === i ? { ...s, ...p } : s)));
  // Names are what projects store, so a new one must not collide with an existing one.
  const freshName = (base: string) => {
    let n = base, k = 2;
    while (senders.some(s => s.name === n)) n = `${base} ${k++}`;
    return n;
  };
  const dupNames = new Set(senders.map(s => s.name).filter((n, i, a) => a.indexOf(n) !== i));

  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-center justify-between">
        <span className="text-fg-2 text-micro font-medium">State trigger senders</span>
        <button onClick={() => set([...senders, { name: freshName('Sender'), host: '' }])}
          className="inline-flex items-center gap-0.5 text-accent text-micro hover:underline"><Plus size={11} /> add</button>
      </div>
      {senders.length === 0 && (
        <div className="text-fg-3 italic text-micro">
          None. State-machine OSC bindings can still use “Any sender”. Add a device here to accept triggers only from it.
        </div>
      )}
      {senders.map((s, i) => (
        <div key={i} className="flex items-center gap-1">
          <input value={s.name} placeholder="Name" title="The name projects refer to this device by"
            onChange={(e) => patchAt(i, { name: e.target.value })}
            className={`${inputCls} w-24 ${dupNames.has(s.name) ? 'border-warn' : ''}`} />
          <input value={s.host} placeholder="192.168.0.20" title="The device's IP address"
            onChange={(e) => patchAt(i, { host: e.target.value.trim() })}
            className={`${inputCls} flex-1`} />
          <input value={s.port ? String(s.port) : ''} placeholder="any" title="The device's SOURCE port. Leave blank to accept any port from this IP."
            inputMode="numeric"
            onChange={(e) => { const n = parseInt(e.target.value, 10); patchAt(i, { port: Number.isFinite(n) && n > 0 && n < 65536 ? n : undefined }); }}
            className={`${inputCls} w-14 text-right`} />
          <button onClick={() => set(senders.filter((_, j) => j !== i))} title="Remove" className="text-fg-3 hover:text-danger"><Trash2 size={11} /></button>
        </div>
      ))}
      {dupNames.size > 0 && <div className="text-warn italic text-micro">⚠ Two senders share a name — bindings will match the first.</div>}
      {seen.length > 0 && (
        <div className="space-y-1">
          <span className="text-fg-3 text-micro">Seen recently — click to add as a sender</span>
          <div className="flex flex-wrap gap-1">
            {seen.map(src => (
              <button key={`${src.host}:${src.port}`}
                title={`Last address: ${src.lastAddress}`}
                onClick={() => set([...senders, { name: freshName('Device'), host: src.host, port: src.port }])}
                className="px-1.5 py-0.5 rounded-sm border num text-micro bg-surface-2 border-line-1 text-fg-2 hover:text-fg-1">
                {src.host}:{src.port}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
