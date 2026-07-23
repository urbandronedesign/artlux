import React, { useEffect, useRef, useState } from 'react';
import { X, Pause, Play, Trash2, Radio, Search } from 'lucide-react';
import type { OscMessage } from '../../../shared/protocol';
import type { PanelProps } from '@artlux/sdk/renderer';
import { Button } from '@/components/ui'; // host UI primitive (pure presentational — no singleton)
import { useHostSettings } from './trackingHost';

// OSC sniffer / monitor — a diagnostic view of the raw incoming OSC stream, for testing the
// LiDAR tracking system (is the venue server actually sending blobs to this machine?).
//
// It taps window.artlux.onOscMessage DIRECTLY, in parallel with services/oscController's router
// (each preload onOscMessage() registers its own ipcRenderer listener, so multiple subscribers
// coexist). It therefore sees EVERY received message on the wire — including ones the router
// ignores, and including live blobs even while a recorded take is replaying (the trackingStore
// replay gate doesn't apply here, because we parse the stream ourselves).
//
// Perf: at 61 fps × many leaf addresses this is a firehose. We never setState per message —
// messages accumulate into a mutable ref synchronously, and a ~4 Hz interval flushes a derived
// snapshot into React state. (See the perf-rerenders note: high-rate signals must stay render-free.)

const SPEC_RE = /^\/([^/]+)\/specs\/(Scalex|Scaley)$/i;
const BLOB_RE = /^\/([^/]+)\/blobs\/blob(\d+)\/(id|tx|ty|u|v)$/i;

interface AddrStat { count: number; prev: number; last: (number | string)[]; lastAt: number; }
interface SurfStat { scaleX: number; scaleY: number; slots: Map<number, number>; } // slot → id

interface Accum {
  total: number;
  prevTotal: number;
  lastFlush: number;
  addresses: Map<string, AddrStat>;
  surfaces: Map<string, SurfStat>;
  log: string[];        // ring buffer of recent raw lines (only filled while logging)
}

function freshAccum(): Accum {
  return { total: 0, prevTotal: 0, lastFlush: performance.now(), addresses: new Map(), surfaces: new Map(), log: [] };
}

const LOG_CAP = 600;       // ring-buffer size for the raw log
const FLUSH_MS = 250;      // UI refresh cadence (~4 Hz)

interface Row { address: string; hz: number; count: number; last: string; }
interface SurfRow { surface: string; active: number; slots: number; scaleX: number; scaleY: number; }

function fmtArgs(args: (number | string)[]): string {
  return args
    .map((a) => (typeof a === 'number' ? (Number.isInteger(a) ? String(a) : a.toFixed(4)) : JSON.stringify(a)))
    .join(', ');
}

// Registered as a 'dock' PanelContribution on the `tracking` workspace context — the host mounts it
// as a dock tab beside the other tracking monitors, so it no longer needs modal chrome or a close.
// OSC settings (for the status strip) come from the host settings service, not props.
export const OscMonitor: React.FC<PanelProps> = () => {
  const settings = useHostSettings();
  const accum = useRef<Accum>(freshAccum());
  const pausedRef = useRef(false);
  const loggingRef = useRef(false);
  const filterRef = useRef('');

  const [paused, setPaused] = useState(false);
  const [logging, setLogging] = useState(false);
  const [filter, setFilter] = useState('');
  const [totalHz, setTotalHz] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [surfRows, setSurfRows] = useState<SurfRow[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [seenAny, setSeenAny] = useState(false);

  pausedRef.current = paused;
  loggingRef.current = logging;
  filterRef.current = filter;

  // Subscribe to the raw OSC stream for the panel's lifetime (mounted only while open). Reset stats on mount.
  useEffect(() => {
    accum.current = freshAccum();
    setSeenAny(false);

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

        // Parse tracking leaves ourselves so the blob summary reflects the wire, not the store.
        const spec = SPEC_RE.exec(m.address);
        if (spec) {
          const s = surf(a, spec[1]);
          const v = typeof m.args[0] === 'number' ? m.args[0] : 0;
          if (spec[2].toLowerCase() === 'scalex') s.scaleX = v; else s.scaleY = v;
        } else {
          const b = BLOB_RE.exec(m.address);
          if (b && b[3].toLowerCase() === 'id') {
            const s = surf(a, b[1]);
            s.slots.set(parseInt(b[2], 10), typeof m.args[0] === 'number' ? m.args[0] : 0);
          }
        }

        if (loggingRef.current && (!f || m.address.includes(f))) {
          a.log.push(`${m.address}  ${fmtArgs(m.args)}`);
          if (a.log.length > LOG_CAP) a.log.splice(0, a.log.length - LOG_CAP);
        }
      }
    };

    const unsub = window.artlux?.onOscMessage?.(ingest) ?? null;
    return () => { unsub?.(); };
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

      const srows: SurfRow[] = [];
      for (const [surface, s] of a.surfaces) {
        let active = 0;
        for (const id of s.slots.values()) if (id !== 0) active++;
        srows.push({ surface, active, slots: s.slots.size, scaleX: s.scaleX, scaleY: s.scaleY });
      }
      srows.sort((x, y) => x.surface.localeCompare(y.surface));
      setSurfRows(srows);

      if (loggingRef.current) setLogLines(a.log.slice(-200));
    }, FLUSH_MS);
    return () => window.clearInterval(id);
  }, []);

  const clear = () => {
    accum.current = freshAccum();
    setRows([]); setSurfRows([]); setLogLines([]); setTotalHz(0); setSeenAny(false);
  };

  const where = settings.oscListenAddress ? `${settings.oscListenAddress}:${settings.oscListenPort}` : `*:${settings.oscListenPort}`;
  const totalActive = surfRows.reduce((n, s) => n + s.active, 0);


  return (
    <div className="w-full h-full flex flex-col bg-surface-1 overflow-hidden" aria-label="OSC Monitor">
        <div className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2 shrink-0 select-none">
          <div className="flex items-center gap-2 text-fg-1 text-sm font-semibold">
            <Radio size={15} className="text-accent" /> OSC Monitor
          </div>
        </div>

        {/* Status strip */}
        <div className="px-3 py-2 flex items-center gap-4 border-b border-line-1 text-mini shrink-0">
          <span className="inline-flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${settings.oscEnabled ? (totalHz > 0 ? 'bg-emerald-400' : 'bg-amber-400') : 'bg-fg-3'}`} />
            <span className="text-fg-2">{settings.oscEnabled ? `listening ${where}` : 'OSC receive disabled'}</span>
          </span>
          <span className="num text-fg-2">{totalHz.toFixed(0)} <span className="text-fg-3">msg/s</span></span>
          <span className="num text-fg-2">{rows.length} <span className="text-fg-3">addresses</span></span>
          <span className="num text-fg-2">{totalActive} <span className="text-fg-3">active blobs</span></span>
        </div>

        {!settings.oscEnabled && (
          <div className="px-3 py-1.5 text-mini text-amber-300 bg-amber-500/10 border-b border-line-1 shrink-0">
            OSC receive is off — enable it in Preferences ▸ OSC / Tracking, on port {settings.oscListenPort}, to see incoming data.
          </div>
        )}

        {/* Blob summary */}
        <div className="px-3 py-2 flex gap-2 flex-wrap border-b border-line-1 shrink-0">
          {surfRows.length === 0 && (
            <div className="text-mini text-fg-3 py-1">No tracking surfaces seen yet{seenAny ? ' (OSC arriving, but no /…/blobs/… addresses)' : '…'}</div>
          )}
          {surfRows.map((s) => (
            <div key={s.surface} className={`px-2.5 py-1.5 rounded-md border ${s.active > 0 ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-line-1 bg-surface-2'}`}>
              <div className="text-mini font-semibold text-fg-1">{s.surface}</div>
              <div className="num text-micro text-fg-2">{s.active}<span className="text-fg-3">/{s.slots} blobs</span></div>
              <div className="num text-micro text-fg-3">{s.scaleX.toFixed(2)}×{s.scaleY.toFixed(2)} m</div>
            </div>
          ))}
        </div>

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
  );
};

function surf(a: Accum, name: string): SurfStat {
  let s = a.surfaces.get(name);
  if (!s) { s = { scaleX: 0, scaleY: 0, slots: new Map() }; a.surfaces.set(name, s); }
  return s;
}
