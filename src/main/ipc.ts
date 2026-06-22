import { app, ipcMain, shell, type BrowserWindow } from 'electron';
import { IPC, type OutputConfig, type InputConfig, type ProjectData, type RigData, type Prefs, type SpoutConfig } from '../../shared/protocol';
import * as output from './transport/outputManager';
import * as input from './transport/input';
import * as discovery from './transport/discovery';
import * as spout from './transport/spoutManager';
import * as persistence from './persistence';
import { rebuildAppMenu } from './menu';

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

    // ---- Persistence (request/response via handle/invoke) ----
    // Recents change on save/open/load → rebuild the menu's Open-Recent submenu.
    ipcMain.handle(IPC.PROJECT_SAVE, async (_e, data: ProjectData, path?: string) => {
        const r = await persistence.saveProject(getWindow(), data, path);
        rebuildAppMenu();
        return r;
    });
    ipcMain.handle(IPC.PROJECT_OPEN, async () => {
        const r = await persistence.openProject(getWindow());
        rebuildAppMenu();
        return r;
    });
    ipcMain.handle(IPC.PROJECT_LOAD_PATH, (_e, path: string) => {
        const r = persistence.loadProjectPath(path);
        rebuildAppMenu();
        return r;
    });
    ipcMain.handle(IPC.RIG_EXPORT, (_e, rig: RigData) => persistence.exportRig(getWindow(), rig));
    ipcMain.handle(IPC.RIG_IMPORT, () => persistence.importRig(getWindow()));
    ipcMain.handle(IPC.PREFS_GET, () => persistence.getPrefs());
    ipcMain.handle(IPC.PREFS_SET, (_e, patch: Partial<Prefs>) => { persistence.setPrefs(patch); });
    ipcMain.handle(IPC.ARTNET_DISCOVER, () => discovery.discover());
    ipcMain.handle(IPC.APP_INFO, () => ({ name: app.getName(), version: app.getVersion() }));
    ipcMain.on(IPC.OPEN_EXTERNAL, (_e, url: string) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    });

    // ---- Spout receiver ----
    ipcMain.handle(IPC.SPOUT_LIST, () => spout.listSenders());
    ipcMain.on(IPC.SPOUT_CONFIGURE, (_e, cfg: SpoutConfig) => {
        if (cfg.enabled) {
            spout.start(cfg.name ?? '', (frame) => getWindow()?.webContents.send(IPC.SPOUT_FRAME, frame));
        } else {
            spout.stop();
        }
    });

    // Poll native engine throughput stats ~1 Hz and push to the renderer.
    setInterval(() => {
        const stats = output.getStats();
        if (stats) getWindow()?.webContents.send(IPC.STATS, stats);
    }, 1000);
}
