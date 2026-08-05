// Project-playlist scheduler (main process). Ticks the wall clock and, in BROADCAST mode, relaunches
// the app into the project that is due now (relaunch-per-project — a fresh process each switch, so no
// media/GPU leaks accumulate over days). Stateless across relaunch: on every start it re-reads the
// userData playlist and re-arms, holding no cross-process state — an app crash / OS reboot resumes on
// the correct project. The relaunch-loop guard only switches when the due project differs from the one
// currently loaded (--project=), so re-arming after a start never re-triggers the same project.
//
// In editor mode the scheduler does NOT auto-relaunch (that would yank the operator into broadcast);
// it only reports status. The operator explicitly starts the playlist in broadcast (startBroadcast).

import { app } from 'electron';
import { relaunchArgs } from '../../../src/main/runProfile'; // host relaunch seam (main-side, in-process)
import { getPlaylist, resolve, minuteOfWeek } from './playlist';
import type { PlaylistStatus } from './types';

const argv = process.argv.slice(1);
const IS_BROADCAST = argv.includes('--broadcast');
const projArg = argv.find((a) => a.startsWith('--project='));
const CURRENT_PROJECT = projArg ? projArg.slice('--project='.length) : '';

// Normalize a path for equality across Windows case + separators.
const norm = (p: string | null | undefined) => (p || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

let timer: ReturnType<typeof setInterval> | null = null;
let onStatus: ((s: PlaylistStatus) => void) | null = null;
let relaunching = false;

// Relaunch the app into broadcast mode loading `projectPath`. The argv base comes from the host's
// ONE relaunch builder (re-passes the app path when unpacked; carries --built-renderer so the
// successor does not inherit a dev-server URL whose server this exit kills).
export function relaunchBroadcast(projectPath: string): void {
  if (relaunching) return;
  relaunching = true;
  const args = relaunchArgs();
  args.push('--broadcast');
  if (projectPath) args.push(`--project=${projectPath}`);
  console.log('[show-control] relaunch → broadcast', projectPath);
  try { app.releaseSingleInstanceLock(); } catch { /* ignore */ } // let the fresh process reclaim the single-instance lock
  app.relaunch({ args });
  app.exit(0);
}

// Compute current/next status (informational; drives the tablet header).
export function status(): PlaylistStatus {
  const pl = getPlaylist();
  const { due, next } = resolve(minuteOfWeek(new Date()), pl.entries);
  return {
    currentPath: CURRENT_PROJECT || null,
    nextPath: next?.entry.projectPath ?? null,
    nextAt: next?.entry.time ?? null,
  };
}

// Start the playlist explicitly (from the operator panel / tablet): jump broadcast to the due project.
// If nothing is due (empty/disabled playlist) this is a no-op.
export function startBroadcast(): void {
  const pl = getPlaylist();
  const { due } = resolve(minuteOfWeek(new Date()), pl.entries);
  if (due) relaunchBroadcast(due.entry.projectPath);
}

function tick(): void {
  const pl = getPlaylist();
  // Push status every tick so a freshly-connected tablet always has current/next.
  onStatus?.(status());
  if (!IS_BROADCAST || !pl.enabled) return;
  const { due } = resolve(minuteOfWeek(new Date()), pl.entries);
  if (!due) return;
  if (norm(due.entry.projectPath) !== norm(CURRENT_PROJECT)) {
    relaunchBroadcast(due.entry.projectPath);
  }
}

export function start(statusCb: (s: PlaylistStatus) => void): void {
  onStatus = statusCb;
  if (timer) return;
  // 5s cadence: minute-of-day resolution is plenty for a time-of-day playlist, and a fast-ish tick
  // makes the boundary switch feel prompt without busy-waiting.
  timer = setInterval(tick, 5000);
  tick(); // resolve immediately on start (so a broadcast launched on the wrong project corrects fast)
}

export function stop(): void {
  if (timer) { clearInterval(timer); timer = null; }
  onStatus = null;
}

export function currentProject(): string { return CURRENT_PROJECT; }
export function isBroadcast(): boolean { return IS_BROADCAST; }
