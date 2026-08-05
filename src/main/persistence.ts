import { app, dialog, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectData, RigData, Prefs, OpenProjectResult } from '../../shared/protocol';
import { relativizeAssets, resolveAssets } from './projectFolder';
import * as mediaAccess from './mediaAccess';

// All file I/O lives in main (the renderer is sandboxed with no fs access).
// Projects/rigs use native Open/Save dialogs; preferences (settings + recent
// files + last project) persist as a small JSON in the app's userData dir.

const MAX_RECENTS = 10;
const prefsFile = () => join(app.getPath('userData'), 'artlux-prefs.json');

let prefsCache: Prefs | null = null;

const defaultPrefs = (): Prefs => ({ recentFiles: [] });

export function getPrefs(): Prefs {
  if (prefsCache) return prefsCache;
  try {
    prefsCache = { ...defaultPrefs(), ...JSON.parse(readFileSync(prefsFile(), 'utf-8')) };
  } catch {
    prefsCache = defaultPrefs();
  }
  return prefsCache;
}

export function setPrefs(patch: Partial<Prefs>): void {
  const next = { ...getPrefs(), ...patch };
  prefsCache = next;
  try {
    writeFileSync(prefsFile(), JSON.stringify(next, null, 2), 'utf-8');
  } catch (e) {
    console.error('[persistence] setPrefs failed', e);
  }
}

function pushRecent(path: string): void {
  const p = getPrefs();
  const recentFiles = [path, ...p.recentFiles.filter((f) => f !== path)].slice(0, MAX_RECENTS);
  setPrefs({ recentFiles, lastProjectPath: path });
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
