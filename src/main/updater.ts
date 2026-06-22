import { app, ipcMain, shell, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { IPC, type UpdateEvent } from '../../shared/protocol';

// User-gated auto-update via electron-updater (GitHub Releases provider). Nothing
// downloads or installs without an explicit renderer request: autoDownload is off,
// the renderer prompts on `available`, the user accepts → downloadUpdate(), then on
// `downloaded` the user accepts again → quitAndInstall().
//
// Platforms: Windows (NSIS) and Linux (AppImage) update in place. macOS needs a
// Developer ID signature for Squirrel.Mac (we only ad-hoc sign), so there we emit a
// `manual` event and point the user at the Releases page instead.

const { autoUpdater } = electronUpdater;
const RELEASES_URL = 'https://github.com/urbandronedesign/artlux/releases/latest';

export function setupUpdater(getWindow: () => BrowserWindow | null): void {
  const send = (e: UpdateEvent) => getWindow()?.webContents.send(IPC.UPDATE_EVENT, e);
  const fail = (err: unknown) => send({ status: 'error', message: String((err as Error)?.message ?? err) });

  // In-place updates only apply to packaged, non-macOS builds.
  const supported = app.isPackaged && process.platform !== 'darwin';

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => send({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send({ status: 'not-available' }));
  autoUpdater.on('download-progress', (p) => send({ status: 'progress', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send({ status: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => fail(err));

  ipcMain.on(IPC.UPDATE_CHECK, () => {
    if (!app.isPackaged) { send({ status: 'not-available' }); return; } // dev: no metadata
    if (!supported) { send({ status: 'manual', url: RELEASES_URL }); return; }
    autoUpdater.checkForUpdates().catch(fail);
  });

  ipcMain.on(IPC.UPDATE_DOWNLOAD, () => {
    if (!supported) { shell.openExternal(RELEASES_URL); return; }
    autoUpdater.downloadUpdate().catch(fail);
  });

  ipcMain.on(IPC.UPDATE_INSTALL, () => {
    if (!supported) { shell.openExternal(RELEASES_URL); return; }
    autoUpdater.quitAndInstall();
  });

  // Quietly check shortly after launch; the renderer only surfaces a prompt if an
  // update is actually available.
  if (supported) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => { /* offline — ignore */ }), 4000);
  }
}
