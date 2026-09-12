// Electron host for the frame-exact harness. See scripts/test-frame-exact.cjs for what this proves.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
let done = false;
ipcMain.on('result', (_e, r) => {
  done = true;
  console.log(r.text);
  process.exitCode = r.failed ? 1 : 0;
  setTimeout(() => app.quit(), 100);
});
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  w.loadFile(path.join(__dirname, 'index.html'));
  // Surfaced so a failure inside the page is visible instead of looking like a hang.
  w.webContents.on('console-message', (_e, _l, m) => { if (!/Security Warning/.test(String(m))) console.log('[renderer]', m); });
  setTimeout(() => { if (!done) { console.log('TIMEOUT - the harness never reported'); process.exitCode = 1; app.quit(); } }, 180000);
});
app.on('window-all-closed', () => app.quit());
