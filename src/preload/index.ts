import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
    IPC, type OutputConfig, type OutputStats, type InputConfig, type InputFrame, type ArtluxApi,
    type ProjectData, type RigData, type Prefs, type SpoutConfig, type SpoutFrame, type UpdateEvent,
    type DisplayInfo, type NdiConfig, type NdiFrame, type NdiSendConfig, type OscConfig, type OscMessage,
    type WindowCommand,
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
    // NDI
    ndiAvailable: () => ipcRenderer.invoke(IPC.NDI_AVAILABLE),
    listNdiSources: () => ipcRenderer.invoke(IPC.NDI_LIST),
    configureNdi: (cfg: NdiConfig) => ipcRenderer.send(IPC.NDI_CONFIGURE, cfg),
    onNdiFrame: (cb: (frame: NdiFrame) => void) => {
        const listener = (_e: unknown, frame: NdiFrame) => cb(frame);
        ipcRenderer.on(IPC.NDI_FRAME, listener);
        return () => { ipcRenderer.removeListener(IPC.NDI_FRAME, listener); };
    },
    configureNdiSend: (cfg: NdiSendConfig) => ipcRenderer.send(IPC.NDI_SEND_CONFIGURE, cfg),
    sendNdiFrame: (outputId: string, width: number, height: number, data: ArrayBuffer) =>
        ipcRenderer.send(IPC.NDI_SEND_FRAME, outputId, width, height, data),
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
    // HAP video (frame-accurate pull)
    openHap: (path: string) => ipcRenderer.invoke(IPC.HAP_OPEN, path),
    decodeHapFrame: (path: string, index: number) => ipcRenderer.invoke(IPC.HAP_DECODE, path, index),
    closeHap: (path: string) => ipcRenderer.send(IPC.HAP_CLOSE, path),
    // Projector calibration (native OpenCV addon)
    calibAvailable: () => ipcRenderer.invoke(IPC.CALIB_AVAILABLE),
    calibDetectBoard: (image: ArrayBuffer, w: number, h: number, cols: number, rows: number) =>
        ipcRenderer.invoke(IPC.CALIB_DETECT_BOARD, image, w, h, cols, rows),
    calibDetectAruco: (image: ArrayBuffer, w: number, h: number, dict: number) =>
        ipcRenderer.invoke(IPC.CALIB_DETECT_ARUCO, image, w, h, dict),
    calibMapCorners: (captures: ArrayBuffer, captureCount: number, camW: number, camH: number, projW: number, projH: number, corners: number[], white: ArrayBuffer, black: ArrayBuffer) =>
        ipcRenderer.invoke(IPC.CALIB_MAP_CORNERS, captures, captureCount, camW, camH, projW, projH, corners, white, black),
    calibCalibrateProjector: (objectPoints: number[], imagePoints: number[], pointCounts: number[], projW: number, projH: number) =>
        ipcRenderer.invoke(IPC.CALIB_CALIBRATE_PROJECTOR, objectPoints, imagePoints, pointCounts, projW, projH),
    calibSolvePnp: (objectPts: number[], imagePts: number[], k: number[], dist: number[]) =>
        ipcRenderer.invoke(IPC.CALIB_SOLVE_PNP, objectPts, imagePts, k, dist),
    calibCameraOpen: (index: number, width: number, height: number, fps: number, fourcc: string) =>
        ipcRenderer.invoke(IPC.CALIB_CAMERA_OPEN, index, width, height, fps, fourcc),
    calibCameraGrab: () => ipcRenderer.invoke(IPC.CALIB_CAMERA_GRAB),
    calibCameraGrabColor: () => ipcRenderer.invoke(IPC.CALIB_CAMERA_GRAB_COLOR),
    calibCameraClose: () => ipcRenderer.send(IPC.CALIB_CAMERA_CLOSE),
    calibCameraSetProp: (prop: string, value: number) => ipcRenderer.invoke(IPC.CALIB_CAMERA_SET_PROP, prop, value),
    calibCameraGetProp: (prop: string) => ipcRenderer.invoke(IPC.CALIB_CAMERA_GET_PROP, prop),
    calibDecodeDense: (captures: ArrayBuffer, captureCount: number, camW: number, camH: number, projW: number, projH: number, white: ArrayBuffer, black: ArrayBuffer, stride: number) =>
        ipcRenderer.invoke(IPC.CALIB_DECODE_DENSE, captures, captureCount, camW, camH, projW, projH, white, black, stride),
    calibSolvePnpRansac: (objectPts: number[], imagePts: number[], k: number[], dist: number[], reprojErr: number) =>
        ipcRenderer.invoke(IPC.CALIB_SOLVE_PNP_RANSAC, objectPts, imagePts, k, dist, reprojErr),
    calibCalibrateGuided: (objectPoints: number[], imagePoints: number[], pointCounts: number[], projW: number, projH: number, initK: number[], fixPrincipalPoint: boolean, fixAspect: boolean) =>
        ipcRenderer.invoke(IPC.CALIB_CALIBRATE_GUIDED, objectPoints, imagePoints, pointCounts, projW, projH, initK, fixPrincipalPoint, fixAspect),
    calibSelfCalibrate: (camX: number[], camY: number[], projX: number[], projY: number[], camW: number, camH: number, projW: number, projH: number) =>
        ipcRenderer.invoke(IPC.CALIB_SELF_CALIBRATE, camX, camY, projX, projY, camW, camH, projW, projH),
    // NVAPI scanout warp/blend
    nvwarpAvailable: () => ipcRenderer.invoke(IPC.NVWARP_AVAILABLE),
    nvwarpSetWarp: (electronDisplayId: number, verts: number[], src: number[]) =>
        ipcRenderer.invoke(IPC.NVWARP_SET_WARP, electronDisplayId, verts, src),
    nvwarpSetIntensity: (electronDisplayId: number, w: number, h: number, rgb: number[]) =>
        ipcRenderer.invoke(IPC.NVWARP_SET_INTENSITY, electronDisplayId, w, h, rgb),
    nvwarpClear: (electronDisplayId: number) => ipcRenderer.send(IPC.NVWARP_CLEAR, electronDisplayId),
    // MPCDI interchange
    exportMpcdi: (regions: unknown[]) => ipcRenderer.invoke(IPC.MPCDI_EXPORT, regions),
    importMpcdi: () => ipcRenderer.invoke(IPC.MPCDI_IMPORT),
    // App chrome
    onMenuAction: (cb: (action: string) => void) => {
        const listener = (_e: unknown, action: string) => cb(action);
        ipcRenderer.on(IPC.MENU_ACTION, listener);
        return () => { ipcRenderer.removeListener(IPC.MENU_ACTION, listener); };
    },
    getAppInfo: () => ipcRenderer.invoke(IPC.APP_INFO),
    openExternal: (url: string) => ipcRenderer.send(IPC.OPEN_EXTERNAL, url),
    relaunchBroadcast: (projectPath: string) => ipcRenderer.send(IPC.APP_RELAUNCH_BROADCAST, projectPath),
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
    pickVideo: () => ipcRenderer.invoke(IPC.PICK_VIDEO),
    saveTrackingTake: (id: string, json: string) => ipcRenderer.invoke(IPC.SAVE_TRACKING_TAKE, id, json),
    // Asset library
    importAssets: (projectFile: string, type) => ipcRenderer.invoke(IPC.IMPORT_ASSETS, projectFile, type),
    importAssetFile: (projectFile: string, srcPath: string, type, name?: string) => ipcRenderer.invoke(IPC.IMPORT_ASSET_FILE, projectFile, srcPath, type, name),
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
window.addEventListener('message', (e) => {
    if (e.data === 'artlux:projector-ready') {
        rendererReady = true;
        flushPorts();
    }
});

contextBridge.exposeInMainWorld('artlux', api);
