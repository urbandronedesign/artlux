// Machine-global project playlist: an ordered list of (project, time-of-day, weekdays). Persisted in a
// userData sidecar so it survives process relaunch and is readable by main at every start (the whole
// unattended-broadcast design leans on this being stateless across relaunches — see scheduler.ts).
// This module is pure storage + a "which project is due now" resolver; the scheduler drives relaunch.

import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Playlist, PlaylistEntry } from './types';

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

const MIN_PER_WEEK = 7 * 24 * 60;

// "HH:MM" → minutes since midnight, or null if malformed.
function parseHM(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// Expand an entry into its minute-of-week occurrences (one per active weekday; empty days = all 7).
function occurrences(e: PlaylistEntry): number[] {
  const hm = parseHM(e.time);
  if (hm == null) return [];
  const days = e.days && e.days.length ? e.days : [0, 1, 2, 3, 4, 5, 6];
  return days.filter((d) => d >= 0 && d <= 6).map((d) => d * 1440 + hm);
}

export interface Resolved { entry: PlaylistEntry; occ: number }

// The entry currently in effect at `nowMinuteOfWeek` (the latest occurrence at-or-before now, wrapping
// across the week boundary) and the next upcoming one. Only enabled entries with a valid path count.
export function resolve(nowMinuteOfWeek: number, entries: PlaylistEntry[]): { due: Resolved | null; next: Resolved | null } {
  let due: Resolved | null = null;      // maximize (occ - now) among occ <= now  (i.e. closest past)
  let dueDelta = -Infinity;
  let next: Resolved | null = null;     // minimize (occ - now) among occ > now
  let nextDelta = Infinity;

  for (const entry of entries) {
    if (!entry.enabled || !entry.projectPath) continue;
    for (const base of occurrences(entry)) {
      // Consider this week and the previous week so "before the first entry of the week" wraps to the
      // last entry of the prior week.
      for (const occ of [base - MIN_PER_WEEK, base]) {
        const delta = occ - nowMinuteOfWeek; // <= 0 = past/now, > 0 = future
        if (delta <= 0 && delta > dueDelta) { dueDelta = delta; due = { entry, occ: base }; }
      }
      const fwdDelta = base - nowMinuteOfWeek;
      if (fwdDelta > 0 && fwdDelta < nextDelta) { nextDelta = fwdDelta; next = { entry, occ: base }; }
    }
  }
  return { due, next };
}

// Convenience: minute-of-week for a Date (local time).
export function minuteOfWeek(d: Date): number {
  return d.getDay() * 1440 + d.getHours() * 60 + d.getMinutes();
}
