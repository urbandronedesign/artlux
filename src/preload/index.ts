import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
    IPC, type OutputConfig, type OutputStats, type InputConfig, type InputFrame, type ArtluxApi,
    type ProjectData, type RigData, type Prefs, type SpoutConfig, type SpoutFrame, type UpdateEvent,
    type DisplayInfo,
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
    openProjectFolder: () => ipcRenderer.invoke(IPC.PROJECT_OPEN_FOLDER),
    collectAssets: (projectFile: string, data: ProjectData) => ipcRenderer.invoke(IPC.PROJECT_COLLECT_ASSETS, projectFile, data),
    exportRig: (rig: RigData) => ipcRenderer.invoke(IPC.RIG_EXPORT, rig),
    importRig: () => ipcRenderer.invoke(IPC.RIG_IMPORT),
    getPrefs: () => ipcRenderer.invoke(IPC.PREFS_GET),
    setPrefs: (patch: Partial<Prefs>) => ipcRenderer.invoke(IPC.PREFS_SET, patch),
    discoverDevices: () => ipcRenderer.invoke(IPC.ARTNET_DISCOVER),
    // Spout
    listSpoutSenders: () => ipcRenderer.invoke(IPC.SPOUT_LIST),
    configureSpout: (cfg: SpoutConfig) => ipcRenderer.send(IPC.SPOUT_CONFIGURE, cfg),
    onSpoutFrame: (cb: (frame: SpoutFrame) => void) => {
        const listener = (_e: unknown, frame: SpoutFrame) => cb(frame);
        ipcRenderer.on(IPC.SPOUT_FRAME, listener);
        return () => { ipcRenderer.removeListener(IPC.SPOUT_FRAME, listener); };
    },
    // App chrome
    onMenuAction: (cb: (action: string) => void) => {
        const listener = (_e: unknown, action: string) => cb(action);
        ipcRenderer.on(IPC.MENU_ACTION, listener);
        return () => { ipcRenderer.removeListener(IPC.MENU_ACTION, listener); };
    },
    getAppInfo: () => ipcRenderer.invoke(IPC.APP_INFO),
    openExternal: (url: string) => ipcRenderer.send(IPC.OPEN_EXTERNAL, url),
    relaunchBroadcast: (projectPath: string) => ipcRenderer.send(IPC.APP_RELAUNCH_BROADCAST, projectPath),
    // Auto-update
    checkForUpdates: () => ipcRenderer.send(IPC.UPDATE_CHECK),
    downloadUpdate: () => ipcRenderer.send(IPC.UPDATE_DOWNLOAD),
    installUpdate: () => ipcRenderer.send(IPC.UPDATE_INSTALL),
    onUpdate: (cb: (e: UpdateEvent) => void) => {
        const listener = (_e: unknown, evt: UpdateEvent) => cb(evt);
        ipcRenderer.on(IPC.UPDATE_EVENT, listener);
        return () => { ipcRenderer.removeListener(IPC.UPDATE_EVENT, listener); };
    },
    // 3D Scene window
    openSceneWindow: () => ipcRenderer.send(IPC.SCENE_OPEN),
    pickModel: () => ipcRenderer.invoke(IPC.SCENE_PICK_MODEL),
    readModel: (path: string) => ipcRenderer.invoke(IPC.SCENE_READ_MODEL, path),
    readFile: (path: string) => ipcRenderer.invoke(IPC.READ_FILE, path),
    pickVideo: () => ipcRenderer.invoke(IPC.PICK_VIDEO),
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
};

// Bridge MessagePort: a MessagePort can't survive being passed through a contextBridge
// callback (contextIsolation strips its methods), so forward it into the main world with
// window.postMessage — which preserves the transferred port. Buffer ports until the renderer
// signals readiness (it posts a '*-request'/'-ready' after attaching its listener), because
// transferring to a not-yet-listening window would drop the port. The scene window has at most
// one port; projector outputs have one each, tagged by surfaceId, so they queue.
let pendingScenePort: MessagePort | null = null;
const pendingProjectorPorts: { surfaceId: string; port: MessagePort }[] = [];
let rendererReady = false;
const flushPorts = () => {
    if (!rendererReady) return;
    if (pendingScenePort) {
        const port = pendingScenePort;
        pendingScenePort = null;
        window.postMessage('artlux:scene-port', '*', [port]);
    }
    while (pendingProjectorPorts.length) {
        const { surfaceId, port } = pendingProjectorPorts.shift()!;
        window.postMessage({ kind: 'artlux:projector-port', surfaceId }, '*', [port]);
    }
};
ipcRenderer.on(IPC.SCENE_PORT, (e) => { pendingScenePort = e.ports[0] ?? null; flushPorts(); });
ipcRenderer.on(IPC.PROJECTOR_PORT, (e, payload: { surfaceId: string }) => {
    const port = e.ports[0];
    if (port) pendingProjectorPorts.push({ surfaceId: payload?.surfaceId, port });
    flushPorts();
});
window.addEventListener('message', (e) => {
    if (e.data === 'artlux:scene-port-request' || e.data === 'artlux:projector-ready') {
        rendererReady = true;
        flushPorts();
    }
});

contextBridge.exposeInMainWorld('artlux', api);
