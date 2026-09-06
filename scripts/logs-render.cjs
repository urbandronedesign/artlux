#!/usr/bin/env node
// Render a machine log (JSONL) as aligned, readable text.
//
// The log is written as one JSON object per line because that is the only format that answers a
// question like "every video over a second, on this machine, last week" without someone writing a
// parser first. The cost is that it is not pleasant to read cold — so this is the other half of that
// trade, and the reason the on-disk format never needs a second, prettier copy.
//
// Usage:
//   node scripts/logs-render.cjs                        # the newest log in %APPDATA%\artlux\logs
//   node scripts/logs-render.cjs <file|dir>             # a specific file, or the newest in a folder
//   node scripts/logs-render.cjs <file> --level warn    # only warn and error
//   node scripts/logs-render.cjs <file> --cat media     # only one category (repeatable, comma-ok)
//   node scripts/logs-render.cjs <file> --run r7        # one show run
//   node scripts/logs-render.cjs <file> --full          # do not truncate payloads

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);

const RANK = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const COLOR = { error: '\x1b[31m', warn: '\x1b[33m', info: '', debug: '\x1b[90m', trace: '\x1b[90m' };
const RESET = '\x1b[0m';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function defaultDir() {
  const appdata = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library', 'Application Support')
      : path.join(process.env.HOME || '', '.config'));
  return path.join(appdata, 'artlux', 'logs');
}

function newestIn(dir) {
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files[0]?.f;
}

function resolveTarget() {
  const positional = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--level'
    && argv[argv.indexOf(a) - 1] !== '--cat' && argv[argv.indexOf(a) - 1] !== '--run');
  const target = positional || defaultDir();
  if (!fs.existsSync(target)) return null;
  return fs.statSync(target).isDirectory() ? newestIn(target) : target;
}

// A payload reads better as `key=value` pairs than as JSON: the keys are short and the values are
// mostly numbers, which is exactly the shape a table wants.
function pairs(d, full) {
  if (!d || typeof d !== 'object') return '';
  const out = [];
  for (const [k, v] of Object.entries(d)) {
    if (k === 'msg') continue; // rendered on its own, unquoted
    let s;
    if (v === null || v === undefined) s = '-';
    else if (Array.isArray(v)) s = full ? JSON.stringify(v) : `[${v.length}]`;
    else if (typeof v === 'object') s = full ? JSON.stringify(v) : '{…}';
    else s = String(v);
    if (!full && s.length > 60) s = s.slice(0, 60) + '…';
    out.push(`${k}=${s}`);
  }
  return out.join(' ');
}

const file = resolveTarget();
if (!file) {
  console.error(`no log found. Looked in: ${argv[0] || defaultDir()}`);
  process.exit(1);
}

const minRank = RANK[flag('level') || 'trace'] ?? RANK.trace;
const cats = (flag('cat') || '').split(',').filter(Boolean);
const runFilter = flag('run');
const full = has('full');

console.log(`# ${file}\n`);

let shown = 0;
let total = 0;
for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
  if (!line.trim()) continue;
  total++;
  let r;
  // A truncated tail is normal: the file may be being written to right now.
  try { r = JSON.parse(line); } catch { continue; }
  if ((RANK[r.lv] ?? 9) > minRank) continue;
  if (cats.length && !cats.some((c) => r.cat === c || r.cat.startsWith(`${c}:`))) continue;
  if (runFilter && r.run !== runFilter) continue;
  shown++;
  const time = (r.t || '').slice(11, 23);
  const msg = r.d && r.d.msg ? ` ${r.d.msg}` : '';
  const rest = pairs(r.d, full);
  const c = useColor ? (COLOR[r.lv] || '') : '';
  const z = useColor && c ? RESET : '';
  console.log(
    `${c}${time}  ${r.lv.toUpperCase().padEnd(5)} ${String(r.cat).padEnd(16)} ${String(r.ev).padEnd(16)}${msg}${rest ? '  ' + rest : ''}${z}`,
  );
  if (r.err && r.err.stack) console.log(`${' '.repeat(14)}${String(r.err.stack).split('\n').slice(0, 4).join('\n' + ' '.repeat(14))}`);
}

console.log(`\n# ${shown} of ${total} records`);
