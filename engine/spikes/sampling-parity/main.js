// E1b-2 GPU parity (driven by scripts/test-sampling-parity.cjs --gpu; not run on its own).
// Opens one page, runs the app's REAL WebGPUMapper in it (the bundled page.ts, SPIKE_PAGE), and quits
// when the page has written SPIKE_OUT/gpu-cases.json.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
// Extra Chromium switches for a diagnostic page (e.g. enable-privileged-webgl-extensions for the
// WEBGL_debug_shaders extension — engine/spikes/hlsl-dump), comma-separated.
for (const sw of (process.env.SPIKE_SWITCHES || '').split(',').filter(Boolean)) app.commandLine.appendSwitch(sw);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 300, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const backstop = setTimeout(() => app.quit(), 150000);
  win.on('closed', () => { clearTimeout(backstop); app.quit(); });
  // A file:// page, not about:blank: WebGPU exists only in a secure context, and the app's own pages are
  // file:// too.
  const path = require('node:path');
  const html = path.join(process.env.SPIKE_OUT, 'page.html');
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>E1b-2 sampling parity</title>');
  await win.loadFile(html);
  win.webContents.on('console-message', (_e, _lvl, msg) => console.log(`[page] ${msg}`));
  await win.webContents.executeJavaScript(fs.readFileSync(process.env.SPIKE_PAGE, 'utf8'));
});
