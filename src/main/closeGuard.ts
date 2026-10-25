import type { BrowserWindow } from 'electron';
import { IPC } from '../../shared/protocol';
import { abandonQuit, quitRequested, resumeQuit } from './quitState';

// CLOSING THE EDITOR USED TO DISCARD EVERY UNSAVED CHANGE, SILENTLY.
//
// `before-quit` in index.ts is cleanup — watchdog, metrics, tray, NDI — and nothing anywhere asked
// whether the document had been saved. Hit the X with an hour of scene work in memory and it was
// simply gone: no prompt, no autosave, and (until the same change that added this) nothing on screen
// that had ever said the document differed from the file.
//
// Main cannot answer that question: the document lives in the renderer, and only the renderer can
// compare it against what was written. So a close becomes a ROUND TRIP — hold the window open, ask,
// and act on the answer.
//
// ⚠ THE BACKSTOP IS NOT OPTIONAL. A renderer that has crashed, hung, or simply lost its listener
// would otherwise make the app UNQUITTABLE — the window refusing to close forever, with the only way
// out being Task Manager. On a venue machine that is a worse failure than losing the edit, so an
// unanswered request closes anyway after ANSWER_MS. The same reasoning as the reveal backstop in
// createWindow: never let one missing event become a state the operator cannot leave.
const ANSWER_MS = 4000;

const allowed = new WeakSet<BrowserWindow>();
const waiting = new WeakSet<BrowserWindow>();
// The renderer said it is ASKING the operator (a dialog is up). The backstop is for a renderer that
// cannot answer; one that is waiting on a person has answered "alive", and closing under its dialog
// discarded unsaved work after 4 s — measured 2026-10-25, the log read "did not answer in time" while
// "Save before closing?" was on screen.
const asking = new WeakSet<BrowserWindow>();

/**
 * Ask the renderer before this window closes. `enabled` is false in show modes (broadcast/headless):
 * there is no operator to answer, the document is not being edited, and a window that will not close
 * is exactly what an unattended install must never do.
 */
export function guardClose(win: BrowserWindow, enabled: boolean): void {
  if (!enabled) return;
  // A renderer that dies WHILE asking can never answer, and `asking` has stood the backstop down — so
  // its death is the answer: let the pending close through rather than leave an unquittable window.
  win.webContents.on('render-process-gone', () => { if (waiting.has(win) && !win.isDestroyed()) allowClose(win); });
  win.on('close', (e) => {
    if (allowed.has(win)) return;         // the renderer already said go ahead
    e.preventDefault();
    if (waiting.has(win)) return;         // a second click while the dialog is up — ignore, don't stack
    waiting.add(win);
    asking.delete(win);
    win.webContents.send(IPC.MENU_ACTION, 'close-request');
    setTimeout(() => {
      if (!waiting.has(win) || allowed.has(win) || asking.has(win) || win.isDestroyed()) return;
      console.warn('[closeGuard] renderer did not answer in time — closing anyway');
      allowClose(win);
    }, ANSWER_MS);
  });
}

/**
 * The renderer is done (saved, or chose to discard): let the close through.
 *
 * ⚠ AND RESUME THE QUIT, if a quit is what asked. `preventDefault()` in the `close` handler above does
 * not merely delay a quit — it CANCELS it, and nothing re-issues it once the answer arrives. That is
 * the whole of the "Cmd+Q leaves the app running with no window" bug: the window went, the process
 * stayed. Re-issued from `closed` rather than straight after `close()` so the window is genuinely gone
 * before the quit sequence walks the window list again. See quitState.ts.
 */
export function allowClose(win: BrowserWindow): void {
  waiting.delete(win);
  asking.delete(win);
  allowed.add(win);
  if (win.isDestroyed()) { resumeQuit(); return; }
  if (quitRequested()) win.once('closed', () => resumeQuit());
  win.close();
}

/** The renderer is asking the operator: it is alive, so the backstop stands down until they answer. */
export function closeAsking(win: BrowserWindow): void {
  if (waiting.has(win)) asking.add(win);
}

/** The operator cancelled. Clear the latch so the NEXT close asks again rather than closing mutely. */
export function cancelClose(win: BrowserWindow): void {
  waiting.delete(win);
  asking.delete(win);
  // "Keep editing" answers the QUIT too, not just the window close — otherwise the aborted quit would
  // sit armed and the next unrelated window close would silently end the app.
  abandonQuit();
}
