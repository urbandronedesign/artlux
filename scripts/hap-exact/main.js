// Electron host for the HAP exactness harness. See scripts/test-hap-exact.cjs.
//
// Runs the NATIVE decoder in the main process, exactly as plugins/hap does, and hands a real frame to
// a renderer window that uploads it through the REAL hapGL. Two layers, two different questions: main
// answers "does index N give frame N, every time"; the renderer answers "what actually reaches a
// drawable" — which, for alpha, is the only answer that counts, because the bake reads that drawable.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const FILE = process.argv[2];
const ADDON = path.join(__dirname, '..', '..', 'native', 'hap', 'hap.node');
const problems = [];

function bail(msg) {
  console.log('  FAIL ' + msg);
  console.log('\n1 FAILED\n');
  app.exit(1);
}

app.whenReady().then(async () => {
  if (!FILE || !fs.existsSync(FILE)) return bail('no HAP file given (pass a path, or set ARTLUX_HAP)');

  let hap;
  try { hap = require(ADDON); } catch (e) { return bail('native hap addon did not load: ' + e.message); }

  let info;
  try { info = hap.open(FILE); } catch (e) { return bail('open threw: ' + e.message); }
  if (!info) return bail('open returned null — not a HAP file, or a variant this build cannot read');
  console.log('  info  ' + JSON.stringify(info));

  const n = info.frameCount;
  if (!(n > 0) || !(info.fps > 0)) problems.push('probe gave frameCount=' + n + ' fps=' + info.fps);

  // Indices chosen to make ORDER matter. A decoder that quietly serves "whatever is in the ring"
  // passes a forward pass and fails the moment the caller goes back — which is the failure the mp4
  // path actually had, and the reason frameExact exists at all.
  const pick = [...new Set([0, 1, 2, Math.floor(n / 3), Math.floor(n / 2), n - 2, n - 1])]
    .filter((i) => i >= 0 && i < n)
    .sort((a, b) => a - b);

  // Sampled FNV — every 97th byte. A full hash of a 4K frame buys nothing here: we are separating
  // "a different picture" from "the same picture", not authenticating bytes.
  const hashOf = (buf) => {
    let h = 2166136261;
    for (let i = 0; i < buf.length; i += 97) { h ^= buf[i]; h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  };

  const decode = async (idx) => {
    let f = null;
    try { f = await hap.decodeFrame(FILE, idx); } catch { return null; }
    if (!f || !f.data) return null;
    return { idx, format: f.format, width: f.width, height: f.height, bytes: f.data.length, hash: hashOf(f.data), data: f.data };
  };

  const forward = [];
  for (const i of pick) {
    const r = await decode(i);
    if (!r) problems.push('forward: index ' + i + ' decoded null');
    else forward.push(r);
  }
  const backward = [];
  for (const i of [...pick].reverse()) {
    const r = await decode(i);
    if (!r) problems.push('backward: index ' + i + ' decoded null');
    else backward.push(r);
  }

  // 1. ORDER-INDEPENDENCE — the property frameExact is for.
  let orderIndependent = true;
  for (const b of backward) {
    const f = forward.find((x) => x.idx === b.idx);
    if (f && f.hash !== b.hash) {
      orderIndependent = false;
      problems.push('index ' + b.idx + ' decoded DIFFERENTLY on the way back (' + f.hash + ' vs ' + b.hash + ') — frameExact is order-dependent');
    }
  }

  // 2. DISTINCTNESS — a decoder ignoring its index hands back one picture for every time. Reported
  //    rather than asserted: on genuinely static material identical frames are correct, so this is a
  //    number a human reads, not a pass/fail the harness can decide alone.
  const distinct = new Set(forward.map((f) => f.hash)).size;

  // 3. PAST THE END IS REFUSED, NEVER CLAMPED. thumbnail() pins the index into range because a
  //    filmstrip wants *a* picture; a render must be told instead, or it bakes the last frame over
  //    and over — which on a wall looks like a freeze and gets blamed on the encoder.
  let past = null;
  try { past = await hap.decodeFrame(FILE, n + 5); } catch { past = null; }
  if (past && past.data) problems.push('an index past the end returned a frame instead of null — a render would bake a freeze');

  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });

  ipcMain.on('gl', (_e, r) => {
    const declared = !!info.hasAlpha;
    const reached = !!(r && r.alphaReachesDrawable);
    console.log('  gl    ' + JSON.stringify(r));
    if (r && r.error) problems.push('GL upload failed: ' + r.error);

    // THE finding worth printing either way — what the container claims against what a drawable gets.
    if (declared && !reached) {
      console.log('  note  the container declares alpha (' + info.codec + ' / ' + info.format + ') but none reaches the drawable.');
      console.log('        A bake of this surface is opaque because the DECODER drops the alpha, not because the bake did:');
      console.log('        HapQ Alpha carries alpha in a second texture and this decoder keeps one texture per frame.');
    }
    // The inverse IS a fault: alpha that nothing declared means the upload invented it.
    if (!declared && reached) problems.push('alpha reached the drawable for a file that declares none — the upload is inventing it');

    for (const p of problems) console.log('  FAIL ' + p);
    console.log('  summary ' + JSON.stringify({
      codec: info.codec, format: info.format,
      declaresAlpha: declared, alphaReachesDrawable: reached,
      framesProbed: forward.length, distinctFrames: distinct, orderIndependent,
      refusesPastEnd: !(past && past.data),
    }));
    console.log(problems.length ? '\n' + problems.length + ' FAILED\n' : '\nall passed\n');
    // ⚠ app.exit(code), NEVER `process.exitCode = code` + app.quit(). Electron's quit path does not
  // carry process.exitCode, so a harness written that way prints FAIL and still exits 0 — it passes
  // every `&&` chain and every CI gate while testing nothing. Measured on this build, against a
  // deliberately broken harness: '1 FAILED' on stdout, exit code 0.
    setTimeout(() => app.exit(problems.length ? 1 : 0), 100);
  });

  w.webContents.on('console-message', (_e, _l, m) => { if (!/Security Warning/.test(String(m))) console.log('[renderer]', m); });
  await w.loadFile(path.join(__dirname, 'index.html'));

  const f0 = forward[0];
  w.webContents.send('frame', f0 ? { format: f0.format, width: f0.width, height: f0.height, data: f0.data } : null);

  setTimeout(() => { console.log('TIMEOUT'); app.exit(1); }, 60000);
});

app.on('window-all-closed', () => app.quit());
