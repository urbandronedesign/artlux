// THE EDITOR'S RENDERER DIED AND NOTHING NOTICED. Recovery for the one case no other tier covers: an
// operator's editor (or ArtLux Calibrator) whose renderer PROCESS is gone — crashed, OOM-killed, taken
// down by a GPU driver reset.
//
// What used to happen (owner's session, 2026-10-26 09:10:47): a GPU reset killed the Calibrator's
// editor renderer. Every output reloaded itself (projector.ts → webglcontextlost) and then sat on
// "Waiting for the main window…" for good; the editor window stayed on screen, dead; the machine log
// said nothing, because the only `render-process-gone` listener is the watchdog's and it returns early
// unless it is ARMED, which it is only in broadcast. 28 minutes later the close guard logged "renderer
// did not answer". (Open since 2026-10-23: plans/mp4-decoder-freeze.md §11 item 1.)
//
// What happens now, in every mode: the death is LOGGED, with Electron's reason. Then, in the editor
// only — a show mode belongs to the watchdog, whose answer is a full relaunch, and two recoveries
// racing over one window is worse than either — the window is LOADED AGAIN, on a ladder:
//   1st, 2nd death in RECOVERY_WINDOW_MS → load the editor on the last project (`?project=`)
//   3rd                                  → Safe Mode (`?safe=1`): empty editor, nothing auto-opened —
//                                          the existing rung 3 (services/faultReporter.ts), because a
//                                          project that kills its renderer would otherwise kill it again
//   4th                                  → stop, and say so in a dialog. Never a reload storm.
//
// WHY A FRESH LOAD AND NOT webContents.reload(): reload() replays the URL the window was STARTED with.
// Launched with `--project=A`, then switched to B through File ▸ Open, a reload would bring back A.
// lastProjectPath is written on every open and save (persistence.pushRecent), so it is the document
// the operator was last working with — the same one a manual restart reopens.
//
// Nothing is lost by reloading: the unsaved document lived in the renderer that just died. The
// renderer is told it was recovered (`?recovered=<reason>`) so it can say that plainly.

import { app, dialog, type BrowserWindow } from 'electron';
import * as logger from './logger';
import { quitRequested } from './quitState';

const RECOVERY_WINDOW_MS = 5 * 60_000;
const RELOAD_DELAY_MS = 1000; // let the GPU process and the outputs' own reloads settle first

export interface EditorRecoveryOpts {
  /** True in broadcast/headless, or when the watchdog is armed: someone else owns recovery. */
  othersOwnIt: () => boolean;
  /** The project to come back to, or '' for an untitled editor. */
  lastProject: () => string;
  /** Load the editor page with this query (dev server or built file — index.ts knows which). */
  load: (query: Record<string, string>) => void;
}

export function guardEditorRenderer(win: BrowserWindow, opts: EditorRecoveryOpts): void {
  const deaths: number[] = [];
  win.webContents.on('render-process-gone', (_e, details) => {
    const reason = details?.reason ?? 'unknown';
    const exitCode = details?.exitCode;
    // LOGGED FIRST AND ALWAYS — in a show mode too. This one line is the difference between "the
    // editor went black" and knowing it was an OOM at 14 GB or a GPU reset.
    try { logger.log('error', 'renderer', 'renderer.gone', { window: 'editor', reason, exitCode }); } catch { /* never let logging stop recovery */ }
    console.error(`[editor] renderer process gone — reason=${reason} exitCode=${exitCode}`);

    if (reason === 'clean-exit' || quitRequested() || win.isDestroyed()) return; // a teardown, not a crash
    if (opts.othersOwnIt()) return;

    const now = Date.now();
    while (deaths.length && now - deaths[0] > RECOVERY_WINDOW_MS) deaths.shift();
    deaths.push(now);
    const n = deaths.length;

    if (n >= 4) {
      console.error(`[editor] renderer died ${n} times in ${RECOVERY_WINDOW_MS / 60_000} min — not reloading again`);
      try { logger.log('error', 'renderer', 'renderer.recovery-stopped', { deaths: n }); } catch { /* ignore */ }
      void dialog.showMessageBox(win, {
        type: 'error',
        title: 'The editor keeps stopping',
        message: 'The editor stopped four times in a few minutes, so ARTLux has stopped reloading it.',
        detail: `Last reason: ${reason}. Your project file on disk has not been modified. Quit and start ARTLux again; `
          + 'if it keeps happening, the machine log in the project folder records each stop.',
        buttons: ['Quit ARTLux', 'Leave it'],
        defaultId: 0,
        // ⚠ Without cancelId, Electron maps ANY dismissal (Esc, the X, the parent going away) to
        // button 0 — here that is Quit, and it quit the app by itself in testing. Dismissing must leave.
        cancelId: 1,
      }).then((r) => { if (r.response === 0) app.quit(); }).catch(() => { /* ignore */ });
      return;
    }

    setTimeout(() => {
      if (win.isDestroyed() || quitRequested()) return; // a pending close went through meanwhile (closeGuard)
      const safe = n >= 3;
      const project = safe ? '' : opts.lastProject();
      console.warn(`[editor] reloading the editor after its renderer died (${n}/3${safe ? ', Safe Mode' : ''})${project ? ' — ' + project : ''}`);
      try { logger.log('warn', 'renderer', 'renderer.recovered', { attempt: n, safe, project: project || null }); } catch { /* ignore */ }
      opts.load({ recovered: reason, ...(safe ? { safe: '1' } : project ? { project } : {}) });
    }, RELOAD_DELAY_MS);
  });
}
