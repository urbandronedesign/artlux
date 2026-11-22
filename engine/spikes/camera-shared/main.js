// Item 2d (driven by scripts/test-camera-shared.cjs; not run on its own): a CAMERA HOLDER that opens the camera
// exactly as the app does (services/contentSource.ts startCamera: getUserMedia, ideal 1280×720, frames through
// a MediaStreamTrackProcessor), so the engine's shared reader can be measured beside a real Chromium holder.
// Writes SPIKE_OUT/holder.json every 250 ms: frames so far, the track's settings, and whether it still holds.
// Holds for HOLD_SECS, then STOPS the track (the "app closed its camera" case) and stays up POST_SECS more.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const OUT = process.env.SPIKE_OUT;
const HOLD = Number(process.env.HOLD_SECS || 10);
const POST = Number(process.env.POST_SECS || 0);
app.whenReady().then(async () => {
  // The app's main process grants 'media' the same way (src/main/index.ts).
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);
  const win = new BrowserWindow({ width: 320, height: 200, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const backstop = setTimeout(() => app.quit(), (HOLD + POST + 30) * 1000);
  win.on('closed', () => { clearTimeout(backstop); app.quit(); });
  const html = path.join(OUT, 'holder.html');
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>camera holder</title>');
  await win.loadFile(html);
  win.webContents.on('console-message', (_e, _lvl, msg) => console.log(`[holder] ${msg}`));
  await win.webContents.executeJavaScript(`(async () => {
    const fs = require('fs'), path = require('path');
    const st = { frames: 0, holding: false, settings: null, error: null, t: 0, times: [] };
    const t0 = performance.now();
    const write = () => { st.t = performance.now() - t0; fs.writeFileSync(path.join(${JSON.stringify(OUT)}, 'holder.json'), JSON.stringify(st)); };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      const track = stream.getVideoTracks()[0];
      st.settings = track.getSettings(); st.holding = true;
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; st.frames++; st.times.push(Math.round(performance.now() - t0)); value.close(); } })();
      const tick = setInterval(write, 250);
      setTimeout(() => { track.stop(); st.holding = false; st.stoppedAt = Math.round(performance.now() - t0); write(); }, ${HOLD * 1000});
      setTimeout(() => { clearInterval(tick); write(); window.close(); }, ${(HOLD + POST) * 1000});
    } catch (e) { st.error = String(e && e.message || e); write(); window.close(); }
  })()`);
});
