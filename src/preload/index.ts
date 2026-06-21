import { contextBridge, ipcRenderer } from 'electron';
import {
    IPC, type OutputConfig, type OutputStats, type InputConfig, type InputFrame, type ArtluxApi,
    type ProjectData, type RigData, type Prefs,
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
    exportRig: (rig: RigData) => ipcRenderer.invoke(IPC.RIG_EXPORT, rig),
    importRig: () => ipcRenderer.invoke(IPC.RIG_IMPORT),
    getPrefs: () => ipcRenderer.invoke(IPC.PREFS_GET),
    setPrefs: (patch: Partial<Prefs>) => ipcRenderer.invoke(IPC.PREFS_SET, patch),
    discoverDevices: () => ipcRenderer.invoke(IPC.ARTNET_DISCOVER),
};

contextBridge.exposeInMainWorld('artlux', api);
