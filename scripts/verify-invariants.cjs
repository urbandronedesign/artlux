#!/usr/bin/env node
/*
 * Source-level invariant verifier — the rules that are load-bearing but invisible.
 *
 * Every check below encodes a bug we actually shipped and then had to hunt. They share a shape that
 * makes them expensive: the code still compiles, the app still boots, nothing throws, and the failure
 * shows up as "I can't select my fixtures" or "Art-Net stopped" — hours later, on someone's rig. A
 * typechecker cannot see any of them, so they are asserted here instead.
 *
 * This reads SOURCE, not the build, so it is instant and runs before `npm run build`.
 * Wired as `npm run verify:invariants`; also part of `npm run verify`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const raw = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

/*
 * Every check below reads CODE, never prose. This repo comments densely and those comments name the
 * very things being asserted ("two <Simulator3D> mounts", "see ledUnderPointer") — matching raw text
 * both reports mounts that do not exist AND lets a stale comment satisfy a check whose call has been
 * deleted, which is the worse failure of the two.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .split(/\r?\n/)
    .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); })
    .join('\n');
}
const read = (p) => stripComments(raw(p));

/** Every .ts/.tsx under a directory. */
function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** The body of `const <name> = (…) => { … }` — brace-matched, good enough for our handlers. */
function fnBody(src, name) {
  const i = src.indexOf(`const ${name} = `);
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  return null;
}

const checks = [];
const check = (name, why, fn) => checks.push({ name, why, fn });

// ── 3D: instanced meshes must refresh their bounding sphere ───────────────────────────────────
check(
  'InstancedMesh writes recompute boundingSphere',
  'THREE caches boundingSphere from the FIRST raycast and instanceMatrix.needsUpdate does NOT ' +
  'invalidate it, so the pickable region freezes wherever the instances were and later layout ' +
  'changes silently make objects unclickable.',
  () => {
    const bad = [];
    for (const f of walk('src/renderer')) {
      const src = read(f);
      if (src.includes('instanceMatrix.needsUpdate') && !src.includes('computeBoundingSphere')) bad.push(f);
    }
    return bad.length ? `writes instance matrices without computeBoundingSphere(): ${bad.join(', ')}` : null;
  },
);

// ── 3D: backdrop geometry must not swallow fixture picks ──────────────────────────────────────
check(
  '3D backdrop objects yield picks to fixtures',
  'Venue screens are large planes and fixtures sit ON them, so a screen is always nearer the ' +
  'camera. If its click handler calls stopPropagation() unconditionally, r3f (nearest-first) never ' +
  'reaches the fixture and fixtures become unselectable. Measured once at 648/649 clicks stolen.',
  () => {
    const bad = [];
    for (const f of ['src/renderer/components/Simulator3D/PlaneObject.tsx',
                     'src/renderer/components/Simulator3D/ModelObject.tsx']) {
      if (!exists(f)) { bad.push(`${f} (missing)`); continue; }
      const src = read(f);
      // The CALL, not the identifier: a leftover `import { ledUnderPointer }` would otherwise
      // satisfy this check after the guard itself had been deleted. (It did, first time out.)
      if (src.includes('stopPropagation') && !src.includes('ledUnderPointer(')) bad.push(f);
    }
    return bad.length ? `stopPropagation() without a ledUnderPointer() guard: ${bad.join(', ')}` : null;
  },
);

check(
  'fixtures have a pickable body',
  'The only pick target used to be an individual 12mm LED sphere — not something an operator can ' +
  'hit. FixtureBodies draws the housing that carries the click.',
  () => (exists('src/renderer/components/Simulator3D/FixtureBodies.tsx')
    ? null : 'src/renderer/components/Simulator3D/FixtureBodies.tsx is gone'),
);

// ── Selection: the two 3D selections must clear each other ────────────────────────────────────
check(
  'fixture/model selection is symmetric',
  'Simulator3D gates the fixture gizmo on `!selectedModelId`. If selecting a fixture does not clear ' +
  'the model, the click lands but nothing visibly happens — it reads as "fixtures cannot be selected".',
  () => {
    const src = read('src/renderer/App.tsx');
    const problems = [];
    const fix = fnBody(src, 'handleSelectFixture');
    const fixes = fnBody(src, 'handleSelectFixtures');
    const mod = fnBody(src, 'handleSelectModel');
    if (!fix || !mod || !fixes) return 'could not find handleSelectFixture / handleSelectFixtures / handleSelectModel in App.tsx';
    if (!fix.includes('setSelectedModelId')) problems.push('handleSelectFixture does not clear selectedModelId');
    if (!fixes.includes('setSelectedModelId')) problems.push('handleSelectFixtures does not clear selectedModelId');
    if (!mod.includes('setSelectedFixtureId')) problems.push('handleSelectModel does not clear the fixture selection');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Shell: context switching must carry the layout revision ───────────────────────────────────
check(
  'context switches go through goToContext()',
  'A banked layout slice wins over a context\'s declared layout, so the switch must carry layoutRev. ' +
  'Calling layoutStore.setContext directly means a shipped layout change silently never reaches an ' +
  'operator who already opened that context.',
  () => {
    const allowed = new Set(['src/renderer/services/layoutStore.ts', 'src/renderer/contexts/nav.ts']);
    const bad = walk('src/renderer')
      .filter((f) => !allowed.has(f) && read(f).includes('layoutStore.setContext('));
    return bad.length ? `calls layoutStore.setContext() directly: ${bad.join(', ')}` : null;
  },
);

// ── Shell: exactly one 3D scene ───────────────────────────────────────────────────────────────
check(
  'the scene3d viewport id is declared once',
  'WorkspaceShell keeps the 3D viewport out of the left pane by comparing against its own constant. ' +
  'A second, independently-declared copy of the id could drift, and Simulator3D would then mount in ' +
  'BOTH panes: two WebGL contexts, two render loops.',
  () => {
    const lit = "'core.viewport.scene3d'";
    const decls = walk('src/renderer').filter((f) => read(f).includes(lit));
    return decls.length === 1
      ? null
      : `the literal ${lit} appears in ${decls.length} files (${decls.join(', ')}) — it must be declared once and re-exported`;
  },
);

check(
  'only one <Simulator3D> mount site',
  'The 3D scene is a persistent viewport. A second mount means two WebGL contexts fighting over the ' +
  'same scene, which shows up as halved frame rate rather than an error.',
  () => {
    const sites = walk('src/renderer').filter((f) => /<Simulator3D[\s/>]/.test(read(f)));
    return sites.length === 1 ? null : `mounted in ${sites.length} files: ${sites.join(', ')}`;
  },
);

// ── Shell: the engine-critical viewports ──────────────────────────────────────────────────────
check(
  'Stage and TimelinePanel are mounted exactly once',
  'Stage publishes dmx:frame — unmounting it stops Art-Net mid-show. Two TimelinePanels double its ' +
  'keyboard hook and engine subscription. Both are passed to the shell as persistent elements.',
  () => {
    const problems = [];
    const stage = walk('src/renderer').filter((f) => /<Stage[\s\n]/.test(read(f)));
    // App renders Stage twice on purpose: the editor shell AND the headless/broadcast branch.
    if (stage.length !== 1) problems.push(`<Stage> appears in ${stage.length} files: ${stage.join(', ')}`);
    const tl = walk('src/renderer').filter((f) => /<TimelinePanel[\s/>]/.test(read(f)));
    if (tl.length !== 1) problems.push(`<TimelinePanel> appears in ${tl.length} files: ${tl.join(', ')}`);
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Shell: panels read state, they do not receive it ──────────────────────────────────────────
check(
  'EditorData is memoized',
  'Rebuilt per render it re-renders every panel through the React context and closes native <select> ' +
  'popups mid-interaction — the documented reason panels used to be individually memoized.',
  () => {
    const src = read('src/renderer/App.tsx');
    return /const editorData: EditorData = useMemo\(/.test(src)
      ? null : 'App.tsx must build `editorData` with useMemo (see state/EditorStore.tsx)';
  },
);

// ── UI: the interaction-state floor ───────────────────────────────────────────────────────────
check(
  'the interaction-state floor is overridable',
  'Every control in the app gets its hover/press from one base-layer rule in styles/index.css. ' +
  'Tailwind v3\'s @layer base is SOURCE ORDER, not a real cascade layer, so the rule only stays ' +
  'overridable because :where() weighs zero. Rewrite it as a plain selector and it silently outranks ' +
  'every hover:/active: utility in the app — nothing throws, the build is clean, and components stop ' +
  'being able to style their own states.',
  () => {
    const css = read('src/renderer/styles/index.css');
    const rules = css.match(/^.*no-press.*:(hover|active) \{$/gm) ?? [];
    if (rules.length !== 2) return `expected one :hover and one :active floor rule in index.css, found ${rules.length}`;
    const bare = rules.filter((r) => !/:where\(:not\(:disabled\)\)/.test(r) || !/^:where\(button,/.test(r.trim()));
    if (bare.length) return `floor rule is not fully wrapped in :where() — it would outrank component utilities:\n      ${bare.join('\n      ')}`;
    // The floor is inert unless it sits in the base layer.
    const base = css.slice(css.indexOf('@layer base'), css.indexOf('/* Scrollbars'));
    return base.includes('no-press') ? null : 'the floor rules must live inside @layer base';
  },
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.error(`\x1b[31m✗\x1b[0m ${m}`);

let failures = 0;
for (const c of checks) {
  let problem;
  try { problem = c.fn(); } catch (e) { problem = `check threw: ${e.message}`; }
  if (problem) { failures++; bad(`${c.name}\n    ${problem}\n    WHY: ${c.why}`); }
  else ok(c.name);
}
console.log('');
if (failures) {
  console.error(`\x1b[31minvariant verification: ${failures} failure(s)\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32minvariant verification OK (${checks.length} checks)\x1b[0m`);
