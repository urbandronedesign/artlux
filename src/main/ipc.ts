import { app, ipcMain, shell, dialog, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { IPC, type OutputConfig, type InputConfig, type ProjectData, type RigData, type Prefs, type OscConfig, type AssetType, type WindowCommand, type RendererFault } from '../../shared/protocol';
import * as output from './transport/outputManager';
import * as input from './transport/input';
import * as discovery from './transport/discovery';
import * as osc from './transport/oscManager';
import * as nvwarp from './nvwarpManager';
import { buildMpcdi, parseMpcdi, type MpcdiRegion } from './mpcdi';
import * as persistence from './persistence';
import * as uiScale from './uiScale';
import * as projectFolder from './projectFolder';
import * as docs from './docs';
import * as fixtureLibrary from './fixtureLibrary';
import { importGdtf } from './gdtf';
import * as metrics from './metrics';
import * as watchdog from './watchdog';
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

    // Renderer frame-time stats (~1 Hz) → Prometheus gauges. Fire-and-forget; broadcast/headless have
    // no HUD, so this is their only frame-health signal. Cheap: four gauge writes.
    ipcMain.on(IPC.RENDER_STATS, (_e, stats: metrics.RenderTimingStats) => {
        metrics.updateRenderStats(stats);
        watchdog.noteRenderStats(stats); // heartbeat: renderer frame loop alive (render-stall detector)
    });

    // An uncaught renderer error — the white screen. See services/faultReporter.ts for why nothing
    // else in the watchdog can see this.
    //
    // SENDER IDENTITY IS LOAD-BEARING. A projector or docs window shares this preload and this
    // channel; a throw in one of those must be AUDITED but must never relaunch the show, and must
    // never be logged as the main window's. (cf. the WINDOW_COMMAND handler below, which resolved
    // getWindow() regardless of sender until this wave — that is how the docs window's close button
    // came to close the editor.)
    ipcMain.on(IPC.RENDERER_FAULT, (e, fault: RendererFault) => {
        const from = BrowserWindow.fromWebContents(e.sender) === getWindow() ? 'main' : 'aux';
        watchdog.noteRendererFault(fault, from);
    });

    // ---- Unattended watchdog (self-healing; Tier-1 lives in ./watchdog, armed in index.ts) ----
    ipcMain.handle(IPC.WATCHDOG_STATUS, () => watchdog.status());
    ipcMain.handle(IPC.WATCHDOG_INSTALL_TASK, () => watchdog.installTask());
    ipcMain.handle(IPC.WATCHDOG_UNINSTALL_TASK, () => watchdog.uninstallTask());

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
    ipcMain.handle(IPC.PROJECT_PREPARE_FOLDER, (_e, root: string) => projectFolder.prepareNewProjectFolder(root));
    ipcMain.handle(IPC.PROJECT_OPEN_FOLDER, async () => {
        const projectFile = await projectFolder.pickProjectFolder(getWindow());
        if (!projectFile) return null;
        const data = persistence.loadProjectPath(projectFile); // resolves relative paths + records recent
        rebuildAppMenu();
        return data ? { path: projectFile, data } : null;
    });
    ipcMain.handle(IPC.PROJECT_COLLECT_ASSETS, (_e, projectFile: string, data: ProjectData) =>
        projectFolder.collectAssets(projectFile, data));
    ipcMain.handle(IPC.PROJECT_COLLECT_TO, (_e, data: ProjectData) =>
        projectFolder.collectAssetsToFolder(getWindow(), data));
    ipcMain.handle(IPC.RIG_EXPORT, (_e, rig: RigData) => persistence.exportRig(getWindow(), rig));
    ipcMain.handle(IPC.RIG_IMPORT, () => persistence.importRig(getWindow()));
    ipcMain.handle(IPC.PREFS_GET, () => persistence.getPrefs());
    ipcMain.handle(IPC.PREFS_SET, (_e, patch: Partial<Prefs>) => { persistence.setPrefs(patch); });
    ipcMain.handle(IPC.UI_SCALE_SET, (_e, scale: number) => { uiScale.setUiScale(getWindow(), scale); });
    ipcMain.handle(IPC.UI_SCALE_DETECT, () => uiScale.detectDefaultUiScale());
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

    // In-app Docs Browser: enumerate the example/tutorial + user-guide tree, and read one doc by id.
    // DMX fixture library. The index is small and cached; a manufacturer's full profiles are pulled
    // only when a fixture is actually patched, so the renderer never carries the ~4 MB library.
    ipcMain.handle(IPC.FIXTURE_LIBRARY_INDEX, () => fixtureLibrary.getIndex());
    ipcMain.handle(IPC.FIXTURE_LIBRARY_GET, (_e, key: string) => fixtureLibrary.getManufacturer(String(key ?? '')));
    ipcMain.handle(IPC.SERIAL_DEVICES, () => output.listSerialDevices());
    ipcMain.handle(IPC.FIXTURE_IMPORT_GDTF, async () => {
        const parent = BrowserWindow.getFocusedWindow() ?? getWindow();
        const opts = {
            title: 'Import a GDTF fixture',
            properties: ['openFile' as const],
            filters: [{ name: 'GDTF fixture', extensions: ['gdtf'] }],
        };
        const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
        if (res.canceled || !res.filePaths[0]) return null;
        try {
            const { profile, notes } = await importGdtf(res.filePaths[0]);
            return { id: profile.id, model: `${profile.manufacturer} ${profile.model}`, notes };
        } catch (e) {
            // A bad file must not be a crash — it is a thing the operator can fix by picking another.
            console.error('[gdtf] import failed', e);
            return { id: '', model: '', notes: [`Import failed: ${(e as Error).message}`] };
        }
    });
    ipcMain.handle(IPC.DOCS_LIST, () => docs.listDocs());
    ipcMain.handle(IPC.DOCS_SEARCH_INDEX, () => docs.searchIndex());
    ipcMain.handle(IPC.DOCS_READ, (_e, id: string) => docs.readDoc(id));
    ipcMain.handle(IPC.DOCS_READ_ASSET, (_e, absPath: string) => docs.readDocAsset(absPath));
    ipcMain.handle(IPC.SAVE_TRACKING_TAKE, (_e, id: string, json: string) => persistence.saveTrackingTake(id, json));

    // ---- Asset library: import (copy-in), reveal, existence checks ----
    ipcMain.handle(IPC.IMPORT_ASSETS, (_e, projectFile: string, type: AssetType) =>
        projectFolder.importAssets(getWindow(), projectFile, type));
    ipcMain.handle(IPC.IMPORT_ASSET_FILE, (_e, projectFile: string, srcPath: string, type: AssetType, name?: string) =>
        projectFolder.importAssetFile(projectFile, srcPath, type, name));
    ipcMain.handle(IPC.SCAN_ASSETS, (_e, projectFile: string, knownPaths: string[]) =>
        projectFolder.scanAssets(projectFile, knownPaths ?? []));
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
    ipcMain.on(IPC.WINDOW_COMMAND, (e, cmd: WindowCommand) => {
        // Act on the window that ASKED, not on the main window. This handler used to resolve
        // getWindow() unconditionally, so the detached Docs window's close button (docs.tsx) closed
        // the EDITOR — and the crash-recovery ladder now rides this same channel, which is not a
        // place to keep a sender-blind handler. Fall back to the main window for a sender we cannot
        // resolve, which is the old behaviour for the only caller that ever relied on it.
        const win = BrowserWindow.fromWebContents(e.sender) ?? getWindow();
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
            // Keyboard zoom is one source of truth with the Preferences UI-scale slider: step + persist.
            case 'zoom-in': uiScale.stepUiScale(win, 0.1); break;
            case 'zoom-out': uiScale.stepUiScale(win, -0.1); break;
            case 'zoom-reset': uiScale.resetUiScale(win); break;
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
    // With a path, read it; without, ask. The path form serves BOOT-TIME RESTORE, which is the only
    // way a `--broadcast` machine is ever calibrated by a baked map: it renders no editor chrome, so
    // there is no import panel and no operator to answer a dialog. It is also what makes the whole
    // path testable without driving a native file picker.
    ipcMain.handle(IPC.MPCDI_IMPORT, async (e, path?: string) => {
        let file = path;
        if (!file) {
            const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined;
            const opts = { title: 'Import MPCDI', filters: [{ name: 'MPCDI', extensions: ['mpcdi'] }], properties: ['openFile' as const] };
            const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
            if (res.canceled || !res.filePaths[0]) return null;
            file = res.filePaths[0];
        }
        // A remembered path can go stale — the venue file moved, the drive is not mounted, someone
        // tidied up. Say so once and return null; the caller treats it exactly like a cancelled
        // dialog, so a show still boots and simply runs uncalibrated rather than failing to start.
        try { return { path: file, regions: parseMpcdi(readFileSync(file)) }; }
        catch (err) { console.warn(`[mpcdi] import failed (${file}):`, (err as Error)?.message ?? err); return null; }
    });

    // Poll native engine throughput stats ~1 Hz and push to the renderer.
    // The same numbers feed the Prometheus gauges (see ./metrics) — no extra polling.
    setInterval(() => {
        const stats = output.getStats();
        if (stats) getWindow()?.webContents.send(IPC.STATS, stats);
        metrics.updateEngineStats(stats);
        watchdog.noteEngineStats(stats); // output-down detector (only acts after the wire was live)
    }, 1000);
}
