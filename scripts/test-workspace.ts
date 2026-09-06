// A behavioural round-trip over services/workspacePortable.ts — the pure half of named workspaces
// (plans/named-workspaces.md).
//
// The module under test imports only dockTree (which imports nothing) and types, which is the whole
// reason this can exist: no Electron, no React, no dev server, no app. `npm run test:workspace`
// compiles and runs it in about a second.
//
// Every case below is a way a SHARED workspace can be silently wrong on the machine that receives it:
// the app boots, nothing throws, and the shell is simply the wrong shape. That class of bug is not
// findable by clicking, which is why these rules live here rather than in a manual pass.
import { preparePortable, type PortableLayout, type PrepareEnv } from '../src/renderer/services/workspacePortable';
import { DOCK_TREE_VERSION } from '../src/renderer/services/dockTree';

let failures = 0;
let ran = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  ran++;
  if (cond) { console.log('  ok   ', name); return; }
  failures++; console.log('  FAIL ', name, extra !== undefined ? JSON.stringify(extra) : '');
};

const KNOWN = new Set(['mapping', '3d', 'show', 'calib']);
const RETIRED: Record<string, string> = { map: 'mapping', led: 'mapping', media: 'mapping', timeline: 'mapping', tracking: '3d' };
const env = (w: number, h: number): PrepareEnv => ({
  view: { w, h },
  hasContext: (id) => KNOWN.has(id),
  remap: (id) => RETIRED[id] ?? id,
  fallbackContext: 'mapping',
});

const tree = (v: number, px: number) => ({
  v, removed: [], meta: { viewport: 'core.viewport.stage2d' },
  root: {
    kind: 'split', id: 's1', dir: 'row',
    sizes: [{ px }, { fr: 1 }],
    children: [
      { kind: 'group', id: 'g1', render: 'stack', region: 'browser', panelIds: ['core.browser.surfaces'], activeId: 'core.browser.surfaces' },
      { kind: 'group', id: 'g2', render: 'tabs', region: 'viewport', panelIds: ['core.viewport.stage2d'], activeId: 'core.viewport.stage2d' },
    ],
  },
});

const base = (over: Partial<PortableLayout> = {}): PortableLayout => ({
  contexts: { mapping: { leftWidth: 700, rightWidth: 320, dockHeight: 900, splitRatio: 0.5 } },
  activeContext: 'mapping', showLeft: true, showRight: true, dockOpen: true,
  splitView: false, bottomOpen: false, timelineMax: false, leftTab: 'scene',
  dockTrees: { mapping: tree(DOCK_TREE_VERSION, 700) },
  ...over,
});

console.log('\n1. A 4K-authored workspace opening on a 1366x768 laptop');
{
  const r = preparePortable(base(), env(1366, 768));
  const s = r.layout.contexts!.mapping;
  ok('a 700px column is clamped to 40% of the width', s.leftWidth === 546, s.leftWidth);
  ok('a 320px column that already fits is untouched', s.rightWidth === 320, s.rightWidth);
  ok('a 900px dock is clamped to 60% of the height', s.dockHeight === 460, s.dockHeight);
  ok('the split ratio survives', s.splitRatio === 0.5, s.splitRatio);
  const root = (r.layout.dockTrees!.mapping as any).root;
  ok('the tree px size is clamped on the SAME axis as its split', root.sizes[0].px === 546, root.sizes[0]);
  ok('an fr size is left alone', 'fr' in root.sizes[1], root.sizes[1]);
  ok('nothing was dropped', r.droppedTrees.length === 0, r.droppedTrees);
}

console.log('\n2. The same workspace back on the desk it was authored on');
{
  const r = preparePortable(base(), env(3840, 2160));
  ok('nothing moves', r.layout.contexts!.mapping.leftWidth === 700);
  ok('idempotent: preparing twice changes nothing',
     preparePortable(r.layout, env(3840, 2160)).layout.contexts!.mapping.leftWidth === 700);
}

console.log('\n3. A tree written by a different build');
{
  const r = preparePortable(base({ dockTrees: { mapping: tree(DOCK_TREE_VERSION + 1, 400) } }), env(1920, 1080));
  ok('it is refused, not half-read', !r.layout.dockTrees!.mapping);
  ok('and REPORTED so the operator is told', r.droppedTrees.includes('mapping'), r.droppedTrees);
  ok('the workbench itself still opens', r.layout.activeContext === 'mapping');
}

console.log('\n4. Workbench ids the target machine does not have');
{
  const retired = preparePortable(base({ activeContext: 'tracking', contexts: { tracking: { leftWidth: 300 } }, dockTrees: {} }), env(1920, 1080));
  ok('a retired id is remapped (tracking -> 3d)', retired.layout.activeContext === '3d', retired.layout.activeContext);
  ok('…and so is its slice key', !!retired.layout.contexts!['3d'], Object.keys(retired.layout.contexts!));
  ok('a clean remap is NOT reported as a fallback', retired.fellBackContext === false);

  const missing = preparePortable(base({ activeContext: 'audio', dockTrees: {} }), env(1920, 1080));
  ok('an absent workbench falls back instead of selecting nothing', missing.layout.activeContext === 'mapping');
  ok('and it says so', missing.fellBackContext === true);
  ok('its slice is KEPT for when the plugin comes back', !!missing.layout.contexts!.mapping);
}

console.log('\n5. Per-machine keys can never ride along');
{
  const keys = Object.keys(preparePortable(base(), env(1920, 1080)).layout);
  for (const k of ['uiScale', 'mediaView', 'scene3dRenderScale', 'calibrationFile', 'shortcuts']) {
    ok(`${k} is absent`, !keys.includes(k));
  }
}

console.log(failures ? `\n${failures} of ${ran} checks FAILED\n` : `\nall ${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
