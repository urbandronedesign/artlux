import { app, ipcMain, shell, dialog, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { IPC, type OutputConfig, type InputConfig, type ProjectData, type RigData, type Prefs, type SpoutConfig, type NdiConfig, type NdiSendConfig } from '../../shared/protocol';
import * as output from './transport/outputManager';
import * as input from './transport/input';
import * as discovery from './transport/discovery';
import * as spout from './transport/spoutManager';
import * as ndi from './transport/ndiManager';
import * as hap from './transport/hapManager';
import * as persistence from './persistence';
import * as projectFolder from './projectFolder';
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
    // Portable projects: create/open a project folder + collect assets into it.
    ipcMain.handle(IPC.PROJECT_NEW_FOLDER, () => projectFolder.newProjectFolder(getWindow()));
    ipcMain.handle(IPC.PROJECT_OPEN_FOLDER, async () => {
        const projectFile = await projectFolder.pickProjectFolder(getWindow());
        if (!projectFile) return null;
        const data = persistence.loadProjectPath(projectFile); // resolves relative paths + records recent
        rebuildAppMenu();
        return data ? { path: projectFile, data } : null;
    });
    ipcMain.handle(IPC.PROJECT_COLLECT_ASSETS, (_e, projectFile: string, data: ProjectData) =>
        projectFolder.collectAssets(projectFile, data));
    ipcMain.handle(IPC.RIG_EXPORT, (_e, rig: RigData) => persistence.exportRig(getWindow(), rig));
    ipcMain.handle(IPC.RIG_IMPORT, () => persistence.importRig(getWindow()));
    ipcMain.handle(IPC.PREFS_GET, () => persistence.getPrefs());
    ipcMain.handle(IPC.PREFS_SET, (_e, patch: Partial<Prefs>) => { persistence.setPrefs(patch); });
    ipcMain.handle(IPC.ARTNET_DISCOVER, () => discovery.discover());

    // 3D Scene venue model: pick a GLB/glTF, and read its bytes (renderer wraps them in
    // a Blob URL for drei useGLTF — avoids file:// in the sandboxed renderer).
    ipcMain.handle(IPC.SCENE_PICK_MODEL, async () => {
        const parent = BrowserWindow.getFocusedWindow() ?? getWindow();
        const opts = {
            title: 'Import venue model',
            properties: ['openFile' as const],
            filters: [{ name: '3D Model', extensions: ['glb', 'gltf'] }],
        };
        const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
        return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
    });
    ipcMain.handle(IPC.SCENE_READ_MODEL, async (_e, path: string) => {
        try {
            return new Uint8Array(await readFile(path));
        } catch (err) { console.error('[scene] read model failed', err); return null; }
    });
    ipcMain.handle(IPC.READ_FILE, async (_e, path: string) => {
        try { return new Uint8Array(await readFile(path)); }
        catch (err) { console.error('[ipc] read file failed', err); return null; }
    });
    ipcMain.handle(IPC.PICK_VIDEO, async () => {
        const parent = BrowserWindow.getFocusedWindow() ?? getWindow();
        const opts = { title: 'Import video', properties: ['openFile' as const], filters: [{ name: 'Video', extensions: ['mp4', 'webm', 'mov', 'mkv'] }] };
        const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
        return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
    });
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

    // ---- NDI (network video): receive onto a surface + send per-output ----
    ipcMain.handle(IPC.NDI_AVAILABLE, () => ndi.available());
    ipcMain.handle(IPC.NDI_LIST, () => ndi.listSources());
    ipcMain.on(IPC.NDI_CONFIGURE, (_e, cfg: NdiConfig) => {
        if (cfg.enabled) {
            ndi.startRecv(cfg.name ?? '', (frame) => getWindow()?.webContents.send(IPC.NDI_FRAME, frame));
        } else {
            ndi.stopRecv();
        }
    });
    ipcMain.on(IPC.NDI_SEND_CONFIGURE, (_e, cfg: NdiSendConfig) => {
        ndi.sendConfigure(cfg.outputId, cfg.enabled, cfg.name ?? 'ArtLux');
    });
    ipcMain.on(IPC.NDI_SEND_FRAME, (_e, outputId: string, width: number, height: number, data: ArrayBuffer) => {
        ndi.sendFrame(outputId, width, height, Buffer.from(data));
    });

    // ---- HAP video (native decode; renderer pulls frames by index) ----
    ipcMain.handle(IPC.HAP_OPEN, (_e, path: string) => hap.open(path));
    ipcMain.handle(IPC.HAP_DECODE, (_e, path: string, index: number) => hap.decode(path, index));
    ipcMain.on(IPC.HAP_CLOSE, (_e, path: string) => hap.close(path));

    // Poll native engine throughput stats ~1 Hz and push to the renderer.
    setInterval(() => {
        const stats = output.getStats();
        if (stats) getWindow()?.webContents.send(IPC.STATS, stats);
    }, 1000);
}
