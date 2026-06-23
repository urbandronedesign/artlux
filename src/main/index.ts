import { app, BrowserWindow, session, systemPreferences, ipcMain, MessageChannelMain, Tray, Menu, globalShortcut } from 'electron';
import { join, basename } from 'node:path';
import { registerIpc } from './ipc';
import { buildAppMenu } from './menu';
import { setupUpdater } from './updater';
import { registerProjectorWindows, closeAllProjectors } from './projector';
import { IPC } from '../../shared/protocol';

const APP_ICON = join(__dirname, '../../build/icon.png');

let mainWindow: BrowserWindow | null = null;
let sceneWindow: BrowserWindow | null = null;
let broadcastTray: Tray | null = null;

// --headless [--project=<path>]: run only the Stage compute + output loop in an
// invisible, GPU-backed window (no UI/3D/monitor) to minimize compute.
// --broadcast [--project=<path>]: show mode — hidden editor, fullscreen projector outputs
// + Art-Net only, controlled from a tray icon / global hotkey.
const argv = process.argv.slice(1);
const HEADLESS = argv.includes('--headless');
const BROADCAST = argv.includes('--broadcast');
const projectArg = argv.find((a) => a.startsWith('--project='));
const PROJECT_PATH = projectArg ? projectArg.slice('--project='.length) : '';

// Keep renderers full-speed even when unfocused/occluded — this is a live tool with two
// windows (main mapping + 3D Scene), so the compositing loop, video playback, and DMX
// output must not be throttled when the other window has focus.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 640,
        backgroundColor: '#000000',
        show: false,
        icon: APP_ICON,
        autoHideMenuBar: HEADLESS || BROADCAST, // GUI shows the native menu bar; headless/broadcast hide it
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // Never throttle: the engine + timeline must run when the Scene window has focus.
            backgroundThrottling: false,
        },
    });

    // GUI mode shows when ready; headless + broadcast keep the editor window invisible.
    if (!HEADLESS && !BROADCAST) mainWindow.on('ready-to-show', () => mainWindow?.show());
    mainWindow.on('closed', () => { closeAllProjectors(); mainWindow = null; });

    // electron-vite provides the dev server URL; fall back to the built file.
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (HEADLESS) {
        const query = { headless: '1', project: PROJECT_PATH };
        if (devUrl) {
            const qs = new URLSearchParams(query).toString();
            mainWindow.loadURL(`${devUrl}/headless.html?${qs}`);
        } else {
            mainWindow.loadFile(join(__dirname, '../renderer/headless.html'), { query });
        }
        console.log(`[main] headless mode — project: ${PROJECT_PATH || '(last opened)'}`);
    } else if (BROADCAST) {
        // Full App in a hidden window; it renders only the Stage and opens the saved outputs.
        const query = { broadcast: '1', project: PROJECT_PATH };
        if (devUrl) {
            const qs = new URLSearchParams(query).toString();
            mainWindow.loadURL(`${devUrl}/?${qs}`);
        } else {
            mainWindow.loadFile(join(__dirname, '../renderer/index.html'), { query });
        }
        console.log(`[main] broadcast mode — project: ${PROJECT_PATH || '(last opened)'}`);
    } else if (devUrl) {
        mainWindow.loadURL(devUrl);
    } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }
}

// The 3D Scene runs in its own window (second monitor). It needs live state + the
// per-LED pixel stream from the main window and sends edits back, so we bridge the two
// renderers with a MessageChannelMain: each gets one port and they talk directly.
function bridgeSceneToMain(): void {
    if (!mainWindow || !sceneWindow) return;
    const { port1, port2 } = new MessageChannelMain();
    mainWindow.webContents.postMessage(IPC.SCENE_PORT, null, [port1]);
    sceneWindow.webContents.postMessage(IPC.SCENE_PORT, null, [port2]);
}

function createSceneWindow(): void {
    if (sceneWindow && !sceneWindow.isDestroyed()) { sceneWindow.focus(); return; }
    sceneWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        backgroundColor: '#0d0d0d',
        title: 'ArtLux — 3D Scene',
        icon: APP_ICON,
        autoHideMenuBar: true,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
        },
    });
    sceneWindow.on('closed', () => { sceneWindow = null; });
    // Re-bridge once the scene renderer is ready to receive the port.
    sceneWindow.webContents.once('did-finish-load', () => bridgeSceneToMain());

    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl) sceneWindow.loadURL(`${devUrl}/scene.html`);
    else sceneWindow.loadFile(join(__dirname, '../renderer/scene.html'));
}

// Live-input surfaces (Camera / mic) call getUserMedia in the renderer. Electron denies
// 'media' permission unless the main process grants it, so wire both handlers.
function grantMediaPermissions(): void {
    const MEDIA = new Set(['media', 'camera', 'microphone', 'audioCapture', 'videoCapture']);
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(MEDIA.has(permission));
    });
    ses.setPermissionCheckHandler((_wc, permission) => MEDIA.has(permission));
    // macOS additionally gates camera/mic at the OS level.
    if (process.platform === 'darwin') {
        systemPreferences.askForMediaAccess('camera').catch(() => {});
    }
}

// Broadcast mode has no editor window — give the operator a tray icon + global hotkey to quit.
function setupBroadcastControls(): void {
    const label = PROJECT_PATH ? basename(PROJECT_PATH) : '(last project)';
    try {
        broadcastTray = new Tray(APP_ICON);
        broadcastTray.setToolTip(`ArtLux Broadcast — ${label}`);
        broadcastTray.setContextMenu(Menu.buildFromTemplate([
            { label: `ArtLux Broadcast — ${label}`, enabled: false },
            { type: 'separator' },
            { label: 'Quit Broadcast', click: () => app.quit() },
        ]));
    } catch (e) {
        console.error('[broadcast] tray failed:', e);
    }
    console.log('[broadcast] tray ready — Quit from the tray or Ctrl/Cmd+Shift+Q');
}

app.whenReady().then(() => {
    grantMediaPermissions();
    registerIpc(() => mainWindow);
    if (!HEADLESS && !BROADCAST) { buildAppMenu(() => mainWindow); setupUpdater(() => mainWindow); }
    ipcMain.on(IPC.SCENE_OPEN, () => { if (!HEADLESS && !BROADCAST) createSceneWindow(); });
    ipcMain.on(IPC.APP_RELAUNCH_BROADCAST, (_e, projectPath: string) => {
        // app.relaunch replaces argv. When unpacked (dev), argv is [electron, appPath, …flags],
        // so we must re-pass the app path or Electron relaunches with no app (the welcome screen).
        const args = app.isPackaged ? [] : [app.getAppPath()];
        args.push('--broadcast');
        if (projectPath) args.push(`--project=${projectPath}`);
        app.relaunch({ args });
        app.exit(0);
    });
    if (!HEADLESS) registerProjectorWindows(() => mainWindow);
    // One consistent, always-available quit for both editor and broadcast modes — works even
    // when a frameless fullscreen projector window is focused (no reachable menu there).
    if (!HEADLESS) globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
    if (BROADCAST) setupBroadcastControls();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    broadcastTray?.destroy();
    broadcastTray = null;
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
