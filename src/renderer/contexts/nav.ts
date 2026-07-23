import { contextRegistry } from '../host/registries';
import { layoutStore, type ContextLayout } from '../services/layoutStore';

// Switching workspace contexts from anywhere — the rail, a menu action, a button inside a panel.
//
// The one subtlety this exists to centralise: a context's declared `layout` has to travel to the store
// WITH its `layoutRev`, because a banked slice (the operator's own sizes) normally wins over the
// declared one, and the rev is what tells the store a shipped layout has been revised since. Three
// call sites were each rebuilding that object; getting it wrong silently means either the operator's
// arrangement is trampled, or a shipped layout never reaches them. See resolveContextLayout().

export function contextLayoutOf(id: string): ContextLayout | undefined {
  const c = contextRegistry.get(id);
  return c ? { ...c.layout, rev: c.layoutRev ?? 0 } : undefined;
}

/** Make `id` the active workbench. No-op if nothing is registered under that id. */
export function goToContext(id: string): void {
  if (!contextRegistry.get(id)) return;
  layoutStore.setContext(id, contextLayoutOf(id));
}
