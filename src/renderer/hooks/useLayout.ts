import { useSyncExternalStore } from 'react';
import { layoutStore, type WorkspaceLayout } from '../services/layoutStore';

// Subscribe a component to the workspace layout store. React 19 useSyncExternalStore keeps the
// per-frame repaint loop correct (no tearing) — the store's get() returns a stable object identity
// between notifications, so this only re-renders when layoutStore.set/hydrate actually run.
export function useLayout(): WorkspaceLayout {
  return useSyncExternalStore(layoutStore.subscribe, layoutStore.get);
}

// Subscribe to ONE layout value. A panel that only cares about a single key must not re-render on
// every other key: layoutStore.set() fires per pointer tick during a resize drag, so a sidebar reading
// the whole object (MediaPanel, which rebuilds a usage index per render) would re-render all the way
// through someone dragging the dock. `sel` must return a primitive — React bails out on Object.is, so
// a fresh object/array every call defeats the point and re-renders anyway.
export function useLayoutValue<T>(sel: (l: WorkspaceLayout) => T): T {
  return useSyncExternalStore(layoutStore.subscribe, () => sel(layoutStore.get()));
}
