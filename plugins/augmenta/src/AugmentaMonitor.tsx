import React, { useEffect, useRef, useState } from 'react';
import { X, Pause, Play, Trash2, Radio, Search } from 'lucide-react';
import type { OscMessage } from '../../../shared/protocol';
import type { PanelProps } from '@artlux/sdk/renderer';
import { useDraggable } from '@artlux/sdk/renderer';
import { Button } from '@/components/ui'; // host UI primitive (pure presentational — no singleton)
import { useHostSettings } from './augmentaHost';

// Augmenta Monitor — a diagnostic view of the raw incoming OSC stream, for validating the Augmenta box
// on real hardware (is the box actually sending /au/… messages to this machine, and what exact address
// grammar + argument order does this firmware use?). This is the tool the plan calls out for finalizing
// the augmentaStore parser against a captured stream.
//
// It taps window.artlux.onOscMessage DIRECTLY, in parallel with services/oscController's router and the
// augmentaStore ingest (each preload onOscMessage() registers its own ipcRenderer listener, so multiple
// subscribers coexist). It therefore sees EVERY received message on the wire — including live objects
// even while a recorded take is replaying (the store's replay gate doesn't apply here).
//
// Perf: at high fps × many objects this is a firehose. We never setState per message — messages
// accumulate into a mutable ref synchronously, and a ~4 Hz interval flushes a derived snapshot into
// React state. (High-rate signals must stay render-free.)

const SCENE_RE = /^\/au\/scene\b/i;
const OBJ_RE = /^\/au\/(?:person|object)/i;

interface AddrStat { count: number; prev: number; last: (number | string)[]; lastAt: number; }

interface Accum {
  total: number;
  prevTotal: number;
  lastFlush: number;
  addresses: Map<string, AddrStat>;
  ids: Set<number>;       // distinct object ids seen recently (cleared each flush)
  sceneW: number;
  sceneH: number;
  objectCount: number;
  auTotal: number;        // count of recognised /au/ messages (vs unrelated OSC on the port)
  log: string[];          // ring buffer of recent raw lines (only filled while logging)
}

function freshAccum(): Accum {
  return { total: 0, prevTotal: 0, lastFlush: performance.now(), addresses: new Map(), ids: new Set(), sceneW: 0, sceneH: 0, objectCount: 0, auTotal: 0, log: [] };
}

const LOG_CAP = 600;       // ring-buffer size for the raw log
const FLUSH_MS = 250;      // UI refresh cadence (~4 Hz)

interface Row { address: string; hz: number; count: number; last: string; }

function fmtArgs(args: (number | string)[]): string {
  return args
    .map((a) => (typeof a === 'number' ? (Number.isInteger(a) ? String(a) : a.toFixed(4)) : JSON.stringify(a)))
    .join(', ');
}

const num = (a: number | string | undefined): number => (typeof a === 'number' ? a : 0);

// Registered as a 'modal' PanelContribution — the host mounts it only while open and passes `onClose`.
export const AugmentaMonitor: React.FC<PanelProps> = ({ onClose }) => {
  const settings = useHostSettings();
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const close = () => onCloseRef.current?.();
  const accum = useRef<Accum>(freshAccum());
  const pausedRef = useRef(false);
  const loggingRef = useRef(false);
  const filterRef = useRef('');

  const [paused, setPaused] = useState(false);
  const [logging, setLogging] = useState(false);
  const [filter, setFilter] = useState('');
  const [totalHz, setTotalHz] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [objCount, setObjCount] = useState(0);
  const [sceneDims, setSceneDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [seenAu, setSeenAu] = useState(false);
  const [seenAny, setSeenAny] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);

  pausedRef.current = paused;
  loggingRef.current = logging;
  filterRef.current = filter;

  // Subscribe to the raw OSC stream for the panel's lifetime (mounted only while open). Reset on mount.
  useEffect(() => {
    accum.current = freshAccum();
    setSeenAu(false); setSeenAny(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current?.(); };
    window.addEventListener('keydown', onKey);

    const ingest = (msgs: OscMessage[]) => {
      if (pausedRef.current) return;
      const a = accum.current;
      const now = performance.now();
      const f = filterRef.current;
      for (const m of msgs) {
        a.total++;
        let st = a.addresses.get(m.address);
        if (!st) { st = { count: 0, prev: 0, last: [], lastAt: 0 }; a.addresses.set(m.address, st); }
        st.count++; st.last = m.args; st.lastAt = now;

        // Parse the Augmenta grammar ourselves so the summary reflects the wire, not the store.
        if (SCENE_RE.test(m.address)) {
          a.auTotal++;
          a.objectCount = num(m.args[1]);
          if (num(m.args[2])) a.sceneW = num(m.args[2]);
          if (num(m.args[3])) a.sceneH = num(m.args[3]);
        } else if (OBJ_RE.test(m.address)) {
          a.auTotal++;
          a.ids.add(num(m.args[0]));
        }

        if (loggingRef.current && (!f || m.address.includes(f))) {
          a.log.push(`${m.address}  ${fmtArgs(m.args)}`);
          if (a.log.length > LOG_CAP) a.log.splice(0, a.log.length - LOG_CAP);
        }
      }
    };

    const unsub = window.artlux?.onOscMessage?.(ingest) ?? null;
    return () => { window.removeEventListener('keydown', onKey); unsub?.(); };
  }, []);

  // Flush accumulated stats into React state on a fixed cadence.
  useEffect(() => {
    const id = window.setInterval(() => {
      const a = accum.current;
      const now = performance.now();
      const dt = Math.max(1e-3, (now - a.lastFlush) / 1000);

      setTotalHz((a.total - a.prevTotal) / dt);
      a.prevTotal = a.total; a.lastFlush = now;
      if (a.total > 0) setSeenAny(true);
      if (a.auTotal > 0) setSeenAu(true);

      const f = filterRef.current;
      const out: Row[] = [];
      for (const [address, st] of a.addresses) {
        if (f && !address.includes(f)) continue;
        const hz = (st.count - st.prev) / dt;
        st.prev = st.count;
        out.push({ address, hz, count: st.count, last: fmtArgs(st.last) });
      }
      out.sort((x, y) => x.address.localeCompare(y.address));
      setRows(out);

      setObjCount(a.ids.size);
      a.ids.clear(); // distinct ids per flush window
      setSceneDims({ w: a.sceneW, h: a.sceneH });

      if (loggingRef.current) setLogLines(a.log.slice(-200));
    }, FLUSH_MS);
    return () => window.clearInterval(id);
  }, []);

  const clear = () => {
    accum.current = freshAccum();
    setRows([]); setObjCount(0); setSceneDims({ w: 0, h: 0 }); setTotalHz(0); setSeenAu(false); setSeenAny(false); setLogLines([]);
  };

  const where = settings.oscListenAddress ? `${settings.oscListenAddress}:${settings.oscListenPort}` : `*:${settings.oscListenPort}`;

  // Draggable + remembered position via the SDK hook. This is a plugin, so it can't reach host prefs —
  // it persists to localStorage (renderer-global, survives restart) instead.
  const { positionerStyle, handleProps } = useDraggable({
    load: () => { try { const s = localStorage.getItem('artlux.modalPos.augmenta'); return s ? JSON.parse(s) as { x: number; y: number } : null; } catch { return null; } },
    onCommit: (pos) => { try { localStorage.setItem('artlux.modalPos.augmenta', JSON.stringify(pos)); } catch { /* storage full/blocked — non-fatal */ } },
  });

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 animate-overlay-in" onClick={close}>
      <div style={positionerStyle}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Augmenta Monitor"
        className="w-[760px] max-h-[86vh] flex flex-col bg-surface-1 border border-line-2 rounded-lg shadow-e3 animate-modal-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — drag handle */}
        <div {...handleProps} className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2 shrink-0 cursor-move select-none">
          <div className="flex items-center gap-2 text-fg-1 text-sm font-semibold">
            <Radio size={15} className="text-accent" /> Augmenta Monitor
          </div>
          <button onClick={close} aria-label="Close Augmenta monitor" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
        </div>

        {/* Status strip */}
        <div className="px-3 py-2 flex items-center gap-4 border-b border-line-1 text-mini shrink-0">
          <span className="inline-flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${settings.oscEnabled ? (seenAu ? 'bg-emerald-400' : 'bg-amber-400') : 'bg-fg-3'}`} />
            <span className="text-fg-2">{settings.oscEnabled ? `listening ${where}` : 'OSC receive disabled'}</span>
          </span>
          <span className="num text-fg-2">{totalHz.toFixed(0)} <span className="text-fg-3">msg/s</span></span>
          <span className="num text-fg-2">{rows.length} <span className="text-fg-3">addresses</span></span>
          <span className="num text-fg-2">{objCount} <span className="text-fg-3">objects</span></span>
          {(sceneDims.w > 0 || sceneDims.h > 0) && (
            <span className="num text-fg-3">{sceneDims.w.toFixed(2)}×{sceneDims.h.toFixed(2)} m</span>
          )}
        </div>

        {!settings.oscEnabled && (
          <div className="px-3 py-1.5 text-mini text-amber-300 bg-amber-500/10 border-b border-line-1 shrink-0">
            OSC receive is off — enable it in Preferences ▸ OSC / Tracking (port {settings.oscListenPort ?? '—'}), then point the Augmenta box's OSC output at that port.
          </div>
        )}
        {settings.oscEnabled && seenAny && !seenAu && (
          <div className="px-3 py-1.5 text-mini text-amber-300 bg-amber-500/10 border-b border-line-1 shrink-0">
            OSC is arriving, but no <span className="num">/au/…</span> messages yet — check the box is targeting this machine and this port, and is enabled for OSC v2 output.
          </div>
        )}

        {/* Controls */}
        <div className="px-3 py-2 flex items-center gap-2 border-b border-line-1 shrink-0">
          <Button variant="tonal" size="sm" onClick={() => setPaused((p) => !p)}>
            {paused ? <><Play size={13} /> Resume</> : <><Pause size={13} /> Pause</>}
          </Button>
          <Button variant="tonal" size="sm" onClick={clear}><Trash2 size={13} /> Clear</Button>
          <label className="flex items-center gap-1.5 text-mini text-fg-2 cursor-pointer select-none">
            <input type="checkbox" checked={logging} onChange={(e) => setLogging(e.target.checked)} /> Raw log
          </label>
          <div className="ml-auto relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-3" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter address…"
              className="num text-mini pl-6 pr-2 py-1 w-48 bg-surface-2 border border-line-1 rounded-sm text-fg-1 placeholder:text-fg-3 focus:border-accent outline-none"
            />
          </div>
        </div>

        {/* Address table */}
        <div className="flex-1 min-h-[120px] overflow-auto">
          <table className="w-full text-mini num">
            <thead className="sticky top-0 bg-surface-2 text-fg-3 text-left">
              <tr>
                <th className="px-3 py-1 font-medium">Address</th>
                <th className="px-2 py-1 font-medium text-right w-16">Hz</th>
                <th className="px-2 py-1 font-medium text-right w-16">Count</th>
                <th className="px-3 py-1 font-medium w-[40%]">Last value</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-fg-3">{paused ? 'Paused.' : seenAny ? 'No addresses match the filter.' : 'Waiting for OSC messages…'}</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.address} className="border-t border-line-1/50 hover:bg-surface-2/50">
                  <td className="px-3 py-1 text-fg-1 truncate max-w-[280px]" title={r.address}>{r.address}</td>
                  <td className="px-2 py-1 text-right text-fg-2">{r.hz >= 1 ? r.hz.toFixed(0) : r.hz > 0 ? r.hz.toFixed(1) : '·'}</td>
                  <td className="px-2 py-1 text-right text-fg-3">{r.count}</td>
                  <td className="px-3 py-1 text-fg-2 truncate" title={r.last}>{r.last}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Raw log */}
        {logging && (
          <div className="h-40 shrink-0 border-t border-line-1 overflow-auto bg-black/30 px-3 py-2 num text-micro leading-snug text-fg-2">
            {logLines.length === 0 ? <div className="text-fg-3">Logging… raw messages will stream here.</div> :
              logLines.map((l, i) => <div key={i} className="whitespace-pre truncate">{l}</div>)}
          </div>
        )}
      </div>
      </div>
    </div>
  );
};
