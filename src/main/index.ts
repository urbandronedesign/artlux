import './threadpool'; // MUST stay first — sizes the libuv pool before anything can initialise it
import { app, BrowserWindow, session, systemPreferences, ipcMain, Tray, Menu, globalShortcut, nativeTheme, dialog } from 'electron';
import { join, basename } from 'node:path';
import { registerIpc } from './ipc';
import { openEnginePort, closeEnginePort } from './enginePort';
import { buildAppMenu } from './menu';
import { setupUpdater } from './updater';
import { registerProjectorWindows, closeAllProjectors } from './projector';
import { APP_ICON } from './appIcon';
import { guardClose } from './closeGuard';
import { registerDocsWindow } from './docsWindow';
import * as splash from './splashWindow';
import { applyUiScale } from './uiScale';
import { ndiManager as ndi } from '@artlux/plugin-ndi/main'; // app lifecycle (recv cap / quit) — transitional host→plugin seam
import * as nvwarp from './nvwarpManager';
import * as metrics from './metrics';
import * as watchdog from './watchdog';
import * as persistence from './persistence';
import { profileQuery, CALIBRATION_ENABLED, rendererDevUrl, relaunchArgs, missingBuiltRenderer } from './runProfile';
import { registerMediaScheme, registerMediaProtocol } from './mediaProtocol';
import { IPC } from '../../shared/protocol';

// ⚠ MODULE SCOPE, BEFORE app.whenReady() — NOT inside it. Chromium fixes its scheme registry during
// startup: registered late, `artlux-media://` either throws or comes up without the privileges
// (`standard`/`secure`/`stream`/`supportFetch`) that make it usable at all, and the symptom is every
// video in the show silently failing to load. Guarded by npm run verify:invariants.
registerMediaScheme();

// THE SHIPPED COPY, not the repo's — and now in ONE place (./appIcon), because the editor window was
// the only window that ever set it. It used to be a local const here pointing at `../../build/icon.png`,
// which resolves in dev and NEVER in a packaged build, and the one caller that can fail wraps itself in
// a try/catch: so packaged broadcast logged "[broadcast] tray failed" and ran on with no tray icon —
// in the one mode that has no window and no menu, leaving Ctrl+Shift+Q as the operator's only way out.
// The path and the reasoning behind it now live with the constant.

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
// --new-project=<folder>: lay out that folder as a project and save a clean document into it. The
// folder is created if absent. Used by the launcher, which owns picking WHERE a project goes but
// must not own what a project IS -- that lives in the renderer's resetToNewProject().
const newProjectArg = argv.find((a) => a.startsWith('--new-project='));
const NEW_PROJECT_PATH = newProjectArg ? newProjectArg.slice('--new-project='.length) : '';
const RUN_MODE = HEADLESS ? 'headless' : BROADCAST ? 'broadcast' : 'editor';

// Single instance: a watchdog / OS-supervisor respawn (or a stray double-launch) must never run two
// copies fighting over the same Art-Net universes and displays. The primary holds the lock; a second
// launch just focuses the existing window and exits. Every relaunch site releases the lock first (see
// releaseLockForRelaunch) so a fresh process reclaims it without racing this guard.
const isPrimaryInstance = app.requestSingleInstanceLock();
app.on('second-instance', (_e, incomingArgv) => {
    if (!mainWindow) return;
    // HONOUR A --project= CARRIED BY THE SECOND LAUNCH. The incoming argv used to be discarded
    // outright, and the second process then exited 0 — so `ArtLux.exe --project=<other>` against a
    // running copy brought the existing window forward STILL SHOWING THE OLD PROJECT and reported
    // success to whoever spawned it. There is no exit code, no log line, and no window state that
    // distinguishes that from having worked. Reuses the 'open-recent:<path>' menu action App already
    // routes to handleOpenRecent (load + apply), exactly as the detached Docs window does.
    const arg = incomingArgv.find((a) => a.startsWith('--project='));
    const path = arg ? arg.slice('--project='.length) : '';
    if (path) mainWindow.webContents.send(IPC.MENU_ACTION, 'open-recent:' + path);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
});
// Drop the single-instance lock immediately before an intentional relaunch so the incoming process can
// acquire it even if this one lingers a moment during teardown.
const releaseLockForRelaunch = () => { try { app.releaseSingleInstanceLock(); } catch { /* ignore */ } };

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

// What the editor's renderer is told to do on boot. Empty -> the untitled document, exactly as
// before, so a plain launch is byte-identical.
function editorQuery(): Record<string, string> | null {
    // `--calibrate` brings the calibration workbench into an editor launch; without it the editor
    // drops the plugin entirely and its outputs stay on the cheap warp path. See main/runProfile.ts.
    const p = profileQuery();
    if (NEW_PROJECT_PATH) return { newProject: NEW_PROJECT_PATH, ...p };
    if (PROJECT_PATH) return { project: PROJECT_PATH, ...p };
    return Object.keys(p).length ? p : null;
}

/**
 * Dev-only gate in front of an operator-initiated relaunch. True = refused, caller must return.
 *
 * A relaunch out of `npm run dev` lands on the BUILT renderer (see runProfile → --built-renderer),
 * so if nobody has run `npm run build` there is nothing for the successor to load. Refusing here
 * keeps the editor the developer is standing in alive and says why; the alternative is exiting into
 * an invisible process that can never draw, which is the failure this whole path exists to end.
 * Unpackaged only — a venue never sees it, and the unattended relaunch sites never call it.
 */
function refuseRelaunchWithoutBuild(what: string): boolean {
    const missing = missingBuiltRenderer();
    if (!missing) return false;
    const msg = `Relaunching into ${what} loads the BUILT renderer, not the dev server — `
        + `electron-vite shuts the dev server down when this process exits, so the new one could `
        + `never reach it.\n\nRun "npm run build" once, then try again.\n\nMissing: ${missing}`;
    console.error(`[main] relaunch into ${what} refused — ${missing} is missing (run npm run build)`);
    dialog.showErrorBox('Build the renderer first', msg);
    return true;
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

    // GUI mode: reveal the editor window once its content is ready. We DON'T rely on ready-to-show
    // alone — on some packaged builds/GPU configs that event never fires, which left the app running
    // with no window at all (process alive, nothing on screen). So reveal on ready-to-show, again on
    // did-finish-load (which always fires — see below), and a backstop timer. show()+focus is
    // idempotent, guarded by isVisible so we only bring it up once.
    const revealEditor = () => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) { mainWindow.show(); mainWindow.focus(); }
        // The splash is only allowed to sit above windows until the editor is genuinely on screen; from
        // here it drops always-on-top and closes as soon as the boot report is complete. Called from
        // every reveal path (all three are idempotent), so a config where ready-to-show never fires
        // still hands the screen over.
        splash.noteEditorVisible();
    };
    if (!HEADLESS && !BROADCAST) {
        mainWindow.on('ready-to-show', revealEditor);
        setTimeout(revealEditor, 4000); // backstop: never leave the editor with no visible window
    }
    // Broadcast: the editor window stays invisible to the operator but must keep running at
    // full speed — it decodes the video and pushes frames to the fullscreen projector outputs.
    // A never-shown window throttles its rAF/WebGL (starving the projector → laggy output), so
    // we SHOW it but at opacity 0 + click-through + off the taskbar: the compositor keeps it
    // full-speed while nothing is visible. (Headless does pure compute and stays fully hidden.)
    //
    // THREE PATHS, for the same reason the editor above has three: ready-to-show does not always
    // fire. This one hung off that event alone, so on a build where it went missing the broadcast
    // window was never shown at all — and an unshown window is exactly the throttled state this
    // block exists to avoid, which starves the projectors it is supposed to be feeding.
    const revealBroadcast = () => {
        if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
        mainWindow.setOpacity(0);
        mainWindow.setIgnoreMouseEvents(true);
        mainWindow.setSkipTaskbar(true);
        mainWindow.showInactive();
    };
    if (BROADCAST) {
        mainWindow.on('ready-to-show', revealBroadcast);
        setTimeout(revealBroadcast, 4000); // backstop: never leave broadcast with an unshown window
    }
    // Ask the renderer before closing, so an hour of unsaved scene work is not discarded by the X.
    // Editor only: a show mode has no operator to answer and must never refuse to close.
    guardClose(mainWindow, !HEADLESS && !BROADCAST);
    mainWindow.on('closed', () => { closeAllProjectors(); closeEnginePort(); mainWindow = null; });
    // Unattended self-heal: wire the crash/hang detectors to this window. No-op unless the watchdog
    // armed itself in whenReady (unattended.enabled + broadcast/always).
    watchdog.attach(mainWindow);
    // Custom title bar: tell the renderer when maximized state flips so it swaps the maximize/restore icon.
    const emitMaximized = () => mainWindow?.webContents.send(IPC.WINDOW_MAXIMIZE_CHANGED, !!mainWindow?.isMaximized());
    mainWindow.on('maximize', emitMaximized);
    mainWindow.on('unmaximize', emitMaximized);
    // Apply the persisted (or auto-detected) UI scale. setZoomFactor doesn't survive a reload, so
    // re-run on every load. Headless/broadcast have no visible chrome, so scale is a no-op there.
    if (!HEADLESS && !BROADCAST) mainWindow.webContents.on('did-finish-load', () => { applyUiScale(mainWindow); revealEditor(); });
    // The broadcast half of the same rule. UI scale is deliberately not applied (no visible chrome),
    // but the reveal is: did-finish-load ALWAYS fires, which is what makes it the reliable path.
    if (BROADCAST) mainWindow.webContents.on('did-finish-load', revealBroadcast);

    // Hand the renderer its end of the output MessagePort on EVERY load, in every mode. On every load
    // because a reload kills the old port with the old page; in every mode because headless and
    // broadcast are precisely the runs where output matters most. The renderer relays it into the
    // frame-engine worker — see main/enginePort.ts.
    mainWindow.webContents.on('did-finish-load', () => { if (mainWindow) openEnginePort(mainWindow); });

    // Start the watchdog's clock on the renderer's FIRST heartbeat. UNGATED by mode, unlike the
    // reveal/scale handler above — broadcast is precisely the mode this exists for. Until this call,
    // 'render-stall' was armed only by a heartbeat, so a renderer that threw during its first render
    // never armed it and the install sat dead, silent and undetected. No-op unless the watchdog is
    // armed. See src/main/watchdog.ts → noteRendererUp and docs/WATCHDOG.md.
    mainWindow.webContents.on('did-finish-load', () => watchdog.noteRendererUp());

    // A LOAD THAT FAILS MUST SAY SO — every reveal path above hangs off ready-to-show or
    // did-finish-load, and NEITHER fires when the load itself fails. So a renderer that never
    // arrives leaves the process alive with no window, no output and not one log line: exactly the
    // "process alive, nothing on screen" state the reveal comments legislate against, reached from
    // the other side. The watchdog cannot cover it either — it arms on did-finish-load (see
    // noteRendererUp below), so a load that never finished never arms it.
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
        if (!isMainFrame) return;  // a subframe failing is not the app failing to boot
        if (code === -3) return;   // ERR_ABORTED: a superseded or cancelled navigation, not a failure
        console.error(`[main] RENDERER FAILED TO LOAD (${code} ${desc}) — ${url}`);
        // In a show mode the window is invisible by design, so this is otherwise completely silent:
        // the process would linger holding the metrics port, the Art-Net socket and the audio device
        // while putting nothing on any wall. Exit non-zero and let the supervisor decide. The editor
        // is left alone — its window is visible, Chromium renders its own error page, and a developer
        // can just fix the dev server rather than have the app vanish from under them.
        if (HEADLESS || BROADCAST) {
            console.error('[main] no renderer means no output — exiting rather than lingering invisibly.');
            app.exit(1);
        }
    });

    // Where the renderer comes from. NOT process.env — a relaunched process inherits a dev-server URL
    // whose server its own exit killed. runProfile.rendererDevUrl() is the single arbiter; see there.
    const devUrl = rendererDevUrl();
    if (HEADLESS) {
        // Headless boots the FULL App entry (index.html) with ?headless=1, exactly like
        // broadcast — so the plugin host + show engine + schedule tick + media playback all run.
        // App gates on HEADLESS to suppress projector/NDI output, keeping headless = hidden
        // compute + Art-Net only.
        // Calibration is implied by every show mode — a show's outputs ARE the calibrated ones.
        const query = { headless: '1', project: PROJECT_PATH, ...profileQuery() };
        if (devUrl) {
            const qs = new URLSearchParams(query).toString();
            mainWindow.loadURL(`${devUrl}/?${qs}`);
        } else {
            mainWindow.loadFile(join(__dirname, '../renderer/index.html'), { query });
        }
        console.log(`[main] headless mode — project: ${PROJECT_PATH || '(last opened)'}`);
    } else if (BROADCAST) {
        // Full App in a hidden window; it renders only the Stage and opens the saved outputs.
        const query = { broadcast: '1', project: PROJECT_PATH, ...profileQuery() };
        if (devUrl) {
            const qs = new URLSearchParams(query).toString();
            mainWindow.loadURL(`${devUrl}/?${qs}`);
        } else {
            mainWindow.loadFile(join(__dirname, '../renderer/index.html'), { query });
        }
        console.log(`[main] broadcast mode — project: ${PROJECT_PATH || '(last opened)'}`);
    } else if (devUrl) {
        // EDITOR MODE ALSO FORWARDS --project=. It did not until now: the path was parsed here, used
        // for the tray label and the watchdog's recovery target, and then silently dropped on the way
        // to the renderer — so `ArtLux.exe --project=<file>` opened an empty editor and nothing said
        // why. That matters beyond the CLI: it is the only contract an EXTERNAL program (the launcher)
        // has for "open this project", since there is no file association and no protocol handler.
        // Empty path → no query at all, so a plain launch is byte-identical to before.
        const q = editorQuery();
        mainWindow.loadURL(q ? `${devUrl}/?${new URLSearchParams(q)}` : devUrl);
    } else {
        const file = join(__dirname, '../renderer/index.html');
        const q = editorQuery();
        if (q) mainWindow.loadFile(file, { query: q });
        else mainWindow.loadFile(file);
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
        broadcastTray.setToolTip(`ARTLux Broadcast — ${label}`);
        broadcastTray.setContextMenu(Menu.buildFromTemplate([
            { label: `ARTLux Broadcast — ${label}`, enabled: false },
            { type: 'separator' },
            { label: 'Quit Broadcast', click: () => app.quit() },
        ]));
    } catch (e) {
        console.error('[broadcast] tray failed:', e);
    }
    console.log('[broadcast] tray ready — Quit from the tray or Ctrl/Cmd+Shift+Q');
}

app.whenReady().then(() => {
    // Lost the single-instance race → a copy is already running. Focus it (via 'second-instance') and bail.
    //
    // SAY SO, LOUDLY, WHEN A SHOW WAS SUPPOSED TO START. For the editor this is the designed outcome:
    // you double-clicked the app, the running copy comes forward, nothing is wrong. For broadcast or
    // headless it is a FAILURE TO START A SHOW, and it used to exit here in total silence — no window,
    // no log line, nothing to distinguish it from a broken project or a bad display config. The usual
    // cause is a stale process still holding the lock (an interrupted `npm run dev` kills the npm
    // wrapper but leaves its Electron children alive), which is invisible unless you go looking in the
    // task list. In an unattended venue that is a show that simply never comes up with nothing in the
    // log explaining why.
    if (!isPrimaryInstance) {
        if (RUN_MODE === 'editor') console.info('[artlux] another instance is already running — focusing it and exiting.');
        else console.error(`[${RUN_MODE}] ANOTHER ARTLUX INSTANCE ALREADY HOLDS THE SINGLE-INSTANCE LOCK — this ${RUN_MODE} launch is exiting WITHOUT starting the show. Kill the running artlux/electron process and relaunch.`);
        app.quit();
        return;
    }
    // Force dark UI so the native Windows menu bar (File/Edit/View/…) and other OS-drawn
    // chrome render dark instead of following the system light theme.
    nativeTheme.themeSource = 'dark';
    grantMediaPermissions();
    // Broadcast (show) mode lifts the NDI receive downscale cap to 1080p for full-HD projector
    // output; the editor keeps the lighter 720p default for preview.
    //
    // Spout has no cap to lift. It delivers the sender's texture on the GPU at whatever size the
    // sender publishes — nothing is resampled, so there is no resolution knob and no mode in which
    // the picture is preview-grade.
    if (BROADCAST) { ndi.setRecvCap(1920, 1080); }
    // The startup splash. Registered in every mode (it opens nothing by itself) but OPENED only in the
    // editor: in broadcast — the watchdog's relaunch mode — an always-on-top window would flash over
    // live fullscreen projector output, unattended, on every self-heal. Opened BEFORE registerIpc so it
    // is already loading while the main plugins activate, and so it catches their report as it fills.
    splash.registerSplash();
    if (!HEADLESS && !BROADCAST && persistence.getPrefs().showSplash !== false) splash.open();
    // The handler half of `artlux-media://` (the scheme itself was registered at module scope above).
    // Before the first window loads, so a renderer can never race it with a media request.
    registerMediaProtocol();
    registerIpc(() => mainWindow);
    metrics.start(); // Prometheus /metrics endpoint (loopback by default; ARTLUX_METRICS=0 to disable)
    if (!HEADLESS && !BROADCAST) { buildAppMenu(() => mainWindow); setupUpdater(() => mainWindow); }
    // SWITCH LAUNCH PROFILE. Calibration is not a runtime toggle (plugin activation happens once per
    // window, in the editor AND in every projector window it spawns — see runProfile.ts), so entering
    // or leaving the calibration workbench is a relaunch. Same proven mechanism as broadcast below;
    // `on` rather than `into` so one handler serves both directions.
    ipcMain.on(IPC.APP_RELAUNCH_PROFILE, (_e, on: boolean, projectPath: string) => {
        if (refuseRelaunchWithoutBuild('the calibration workbench')) return;
        const args = relaunchArgs();
        if (on) args.push('--calibrate');
        if (projectPath) args.push(`--project=${projectPath}`);
        releaseLockForRelaunch();
        app.relaunch({ args });
        app.exit(0);
    });
    ipcMain.on(IPC.APP_RELAUNCH_BROADCAST, (_e, projectPath: string) => {
        if (refuseRelaunchWithoutBuild('broadcast mode')) return;
        const args = relaunchArgs();
        args.push('--broadcast');
        if (projectPath) args.push(`--project=${projectPath}`);
        releaseLockForRelaunch();
        app.relaunch({ args });
        app.exit(0);
    });
    // Unattended self-healing watchdog. Armed only when the pref is on AND we're in broadcast (or
    // unattended.always), so it never surprises a developer in the editor. Feeds off the existing 1 Hz
    // stat plumbing (see ipc.ts). Project it recovers into: the launched project, else the last opened.
    const prefs = persistence.getPrefs();
    watchdog.start({
        mode: RUN_MODE,
        project: PROJECT_PATH || prefs.lastProjectPath || '',
        cfg: prefs.unattended,
    });
    watchdog.setEventListener((e) => mainWindow?.webContents.send(IPC.WATCHDOG_EVENT, e));
    // Broadcast only: the projector outputs are this mode's ONLY visible windows (the editor window
    // is deliberately kept at opacity 0 so its rAF stays full-speed), so closing the last one by hand
    // is the operator saying "stop" — otherwise the app lingers invisibly, still playing audio and
    // still sending Art-Net, reachable only via the tray. The editor passes no callback: closing an
    // output there must never quit. Only USER closes reach this (a display unplug or an app-initiated
    // close is excluded in projector.ts), and fullscreen outputs are frameless with no close button,
    // so a live venue output cannot trigger it.
    if (!HEADLESS) registerProjectorWindows(() => mainWindow, BROADCAST ? () => {
        console.info('[broadcast] last projector output closed by the operator — quitting.');
        app.quit();
    } : undefined);
    if (!HEADLESS) registerDocsWindow(() => mainWindow);
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
    watchdog.stop();
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
