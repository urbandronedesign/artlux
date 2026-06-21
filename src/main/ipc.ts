import { ipcMain, type BrowserWindow } from 'electron';
import { IPC, type OutputConfig, type InputConfig } from '../../shared/protocol';
import * as output from './transport/outputManager';
import * as input from './transport/input';

// Wire renderer IPC to the native Art-Net transport and report status back.
export function registerIpc(getWindow: () => BrowserWindow | null): void {
    const sendStatus = (connected: boolean) => {
        getWindow()?.webContents.send(IPC.STATUS, connected);
    };

    ipcMain.on(IPC.CONFIGURE, (_e, cfg: OutputConfig) => {
        try {
            output.configure(cfg);
            sendStatus(true);
        } catch (err) {
            console.error('[ipc] configure failed', err);
            sendStatus(false);
        }
    });

    ipcMain.on(IPC.FRAME, (_e, frame: ArrayBuffer | Uint8Array) => {
        if (!output.isReady()) return;
        output.sendFrame(frame);
    });

    ipcMain.on(IPC.INPUT_CONFIGURE, (_e, cfg: InputConfig) => {
        input.configureInput(cfg, (frames) => {
            getWindow()?.webContents.send(IPC.INPUT_FRAME, frames);
        });
    });
}
