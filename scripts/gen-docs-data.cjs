// Generate the DERIVED parts of the documentation from source, into marked blocks.
//
//   node scripts/gen-docs-data.cjs           write the blocks (npm run docs:gen)
//   node scripts/gen-docs-data.cjs --check   fail if any block is out of date (used by verify-docs)
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────────────
// docs/user-guide/15-keyboard-reference.md was a hand-typed table of shortcuts. It was edited as recently
// as 2026-07-28 and was STILL wrong: it documented a static key list that `docs/SHORTCUTS.md` itself says
// was replaced by a rebindable registry, and it never mentioned that shortcuts can be rebound at all. It
// was not a neglected file — it was maintained, and still wrong. A human re-typing data that already
// lives in a registry loses that race every time, because nothing tells them the registry moved.
//
// So the rule (plans/documentation-wiki.md → "Keeping it true while the app moves"): never hand-write
// what the source already knows. The keyboard tables are OUTPUT now. Editing them by hand is a build
// failure, not a merge conflict waiting to happen.
//
// ── WHAT IS *NOT* GENERATED, AND WHY THAT IS DELIBERATE ───────────────────────────────────────────────
// Generation is only correct where the source holds ALL the information the reader needs. Two doc tables
// deliberately stay hand-written and are CHECKED instead (see verify-docs.cjs):
//   - docs/OSC.md's address table carries argument types and prose the switch statement does not have;
//   - docs/EFFECTS.md explains what each effect's speed/intensity knob does, while `EFFECT_NAMES` is a
//     bare string[]. Generating either would DELETE information to gain freshness. Checking gets both.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

// ── Parsing the shortcut registry ─────────────────────────────────────────────────────────────────────
// A regex, not a TS import: this script runs under plain node in `npm run verify`, long before any
// bundler exists in the pipeline, and the registry is deliberately one-object-literal-per-line (it is
// meant to be read as a table). If that formatting ever changes, this throws loudly rather than silently
// emitting a short table — an empty parse is the one failure mode that would put us back where we
// started, so it is an error, not a warning.
function parseShortcuts() {
  const file = path.join(ROOT, 'src', 'renderer', 'shortcuts', 'registry.ts');
  const src = fs.readFileSync(file, 'utf8');
  const arr = src.match(/export const SHORTCUT_DEFS[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!arr) throw new Error(`gen-docs-data: could not find SHORTCUT_DEFS in ${rel(file)}`);

  const defs = [];
  for (const line of arr[1].split('\n')) {
    if (!/^\s*\{/.test(line)) continue;                      // skip comments and blank lines
    const pick = (k) => (line.match(new RegExp(`\\b${k}:\\s*'([^']*)'`)) || [])[1];
    const bindings = (line.match(/defaultBinding:\s*\[([^\]]*)\]/) || [])[1];
    const def = {
      id: pick('id'),
      label: pick('label'),
      category: pick('category'),
      scope: pick('scope'),
      description: pick('description'),
      bindings: bindings ? [...bindings.matchAll(/'([^']+)'/g)].map((m) => m[1]) : [],
    };
    if (!def.id || !def.label || !def.bindings.length) {
      throw new Error(`gen-docs-data: unparsable SHORTCUT_DEFS row in ${rel(file)}:\n  ${line.trim()}`);
    }
    defs.push(def);
  }
  if (!defs.length) throw new Error(`gen-docs-data: parsed 0 shortcuts from ${rel(file)} — the format changed`);
  return defs;
}

// Human headings for the listener scopes. The scope is not cosmetic: conflict detection is
// per-scope, so a timeline key may legitimately reuse a global one, and the reader needs to know WHEN a
// key is live. Anything added to ShortcutScope without a heading here fails the build.
const SCOPES = {
  global: ['Global', 'Live anywhere in the editor, and suppressed while you are typing in a field.'],
  timeline: ['Timeline', 'Live only while the timeline drawer is hovered or focused (`Ctrl+T` opens it).'],
  scene3d: ['3D scene', 'Live only while the pointer is over the 3D viewport.'],
  stategraph: ['Show state-graph editor', 'Live only while the Show graph has focus.'],
  projector: ['Projector window', "Live only in a projector window's warp-edit mode."],
};

function renderKeymap(defs) {
  const out = [];
  for (const scope of Object.keys(SCOPES)) {
    const rows = defs.filter((d) => d.scope === scope);
    if (!rows.length) continue;
    const [title, blurb] = SCOPES[scope];
    out.push(`### ${title}`, '', blurb, '');
    // Category order follows first appearance in the registry, so the doc reads in the order the
    // registry is grouped rather than alphabetically — the grouping there is editorial and worth keeping.
    const cats = [...new Set(rows.map((r) => r.category))];
    for (const cat of cats) {
      out.push(`**${cat}**`, '', '| Shortcut | Action |', '|---|---|');
      for (const r of rows.filter((x) => x.category === cat)) {
        const keys = r.bindings.map((b) => `\`${b}\``).join(' or ');
        const note = r.description ? ` — ${r.description.replace(/\.$/, '')}` : '';
        out.push(`| ${keys} | ${r.label}${note} |`);
      }
      out.push('');
    }
  }
  const unknown = defs.filter((d) => !SCOPES[d.scope]);
  if (unknown.length) {
    throw new Error(`gen-docs-data: shortcut scope(s) with no heading in SCOPES: ${[...new Set(unknown.map((d) => d.scope))].join(', ')}`);
  }
  return out.join('\n').trimEnd();
}

// ── Block replacement ─────────────────────────────────────────────────────────────────────────────────
// A block is delimited by HTML comments so it survives every markdown renderer we ship through (the
// in-app DocsBrowser, marked in build-docs-html, GitHub, and a future Starlight build) without any of
// them rendering the markers.
function open(name) {
  return `<!-- generated:${name} — DO NOT EDIT BY HAND. Regenerate with: npm run docs:gen -->`;
}
function close(name) {
  return `<!-- /generated:${name} -->`;
}

function applyBlock(file, name, body) {
  const abs = path.join(ROOT, file);
  const before = fs.readFileSync(abs, 'utf8');
  const re = new RegExp(`<!-- generated:${name}[\\s\\S]*?<!-- /generated:${name} -->`);
  if (!re.test(before)) {
    throw new Error(`gen-docs-data: ${file} has no "${name}" block. Add:\n${open(name)}\n${close(name)}`);
  }
  const after = before.replace(re, `${open(name)}\n\n${body}\n\n${close(name)}`);
  // COMPARE LINE-ENDING-BLIND. On a machine with `core.autocrlf=true` — the Windows default, and this
  // project's — git materialises the file with CRLF on every checkout, while the block above is built
  // with \n. A raw string compare therefore reports EVERY block stale after any checkout or branch
  // switch, with no content difference at all: `npm run docs:gen` then rewrites the file, `git diff`
  // shows nothing, and the next checkout breaks it again. That cost two red `npm run verify` runs on a
  // clean tree before it was diagnosed, which is exactly how a real check gets ignored. Content is what
  // is being asserted here; the newline flavour on disk is git's business.
  const norm = (s) => s.replace(/\r\n/g, '\n');
  return { abs, file, changed: norm(after) !== norm(before), after };
}

// ── Parsing the shader uniform table ──────────────────────────────────────────────────────────────────
// Same doctrine as the keymap above: the uniforms an operator's shader can read are declared once, in
// the plugin's wrapper, and the doc table is OUTPUT. A hand-kept copy is wrong the first time a uniform
// is added or renamed — and a shader reference listing a uniform the wrapper does not declare sends an
// author hunting for a compile error in their own code.
function parseShaderUniforms() {
  const file = path.join(ROOT, 'plugins', 'shader', 'src', 'wrapper.ts');
  const src = fs.readFileSync(file, 'utf8');
  const arr = src.match(/export const UNIFORMS[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!arr) throw new Error('gen-docs-data: could not find UNIFORMS in plugins/shader/src/wrapper.ts');
  const rows = [];
  for (const line of arr[1].split(/\r?\n/)) {
    const m = line.match(/\{\s*name:\s*'([^']+)',\s*detail:\s*'([^']*)'/);
    if (m) rows.push({ name: m[1], detail: m[2] });
  }
  // An empty parse is the one failure that would silently put us back to a hand-kept table.
  if (!rows.length) throw new Error('gen-docs-data: UNIFORMS parsed to zero rows — the literal formatting changed');
  return rows;
}

function renderShaderUniforms(rows) {
  const out = ['| Name | Type | What it is |', '|---|---|---|'];
  for (const r of rows) {
    // `detail` is authored as "type — prose"; split it so the table reads as a table.
    const [type, ...rest] = r.detail.split(' — ');
    out.push(`| \`${r.name}\` | ${type} | ${rest.join(' — ')} |`);
  }
  return out.join('\n');
}

// ── Parsing the shader cookbook ───────────────────────────────────────────────────────────────────────
// The guide's examples are SHIPPED SHADERS, not prose. Every one is in plugins/shader/src/cookbook.ts,
// four of them are in the app's shader dropdown, and all of them are compiled on a real driver by the
// harness before release — so a documented example cannot be one that does not build. Copying them into
// markdown by hand would break that the first time one was edited.
function parseCookbook(fileName) {
  const file = path.join(ROOT, 'plugins', 'shader', 'src', fileName);
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  // One entry per `{ id: '…', … source: `…` }`. Sources contain no backticks (checked below), so a
  // non-greedy match to the next one is exact rather than merely convenient.
  const re = /\{\s*\n\s*id:\s*'([^']+)',\s*\n\s*name:\s*'([^']+)',\s*\n\s*teach:\s*'([\s\S]*?)',\s*\n\s*note:\s*\n?([\s\S]*?),\s*\n\s*(?:starter:[\s\S]*?)?source:\s*`([\s\S]*?)`,\s*\n\s*\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const note = m[4]
      .split('\n')
      .map((l) => l.trim().replace(/^\+?\s*'/, '').replace(/'\s*$/, ''))
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    out.push({ id: m[1], name: m[2], teach: m[3], note, source: m[5] });
  }
  if (!out.length) throw new Error('gen-docs-data: ' + fileName + ' parsed to zero recipes — the literal formatting changed');
  return out;
}

function renderCookbook(recipes) {
  const parts = [];
  for (const r of recipes) {
    parts.push(`### ${r.name}`);
    parts.push('');
    parts.push(`**${r.teach}**`);
    parts.push('');
    parts.push(r.note);
    parts.push('');
    parts.push('```glsl');
    parts.push(r.source);
    parts.push('```');
    parts.push('');
  }
  return parts.join('\n').trimEnd();
}

// ── Parsing the node catalogue ────────────────────────────────────────────────────────────────────
// The palette in the node editor IS nodeCatalog.ts. A hand-written list of nodes is wrong the first
// time somebody adds one — which is the entire reason generated blocks exist.
function parseNodes() {
  const src = fs.readFileSync(path.join(ROOT, 'plugins', 'shader', 'src', 'nodeCatalog.ts'), 'utf8');
  // The optional trailing group is the alias list the menu's search uses (NodeDef.aliases). It is
  // documented because a reader of the table should not have to learn our vocabulary either: the
  // table is where somebody looks up "what is ArtLux's name for lerp?".
  const re = /id:\s*'([^']+)',\s*(?:\n\s*)?label:\s*'([^']+)',\s*(?:\n\s*)?category:\s*'([^']+)',\s*(?:\n\s*)?hint:\s*'([^']*)',\s*(?:\n\s*)?(?:aliases:\s*\[([^\]]*)\])?/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const aliases = (m[5] ?? '').split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
    out.push({ id: m[1], label: m[2], category: m[3], hint: m[4], aliases });
  }
  if (out.length < 20) throw new Error('gen-docs-data: nodeCatalog.ts parsed to ' + out.length + ' nodes — the literal formatting changed');
  return out;
}

function renderNodes(nodes) {
  const parts = [];
  for (const cat of [...new Set(nodes.map((n) => n.category))]) {
    parts.push(`**${cat}**`, '', '| Node | What it does | Also found by |', '|---|---|---|');
    for (const n of nodes.filter((x) => x.category === cat)) {
      const also = n.aliases.length ? n.aliases.map((a) => '`' + a + '`').join(', ') : '—';
      parts.push(`| **${n.label}** | ${n.hint} | ${also} |`);
    }
    parts.push('');
  }
  return parts.join('\n').trimEnd();
}

function main() {
  const results = [
    applyBlock('docs/user-guide/15-keyboard-reference.md', 'keymap', renderKeymap(parseShortcuts())),
    applyBlock('docs/SHADERS.md', 'shader-uniforms', renderShaderUniforms(parseShaderUniforms())),
    applyBlock('docs/SHADER-COOKBOOK.md', 'shader-cookbook', renderCookbook(parseCookbook('cookbook.ts'))),
    applyBlock('docs/SHADER-COOKBOOK.md', 'shader-noise', renderCookbook(parseCookbook('noiseLib.ts'))),
    applyBlock('docs/SHADERS.md', 'shader-nodes', renderNodes(parseNodes())),
    // The per-node reference. Built by CALLING each node's generator rather than by reading the
    // source, so the GLSL in the page is the GLSL the compiler emits — see gen-shader-node-docs.cjs.
    applyBlock('docs/SHADER-NODES.md', 'shader-node-reference', require('./gen-shader-node-docs.cjs').build()),
  ];

  const stale = results.filter((r) => r.changed);
  if (CHECK) {
    if (stale.length) {
      console.error('\x1b[31m✗ generated documentation blocks are out of date:\x1b[0m');
      for (const r of stale) console.error(`  ${r.file} → block regenerates differently than what is on disk`);
      console.error('\n  Run \x1b[1mnpm run docs:gen\x1b[0m and commit the result.');
      console.error('  (A shortcut was added, renamed or rebound in src/renderer/shortcuts/registry.ts.)');
      process.exit(1);
    }
    console.log(`\x1b[32m✓\x1b[0m generated doc blocks are current (${results.length} block${results.length === 1 ? '' : 's'})`);
    return;
  }

  for (const r of results) {
    if (r.changed) { fs.writeFileSync(r.abs, r.after); console.log(`  wrote ${r.file}`); }
    else console.log(`  unchanged ${r.file}`);
  }
  console.log(`\x1b[32m✓\x1b[0m ${results.length} generated block${results.length === 1 ? '' : 's'}`);
}

try {
  main();
} catch (e) {
  console.error(`\x1b[31m✗ ${e.message}\x1b[0m`);
  process.exit(1);
}
