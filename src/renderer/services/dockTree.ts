// The dockable workspace's data model — the tree, the ops on it, and the compiler that derives one
// from a context's flat manifest. Plan: plans/dockable-workspace.md.
//
// ⚠ THIS FILE IMPORTS NOTHING, ON PURPOSE, AND SHOULD STAY THAT WAY.
//
// It is the part of docking that is pure logic: no React, no DOM, no registries, not even the SDK's
// `WorkspaceContext` type (it takes a minimal structural view of one instead — see DockManifest). That
// is what lets it be verified by a throwaway `tsc`-checked script rather than by clicking panels around
// in a running app, which is the repo's documented pattern for logic of this shape. Every rule below is
// something the UI would otherwise get subtly wrong once and then forever.

export const DOCK_TREE_VERSION = 1;

/** Where a group sits in the shipped arrangement — what `mergePluginPanels` matches a late panel against. */
export type DockRegion = 'browser' | 'dock' | 'inspector' | 'viewport';

/**
 * A group's rendering idiom, and the reason the model needs both.
 *
 * 'stack' is the browser/inspector column: every panel visible at once, stacked as CollapsibleSections.
 * 'tabs' is the dock idiom: one visible, the rest as tabs.
 *
 * Collapsing these into one would look like a simplification and would break the inspector: its
 * `appliesTo` filtering exists precisely so a surface AND a fixture can contribute sections at the same
 * time, which is only meaningful if they are all on screen together.
 */
export type DockRender = 'stack' | 'tabs';

/** A pane's share of its parent split: absolute px (columns) or a fraction (viewport areas). */
export type DockSize = { px: number } | { fr: number };

export interface DockGroupNode {
  kind: 'group';
  id: string;
  render: DockRender;
  panelIds: string[];
  activeId?: string;
  collapsed?: boolean;
  region?: DockRegion;
}

export interface DockSplitNode {
  kind: 'split';
  id: string;
  dir: 'row' | 'col';
  children: DockNode[];
  sizes: DockSize[];
}

export type DockNode = DockGroupNode | DockSplitNode;

export interface DockTree {
  v: number;
  root: DockNode;
  /**
   * Panels the operator explicitly closed. Kept so that `mergePluginPanels` does not resurrect them on
   * the next launch — without this, "close" would silently mean "close until you restart".
   */
  removed: string[];
  /**
   * The viewport this tree was built for, and the companion pane's. Held in the tree rather than read
   * from the context at render time so the compiler can notice a plugin has since CLAIMED the viewport
   * (contextRegistry.extend) and swap it, instead of rendering a viewport the context no longer has.
   */
  meta: { viewport: string; companion?: string };
}

/** The minimal view of a WorkspaceContext this module needs. Structural, so nothing has to be imported. */
export interface DockManifest {
  id: string;
  viewport: string;
  companion?: string;
  browser?: string[];
  dock?: string[];
  inspector?: string[];
}

/** The banked ergonomics a first build inherits, so an upgrading install sees nothing move. */
export interface DockDefaults {
  leftWidth?: number;
  rightWidth?: number;
  dockHeight?: number;
  dockPanel?: string;
}

// Caps. Depth 8 and 64 nodes are far past any arrangement a person would build by hand; they exist so a
// corrupt or hand-edited prefs file cannot hand the renderer something pathological.
const MAX_DEPTH = 8;
const MAX_NODES = 64;

// Deterministic within a process, which is all persistence needs and all a test needs.
let idSeq = 0;
const newId = (p: string): string => `${p}${++idSeq}`;
/** Test-only: makes generated ids reproducible across cases. Not used by the app. */
export function __resetIds(): void { idSeq = 0; }

const isGroup = (n: DockNode): n is DockGroupNode => n.kind === 'group';
const isSplit = (n: DockNode): n is DockSplitNode => n.kind === 'split';

// ── Reading the tree ─────────────────────────────────────────────────────────────────────────────

export function walk(node: DockNode, fn: (n: DockNode) => void): void {
  fn(node);
  if (isSplit(node)) for (const c of node.children) walk(c, fn);
}

export function groups(tree: DockTree): DockGroupNode[] {
  const out: DockGroupNode[] = [];
  walk(tree.root, (n) => { if (isGroup(n)) out.push(n); });
  return out;
}

export function panelIds(tree: DockTree): string[] {
  return groups(tree).flatMap((g) => g.panelIds);
}

export function findGroupOf(tree: DockTree, panelId: string): DockGroupNode | undefined {
  return groups(tree).find((g) => g.panelIds.includes(panelId));
}

function depthOf(node: DockNode): number {
  if (!isSplit(node)) return 1;
  return 1 + Math.max(0, ...node.children.map(depthOf));
}

function countNodes(node: DockNode): number {
  let n = 0;
  walk(node, () => { n++; });
  return n;
}

// ── normalize ────────────────────────────────────────────────────────────────────────────────────

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const evenSizes = (n: number): DockSize[] => Array.from({ length: n }, () => ({ fr: 1 / Math.max(1, n) }));

/**
 * Put a tree back into a shape the renderer can trust. Every op ends here, so no op has to be careful.
 *
 * The rules, and what each one prevents:
 *  · a panel id appears AT MOST ONCE in the whole tree — duplicates mount a panel twice, which doubles
 *    any window-level keyboard listener it registers (this is the rule that keeps the single-instance
 *    guarantee the timeline depends on true BY CONSTRUCTION rather than by review);
 *  · empty groups are dropped — dragging the last tab out of a group must not leave a dead pane;
 *  · a split with one child is replaced by that child, and a split whose child is a split in the SAME
 *    direction is inlined — otherwise every drag deepens the tree permanently, and the sizes stop
 *    meaning anything to the operator;
 *  · `sizes` is repaired to match the children, and `activeId` to name a panel actually present.
 */
export function normalize(root: DockNode, seen: Set<string> = new Set()): DockNode | null {
  if (isGroup(root)) {
    const panels = root.panelIds.filter((id) => { if (seen.has(id)) return false; seen.add(id); return true; });
    if (panels.length === 0) return null;
    const active = root.activeId && panels.includes(root.activeId) ? root.activeId : panels[0];
    return { ...root, panelIds: panels, activeId: active };
  }
  // Children first, so an emptied child is gone before this split decides whether it still has a job.
  const kids: DockNode[] = [];
  const keptSizes: DockSize[] = [];
  root.children.forEach((c, i) => {
    const n = normalize(c, seen);
    if (!n) return;
    // Inline a same-direction split: `[a, [b, c]]` and `[a, b, c]` render identically, but only the
    // second lets the operator drag a splitter between b and c and have it mean what it looks like.
    if (isSplit(n) && n.dir === root.dir) {
      kids.push(...n.children);
      keptSizes.push(...n.sizes);
      return;
    }
    kids.push(n);
    keptSizes.push(root.sizes[i] ?? { fr: 1 });
  });
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  return { ...root, children: kids, sizes: keptSizes.length === kids.length ? keptSizes : evenSizes(kids.length) };
}

function finish(tree: DockTree, root: DockNode | null): DockTree {
  const n = root ? normalize(root) : null;
  // A tree that normalized to nothing is not a state the renderer should ever see; keep the old root.
  return n ? { ...tree, root: n } : tree;
}

// ── sanitize ─────────────────────────────────────────────────────────────────────────────────────

function validNode(n: unknown): n is DockNode {
  if (!n || typeof n !== 'object') return false;
  const o = n as Record<string, unknown>;
  if (o.kind === 'group') return typeof o.id === 'string' && Array.isArray(o.panelIds)
    && (o.panelIds as unknown[]).every((p) => typeof p === 'string')
    && (o.render === 'stack' || o.render === 'tabs');
  if (o.kind === 'split') return typeof o.id === 'string' && (o.dir === 'row' || o.dir === 'col')
    && Array.isArray(o.children) && (o.children as unknown[]).every(validNode);
  return false;
}

/**
 * Accept a tree read off disk, or refuse it.
 *
 * IDEMPOTENT, and a refusal is `null` rather than a throw or a repair-at-all-costs: the caller's
 * response to `null` is `defaultTreeOf(...)`, which is a *better* outcome than rendering a mangled
 * arrangement. Version mismatch refuses for the same reason — a future format must not be half-read by
 * an older build that happens to recognise some of its keys.
 */
export function sanitizeDockTree(input: unknown): DockTree | null {
  if (!input || typeof input !== 'object') return null;
  const t = input as Record<string, unknown>;
  if (t.v !== DOCK_TREE_VERSION) return null;
  if (!validNode(t.root)) return null;
  const meta = (t.meta ?? {}) as Record<string, unknown>;
  if (typeof meta.viewport !== 'string') return null;
  const root = normalize(clone(t.root as DockNode));
  if (!root) return null;
  if (depthOf(root) > MAX_DEPTH || countNodes(root) > MAX_NODES) return null;
  return {
    v: DOCK_TREE_VERSION,
    root,
    removed: Array.isArray(t.removed) ? (t.removed as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    meta: { viewport: meta.viewport, companion: typeof meta.companion === 'string' ? meta.companion : undefined },
  };
}

// ── the compiler ─────────────────────────────────────────────────────────────────────────────────

/**
 * Build a context's shipped arrangement from the flat manifest it already declares.
 *
 * THIS IS WHY THE PLUGIN SDK NEEDS NO CHANGE. Contexts and plugins keep declaring `browser[]`/`dock[]`/
 * `inspector[]`/`viewport` exactly as they do now; the tree is derived. And because the ABSENCE of a
 * saved tree is what triggers a build, `banked` lets the first one inherit the operator's own column
 * widths and dock height — so upgrading changes nothing they can see.
 */
export function defaultTreeOf(ctx: DockManifest, banked: DockDefaults = {}): DockTree {
  const centre: DockNode[] = [{
    kind: 'group', id: newId('g'), render: 'tabs', region: 'viewport',
    panelIds: [ctx.viewport], activeId: ctx.viewport,
  }];
  const centreSizes: DockSize[] = [{ fr: 1 }];
  if (ctx.dock?.length) {
    const active = banked.dockPanel && ctx.dock.includes(banked.dockPanel) ? banked.dockPanel : ctx.dock[0];
    centre.push({ kind: 'group', id: newId('g'), render: 'tabs', region: 'dock', panelIds: [...ctx.dock], activeId: active });
    centreSizes.push({ px: banked.dockHeight ?? 280 });
  }
  const centreNode: DockNode = centre.length === 1
    ? centre[0]
    : { kind: 'split', id: newId('s'), dir: 'col', children: centre, sizes: centreSizes };

  const cols: DockNode[] = [];
  const colSizes: DockSize[] = [];
  if (ctx.browser?.length) {
    cols.push({ kind: 'group', id: newId('g'), render: 'stack', region: 'browser', panelIds: [...ctx.browser] });
    colSizes.push({ px: banked.leftWidth ?? 288 });
  }
  cols.push(centreNode);
  colSizes.push({ fr: 1 });
  if (ctx.inspector?.length) {
    cols.push({ kind: 'group', id: newId('g'), render: 'stack', region: 'inspector', panelIds: [...ctx.inspector] });
    colSizes.push({ px: banked.rightWidth ?? 320 });
  }

  const root: DockNode = cols.length === 1 ? cols[0] : { kind: 'split', id: newId('s'), dir: 'row', children: cols, sizes: colSizes };
  const tree: DockTree = { v: DOCK_TREE_VERSION, root, removed: [], meta: { viewport: ctx.viewport, companion: ctx.companion } };
  return finish(tree, tree.root);
}

/**
 * Reconcile a banked tree with what the context declares NOW.
 *
 * Three things happen between banking a tree and rendering it again, and all three are ordinary:
 *  1. a plugin registers a panel late (or is enabled for the first time) — it must appear, in its own
 *     region, rather than being invisible until the operator resets their layout;
 *  2. the operator closed a panel — `removed[]` must survive step 1, or "close" means nothing;
 *  3. a plugin CLAIMS the context's viewport (contextRegistry.extend). The tree still names the old one,
 *     so the viewport group is repointed — otherwise the workbench renders a viewport that is no longer
 *     the context's.
 *
 * Panels in the tree that no longer resolve are deliberately LEFT ALONE here: dropping them would erase
 * a disabled plugin's placement forever, and the renderer already skips an id it cannot resolve. Same
 * reasoning as never pruning orphaned context slices.
 */
export function mergePluginPanels(tree: DockTree, ctx: DockManifest, defaults: DockDefaults = {}): DockTree {
  const present = new Set(panelIds(tree));
  const removed = new Set(tree.removed);
  let next: DockTree = { ...tree, root: clone(tree.root), meta: { ...tree.meta } };

  // 3 — the viewport may have been claimed since this tree was banked.
  if (ctx.viewport !== next.meta.viewport) {
    const old = next.meta.viewport;
    walk(next.root, (n) => {
      if (isGroup(n) && n.panelIds.includes(old)) {
        n.panelIds = n.panelIds.map((p) => (p === old ? ctx.viewport : p));
        if (n.activeId === old) n.activeId = ctx.viewport;
      }
    });
    next.meta = { viewport: ctx.viewport, companion: ctx.companion };
    present.delete(old);
    present.add(ctx.viewport);
  } else if (ctx.companion !== next.meta.companion) {
    next.meta = { ...next.meta, companion: ctx.companion };
  }

  // 1 + 2 — late panels land in their region; a closed one stays closed.
  const byRegion = (r: DockRegion): DockGroupNode | undefined =>
    groups(next).find((g) => g.region === r);
  const declared: Array<[DockRegion, string[]]> = [
    ['browser', ctx.browser ?? []], ['dock', ctx.dock ?? []], ['inspector', ctx.inspector ?? []],
  ];
  for (const [region, ids] of declared) {
    for (const id of ids) {
      if (present.has(id) || removed.has(id)) continue;
      const host = byRegion(region);
      if (host) {
        host.panelIds.push(id);
      } else {
        // The region was empty when this tree was built (a context that declared no dock, say, and a
        // plugin has now contributed one). Give it a group rather than silently dropping the panel.
        next = addRegionGroup(next, region, id, defaults);
      }
      present.add(id);
    }
  }
  return finish(next, next.root);
}

function addRegionGroup(tree: DockTree, region: DockRegion, panelId: string, defaults: DockDefaults): DockTree {
  const g: DockGroupNode = {
    kind: 'group', id: newId('g'), region,
    render: region === 'dock' || region === 'viewport' ? 'tabs' : 'stack',
    panelIds: [panelId], activeId: panelId,
  };
  const size: DockSize = region === 'browser' ? { px: defaults.leftWidth ?? 288 }
    : region === 'inspector' ? { px: defaults.rightWidth ?? 320 }
    : { px: defaults.dockHeight ?? 280 };
  const dir: 'row' | 'col' = region === 'dock' ? 'col' : 'row';
  const before = region === 'browser';
  const root = tree.root;
  if (isSplit(root) && root.dir === dir) {
    const children = before ? [g, ...root.children] : [...root.children, g];
    const sizes = before ? [size, ...root.sizes] : [...root.sizes, size];
    return { ...tree, root: { ...root, children, sizes } };
  }
  return {
    ...tree,
    root: {
      kind: 'split', id: newId('s'), dir,
      children: before ? [g, root] : [root, g],
      sizes: before ? [size, { fr: 1 }] : [{ fr: 1 }, size],
    },
  };
}

// ── ops (all pure; each returns a new tree, already normalized) ───────────────────────────────────

/** Reorder a panel inside its own group. */
export function reorderTab(tree: DockTree, groupId: string, panelId: string, index: number): DockTree {
  const root = clone(tree.root);
  walk(root, (n) => {
    if (!isGroup(n) || n.id !== groupId) return;
    const from = n.panelIds.indexOf(panelId);
    if (from < 0) return;
    n.panelIds.splice(from, 1);
    n.panelIds.splice(Math.max(0, Math.min(index, n.panelIds.length)), 0, panelId);
  });
  return finish(tree, root);
}

export function setActive(tree: DockTree, groupId: string, panelId: string): DockTree {
  const root = clone(tree.root);
  walk(root, (n) => { if (isGroup(n) && n.id === groupId && n.panelIds.includes(panelId)) n.activeId = panelId; });
  return finish(tree, root);
}

export function toggleCollapsed(tree: DockTree, groupId: string): DockTree {
  const root = clone(tree.root);
  walk(root, (n) => { if (isGroup(n) && n.id === groupId) n.collapsed = !n.collapsed; });
  return finish(tree, root);
}

/** Splitter drag result. Sizes are written wholesale so a drag commits one coherent row. */
export function setSplitSizes(tree: DockTree, splitId: string, sizes: DockSize[]): DockTree {
  const root = clone(tree.root);
  walk(root, (n) => { if (isSplit(n) && n.id === splitId && sizes.length === n.children.length) n.sizes = clone(sizes); });
  return finish(tree, root);
}

/**
 * Close a panel. The VIEWPORT cannot be closed — a workbench with no viewport is not a state the
 * operator can get back out of, and "Reset layout" being the only escape is not a design.
 */
export function closePanel(tree: DockTree, panelId: string): DockTree {
  if (panelId === tree.meta.viewport) return tree;
  const root = clone(tree.root);
  walk(root, (n) => { if (isGroup(n)) n.panelIds = n.panelIds.filter((p) => p !== panelId); });
  const removed = tree.removed.includes(panelId) ? tree.removed : [...tree.removed, panelId];
  return finish({ ...tree, removed }, root);
}

/** Add a panel to a group (default: the first tabbed group). Un-closes it, or `close` would be permanent. */
export function addPanel(tree: DockTree, panelId: string, targetGroupId?: string): DockTree {
  if (panelIds(tree).includes(panelId)) return tree;
  const root = clone(tree.root);
  const all: DockGroupNode[] = [];
  walk(root, (n) => { if (isGroup(n)) all.push(n); });
  const host = all.find((g) => g.id === targetGroupId) ?? all.find((g) => g.render === 'tabs') ?? all[0];
  if (!host) return tree;
  host.panelIds.push(panelId);
  host.activeId = panelId;
  return finish({ ...tree, removed: tree.removed.filter((p) => p !== panelId) }, root);
}

export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

/**
 * The drag-and-drop op: move a panel onto a group, either as a tab or by splitting that group.
 *
 * Refuses to deepen the tree past MAX_DEPTH rather than producing a tree that `sanitizeDockTree` would
 * later refuse to load — a layout that works until you restart is worse than a drag that declines.
 */
export function moveTab(tree: DockTree, panelId: string, targetGroupId: string, zone: DropZone): DockTree {
  const from = findGroupOf(tree, panelId);
  if (!from) return tree;
  // A no-op drop: onto its own group's centre, or onto a group it is already the only member of.
  if (zone === 'center' && from.id === targetGroupId) return tree;
  if (from.id === targetGroupId && from.panelIds.length === 1) return tree;

  let root = clone(tree.root);
  // Detach first, so a move within the same split cannot leave a duplicate behind.
  walk(root, (n) => { if (isGroup(n)) n.panelIds = n.panelIds.filter((p) => p !== panelId); });

  if (zone === 'center') {
    let placed = false;
    walk(root, (n) => {
      if (placed || !isGroup(n) || n.id !== targetGroupId) return;
      n.panelIds.push(panelId);
      n.activeId = panelId;
      placed = true;
    });
    return placed ? finish(tree, root) : tree;
  }

  const dir: 'row' | 'col' = zone === 'left' || zone === 'right' ? 'row' : 'col';
  const before = zone === 'left' || zone === 'top';
  // No `region`: this group is the operator's, not part of the shipped arrangement, so a later
  // mergePluginPanels must not treat it as the home for late-registered panels of some region.
  const fresh: DockGroupNode = {
    kind: 'group', id: newId('g'), render: 'tabs', panelIds: [panelId], activeId: panelId,
  };
  const wrap = (target: DockNode): DockSplitNode => ({
    kind: 'split', id: newId('s'), dir,
    children: before ? [fresh, target] : [target, fresh],
    sizes: [{ fr: 0.5 }, { fr: 0.5 }],
  });
  // The target can BE the root (a context with one group and no columns), which a descend-only
  // replacement silently misses — the panel then vanishes, because it was already detached above.
  if (root.id === targetGroupId) root = wrap(root);
  else if (!replaceNode(root, targetGroupId, wrap)) return tree;
  const out = finish(tree, root);
  return depthOf(out.root) > MAX_DEPTH || countNodes(out.root) > MAX_NODES ? tree : out;
}

/** Swap one node for another, in place, by id. Returns whether it found it. */
function replaceNode(root: DockNode, id: string, make: (found: DockNode) => DockNode): boolean {
  if (!isSplit(root)) return false;
  for (let i = 0; i < root.children.length; i++) {
    const c = root.children[i];
    if (c.id === id) { root.children[i] = make(c); return true; }
    if (replaceNode(c, id, make)) return true;
  }
  return false;
}

/**
 * The tree to render: the banked one if it still makes sense, otherwise the shipped arrangement.
 * The single door every caller uses — see the guard in verify-invariants.
 */
export function ensureTree(saved: unknown, ctx: DockManifest, banked: DockDefaults = {}): DockTree {
  const ok = sanitizeDockTree(saved);
  return ok ? mergePluginPanels(ok, ctx, banked) : defaultTreeOf(ctx, banked);
}
