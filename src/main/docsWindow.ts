import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { IPC } from '../../shared/protocol';
import { rendererDevUrl } from './runProfile';
import { APP_ICON } from './appIcon';

// Detached Docs & Tutorials window — a single normal framed window reusing the app preload so
// window.artlux (docsList/docsRead/openExternal/docsOpenExample) works there. Static content, so plain
// IPC is enough (no MessagePort, unlike the projector window). "Open example" is forwarded to the MAIN
// editor window so the referenced project loads there, letting the reader follow along on a 2nd screen.

const APP_PRELOAD = join(__dirname, '../preload/index.js');
let win: BrowserWindow | null = null;

function open(initialId?: string): void {
  if (win && !win.isDestroyed()) { win.focus(); return; } // singleton: focus the existing window
  win = new BrowserWindow({
    width: 820, height: 940, minWidth: 480, minHeight: 400,
    title: 'ARTLux — Docs & Tutorials',
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: APP_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.on('closed', () => { win = null; });

  const devUrl = rendererDevUrl();
  const q = initialId ? `?id=${encodeURIComponent(initialId)}` : '';
  if (devUrl) win.loadURL(`${devUrl}/docs.html${q}`);
  else win.loadFile(join(__dirname, '../renderer/docs.html'), initialId ? { query: { id: initialId } } : undefined);
}

export function registerDocsWindow(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.on(IPC.DOCS_OPEN_WINDOW, (_e, id?: string) => open(id));
  // The detached docs window asks the main editor window to load an example by absolute path — reuse
  // the existing 'open-recent:<path>' menu action, which App routes to handleOpenRecent (load + apply).
  ipcMain.on(IPC.DOCS_OPEN_EXAMPLE, (_e, absPath: string) => {
    const main = getMainWindow();
    if (!main || main.isDestroyed() || !absPath) return;
    main.webContents.send(IPC.MENU_ACTION, 'open-recent:' + absPath);
    if (main.isMinimized()) main.restore();
    main.focus();
  });
}
