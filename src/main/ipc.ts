import { ipcMain, type BrowserWindow } from 'electron';
import { IPC, type OutputConfig, type ArtNetFramePayload } from '../../shared/protocol';
import * as artnet from './transport/artnet';

// Wire renderer IPC to the native Art-Net transport and report status back.
export function registerIpc(getWindow: () => BrowserWindow | null): void {
    const sendStatus = (connected: boolean) => {
        getWindow()?.webContents.send(IPC.STATUS, connected);
    };

    ipcMain.on(IPC.CONFIGURE, (_e, cfg: OutputConfig) => {
        try {
            artnet.configure(cfg);
            sendStatus(true);
        } catch (err) {
            console.error('[ipc] configure failed', err);
            sendStatus(false);
        }
    });

    ipcMain.on(IPC.FRAME, (_e, payload: ArtNetFramePayload) => {
        if (!artnet.isReady()) return;
        artnet.sendFrame(payload);
    });
}
