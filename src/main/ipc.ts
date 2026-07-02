import { app, ipcMain, shell, dialog, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { IPC, type OutputConfig, type InputConfig, type ProjectData, type RigData, type Prefs, type OscConfig, type AssetType, type WindowCommand } from '../../shared/protocol';
import * as output from './transport/outputManager';
import * as input from './transport/input';
import * as discovery from './transport/discovery';
import * as osc from './transport/oscManager';
import * as nvwarp from './nvwarpManager';
import { buildMpcdi, parseMpcdi, type MpcdiRegion } from './mpcdi';
import * as persistence from './persistence';
import * as projectFolder from './projectFolder';
import * as metrics from './metrics';
import { rebuildAppMenu } from './menu';
import { activateMainPlugins } from './host/plugins';

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
    ipcMain.handle(IPC.SAVE_TRACKING_TAKE, (_e, id: string, json: string) => persistence.saveTrackingTake(id, json));

    // ---- Asset library: import (copy-in), reveal, existence checks ----
    ipcMain.handle(IPC.IMPORT_ASSETS, (_e, projectFile: string, type: AssetType) =>
        projectFolder.importAssets(getWindow(), projectFile, type));
    ipcMain.handle(IPC.IMPORT_ASSET_FILE, (_e, projectFile: string, srcPath: string, type: AssetType, name?: string) =>
        projectFolder.importAssetFile(projectFile, srcPath, type, name));
    ipcMain.on(IPC.SHOW_ITEM_IN_FOLDER, (_e, path: string) => { if (path) shell.showItemInFolder(path); });
    ipcMain.handle(IPC.ASSET_EXISTS, (_e, paths: string[]) => (paths ?? []).map((p) => !!p && existsSync(p)));
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

    // ---- Custom title bar: window controls + menu roles (frameless window) ----
    ipcMain.on(IPC.WINDOW_COMMAND, (_e, cmd: WindowCommand) => {
        const win = getWindow();
        if (!win) return;
        const wc = win.webContents;
        switch (cmd) {
            case 'minimize': win.minimize(); break;
            case 'maximize-toggle': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
            case 'close': win.close(); break;
            case 'quit': app.quit(); break;
            case 'reload': wc.reload(); break;
            case 'devtools': wc.toggleDevTools(); break;
            case 'fullscreen': win.setFullScreen(!win.isFullScreen()); break;
            case 'zoom-in': wc.setZoomLevel(wc.getZoomLevel() + 0.5); break;
            case 'zoom-out': wc.setZoomLevel(wc.getZoomLevel() - 0.5); break;
            case 'zoom-reset': wc.setZoomLevel(0); break;
            case 'cut': wc.cut(); break;
            case 'copy': wc.copy(); break;
            case 'paste': wc.paste(); break;
            case 'select-all': wc.selectAll(); break;
        }
    });
    ipcMain.handle(IPC.WINDOW_IS_MAXIMIZED, () => !!getWindow()?.isMaximized());
    // Spout receive moved to @artlux/plugin-spout (spout:list / spout:configure / spout:frame over the
    // generic plugin bridge; activated via activateMainPlugins below).

    // First-party main plugins register their own IPC through the generic plugin bridge. NDI lives in
    // @artlux/plugin-ndi now (channels: ndi:available / ndi:list / ndi:configure / ndi:frame / ndi:send-*).
    activateMainPlugins(getWindow);

    // ---- OSC (external control + LiDAR blob tracking): receive onto the renderer ----
    ipcMain.on(IPC.OSC_CONFIGURE, (_e, cfg: OscConfig) => {
        if (cfg.enabled) {
            osc.start(cfg.listenPort, (msgs) => getWindow()?.webContents.send(IPC.OSC_MESSAGE, msgs), cfg.listenAddress || undefined);
        } else {
            osc.stop();
        }
    });
    ipcMain.on(IPC.OSC_SEND, (_e, host: string, port: number, address: string, args: (number | string)[]) => {
        osc.send(host, port, address, args);
    });
    ipcMain.handle(IPC.OSC_LOCAL_ADDRS, () => osc.localAddresses());
    // HAP video decode moved to @artlux/plugin-hap (hap:open / hap:decode / hap:close over the generic
    // plugin bridge; activated via activateMainPlugins).

    // Projector calibration (native OpenCV addon) now lives in @artlux/plugin-calibration — its main
    // entry registers the solve/camera IPC (channels 'calib:*') via activateMainPlugins above.

    // ---- NVIDIA NVAPI scanout warp/blend (Quadro/RTX-pro; GLSL fallback otherwise) ----
    ipcMain.handle(IPC.NVWARP_AVAILABLE, () => nvwarp.isAvailable());
    ipcMain.handle(IPC.NVWARP_SET_WARP, (_e, electronDisplayId: number, verts: number[], src: number[]) =>
        nvwarp.setWarp(electronDisplayId, verts, src));
    ipcMain.handle(IPC.NVWARP_SET_INTENSITY, (_e, electronDisplayId: number, w: number, h: number, rgb: number[]) =>
        nvwarp.setIntensity(electronDisplayId, w, h, rgb));
    ipcMain.on(IPC.NVWARP_CLEAR, (_e, electronDisplayId: number) => nvwarp.clearDisplay(electronDisplayId));

    // ---- MPCDI interchange (export/import projector warp+blend) ----
    ipcMain.handle(IPC.MPCDI_EXPORT, async (e, regions: MpcdiRegion[]) => {
        const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined;
        const opts = { title: 'Export MPCDI', defaultPath: 'artlux.mpcdi', filters: [{ name: 'MPCDI', extensions: ['mpcdi'] }] };
        const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
        if (res.canceled || !res.filePath) return null;
        try { writeFileSync(res.filePath, buildMpcdi(regions)); return res.filePath; }
        catch (err) { console.warn('[mpcdi] export failed:', (err as Error)?.message ?? err); return null; }
    });
    ipcMain.handle(IPC.MPCDI_IMPORT, async (e) => {
        const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined;
        const opts = { title: 'Import MPCDI', filters: [{ name: 'MPCDI', extensions: ['mpcdi'] }], properties: ['openFile' as const] };
        const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
        if (res.canceled || !res.filePaths[0]) return null;
        try { return parseMpcdi(readFileSync(res.filePaths[0])); }
        catch (err) { console.warn('[mpcdi] import failed:', (err as Error)?.message ?? err); return null; }
    });

    // Poll native engine throughput stats ~1 Hz and push to the renderer.
    // The same numbers feed the Prometheus gauges (see ./metrics) — no extra polling.
    setInterval(() => {
        const stats = output.getStats();
        if (stats) getWindow()?.webContents.send(IPC.STATS, stats);
        metrics.updateEngineStats(stats);
    }, 1000);
}
