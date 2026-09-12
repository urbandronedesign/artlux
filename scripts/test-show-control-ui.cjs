// The SERVED tablet page, driven in a real browser against a stub that speaks the show-control
// protocol.
//
//   node scripts/test-show-control-ui.cjs [--head] [--shots=<dir>]
//
// WHY IT EXISTS. plugins/show-control/src/clientHtml.ts is the entire remote — markup, CSS and the
// client script — inside ONE template literal, so TypeScript checks none of it and the bundler is
// happy with anything. `verify:invariants` now catches a page that cannot parse, but "it parses" is
// a long way from "an operator can use it": every bug this file was written for was a live page
// behaving wrongly. A five-second status push rebuilding the form under a finger. A confirm sheet
// that set its state and drew nothing because only two tabs painted overlays. A scroll that snapped
// back to the top twice a second, which made every control below the fold unreachable.
//
// IT NEEDS NO ARTLUX. The stub speaks HTTP+SSE the way server.ts does, so this never contends for
// the editor's single-instance lock and can run while the app is open. For the half that only the
// real app can answer — the process actually exiting, the supervisor standing down, the rig going
// dark — see test-show-control.cjs.
//
// Requires a Chromium-family browser (found automatically, or set ARTLUX_TEST_BROWSER).

const http = require('node:http');
const { readFileSync, existsSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..');
const HEAD = process.argv.includes('--head');
const SHOTS = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const PORT = 8799;

// ─── prerequisites ──────────────────────────────────────────────────────────────────────────────
function findBrowser() {
  const env = process.env.ARTLUX_TEST_BROWSER;
  if (env) return existsSync(env) ? env : null;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

let puppeteer;
try { puppeteer = require(join(REPO, 'node_modules/puppeteer-core')); }
catch { console.error('puppeteer-core is not installed — run npm install'); process.exit(1); }

const BROWSER = findBrowser();
if (!BROWSER) {
  console.error('No Chromium-family browser found. Set ARTLUX_TEST_BROWSER to a chrome/edge binary.');
  process.exit(1);
}

// ─── the page under test, extracted the way the bundler would build it ──────────────────────────
// Evaluated rather than imported: clientHtml.ts is TypeScript, and all we want is the string it
// builds. The brand marks are stubbed — they are decoration and would drag in the whole asset chain.
function clientHtml() {
  const src = readFileSync(join(REPO, 'plugins/show-control/src/clientHtml.ts'), 'utf-8');
  const body = src.replace(/^import[\s\S]*?from\s+'[^']+';\s*$/m, '').replace(/\bexport const\b/g, 'const');
  // eslint-disable-next-line no-new-func
  return new Function('WORDMARK', 'ICON_MARK', body + '\nreturn CLIENT_HTML;')(
    { width: 100, height: 20, path: 'M0 0h10v10H0z' }, { png180: 'data:image/png;base64,' });
}

// ─── the stub app ───────────────────────────────────────────────────────────────────────────────
const PROJECTS = [
  { path: 'D:/Shows/Museum.artlux', name: 'Museum', isFolder: false, rel: '' },
  { path: 'D:/Shows/Hall A/hall-a.artlux', name: 'hall-a', isFolder: false, rel: 'Hall A' },
  { path: 'D:/Shows/Hall B/portable/project.artlux', name: 'portable', isFolder: true, rel: 'Hall B' },
];
const SCENES = [{ id: 's1', name: 'Opening' }, { id: 's2', name: 'Finale' }];
const BANKS = [{ id: 'b1', name: 'Main', rows: 1, cols: 8, sceneCells: [{ col: 0, sceneId: 's1' }],
  cues: Array.from({ length: 8 }, (_, i) => ({ id: 'c' + i, name: 'Cue ' + (i + 1), row: 0, col: i })) }];

const app = {
  locked: false,
  mode: 'broadcast',
  playlist: { enabled: false, folder: 'D:/Shows', entries: [] },
  schedule: [],
  scan: { root: 'D:/Shows', projects: PROJECTS, truncated: false },
  plStatus: { currentPath: 'D:/Shows/Museum.artlux', nextPath: null, nextAt: null, nextAtMs: null },
  log: [],
};
const clients = new Set();
const emit = (e) => { for (const r of clients) { try { r.write('data: ' + JSON.stringify(e) + '\n\n'); } catch { /* */ } } };
const snapshot = () => ({ scenes: SCENES, banks: BANKS, schedule: app.schedule, projectName: 'Stub',
  fsm: { enabled: true, initialStateId: 'st0', states: [{ id: 'st0', name: 'Idle' }], transitions: [] } });
let playhead = 0;
const statusEvent = () => ({ t: 'status', status: {
  playing: true, playhead: (playhead += 0.5), duration: 600, currentStateId: 'st0',
  stateElapsedSec: playhead, activeSceneId: 's1', lastFiredTransitionId: null, ts: Date.now() } });

const srv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML); return; }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(res);
    const push = (e) => res.write('data: ' + JSON.stringify(e) + '\n\n');
    push({ t: 'hello', locked: app.locked, mode: app.mode });
    push({ t: 'snapshot', snapshot: snapshot() });
    push(statusEvent());
    push({ t: 'playlist', playlist: app.playlist, status: app.plStatus });
    push({ t: 'projects', scan: app.scan });
    req.on('close', () => clients.delete(res));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const b = body ? JSON.parse(body) : {};
    app.log.push([url.pathname, b]);
    if (url.pathname === '/pair') return json(200, { token: 'T', name: 'Test' });
    // Everything below is a mutating action, and the operator Lock must cover all of it.
    if (app.locked) return json(423, { error: 'locked' });
    if (url.pathname === '/playlist') {
      app.playlist = b.playlist;
      emit({ t: 'playlist', playlist: app.playlist, status: app.plStatus });
      return json(200, { ok: true });
    }
    if (url.pathname === '/schedule') {
      app.schedule = b.schedule;
      emit({ t: 'snapshot', snapshot: snapshot() });
      return json(200, { ok: true });
    }
    if (url.pathname === '/scan') return json(200, { root: b.folder, projects: PROJECTS, truncated: false });
    return json(200, { ok: true });
  });
});
const HTML = clientHtml();

// THE THING THAT CAUSED THE WORST BUG: the app pushes status twice a second, forever, and the
// playlist scheduler pushes its own status every five. Neither carries anything the Control tab
// draws. If the page repaints on them, everything here about scrolling and typing falls over.
let beat = null;

// ─── assertions ─────────────────────────────────────────────────────────────────────────────────
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  await new Promise((r) => srv.listen(PORT, r));
  beat = setInterval(() => emit(statusEvent()), 500);

  const browser = await puppeteer.launch({
    executablePath: BROWSER, headless: HEAD ? false : 'new', args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 820, height: 1100 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // A 4xx answer logs a resource-load line; that is the server answering, not a page fault.
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

  const text = () => page.evaluate(() => document.body.innerText);
  const click = async (sel) => { await page.click(sel); await wait(250); };
  const shot = async (name, full = true) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name + '.png'), fullPage: full }); };
  const scrollTop = () => page.$eval('#main', (e) => e.scrollTop);
  const lastPost = (p) => app.log.filter(([x]) => x === p).pop();

  await page.goto(`http://127.0.0.1:${PORT}/?pin=1234`, { waitUntil: 'networkidle2' });
  await wait(800);

  console.log('\n[boot]');
  ok('auto-pairs from the QR\'s ?pin', !(await text()).includes('Pair this device'));
  ok('no page errors', errors.length === 0, errors.join(' | '));

  // ── Control ───────────────────────────────────────────────────────────────────────────────
  console.log('\n[Control]');
  let t = await text();
  ok('scenes are listed', t.includes('Opening') && t.includes('Finale'));
  ok('cue tiles are listed', (await page.$$('[data-act="cue"]')).length === 8);
  // Removed at the owner's request; the fireColumn COMMAND still exists, only the buttons went.
  ok('no per-column fire tiles', !/Column\s*\d/.test(t) && (await page.$$('[data-act="col"]')).length === 0);
  ok('a "This machine" section', /this machine/i.test(t));
  await shot('control');

  // ── Projects: the list, and the form that used to be wiped every 5 seconds ────────────────
  console.log('\n[Projects — the list arrives without being asked for]');
  await click('nav button:nth-child(4)');
  t = await text();
  ok('projects listed on arrival', t.includes('Museum') && t.includes('hall-a') && t.includes('portable'), t.slice(0, 200));
  ok('a subfolder is shown, so same-named shows are tellable apart', t.includes('Hall A'));
  ok('the folder field is pre-filled', (await page.$eval('#pl-folder', (e) => e.value)) === 'D:/Shows');

  console.log('\n[a repeated stream push no longer wipes what you are typing]');
  await page.$eval('#pl-folder', (e) => { e.focus(); e.setSelectionRange(e.value.length, e.value.length); });
  await page.type('#pl-folder', '/Extra');
  for (let i = 0; i < 3; i++) { emit({ t: 'playlist', playlist: app.playlist, status: app.plStatus }); await wait(120); }
  ok('typing survives three identical pushes', (await page.$eval('#pl-folder', (e) => e.value)) === 'D:/Shows/Extra',
    await page.$eval('#pl-folder', (e) => e.value));

  console.log('\n[schedule a project — one flow for add and edit]');
  await page.evaluate(() => [...document.querySelectorAll('[data-act="pl-add"]')]
    .find((x) => x.getAttribute('data-name') === 'hall-a').click());
  await wait(250);
  ok('the editor opened', (await page.$('.sheet')) !== null);
  ok('prefilled with that project', (await page.$eval('#ed-proj', (e) => e.value)).includes('hall-a'));
  await page.$eval('#ed-time', (e) => { e.value = '18:30'; });
  emit({ t: 'playlist', playlist: app.playlist, status: app.plStatus });
  await wait(200);
  ok('a push does not close the sheet', (await page.$('.sheet')) !== null);
  ok('nor discard the typed time', (await page.$eval('#ed-time', (e) => e.value)) === '18:30');

  await click('[data-act="ed-rep"][data-rep="once"]');
  ok('Once reveals a date field', (await page.$('#ed-date')) !== null);
  ok('the time survives the scheme switch', (await page.$eval('#ed-time', (e) => e.value)) === '18:30');
  await page.$eval('#ed-date', (e) => { e.value = '2026-09-19'; });
  await shot('editor');
  await click('[data-act="ed-save"]');

  let saved = lastPost('/playlist')[1].playlist.entries[0];
  ok('saved as a one-off on that date', saved.repeat === 'once' && saved.date === '2026-09-19', JSON.stringify(saved));
  ok('with the typed time', saved.time === '18:30');
  ok('and no stale weekdays', Array.isArray(saved.days) && saved.days.length === 0);
  ok('pointing at the right project', saved.projectPath === 'D:/Shows/Hall A/hall-a.artlux', saved.projectPath);
  ok('the row reads the scheme back', (await text()).includes('Once on 2026-09-19'));

  console.log('\n[editing changes only what you changed]');
  await click('[data-act="pl-edit"]');
  ok('reopens on the saved values', (await page.$eval('#ed-date', (e) => e.value)) === '2026-09-19');
  await page.$eval('#ed-time', (e) => { e.value = '21:15'; });
  await click('[data-act="ed-save"]');
  let edited = lastPost('/playlist')[1].playlist.entries;
  ok('still one entry — edited, not added', edited.length === 1, String(edited.length));
  ok('the time changed', edited[0].time === '21:15');
  ok('the project did not drift', edited[0].projectPath === 'D:/Shows/Hall A/hall-a.artlux');
  ok('the id is stable', edited[0].id === saved.id);

  await click('[data-act="pl-edit"]');
  await click('[data-act="ed-rep"][data-rep="weekly"]');
  await page.evaluate(() => { const b = document.querySelectorAll('#ed-days button'); b[1].click(); b[5].click(); });
  await click('[data-act="ed-save"]');
  const wk = lastPost('/playlist')[1].playlist.entries[0];
  ok('weekly keeps the two days', wk.repeat === 'weekly' && JSON.stringify(wk.days) === '[1,5]', JSON.stringify(wk));
  ok('and drops the one-off date', wk.date === undefined);
  ok('the row reads Mon Fri', (await text()).includes('Mon Fri'));
  await shot('playlist');

  await click('[data-act="pl-edit"]');
  await click('[data-act="ed-del"]');
  ok('delete empties the playlist', lastPost('/playlist')[1].playlist.entries.length === 0);

  console.log('\n[loading a project asks first, in the page]');
  await page.evaluate(() => document.querySelector('[data-act="pl-load"]').click());
  await wait(200);
  ok('an in-page confirm, never a browser dialog', (await text()).includes('Load a different project?'));
  let loads = app.log.filter(([p]) => p === '/playlist/load').length;
  await click('[data-act="ask-no"]');
  ok('Cancel loads nothing', app.log.filter(([p]) => p === '/playlist/load').length === loads);
  await page.evaluate(() => document.querySelector('[data-act="pl-load"]').click());
  await wait(150);
  await click('[data-act="ask-yes"]');
  ok('confirming loads it', app.log.filter(([p]) => p === '/playlist/load').length === loads + 1);

  console.log('\n[the project filter keeps the caret]');
  const many = Array.from({ length: 12 }, (_, i) => ({ path: 'D:/S/p' + i + '.artlux', name: 'Show ' + i, isFolder: false, rel: i % 2 ? 'Sub' : '' }));
  emit({ t: 'projects', scan: { root: 'D:/Shows', projects: many, truncated: true } });
  await wait(250);
  ok('a filter appears past eight projects', (await page.$('#pl-filter')) !== null);
  ok('truncation is stated, never silent', (await text()).includes('Stopped after 12'));
  await page.focus('#pl-filter');
  await page.type('#pl-filter', 'Show 1');
  ok('the caret stayed in the filter', (await page.evaluate(() => document.activeElement.id)) === 'pl-filter');
  t = await text();
  ok('and it filtered', t.includes('Show 1') && t.includes('Show 10') && !t.includes('Show 2'));

  // ── Schedule: adding used to look like nothing happened ───────────────────────────────────
  console.log('\n[Schedule]');
  await click('nav button:nth-child(3)');
  await click('[data-act="sched-new"]');
  ok('the action editor opened', (await page.$('#ed-act')) !== null);
  await page.select('#ed-act', 'scene:s2');
  await page.$eval('#ed-time', (e) => { e.value = '08:45'; });
  await click('[data-act="ed-save"]');
  await wait(300);
  t = await text();
  ok('the entry is VISIBLE right after Save', t.includes('08:45') && t.includes('Recall Finale'), t.slice(0, 300));
  const sc = lastPost('/schedule')[1].schedule[0];
  ok('saved as a scene recall', sc.action.kind === 'recallScene' && sc.action.ref === 's2', JSON.stringify(sc.action));
  await click('[data-act="sched-edit"]');
  ok('reopens on the right action', (await page.$eval('#ed-act', (e) => e.value)) === 'scene:s2');
  await click('[data-act="ed-cancel"]');

  // ── Power ─────────────────────────────────────────────────────────────────────────────────
  console.log('\n[Power — stopping the show from the room it is playing in]');
  await click('nav button:nth-child(1)');
  await click('[data-act="pw-shutdown"]');
  t = await text();
  ok('a confirm sheet', t.includes('Shut down ArtLux?'));
  ok('it says it will NOT come back', /will NOT start again by itself/i.test(t), t.slice(0, 400));
  ok('it says the rig goes dark', /the rig goes dark/i.test(t), t.slice(0, 400));
  ok('nothing sent yet', !app.log.some(([p]) => p === '/shutdown'));
  await shot('shutdown-confirm', false);
  await click('[data-act="ask-no"]');
  ok('Cancel sends nothing', !app.log.some(([p]) => p === '/shutdown'));

  await click('[data-act="pw-shutdown"]');
  await click('[data-act="ask-yes"]');
  ok('POST /shutdown', app.log.some(([p]) => p === '/shutdown'));
  t = await text();
  ok('the tablet says what happened', t.includes('Shutting down'), t.slice(0, 200));
  ok('and how it comes back', /Start ArtLux on the machine/i.test(t));
  emit(statusEvent()); await wait(300);
  ok('a late stream event does not dismiss it', (await text()).includes('Shutting down'));
  await click('[data-act="pw-back"]');
  ok('Back returns to the remote', /this machine/i.test(await text()));

  await click('[data-act="pw-restart"]');
  ok('restart has its own wording', (await text()).includes('Restart the app?'));
  await click('[data-act="ask-yes"]');
  ok('POST /restart', app.log.some(([p]) => p === '/restart'));
  ok('shows Restarting', (await text()).includes('Restarting'));
  for (const c of clients) { try { c.end(); } catch { /* */ } }
  clients.clear();
  await wait(4500); // EventSource reconnects on its own — that is the "it came back" signal
  ok('reconnecting puts the remote back', /this machine/i.test(await text()), (await text()).slice(0, 160));

  console.log('\n[the operator Lock covers the power actions too]');
  app.locked = true;
  await click('[data-act="pw-shutdown"]');
  await click('[data-act="ask-yes"]');
  await wait(400);
  ok('a locked remote does not claim to be shutting down', !(await text()).includes('Shutting down'));
  ok('it shows the lock instead', (await page.$eval('header .lock', (e) => e.className)).includes('show'));
  app.locked = false;

  // ── the scroll, on the screen this is actually used on ────────────────────────────────────
  console.log('\n[a phone — the controls below the fold must be reachable]');
  await page.setViewport({ width: 390, height: 720, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  // Enough scenes that the power card is well below the fold on a phone. Kept in a variable because
  // the "a real change still repaints" step below has to ADD to this list: pushing a SHORTER page
  // would clamp the scroll legitimately and the assertion would be measuring its own fixture.
  const manyScenes = Array.from({ length: 10 }, (_, i) => ({ id: 'sc' + i, name: 'Scene ' + (i + 1) }));
  emit({ t: 'snapshot', snapshot: { ...snapshot(), scenes: manyScenes } });
  await wait(600);
  const max = await page.$eval('#main', (e) => e.scrollHeight - e.clientHeight);
  ok('the page really does scroll', max > 100, String(max));
  await page.$eval('#main', (e) => { e.scrollTop = e.scrollHeight; });
  const landed = await scrollTop();
  ok('the scroll takes', landed > 100, String(landed));
  await wait(3000); // six status pushes
  ok('and holds under a 2 Hz stream (it used to snap to 0)', (await scrollTop()) === landed,
    `was ${landed}, now ${await scrollTop()}`);
  ok('so Shut down is on screen and hittable', await page.$eval('[data-act="pw-shutdown"]', (e) => {
    const r = e.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  }));
  await shot('phone', false);

  const before = await scrollTop();
  emit({ t: 'snapshot', snapshot: { ...snapshot(), scenes: [...manyScenes, { id: 'sx', name: 'Encore' }] } });
  await wait(600);
  ok('a REAL change still repaints', (await text()).includes('Encore'));
  ok('and the scroll survives that too', Math.abs((await scrollTop()) - before) < 60,
    `was ${before}, now ${await scrollTop()}`);
  await click('nav button:nth-child(4)');
  ok('switching tab starts at the top', (await scrollTop()) === 0);

  ok('still no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  clearInterval(beat);
  srv.close();
  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { clearInterval(beat); console.error(e); process.exit(1); });
