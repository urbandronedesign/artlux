// Shaping the boot report into the rows the splash console draws. Pure — no React, no IPC.
//
// The wire carries one entry per PROCESS HALF, which is the honest shape: a cross-process plugin like
// NDI has a main half that knows whether the addon loaded and a renderer half that knows what it
// contributed, and neither may speak for the other (see the SDK's status() docs). For a human reading a
// startup console, though, "ndi" is one thing — printing it twice reads as a duplicate, not as an
// architecture. So the halves are merged HERE, at the display edge, where the merge can't corrupt what
// either half actually reported.

import type { BootEntry, BootReport, BootState } from '../../../../shared/protocol';

export interface BootRow {
  id: string;
  name: string;
  detail: string;
  state: BootState;
  /** Sum across halves. A plugin that activated in both processes really did cost both. */
  ms?: number;
  /** Host natives are listed above the plugins under their own heading. */
  native: boolean;
}

// Worst state wins. An 'ok' renderer half must never mask a 'degraded' main half — that would hide
// exactly the case this screen exists for (the addon is missing; the UI registered fine).
const SEVERITY: Record<BootState, number> = { ok: 0, off: 1, degraded: 2, error: 3 };
const worse = (a: BootState, b: BootState): BootState => (SEVERITY[b] > SEVERITY[a] ? b : a);

export function toRows(entries: BootEntry[]): { natives: BootRow[]; plugins: BootRow[] } {
  const byId = new Map<string, BootRow>();
  for (const e of entries) {
    const key = (e.group === 'native' ? 'native:' : 'plugin:') + e.id;
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, {
        id: e.id,
        name: e.name || e.id,
        detail: e.detail ?? '',
        state: e.state,
        ms: e.ms,
        native: e.group === 'native',
      });
      continue;
    }
    existing.state = worse(existing.state, e.state);
    existing.ms = (existing.ms ?? 0) + (e.ms ?? 0);
    // Keep the more alarming half's words. When both are unremarkable, join them: "native addon
    // loaded · content source" says more than either alone, and it is what a dev actually wants.
    if (e.detail) {
      if (!existing.detail) existing.detail = e.detail;
      else if (SEVERITY[e.state] > SEVERITY.ok && SEVERITY[e.state] >= SEVERITY[existing.state]) existing.detail = e.detail;
      else if (SEVERITY[existing.state] === SEVERITY.ok) existing.detail = `${existing.detail} · ${e.detail}`;
    }
  }
  const all = [...byId.values()];
  // Insertion order, NOT alphabetical: it is load order, which is the one ordering that tells a reader
  // something (what came up before what, and where a failure happened in the sequence).
  return { natives: all.filter((r) => r.native), plugins: all.filter((r) => !r.native) };
}

export interface BootSummary {
  total: number;
  ok: number;
  /** Deliberately inactive — a setting is off, or the feature is not for this platform/GPU. */
  inactive: number;
  /**
   * degraded + error only. 'off' is EXCLUDED on purpose: nvwarp reports 'off' on every machine without
   * a Quadro/RTX-pro GPU and Spout does the same off Windows, so counting those as problems would open
   * the app on "2 need attention" for a laptop where nothing whatsoever is wrong. A summary that cries
   * wolf on a normal machine teaches an operator to ignore the one that matters.
   */
  problems: number;
  done: boolean;
}

export function summarize(report: BootReport): BootSummary {
  const { natives, plugins } = toRows(report.entries);
  const rows = [...natives, ...plugins];
  let ok = 0, inactive = 0, problems = 0;
  for (const r of rows) {
    if (r.state === 'ok') ok++;
    else if (r.state === 'off') inactive++;
    else problems++;
  }
  return { total: rows.length, ok, inactive, problems, done: report.mainDone && report.rendererDone };
}
