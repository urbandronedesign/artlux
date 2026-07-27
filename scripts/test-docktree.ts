// WP-5.1 — a behavioural round-trip over services/dockTree.ts.
//
// The file imports nothing, which is the whole reason this can exist: no Electron, no React, no dev
// server, no app. `npm run test:docktree` compiles it and runs it in about a second. Every case below is a rule the plan says the model must hold, and
// several are rules a UI would otherwise break once and then forever.
import {
  DOCK_TREE_VERSION, __resetIds, defaultTreeOf, ensureTree, sanitizeDockTree, mergePluginPanels,
  moveTab, reorderTab, setActive, toggleCollapsed, setSplitSizes, closePanel, addPanel,
  panelIds, groups, findGroupOf, walk,
  type DockManifest, type DockNode, type DockTree,
} from '../src/renderer/services/dockTree';

let failed = 0;
const ok = (cond: boolean, what: string) => {
  if (cond) console.log(`  OK   ${what}`);
  else { console.log(`  FAIL ${what}`); failed++; }
};
const eq = (a: unknown, b: unknown, what: string) => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  ok(same, same ? what : `${what}   (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
};

const CTX: DockManifest = {
  id: 'mapping',
  viewport: 'core.viewport.stage2d',
  browser: ['core.browser.scene', 'core.browser.media'],
  dock: ['core.dock.fixture', 'core.dock.dmx'],
  inspector: ['core.inspector.surface', 'core.inspector.fixture'],
};
const depth = (n: DockNode): number => (n.kind === 'split' ? 1 + Math.max(...n.children.map(depth)) : 1);
const count = (t: DockTree) => { let c = 0; walk(t.root, () => { c++; }); return c; };

console.log('\n[compiler]');
__resetIds();
const base = defaultTreeOf(CTX, { leftWidth: 300, rightWidth: 340, dockHeight: 260, dockPanel: 'core.dock.dmx' });
eq(panelIds(base).sort(), [...(CTX.browser ?? []), ...(CTX.dock ?? []), ...(CTX.inspector ?? []), CTX.viewport].sort(),
  'every declared panel lands in the tree, exactly once');
ok(base.root.kind === 'split' && base.root.dir === 'row' && base.root.children.length === 3,
  'browser | centre | inspector across a row');
ok(groups(base).find(g => g.region === 'browser')?.render === 'stack', 'the browser column STACKS (appliesTo co-display)');
ok(groups(base).find(g => g.region === 'dock')?.render === 'tabs', 'the dock is TABBED');
eq(groups(base).find(g => g.region === 'dock')?.activeId, 'core.dock.dmx', 'the banked dock tab is inherited, so upgrading moves nothing');
ok(JSON.stringify(base.root).includes('"px":300') && JSON.stringify(base.root).includes('"px":340'),
  'the banked column widths are inherited too');

console.log('\n[sanitize]');
ok(sanitizeDockTree(null) === null, 'null is refused');
ok(sanitizeDockTree({ v: 999, root: base.root, meta: base.meta }) === null, 'a future version is refused, not half-read');
ok(sanitizeDockTree({ v: DOCK_TREE_VERSION, root: { kind: 'nope' }, meta: base.meta }) === null, 'a garbage root is refused');
ok(sanitizeDockTree({ v: DOCK_TREE_VERSION, root: base.root }) === null, 'a tree with no meta.viewport is refused');
const round = sanitizeDockTree(JSON.parse(JSON.stringify(base)));
ok(!!round, 'a real tree survives a JSON round-trip');
eq(sanitizeDockTree(round), round, 'sanitize is IDEMPOTENT');

console.log('\n[normalize invariants]');
const dup = JSON.parse(JSON.stringify(base)) as DockTree;
groups(dup)[0].panelIds.push(CTX.viewport);
eq(panelIds(sanitizeDockTree(dup)!).filter(p => p === CTX.viewport).length, 1,
  'a panel appears AT MOST ONCE - this is what keeps the timeline single-instance by construction');
const empty = JSON.parse(JSON.stringify(base)) as DockTree;
groups(empty).find(g => g.region === 'browser')!.panelIds = [];
const noEmpty = sanitizeDockTree(empty)!;
ok(!groups(noEmpty).some(g => g.panelIds.length === 0), 'empty groups are dropped');
ok(depth(noEmpty.root) <= depth(base.root), 'a single-child split is hoisted rather than left as a wrapper');

console.log('\n[ops]');
const g0 = groups(base).find(g => g.region === 'browser')!;
const gDock = groups(base).find(g => g.region === 'dock')!;
const moved = moveTab(base, 'core.browser.media', gDock.id, 'center');
ok(findGroupOf(moved, 'core.browser.media')?.id === gDock.id, 'moveTab centre: the panel joins the target group');
eq(panelIds(moved).filter(p => p === 'core.browser.media').length, 1, 'and does not leave a copy behind');
eq(findGroupOf(moved, 'core.browser.media')?.activeId, 'core.browser.media', 'and becomes the active tab');

// Dropping BELOW the dock, whose parent split already runs 'col': the new split is same-direction, so
// normalize INLINES it. Depth is unchanged, and that is the point - otherwise every drag would deepen
// the tree permanently and the splitters would stop meaning what they look like.
const split = moveTab(base, 'core.browser.media', gDock.id, 'bottom');
ok(findGroupOf(split, 'core.browser.media')!.id !== gDock.id, 'moveTab edge: the panel gets a group of its own');
eq(groups(split).length, groups(base).length + 1, 'one more group than before');
eq(depth(split.root), depth(base.root), 'and a same-direction split is INLINED, so the tree does not deepen');
const crossed = moveTab(base, 'core.browser.media', gDock.id, 'right');
ok(depth(crossed.root) > depth(base.root), 'a cross-axis drop DOES nest a new split');

eq(moveTab(base, 'core.browser.media', g0.id, 'center'), base, 'dropping a panel on its own group is a no-op');
eq(moveTab(base, 'nope', gDock.id, 'center'), base, 'moving a panel that is not in the tree is a no-op');

eq(findGroupOf(reorderTab(base, g0.id, 'core.browser.media', 0), 'core.browser.media')!.panelIds[0],
  'core.browser.media', 'reorderTab moves it to the front');
eq(findGroupOf(setActive(base, gDock.id, 'core.dock.fixture'), 'core.dock.fixture')!.activeId,
  'core.dock.fixture', 'setActive picks the tab');
eq(setActive(base, gDock.id, 'not.here'), base, 'setActive on a panel the group does not hold is a no-op');
ok(groups(toggleCollapsed(base, g0.id)).find(g => g.id === g0.id)!.collapsed === true, 'toggleCollapsed collapses');

const rootSplit = base.root as Extract<DockNode, { kind: 'split' }>;
ok(JSON.stringify(setSplitSizes(base, rootSplit.id, [{ px: 111 }, { fr: 1 }, { px: 222 }]).root).includes('"px":111'),
  'setSplitSizes writes the row');
eq(setSplitSizes(base, rootSplit.id, [{ fr: 1 }]), base, 'and refuses a size list that does not match the children');

console.log('\n[close / add - the rule that makes close mean something]');
const closed = closePanel(base, 'core.dock.dmx');
ok(!panelIds(closed).includes('core.dock.dmx'), 'closePanel removes it');
ok(closed.removed.includes('core.dock.dmx'), 'and records it');
eq(closePanel(base, CTX.viewport), base, 'the VIEWPORT cannot be closed - that state has no way back');
ok(!panelIds(mergePluginPanels(closed, CTX)).includes('core.dock.dmx'),
  'a closed panel is NOT resurrected by a merge, or close would mean "until you restart"');
const readded = addPanel(closed, 'core.dock.dmx', gDock.id);
ok(panelIds(readded).includes('core.dock.dmx'), 'addPanel puts it back');
ok(!readded.removed.includes('core.dock.dmx'), 'and un-records it, or close would be permanent');
eq(addPanel(base, 'core.dock.dmx'), base, 'adding a panel already in the tree is a no-op (no duplicates)');

console.log('\n[merge - the three things that happen between banking and rendering]');
const withPlugin: DockManifest = { ...CTX, dock: [...(CTX.dock ?? []), 'plugin.dock.ndi'], inspector: [...(CTX.inspector ?? []), 'plugin.inspector.ndi'] };
const merged = mergePluginPanels(base, withPlugin);
eq(findGroupOf(merged, 'plugin.dock.ndi')?.region, 'dock', 'a late plugin panel lands in its own region');
eq(findGroupOf(merged, 'plugin.inspector.ndi')?.region, 'inspector', 'for every region');
eq(mergePluginPanels(merged, withPlugin), merged, 'merge is idempotent');

const swapped = mergePluginPanels(base, { ...CTX, viewport: 'plugin.viewport.calib' });
ok(panelIds(swapped).includes('plugin.viewport.calib') && !panelIds(swapped).includes(CTX.viewport),
  'a plugin CLAIMING the viewport repoints the tree instead of rendering one the context no longer has');
eq(swapped.meta.viewport, 'plugin.viewport.calib', 'and meta follows');

const noDock: DockManifest = { id: 'x', viewport: 'v', browser: ['b'] };
__resetIds();
ok(panelIds(mergePluginPanels(defaultTreeOf(noDock), { ...noDock, dock: ['plugin.dock.late'] })).includes('plugin.dock.late'),
  'a plugin can contribute the FIRST panel of a region the context never declared');

console.log('\n[unknown ids are kept, never dropped]');
ok(panelIds(mergePluginPanels(merged, CTX)).includes('plugin.dock.ndi'),
  'a disabled plugin panel keeps its placement - dropping it would erase the arrangement forever');

console.log('\n[caps]');
let deepNode: DockNode = { kind: 'group', id: 'g0', render: 'tabs', panelIds: ['p0'], activeId: 'p0' };
for (let i = 1; i <= 12; i++) {
  deepNode = {
    kind: 'split', id: `s${i}`, dir: i % 2 ? 'row' : 'col',
    children: [deepNode, { kind: 'group', id: `g${i}`, render: 'tabs', panelIds: [`p${i}`], activeId: `p${i}` }],
    sizes: [{ fr: 0.5 }, { fr: 0.5 }],
  };
}
ok(sanitizeDockTree({ v: DOCK_TREE_VERSION, root: deepNode, meta: { viewport: 'p0' } }) === null,
  'a tree past the depth cap is REFUSED, so the caller re-derives rather than rendering something pathological');

// ...and no sequence of ops can build one. That is the property that matters: a layout which works until
// you restart would be worse than a drag that declines.
let deep = base;
for (let i = 0; i < 40; i++) {
  const target = groups(deep)[groups(deep).length - 1];
  const victim = panelIds(deep).find(p => p !== deep.meta.viewport && findGroupOf(deep, p)!.id !== target.id);
  if (!victim) break;
  deep = moveTab(deep, victim, target.id, i % 2 ? 'right' : 'bottom');
}
ok(depth(deep.root) <= 8 && count(deep) <= 64, `40 chained drags stay inside the caps (depth ${depth(deep.root)}, ${count(deep)} nodes)`);
ok(sanitizeDockTree(JSON.parse(JSON.stringify(deep))) !== null, 'a tree built only by ops always survives a reload');

console.log('\n[ensureTree - the single door]');
__resetIds();
ok(panelIds(ensureTree(undefined, CTX)).length > 0, 'no saved tree gives the shipped arrangement');
ok(panelIds(ensureTree({ v: 99 }, CTX)).length > 0, 'garbage gives the shipped arrangement, not a crash');
eq(panelIds(ensureTree(JSON.parse(JSON.stringify(base)), CTX)).sort(), panelIds(base).sort(), 'a good saved tree is kept');

console.log(failed ? `\n${failed} FAILED` : '\nall dockTree behaviour holds');
process.exit(failed ? 1 : 0);
