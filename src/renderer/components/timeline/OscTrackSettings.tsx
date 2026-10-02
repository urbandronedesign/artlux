// The settings of ONE OSC track: what it sends (address pattern + type + range), where (1+ host:port),
// how often (rate limit + keep-alive) — plus the two things you need on the day a board does not answer:
// TEST buttons that send a value right now, and what main saw when it tried (per destination).
//
// EDITS ARE A LOCAL DRAFT, COMMITTED ONCE ON CLOSE. Every commit re-enters App → setData → a full
// automation recompile, and a live-applied host field would also SEND to every prefix of the address
// being typed ("192.168.1" is a valid hostname to the resolver). So nothing reaches the document until
// you click Done or outside — Escape and Cancel abandon.
//
// Portalled to document.body for the same reason AutomationTargetPicker is: inside the timeline scroller
// the wheel would zoom the timeline instead of scrolling this box, and the maximised timeline's z-50
// wrapper would sit over a local z-index.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, Send, X } from 'lucide-react';
import type { OscArgType, OscTrackConfig } from '../../types';
import { sanitizeOscTrackConfig } from '../../types';
import type { OscSendStatus } from '../../../../shared/protocol';
import { NumInput } from '../ui/NumberField';
import { Segmented } from '../ui/Segmented';
import { sendTest } from '../../services/oscOut';

interface Props {
  config: OscTrackConfig;
  anchor: { x: number; y: number };
  onCommit: (next: OscTrackConfig) => void;
  onClose: () => void;
}

const W = 340;
const M = 8;
const TEXT = 'bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-mini text-fg-1 focus:border-accent outline-none';

// What an OS-level send error MEANS for someone with an Arduino on a cable. The code alone ("EHOSTUNREACH")
// is the commonest first-day failure and tells a non-network person nothing.
function explain(code: string): string {
  switch (code) {
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'No network card on this machine is on that address range. Give the PC a fixed IP in the same range as the board (see the tutorial).';
    case 'EACCES':
      return 'The OS refused the send (a broadcast address, or a firewall rule on outgoing UDP).';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'That host name does not resolve. Use the board’s IP address.';
    case 'EADDRNOTAVAIL':
      return 'That address cannot be sent to from here (check for a typo).';
    default:
      return 'The OS refused the send.';
  }
}

const isIPv4 = (h: string) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h) && h.split('.').every((n) => +n <= 255);
const prefix3 = (h: string) => h.split('.').slice(0, 3).join('.');

export const OscTrackSettings: React.FC<Props> = ({ config, anchor, onCommit, onClose }) => {
  const [d, setD] = useState<OscTrackConfig>(() => structuredClone(config));
  const [status, setStatus] = useState<OscSendStatus[]>([]);
  const [nics, setNics] = useState<string[] | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y });

  useLayoutEffect(() => {
    const h = boxRef.current?.offsetHeight ?? 420;
    const left = Math.max(M, Math.min(anchor.x, window.innerWidth - W - M));
    const top = Math.max(M, Math.min(anchor.y, window.innerHeight - h - M));
    setPos({ left, top });
  }, [anchor.x, anchor.y, d.destinations.length]);

  // Main's per-destination counters, polled only while this box is open (1 Hz is plenty to watch a
  // count climb or an error appear when you plug a cable in).
  useEffect(() => {
    let alive = true;
    const poll = () => { window.artlux?.oscSendStatus?.().then((s) => { if (alive) setStatus(s ?? []); }).catch(() => {}); };
    poll();
    const id = setInterval(poll, 1000);
    window.artlux?.listLocalAddrs?.().then((a) => { if (alive) setNics(a ?? []); }).catch(() => {});
    return () => { alive = false; clearInterval(id); };
  }, []);

  const done = () => { const clean = sanitizeOscTrackConfig(d); if (clean) onCommit(clean); onClose(); };
  const set = (patch: Partial<OscTrackConfig>) => setD((c) => ({ ...c, ...patch }));
  const setDest = (i: number, patch: Partial<OscTrackConfig['destinations'][number]>) =>
    setD((c) => ({ ...c, destinations: c.destinations.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));

  // A heuristic, and labelled as one: /24 is what a hand-configured direct cable almost always is, and
  // listLocalAddrs carries no netmask. It catches the real failure (the PC's Ethernet port still on DHCP,
  // so it has a 169.254.x.x address or none) without pretending to be a routing table.
  const subnetWarning = (host: string): string | null => {
    if (!nics || !isIPv4(host) || host.startsWith('127.') || host.endsWith('.255')) return null;
    if (nics.some((n) => prefix3(n) === prefix3(host))) return null;
    return `No network card here is on ${prefix3(host)}.x (this machine: ${nics.length ? nics.join(', ') : 'no IPv4 address'}).`;
  };

  const lo = d.argType === 'bool' ? 0 : d.min;
  const hi = d.argType === 'bool' ? 1 : d.max;

  return createPortal(
    <>
      <div className="fixed inset-0 z-popover" onClick={done} />
      <div
        ref={boxRef}
        className="fixed z-popover flex flex-col gap-2 rounded-lg border border-line-2 bg-surface-1 shadow-e3 p-2 text-mini max-h-[80vh] overflow-y-auto overscroll-contain"
        style={{ left: pos.left, top: pos.top, width: W }}
        onWheel={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <div className="flex items-center gap-2">
          <span className="text-fg-1 font-medium flex-1">OSC track</span>
          <button onClick={onClose} title="Close without saving" className="text-fg-3 hover:text-fg-1"><X size={12} /></button>
        </div>

        <label className="flex items-center gap-2">
          <span className="w-16 text-fg-3">Name</span>
          <input value={d.name ?? ''} placeholder={d.address} onChange={(e) => set({ name: e.target.value })} className={`flex-1 ${TEXT}`} />
        </label>
        <label className="flex items-center gap-2" title="The OSC address the message is sent to. Your receiver dispatches on it — e.g. msg.dispatch(&quot;/led&quot;, …) in an Arduino sketch.">
          <span className="w-16 text-fg-3">Address</span>
          <input value={d.address} placeholder="/led" spellCheck={false} onChange={(e) => set({ address: e.target.value })} className={`flex-1 font-mono ${TEXT}`} />
        </label>
        <div className="flex items-center gap-2">
          <span className="w-16 text-fg-3">Type</span>
          <Segmented<OscArgType>
            value={d.argType}
            onChange={(argType) => set(argType === 'bool' ? { argType, min: 0, max: 1 } : { argType })}
            options={[
              { value: 'int', label: 'int', title: "Sends a whole number (type tag 'i'). The curve is rounded." },
              { value: 'float', label: 'float', title: "Sends a decimal number (type tag 'f')." },
              { value: 'bool', label: 'bool', title: "Sends True/False (type tags 'T'/'F'). The curve is ON at 0.5 and above." },
            ]}
          />
        </div>
        {d.argType !== 'bool' && (
          <div className="flex items-center gap-2" title="The lane's vertical range. Keys are clamped to it; it is also the range that is sent.">
            <span className="w-16 text-fg-3">Range</span>
            <NumInput value={d.min} onChange={(v) => set({ min: v })} step={d.argType === 'int' ? 1 : 0.1} commit="blur" />
            <span className="text-fg-3">to</span>
            <NumInput value={d.max} onChange={(v) => set({ max: v })} step={d.argType === 'int' ? 1 : 0.1} commit="blur" />
          </div>
        )}

        <div className="border-t border-line-1 pt-2 flex flex-col gap-1">
          <div className="flex items-center">
            <span className="text-fg-3 flex-1">Destinations — every one gets every message</span>
            <button onClick={() => set({ destinations: [...d.destinations, { host: d.destinations[d.destinations.length - 1]?.host ?? '192.168.1.177', port: d.destinations[d.destinations.length - 1]?.port ?? 8000 }] })}
              title="Add another board (or any OSC receiver)" className="text-fg-3 hover:text-fg-1 inline-flex items-center gap-1"><Plus size={11} /> Add</button>
          </div>
          {d.destinations.length === 0 && <div className="text-warn">No destination — this track sends nothing.</div>}
          {d.destinations.map((dest, i) => {
            const st = status.find((s) => s.host === dest.host.trim() && s.port === dest.port);
            const warn = subnetWarning(dest.host.trim());
            return (
              <div key={i} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1">
                  <input type="checkbox" checked={dest.enabled !== false} onChange={(e) => setDest(i, { enabled: e.target.checked ? undefined : false })}
                    title="Send to this destination" />
                  <input value={dest.host} spellCheck={false} placeholder="192.168.1.177" onChange={(e) => setDest(i, { host: e.target.value })}
                    className={`flex-1 min-w-0 font-mono ${TEXT}`} title="IP address of the board. x.x.x.255 reaches every board on that network at once (broadcast)." />
                  <span className="text-fg-3">:</span>
                  <NumInput value={dest.port} onChange={(v) => setDest(i, { port: Math.trunc(v) })} min={1} max={65535} step={1} commit="blur"
                    className={`w-16 text-right ${TEXT}`} title="UDP port the board listens on (Udp.begin(…) in the sketch)" />
                  <button onClick={() => set({ destinations: d.destinations.filter((_, j) => j !== i) })} title="Remove this destination"
                    className="text-fg-3 hover:text-danger"><Trash2 size={11} /></button>
                </div>
                {warn && <div className="text-micro text-warn pl-5">{warn}</div>}
                {st && (
                  <div className={`text-micro pl-5 ${st.lastError ? 'text-danger' : 'text-fg-3'}`}>
                    {st.lastError
                      ? <>{st.lastError}: {explain(st.lastError)}</>
                      : <>{st.sent} sent — left this machine. (UDP cannot confirm the board received it.)</>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t border-line-1 pt-2 flex flex-col gap-1">
          <div className="flex items-center gap-2" title="At most this many messages per second. The final value of a fast ramp is always delivered.">
            <span className="w-24 text-fg-3">Max rate (Hz)</span>
            <NumInput value={d.maxRate ?? 30} onChange={(v) => set({ maxRate: v })} min={1} max={240} step={1} commit="blur" />
          </div>
          <div className="flex items-center gap-2" title="Re-send the current value every N seconds even if it has not changed, so a board that rebooted catches up. 0 = off.">
            <span className="w-24 text-fg-3">Re-send every (s)</span>
            <NumInput value={d.resendSec ?? 0} onChange={(v) => set({ resendSec: v })} min={0} step={0.5} commit="blur" />
          </div>
        </div>

        <div className="border-t border-line-1 pt-2 flex items-center gap-1.5">
          <span className="text-fg-3 flex-1" title="Sends once, right now, to the destinations above — even with the track switched off.">Test</span>
          <button onClick={() => sendTest(d, lo)} className="px-2 py-0.5 rounded border border-line-1 text-fg-1 inline-flex items-center gap-1">
            <Send size={10} /> {d.argType === 'bool' ? 'False' : lo}
          </button>
          <button onClick={() => sendTest(d, hi)} className="px-2 py-0.5 rounded border border-line-1 text-fg-1 inline-flex items-center gap-1">
            <Send size={10} /> {d.argType === 'bool' ? 'True' : hi}
          </button>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-2 py-0.5 text-fg-3 hover:text-fg-1">Cancel</button>
          <button onClick={done} className="px-3 py-0.5 rounded bg-accent text-black">Done</button>
        </div>
      </div>
    </>,
    document.body,
  );
};
