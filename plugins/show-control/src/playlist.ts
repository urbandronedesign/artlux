// Machine-global project playlist: an ordered list of (project, time-of-day, weekdays). Persisted in a
// userData sidecar so it survives process relaunch and is readable by main at every start (the whole
// unattended-broadcast design leans on this being stateless across relaunches — see scheduler.ts).
// This module is pure storage + a "which project is due now" resolver; the scheduler drives relaunch.

import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Playlist, PlaylistEntry } from './types';
import { occurrencesNear } from './recurrence';

const file = () => join(app.getPath('userData'), 'showctl-playlist.json');

let cache: Playlist | null = null;

const empty = (): Playlist => ({ enabled: false, entries: [] });

export function getPlaylist(): Playlist {
  if (cache) return cache;
  try {
    const p = JSON.parse(readFileSync(file(), 'utf-8')) as Partial<Playlist>;
    cache = { enabled: !!p.enabled, folder: p.folder, entries: Array.isArray(p.entries) ? p.entries : [] };
  } catch {
    cache = empty();
  }
  return cache;
}

export function setPlaylist(p: Playlist): void {
  cache = { enabled: !!p.enabled, folder: p.folder, entries: Array.isArray(p.entries) ? p.entries : [] };
  try { writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf-8'); }
  catch (e) { console.error('[show-control] playlist persist failed', e); }
}

export interface Resolved { entry: PlaylistEntry; at: number }

// The entry currently IN EFFECT at `now` (its most recent fire, at or before now) and the next one
// due. Only enabled entries with a path count.
//
// ABSOLUTE TIME, not minute-of-week. The old resolver worked in minutes-since-Sunday-midnight, a
// coordinate in which a calendar date cannot be expressed — so a one-off ("open the gala show on
// 2026-09-20 at 20:00") was not a missing feature, it was unrepresentable. recurrence.ts enumerates
// each entry's fires in a window around now; picking the closest on each side is all that is left,
// and the daily/weekly answers are unchanged (its default ±8-day window reproduces the old
// look-back of one full week that made "before the first entry of the week" wrap to the last entry
// of the previous one).
export function resolve(now: Date, entries: PlaylistEntry[]): { due: Resolved | null; next: Resolved | null } {
  const n = now.getTime();
  let due: Resolved | null = null;
  let next: Resolved | null = null;

  for (const entry of entries) {
    if (!entry.enabled || !entry.projectPath) continue;
    for (const t of occurrencesNear(entry, now)) {
      if (t <= n) { if (!due || t > due.at) due = { entry, at: t }; }
      else if (!next || t < next.at) next = { entry, at: t };
    }
  }
  return { due, next };
}
