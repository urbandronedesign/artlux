// Electron host for the matte-recombiner harness. See scripts/test-matte-gl.cjs.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
let done = false;
ipcMain.on('result', (_e, r) => {
  done = true;
  const ok = r && r.ok && r.alphaFollowsMatte && r.colourSideCorrect;
  console.log((ok ? '  ok   ' : '  FAIL ') + 'matteGL recombines colour + matte into correct RGBA');
  console.log('       ' + JSON.stringify(r));
  console.log(ok ? '\nall passed\n' : '\n1 FAILED\n');
  process.exitCode = ok ? 0 : 1;
  setTimeout(() => app.quit(), 100);
});
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  w.loadFile(path.join(__dirname, 'index.html'));
  w.webContents.on('console-message', (_e, _l, m) => { if (!/Security Warning/.test(String(m))) console.log('[renderer]', m); });
  setTimeout(() => { if (!done) { console.log('TIMEOUT'); process.exitCode = 1; app.quit(); } }, 60000);
});
app.on('window-all-closed', () => app.quit());
