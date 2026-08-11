// The per-node shader reference, generated from the catalogue itself.
//
// WHY THIS IS GENERATED AND NOT WRITTEN. Eighty-three nodes with their ports, defaults, aliases and
// the GLSL each one emits is exactly the kind of table that is correct on the day it is written and
// wrong by the end of the week — the repo has a cautionary tale about a hand-kept shortcut list that
// was maintained for months and still documented a feature that had been replaced. So the page is
// built from `nodeCatalog.ts`, and `verify:docs` fails the build if the two disagree.
//
// THE GLSL IS NOT A DESCRIPTION OF THE CODE, IT IS THE CODE. Each node's `emit()` is CALLED here with
// its own port names as the inputs, so the snippet in the docs is the expression the compiler will
// actually produce. A node cannot document an operation it does not perform.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

/** Bundle the catalogue to CJS so this plain script can call into it. */
function loadCatalogue() {
  const out = path.join(os.tmpdir(), `artlux-node-catalogue-${process.pid}.cjs`);
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'plugins', 'shader', 'src', 'nodeCatalog.ts')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  try {
    return require(out);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

const TYPE_HELP = {
  float: 'a number',
  int: 'a whole number',
  bool: 'on or off',
  vec2: 'two numbers (x, y)',
  vec3: 'three numbers — a colour, or a point',
  vec4: 'four numbers — a colour with alpha',
};

const fmtDefault = (v) => {
  if (v === undefined) return '—';
  if (Array.isArray(v)) return `\`${v.join(', ')}\``;
  return `\`${v}\``;
};

/**
 * What this node emits, with its own port names standing in for whatever is wired to it.
 *
 * Never throws: a node whose emit depends on something only the generator has is documented by its
 * signature alone, which is worth more than a page that fails to build.
 */
function glslFor(def) {
  const ins = {};
  for (const p of def.inputs) ins[p.name] = p.name;
  const params = {};
  for (const p of def.inputs) if (p.def !== undefined) params[p.name] = p.def;
  for (const st of def.settings ?? []) params[st.name] = st.def;
  if (def.id === 'param.float') Object.assign(params, { name: 'value', label: 'Value', min: 0, max: 1, default: 0.5 });
  if (def.id === 'param.palette') Object.assign(params, { name: 'pal', label: 'Palette', default: 0 });
  try {
    const emitted = def.emit(ins, params, { id: 'n', type: def.id, params });
    const lines = def.outputs
      .map((o) => (emitted[o.name] === undefined ? null : `${o.name} = ${emitted[o.name]}`))
      .filter(Boolean);
    return lines.join('\n');
  } catch {
    return '';
  }
}

function render(nodes) {
  const parts = [];
  const categories = [...new Set(nodes.map((n) => n.category))];

  parts.push('**Jump to:** ' + categories.map((c) => `[${c}](#${c.toLowerCase()})`).join(' · '), '');

  for (const cat of categories) {
    parts.push(`## ${cat}`, '');
    for (const def of nodes.filter((n) => n.category === cat)) {
      parts.push(`### ${def.label}`, '');
      parts.push(def.hint, '');
      if (def.doc) parts.push(def.doc, '');

      if (def.inputs.length) {
        parts.push('| In | Type | Default |', '|---|---|---|');
        for (const p of def.inputs) {
          parts.push(`| \`${p.label ?? p.name}\` | ${p.type} — ${TYPE_HELP[p.type]} | ${fmtDefault(p.def)} |`);
        }
        parts.push('');
      }
      if (def.outputs.length) {
        parts.push('| Out | Type |', '|---|---|');
        for (const p of def.outputs) parts.push(`| \`${p.name}\` | ${p.type} — ${TYPE_HELP[p.type]} |`);
        parts.push('');
      }
      for (const st of def.settings ?? []) {
        const opts = st.options ? ` — ${st.options.map((o) => `\`${o}\``).join(', ')}` : '';
        parts.push(`**${st.label ?? st.name}** (setting${opts}), default ${fmtDefault(st.def)}${st.hint ? ` · ${st.hint}` : ''}`, '');
      }

      const glsl = glslFor(def);
      if (glsl) parts.push('```glsl', glsl, '```', '');
      const extras = [];
      if (def.requires?.length) extras.push(`helper${def.requires.length > 1 ? 's' : ''}: ${def.requires.map((r) => `\`${r}\``).join(', ')}`);
      if (def.feedback) extras.push('asks the shader for `REQUIRES_LAST_FRAME`');
      if (def.header) extras.push('declares a parameter in the shader header');
      if (def.aliases?.length) extras.push(`also found by ${def.aliases.map((a) => `\`${a}\``).join(', ')}`);
      if (extras.length) parts.push(extras.join(' · '), '');
    }
  }
  return parts.join('\n').trimEnd();
}

function build() {
  const { NODE_LIST } = loadCatalogue();
  if (!Array.isArray(NODE_LIST) || NODE_LIST.length < 20) {
    throw new Error(`gen-shader-node-docs: the catalogue loaded as ${NODE_LIST?.length} nodes`);
  }
  return render(NODE_LIST);
}

module.exports = { build };

if (require.main === module) process.stdout.write(build() + '\n');
