import { useDraggable, type DragOffset } from '@artlux/sdk/renderer';

// Host wrapper around the SDK's host-agnostic useDraggable: adds the ONE host-specific piece —
// persistence to app prefs (userData) keyed by a stable modal id. The drag mechanics and the
// positionerStyle/handleProps come from the SDK; only load/save live here. Position is workspace
// ergonomics, so it goes in prefs (survives restart) rather than the portable .artlux project.
//
// Usage: `const { positionerStyle, handleProps } = useDraggableModal('preferences')`. Put
// `style={positionerStyle}` on a wrapper around the dialog and spread `{...handleProps}` on the
// header bar (with `cursor-move select-none`). Double-clicking the header recenters.
export function useDraggableModal(id: string) {
  return useDraggable({
    load: async () => (await window.artlux?.getPrefs?.())?.modalPositions?.[id],
    // Read-modify-write so concurrent modals don't clobber each other's saved slots.
    onCommit: (pos: DragOffset) => {
      window.artlux?.getPrefs?.()
        .then((p) => window.artlux?.setPrefs?.({ modalPositions: { ...(p?.modalPositions ?? {}), [id]: pos } }))
        .catch(() => {});
    },
  });
}
