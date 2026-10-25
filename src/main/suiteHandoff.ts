// THE OTHER APP OF THE SUITE — finding it, and handing a project to it (suite plan Phase 3).
//
// ArtLux Show and ArtLux Calibrator open the same `.artlux`; switching is "open this project in the other
// app", never a restart of the one you are in. They also share one userData (main/appPaths.ts), which
// makes Electron's single-instance lock cover both — so only one of them ever drives the displays and the
// universes, and a hand-over means: save, free the outputs and the lock, start the other one, exit.
//
// Finding the other app's exe, first hit wins:
//   1. a hint — the exe of the other app that just tried to start (second-instance hands us its argv[0]);
//   2. ARTLUX_OTHER_EXE — a test bench pointing at an unpacked build;
//   3. the sibling unpacked build, when this one runs from `release/<app>/win-unpacked` (§8a level 2);
//   4. its uninstall entry in the registry (HKLM, then HKCU) — DisplayName "ArtLux Show …" /
//      "ArtLux Calibrator …", written by scripts/package-app.cjs's uninstallDisplayName;
//   5. the default install folder.
// Not found is a normal answer: the menu then says the app is not installed and links to the download,
// rather than offering a door that opens nothing (DESIGN-SYSTEM §4.4).

import { app, dialog, type BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ARTLUX_APP } from '../../shared/appIdentity';
import { relaunchArgs } from './runProfile';
import { IPC, type SuiteOtherApp } from '../../shared/protocol';

const RELEASES = 'https://github.com/urbandronedesign/artlux/releases/latest';

const OTHER = ARTLUX_APP === 'show' ? 'calibrator' : ARTLUX_APP === 'calibrator' ? 'show' : null;
const NAME = { show: 'ArtLux Show', calibrator: 'ArtLux Calibrator' } as const;
// Show keeps the historical exe and folder names (scripts/package-app.cjs explains why).
const EXE_NAME = { show: 'ArtLux.exe', calibrator: 'ArtLux Calibrator.exe' } as const;
const DEFAULT_DIR = { show: 'ArtLux', calibrator: 'ArtLux Calibrator' } as const;

/** Which app this one hands over to, or null in the combined app. */
export function otherApp(): 'show' | 'calibrator' | null { return OTHER; }
export function otherAppName(): string | null { return OTHER ? NAME[OTHER] : null; }
export function thisAppName(): string { return ARTLUX_APP === 'calibrator' ? NAME.calibrator : ARTLUX_APP === 'show' ? NAME.show : 'ArtLux'; }

function fromRegistry(other: 'show' | 'calibrator'): string | null {
  if (process.platform !== 'win32') return null;
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      // /f searches data, /d restricts to data; /s recurses the Uninstall subkeys.
      const out = execFileSync('reg', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/d', '/f', NAME[other]],
        { encoding: 'utf8', windowsHide: true, timeout: 4000 });
      // Each match is a key line followed by its values; take the InstallLocation of a key whose
      // DisplayName STARTS with the app's name ("ArtLux Show 0.35.0"), so "ArtLux" alone never matches.
      for (const block of out.split(/\r?\n(?=HKEY_)/)) {
        if (!new RegExp(`DisplayName\\s+REG_SZ\\s+${NAME[other]}\\b`).test(block)) continue;
        // InstallLocation when the entry carries one; electron-builder's per-machine entries leave it
        // EMPTY (the path lives under HKLM\SOFTWARE\<guid>), so fall back to the folder of the
        // UninstallString, which always points into the install folder (measured on v0.34.1's entry).
        const loc = block.match(/InstallLocation\s+REG_SZ\s+(.+)/)?.[1]?.trim()
          || dirname(block.match(/UninstallString\s+REG_SZ\s+"?([^"\r\n]+?\.exe)"?/i)?.[1] ?? '');
        if (loc && existsSync(join(loc, EXE_NAME[other]))) return join(loc, EXE_NAME[other]);
      }
    } catch { /* no match → reg exits 1; not installed in this hive */ }
  }
  return null;
}

/** The other app's exe, or null when it cannot be found. */
export function findOtherAppExe(hint?: string): string | null {
  if (!OTHER) return null;
  // Only an exe that IS the other app: in a dev run argv[0] is electron.exe, which would start a bare
  // Electron on the project.
  if (hint && basename(hint).toLowerCase() === EXE_NAME[OTHER].toLowerCase() && existsSync(hint)) return hint;
  const env = process.env.ARTLUX_OTHER_EXE;
  if (env && existsSync(env)) return env;
  if (app.isPackaged) {
    // release/<app>/win-unpacked/<exe> → release/<other>/win-unpacked/<other exe>
    const sib = resolve(dirname(process.execPath), '..', '..', OTHER, 'win-unpacked', EXE_NAME[OTHER]);
    if (/[\\/]release[\\/]/.test(process.execPath) && existsSync(sib)) return sib;
  }
  const reg = fromRegistry(OTHER);
  if (reg) return reg;
  const pf = process.env['ProgramW6432'] || process.env['ProgramFiles'] || 'C:\\Program Files';
  const def = join(pf, DEFAULT_DIR[OTHER], EXE_NAME[OTHER]);
  return existsSync(def) ? def : null;
}

export function describeOtherApp(): SuiteOtherApp | null {
  if (!OTHER) return null;
  return { app: OTHER, name: NAME[OTHER], exe: findOtherAppExe(), downloadUrl: RELEASES };
}

/**
 * Hand the machine to the other app: it starts on `projectPath` once THIS process has exited. The caller
 * has already SAVED and shut its subsystems down; it exits straight after this. Returns false (and does
 * nothing) when the exe is gone, so the caller can say so and keep running.
 *
 * ⚠ THROUGH app.relaunch({ execPath }), NEVER child_process.spawn. On Windows a socket is inheritable by
 * default, and spawn passes every inheritable handle to the child — measured: the Calibrator started by
 * spawn inherited Show's listening sockets, so after Show exited its ports stayed bound under a dead pid
 * and the next app could not take them. Electron's relauncher waits for this process to exit and then
 * starts the target WITHOUT inheriting handles — the same door every other relaunch in the app uses
 * (runProfile.relaunchArgs). The successor also waits for our pid itself (handoffWait.ts).
 */
export function launchOtherApp(projectPath: string, exeHint?: string, extraArgs: string[] = []): boolean {
  const exe = findOtherAppExe(exeHint);
  if (!exe) return false;
  // relaunchArgs() is the one argv builder for every relaunch; of what it carries, only the PROFILE applies
  // to another app's exe (its app path and --built-renderer are this app's dev-mode business).
  const args = relaunchArgs().filter((a) => a.startsWith('--user-data-dir='));
  if (projectPath) args.push(`--project=${projectPath}`);
  args.push(`--handoff-from=${process.pid}`, ...extraArgs);
  app.relaunch({ execPath: exe, args });
  console.info(`[suite] handing ${projectPath || '(no project)'} to ${NAME[OTHER!]} — ${exe}`);
  return true;
}

/**
 * second-instance from the OTHER app of the suite (index.ts): it lost the shared lock and has already
 * exited. Ask, in the window the operator is looking at, whether to hand the machine over — naming both
 * apps — rather than letting the newcomer vanish or quietly opening its project here. Returns true when
 * the event was the other app's (handled here), false for an ordinary second launch of this one.
 */
export function offerHandover(win: BrowserWindow, incomingArgv: string[], additionalData: unknown): boolean {
  const incoming = (additionalData as { app?: string } | null)?.app;
  if (!OTHER || incoming !== OTHER) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const other = NAME[OTHER], me = thisAppName();
  void dialog.showMessageBox(win, {
    type: 'question',
    title: `${other} was started`,
    message: `${me} is running and drives the projectors and outputs. Only one of the two can run at a time.`,
    detail: `Switch saves this project, closes ${me} and opens the project in ${other}.`,
    buttons: [`Switch to ${other}`, `Stay in ${me}`],
    defaultId: 1, cancelId: 1, noLink: true,
  }).then(({ response }) => {
    // Through the renderer: it owns the document, so it saves first, then hands over with the exe the
    // other app started from (argv[0]) as the hint, so it reaches exactly that install.
    if (response === 0) win.webContents.send(IPC.MENU_ACTION, 'open-in-other-app:' + (incomingArgv[0] ?? ''));
  });
  return true;
}
