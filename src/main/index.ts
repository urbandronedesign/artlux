import { app, BrowserWindow, session, systemPreferences, ipcMain, Tray, Menu, globalShortcut, nativeTheme } from 'electron';
import { join, basename } from 'node:path';
import { registerIpc } from './ipc';
import { buildAppMenu } from './menu';
import { setupUpdater } from './updater';
import { registerProjectorWindows, closeAllProjectors } from './projector';
import { ndiManager as ndi } from '@artlux/plugin-ndi/main'; // app lifecycle (recv cap / quit) — transitional host→plugin seam
import * as nvwarp from './nvwarpManager';
import * as spout from './transport/spoutManager';
import * as metrics from './metrics';
import { IPC } from '../../shared/protocol';

const APP_ICON = join(__dirname, '../../build/icon.png');

let mainWindow: BrowserWindow | null = null;
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
// On Windows, Chromium's native window-occlusion calculation marks a covered window
// "hidden" and pauses its video frame production (the media clock keeps ticking, so the
// frame goes stale) even with the throttling switches above. The main window decodes the
// video that the Scene + projector windows mirror, so when the Scene window covers it the
// mirrors freeze. Disabling the feature keeps the covered window producing frames.
const disabledFeatures = ['CalculateNativeWinOcclusion'];
// Opt-in: revert Chromium's Windows camera backend from Media Foundation to the legacy
// DirectShow capture path. Needed for cameras exposed only as a DirectShow *source filter*
// (e.g. the PS3 Eye via the PS3EyeDirectShow driver) — Media Foundation ignores those, so
// getUserMedia/the calibration wizard can't see them otherwise. Off by default because it's
// a global backend switch; enable with ARTLUX_DSHOW_CAPTURE=1 when using such a camera.
if (process.env.ARTLUX_DSHOW_CAPTURE === '1') {
    disabledFeatures.push('MediaFoundationVideoCapture');
}
app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));

// Dev-only: enable the Chromium remote-debugging (CDP) endpoint so the documentation
// screenshot harness (scripts/capture-docs.cjs) can attach and drive the UI. Off unless
// ARTLUX_CDP_PORT is set — no effect on normal runs or packaged builds.
if (process.env.ARTLUX_CDP_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.ARTLUX_CDP_PORT);
    app.commandLine.appendSwitch('remote-allow-origins', '*');
}

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 640,
        backgroundColor: '#000000',
        show: false,
        icon: APP_ICON,
        // Frameless: the editor draws its own title bar (logo + menus + window controls) in the
        // renderer (components/MenuBar.tsx). The native application menu is still registered (see
        // buildAppMenu) so all keyboard accelerators keep working even with no native menu bar shown.
        frame: false,
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

    // GUI mode shows when ready.
    if (!HEADLESS && !BROADCAST) mainWindow.on('ready-to-show', () => mainWindow?.show());
    // Broadcast: the editor window stays invisible to the operator but must keep running at
    // full speed — it decodes the video and pushes frames to the fullscreen projector outputs.
    // A never-shown window throttles its rAF/WebGL (starving the projector → laggy output), so
    // we SHOW it but at opacity 0 + click-through + off the taskbar: the compositor keeps it
    // full-speed while nothing is visible. (Headless does pure compute and stays fully hidden.)
    if (BROADCAST) mainWindow.on('ready-to-show', () => {
        mainWindow?.setOpacity(0);
        mainWindow?.setIgnoreMouseEvents(true);
        mainWindow?.setSkipTaskbar(true);
        mainWindow?.showInactive();
    });
    mainWindow.on('closed', () => { closeAllProjectors(); mainWindow = null; });
    // Custom title bar: tell the renderer when maximized state flips so it swaps the maximize/restore icon.
    const emitMaximized = () => mainWindow?.webContents.send(IPC.WINDOW_MAXIMIZE_CHANGED, !!mainWindow?.isMaximized());
    mainWindow.on('maximize', emitMaximized);
    mainWindow.on('unmaximize', emitMaximized);

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
    // Force dark UI so the native Windows menu bar (File/Edit/View/…) and other OS-drawn
    // chrome render dark instead of following the system light theme.
    nativeTheme.themeSource = 'dark';
    grantMediaPermissions();
    // Broadcast (show) mode lifts the Spout/NDI receive downscale caps to 1080p for full-HD
    // projector output + NDI; the editor keeps the lighter defaults (512² / 720p) for preview.
    if (BROADCAST) { ndi.setRecvCap(1920, 1080); spout.setCap(1920, 1080); }
    registerIpc(() => mainWindow);
    metrics.start(); // Prometheus /metrics endpoint (loopback by default; ARTLUX_METRICS=0 to disable)
    if (!HEADLESS && !BROADCAST) { buildAppMenu(() => mainWindow); setupUpdater(() => mainWindow); }
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
    metrics.stop();
    globalShortcut.unregisterAll();
    broadcastTray?.destroy();
    broadcastTray = null;
    ndi.stopAllSenders();
    ndi.stopRecv();
    nvwarp.clearAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
