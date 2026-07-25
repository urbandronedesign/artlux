import { app, BrowserWindow, ipcMain, screen, MessageChannelMain } from 'electron';
import type { Display } from 'electron';
import { join } from 'node:path';
import { IPC, WINDOWED_DISPLAY, type DisplayInfo } from '../../shared/protocol';

// Per-Surface fullscreen projector outputs. Each enabled output gets its own frameless,
// fullscreen BrowserWindow positioned on a chosen physical display; the surface's content
// is rendered there (independently, at native resolution) and corner-pin warped onto the
// projection. Bridged to the main window with a MessageChannelMain (one port pair each),
// mirroring the 3D Scene window pattern in main/index.ts.

const APP_PRELOAD = join(__dirname, '../preload/index.js');

// surfaceId -> open window + the display it currently targets (for hot-plug close).
const windows = new Map<string, { win: BrowserWindow; displayId: number }>();
// Windows WE are closing (reconciler, display unplug, quit, windowed↔fullscreen recreate). The
// 'closed' event can't tell who closed it, and only a USER close should be reported back to the
// renderer — reporting our own closes would disable the very output the reconciler just decided to
// move, and the two would fight. Keyed by surfaceId, cleared once 'closed' has fired.
const closingByApp = new Set<string>();
// Called when the user closes the LAST remaining output window (broadcast wires this to quit — the
// projector windows are that mode's only visible surface, so closing them all means stop). Set by
// registerProjectorWindows; undefined in the editor, where closing an output must never quit.
let onAllClosedByUser: (() => void) | undefined;

function describe(d: Display, primaryId: number): DisplayInfo {
  const res = `${d.size.width}×${d.size.height}`;
  const base = d.label && d.label.trim() ? d.label : d.internal ? `Built-in (${res})` : `Display (${res})`;
  return {
    id: d.id,
    label: `${base}${d.id === primaryId ? ' — primary' : ''}`,
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    scaleFactor: d.scaleFactor,
    primary: d.id === primaryId,
    internal: d.internal,
  };
}

function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => describe(d, primaryId));
}

const findDisplay = (id: number): Display | undefined => screen.getAllDisplays().find((d) => d.id === id);

// Position a window to fill a specific display, then go fullscreen. Order matters on
// Windows: if we fullscreen before moving, it fullscreens on whichever monitor it spawned
// on (usually the primary). showInactive() so the projector never steals editor focus.
function placeOnDisplay(win: BrowserWindow, display: Display): void {
  if (win.isFullScreen()) win.setFullScreen(false);
  const b = display.bounds;
  win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  if (!win.isVisible()) win.showInactive();
  win.setFullScreen(true);
}

// --- Windowed-output layout ---------------------------------------------------------------------
// EVERY windowed output used to be created at the same spot (primary + 80,80 at 1280×720), so with
// more than one they landed on top of each other — the OS nudges the second one a little, but at
// ~80% overlap you see one window and reasonably conclude the other never opened, or that whichever
// output is showing black is broken. Both were wrong: they were simply stacked.
//
// So lay them out to be visible AT ONCE. Only windowed outputs are touched — a fullscreen output
// owns its whole display and is placed by placeOnDisplay.
const TILE_MAX = 4;       // up to a 2×2 grid; beyond that tiles get too small to judge, so cascade
const GAP = 8;            // gutter between tiles / around the grid
const CASCADE_STEP = 48;  // classic title-bar-visible offset, so each window stays grabbable

// Largest 16:9 rect centred inside a cell — a projector preview is worth judging at the right shape
// rather than stretched to whatever the grid cell happens to be.
function fit169(x: number, y: number, w: number, h: number): { x: number; y: number; width: number; height: number } {
  const width = Math.max(320, Math.min(w, Math.floor((h * 16) / 9)));
  const height = Math.floor((width * 9) / 16);
  return { x: Math.round(x + (w - width) / 2), y: Math.round(y + (h - height) / 2), width, height };
}

// Re-lay every open windowed output. Called when one is ADDED (not when one closes, and never on a
// drag) so the layout is predictable: it settles once and then leaves your manual positioning alone
// until the set of outputs actually changes again.
function layoutWindowedOutputs(): void {
  const wins = [...windows.values()].filter((e) => e.displayId === WINDOWED_DISPLAY && !e.win.isDestroyed());
  const n = wins.length;
  if (n === 0) return;
  const wa = screen.getPrimaryDisplay().workArea;

  // A single output keeps the familiar free-floating 1280×720 — tiling one window to fill the
  // screen would just bury the editor behind it.
  if (n === 1) {
    const width = Math.min(1280, wa.width - 2 * CASCADE_STEP);
    const height = Math.floor((width * 9) / 16);
    wins[0].win.setBounds({ x: wa.x + CASCADE_STEP, y: wa.y + CASCADE_STEP, width, height });
    return;
  }

  if (n <= TILE_MAX) {
    const cols = 2;
    const rows = Math.ceil(n / cols);
    const cellW = Math.floor((wa.width - GAP * (cols + 1)) / cols);
    const cellH = Math.floor((wa.height - GAP * (rows + 1)) / rows);
    wins.forEach((e, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      e.win.setBounds(fit169(wa.x + GAP + c * (cellW + GAP), wa.y + GAP + r * (cellH + GAP), cellW, cellH));
    });
    return;
  }

  // More outputs than tiles are worth: cascade, wrapping before we march off the work area.
  const width = Math.min(960, wa.width - 2 * CASCADE_STEP);
  const height = Math.floor((width * 9) / 16);
  const perWrap = Math.max(1, Math.floor((wa.height - height - CASCADE_STEP) / CASCADE_STEP));
  wins.forEach((e, i) => {
    const k = i % perWrap;
    e.win.setBounds({ x: wa.x + CASCADE_STEP + k * CASCADE_STEP, y: wa.y + CASCADE_STEP + k * CASCADE_STEP, width, height });
  });
}

function bridge(getMain: () => BrowserWindow | null, projWin: BrowserWindow, surfaceId: string): void {
  const main = getMain();
  if (!main || main.isDestroyed() || projWin.isDestroyed()) return;
  const { port1, port2 } = new MessageChannelMain();
  main.webContents.postMessage(IPC.PROJECTOR_PORT, { surfaceId }, [port1]);
  projWin.webContents.postMessage(IPC.PROJECTOR_PORT, { surfaceId }, [port2]);
}

// Create the projector BrowserWindow: a normal movable/resizable window (windowed mode, for working
// on one screen) or a frameless fullscreen output. Wires the bridge + loads the projector renderer.
function createProjectorWindow(getMain: () => BrowserWindow | null, surfaceId: string, windowed: boolean, notifyClosed: (id: string) => void): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const geom = windowed
    ? { x: primary.bounds.x + 80, y: primary.bounds.y + 80, width: 1280, height: 720, frame: true, skipTaskbar: false }
    : { x: primary.bounds.x, y: primary.bounds.y, width: primary.bounds.width, height: primary.bounds.height, frame: false, skipTaskbar: true };
  const win = new BrowserWindow({
    ...geom,
    backgroundColor: '#000000',
    show: false,
    title: 'ARTLux — Output',
    webPreferences: {
      preload: APP_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Never throttle: this is a live projection output.
      backgroundThrottling: false,
    },
  });
  if (windowed) win.setMenuBarVisibility(false);
  win.on('closed', () => {
    if (windows.get(surfaceId)?.win === win) windows.delete(surfaceId);
    // Only a USER close is reported — see closingByApp. A windowed output has an X button; a
    // fullscreen one is frameless, so in a venue this path is effectively unreachable.
    const byApp = closingByApp.delete(surfaceId);
    if (byApp) return;
    notifyClosed(surfaceId);
    // Closing the LAST output by hand is the operator saying "stop". `windows` was pruned just
    // above, so an empty map here means nothing is left on screen. Only app-initiated closes are
    // excluded, so a display unplug or an app quit can never reach this.
    if (windows.size === 0) onAllClosedByUser?.();
  });
  // Bridge once the projector renderer is loaded (the port is buffered by its preload
  // until the renderer signals readiness, so racing the handshake is safe).
  win.webContents.once('did-finish-load', () => bridge(getMain, win, surfaceId));

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const query = { surfaceId };
  if (devUrl) win.loadURL(`${devUrl}/projector.html?${new URLSearchParams(query).toString()}`);
  else win.loadFile(join(__dirname, '../renderer/projector.html'), { query });
  return win;
}

// Open (or move) a surface's projector window. displayId === WINDOWED_DISPLAY → a movable window on
// the primary screen; otherwise a fullscreen output on that physical display.
function openProjector(getMain: () => BrowserWindow | null, surfaceId: string, displayId: number, notifyClosed: (id: string) => void): void {
  const windowed = displayId === WINDOWED_DISPLAY;

  const existing = windows.get(surfaceId);
  if (existing && !existing.win.isDestroyed()) {
    const wasWindowed = existing.displayId === WINDOWED_DISPLAY;
    if (wasWindowed === windowed) { // same kind → just reposition (fullscreen) / leave (windowed)
      existing.displayId = displayId;
      if (!windowed) placeOnDisplay(existing.win, findDisplay(displayId) ?? screen.getPrimaryDisplay());
      return;
    }
    closingByApp.add(surfaceId); // our own recreate, not the user closing the output
    existing.win.destroy(); // switching between windowed ↔ fullscreen → recreate
    windows.delete(surfaceId);
  }

  const win = createProjectorWindow(getMain, surfaceId, windowed, notifyClosed);
  windows.set(surfaceId, { win, displayId });
  if (windowed) {
    // Re-lay ALL windowed outputs now this one has joined, so they never open stacked on each other.
    // After 'ready-to-show' rather than immediately: showInactive() on Windows can nudge a window's
    // position, so the layout has to be the last thing applied or it gets partly undone.
    win.once('ready-to-show', () => { win.showInactive(); layoutWindowedOutputs(); });
  } else {
    const display = findDisplay(displayId) ?? screen.getPrimaryDisplay();
    win.once('ready-to-show', () => placeOnDisplay(win, findDisplay(displayId) ?? display));
  }
}

function closeProjector(surfaceId: string): void {
  const entry = windows.get(surfaceId);
  if (entry && !entry.win.isDestroyed()) {
    closingByApp.add(surfaceId); // app-initiated — don't report this back as a user close
    entry.win.close();
  }
  windows.delete(surfaceId);
}

export function closeAllProjectors(): void {
  for (const id of [...windows.keys()]) closeProjector(id);
}

// Wire IPC + display hot-plug watchers. Call once after app is ready.
export function registerProjectorWindows(getMainWindow: () => BrowserWindow | null, onLastOutputClosedByUser?: () => void): void {
  onAllClosedByUser = onLastOutputClosedByUser;
  // Tell the renderer a user closed an output, so it can drop its bookkeeping and mark the output
  // disabled instead of believing a dead window is still live.
  const notifyClosed = (surfaceId: string): void => {
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send(IPC.PROJECTOR_CLOSED, surfaceId);
  };
  ipcMain.handle(IPC.PROJECTOR_LIST_DISPLAYS, () => listDisplays());
  ipcMain.on(IPC.PROJECTOR_OPEN, (_e, surfaceId: string, displayId: number) => openProjector(getMainWindow, surfaceId, displayId, notifyClosed));
  ipcMain.on(IPC.PROJECTOR_SET_DISPLAY, (_e, surfaceId: string, displayId: number) => openProjector(getMainWindow, surfaceId, displayId, notifyClosed));
  ipcMain.on(IPC.PROJECTOR_CLOSE, (_e, surfaceId: string) => closeProjector(surfaceId));

  const notify = () => {
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send(IPC.PROJECTOR_DISPLAYS_CHANGED, listDisplays());
  };

  screen.on('display-added', notify);
  screen.on('display-metrics-changed', notify);
  screen.on('display-removed', (_e, removed: Display) => {
    // A projector on a now-gone display can't be shown — close it. The renderer reconciler
    // (keyed on the refreshed display list) clears the stale displayId in app state.
    for (const [surfaceId, entry] of windows) {
      if (entry.displayId === removed.id) closeProjector(surfaceId);
    }
    notify();
  });

  app.on('before-quit', () => closeAllProjectors());
}
