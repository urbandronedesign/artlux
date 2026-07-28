// The file somebody reads the morning after.
//
// A permanent installation's real failure mode is not a dramatic one — it is a maintenance task that
// quietly stopped happening, or one that has been reporting the same fault for three weeks with
// nobody watching the tablet. Prometheus is the alerting channel (pull, on the monitoring box); this
// is the forensic one: an append-only JSONL of every run, its verdict and its reason, tailed on boot
// so it never grows without bound. Same idiom as the watchdog's log, deliberately — an operator who
// has debugged one already knows how to read this.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

const MAX_LINES = 2000;
let file: string | null = null;
let queue: Promise<void> = Promise.resolve();

function logPath(): string {
  if (!file) file = path.join(app.getPath('userData'), 'artlux-calibration.log');
  return file;
}

export interface AuditRecord {
  ts: string;
  event: 'run-start' | 'run-end' | 'surface' | 'interrupted' | 'applied' | 'reverted';
  [k: string]: unknown;
}

// Serialized through one promise chain: two concurrent appends to the same file interleave, and a
// half-written JSON line makes the whole log unparseable from that point on.
export function append(rec: AuditRecord): Promise<void> {
  queue = queue.then(async () => {
    try { await fs.appendFile(logPath(), `${JSON.stringify(rec)}\n`, 'utf8'); }
    catch { /* an unwritable log must never take the show down */ }
  });
  return queue;
}

/** Trim to the last MAX_LINES on boot, and return them for the panel/tablet. */
export async function tail(limit = 200): Promise<AuditRecord[]> {
  try {
    const raw = await fs.readFile(logPath(), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      await fs.writeFile(logPath(), `${lines.slice(-MAX_LINES).join('\n')}\n`, 'utf8');
    }
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l) as AuditRecord; } catch { return null; } })
      .filter((r): r is AuditRecord => !!r);
  } catch {
    return [];
  }
}

// ── The in-flight marker ───────────────────────────────────────────────────────────────────────
// A recalibration killed part-way (watchdog relaunch, power cut, crash) must be VISIBLE. Its
// presence at the next activation is the only evidence that a run started and never finished; the
// project file itself looks untouched, because the single save never happened. Deliberately NOT
// resumed — a half-measured rig is not a state to continue from.
function markerPath(): string { return path.join(app.getPath('userData'), 'artlux-recal-inflight.json'); }

export async function markInFlight(detail: Record<string, unknown>): Promise<void> {
  try { await fs.writeFile(markerPath(), JSON.stringify({ startedAt: new Date().toISOString(), ...detail }), 'utf8'); }
  catch { /* best effort */ }
}
export async function clearInFlight(): Promise<void> {
  try { await fs.unlink(markerPath()); } catch { /* already gone */ }
}
export async function takeInterrupted(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(markerPath(), 'utf8');
    await clearInFlight();
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
