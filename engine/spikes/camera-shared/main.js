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
  // FP_LIB: the app's cameraFingerprint.ts, bundled (global camFp) — the fingerprint is the app's own code.
  if (process.env.FP_LIB) await win.webContents.executeJavaScript(fs.readFileSync(process.env.FP_LIB, 'utf8'));
  await win.webContents.executeJavaScript(`(async () => {
    const fs = require('fs'), path = require('path');
    const st = { frames: 0, holding: false, settings: null, error: null, t: 0, times: [] };
    const t0 = performance.now();
    const write = () => { st.t = performance.now() - t0; fs.writeFileSync(path.join(${JSON.stringify(OUT)}, 'holder.json'), JSON.stringify(st)); };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      const track = stream.getVideoTracks()[0];
      st.settings = track.getSettings(); st.holding = true;
      // What the app knows of the camera it holds: the track's label, and every video input as Chromium lists it.
      st.label = track.label;
      st.devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').map((d) => ({ label: d.label, deviceId: d.deviceId, groupId: d.groupId }));
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      // DUMP_FRAMES=n: after the first second, the next n frames as the app has them — the VideoFrame's planes
      // (copyTo), its format + colour space + timestamp, and the picture drawn 1:1 into a 2D canvas (the
      // atlas's kind of draw) — f<k>.json / .planes.bin / .rgba.bin.
      const dumpN = ${Number(process.env.DUMP_FRAMES || 0)};
      let dumped = 0;
      const draw = (vf, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(vf, 0, 0, w, h); return new Uint8Array(x.getImageData(0, 0, w, h).data.buffer); };
      (async () => { for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        st.frames++; st.times.push(Math.round(performance.now() - t0));
        // The app's fingerprint, kept FRESH (every ~0.5 s): a resolve compares it with what the engine reads now.
        if (window.camFp && performance.now() - t0 > 2000 && performance.now() - (st.fpAt ?? 0) > 500) { st.fp = await camFp.frameFingerprint(value); st.fpAt = performance.now(); }
        if (dumped < dumpN && performance.now() - t0 > ${Number(process.env.DUMP_AFTER_MS || 1000)}) {
          const k = dumped++;
          const rect = { x: 0, y: 0, width: value.codedWidth, height: value.codedHeight };
          const buf = new Uint8Array(value.allocationSize({ rect }));
          const layout = await value.copyTo(buf, { rect });
          const v = value.visibleRect;
          fs.writeFileSync(path.join(${JSON.stringify(OUT)}, 'f' + k + '.planes.bin'), buf);
          fs.writeFileSync(path.join(${JSON.stringify(OUT)}, 'f' + k + '.rgba.bin'), draw(value, value.displayWidth, value.displayHeight));
          fs.writeFileSync(path.join(${JSON.stringify(OUT)}, 'f' + k + '.json'), JSON.stringify({ coded: [value.codedWidth, value.codedHeight], visible: [v.x, v.y, v.width, v.height],
            display: [value.displayWidth, value.displayHeight], format: value.format, colorSpace: value.colorSpace.toJSON(), layout, timestamp: value.timestamp, at: performance.now() - t0 }));
        }
        value.close();
      } })();
      const tick = setInterval(write, 250);
      setTimeout(() => { track.stop(); st.holding = false; st.stoppedAt = Math.round(performance.now() - t0); write(); }, ${HOLD * 1000});
      setTimeout(() => { clearInterval(tick); write(); window.close(); }, ${(HOLD + POST) * 1000});
    } catch (e) { st.error = String(e && e.message || e); write(); window.close(); }
  })()`);
});
