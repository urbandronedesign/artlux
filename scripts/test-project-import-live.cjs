// Does cross-project import work in the REAL app? Run: npm run test:import:live
//
// scripts/test-project-import.ts covers the pure half — the closure, the remap, the validator — and it
// runs in a second with no Electron. This covers the half it cannot reach, which is the half that
// touches main:
//
//   1. `peekProject` round-trips a SECOND project and comes back with ABSOLUTE asset paths;
//   2. …WITHOUT disturbing the open show. This is the one that matters. openProjectTimed clears and
//      rebuilds the media allowlist from whatever it just read, so peeking through it would have
//      revoked the open project's media mid-session — and a refused path is indistinguishable
//      downstream from a file that will not decode (main/mediaAccess), so nothing would have said so.
//      The test proves the open project's own media still serves AND that the source project's media
//      was NOT silently admitted.
//   3. `importAssetPaths` copies media into the destination, byte-for-byte, and the handler admits
//      what it copied.
//
// Two real project folders on disk, one real PNG each, one real Electron. Nothing is mocked.
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9391';
const KEEP = process.argv.includes('--keep');
const WORK = path.join(os.tmpdir(), 'artlux-import-live');
const SRC = path.join(WORK, 'source-show');
const DEST = path.join(WORK, 'dest-show');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej);
});
let puppeteer = null;
try { puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core')); } catch { /* checked below */ }

let failures = 0;
const note = (ok, what, detail) => {
  if (!ok) failures++;
  console.log(`   ${ok ? '\x1b[32mOK\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${what}${detail ? `\n        ${detail}` : ''}`);
};

// A real 1x1 PNG — two DIFFERENT ones, so the byte-compare at the end is meaningful.
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

function buildProjects() {
  fs.rmSync(WORK, { recursive: true, force: true });
  for (const root of [SRC, DEST]) fs.mkdirSync(path.join(root, 'assets', 'images'), { recursive: true });

  fs.writeFileSync(path.join(SRC, 'assets', 'images', 'logo.png'), PNG_A);
  fs.writeFileSync(path.join(DEST, 'assets', 'images', 'house.png'), PNG_B);

  const scene = {
    id: 'sc_one', name: 'Opening', globalBrightness: 1, fixtures: [],
    // RELATIVE on disk, exactly as saveProject writes it — so a peek that forgot resolveAssets would
    // hand the renderer a path it cannot open, and assertion 1 would catch it.
    surfaces: [{
      id: 'S1', name: 'Wall', x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 0,
      content: { type: 'IMAGE', url: 'assets/images/logo.png' },
    }],
    timeline: { layers: [], clips: [], duration: 30, fps: 30, markers: [], automation: [] },
  };
  fs.writeFileSync(path.join(SRC, 'project.artlux'), JSON.stringify({
    version: '1.2', surfaces: [], fixtures: [], controllers: [], globalBrightness: 1,
    groups: [], scenes: [scene], cueBanks: [],
    stateMachine: {
      enabled: false, initialStateId: 'st_one', regions: [],
      states: [{ id: 'st_one', name: 'Opening', x: 0, y: 0, entry: [], sceneId: 'sc_one' }],
      transitions: [],
    },
    timeline: { layers: [], clips: [], duration: 60, fps: 30, markers: [], automation: [] },
    assets: [], projectorOutputs: [],
  }, null, 2));

  fs.writeFileSync(path.join(DEST, 'project.artlux'), JSON.stringify({
    version: '1.2',
    surfaces: [{
      id: 'D1', name: 'House', x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 0,
      content: { type: 'IMAGE', url: 'assets/images/house.png' },
    }],
    fixtures: [], controllers: [], globalBrightness: 1, groups: [], scenes: [], cueBanks: [],
    timeline: { layers: [], clips: [], duration: 60, fps: 30, markers: [], automation: [] },
    assets: [], projectorOutputs: [],
  }, null, 2));

  return path.join(DEST, 'project.artlux');
}

function launch(project) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // inheriting it boots Electron as plain Node (DEVELOPMENT.md)
  env.ARTLUX_CDP_PORT = CDP_PORT;
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--', `--project=${project}`],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  return child;
}

async function stop(child) {
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  try { execSync(process.platform === 'win32' ? 'taskkill /IM electron.exe /F /T' : 'pkill -f electron', { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(2000);
}

(async () => {
  if (!puppeteer) { console.error('puppeteer-core not installed — run npm install'); process.exit(1); }
  const destFile = buildProjects();
  const srcFile = path.join(SRC, 'project.artlux');
  const srcPng = path.join(SRC, 'assets', 'images', 'logo.png');
  const destPng = path.join(DEST, 'assets', 'images', 'house.png');

  const child = launch(destFile);
  let browser = null;
  try {
    let up = null;
    for (let i = 0; i < 90 && !up; i++) { await sleep(1000); try { up = JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json/version`)); } catch { /* not yet */ } }
    if (!up) throw new Error('the app never opened its CDP port');
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null });

    // Identify the editor by ELIMINATION — in dev it is served at http://localhost:3000/ with no
    // filename, so an "index.html" matcher finds nothing, and pages()[0] can be a projector window.
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      page = (await browser.pages()).find((p) => !/splash\.html|projector\.html|docs\.html/.test(p.url())) || null;
      if (!page) await sleep(1000);
    }
    if (!page) throw new Error('no editor page');
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => document.querySelectorAll('button').length > 0)) break;
      await sleep(1000);
    }

    // The media scheme's URL encoding, mirrored from shared/mediaUrl.ts (base64url of the path).
    const mediaFetch = (p) => page.evaluate(async (abs) => {
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(abs)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      try { const r = await fetch(`artlux-media://f/${b64}`); return r.status; }
      catch { return 0; }                       // a refused scheme request rejects rather than 403s
    }, p);

    console.log('\n[1] peekProject reads a second project');
    const peek = await page.evaluate((f) => window.artlux.peekProject(f), srcFile);
    note(!!peek && !!peek.data, 'peek returned a document', peek ? '' : 'got null');
    note(peek?.data?.scenes?.length === 1, 'the source scene came through');
    const url = peek?.data?.scenes?.[0]?.surfaces?.[0]?.content?.url || '';
    note(/^[a-zA-Z]:[\\/]/.test(url) || url.startsWith('/'),
      'asset paths are RESOLVED to absolute', `url = ${url}`);
    note(url.toLowerCase().endsWith('logo.png'), 'and still point at the right file');
    note(peek?.data?.stateMachine?.states?.length === 1, 'the state machine came through');

    console.log('\n[2] …and the open show is untouched by the peek');
    const destStatus = await mediaFetch(destPng);
    note(destStatus === 200, "the OPEN project's media still serves after a peek",
      `artlux-media:// returned ${destStatus} for house.png — a peek must not rebuild the allowlist`);
    const srcStatus = await mediaFetch(srcPng);
    note(srcStatus !== 200, "the SOURCE project's media was NOT admitted by peeking",
      `artlux-media:// returned ${srcStatus} for the un-imported logo.png`);

    console.log('\n[3] importAssetPaths copies the media in');
    const r = await page.evaluate((f, p) => window.artlux.importAssetPaths(f, [p]), destFile, srcPng);
    note(!!r, 'the bulk copy returned a result');
    const landed = r?.remap?.[srcPng];
    note(!!landed && landed !== srcPng, 'the source path was remapped into this project', `→ ${landed}`);
    note(!!landed && landed.toLowerCase().startsWith(DEST.toLowerCase()),
      'the copy landed inside the destination project folder', landed);
    note(r?.entries?.length === 1, 'one library row was minted for it');
    note(r?.copied === 1 && !r?.missing?.length, 'reported as copied, with nothing missing',
      `copied=${r?.copied} missing=${JSON.stringify(r?.missing)}`);

    console.log('\n[4] the bytes actually arrived, and the file is readable');
    const onDisk = landed && fs.existsSync(landed);
    note(!!onDisk, 'the copied file exists on disk', landed);
    note(!!onDisk && Buffer.compare(fs.readFileSync(landed), PNG_A) === 0,
      'and is byte-for-byte the source file');
    const copiedStatus = landed ? await mediaFetch(landed) : 0;
    note(copiedStatus === 200, 'the copied file serves over artlux-media://',
      `returned ${copiedStatus} — the handler must admit what it copied`);

    console.log('\n[5] a same-name but DIFFERENT file is suffixed, never de-duplicated onto');
    // uniqueDest's identity test is byte-exact for a reason: a name+size heuristic once remapped one
    // WAV onto another and reported success — a silent, self-certifying wrong-asset-on-stage.
    const clashDir = path.join(WORK, 'clash', 'assets', 'images');
    fs.mkdirSync(clashDir, { recursive: true });
    const clash = path.join(clashDir, 'logo.png');
    fs.writeFileSync(clash, PNG_B);                       // same NAME as the one already imported
    const r2 = await page.evaluate((f, p) => window.artlux.importAssetPaths(f, [p]), destFile, clash);
    const landed2 = r2?.remap?.[clash];
    note(!!landed2 && landed2 !== landed, 'a different file with the same name got its own path', landed2);
    note(!!landed2 && Buffer.compare(fs.readFileSync(landed2), PNG_B) === 0,
      'and kept its own bytes rather than being folded onto the first');
  } catch (e) {
    failures++;
    console.error('\n\x1b[31mERROR\x1b[0m', e && e.message ? e.message : e);
  } finally {
    if (browser) { try { await browser.disconnect(); } catch { /* already gone */ } }
    await stop(child);
    if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
    else console.log(`\nkept: ${WORK}`);
  }

  console.log(failures === 0 ? '\n\x1b[32mALL PASS\x1b[0m' : `\n\x1b[31m${failures} FAILURE(S)\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
})();
