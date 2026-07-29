// Documentation invariants — the docs half of `npm run verify`.
//
//   node scripts/verify-docs.cjs
//
// Sibling of verify-invariants.cjs, and built on the same premise: every check below encodes a bug that
// SHIPPED, where nothing threw, no type was violated, and the only symptom was an operator reading
// something untrue. A typechecker cannot see any of this, because prose is not code.
//
// The four that were live in the tree on 2026-07-29, when this file was written:
//   - scripts/build-docs-html.cjs's hand-kept PAGES list ended at '13-keyboard-reference.md', a file that
//     does not exist — so the built user guide silently dropped the Tracking and Show/state-machine
//     chapters. Its own comment predicted this exact failure, in capitals, and it happened anyway.
//   - docs/user-guide/15-keyboard-reference.md documented a static shortcut list that docs/SHORTCUTS.md
//     says was replaced by a rebindable registry — while being edited as recently as four days earlier.
//   - src/main/docs.ts shipped ARCHITECTURE / DEVELOPMENT / PLUGINS / SDK into the operator's in-app
//     sidebar. It had carefully excluded PROGRESS and ROADMAP, then let those four through.
//   - /scene/recall and /cue/fire were handled by src/renderer/services/oscController.ts and documented
//     in no file at all.
//
// The rule these enforce (plans/documentation-wiki.md): docs/manifest.json is the ONE index, derived data
// is generated rather than re-typed, and anything a doc asserts about the UI must still exist in source.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'docs', 'manifest.json');

const errors = [];
const checks = [];
const fail = (check, msg) => errors.push(`${check}: ${msg}`);
const pass = (label) => checks.push(label);

const read = (p) => fs.readFileSync(p, 'utf8');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const exists = (p) => fs.existsSync(p);

const manifest = JSON.parse(read(MANIFEST).replace(/^\s*"\$comment"[\s\S]*?\],\s*$/m, ''));
const GUIDE_DIR = path.join(ROOT, ...manifest.guideDir.split('/'));

// ── 1. The manifest and the tree agree ────────────────────────────────────────────────────────────────
// Both directions. A file listed but absent is the build-docs-html bug; a file present but unlisted is a
// chapter that will be silently missing from the guide, the sidebar and the search index.
{
  const onDisk = fs.readdirSync(GUIDE_DIR).filter((f) => f.endsWith('.md'));
  const listed = new Set(manifest.guide);
  const excluded = new Set(manifest.guideExclude || []);

  for (const f of manifest.guide) {
    if (!exists(path.join(GUIDE_DIR, f))) {
      fail('manifest', `${manifest.guideDir}/${f} is listed in docs/manifest.json but does NOT exist on disk`);
    }
  }
  for (const f of onDisk) {
    if (!listed.has(f) && !excluded.has(f)) {
      fail('manifest', `${manifest.guideDir}/${f} exists but is in neither "guide" nor "guideExclude" — add it`);
    }
  }

  const refDir = path.join(ROOT, 'docs');
  const refOnDisk = fs.readdirSync(refDir).filter((f) => f.endsWith('.md'));
  for (const f of refOnDisk) {
    if (!manifest.reference[f]) {
      fail('manifest', `docs/${f} has no audience tag in docs/manifest.json (usage | hybrid | code)`);
    }
  }
  for (const f of Object.keys(manifest.reference)) {
    if (!exists(path.join(refDir, f))) fail('manifest', `docs/${f} is tagged in the manifest but does not exist`);
  }
  const valid = new Set(['usage', 'hybrid', 'code']);
  for (const [f, tag] of Object.entries(manifest.reference)) {
    if (!valid.has(tag)) fail('manifest', `docs/${f} has an unknown audience tag "${tag}"`);
  }
  pass(`docs/manifest.json matches the tree (${manifest.guide.length} chapters, ${Object.keys(manifest.reference).length} reference pages)`);
}

// ── 2. No contributor page reaches the operator's in-app sidebar ──────────────────────────────────────
// The in-app Docs Browser is what a venue tech reads offline, at night, with no internet. It is not the
// place to hand someone the plugin SDK reference. Checked by literal presence rather than by parsing the
// list, so it holds whether src/main/docs.ts hardcodes its nav or derives it from the manifest.
{
  const src = read(path.join(ROOT, 'src', 'main', 'docs.ts'));
  const code = Object.entries(manifest.reference).filter(([, t]) => t === 'code').map(([f]) => f);
  for (const f of code) {
    if (src.includes(`'${f}'`) || src.includes(`"${f}"`)) {
      fail('audience', `src/main/docs.ts names ${f}, which is tagged "code" — contributor docs must not be reachable from the operator sidebar`);
    }
  }
  // The loop above is VACUOUS while docs.ts derives its nav (it names no file at all) — it exists to
  // catch a future hand-rolled list, which is how the four dev pages got in the first time. So the
  // mechanism itself is asserted too: without these, someone could delete the derivation and the loop
  // above would keep passing over an empty sidebar.
  if (!src.includes('manifest.json')) fail('audience', 'src/main/docs.ts no longer reads docs/manifest.json — the operator sidebar has stopped being derived');
  if (!/!==\s*'code'/.test(src)) fail('audience', "src/main/docs.ts no longer filters out the 'code' audience");
  pass(`no "code"-tagged page is reachable from the in-app operator sidebar (${code.length} excluded, nav derived from the manifest)`);
}

// ── 3. Every relative markdown link resolves ──────────────────────────────────────────────────────────
// Nineteen dead cross-links once shipped at the same time, and the in-app browser's click handler
// SWALLOWED every one of them (`if (match) load(match)`, with no else). A dead link inside the app is
// invisible: nothing happens, and the reader assumes they mis-clicked.
{
  const roots = ['docs', 'plans', 'examples'];
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'archive' && e.name !== 'node_modules') walk(p); }
      else if (e.name.endsWith('.md')) files.push(p);
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));
  files.push(path.join(ROOT, 'CLAUDE.md'), path.join(ROOT, 'README.md'));

  let n = 0;
  for (const f of files) {
    const body = read(f);
    for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const href = m[1];
      if (/^(https?:|mailto:|#)/.test(href)) continue;
      const target = href.split('#')[0];
      if (!target) continue;
      // Markdown and images only. Deliberately NOT source-code links: the plans/ set cites code as
      // `src/renderer/App.tsx#L1200` from a file in plans/, which is a repo-root path rather than a
      // relative one, and rewriting ~50 of those in contributor scratch notes is not what this gate is
      // for. Doc-to-doc and doc-to-image links are what an operator actually clicks.
      if (!/\.(md|png|svg|jpg|jpeg|gif|webp)$/i.test(target)) continue;
      n++;
      const abs = path.resolve(path.dirname(f), target);
      if (!exists(abs)) fail('links', `${rel(f)} → ${href} does not exist`);
    }
  }
  pass(`every relative doc link resolves (${n} checked)`);
}

// ── 4. Generated blocks are current ───────────────────────────────────────────────────────────────────
// Delegated so there is exactly one implementation of "what should this block say".
{
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-docs-data.cjs'), '--check'], { stdio: 'pipe' });
    pass(`generated doc blocks regenerate identically (${(manifest.generated || []).length})`);
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.replace(/\x1b\[\d+m/g, '').trim();
    fail('generated', `a generated block is stale — run \`npm run docs:gen\`\n      ${out.split('\n').join('\n      ')}`);
  }
}

// ── 5. What the docs assert about the app still exists in the app ─────────────────────────────────────
// The OSC table and the effect list are hand-written on purpose (they carry argument types and knob
// behaviour the source does not have), so they are CHECKED both ways instead of generated. This is the
// check that found /scene/recall and /cue/fire handled in source and documented nowhere.
{
  const osc = read(path.join(ROOT, 'src', 'renderer', 'services', 'oscController.ts'));
  const inSource = new Set([...osc.matchAll(/case '(\/[a-z/]+)'/g)].map((m) => m[1])
    .concat([...osc.matchAll(/rest === '(\/[a-z/]+)'/g)].map((m) => m[1])));
  const doc = read(path.join(ROOT, 'docs', 'OSC.md'));
  const inDoc = new Set([...doc.matchAll(/`\/artlux(\/[a-z/]+)`/g)].map((m) => m[1]));

  for (const a of inSource) {
    if (!inDoc.has(a)) fail('osc', `oscController.ts handles /artlux${a} but docs/OSC.md does not document it`);
  }
  for (const a of inDoc) {
    if (!inSource.has(a)) fail('osc', `docs/OSC.md documents /artlux${a} but oscController.ts does not handle it`);
  }
  pass(`every documented OSC control address is handled, and vice-versa (${inSource.size})`);

  const fx = read(path.join(ROOT, 'src', 'renderer', 'gpu', 'effects.ts'));
  const names = [...(fx.match(/EFFECT_NAMES[^=]*=\s*\[([\s\S]*?)\]/) || ['', ''])[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const fxDoc = read(path.join(ROOT, 'docs', 'EFFECTS.md'));
  for (const nm of names) {
    if (!fxDoc.includes(`**${nm}**`)) fail('effects', `EFFECT_NAMES has "${nm}" but docs/EFFECTS.md never names it in bold`);
  }
  pass(`every effect in EFFECT_NAMES is documented (${names.length})`);
}

// ── 6. Every "▸" UI path in the guide still exists in the source ──────────────────────────────────────
// The guide points operators at real controls: "Preferences ▸ Edit shortcuts…", "View ▸ OSC Monitor".
// There are dozens, they are the highest-churn thing prose can assert, and a rename today breaks every
// one of them in total silence. Deliberately lenient — it matches the LABEL only, case-insensitively,
// anywhere in the renderer/main/plugin sources — because a false alarm here would get this check
// switched off, and a lenient check that runs beats a strict one that does not.
{
  const srcText = [];
  const walkSrc = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'dist', 'out', 'target'].includes(e.name)) walkSrc(p); }
      else if (/\.(ts|tsx)$/.test(e.name)) srcText.push(read(p));
    }
  };
  walkSrc(path.join(ROOT, 'src'));
  walkSrc(path.join(ROOT, 'plugins'));
  const haystack = srcText.join('\n').toLowerCase();

  const guideFiles = manifest.guide.map((f) => path.join(GUIDE_DIR, f));
  const seen = new Set();
  let n = 0;
  for (const f of guideFiles) {
    for (const m of read(f).matchAll(/▸\s*\*{0,2}([A-Za-z][A-Za-z0-9 /&'-]{2,40}?)\*{0,2}\s*(?=[▸,.)*\n]|$)/g)) {
      const label = m[1].trim().replace(/\s+/g, ' ');
      if (label.length < 3) continue;
      const key = `${rel(f)}::${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      n++;
      if (!haystack.includes(label.toLowerCase())) {
        fail('ui-paths', `${rel(f)} points at "▸ ${label}" — no such string in src/ or plugins/`);
      }
    }
  }
  pass(`every "▸ Control" path in the guide exists in source (${n} checked)`);
}

// ── 7. The two PROSE indexes still cover everything ───────────────────────────────────────────────────
// docs/manifest.json replaced the two MECHANICAL indexes (build-docs-html's PAGES and docs.ts's
// REFERENCE_PAGES). Two hand-written navigational tables remain because a human reads them as prose, not
// as data: CLAUDE.md's documentation index and the user guide's contents table. Both were complete on
// 2026-07-29 — this pins them there, so a new chapter cannot be invisible from the place people look.
{
  const claude = read(path.join(ROOT, 'CLAUDE.md'));
  for (const f of Object.keys(manifest.reference)) {
    if (!claude.includes(f)) fail('index', `docs/${f} is in no row of CLAUDE.md's documentation index`);
  }
  const guideReadme = read(path.join(GUIDE_DIR, 'README.md'));
  for (const f of manifest.guide) {
    if (f === 'README.md') continue;
    if (!guideReadme.includes(f)) fail('index', `${manifest.guideDir}/${f} is not linked from the guide's contents table`);
  }
  pass('the CLAUDE.md index and the guide contents table cover every page');
}

// ── 8. The manifest actually ships ────────────────────────────────────────────────────────────────────
// src/main/docs.ts derives the operator sidebar from docs/manifest.json at RUNTIME, so if the file does
// not reach the installer the sidebar silently falls back to showing every docs/*.md — contributor pages
// included, which is the bug check 2 exists to prevent. electron-builder's `filter` is a glob list, and
// dropping an entry from it fails silently in exactly the way verify-package-resources.cjs was written
// about. So the filter itself is an invariant.
{
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  const docsRes = (pkg.build?.extraResources || []).find((r) => r && r.from === 'docs');
  if (!docsRes) fail('packaging', 'package.json build.extraResources has no "docs" entry — the in-app docs would not ship at all');
  else if (docsRes.filter && !docsRes.filter.includes('manifest.json')) {
    fail('packaging', 'package.json ships docs/ without manifest.json — src/main/docs.ts needs it, and would silently fall back to listing contributor pages');
  } else pass('docs/manifest.json is packaged, so the operator sidebar cannot silently fall back');
}

// ── Report ────────────────────────────────────────────────────────────────────────────────────────────
for (const c of checks) console.log(`\x1b[32m✓\x1b[0m ${c}`);
if (errors.length) {
  console.error(`\n\x1b[31m✗ ${errors.length} documentation problem${errors.length === 1 ? '' : 's'}:\x1b[0m`);
  for (const e of errors) console.error(`  \x1b[31m•\x1b[0m ${e}`);
  console.error('\n  These are docs the app has outgrown. See plans/documentation-wiki.md.');
  process.exit(1);
}
console.log(`\n\x1b[32mdocumentation verification OK (${checks.length} checks)\x1b[0m`);
