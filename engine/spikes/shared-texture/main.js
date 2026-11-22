// E0c SPIKE (throwaway): the engine's frames in an Electron page through `sharedTexture` (Electron 42).
//
//   ELECTRON_RUN_AS_NODE= node_modules/electron/dist/electron.exe engine/spikes/shared-texture
//   env: ARTLUX_ENGINE (engine exe), SPIKE_SECONDS (default 6), SPIKE_OUT (results dir)
//
// Main spawns `artlux-engine --share <its own pid>`: the engine creates three shared D3D12 textures and
// DUPLICATES their NT handles into THIS process (Node cannot call DuplicateHandle). Main imports each
// once, then for every frame the engine announces, sends that slot's texture to the page, which draws the
// VideoFrame to a canvas, releases it, and says "drawn" — only then is the slot handed back to the engine.
// The page reports the pixels it actually received; main writes them to spike-result.json and quits.
const { app, BrowserWindow, sharedTexture, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ENGINE = process.env.ARTLUX_ENGINE || path.join(__dirname, '..', '..', 'target', 'release', 'artlux-engine.exe');
const SECONDS = Number(process.env.SPIKE_SECONDS || 6);
const OUT = process.env.SPIKE_OUT || __dirname;
// SPIKE_ISOLATED=1: the page sandboxed + context-isolated like ArtLux's, frames through the preload.
const ISOLATED = process.env.SPIKE_ISOLATED === '1';

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 680, height: 420, show: true, title: 'E0c shared texture spike', backgroundColor: '#202020',
    webPreferences: ISOLATED
      ? { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
      : { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, ISOLATED ? 'page-isolated.html' : 'page.html'));
  const stats = { slots: null, announced: 0, sent: 0, sendErrors: 0, drawn: 0 };
  const reports = [];
  let lastError = null;
  let imported = [];
  const eng = spawn(ENGINE, ['--share', String(process.pid), '--seconds', String(SECONDS)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const free = (slot) => { try { eng.stdin.write(JSON.stringify({ free: slot }) + '\n'); } catch { /* engine gone */ } };
  let buf = '';
  eng.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) onLine(JSON.parse(line)); }
  });
  function onLine(m) {
    if (m.type === 'slots') {
      stats.slots = { w: m.w, h: m.h, format: m.format, handles: m.handles };
      imported = m.handles.map((h) => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(h));
        return sharedTexture.importSharedTexture({
          textureInfo: { pixelFormat: 'bgra', codedSize: { width: m.w, height: m.h }, handle: { ntHandle: b } },
        });
      });
      console.log(`imported ${imported.length} shared textures ${m.w}x${m.h} (${m.handles.join(', ')})`);
    } else if (m.type === 'frame') {
      stats.announced++;
      const t = imported[m.slot];
      sharedTexture.sendSharedTexture({ frame: win.webContents.mainFrame, importedSharedTexture: t }, { n: m.n, slot: m.slot })
        .then(() => { stats.sent++; })
        .catch((e) => { stats.sendErrors++; lastError = String(e && e.message || e); free(m.slot); });
    }
  }
  ipcMain.on('drawn', (_e, r) => {
    stats.drawn++;
    if (r.report) reports.push(r.report);
    if (r.error) lastError = r.error;
    free(r.slot);
  });
  eng.on('exit', async (code) => {
    let shot = null;
    try { const img = await win.webContents.capturePage(); shot = path.join(OUT, 'spike-page.png'); fs.writeFileSync(shot, img.toPNG()); } catch (e) { lastError = lastError || String(e); }
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'spike-result.json'), JSON.stringify({ isolated: ISOLATED, engineExit: code, stats, reports, lastError, shot }, null, 2));
    for (const t of imported) { try { t.release(); } catch { /* already */ } }
    app.quit();
  });
});
