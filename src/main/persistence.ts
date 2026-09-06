import { app, dialog, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectData, RigData, Prefs, OpenProjectResult } from '../../shared/protocol';
import { relativizeAssets, resolveAssets } from './projectFolder';
import * as mediaAccess from './mediaAccess';
import * as logger from './logger';
import * as thumbCache from './thumbCache';

// All file I/O lives in main (the renderer is sandboxed with no fs access).
// Projects/rigs use native Open/Save dialogs; preferences (settings + recent
// files + last project) persist as a small JSON in the app's userData dir.

const MAX_RECENTS = 10;
const prefsFile = () => join(app.getPath('userData'), 'artlux-prefs.json');
// Where an unparseable prefs file is moved rather than overwritten — see getPrefs.
const corruptPrefsFile = () => join(app.getPath('userData'), 'artlux-prefs.corrupt.json');

let prefsCache: Prefs | null = null;

const defaultPrefs = (): Prefs => ({ recentFiles: [] });

export function getPrefs(): Prefs {
  if (prefsCache) return prefsCache;
  const path = prefsFile();
  try {
    prefsCache = { ...defaultPrefs(), ...JSON.parse(readFileSync(path, 'utf-8')) };
  } catch (e) {
    // TWO DIFFERENT EVENTS SHARE THIS CATCH, AND ONLY ONE OF THEM IS NORMAL.
    //
    // No file at all is a first run — say nothing, take the defaults, carry on.
    //
    // A file that EXISTS but will not parse is a machine that has LOST ITS COMMISSIONING. Every
    // venue-specific thing lives in here: the audio interface, the output channel count, the speaker
    // patch that says which amp is speaker 5. Falling silently back to defaults would be survivable
    // on its own — except that the very next setPrefs writes those defaults straight over the file,
    // 400 ms later, and the only copy of the patch is gone for good.
    //
    // So move it aside first. Renaming costs nothing, and it turns "the rig is wrong and nobody knows
    // why" into a file an operator can hand back to us. Truncation was the likely cause (see the
    // note on writeJson) and a truncated file often still holds most of the settings as text.
    if (existsSync(path)) {
      try {
        renameSync(path, corruptPrefsFile());
        console.error('[persistence] artlux-prefs.json was unreadable and has been kept as ' +
                      'artlux-prefs.corrupt.json — settings have been reset to defaults', e);
      } catch (renameErr) {
        console.error('[persistence] artlux-prefs.json is unreadable AND could not be preserved', renameErr);
      }
    }
    prefsCache = defaultPrefs();
  }
  return prefsCache;
}

// ⚠ THIS USED TO BE A RAW writeFileSync, AND IT LOST A COMMISSIONED SPEAKER PATCH ON A REAL MACHINE.
//
// Two independent faults, both fixed here:
//
// 1. TRUNCATION. writeFileSync opens with 'w', which zeroes the file before writing a byte. Kill the
//    process inside that window — a power cut, or the watchdog's own app.exit(0) landing on the 400 ms
//    settings debounce — and artlux-prefs.json is left as a stub. writeJson (below) already solves
//    exactly this for PROJECTS, with a long comment about it. Preferences never used it. They hold the
//    audio device, the channel count and the speaker patch, so the stakes are the same.
//
// 2. A SWALLOWED FAILURE. The old body caught the write error, logged to a console nobody has open,
//    and returned void — so a machine that CANNOT persist (a locked-down profile, an endpoint-security
//    product holding the file, a full disk) behaved perfectly for a whole commissioning session and
//    lost all of it at exit. Returning the result is what lets a caller say so while the operator is
//    still standing in the room.
//
// The cache is still updated even when the write fails, and that is deliberate: the session stays
// self-consistent, and a later write that succeeds then carries EVERY change rather than only the last
// one. Desynchronising the cache would not have prevented the loss — it would only have made the
// symptoms stranger. Surfacing the failure is the fix.
export function setPrefs(patch: Partial<Prefs>): boolean {
  const next = { ...getPrefs(), ...patch };
  prefsCache = next;
  return writeJson(prefsFile(), next);
}

function pushRecent(path: string): void {
  const p = getPrefs();
  const recentFiles = [path, ...p.recentFiles.filter((f) => f !== path)].slice(0, MAX_RECENTS);
  setPrefs({ recentFiles, lastProjectPath: path });
  // THE choke point for "the app is now working with this project" — save, open and load-path all
  // funnel here, which is why the log's project sink is pointed from here rather than from three IPC
  // handlers that would each have to remember.
  logger.setProjectFolder(dirname(path));
  // Free space on the PROJECT's volume, not just userData's — a show often lives on a second disk or
  // a share, and "the drive holding the media is full" is a different fault from "the system disk is".
  // Only knowable here, because at boot there is no project yet.
  let volumeFreeMB: number | null = null;
  try { const st = statfsSync(dirname(path)); volumeFreeMB = Math.round((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024)); }
  catch { /* a share that cannot be stat'd is itself worth seeing as null */ }
  logger.log('info', 'project', 'project.active', { path, volumeFreeMB });
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (e) {
    console.error('[persistence] read failed', path, e);
    return null;
  }
}

// PROJECT OPEN, TIMED — the main-side half of the cold-open trace (the renderer half is
// services/openTrace.ts). Read, parse and resolve are timed SEPARATELY because they scale on different
// axes (disk vs. document size vs. path count across every scene snapshot), and the plan's next steps
// (async read, worker parse — phase 6b) are each gated on which term actually dominates. Same read+parse
// as readJson — kept apart so rigs/prefs don't pay for or pollute the measurement.
function openProjectTimed(path: string): ProjectData | null {
  const t0 = performance.now();
  let text: string;
  try { text = readFileSync(path, 'utf-8'); }
  catch (e) { console.error('[persistence] read failed', path, e); return null; }
  const t1 = performance.now();
  let data: ProjectData;
  try { data = JSON.parse(text) as ProjectData; }
  catch (e) { console.error('[persistence] read failed', path, e); return null; }
  const t2 = performance.now();
  const resolved = resolveAssets(data, dirname(path));
  const t3 = performance.now();
  // ADMIT THIS PROJECT'S MEDIA TO THE SCHEME, AND FORGET THE LAST ONE'S. Rebuilt from scratch here so
  // closing a project stops its assets being readable and a playlist does not accumulate the union of
  // every show it has played. Fed the RESOLVED document because absolute paths are what the renderer
  // will ask for. See src/main/mediaAccess.
  mediaAccess.setProject(path, resolved, app.getPath('userData'));
  // …and point the thumbnail cache at this project's folder, so its sidecars travel with it.
  thumbCache.setProject(path);
  // ProjectData keeps timeline/scenes deliberately loose (`unknown` — the renderer owns those shapes),
  // so the counts peek structurally. A malformed document yields 0s here and fails loudly later.
  const clipsOf = (t: unknown): number => {
    const c = (t as { clips?: unknown[] } | undefined)?.clips;
    return Array.isArray(c) ? c.length : 0;
  };
  const sceneArr = Array.isArray(data.scenes) ? (data.scenes as { timeline?: unknown }[]) : [];
  const scenes = sceneArr.length;
  const clips = clipsOf(data.timeline) + sceneArr.reduce((n, s) => n + clipsOf(s?.timeline), 0);
  console.log(
    `[open] read=${(t1 - t0).toFixed(0)}ms parse=${(t2 - t1).toFixed(0)}ms resolve=${(t3 - t2).toFixed(0)}ms ` +
    `bytes=${text.length} scenes=${scenes} clips=${clips} rssMB=${(process.memoryUsage().rss / 1048576).toFixed(0)}`,
  );
  // …and the same numbers as DATA. The console line above stays because it is what a developer reads
  // in a terminal; this is what answers "which of the last fifty opens was slow, and in which phase".
  logger.log('info', 'open', 'project.read', {
    path,
    bytes: text.length,
    readMs: Math.round(t1 - t0),
    parseMs: Math.round(t2 - t1),
    resolveMs: Math.round(t3 - t2),
    scenes,
    clips,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
  });
  return resolved;
}

// ATOMIC REPLACE, NOT A TRUNCATING WRITE. writeFileSync's first act is openSync(path, 'w') — it TRUNCATES
// the target to zero bytes before a single byte of the new project is written. So a save that fails DURING
// the write (a full disk, an antivirus scanner grabbing the file, a power cut) does not leave the operator
// their old project: it leaves a stub. `{\n  "name": ` and nothing else. The show is gone.
//
// Wave 3 did not cause this — but it lengthened the write window considerably by growing the document
// (audioMix, Timeline.audio, and an automation array on every timeline).
//
// Write a sibling temp file, then rename over the target: rename() on the same volume is atomic on NTFS,
// so what is on disk is only ever the whole old project or the whole new one. Note the failure is still
// REPORTED — an atomic save that silently swallowed ENOSPC would be its own kind of lie.
function writeJson(path: string, data: unknown): boolean {
  const tmp = path + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch (e) {
    // The target was never opened, so the old project is intact. Don't leave the half-written temp behind.
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort — the save has already failed */ }
    console.error('[persistence] write failed', path, e);
    return false;
  }
}

export async function saveProject(win: BrowserWindow | null, data: ProjectData, path?: string): Promise<string | null> {
  let target = path;
  if (!target) {
    const opts = {
      title: 'Save Project',
      defaultPath: 'artlux-project.artlux',
      filters: [{ name: 'ARTLux Project', extensions: ['artlux', 'json'] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    target = res.filePath;
  }
  // Store asset paths under the project folder as folder-relative (portable); keep externals absolute.
  if (!writeJson(target, relativizeAssets(data, dirname(target)))) return null;
  // ADMIT THE FOLDER WE JUST WROTE INTO. A first Save (Save As) MAKES a project folder, and until this
  // line nothing admitted it: `setProject` runs only on OPEN, so every asset the operator then imported
  // into assets/ was refused by the media scheme until the app re-opened the project. Additive, so it
  // does not disturb setProject's clear-and-rebuild discipline. See src/main/mediaAccess.
  mediaAccess.allowRoot(dirname(target));
  pushRecent(target);
  return target;
}

export async function openProject(win: BrowserWindow | null): Promise<OpenProjectResult | null> {
  const opts = {
    title: 'Open Project',
    properties: ['openFile' as const],
    filters: [{ name: 'ARTLux Project', extensions: ['artlux', 'json'] }],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  const path = res.filePaths[0];
  const data = openProjectTimed(path);
  if (!data) return null;
  pushRecent(path);
  return { path, data };
}

export function loadProjectPath(path: string): ProjectData | null {
  const data = openProjectTimed(path);
  if (!data) return null;
  pushRecent(path);
  return data;
}

// Write a recorded LiDAR-blob take to a sidecar `.lblob` file under userData. Stored externally
// (absolute path) so recording never requires a saved project; "Collect Assets" later copies it
// into the project's assets/tracking/ and relativizes the reference (see projectFolder.ts).
export function saveTrackingTake(id: string, json: string): string | null {
  try {
    const dir = join(app.getPath('userData'), 'tracking-takes');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${id}.lblob`);
    writeFileSync(target, json, 'utf-8');
    return target;
  } catch (e) {
    console.error('[persistence] saveTrackingTake failed', e);
    return null;
  }
}

export async function exportRig(win: BrowserWindow | null, rig: RigData): Promise<string | null> {
  const opts = {
    title: 'Export Rig',
    defaultPath: 'artlux-rig.artrig',
    filters: [{ name: 'ARTLux Rig', extensions: ['artrig', 'json'] }],
  };
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (res.canceled || !res.filePath) return null;
  return writeJson(res.filePath, rig) ? res.filePath : null;
}

// ── Named workspaces (.artws) ─────────────────────────────────────────────────────────────────────
//
// Deliberately DUMB: a picker, a JSON write, a JSON read. Every rule about what a workspace is — the
// envelope, the version, remapping a retired workbench, clamping a 4K column onto a laptop, refusing a
// dock tree from a newer build — lives in renderer/services/workspaceStore.ts, next to the model it
// protects. Split across the two processes, the two halves would drift the first time the model moved.

export async function exportWorkspaces(win: BrowserWindow | null, file: unknown): Promise<string | null> {
  const opts = {
    title: 'Export Workspaces',
    defaultPath: 'artlux-workspaces.artws',
    filters: [{ name: 'ARTLux Workspace', extensions: ['artws', 'json'] }],
  };
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (res.canceled || !res.filePath) return null;
  return writeJson(res.filePath, file) ? res.filePath : null;
}

export async function importWorkspaces(win: BrowserWindow | null): Promise<unknown | null> {
  const opts = {
    title: 'Import Workspaces',
    properties: ['openFile' as const],
    filters: [{ name: 'ARTLux Workspace', extensions: ['artws', 'json'] }],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  return readJson<unknown>(res.filePaths[0]);
}

export async function importRig(win: BrowserWindow | null): Promise<RigData | null> {
  const opts = {
    title: 'Import Rig',
    properties: ['openFile' as const],
    filters: [{ name: 'ARTLux Rig', extensions: ['artrig', 'json'] }],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  return readJson<RigData>(res.filePaths[0]);
}
