import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { IPC, type BlendConvertResult, type BlendWatchEntry } from '../../shared/protocol';
import * as persistence from './persistence';
import { log } from './logger';

// NATIVE .blend IMPORT — by asking Blender.
//
// A .blend is Blender's memory written to disk: its layout changes between versions, and a mesh's
// final shape only exists once Blender has evaluated its modifiers. Nothing outside Blender reads one
// reliably, so ArtLux does not try. It runs the Blender installed on this machine, headless, to export
// the file as a .glb — the format the rest of the 3D pipeline already speaks — and loads that. Screens
// (`screen…`) and projectors (`projector…`) travel because the export keeps object names and cameras.
//
// TWO FILES PER MODEL, on purpose: SceneModel.source is the .blend, SceneModel.path the converted
// .glb. A project therefore still opens where Blender is NOT installed — a venue PC that only plays
// the show loads the last .glb. Blender is needed to IMPORT or UPDATE, never to play.
//
// LIVE UPDATE: every .blend in the scene is watched. Saving it in Blender re-exports it, and every
// window — the editor AND each projector — is told, so each reloads that .glb. Every binding survives:
// screens and projectors are matched by NAME, which is exactly what a re-export keeps.

const CACHE_DIR = () => join(app.getPath('userData'), 'blend-cache');
const TIMEOUT_MS = 180_000;
const SETTLE_MS = 700; // Blender writes `x.blend@` then renames; wait for the burst of events to end

// ── Finding Blender ─────────────────────────────────────────────────────────────────────────────────
// Order: the path set in Preferences, then ARTLUX_BLENDER, then the newest version in the standard
// install location. "Newest" by the version in the folder name — a machine with 5.1 and 5.2 side by
// side converts with 5.2, which reads every file 5.1 wrote.
function versionKey(dir: string): number[] {
  const m = /(\d+)\.(\d+)/.exec(dir);
  return m ? [+m[1], +m[2]] : [0, 0];
}
export function findBlender(): string | null {
  const pref = (persistence.getPrefs() as { blenderPath?: string }).blenderPath;
  if (pref && existsSync(pref)) return pref;
  const env = process.env.ARTLUX_BLENDER;
  if (env && existsSync(env)) return env;
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[];
    const found: string[] = [];
    for (const r of roots) {
      const base = join(r, 'Blender Foundation');
      if (!existsSync(base)) continue;
      for (const d of readdirSync(base)) {
        const exe = join(base, d, 'blender.exe');
        if (existsSync(exe)) found.push(exe);
      }
    }
    found.sort((a, b) => { const x = versionKey(a), y = versionKey(b); return y[0] - x[0] || y[1] - x[1]; });
    return found[0] ?? null;
  }
  if (process.platform === 'darwin') {
    const mac = '/Applications/Blender.app/Contents/MacOS/Blender';
    return existsSync(mac) ? mac : null;
  }
  for (const p of ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender']) if (existsSync(p)) return p;
  return null;
}

// ── Converting ──────────────────────────────────────────────────────────────────────────────────────
// The export Blender runs. Kept to options every Blender since 2.8x accepts, and set to what the 3D
// scene needs: Y-up, UVs (content is mapped through them), modifiers applied (what you see in Blender
// is what you get), and CAMERAS — a `projector…` camera is a calibration starting point.
const EXPORT_PY = `
import bpy, sys
out = sys.argv[sys.argv.index('--') + 1]
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True,
    export_texcoords=True, export_normals=True, export_apply=True, export_cameras=True)
`;

/** Where a .blend's export lives when nothing better is known: per source path, in userData. */
export function defaultGlbFor(blendPath: string): string {
  const h = createHash('sha1').update(blendPath.toLowerCase()).digest('hex').slice(0, 10);
  return join(CACHE_DIR(), `${basename(blendPath).replace(/\.blend$/i, '')}-${h}.glb`);
}

const inFlight = new Map<string, Promise<BlendConvertResult>>();

/**
 * Export `blendPath` to `glbPath` with Blender. Writes to a temp file and RENAMES on success, so a
 * failed or interrupted export never replaces a good model, and a reader never sees half a file.
 * One conversion per source at a time; a second request while one runs joins it.
 */
export function convertBlend(blendPath: string, glbPath?: string): Promise<BlendConvertResult> {
  const key = blendPath.toLowerCase();
  const running = inFlight.get(key);
  if (running) return running;
  const p = runConvert(blendPath, glbPath ?? defaultGlbFor(blendPath)).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function runConvert(blendPath: string, glbPath: string): Promise<BlendConvertResult> {
  const blender = findBlender();
  if (!blender) {
    log('warn', 'blend', 'blend.no-blender', { source: blendPath });
    return { ok: false, glbPath, error: 'Blender was not found on this machine. Install Blender, or set its path in Preferences ▸ Blender.' };
  }
  if (!existsSync(blendPath)) return { ok: false, glbPath, error: `The .blend file is missing: ${blendPath}` };
  mkdirSync(dirname(glbPath), { recursive: true });
  const tmp = `${glbPath}.${process.pid}.tmp.glb`;
  const t0 = Date.now();
  const res = await new Promise<{ code: number | null; tail: string; timedOut: boolean }>((resolve) => {
    let tail = '';
    const keep = (b: Buffer) => { tail = (tail + b.toString()).slice(-4000); };
    // --factory-startup: the operator's own Blender add-ons and startup file must not change the export.
    // --python-exit-code: a Python error is a failed conversion, not a silent exit 0.
    const child = spawn(blender, ['--background', '--factory-startup', '-noaudio', blendPath,
      '--python-exit-code', '1', '--python-expr', EXPORT_PY, '--', tmp], { windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, tail, timedOut: true }); }, TIMEOUT_MS);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, tail: String(err), timedOut: false }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, tail, timedOut: false }); });
  });
  const ms = Date.now() - t0;
  if (res.code === 0 && existsSync(tmp) && statSync(tmp).size > 0) {
    await rename(tmp, glbPath);
    log('info', 'blend', 'blend.converted', { source: blendPath, glb: glbPath, blender, ms });
    return { ok: true, glbPath, blender, ms };
  }
  await rm(tmp, { force: true }).catch(() => {});
  // The useful line of Blender's output is near the end — the Python traceback or the read error.
  const lastLines = res.tail.split(/\r?\n/).filter((l) => l.trim()).slice(-6).join('\n');
  const error = res.timedOut ? `Blender did not finish within ${TIMEOUT_MS / 1000} s.` : `Blender could not export the file.\n${lastLines}`;
  log('error', 'blend', 'blend.failed', { source: blendPath, blender, ms, code: res.code, tail: lastLines });
  return { ok: false, glbPath, blender, ms, error };
}

// ── Watching ────────────────────────────────────────────────────────────────────────────────────────
// The renderer sends the full list of {source, path} on every model change; this keeps exactly those
// watched. A DIRECTORY watch, filtered by name: Blender saves `x.blend@` and renames it over `x.blend`,
// and a watch on the file itself is left pointing at the replaced inode on Windows.
const dirWatchers = new Map<string, FSWatcher>();
let entries: BlendWatchEntry[] = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const lastStamp = new Map<string, number>();

export function setWatched(list: BlendWatchEntry[], win: () => BrowserWindow | null): void {
  entries = list.filter((e) => e.source && e.path);
  const dirs = new Set(entries.map((e) => dirname(e.source)));
  for (const [d, w] of dirWatchers) if (!dirs.has(d)) { w.close(); dirWatchers.delete(d); }
  for (const d of dirs) {
    if (dirWatchers.has(d) || !existsSync(d)) continue;
    try {
      const w = watch(d, (_ev, name) => {
        if (!name) return;
        for (const e of entries) if (basename(e.source).toLowerCase() === String(name).toLowerCase()) schedule(e, win);
      });
      w.on('error', () => { w.close(); dirWatchers.delete(d); });
      dirWatchers.set(d, w);
    } catch (err) { log('warn', 'blend', 'blend.watch-failed', { dir: d, err: String(err) }); }
  }
  // A project opened on a machine where the export is missing (moved without it, or never collected):
  // rebuild it now if the source is here, rather than showing an empty model.
  for (const e of entries) {
    if (!existsSync(e.path) && existsSync(e.source)) schedule(e, win, 0);
    else if (existsSync(e.source)) lastStamp.set(e.source, statSync(e.source).mtimeMs);
  }
}

function schedule(e: BlendWatchEntry, win: () => BrowserWindow | null, delay = SETTLE_MS): void {
  const t = timers.get(e.source);
  if (t) clearTimeout(t);
  timers.set(e.source, setTimeout(() => { timers.delete(e.source); void refresh(e, win); }, delay));
}

async function refresh(e: BlendWatchEntry, win: () => BrowserWindow | null): Promise<void> {
  if (!existsSync(e.source)) return;
  // Directory events fire for reads, backups (`x.blend1`) and touches too — only a NEW mtime is a save.
  const stamp = statSync(e.source).mtimeMs;
  if (existsSync(e.path) && lastStamp.get(e.source) === stamp) return;
  lastStamp.set(e.source, stamp);
  win()?.webContents.send(IPC.BLEND_UPDATING, e.source);
  const res = await convertBlend(e.source, e.path);
  // ALL windows, not just the editor: a projector rendering the venue holds its own copy of the model
  // and must reload it too, or the wall keeps showing the geometry from before the save.
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.BLEND_UPDATED, { source: e.source, ...res });
}

export function stopAll(): void {
  for (const w of dirWatchers.values()) w.close();
  dirWatchers.clear();
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
