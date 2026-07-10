import { Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { IPC } from '../../shared/protocol';
import * as persistence from './persistence';

// Native application menu. Renderer-bound commands (save/open/undo/about/…) are
// sent over IPC.MENU_ACTION to the focused window, where App.tsx dispatches them
// to the existing handlers. Built-in editing/view items use Electron roles.

const REPO = 'https://github.com/urbandronedesign/artlux';
const DOCS = `${REPO}/blob/main/docs/FEATURES.md`;

let getWindowRef: (() => BrowserWindow | null) | null = null;

function send(action: string): void {
  getWindowRef?.()?.webContents.send(IPC.MENU_ACTION, action);
}

// Accelerator shown but not registered by the menu, so the renderer's own keydown
// handler owns the shortcut (avoids double-firing project undo/redo).
const passthrough = (label: string, accelerator: string, action: string): MenuItemConstructorOptions => ({
  label, accelerator, registerAccelerator: false, click: () => send(action),
});

function template(): MenuItemConstructorOptions[] {
  const recents = persistence.getPrefs().recentFiles ?? [];
  const recentItems: MenuItemConstructorOptions[] = recents.length
    ? recents.slice(0, 10).map((p) => ({ label: p, click: () => send(`open-recent:${p}`) }))
    : [{ label: 'No recent files', enabled: false }];

  return [
    {
      label: 'File',
      submenu: [
        { label: 'New Project…', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: 'Open Project Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('open-project-folder') },
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { label: 'Collect Assets…', click: () => send('collect-assets') },
        { label: 'Collect a Copy to Folder…', click: () => send('collect-copy') },
        { type: 'separator' },
        { label: 'Export Rig…', click: () => send('export-rig') },
        { label: 'Import Rig…', click: () => send('import-rig') },
        { type: 'separator' },
        { label: 'Routing…', click: () => send('routing') },
        { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => send('preferences') },
        { type: 'separator' },
        { label: 'Launch in Broadcast Mode', click: () => send('broadcast') },
        { type: 'separator' },
        // Accelerator shown for discoverability; the real handler is the global shortcut
        // registered in main (so it also works from a focused fullscreen projector window).
        { role: 'quit', accelerator: 'CmdOrCtrl+Shift+Q', registerAccelerator: false },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        passthrough('Undo', 'CmdOrCtrl+Z', 'undo'),
        passthrough('Redo', 'CmdOrCtrl+Shift+Z', 'redo'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        // Direct calls on the tracked window — the built-in 'reload'/'toggleDevTools' roles
        // route through Electron's getFocusedWebContents(), which throws in this build
        // ("getAllWebContents is not a function") and crashes the main process.
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => getWindowRef?.()?.webContents.reload() },
        { label: 'Toggle Developer Tools', accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => getWindowRef?.()?.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'OSC Monitor…', accelerator: 'CmdOrCtrl+Shift+M', registerAccelerator: false, click: () => send('osc-monitor') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    {
      label: 'Help',
      submenu: [
        { label: 'Help Panel', accelerator: 'F1', click: () => send('help-panel') },
        { label: 'Docs & Tutorials', click: () => send('docs-browser') },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => send('check-updates') },
        { type: 'separator' },
        { label: 'Documentation', click: () => shell.openExternal(DOCS) },
        { label: 'GitHub Repository', click: () => shell.openExternal(REPO) },
        { type: 'separator' },
        { label: 'About ArtLux', click: () => send('about') },
      ],
    },
  ];
}

export function buildAppMenu(getWindow: () => BrowserWindow | null): void {
  getWindowRef = getWindow;
  rebuildAppMenu();
}

// Rebuild (e.g. after a save/open changes the recent-files list).
export function rebuildAppMenu(): void {
  if (!getWindowRef) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(template()));
}
