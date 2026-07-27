import React from 'react';
import type { PanelContribution, SelectionSnapshot } from '@artlux/sdk/renderer';
import { panelRegistry } from '../../host/registries';
import type { DockNode, DockSize, DockTree } from '../../services/dockTree';
import { setActive, setSplitSizes } from '../../services/dockTree';
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

const sizeToFlex = (s: DockSize | undefined): React.CSSProperties =>
  s && 'px' in s ? { flex: `0 0 ${s.px}px` } : { flex: `${s && 'fr' in s ? s.fr : 1} 1 0%` };

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

const GroupBody: React.FC<{ node: Extract<DockNode, { kind: 'group' }>; ctx: Ctx }> = ({ node, ctx }) => {
  // An id that does not resolve is SKIPPED, not dropped from the tree (see dockTree's merge rules): a
  // disabled plugin must not cost the operator the placement they chose.
  const resolved = node.panelIds
    .map((id) => ({ id, panel: ctx.persistentIds.includes(id) ? null : panelRegistry.get(id) }))
    .filter((p) => p.panel || ctx.persistentIds.includes(p.id));

  if (node.render === 'stack') {
    return (
      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-surface-1">
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
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-surface-0">
      {/* A viewport group draws no tab bar: one item, and a bar there would eat a strip of the stage in
          every context for no information. Any other tabbed group gets one even at a single tab, because
          that strip is the drag handle the whole feature is operated through. */}
      {node.region !== 'viewport' && (
        <div role="tablist" className="shrink-0 flex items-stretch h-7 border-b border-line-1 bg-surface-1 overflow-x-auto">
          {resolved.map(({ id, panel }) => (
            <button
              key={id}
              role="tab"
              aria-selected={id === activeId}
              data-dock-tab={id}
              onClick={() => ctx.onTree(setActive(ctx.tree, node.id, id))}
              className={`px-2.5 text-mini whitespace-nowrap border-r border-line-1 ${id === activeId ? 'bg-surface-0 text-fg-1' : 'text-fg-3'}`}
            >
              {panel?.title ?? id.split('.').pop()}
            </button>
          ))}
        </div>
      )}
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
    </div>
  );
};

const Node: React.FC<{ node: DockNode; ctx: Ctx }> = ({ node, ctx }) => {
  const hostRef = React.useRef<HTMLDivElement>(null);
  if (node.kind === 'group') return <GroupBody node={node} ctx={ctx} />;
  return (
    <div ref={hostRef} className={`flex min-h-0 min-w-0 flex-1 ${node.dir === 'row' ? 'flex-row' : 'flex-col'}`}>
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
          <div data-dock-pane="1" className="min-h-0 min-w-0 relative overflow-hidden flex" style={sizeToFlex(node.sizes[i])}>
            <Node node={child} ctx={ctx} />
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};

export const DockRenderer: React.FC<{ tree: DockTree; ctx: Omit<Ctx, 'tree'> }> = ({ tree, ctx }) => (
  <Node node={tree.root} ctx={{ ...ctx, tree }} />
);
