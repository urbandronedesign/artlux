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

function bridge(getMain: () => BrowserWindow | null, projWin: BrowserWindow, surfaceId: string): void {
  const main = getMain();
  if (!main || main.isDestroyed() || projWin.isDestroyed()) return;
  const { port1, port2 } = new MessageChannelMain();
  main.webContents.postMessage(IPC.PROJECTOR_PORT, { surfaceId }, [port1]);
  projWin.webContents.postMessage(IPC.PROJECTOR_PORT, { surfaceId }, [port2]);
}

// Create the projector BrowserWindow: a normal movable/resizable window (windowed mode, for working
// on one screen) or a frameless fullscreen output. Wires the bridge + loads the projector renderer.
function createProjectorWindow(getMain: () => BrowserWindow | null, surfaceId: string, windowed: boolean): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const geom = windowed
    ? { x: primary.bounds.x + 80, y: primary.bounds.y + 80, width: 1280, height: 720, frame: true, skipTaskbar: false }
    : { x: primary.bounds.x, y: primary.bounds.y, width: primary.bounds.width, height: primary.bounds.height, frame: false, skipTaskbar: true };
  const win = new BrowserWindow({
    ...geom,
    backgroundColor: '#000000',
    show: false,
    title: 'ArtLux — Output',
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
  win.on('closed', () => { if (windows.get(surfaceId)?.win === win) windows.delete(surfaceId); });
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
function openProjector(getMain: () => BrowserWindow | null, surfaceId: string, displayId: number): void {
  const windowed = displayId === WINDOWED_DISPLAY;

  const existing = windows.get(surfaceId);
  if (existing && !existing.win.isDestroyed()) {
    const wasWindowed = existing.displayId === WINDOWED_DISPLAY;
    if (wasWindowed === windowed) { // same kind → just reposition (fullscreen) / leave (windowed)
      existing.displayId = displayId;
      if (!windowed) placeOnDisplay(existing.win, findDisplay(displayId) ?? screen.getPrimaryDisplay());
      return;
    }
    existing.win.destroy(); // switching between windowed ↔ fullscreen → recreate
    windows.delete(surfaceId);
  }

  const win = createProjectorWindow(getMain, surfaceId, windowed);
  windows.set(surfaceId, { win, displayId });
  if (windowed) {
    win.once('ready-to-show', () => win.showInactive());
  } else {
    const display = findDisplay(displayId) ?? screen.getPrimaryDisplay();
    win.once('ready-to-show', () => placeOnDisplay(win, findDisplay(displayId) ?? display));
  }
}

function closeProjector(surfaceId: string): void {
  const entry = windows.get(surfaceId);
  if (entry && !entry.win.isDestroyed()) entry.win.close();
  windows.delete(surfaceId);
}

export function closeAllProjectors(): void {
  for (const id of [...windows.keys()]) closeProjector(id);
}

// Wire IPC + display hot-plug watchers. Call once after app is ready.
export function registerProjectorWindows(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.PROJECTOR_LIST_DISPLAYS, () => listDisplays());
  ipcMain.on(IPC.PROJECTOR_OPEN, (_e, surfaceId: string, displayId: number) => openProjector(getMainWindow, surfaceId, displayId));
  ipcMain.on(IPC.PROJECTOR_SET_DISPLAY, (_e, surfaceId: string, displayId: number) => openProjector(getMainWindow, surfaceId, displayId));
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
