import { trackingTake } from '@artlux/plugin-lidar-tracking';
import type { TrackingTakeRef } from '../types';

// TAKES SITTING IN THE FOLDER THAT THE LIBRARY DOES NOT KNOW ABOUT.
//
// A project folder is portable by design — `assets/` plus the `.artlux` — so people copy things into
// it: off a USB stick, out of a sync folder, from another machine's recording session. Every other
// media type is adopted when that happens (projectFolder.scanAssets), but a `.lblob` was skipped and
// nothing said so, which is exactly how five venue recordings came to sit in a project invisibly.
//
// ── WHY THIS IS A LIST AND NOT AN AUTO-IMPORT ────────────────────────────────────────────────────
// Deleting a take removes its row from Timeline.trackingTakes and LEAVES THE FILE, deliberately, so a
// delete stays recoverable (takeRecorder.removeTrackingTake). An orphan on disk is therefore
// indistinguishable from one that was thrown away — and takes are "the most-deleted list in the app,
// you record five and keep one". Adopting silently at startup would resurrect four in five, on every
// launch, for ever. So: notice them cheaply, show them where takes live, and let somebody say yes.
//
// The scan itself is a readdir, no parse: a venue take runs to several megabytes of per-frame
// snapshots and ~180 ms to read, and this happens on every project open, behind a boot gate.

let orphans: string[] = [];
const subs = new Set<() => void>();
const notify = (): void => { for (const cb of subs) { try { cb(); } catch (e) { console.error('[orphanTakes] subscriber', e); } } };

export function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }
export function get(): string[] { return orphans; }

// Called on project open with every take path the library already holds.
export async function rescan(projectFile: string | null, knownPaths: string[]): Promise<number> {
  if (!projectFile) { if (orphans.length) { orphans = []; notify(); } return 0; }
  const found = (await window.artlux?.scanTakes?.(projectFile, knownPaths)) ?? [];
  // Identity by content, so a no-op scan does not re-render the panel every open.
  if (found.length !== orphans.length || found.some((p, i) => p !== orphans[i])) { orphans = found; notify(); }
  return orphans.length;
}

// Read the chosen files and turn them into library rows. This is where the parse finally happens, on
// files an operator asked for. A take that will not parse is skipped rather than failing the batch —
// one corrupt file must not cost the other four.
export async function adopt(paths: string[]): Promise<TrackingTakeRef[]> {
  const refs: TrackingTakeRef[] = [];
  for (const path of paths) {
    const tk = await trackingTake.ensureLoaded(path);
    if (!tk) { console.warn('[orphanTakes] could not read', path); continue; }
    // The take carries its own id and name; keeping them means a take adopted here and the same take
    // recorded in place are the same row, so re-adopting after a delete cannot duplicate it.
    refs.push({ id: tk.id, name: tk.name, path, duration: tk.duration, fps: tk.fps });
  }
  return refs;
}

// Drop the ones just adopted, without a round-trip — the panel updates as the rows appear.
export function forget(paths: string[]): void {
  const gone = new Set(paths);
  const next = orphans.filter((p) => !gone.has(p));
  if (next.length !== orphans.length) { orphans = next; notify(); }
}
