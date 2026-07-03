import { useSyncExternalStore } from 'react';
import { layoutStore, type WorkspaceLayout } from '../services/layoutStore';

// Subscribe a component to the workspace layout store. React 19 useSyncExternalStore keeps the
// per-frame repaint loop correct (no tearing) — the store's get() returns a stable object identity
// between notifications, so this only re-renders when layoutStore.set/hydrate actually run.
export function useLayout(): WorkspaceLayout {
  return useSyncExternalStore(layoutStore.subscribe, layoutStore.get);
}
