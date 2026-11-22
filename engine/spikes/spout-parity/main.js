// E1d-3 Spout parity, the APP's side (driven by scripts/test-image-parity.cjs; not run on its own).
// Main does what the Spout plugin's main half does: the spout-receiver addon connects to the sender, and every
// poll's shared texture goes through the plugin's OWN `deliver` (plugins/spout/src/sharedTexture.main.ts,
// bundled as SPIKE_DELIVER) — importSharedTexture + sendSharedTexture. The preload turns it into a VideoFrame
// like the app's; the page (SPIKE_PAGE, engine/spikes/image-parity/page.ts) hands that to the real
// WebGPUMapper and quits when it has written SPIKE_OUT/gpu-cases.json.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 300, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const backstop = setTimeout(() => app.quit(), 110000);
  const spout = require(path.join(process.env.SPIKE_ROOT, 'native', 'spout-receiver', 'spout-receiver.node'));
  const { deliver } = require(process.env.SPIKE_DELIVER);
  let poll = null;
  win.on('closed', () => { clearTimeout(backstop); clearInterval(poll); try { spout.disconnect(); } catch { /* gone */ } app.quit(); });
  const html = path.join(process.env.SPIKE_OUT, 'page.html');
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>E1d-3 Spout parity</title>');
  await win.loadFile(html);
  win.webContents.on('console-message', (_e, _lvl, msg) => console.log(`[page] ${msg}`));
  spout.connect(process.env.SPIKE_SPOUT);
  // The plugin polls at the sender's rate (spoutManager); 60 Hz here — the picture is a still.
  poll = setInterval(() => { const s = spout.receiveShared(); if (s && !win.isDestroyed()) deliver(win, s); }, 16);
  await win.webContents.executeJavaScript(fs.readFileSync(process.env.SPIKE_PAGE, 'utf8'));
});
