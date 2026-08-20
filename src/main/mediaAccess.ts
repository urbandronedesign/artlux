// WHAT THE MEDIA SCHEME IS ALLOWED TO SERVE.
//
// `artlux-media://` turns any absolute path into something the renderer can read. The renderer is
// sandboxed precisely so that a bug (or a malicious project file, or a plugin) cannot read arbitrary
// files, so the scheme must not hand that back. This module is the authority: the handler asks, and
// anything not admitted here is a 403.
//
// TWO KINDS OF ADMISSION, because ArtLux legitimately has both:
//   · ROOTS — the open project's folder (its assets/ live there), userData (tracking takes, the audio
//     conform cache, thumbnail sidecars), and any directory the OPERATOR chose in a file dialog. A
//     dialog is consent: they picked that folder, in that window, for this app.
//   · EXACT PATHS — every path the open project actually references. `relativizeAssets` deliberately
//     keeps assets OUTSIDE the project folder absolute (docs/ASSETS.md), so a roots-only rule would
//     break every show that references a media library on another drive — which is most of them.
//
// The exact set is harvested with projectFolder.mapAssetPaths, the same visitor `resolveAssets` uses.
// That is deliberate: written as its own walk it would drift the first time a new asset-bearing field
// landed, and the failure mode of drift here is "the operator's video is silently black". Sharing the
// visitor means a new field is admitted and resolved by one edit, or by neither.
//
// REBUILT FROM SCRATCH ON EVERY PROJECT OPEN. Closing a project stops its assets being readable; a
// playlist switching shows does not accumulate the union of everything it has ever played.

import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { ProjectData } from '../../shared/protocol';
import { collectAssetPaths, isInside } from './projectFolder';

const roots = new Set<string>();
const exact = new Set<string>();
// One log line per distinct denial. A denied request is either a bug or an attack, and per-frame
// logging of either is useless (a <video> retries) and itself a hazard (a log that fills a disk).
const denied = new Set<string>();

const norm = (p: string): string => {
  try {
    // realpath resolves symlinks/junctions — without it, a link inside the project folder is a
    // traversal primitive that `isInside` would happily approve.
    return realpathSync(resolve(p));
  } catch {
    return resolve(p); // missing file: normalize anyway, and let the handler 404 it
  }
};

/** A directory the operator chose in a dialog (or that we own) — admits everything under it. */
export function allowRoot(dir: string): void {
  if (!dir || !isAbsolute(dir)) return;
  roots.add(norm(dir));
}

/** Admit exactly one file (used for a single-file dialog pick). */
export function allowPath(file: string): void {
  if (!file || !isAbsolute(file)) return;
  exact.add(norm(file));
}

/**
 * Re-admit everything a freshly-opened project needs, and forget the last one's.
 *
 * `data` must be the RESOLVED document (absolute paths — i.e. after resolveAssets), because that is
 * what the renderer will ask for.
 */
export function setProject(projectFile: string, data: ProjectData, userDataDir: string): void {
  roots.clear();
  exact.clear();
  denied.clear();
  if (projectFile) allowRoot(dirname(projectFile));
  if (userDataDir) allowRoot(userDataDir);
  for (const p of collectAssetPaths(data)) if (isAbsolute(p)) exact.add(norm(p));
}

export function isAllowed(absPath: string): boolean {
  const p = norm(absPath);
  if (exact.has(p)) return true;
  for (const r of roots) if (p === r || isInside(r, p)) return true;
  return false;
}

/** True the first time a given path is refused — so the handler logs once, not per frame. */
export function noteDenied(absPath: string): boolean {
  const p = resolve(absPath);
  if (denied.has(p)) return false;
  denied.add(p);
  return true;
}

/** Diagnostics: what the scheme would currently serve. */
export const stats = (): { roots: number; exact: number; denied: number } =>
  ({ roots: roots.size, exact: exact.size, denied: denied.size });

/**
 * Admit media that arrived AFTER the project was opened.
 *
 * ⚠ THIS EXISTS BECAUSE `setProject` IS NOT ENOUGH, AND THE GAP WAS SILENT.
 *
 * `setProject` runs in exactly one place — `openProjectTimed` — so for a long time the scheme knew only
 * what a project referenced AT OPEN. Everything acquired during the session was invisible to it:
 *
 *   · An import into an UNSAVED project. There is no project folder to admit as a root, so the entry
 *     references the file where it lies — outside every root, absent from every exact path. 403.
 *   · The first Save (Save As). It creates the project folder but never re-admits anything, so assets
 *     under a folder the operator just made stayed refused until the app re-opened the project.
 *   · A scan that adopts files copied in by hand, into a project that was never opened from disk.
 *
 * And a 403 does not look like a permission failure downstream — it looks like an undecodable file.
 * Timeline.tsx's duration probe resolves `null`, the clip is placed at a default length with NO
 * `sourceDuration`, and `onAudioDragMove`'s cap then pins the right-trim handle to that length: a clip
 * that is the wrong size and CANNOT BE RESIZED. Meanwhile the Audio Bed panel places the same file
 * perfectly, because it asks the native engine (which reads the file directly) instead of Chromium
 * (which must come through here). That divergence is what the bug was reported as.
 *
 * ADDITIVE WITHIN A SESSION, and that is the whole security argument: this only ever admits a path the
 * OPERATOR just chose in a dialog or just copied into their own project. The next `setProject` still
 * clears everything, so closing a project still stops its media being readable and a playlist still does
 * not accumulate the union of every show it has played.
 */
export function allowAssets(entries: ReadonlyArray<{ path?: string } | null | undefined> | null | undefined): void {
  for (const e of entries ?? []) if (e?.path) allowPath(e.path);
}
