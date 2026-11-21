// "BACK TO THE EDITOR" (E5/W5): put a panel that is out in a panel window back into the editor's current
// workbench. The window removes it from its own tree; this makes sure the editor shows it.
//
// Opening a window leaves the docked copy where it was, so most of the time the panel is still docked
// and there is nothing to do. It is needed when the operator closed the docked copy (or it was never
// part of this workbench): then it goes into the group of its own kind — a browser panel into the
// browser column, a parameter section into the parameter column, anything else into the dock — the
// place it would have had if the workbench had shipped with it.

import { contextRegistry, panelRegistry } from '../host/registries';
import { layoutStore } from './layoutStore';
import { addPanel, ensureTree, groups, panelIds, type DockManifest, type DockRegion } from './dockTree';

/** Dock `panelId` into the active workbench. True when it is (now) part of it. */
export function dockIntoActiveContext(panelId: string): boolean {
  const layout = layoutStore.get();
  const ctx = contextRegistry.get(layout.activeContext) ?? contextRegistry.all()[0];
  const panel = panelRegistry.get(panelId);
  if (!ctx || !panel) return false;
  // The same single door the shell reads its tree through (WorkspaceShell), with the same banked sizes.
  const tree = ensureTree(layout.dockTrees?.[ctx.id], ctx as unknown as DockManifest, {
    leftWidth: layout.leftWidth, rightWidth: layout.rightWidth,
    dockHeight: layout.dockHeight, dockPanel: layout.contexts[ctx.id]?.dockPanel,
  });
  if (panelIds(tree).includes(panelId)) return true;
  const want: DockRegion = panel.mount === 'inspector' ? 'inspector' : panel.mount === 'browser' ? 'browser' : 'dock';
  const home = groups(tree).find((g) => g.region === want);
  layoutStore.setDockTree(ctx.id, addPanel(tree, panelId, home?.id));
  return true;
}
