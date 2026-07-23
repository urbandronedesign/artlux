import React from 'react';
import type { PanelContribution, SelectionSnapshot } from '@artlux/sdk/renderer';
import { contextRegistry, panelRegistry } from '../../host/registries';
import { layoutStore } from '../../services/layoutStore';
import { useLayout } from '../../hooks/useLayout';
import { useResizable } from '../../hooks/useResizable';
import { CollapsibleSection } from '../CollapsibleSection';
import { Dock } from '../Dock';
import { ContextRail } from './ContextRail';
import { ActionBar } from './ActionBar';
import { CommandPalette } from './CommandPalette';

// The context-driven editor shell.
//
// It renders rail · action bar · browser · viewport · dock · parameters, and every one of those
// except the rail is composed from PANEL IDS the active WorkspaceContext names. The shell resolves
// an id against `panelRegistry` at render time — it imports no panel, so a plugin's panel and a core
// panel are indistinguishable here. That is the whole point: adding a workbench is a registration,
// not an edit to this file.
//
// ── The two-pane viewport, and why it is shaped this way ────────────────────────────────────
// Two hard constraints from the engine, both of which a naive `{active === x && <X/>}` breaks:
//
//   1. `Stage` MUST NEVER UNMOUNT. It owns the per-frame GPU sampling that publishes `dmx:frame`;
//      unmounting it stops Art-Net output mid-show.
//   2. There must be EXACTLY ONE `TimelinePanel`. Two instances double its keyboard hook and its
//      engine subscription (App has guarded this since the dock/fullscreen split).
//
// So the persistent viewports are passed in as elements from App and live at FIXED positions in this
// tree, always mounted, shown or hidden with CSS. A React element can only exist at one position, so
// a viewport cannot "move" between panes — instead each one is assigned to a pane permanently:
// `scene3d` is always the RIGHT pane, everything else is always the LEFT pane. The context and the
// splitView flag then only change the two panes' WIDTHS. Split view, a maximized 3D context and a
// plain 2D context are all the same tree with different widths, and nothing ever remounts.

export const SCENE_3D_VIEWPORT = 'core.viewport.scene3d';

interface Props {
  /** Persistent viewports (id → element), mounted once by App and never remounted. */
  viewports: Record<string, React.ReactNode>;
  selection: SelectionSnapshot;
  /** Global drawers (Docs, Help) — not owned by any context, pinned to the far right. */
  drawers?: React.ReactNode;
}

// One browser/inspector panel, with the shell's section chrome unless the panel draws its own.
const PanelSection: React.FC<{ panel: PanelContribution; contextId: string; selection: SelectionSnapshot }> =
({ panel, contextId, selection }) => {
  const body = <panel.Component contextId={contextId} selection={selection} />;
  // A bare panel draws its own chrome, but it still has to participate in the browser column's flex
  // layout: without this wrapper a full-height bare panel (MediaPanel is `h-full`) eats the column and
  // every section stacked under it disappears.
  if (panel.bare) return <div className={panel.grow ? 'flex-1 min-h-0 overflow-hidden' : 'shrink-0'}>{body}</div>;
  const Actions = panel.HeaderActions;
  return (
    <CollapsibleSection
      title={panel.title ?? panel.id}
      icon={panel.icon}
      defaultOpen={panel.defaultOpen ?? true}
      grow={panel.grow}
      action={Actions ? <Actions contextId={contextId} selection={selection} /> : undefined}
      // Parameter sections get the inspector's padded, evenly-spaced body; browser sections manage
      // their own dense list padding.
      bodyClassName={panel.mount === 'inspector' ? 'p-3 bg-surface-1 space-y-3' : 'bg-surface-1'}
    >
      {body}
    </CollapsibleSection>
  );
};

export const WorkspaceShell: React.FC<Props> = ({ viewports, selection, drawers }) => {
  const layout = useLayout();
  const all = contextRegistry.all();
  const context = contextRegistry.get(layout.activeContext) ?? all[0];

  // Stable pane order for the persistent viewports: a render-to-render reshuffle of these keys would
  // reorder the tree and remount the very things this host exists to keep mounted.
  const persistentIds = Object.keys(viewports).sort();

  const splitHostRef = React.useRef<HTMLDivElement>(null);
  const startSplitDrag = useResizable({
    axis: 'x', mode: 'ratio', min: 0.2, max: 0.85,
    value: layout.splitRatio, containerRef: splitHostRef,
    onChange: (r) => layoutStore.set({ splitRatio: r }),
  });

  const onBottomResize = useResizable({
    axis: 'y', invert: true, value: layout.bottomHeight, min: 140,
    max: () => window.innerHeight - 220,
    onChange: (h) => layoutStore.set({ bottomHeight: h }),
  });

  if (!context) return null; // registry empty — nothing to render (never happens once core registers)

  const resolve = (ids: string[] | undefined): PanelContribution[] =>
    (ids ?? []).map((id) => panelRegistry.get(id)).filter((p): p is PanelContribution => !!p);

  const browserPanels = resolve(context.browser);
  const dockPanels = resolve(context.dock);
  // A parameter section shows when it applies to something currently selected. `appliesTo` omitted
  // means "always" — and this is a FILTER over the live kinds, not the old surface-XOR-fixture rule,
  // so a surface and a fixture can both contribute sections at once.
  const inspectorPanels = resolve(context.inspector).filter(
    (p) => !p.appliesTo || p.appliesTo.some((k) => selection.kinds.includes(k)));

  const activeViewport = context.viewport;
  const activeIsScene3d = activeViewport === SCENE_3D_VIEWPORT;
  // The full-width bottom region. A persistent viewport named here is rendered THERE and nowhere else
  // (see the left-pane filter below) — a React element lives at exactly one position, and mounting the
  // timeline in two places would double its keyboard hook and engine subscription, which is the one
  // thing that must never happen. Moving between positions remounts it, which is what the old
  // dock-tab timeline did on every tab change anyway.
  const bottomId = context.bottom;
  const bottomPanel = bottomId && !persistentIds.includes(bottomId) ? panelRegistry.get(bottomId) : null;
  const hasBottom = !!bottomId && (persistentIds.includes(bottomId) || !!bottomPanel);
  // The right pane exists when the context lives there, or when split view is on.
  const showRightPane = layout.splitView || activeIsScene3d;
  const leftFrac = !showRightPane ? 1 : (activeIsScene3d && !layout.splitView ? 0 : layout.splitRatio);

  const dockPanelId = layout.contexts[context.id]?.dockPanel ?? dockPanels[0]?.id ?? '';
  const activeDock = dockPanels.find((p) => p.id === dockPanelId) ?? dockPanels[0];

  // A context whose viewport isn't one of the persistent elements resolves it from the registry.
  // Those are cheap panels (an outputs table, a cue grid) — remounting them per switch is fine.
  const registryViewport = persistentIds.includes(activeViewport) ? null : panelRegistry.get(activeViewport);

  return (
    <div className="flex flex-1 min-h-0">
      <CommandPalette selection={selection} />
      <ContextRail />

      <div className="flex-1 min-w-0 flex flex-col">
        <ActionBar context={context} selection={selection} />

        <div className="flex flex-1 min-h-0">
          {/* Browser */}
          {browserPanels.length > 0 && (
            <div className={`h-full border-r border-line-1 bg-surface-1 transition-all duration-med ${layout.showLeft ? 'w-72' : 'w-0 overflow-hidden border-none'}`}>
              <div className="w-72 h-full flex flex-col overflow-hidden">
                {browserPanels.map((p) => (
                  <PanelSection key={p.id} panel={p} contextId={context.id} selection={selection} />
                ))}
              </div>
            </div>
          )}

          {/* Viewport + dock */}
          <div className="flex-1 min-w-0 flex flex-col bg-surface-0">
            <div ref={splitHostRef} className="flex-1 min-h-0 relative flex">
              {/* LEFT pane — every persistent viewport except the 3D scene, plus registry viewports.
                  Width 0 (not unmounted) when a 3D-scene context is maximized. */}
              <div
                className="min-h-0 relative overflow-hidden"
                style={{ width: `${leftFrac * 100}%` }}
                aria-hidden={leftFrac === 0}
              >
                {persistentIds.filter((id) => id !== SCENE_3D_VIEWPORT && id !== bottomId).map((id) => (
                  <div key={id} className="absolute inset-0" style={{ display: id === activeViewport ? undefined : 'none' }}>
                    {viewports[id]}
                  </div>
                ))}
                {registryViewport && (
                  <div className="absolute inset-0 overflow-auto">
                    <registryViewport.Component contextId={context.id} selection={selection} />
                  </div>
                )}
              </div>

              {showRightPane && leftFrac > 0 && (
                <div onPointerDown={startSplitDrag} className="w-1 shrink-0 bg-line-1 hover:bg-accent cursor-col-resize" />
              )}

              {/* RIGHT pane — the 3D scene, permanently. Kept mounted (width 0) once it has ever been
                  shown, so switching away from a 3D context doesn't tear down the r3f canvas. */}
              <div className="min-h-0 relative overflow-hidden" style={{ flex: showRightPane ? '1 1 0%' : '0 0 0px' }} aria-hidden={!showRightPane}>
                {viewports[SCENE_3D_VIEWPORT]}
              </div>
            </div>

            {dockPanels.length > 0 && (
              <Dock
                open={layout.dockOpen}
                onToggle={() => layoutStore.set({ dockOpen: !layout.dockOpen })}
                tabs={dockPanels.map((p) => ({ id: p.id, label: p.title ?? p.id, icon: p.icon }))}
                activeTab={activeDock?.id ?? ''}
                onTab={(id) => layoutStore.set({
                  contexts: { ...layout.contexts, [context.id]: { ...layout.contexts[context.id], dockPanel: id } },
                })}
                height={layout.dockHeight}
                onResize={(h) => layoutStore.set({ dockHeight: h })}
              >
                {activeDock && <activeDock.Component contextId={context.id} selection={selection} />}
              </Dock>
            )}
          </div>

          {/* Parameters */}
          {(context.inspector?.length ?? 0) > 0 && (
            <div className={`h-full border-l border-line-1 bg-surface-1 transition-all duration-med ${layout.showRight ? 'w-80' : 'w-0 overflow-hidden border-none'}`}>
              <div className="w-80 h-full overflow-y-auto">
                {inspectorPanels.length === 0 ? (
                  <div className="p-4 text-center text-fg-3 text-mini italic">
                    Nothing selected — pick an object to edit its parameters.
                  </div>
                ) : inspectorPanels.map((p) => (
                  <PanelSection key={p.id} panel={p} contextId={context.id} selection={selection} />
                ))}
              </div>
            </div>
          )}

          {drawers}
        </div>

        {/* FULL-WIDTH BOTTOM REGION — spans under the browser and the parameter column, unlike the
            dock. Drag its top edge to resize; the height is remembered per context. */}
        {hasBottom && (
          <div
            className="shrink-0 border-t border-line-1 bg-surface-0 relative flex flex-col min-h-0"
            style={{ height: layout.bottomHeight }}
          >
            <div
              onPointerDown={onBottomResize}
              title="Drag to resize"
              className="absolute -top-1 left-0 right-0 h-2 cursor-row-resize z-10 hover:bg-accent/30"
            />
            <div className="flex-1 min-h-0">
              {bottomPanel
                ? <bottomPanel.Component contextId={context.id} selection={selection} />
                : viewports[bottomId!]}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
