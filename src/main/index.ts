import { app, BrowserWindow, session, systemPreferences } from 'electron';
import { join } from 'node:path';
import { registerIpc } from './ipc';
import { buildAppMenu } from './menu';
import { setupUpdater } from './updater';

const APP_ICON = join(__dirname, '../../build/icon.png');

let mainWindow: BrowserWindow | null = null;

// --headless [--project=<path>]: run only the Stage compute + output loop in an
// invisible, GPU-backed window (no UI/3D/monitor) to minimize compute.
const argv = process.argv.slice(1);
const HEADLESS = argv.includes('--headless');
const projectArg = argv.find((a) => a.startsWith('--project='));
const PROJECT_PATH = projectArg ? projectArg.slice('--project='.length) : '';

// Keep the renderer process full-speed even when the window is hidden/occluded.
if (HEADLESS) app.commandLine.appendSwitch('disable-renderer-backgrounding');

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 640,
        backgroundColor: '#000000',
        show: false,
        icon: APP_ICON,
        autoHideMenuBar: HEADLESS, // GUI shows the native menu bar; headless hides it
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // Hidden headless window must not be throttled by Chromium.
            backgroundThrottling: !HEADLESS,
        },
    });

    // GUI mode shows when ready; headless stays invisible.
    if (!HEADLESS) mainWindow.on('ready-to-show', () => mainWindow?.show());
    mainWindow.on('closed', () => { mainWindow = null; });

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
    } else if (devUrl) {
        mainWindow.loadURL(devUrl);
    } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }
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

app.whenReady().then(() => {
    grantMediaPermissions();
    registerIpc(() => mainWindow);
    if (!HEADLESS) { buildAppMenu(() => mainWindow); setupUpdater(() => mainWindow); }
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
