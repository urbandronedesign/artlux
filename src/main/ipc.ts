import { app, ipcMain, shell, dialog, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { IPC, type OutputConfig, type InputConfig, type ProjectData, type RigData, type Prefs, type SpoutConfig, type NdiConfig, type NdiSendConfig, type OscConfig, type AssetType, type WindowCommand } from '../../shared/protocol';
import * as output from './transport/outputManager';
import * as input from './transport/input';
import * as discovery from './transport/discovery';
import * as spout from './transport/spoutManager';
import * as ndi from './transport/ndiManager';
import * as osc from './transport/oscManager';
import * as hap from './transport/hapManager';
import * as calib from './calibManager';
import * as persistence from './persistence';
import * as projectFolder from './projectFolder';
import * as metrics from './metrics';
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

    // ---- HAP video (native decode; renderer pulls frames by index) ----
    ipcMain.handle(IPC.HAP_OPEN, (_e, path: string) => hap.open(path));
    ipcMain.handle(IPC.HAP_DECODE, (_e, path: string, index: number) => hap.decode(path, index));
    ipcMain.on(IPC.HAP_CLOSE, (_e, path: string) => hap.close(path));

    // ---- Projector calibration (native OpenCV addon; renderer drives the solves) ----
    ipcMain.handle(IPC.CALIB_AVAILABLE, () => calib.isAvailable());
    ipcMain.handle(IPC.CALIB_DETECT_BOARD, (_e, image: ArrayBuffer, w: number, h: number, cols: number, rows: number) =>
        calib.detectBoard(Buffer.from(image), w, h, cols, rows));
    ipcMain.handle(IPC.CALIB_MAP_CORNERS, (_e, captures: ArrayBuffer, captureCount: number, camW: number, camH: number, projW: number, projH: number, corners: number[], white: ArrayBuffer, black: ArrayBuffer) =>
        calib.mapCorners(Buffer.from(captures), captureCount, camW, camH, projW, projH, corners, Buffer.from(white), Buffer.from(black)));
    ipcMain.handle(IPC.CALIB_CALIBRATE_PROJECTOR, (_e, objectPoints: number[], imagePoints: number[], pointCounts: number[], projW: number, projH: number) =>
        calib.calibrateProjector(objectPoints, imagePoints, pointCounts, projW, projH));
    ipcMain.handle(IPC.CALIB_SOLVE_PNP, (_e, objectPts: number[], imagePts: number[], k: number[], dist: number[]) =>
        calib.solvePnp(objectPts, imagePts, k, dist));
    ipcMain.handle(IPC.CALIB_CAMERA_OPEN, (_e, index: number, width: number, height: number, fps: number, fourcc: string) =>
        calib.cameraOpen(index, width, height, fps, fourcc));
    ipcMain.handle(IPC.CALIB_CAMERA_GRAB, () => calib.cameraGrab());
    ipcMain.on(IPC.CALIB_CAMERA_CLOSE, () => calib.cameraClose());
    ipcMain.handle(IPC.CALIB_DECODE_DENSE, (_e, captures: ArrayBuffer, captureCount: number, camW: number, camH: number, projW: number, projH: number, white: ArrayBuffer, black: ArrayBuffer, stride: number) =>
        calib.decodeDense(Buffer.from(captures), captureCount, camW, camH, projW, projH, Buffer.from(white), Buffer.from(black), stride));
    ipcMain.handle(IPC.CALIB_SOLVE_PNP_RANSAC, (_e, objectPts: number[], imagePts: number[], k: number[], dist: number[], reprojErr: number) =>
        calib.solvePnpRansac(objectPts, imagePts, k, dist, reprojErr));
    ipcMain.handle(IPC.CALIB_CALIBRATE_GUIDED, (_e, objectPoints: number[], imagePoints: number[], pointCounts: number[], projW: number, projH: number, initK: number[], fixPrincipalPoint: boolean, fixAspect: boolean) =>
        calib.calibrateGuided(objectPoints, imagePoints, pointCounts, projW, projH, initK, fixPrincipalPoint, fixAspect));

    // Poll native engine throughput stats ~1 Hz and push to the renderer.
    // The same numbers feed the Prometheus gauges (see ./metrics) — no extra polling.
    setInterval(() => {
        const stats = output.getStats();
        if (stats) getWindow()?.webContents.send(IPC.STATS, stats);
        metrics.updateEngineStats(stats);
    }, 1000);
}
