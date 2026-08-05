// THE STARTUP SPLASH — its own small window, opened before the editor and closed once the editor is
// actually on screen.
//
// WHY A SEPARATE WINDOW, not an overlay inside the editor: the editor window is created hidden and
// revealed on `ready-to-show` (index.ts), with a 4-SECOND BACKSTOP for the packaged/GPU configs where
// that event never fires. Those seconds are the gap a splash exists to fill, and no amount of React
// inside index.html can cover a window that isn't visible yet. This window paints in ~50ms because its
// document is a wordmark, a licence line, and a list.
//
// WHAT IT SHOWS, and why it isn't decoration: the plugin/native boot report (see ./bootReport) — every
// native-backed feature graceful-degrades silently, so this is the one place a human is told that NDI
// or the audio engine didn't load. Plus the credit and the licence restriction, which LICENSE §3
// requires a build to show.
//
// WHERE IT MUST NEVER APPEAR: --headless and --broadcast. Broadcast is the watchdog's relaunch mode, so
// a splash there would mean an always-on-top window flashing over live fullscreen projector output,
// mid-show, unattended, every time the app self-heals. `open()` is simply not called in those modes
// (index.ts) and `verify:invariants` guards that it stays that way.

import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { IPC } from '../../shared/protocol';
import * as bootReport from './bootReport';
import * as persistence from './persistence';
import { clampUiScale } from './uiScale';
import { rendererDevUrl } from './runProfile';

const APP_PRELOAD = join(__dirname, '../preload/index.js');

// The design size (see docs/DESIGN-SYSTEM.md §9). Scaled by the UI-scale pref, because on a 4K venue
// panel running the editor at 150% an unscaled splash is a postage stamp beside it.
const BASE_W = 760;
// 620, measured rather than guessed: a full install reports 14 console rows (2 host natives + 10 plugins
// + 2 group headings) ≈ 245px of well. At 480 the well fitted six rows and at 560 eleven — and because
// the console auto-scrolls to the tail, the rows cut were always the FIRST ones, i.e. the native addons.
// A startup report you have to scroll is a report nobody reads.
const BASE_H = 620;

// Three timings, and each one exists because the other two are not enough:
//   MIN_MS   a readability floor from when the window appears.
//   DWELL_MS a readability floor from when the LAST ROW LANDS, which is the one that actually matters
//            and the one MIN_MS alone got wrong: on a built run the renderer's wave arrived at ~1.5s
//            and the splash closed at the 1.6s floor, so the completed console — the entire point of
//            the screen — was on display for about 100ms. Measured from completion, not from show.
//   GRACE_MS the longest we will WAIT for the renderer's plugin halves (the second and last wave)
//            before closing with a partial report. Sized from measurement, and measured from the
//            SPLASH's own clock — not from the editor's paint, which was the first mistake here: the
//            editor window becomes visible in a few hundred ms (its HTML paints) while its plugins
//            don't activate until ~5MB of bundles have parsed and App has mounted, which is 3–7s
//            depending on the machine. Anchored to the editor's paint at 2.5s, the second wave missed
//            EVERY run and the console always showed half a report. Anchored here, the splash closes
//            as soon as the report completes and only lingers when the app really is still loading.
//            It stays bounded because a cold Vite dev start can take far longer than any of this.
//   HARD_MS  the backstop for the case the editor never appears at all (a crash on boot, a wedged
//            project). The splash must never end up being the only window on screen.
const MIN_MS = 1600;
const DWELL_MS = 900;
const GRACE_MS = 9000;
const HARD_MS = 14000;

let win: BrowserWindow | null = null;
let unsubscribe: (() => void) | null = null;
let shownAt = 0;
let editorVisible = false;
let completedAt = 0;    // when the last row landed — DWELL_MS is measured from here
let closing = false;    // the exit fade has started; every close path is idempotent past this
let hardTimer: NodeJS.Timeout | null = null;
let recheckTimer: NodeJS.Timeout | null = null;

function destroy(): void {
  if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
  if (recheckTimer) { clearTimeout(recheckTimer); recheckTimer = null; }
  unsubscribe?.(); unsubscribe = null;
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

// REVEAL THE SPLASH. Three paths into one idempotent function, for the same reason the editor window
// has three (see the comment in index.ts): `ready-to-show` DOES NOT ALWAYS FIRE in a packaged build.
// This shipped in v0.25.0 relying on that event alone, and on the packaged Windows build it never
// arrived — so showInactive() was never called, `shownAt` stayed 0, and the splash existed as a window
// nobody could see. Worse, `Date.now() - 0` then satisfied every timing floor at once, so it destroyed
// itself immediately and silently: the log read "closing after 1784993242235ms".
function reveal(): void {
  if (!win || win.isDestroyed() || shownAt) return;
  win.showInactive(); // not show(): never steal focus from the editor coming up behind it
  shownAt = Date.now();
  maybeClose();
}

// One pending re-check at a time. maybeClose is driven by report pushes AND by its own deadlines, and
// without a single slot each push queued another timer.
function scheduleRecheck(ms: number): void {
  if (recheckTimer) clearTimeout(recheckTimer);
  recheckTimer = setTimeout(() => { recheckTimer = null; maybeClose(); }, Math.max(20, ms) + 20);
}

/** Both waves reported. Not a promise that everything loaded — only that nothing more is coming. */
const reportComplete = (): boolean => {
  const r = bootReport.get();
  return r.mainDone && r.rendererDone;
};

// Close once the editor is really up, the report is complete OR its grace has expired, and the splash
// has been readable for MIN_MS. The editor's own visibility is the load-bearing condition — the rest
// only shape how long we linger past it.
function maybeClose(): void {
  if (!win || win.isDestroyed() || closing) return;
  // NEVER close a window that was never shown. Every deadline below is measured from `shownAt`, so
  // while it is 0 the arithmetic is meaningless — and it does not fail safe, it fails INVISIBLE: it
  // reads as "all deadlines long past" and tears the splash down before anyone sees it. That is the
  // v0.25.0 bug. The hard timer in open() remains the ultimate backstop if reveal() never runs at all.
  if (!shownAt || !editorVisible) return;
  const complete = reportComplete();
  if (complete && !completedAt) completedAt = Date.now();
  const sinceShown = Date.now() - shownAt;
  if (!complete && sinceShown < GRACE_MS) { scheduleRecheck(GRACE_MS - sinceShown); return; }
  // Both floors: readable since it appeared, AND readable since the last row landed.
  const remaining = Math.max(
    MIN_MS - sinceShown,
    completedAt ? DWELL_MS - (Date.now() - completedAt) : 0,
  );
  if (remaining > 0) { scheduleRecheck(remaining); return; }
  fadeAndClose();
}

// Ask the renderer to run its exit fade, then destroy. If it doesn't answer (a splash that failed to
// load its bundle at all), the timer still tears the window down — never leave it on top of the editor.
function fadeAndClose(): void {
  if (!win || win.isDestroyed() || closing) return;
  // Idempotent: maybeClose is driven by several independent timers plus every report push, and without
  // this the fade fired (and logged) twice on the same close.
  closing = true;
  // One line saying how long the splash was up and whether the operator saw a whole report or half of
  // one. That is the difference between "the console showed everything" and "the renderer wave missed
  // its grace window", which is otherwise invisible after the fact.
  console.log(`[splash] closing after ${Date.now() - shownAt}ms — report ${reportComplete() ? 'complete' : 'PARTIAL (renderer wave missed the grace window)'}`);
  win.webContents.send(IPC.SPLASH_FADE_OUT);
  setTimeout(destroy, 240);
}

/** The editor window became visible — drop always-on-top so it can never sit above a real window. */
export function noteEditorVisible(): void {
  if (editorVisible) return; // called from all three reveal paths; the first one owns the clock
  editorVisible = true;
  if (shownAt) console.log(`[splash] editor visible at ${Date.now() - shownAt}ms`);
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(false);
  maybeClose(); // schedules its own re-check against the grace/dwell deadlines
}

export function open(): void {
  if (win && !win.isDestroyed()) return;
  editorVisible = false; completedAt = 0; closing = false; // a second open() must not inherit a stale clock
  const scale = clampUiScale(persistence.getPrefs().uiScale ?? 1);
  const area = screen.getPrimaryDisplay().workArea;
  // Clamp to the work area: at 200% UI scale on a 1366×768 laptop the design size would be larger than
  // the screen, and a splash you can't see all of is worse than none.
  const w = Math.min(Math.round(BASE_W * scale), area.width - 40);
  const h = Math.min(Math.round(BASE_H * scale), area.height - 40);

  win = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(area.x + (area.width - w) / 2),
    y: Math.round(area.y + (area.height - h) / 2),
    // surface-0. Set on the window as well as in CSS so the first paint is never a white flash.
    backgroundColor: '#0d0d0d',
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Square corners deliberately: a rounded NATIVE frame would clip the 1px border the design draws,
    // and the mismatch reads as a rendering bug rather than a rounded card.
    roundedCorners: false,
    webPreferences: {
      preload: APP_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on('closed', () => { unsubscribe?.(); unsubscribe = null; win = null; });
  // THREE ways in, exactly like the editor window, because the first one is not reliable:
  //   ready-to-show   the fast path — first paint is ready, so nothing flashes
  //   did-finish-load always fires, and is what saved the editor from the same bug
  //   a timer         for the configuration where neither arrives
  // reveal() is idempotent, so whichever wins is the only one that counts.
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);
  setTimeout(reveal, 900);
  // The zoom factor is what makes the whole document scale with the window we sized above.
  win.webContents.on('did-finish-load', () => { win?.webContents.setZoomFactor(scale); });

  // Push the report on every change. Re-sends the WHOLE report each time, so a splash that attaches
  // late (its bundle loads after main already finished activating) still renders everything.
  unsubscribe = bootReport.subscribe((r) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.SPLASH_REPORT, r);
    maybeClose();
  });

  // Absolute backstop. If the renderer never reports (a crash on boot, a project that wedges the
  // editor), the splash still goes away — it must not become the only window on screen.
  hardTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) {
      // Say WHICH kind of overrun this is. A complete report here does not mean the deadline logic
      // failed: opening a heavy project blocks the main event loop for seconds at a time (synchronous
      // HAP opens, file reads), so the dwell timer simply cannot run on schedule. The first message
      // used to claim the editor never reported even when it plainly had, which is a log that lies.
      console.warn(reportComplete()
        ? `[splash] hard deadline (${HARD_MS}ms) — the report WAS complete; the main process was too busy loading to run the close timer`
        : `[splash] hard deadline (${HARD_MS}ms) — the editor never finished reporting`);
    }
    destroy();
  }, HARD_MS);

  const devUrl = rendererDevUrl();
  if (devUrl) win.loadURL(`${devUrl}/splash.html`);
  else win.loadFile(join(__dirname, '../renderer/splash.html'));
}

/** Wire the splash's own IPC. Safe to call in every mode — it opens nothing by itself. */
export function registerSplash(): void {
  // The splash asks for the report on mount (it may have missed the pushes above), and asks to be
  // closed when the user clicks it or presses Esc.
  ipcMain.on(IPC.SPLASH_READY, () => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.SPLASH_REPORT, bootReport.get());
  });
  ipcMain.on(IPC.SPLASH_DISMISS, () => destroy());
  // The editor renderer's plugin halves — the second wave. Recorded even with no splash open: it costs
  // one array copy, and the report is then already complete if a splash ever attaches.
  ipcMain.on(IPC.SPLASH_RENDERER_REPORT, (_e, entries) => {
    const list = Array.isArray(entries) ? entries : [];
    bootReport.recordGroup('renderer', list);
    bootReport.markRendererDone();
    // Logged even with no splash open: it is the one line that says the renderer's plugin host got all
    // the way through activation, which is otherwise only visible as an absence.
    // The "at Nms" is relative to the splash appearing, so it is omitted when there is no splash —
    // headless/broadcast log this line too (the report is collected regardless) and "at -1ms" read as
    // a bug rather than as "not applicable".
    console.log(`[splash] renderer reported ${list.length} plugin(s)${shownAt ? ` at ${Date.now() - shownAt}ms` : ''}`);
  });
}
