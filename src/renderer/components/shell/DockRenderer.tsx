import React from 'react';
import type { PanelContribution, SelectionSnapshot } from '@artlux/sdk/renderer';
import { panelRegistry, appliesToSelection } from '../../host/registries';
import type { DockNode, DockSize, DockTree } from '../../services/dockTree';
import { addPanel, closePanel, defaultTreeOf, moveTab, panelIds, setActive, setSplitSizes, toggleCollapsed,
  type DockManifest, type DropZone } from '../../services/dockTree';
import { useDockDrag, type DragApi } from './DockDrag';
import { X, Plus, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { ErrorBoundary } from '../ErrorBoundary';
import { ViewportSlot } from './PersistentLayer';

// Renders a DockTree. Plan: plans/dockable-workspace.md §2-§4.
//
// This walks the tree and nothing else — it does not know what a "browser column" is, only that a group
// with `render:'stack'` stacks its panels and one with `render:'tabs'` shows one at a time. That is what
// makes the arrangement the operator's rather than ours: the same renderer draws the shipped layout and
// whatever they drag it into.
//
// It imports no panel, exactly like WorkspaceShell: ids are resolved against `panelRegistry` at render
// time, so a plugin's panel and a core panel are indistinguishable here.

interface Ctx {
  contextId: string;
  selection: SelectionSnapshot;
  /** Ids App owns and PersistentLayer draws — rendered as slots, never as components. */
  persistentIds: string[];
  /** Chrome for a stacked panel; the shell owns the section look, so it passes it in. */
  renderPanel: (panel: PanelContribution) => React.ReactNode;
  onTree: (next: DockTree) => void;
  tree: DockTree;
  drag: DragApi;
  /** The context's own manifest, so "Reset this workbench" recompiles rather than hand-building a tree. */
  manifest: DockManifest;
  /** Banked ergonomics for a reset, so it lands where the shipped arrangement would. */
  defaults: { leftWidth?: number; rightWidth?: number; dockHeight?: number; dockPanel?: string };
  /**
   * SPLIT VIEW, which is a layout flag rather than a tree node — and deliberately still is.
   *
   * `layout.splitView` pairs a context's own viewport with the 3D venue scene (Calibration declares it
   * on, because the pose step needs the camera and the scene side by side). It is a runtime toggle, not
   * something a context's manifest declares, so it cannot be compiled into the shipped tree; and
   * dropping it would have made the 3D scene unreachable in Calibration under docking — which is
   * exactly what the parity check caught before this existed.
   *
   * It becomes redundant the moment the operator can simply DRAG the 3D viewport into a pane. Until
   * then the viewport group honours it, so both render paths put the same thing on screen.
   */
  splitWith?: { id: string; ratio: number; onRatio: (r: number) => void };
}

/**
 * A pane's flex, and the shrink factor is the whole story.
 *
 * ⚠ A px PANE MUST BE ALLOWED TO SHRINK. `flex: 0 0 280px` reads like "this column is 280 wide", and in
 * a window with room it is. In a SHORT window it means "280px whatever happens": on a 541px-tall screen
 * the workspace gets ~200px, the dock keeps its 280+, and the difference has to go somewhere — it went
 * *outside* the workspace box, painting the dock over the timeline drawer and leaving the bottom of the
 * window black, permanently, because nothing about it is a repaint artefact. (Reported from a real
 * 1264x541 window; every automated check until then ran at 908 or 1700 tall and never saw it.)
 *
 * `0 1 Npx` keeps the requested size when it fits and gives way when it does not, which is what every
 * fixed column in the hand-built shell already does through its own clamp.
 */
const sizeToFlex = (s: DockSize | undefined, frSum = 1): React.CSSProperties =>
  s && 'px' in s
    // ...and the cap is the second half. Shrinking stops the OVERFLOW; it does not stop a 280px dock
    // from taking every pixel of a 200px workspace and leaving the stage at zero height — which is what
    // the hand-built shell also does at this size, and is no better for being long-standing. `min()`
    // clamps declaratively, with no measuring: at any comfortable window it is inert (45% of a 1216px
    // row is 547, far past a 288px column), and it only bites when the pane would otherwise swallow the
    // one beside it.
    ? { flexGrow: 0, flexShrink: 1, flexBasis: `min(${s.px}px, 45%)` }
    // ⚠ THE GROW FACTORS OF A SPLIT MUST SUM TO AT LEAST 1, WHICH IS WHY `fr` IS NORMALIZED HERE
    // RATHER THAN USED RAW.
    //
    // Flexbox has a rule that is easy to walk straight into: when the flex-grow factors on a line sum
    // to LESS than 1, only that fraction of the free space is distributed and the remainder is simply
    // left empty. A split holding a viewport at `fr: 0.43` and a dock at a fixed px therefore fills 43%
    // of the leftover and paints page background over the other 57% — a black band across the middle of
    // the workspace, in a perfectly ordinary window. (Reported live. The 0.43 came from this file's own
    // splitter commit, which stores an fr relative to the two panes it touched.)
    //
    // Normalizing by the split's own fr total keeps every relative proportion exactly as authored and
    // makes the sum 1 by construction, so no stored tree — including one saved before this fix — can
    // reproduce it.
    : { flexGrow: frSum > 0 ? (s && 'fr' in s ? s.fr : 1) / frSum : 1, flexShrink: 1, flexBasis: '0%' };

/**
 * A splitter that is LOCAL DURING THE DRAG and commits once on release.
 *
 * The shell's existing column splitters call `layoutStore.set()` on every pointer move, which
 * re-renders the whole shell at pointer rate — measured at ~190 ms/s of React commit time during a
 * drag (WP-5.2). Docking adds a splitter between every pair of panes, so copying that would multiply a
 * cost the last two work packages spent themselves removing. This writes flex-basis straight onto the
 * two sibling elements while the pointer moves and touches the store exactly once, on pointerup — the
 * same rule the timeline and the stage already follow for clip and fixture drags.
 */
const Splitter: React.FC<{
  dir: 'row' | 'col';
  hostRef: React.RefObject<HTMLDivElement>;
  index: number;
  node: Extract<DockNode, { kind: 'split' }>;
  onCommit: (sizes: DockSize[]) => void;
}> = ({ dir, hostRef, index, node, onCommit }) => {
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const host = hostRef.current;
    if (!host) return;
    const kids = [...host.children].filter((c) => (c as HTMLElement).dataset.dockPane === '1') as HTMLElement[];
    const a = kids[index];
    const b = kids[index + 1];
    if (!a || !b) return;
    const horiz = dir === 'row';
    const start = horiz ? e.clientX : e.clientY;
    const aStart = horiz ? a.getBoundingClientRect().width : a.getBoundingClientRect().height;
    const bStart = horiz ? b.getBoundingClientRect().width : b.getBoundingClientRect().height;
    const MIN = 80;
    let aNow = aStart;
    let bNow = bStart;
    const move = (ev: PointerEvent) => {
      const d = (horiz ? ev.clientX : ev.clientY) - start;
      aNow = Math.max(MIN, aStart + d);
      bNow = Math.max(MIN, bStart - d);
      // Direct style writes — no state, no render. This is the whole point of the component.
      a.style.flex = `0 0 ${aNow}px`;
      b.style.flex = `0 0 ${bNow}px`;
    };
    const done = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      // ONE commit, on release. Sizes keep their kind: a px pane stays px (a column the operator sized),
      // an fr pane stays fr (it should keep absorbing the leftover when the window resizes).
      const total = aNow + bNow;
      const sizes = node.sizes.slice();
      const keep = (i: number, px: number): DockSize => ('px' in (node.sizes[i] ?? {}) ? { px } : { fr: px / Math.max(1, total) });
      sizes[index] = keep(index, aNow);
      sizes[index + 1] = keep(index + 1, bNow);
      onCommit(sizes);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  };
  return (
    <div
      onPointerDown={onDown}
      role="separator"
      aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'}
      title="Drag to resize"
      className={`shrink-0 bg-line-1 hover:bg-accent ${dir === 'row' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}`}
    />
  );
};

/** The split-view divider. Local during the drag, one commit on release — same rule as Splitter. */
const RatioSplitter: React.FC<{ onRatio: (r: number) => void }> = ({ onRatio }) => {
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const host = (e.currentTarget as HTMLElement).parentElement;
    if (!host) return;
    const box = host.getBoundingClientRect();
    const panes = [...host.children].filter((c) => (c as HTMLElement).classList.contains('relative')) as HTMLElement[];
    let r = 0.5;
    const move = (ev: PointerEvent) => {
      r = Math.max(0.15, Math.min(0.85, (ev.clientX - box.left) / Math.max(1, box.width)));
      if (panes[0]) panes[0].style.flex = `${r} 1 0%`;
      if (panes[1]) panes[1].style.flex = `${1 - r} 1 0%`;
    };
    const done = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      onRatio(r);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  };
  return <div onPointerDown={onDown} role="separator" aria-orientation="vertical" title="Drag to resize"
    className="w-1 shrink-0 bg-line-1 hover:bg-accent cursor-col-resize" />;
};


// A popover: click-away shield plus a positioned card. Both menus below use it.
const Popover: React.FC<{ at: { x: number; y: number }; onClose: () => void; children: React.ReactNode }> = ({ at, onClose, children }) => (
  <>
    <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
    <div className="fixed z-50 min-w-[190px] bg-surface-1 border border-line-1 rounded-md p-1 shadow-e2"
      style={{ left: Math.min(at.x, window.innerWidth - 210), top: Math.min(at.y, window.innerHeight - 260) }}>
      {children}
    </div>
  </>
);

const Item: React.FC<{ onClick: () => void; children: React.ReactNode; danger?: boolean }> = ({ onClick, children, danger }) => (
  <button onClick={onClick} className={`w-full text-left px-2 py-1.5 rounded text-mini hover:bg-surface-2 ${danger ? 'text-danger' : 'text-fg-1'}`}>{children}</button>
);

function groupIdsOf(tree: DockTree): string[] {
  const out: string[] = [];
  const go = (n: DockNode) => { if (n.kind === 'group') out.push(n.id); else n.children.forEach(go); };
  go(tree.root);
  return out;
}

/**
 * Every drag operation, reachable from the keyboard.
 *
 * Docking that could only be done by dragging would quietly undo the roving-tabindex and WCAG-AA work
 * already in this shell: an operator who cannot use a pointer would lose the ability to arrange their
 * own workbench, which is the entire feature. So this menu offers the same four splits, the same move
 * and the same close that a drag does.
 */
const TabMenu: React.FC<{ ctx: Ctx; node: Extract<DockNode, { kind: 'group' }>; at: { panelId: string; x: number; y: number }; onClose: () => void }> =
({ ctx, node, at, onClose }) => {
  const send = (t: DockTree) => { onClose(); if (t !== ctx.tree) ctx.onTree(t); };
  const zones: Array<[DropZone, string]> = [['left', 'Split left'], ['right', 'Split right'], ['top', 'Split up'], ['bottom', 'Split down']];
  const others = groupIdsOf(ctx.tree).filter((g) => g !== node.id);
  return (
    <Popover at={at} onClose={onClose}>
      <div className="px-2 pt-1 pb-1.5 text-micro text-fg-3 border-b border-line-1 mb-1 truncate">{at.panelId.split('.').pop()}</div>
      {zones.map(([z, label]) => <Item key={z} onClick={() => send(moveTab(ctx.tree, at.panelId, node.id, z))}>{label}</Item>)}
      {others.length > 0 && <div className="h-px bg-line-1 my-1" />}
      {others.map((g) => <Item key={g} onClick={() => send(moveTab(ctx.tree, at.panelId, g, 'center'))}>Move to group {g}</Item>)}
      {at.panelId !== ctx.tree.meta.viewport && (
        <>
          <div className="h-px bg-line-1 my-1" />
          <Item danger onClick={() => send(closePanel(ctx.tree, at.panelId))}>Close panel</Item>
        </>
      )}
    </Popover>
  );
};

/** Add any registered panel, and the way back to the shipped arrangement. */
const AddMenu: React.FC<{ ctx: Ctx; at: { x: number; y: number; groupId: string }; onClose: () => void }> = ({ ctx, at, onClose }) => {
  const inTree = new Set(panelIds(ctx.tree));
  // `mount: 'modal'` panels render OUTSIDE <EditorStore>, so a useEditor() call inside one would throw
  // the instant it was docked. They are not offerable, structurally.
  const available = panelRegistry.all()
    .filter((p) => p.mount !== 'modal' && !inTree.has(p.id))
    .sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id));
  return (
    <Popover at={at} onClose={onClose}>
      <div className="px-2 pt-1 pb-1.5 text-micro text-fg-3 border-b border-line-1 mb-1">Add a panel</div>
      <div className="max-h-64 overflow-auto">
        {available.length === 0
          ? <div className="px-2 py-1.5 text-micro text-fg-3 italic">Everything is already on screen.</div>
          : available.map((p) => <Item key={p.id} onClick={() => { onClose(); ctx.onTree(addPanel(ctx.tree, p.id, at.groupId)); }}>{p.title ?? p.id}</Item>)}
      </div>
      <div className="h-px bg-line-1 my-1" />
      {/* Reset RECOMPILES from the live manifest - never a hand-built tree - so the way back is always
          exactly what the context ships, including whatever a plugin has contributed since. */}
      <Item onClick={() => { onClose(); ctx.onTree(defaultTreeOf(ctx.manifest, ctx.defaults)); }}>
        <span className="inline-flex items-center gap-1.5"><RotateCcw size={11} /> Reset this workbench</span>
      </Item>
    </Popover>
  );
};

const GroupBody: React.FC<{ node: Extract<DockNode, { kind: 'group' }>; ctx: Ctx }> = ({ node, ctx }) => {
  const [menu, setMenu] = React.useState<{ panelId: string; x: number; y: number } | null>(null);
  const [add, setAdd] = React.useState<{ x: number; y: number; groupId: string } | null>(null);
  // An id that does not resolve is SKIPPED, not dropped from the tree (see dockTree's merge rules): a
  // disabled plugin must not cost the operator the placement they chose.
  const resolved = node.panelIds
    .map((id) => ({ id, panel: ctx.persistentIds.includes(id) ? null : panelRegistry.get(id) }))
    .filter((p) => p.panel || ctx.persistentIds.includes(p.id))
    // A parameter section that does not apply to the current selection is not drawn — the same rule
    // the hand-built column has always applied, which this path was missing entirely. It is a RENDER
    // filter only: the panel stays in the tree, so the operator's placement survives a selection
    // change and comes back when they select that kind again.
    .filter((p) => !p.panel || appliesToSelection(p.panel, ctx.selection));

  if (node.render === 'stack') {
    return (
      <div data-dock-group={node.id} data-dock-render="stack" className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-surface-1">
        {resolved.map(({ id, panel }) => (
          panel ? <React.Fragment key={id}>{ctx.renderPanel(panel)}</React.Fragment>
            : <div key={id} className="relative flex-1 min-h-0"><ViewportSlot id={id} /></div>
        ))}
      </div>
    );
  }

  const activeId = node.activeId && resolved.some((r) => r.id === node.activeId) ? node.activeId : resolved[0]?.id;
  const active = resolved.find((r) => r.id === activeId);
  const split = node.region === 'viewport' ? ctx.splitWith : undefined;
  // The viewport group is what pairs. NOT gated on the main pane being a persistent viewport: in
  // Calibration the PLUGIN claims the viewport, so the main pane is a registry panel (the wizard rail
  // and camera) and the 3D scene is the thing beside it — which is the entire workbench. Gating on it
  // is what made the parity check report the scene missing there.
  return (
    <div data-dock-group={node.id} data-dock-render="tabs" className="flex-1 min-w-0 min-h-0 flex flex-col bg-surface-0">
      {/* A viewport group holding ONLY its viewport draws no tab bar: a strip there would eat a slice of
          the stage in every context to say one thing the workbench already says. The moment anything else
          is dropped in, it needs one - without it the dropped panel is invisible AND unreachable, which
          is exactly what the interaction test caught. Every other group gets a strip even at a single
          tab, because that strip is the handle the whole feature is operated through. */}
      {(node.region !== 'viewport' || resolved.length > 1) && (
        <div role="tablist" className="shrink-0 flex items-stretch h-7 border-b border-line-1 bg-surface-1">
          <button onClick={() => ctx.onTree(toggleCollapsed(ctx.tree, node.id))}
            title={node.collapsed ? 'Expand' : 'Collapse'} aria-expanded={!node.collapsed}
            className="px-1 text-fg-3 shrink-0">
            {node.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
          <div className="flex items-stretch overflow-x-auto min-w-0">
            {resolved.map(({ id, panel }) => (
              <div
                key={id}
                role="tab"
                tabIndex={0}
                aria-selected={id === activeId}
                data-dock-tab={id}
                onPointerDown={(e) => ctx.drag.startTabDrag(e, id)}
                onClick={() => ctx.onTree(setActive(ctx.tree, node.id, id))}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.onTree(setActive(ctx.tree, node.id, id)); } }}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ panelId: id, x: e.clientX, y: e.clientY }); }}
                title={`${panel?.title ?? id} - drag to move, right-click for options`}
                className={`group px-2.5 flex items-center gap-1 text-mini whitespace-nowrap border-r border-line-1 cursor-grab select-none ${id === activeId ? 'bg-surface-0 text-fg-1' : 'text-fg-3'}`}
              >
                {panel?.title ?? id.split('.').pop()}
                {/* No close on the viewport: closePanel refuses it, because a workbench with no viewport
                    is a state the operator cannot get back out of. */}
                {id !== ctx.tree.meta.viewport && (
                  <button onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); ctx.onTree(closePanel(ctx.tree, id)); }}
                    title="Close panel" className="opacity-0 group-hover:opacity-100 text-fg-3 hover:text-danger">
                    <X size={10} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setAdd({ x: r.left, y: r.bottom, groupId: node.id }); }}
            title="Add a panel here" className="ml-auto px-1.5 text-fg-3 shrink-0"><Plus size={12} /></button>
        </div>
      )}
      {!node.collapsed && (
      <div className="flex-1 min-h-0 relative flex">
        {active && (
          <div className="relative min-w-0 min-h-0 overflow-hidden" style={{ flex: split ? `${split.ratio} 1 0%` : '1 1 0%' }}>
            {active.panel
              ? <div className="absolute inset-0 overflow-auto">
                  <ErrorBoundary variant="panel" label={active.panel.title ?? active.panel.id}>
                    <active.panel.Component contextId={ctx.contextId} selection={ctx.selection} />
                  </ErrorBoundary>
                </div>
              : <ViewportSlot id={active.id} />}
          </div>
        )}
        {split && (
          <>
            <RatioSplitter onRatio={split.onRatio} />
            <div className="relative min-w-0" style={{ flex: `${1 - split.ratio} 1 0%` }}><ViewportSlot id={split.id} /></div>
          </>
        )}
      </div>
      )}
      {menu && <TabMenu ctx={ctx} node={node} at={menu} onClose={() => setMenu(null)} />}
      {add && <AddMenu ctx={ctx} at={add} onClose={() => setAdd(null)} />}
    </div>
  );
};

const Node: React.FC<{ node: DockNode; ctx: Ctx }> = ({ node, ctx }) => {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const paneRefs = React.useRef<Array<HTMLDivElement | null>>([]);
  // The split's own fr total - see sizeToFlex for why this has to be normalized rather than used raw.
  const frSum = node.kind === 'split'
    ? node.children.reduce((a, _c, i) => { const sz = node.sizes[i]; return a + (sz && 'fr' in sz ? sz.fr : 0); }, 0)
    : 0;

  // ⚠ THE PANES' FLEX IS ASSERTED HERE, AFTER EVERY RENDER — IT IS NOT A `style` PROP, AND THAT IS THE
  // WHOLE POINT.
  //
  // The splitter drags by writing pixel sizes straight onto these two elements, which is what keeps a
  // resize off the React path. The trap is that React only writes a style property when its own PROPS
  // change: an `fr` pane's computed style is `grow: <share>, basis: 0%` before a drag AND after it, so
  // React sees nothing to do and the drag's `0 0 1056px` stays on the element FOREVER. Every pane in
  // the split then has grow 0, so widening the window distributes the new space to nobody — a black
  // strip down the right edge of the workspace and another under the dock, exactly as reported.
  //
  // A layout effect with no dependency array runs after every render, so whatever a drag left behind is
  // overwritten by the arrangement the tree actually describes. Declarative styling cannot do this,
  // because "the value did not change" is precisely the case that has to be repaired.
  //
  // ⚠ BUT COMPARE BEFORE WRITING — the repair used to be unconditional, and it was the most expensive
  // thing in the editor. This effect runs after EVERY render, and App re-renders every frame while the
  // transport runs, so four blind style writes per pane became a style + layout invalidation of the
  // whole workspace, sixty times a second. It is paid by whatever the shell happens to be holding: on a
  // 200-fixture rig the browser column alone is ~1,200 nodes, and collapsing it measured 34 → 56 fps.
  // A Chromium trace of the same scene showed the renderer main thread ~19% in Blink's lifecycle —
  // Commit 8%, HitTest 4.3%, Layerize 3.8%, Paint 2.9% — inside a viewport whose 3D content was fine.
  //
  // Comparing against the ELEMENT rather than against props is what keeps the repair working. React
  // could not fix a drag because its own props had not changed; the DOM had, and that is exactly what
  // is read here. After a drag `flexGrow` is `'0'` against a target of `'1'`, so it is written; in the
  // steady state every value already matches and nothing is touched, so Blink invalidates nothing.
  //
  // The old `el.style.flex = ''` is gone rather than made conditional: setting all three longhands
  // below fully determines the shorthand a drag wrote (`flex: 0 0 1056px` IS those three), so clearing
  // first only guaranteed a write every time.
  React.useLayoutEffect(() => {
    if (node.kind !== 'split') return;
    node.children.forEach((child, i) => {
      const el = paneRefs.current[i];
      if (!el) return;
      const s = child.kind === 'group' && child.collapsed
        ? { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' }
        : sizeToFlex(node.sizes[i], frSum);
      // A value the CSSOM serializes differently from what we hand it (`flexBasis: min(288px, 45%)`)
      // simply never matches and is rewritten every render — the old behaviour, and still correct.
      const put = (prop: 'flexGrow' | 'flexShrink' | 'flexBasis', val: string) => {
        if (el.style[prop] !== val) el.style[prop] = val;
      };
      put('flexGrow', String(s.flexGrow));
      put('flexShrink', String(s.flexShrink));
      put('flexBasis', String(s.flexBasis));
    });
  });

  if (node.kind === 'group') return <GroupBody node={node} ctx={ctx} />;
  return (
    // overflow-hidden on the SPLIT too, not just on each pane: a pane that cannot shrink far enough
    // would otherwise paint outside the workspace entirely - which is exactly how a short window ended
    // up with a permanently black lower half. Clipping makes the worst case a cramped pane rather than
    // content drawn over the drawer and the status bar.
    <div ref={hostRef} className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${node.dir === 'row' ? 'flex-row' : 'flex-col'}`}>
      {node.children.map((child, i) => (
        <React.Fragment key={child.id}>
          {i > 0 && (
            <Splitter
              dir={node.dir}
              hostRef={hostRef}
              index={i - 1}
              node={node}
              onCommit={(sizes) => ctx.onTree(setSplitSizes(ctx.tree, node.id, sizes))}
            />
          )}
          {/* `flex` on the pane is load-bearing, not decoration: without it a nested split's `flex-1`
              has no flex parent to size against, the split collapses to content height, and every
              slot inside it measures 0 in one axis — the viewport is then invisible while the DOM
              says it is right there. Found by probing rects, not by looking at the screen. */}
          <div data-dock-pane="1" ref={(el) => { paneRefs.current[i] = el; }}
            className="min-h-0 min-w-0 relative overflow-hidden flex">
            <Node node={child} ctx={ctx} />
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};

export const DockRenderer: React.FC<{ tree: DockTree; ctx: Omit<Ctx, 'tree' | 'drag'> }> = ({ tree, ctx }) => {
  const { api, overlay } = useDockDrag(tree, ctx.onTree);
  return (
    <>
      <Node node={tree.root} ctx={{ ...ctx, tree, drag: api }} />
      {overlay}
    </>
  );
};
