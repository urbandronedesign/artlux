import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
    IPC, type OutputConfig, type OutputStats, type InputConfig, type InputFrame, type ArtluxApi,
    type ProjectData, type RigData, type Prefs, type UpdateEvent,
    type DisplayInfo, type OscConfig, type OscMessage,
    type WindowCommand, type RenderStats, type WatchdogEvent, type RendererFault,
    type BootEntry, type BootReport,
} from '../../shared/protocol';

const api: ArtluxApi = {
    configureOutput: (cfg: OutputConfig) => ipcRenderer.send(IPC.CONFIGURE, cfg),
    sendArtNet: (frame: ArrayBuffer) => ipcRenderer.send(IPC.FRAME, frame),
    onStatus: (cb: (connected: boolean) => void) => {
        const listener = (_e: unknown, connected: boolean) => cb(connected);
        ipcRenderer.on(IPC.STATUS, listener);
        return () => { ipcRenderer.removeListener(IPC.STATUS, listener); };
    },
    onDmxStats: (cb: (stats: OutputStats) => void) => {
        const listener = (_e: unknown, stats: OutputStats) => cb(stats);
        ipcRenderer.on(IPC.STATS, listener);
        return () => { ipcRenderer.removeListener(IPC.STATS, listener); };
    },
    reportRenderStats: (stats: RenderStats) => ipcRenderer.send(IPC.RENDER_STATS, stats),
    // The white-screen channel. Deliberately `send` and not `invoke`: the reporter is called from a
    // React error boundary and from window.onerror, i.e. from a tree that is already failing — an
    // awaited round-trip there is one more thing that can throw.
    reportRendererFault: (fault: RendererFault) => ipcRenderer.send(IPC.RENDERER_FAULT, fault),
    configureInput: (cfg: InputConfig) => ipcRenderer.send(IPC.INPUT_CONFIGURE, cfg),
    onDmxInput: (cb: (frames: InputFrame[]) => void) => {
        const listener = (_e: unknown, frames: InputFrame[]) => cb(frames);
        ipcRenderer.on(IPC.INPUT_FRAME, listener);
        return () => { ipcRenderer.removeListener(IPC.INPUT_FRAME, listener); };
    },
    // Persistence
    saveProject: (data: ProjectData, path?: string) => ipcRenderer.invoke(IPC.PROJECT_SAVE, data, path),
    openProject: () => ipcRenderer.invoke(IPC.PROJECT_OPEN),
    loadProjectPath: (path: string) => ipcRenderer.invoke(IPC.PROJECT_LOAD_PATH, path),
    newProjectFolder: () => ipcRenderer.invoke(IPC.PROJECT_NEW_FOLDER),
    prepareProjectFolder: (root: string) => ipcRenderer.invoke(IPC.PROJECT_PREPARE_FOLDER, root),
    openProjectFolder: () => ipcRenderer.invoke(IPC.PROJECT_OPEN_FOLDER),
    collectAssets: (projectFile: string, data: ProjectData) => ipcRenderer.invoke(IPC.PROJECT_COLLECT_ASSETS, projectFile, data),
    collectAssetsTo: (data: ProjectData) => ipcRenderer.invoke(IPC.PROJECT_COLLECT_TO, data),
    exportRig: (rig: RigData) => ipcRenderer.invoke(IPC.RIG_EXPORT, rig),
    importRig: () => ipcRenderer.invoke(IPC.RIG_IMPORT),
    getPrefs: () => ipcRenderer.invoke(IPC.PREFS_GET),
    setPrefs: (patch: Partial<Prefs>) => ipcRenderer.invoke(IPC.PREFS_SET, patch),
    setUiScale: (scale: number) => ipcRenderer.invoke(IPC.UI_SCALE_SET, scale),
    detectUiScale: () => ipcRenderer.invoke(IPC.UI_SCALE_DETECT),
    discoverDevices: () => ipcRenderer.invoke(IPC.ARTNET_DISCOVER),
    // Spout + NDI moved to their plugins (@artlux/plugin-spout / -ndi) — they use the generic
    // pluginInvoke/Send/On bridge below.
    // OSC (external control + LiDAR tracking)
    configureOsc: (cfg: OscConfig) => ipcRenderer.send(IPC.OSC_CONFIGURE, cfg),
    onOscMessage: (cb: (msgs: OscMessage[]) => void) => {
        const listener = (_e: unknown, msgs: OscMessage[]) => cb(msgs);
        ipcRenderer.on(IPC.OSC_MESSAGE, listener);
        return () => { ipcRenderer.removeListener(IPC.OSC_MESSAGE, listener); };
    },
    sendOsc: (host: string, port: number, address: string, args: (number | string)[]) =>
        ipcRenderer.send(IPC.OSC_SEND, host, port, address, args),
    listLocalAddrs: () => ipcRenderer.invoke(IPC.OSC_LOCAL_ADDRS),
    // HAP video + projector calibration moved to their plugins (generic pluginInvoke/Send bridge).
    // NVAPI scanout warp/blend
    nvwarpAvailable: () => ipcRenderer.invoke(IPC.NVWARP_AVAILABLE),
    nvwarpSetWarp: (electronDisplayId: number, verts: number[], src: number[]) =>
        ipcRenderer.invoke(IPC.NVWARP_SET_WARP, electronDisplayId, verts, src),
    nvwarpSetIntensity: (electronDisplayId: number, w: number, h: number, rgb: number[]) =>
        ipcRenderer.invoke(IPC.NVWARP_SET_INTENSITY, electronDisplayId, w, h, rgb),
    nvwarpClear: (electronDisplayId: number) => ipcRenderer.send(IPC.NVWARP_CLEAR, electronDisplayId),
    // MPCDI interchange
    exportMpcdi: (regions: unknown[]) => ipcRenderer.invoke(IPC.MPCDI_EXPORT, regions),
    importMpcdi: (path?: string) => ipcRenderer.invoke(IPC.MPCDI_IMPORT, path),
    // App chrome
    onMenuAction: (cb: (action: string) => void) => {
        const listener = (_e: unknown, action: string) => cb(action);
        ipcRenderer.on(IPC.MENU_ACTION, listener);
        return () => { ipcRenderer.removeListener(IPC.MENU_ACTION, listener); };
    },
    getAppInfo: () => ipcRenderer.invoke(IPC.APP_INFO),
    openExternal: (url: string) => ipcRenderer.send(IPC.OPEN_EXTERNAL, url),
    // Startup splash. The splash window loads THIS preload (like the docs window), so its three
    // methods live here rather than in a second bridge.
    reportBootStatus: (entries: BootEntry[]) => ipcRenderer.send(IPC.SPLASH_RENDERER_REPORT, entries),
    splashReady: () => ipcRenderer.send(IPC.SPLASH_READY),
    onBootReport: (cb: (r: BootReport) => void) => {
        const listener = (_e: unknown, report: BootReport) => cb(report);
        ipcRenderer.on(IPC.SPLASH_REPORT, listener);
        return () => { ipcRenderer.removeListener(IPC.SPLASH_REPORT, listener); };
    },
    splashDismiss: () => ipcRenderer.send(IPC.SPLASH_DISMISS),
    onSplashFadeOut: (cb: () => void) => {
        const listener = () => cb();
        ipcRenderer.on(IPC.SPLASH_FADE_OUT, listener);
        return () => { ipcRenderer.removeListener(IPC.SPLASH_FADE_OUT, listener); };
    },
    relaunchBroadcast: (projectPath: string) => ipcRenderer.send(IPC.APP_RELAUNCH_BROADCAST, projectPath),
    relaunchWithCalibration: (on: boolean, projectPath: string) => ipcRenderer.send(IPC.APP_RELAUNCH_PROFILE, on, projectPath),
    // Unattended watchdog (self-healing for broadcast/show installs)
    getWatchdogStatus: () => ipcRenderer.invoke(IPC.WATCHDOG_STATUS),
    installWatchdogTask: () => ipcRenderer.invoke(IPC.WATCHDOG_INSTALL_TASK),
    uninstallWatchdogTask: () => ipcRenderer.invoke(IPC.WATCHDOG_UNINSTALL_TASK),
    onWatchdogEvent: (cb: (e: WatchdogEvent) => void) => {
        const listener = (_e: unknown, evt: WatchdogEvent) => cb(evt);
        ipcRenderer.on(IPC.WATCHDOG_EVENT, listener);
        return () => { ipcRenderer.removeListener(IPC.WATCHDOG_EVENT, listener); };
    },
    // Custom title bar (frameless window)
    windowCommand: (cmd: WindowCommand) => ipcRenderer.send(IPC.WINDOW_COMMAND, cmd),
    isWindowMaximized: () => ipcRenderer.invoke(IPC.WINDOW_IS_MAXIMIZED),
    onWindowMaximizeChanged: (cb: (maximized: boolean) => void) => {
        const listener = (_e: unknown, maximized: boolean) => cb(maximized);
        ipcRenderer.on(IPC.WINDOW_MAXIMIZE_CHANGED, listener);
        return () => { ipcRenderer.removeListener(IPC.WINDOW_MAXIMIZE_CHANGED, listener); };
    },
    // Auto-update
    checkForUpdates: () => ipcRenderer.send(IPC.UPDATE_CHECK),
    downloadUpdate: () => ipcRenderer.send(IPC.UPDATE_DOWNLOAD),
    installUpdate: () => ipcRenderer.send(IPC.UPDATE_INSTALL),
    onUpdate: (cb: (e: UpdateEvent) => void) => {
        const listener = (_e: unknown, evt: UpdateEvent) => cb(evt);
        ipcRenderer.on(IPC.UPDATE_EVENT, listener);
        return () => { ipcRenderer.removeListener(IPC.UPDATE_EVENT, listener); };
    },
    // 3D model import (used by the embedded 3D scene panel)
    pickModel: () => ipcRenderer.invoke(IPC.SCENE_PICK_MODEL),
    readModel: (path: string) => ipcRenderer.invoke(IPC.SCENE_READ_MODEL, path),
    readFile: (path: string) => ipcRenderer.invoke(IPC.READ_FILE, path),
    // In-app Docs Browser (examples/tutorials + user guide)
    fixtureLibraryIndex: () => ipcRenderer.invoke(IPC.FIXTURE_LIBRARY_INDEX),
    fixtureLibraryGet: (manufacturerKey: string) => ipcRenderer.invoke(IPC.FIXTURE_LIBRARY_GET, manufacturerKey),
    listSerialDevices: () => ipcRenderer.invoke(IPC.SERIAL_DEVICES),
    importGdtf: () => ipcRenderer.invoke(IPC.FIXTURE_IMPORT_GDTF),
    docsList: () => ipcRenderer.invoke(IPC.DOCS_LIST),
    docsSearchIndex: () => ipcRenderer.invoke(IPC.DOCS_SEARCH_INDEX),
    docsRead: (id: string) => ipcRenderer.invoke(IPC.DOCS_READ, id),
    docsReadAsset: (absPath: string) => ipcRenderer.invoke(IPC.DOCS_READ_ASSET, absPath),
    openDocsWindow: (id?: string) => ipcRenderer.send(IPC.DOCS_OPEN_WINDOW, id),
    docsOpenExample: (absPath: string) => ipcRenderer.send(IPC.DOCS_OPEN_EXAMPLE, absPath),
    pickVideo: () => ipcRenderer.invoke(IPC.PICK_VIDEO),
    saveTrackingTake: (id: string, json: string) => ipcRenderer.invoke(IPC.SAVE_TRACKING_TAKE, id, json),
    // Asset library
    importAssets: (projectFile: string, type) => ipcRenderer.invoke(IPC.IMPORT_ASSETS, projectFile, type),
    importAssetFile: (projectFile: string, srcPath: string, type, name?: string) => ipcRenderer.invoke(IPC.IMPORT_ASSET_FILE, projectFile, srcPath, type, name),
    scanAssets: (projectFile: string, knownPaths: string[]) => ipcRenderer.invoke(IPC.SCAN_ASSETS, projectFile, knownPaths),
    showItemInFolder: (path: string) => ipcRenderer.send(IPC.SHOW_ITEM_IN_FOLDER, path),
    assetExists: (paths: string[]) => ipcRenderer.invoke(IPC.ASSET_EXISTS, paths),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    // Projector outputs
    listDisplays: () => ipcRenderer.invoke(IPC.PROJECTOR_LIST_DISPLAYS),
    openProjector: (surfaceId: string, displayId: number) => ipcRenderer.send(IPC.PROJECTOR_OPEN, surfaceId, displayId),
    closeProjector: (surfaceId: string) => ipcRenderer.send(IPC.PROJECTOR_CLOSE, surfaceId),
    setProjectorDisplay: (surfaceId: string, displayId: number) => ipcRenderer.send(IPC.PROJECTOR_SET_DISPLAY, surfaceId, displayId),
    onDisplaysChanged: (cb: (displays: DisplayInfo[]) => void) => {
        const listener = (_e: unknown, displays: DisplayInfo[]) => cb(displays);
        ipcRenderer.on(IPC.PROJECTOR_DISPLAYS_CHANGED, listener);
        return () => { ipcRenderer.removeListener(IPC.PROJECTOR_DISPLAYS_CHANGED, listener); };
    },
    onProjectorClosed: (cb: (surfaceId: string) => void) => {
        const listener = (_e: unknown, surfaceId: string) => cb(surfaceId);
        ipcRenderer.on(IPC.PROJECTOR_CLOSED, listener);
        return () => { ipcRenderer.removeListener(IPC.PROJECTOR_CLOSED, listener); };
    },
    // Generic plugin IPC bridge. contextIsolation keeps plugin code out of preload and `artlux` is
    // built once, so first-party plugins can't add their own named methods. Instead they funnel all
    // main↔renderer traffic through these three forwarders, namespaced under 'plugin:<channel>'.
    // `pluginOn` adds an independent listener per call (multiple subscribers coexist, like onOscMessage),
    // and delivery preserves the caller's argument shape (a plugin batches its own firehose into one arg).
    pluginInvoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke('plugin:' + channel, ...args),
    pluginSend: (channel: string, ...args: unknown[]) => ipcRenderer.send('plugin:' + channel, ...args),
    pluginOn: (channel: string, cb: (...args: unknown[]) => void) => {
        const listener = (_e: unknown, ...args: unknown[]) => cb(...args);
        ipcRenderer.on('plugin:' + channel, listener);
        return () => { ipcRenderer.removeListener('plugin:' + channel, listener); };
    },
};

// Bridge MessagePort: a MessagePort can't survive being passed through a contextBridge
// callback (contextIsolation strips its methods), so forward it into the main world with
// window.postMessage — which preserves the transferred port. Buffer ports until the renderer
// signals readiness (it posts 'artlux:projector-ready' after attaching its listener), because
// transferring to a not-yet-listening window would drop the port. Projector outputs have one
// port each, tagged by surfaceId, so they queue.
const pendingProjectorPorts: { surfaceId: string; port: MessagePort }[] = [];
let rendererReady = false;
const flushPorts = () => {
    if (!rendererReady) return;
    while (pendingProjectorPorts.length) {
        const { surfaceId, port } = pendingProjectorPorts.shift()!;
        window.postMessage({ kind: 'artlux:projector-port', surfaceId }, '*', [port]);
    }
};
ipcRenderer.on(IPC.PROJECTOR_PORT, (e, payload: { surfaceId: string }) => {
    const port = e.ports[0];
    if (port) pendingProjectorPorts.push({ surfaceId: payload?.surfaceId, port });
    flushPorts();
});

// The OUTPUT port, forwarded the same way and for the same reason (a MessagePort cannot survive the
// contextBridge). The renderer relays it into the frame-engine worker, so packed universes reach main
// without the main thread being involved at all.
//
// Buffered on its own queue rather than reusing the projector one: this port arrives on did-finish-load
// in EVERY mode, including headless, where nothing ever posts 'artlux:projector-ready' — sharing the
// queue would leave it parked forever in exactly the run that needs it most. Its own readiness signal
// is 'artlux:engine-ready', posted by the renderer once it is listening.
let pendingEnginePort: MessagePort | null = null;
let engineReady = false;
const flushEnginePort = () => {
    if (!engineReady || !pendingEnginePort) return;
    const port = pendingEnginePort;
    pendingEnginePort = null;
    window.postMessage({ kind: 'artlux:engine-port' }, '*', [port]);
};
ipcRenderer.on(IPC.ENGINE_PORT, (e) => {
    const port = e.ports[0];
    if (port) pendingEnginePort = port;
    flushEnginePort();
});
window.addEventListener('message', (e) => {
    if (e.data === 'artlux:projector-ready') {
        rendererReady = true;
        flushPorts();
    } else if (e.data === 'artlux:engine-ready') {
        engineReady = true;
        flushEnginePort();
    }
});

contextBridge.exposeInMainWorld('artlux', api);
