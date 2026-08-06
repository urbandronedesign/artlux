// A content hash of the files that decide WHAT THE EDITOR LOOKS LIKE.
//
// The guide's screenshots went stale for three shell generations, and the only thing that recorded it
// was a hand-written "⚠ these are outdated" banner that a human had to remember to add — and then
// remember to delete. That is layer-4 of the documentation strategy (plans/documentation-wiki.md):
// pictures are the shortest-half-life thing in the docs, so their staleness must be measured, not
// remembered.
//
// `npm run docs:capture` stamps this signature beside the images; `verify:docs` recomputes it and says
// so when it has moved. It REPORTS rather than fails: a one-line CSS change in the shell should make
// the screenshots suspect, not block a merge behind a three-minute app run.
//
// Deliberately narrow. These are the shell's shape — the rail, the workbench manifests, the hand-built
// fallback layout, the dock tree that actually renders, and the two PERMANENT STRIPS above and below
// them. A change in a leaf panel moves one screenshot; a change in these moves all of them.
//
// The action bar and the status bar were added after a REC indicator landed in both: they are in every
// screenshot in the guide by construction, and the hash was silently blind to them — you could put a
// permanent new light in the chrome of all ~18 pictures and this would report "unchanged".

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');

const SHELL_FILES = [
  'src/renderer/contexts/index.tsx',
  'src/renderer/components/shell/WorkspaceShell.tsx',
  'src/renderer/components/shell/ContextRail.tsx',
  'src/renderer/components/shell/DockRenderer.tsx',
  'src/renderer/components/shell/ActionBar.tsx',
  'src/renderer/components/StatusBar.tsx',
];

function shellSignature() {
  const h = crypto.createHash('sha256');
  for (const rel of SHELL_FILES) {
    const abs = path.join(ROOT, ...rel.split('/'));
    // A missing file is itself a signature change — it means the shell was restructured.
    h.update(rel);
    h.update(fs.existsSync(abs) ? fs.readFileSync(abs) : Buffer.from('<absent>'));
  }
  return h.digest('hex').slice(0, 16);
}

module.exports = { shellSignature, SHELL_FILES };
