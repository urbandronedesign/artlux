import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type OutputConfig, type InputConfig, type InputFrame, type ArtluxApi } from '../../shared/protocol';

const api: ArtluxApi = {
    configureOutput: (cfg: OutputConfig) => ipcRenderer.send(IPC.CONFIGURE, cfg),
    sendArtNet: (frame: ArrayBuffer) => ipcRenderer.send(IPC.FRAME, frame),
    onStatus: (cb: (connected: boolean) => void) => {
        const listener = (_e: unknown, connected: boolean) => cb(connected);
        ipcRenderer.on(IPC.STATUS, listener);
        return () => { ipcRenderer.removeListener(IPC.STATUS, listener); };
    },
    configureInput: (cfg: InputConfig) => ipcRenderer.send(IPC.INPUT_CONFIGURE, cfg),
    onDmxInput: (cb: (frames: InputFrame[]) => void) => {
        const listener = (_e: unknown, frames: InputFrame[]) => cb(frames);
        ipcRenderer.on(IPC.INPUT_FRAME, listener);
        return () => { ipcRenderer.removeListener(IPC.INPUT_FRAME, listener); };
    },
};

contextBridge.exposeInMainWorld('artlux', api);
