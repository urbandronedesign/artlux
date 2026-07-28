import { Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { IPC, CONTEXT_MENU_ITEMS, contextAction } from '../../shared/protocol';
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
        // Document-wide undo: the history stack now snapshots the whole authored document (fixtures,
        // surfaces, groups, scenes + their timelines, the global timeline, cue banks, the state machine,
        // audio bed, 3D scene, brightness) — one linear stack, cleared on New/Open. Controllers,
        // projector outputs and the asset library are deliberately excluded. See plans/timeline-undo.md.
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
      // Workspace contexts — same list the renderer's menu bar renders (shared/protocol.ts).
      // Accelerators are SHOWN but not registered: the rail's keydown handler owns Ctrl+1..9 so it can
      // ignore them while the operator types in a numeric field.
      label: 'Context',
      submenu: CONTEXT_MENU_ITEMS.flatMap((c): MenuItemConstructorOptions[] => [
        ...(c.sepBefore ? [{ type: 'separator' } as MenuItemConstructorOptions] : []),
        c.accel
          ? passthrough(c.label, c.accel, contextAction(c.id))
          : { label: c.label, click: () => send(contextAction(c.id)) },
      ]),
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
        // The timeline has no context of its own — it is a drawer under whichever workbench you are in.
        // Shown, not registered: the renderer's global keydown owns Ctrl+T so a rebind takes effect.
        { label: 'Timeline', accelerator: 'CmdOrCtrl+T', registerAccelerator: false, click: () => send('toggle-timeline') },
        { type: 'separator' },
        { label: 'OSC Monitor…', accelerator: 'CmdOrCtrl+Shift+M', registerAccelerator: false, click: () => send('osc-monitor') },
        { label: 'DMX Monitor', click: () => send('dmx-monitor') },
        // These five existed ONLY in the renderer's menu bar until now, so they were unreachable from
        // the native menu that owns real accelerators — and on macOS the native menu is the only menu.
        { label: 'Pose Monitor…', click: () => send('pose-monitor') },
        { label: 'Pose Floor Calibration…', click: () => send('pose-calibrate') },
        { label: 'Augmenta Monitor…', click: () => send('augmenta-monitor') },
        { label: 'Show Control…', click: () => send('show-control') },
        { label: 'Audio Bed…', click: () => send('audio-bed') },
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
        { label: 'Keyboard Shortcuts…', click: () => send('shortcuts') },
        { label: 'Docs & Tutorials', click: () => send('docs-browser') },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => send('check-updates') },
        { type: 'separator' },
        { label: 'Documentation', click: () => shell.openExternal(DOCS) },
        { label: 'GitHub Repository', click: () => shell.openExternal(REPO) },
        { type: 'separator' },
        { label: 'About ARTLux', click: () => send('about') },
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
