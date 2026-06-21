import { app, dialog, type BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectData, RigData, Prefs, OpenProjectResult } from '../../shared/protocol';

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

function writeJson(path: string, data: unknown): boolean {
  try {
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) {
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
      filters: [{ name: 'ArtLux Project', extensions: ['artlux', 'json'] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    target = res.filePath;
  }
  if (!writeJson(target, data)) return null;
  pushRecent(target);
  return target;
}

export async function openProject(win: BrowserWindow | null): Promise<OpenProjectResult | null> {
  const opts = {
    title: 'Open Project',
    properties: ['openFile' as const],
    filters: [{ name: 'ArtLux Project', extensions: ['artlux', 'json'] }],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  const path = res.filePaths[0];
  const data = readJson<ProjectData>(path);
  if (!data) return null;
  pushRecent(path);
  return { path, data };
}

export function loadProjectPath(path: string): ProjectData | null {
  const data = readJson<ProjectData>(path);
  if (data) pushRecent(path);
  return data;
}

export async function exportRig(win: BrowserWindow | null, rig: RigData): Promise<string | null> {
  const opts = {
    title: 'Export Rig',
    defaultPath: 'artlux-rig.artrig',
    filters: [{ name: 'ArtLux Rig', extensions: ['artrig', 'json'] }],
  };
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (res.canceled || !res.filePath) return null;
  return writeJson(res.filePath, rig) ? res.filePath : null;
}

export async function importRig(win: BrowserWindow | null): Promise<RigData | null> {
  const opts = {
    title: 'Import Rig',
    properties: ['openFile' as const],
    filters: [{ name: 'ArtLux Rig', extensions: ['artrig', 'json'] }],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  return readJson<RigData>(res.filePaths[0]);
}
