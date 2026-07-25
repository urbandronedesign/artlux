// The Rust side, typed once.
//
// Everything privileged — registry reads, the download, spawning the installer — lives behind these
// commands rather than behind a filesystem/shell capability granted to the web layer. The UI cannot
// name a path to execute; it can only pass back a path this Rust produced and verified.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface InstallInfo {
  dir: string;
  exe: string;
  version: string;
  per_user: boolean;
  quiet_uninstall: string;
  /** How it was located. A path guess is NOT a registry fact and is labelled as such in the UI. */
  found_by: string;
}

export interface InstallScan {
  installs: InstallInfo[];
  /** A per-user AND a per-machine install both present — Windows will not resolve this on its own. */
  duplicate: boolean;
}

export interface ReleaseInfo {
  version: string;
  tag: string;
  file: string;
  url: string;
  /** BASE64, not hex. */
  sha512_b64: string;
  size: number;
  notes_url: string;
}

export interface InstallOutcome {
  ok: boolean;
  message: string;
  scan: InstallScan;
}

export interface Progress {
  received: number;
  total: number;
  done: boolean;
}

export interface ProjectEntry {
  path: string;
  root: string | null;
  name: string;
  kind: 'file' | 'folder';
  mtime_ms: number;
  size: number;
  version: string | null;
  saved_at: string | null;
  source: 'root' | 'recent';
}

export interface ScanProgress { scanned: number; found: number; current: string; done: boolean }

export interface ScanResult {
  entries: ProjectEntry[];
  roots: string[];
  /** null = the walk finished. Otherwise it did NOT, and the UI must say so. */
  stopped: string | null;
  scanned: number;
}

export interface LauncherConfig {
  library_roots?: string[] | null;
  workspace_dir?: string | null;
}

export interface OpenOutcome { ok: boolean; message: string; started_new: boolean }

export const getConfig = () => invoke<LauncherConfig>('get_config');
export const setConfig = (config: LauncherConfig) => invoke<void>('set_config', { config });
export const getEffectiveRoots = () => invoke<string[]>('get_effective_roots');
export const scanProjects = () => invoke<ScanResult>('scan_projects');
export const cancelScan = () => invoke<void>('cancel_scan');
export const recentProjects = () => invoke<ProjectEntry[]>('recent_projects');
export const openProject = (exe: string, project: string) => invoke<OpenOutcome>('open_project', { exe, project });
export const onScanProgress = (cb: (p: ScanProgress) => void) =>
  listen<ScanProgress>('projects://progress', (e) => cb(e.payload));

/** ms epoch -> a date a human reads. Empty for 0, which is "we could not read it". */
export function when(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export interface ExampleSet {
  id: string;
  title: string;
  blurb: string;
  projects: string[];
  project_names: string[];
  size: number;
  has_tutorial: boolean;
}

export interface CopyResult { dir: string; project: string; renamed: boolean; message: string }

export const listExamples = (installDir: string) => invoke<ExampleSet[]>('list_examples', { installDir });
export const getWorkspace = () => invoke<string>('get_workspace');
export const copyExample = (installDir: string, setId: string, project: string) =>
  invoke<CopyResult>('copy_example', { installDir, setId, project });

export interface PreflightItem { group: string; id: string; name: string; status: 'PASS'|'WARN'|'FAIL'|'SKIP'; detail: string; remedy: string }
export interface PreflightReport {
  generated_at: string;
  host: string;
  mode: string;
  summary: { pass: number; warn: number; fail: number; skip: number };
  results: PreflightItem[];
  /** 'run' | 'cache' — a stale report must never look like a fresh one. */
  from: string;
}

export const healthState = (installDir: string) =>
  invoke<{ available: boolean; winget: boolean; script: string }>('health_state', { installDir });
export const healthCached = () => invoke<PreflightReport | null>('health_cached');
export const healthRun = (installDir: string) => invoke<PreflightReport>('health_run', { installDir });
export const healthRepair = (installDir: string) => invoke<void>('health_repair', { installDir });

export const scanInstalls = () => invoke<InstallScan>('scan_installs');
export const artluxRunning = () => invoke<boolean>('artlux_running');
export const resolveLatest = () => invoke<ReleaseInfo>('resolve_latest');
export const isNewer = (latest: string, installed: string) => invoke<boolean>('is_newer', { latest, installed });
export const cancelDownload = () => invoke<void>('cancel_download');
export const runInstaller = (path: string) => invoke<InstallOutcome>('run_installer', { path });

export const downloadInstaller = (r: ReleaseInfo) =>
  invoke<string>('download_installer', { url: r.url, file: r.file, sha512B64: r.sha512_b64, size: r.size });

export const onProgress = (cb: (p: Progress) => void) => listen<Progress>('download://progress', (e) => cb(e.payload));

/** Bytes → a size a human reads at a glance. KB below a megabyte: a 41 KB example set rendered as
 *  "0.0 MB" reads as empty, which is the one thing it is not. */
export function mb(n: number): string {
  if (n <= 0) return '—';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
