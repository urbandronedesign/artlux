import React, { useEffect, useRef } from 'react';
import type { BootReport, BootState } from '../../../../shared/protocol';
import { toRows, summarize, type BootRow } from './bootRows';

// The splash's console: one line per native addon / plugin, as its load actually returned.
//
// It looks like a terminal because that is what it is reporting — module loads, in order, with
// timings — and a reader already knows how to scan one. What it is NOT is a fake progress animation:
// every row appears when that thing's activation returned (main/host/plugins.ts times each one), the
// phase bar tracks the two REAL waves (main process, then renderer), and nothing on screen is
// interpolated to look busy.
//
// Colour never carries the meaning alone (DESIGN-SYSTEM §6): each state has its own glyph, and the
// name + detail stay in the readable text tiers. `danger` on near-black is ~4.3:1 — under AA for an
// 11px sentence — so red is confined to the glyph and the short FAILED badge, never a full line.

const GLYPH: Record<BootState, string> = { ok: '✓', degraded: '!', off: '·', error: '✕' };
const GLYPH_CLASS: Record<BootState, string> = {
  ok: 'text-ok',
  degraded: 'text-warn',
  off: 'text-fg-2',
  error: 'text-danger',
};
// Spoken for screen readers, which get nothing from a glyph column.
const SPOKEN: Record<BootState, string> = {
  ok: 'loaded',
  degraded: 'degraded',
  off: 'inactive',
  error: 'failed',
};

const Row: React.FC<{ row: BootRow }> = ({ row }) => (
  // 11px mono, fg-2 body, fg-1 for the name: the name is the value in this table, so it gets the
  // primary tier and the prose around it stays secondary.
  // 168px on the name column, not 136: "Projector Calibration" is the longest manifest name and was
  // truncating to "Projector Calibrati…" — a plugin whose identity is the whole point of the row.
  <div className="grid grid-cols-[14px_168px_1fr_52px] gap-2 items-baseline animate-overlay-in">
    <span className={GLYPH_CLASS[row.state]} aria-hidden="true">{GLYPH[row.state]}</span>
    <span className="text-fg-1 truncate">{row.name}</span>
    <span className="text-fg-2 truncate">
      {row.state === 'error' && <span className="text-danger font-medium">FAILED </span>}
      {row.detail}
      {/* The glyph column is decorative; this is the same information as text, for a screen reader. */}
      <span className="sr-only"> — {SPOKEN[row.state]}</span>
    </span>
    <span className="text-fg-2 text-right tabular-nums">{row.ms == null ? '—' : `${row.ms}ms`}</span>
  </div>
);

const GroupLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  // Section-label recipe (DESIGN-SYSTEM §2.3) at fg-2, NOT fg-3: the dim tier is barred from 10–11px
  // text and `verify:invariants` enforces it.
  <div className="text-micro uppercase tracking-wider text-fg-2 mt-2 first:mt-0">{children}</div>
);

export const BootConsole: React.FC<{ report: BootReport }> = ({ report }) => {
  const { natives, plugins } = toRows(report.entries);
  const s = summarize(report);
  const scroller = useRef<HTMLDivElement>(null);

  // Follow the tail as rows arrive. The report can exceed the visible ~9 lines on a machine with every
  // plugin present, and the interesting rows (the renderer wave, and any failure) arrive last.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [report.entries.length]);

  return (
    // min-h-0 is load-bearing: without it a flex child refuses to shrink below its content and the
    // console pushes the credits — a licence requirement — off the bottom of the window.
    <div className="flex flex-col gap-2 h-full min-h-0">
      <div
        ref={scroller}
        // Fills whatever height the layout has left rather than a fixed 168px, so on a normal machine
        // every row is visible at once instead of the first two being scrolled out of a short well.
        // bg-stage (#000) rather than a surface: deeper than the splash's own ground, which is what
        // makes it read as a well you are looking into instead of another panel.
        className="flex-1 min-h-0 overflow-y-auto rounded-md border border-line-1 bg-bg-stage p-3 font-mono text-mini"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-busy={!s.done}
        aria-label="Startup log"
      >
        {natives.length > 0 && <GroupLabel>Native</GroupLabel>}
        {natives.map((r) => <Row key={`n:${r.id}`} row={r} />)}
        {plugins.length > 0 && <GroupLabel>Plugins</GroupLabel>}
        {plugins.map((r) => <Row key={`p:${r.id}`} row={r} />)}
        {/* A blinking caret sells "this is live" for the price of one character, and costs nothing
            under prefers-reduced-motion (the global rule collapses the animation). */}
        {!s.done && <div className="text-fg-2 animate-caret" aria-hidden="true">▍</div>}
      </div>

      {/* The two real phases, as a determinate bar. Half when the main process has reported all its
          natives + plugin halves, full when the editor renderer has reported its own — there is no
          third thing to wait for, so there is no third guess drawn here. */}
      <div className="flex items-center gap-3">
        <div className="h-0.5 flex-1 rounded-full bg-surface-3 overflow-hidden">
          <div
            className="h-full bg-accent transition-[width] duration-med"
            style={{ width: s.done ? '100%' : report.mainDone ? '50%' : '12%' }}
          />
        </div>
        {/* Problems get the warn tier so the one line an operator glances at carries the state too —
            and 'inactive' never does, because that is the normal reading on most machines. */}
        <div className={`text-xs tabular-nums ${s.done && s.problems > 0 ? 'text-warn' : 'text-fg-2'}`}>
          {!s.done
            ? (report.mainDone ? 'main ready — starting the editor…' : 'loading…')
            : s.problems > 0
              ? `${s.total} loaded · ${s.problems} need attention`
              : s.inactive > 0
                ? `${s.total} loaded · ${s.inactive} inactive`
                : `${s.total} loaded · all ok`}
        </div>
      </div>
    </div>
  );
};
