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

export const scanInstalls = () => invoke<InstallScan>('scan_installs');
export const artluxRunning = () => invoke<boolean>('artlux_running');
export const resolveLatest = () => invoke<ReleaseInfo>('resolve_latest');
export const isNewer = (latest: string, installed: string) => invoke<boolean>('is_newer', { latest, installed });
export const cancelDownload = () => invoke<void>('cancel_download');
export const runInstaller = (path: string) => invoke<InstallOutcome>('run_installer', { path });

export const downloadInstaller = (r: ReleaseInfo) =>
  invoke<string>('download_installer', { url: r.url, file: r.file, sha512B64: r.sha512_b64, size: r.size });

export const onProgress = (cb: (p: Progress) => void) => listen<Progress>('download://progress', (e) => cb(e.payload));

/** Bytes → a size a human reads at a glance. */
export function mb(n: number): string {
  if (n <= 0) return '—';
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
