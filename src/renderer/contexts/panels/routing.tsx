import React from 'react';
import { RoutingModal } from '../../components/RoutingModal';
import { useEditorPick, useEditorActions } from '../../state/EditorStore';

// The Routing dock (controllers, patch, auto-patch) — in a file of its own because it may open in a panel window (contexts/detachable.tsx), and the
// window's import graph is this file's. It reads only the editor store and dispatches only editor
// actions, so in a window it is the replica and the editor's handlers (live/panelStore).

// Was the Routing MODAL. Patching belongs beside the fixture list and the DMX monitor, so it is a dock
// panel in the `led` context now.
export const RoutingDock: React.FC = () => {
  const { fixtures, surfaces, controllers, fixtureProfiles, settings, patchPolicy } = useEditorPick('fixtures', 'surfaces', 'controllers', 'fixtureProfiles', 'settings', 'patchPolicy');
  const a = useEditorActions();
  return (
    <RoutingModal
      fixtures={fixtures}
      surfaces={surfaces}
      controllers={controllers}
      fixtureProfiles={fixtureProfiles}
      settings={settings}
      patchPolicy={patchPolicy}
      onUpdateFixture={a.updateFixture}
      onAddController={a.addController}
      onUpdateController={a.updateController}
      onRemoveController={a.removeController}
      onAutoPatch={a.autoPatch}
      onUpdateSettings={a.updateSettings}
      onUpdatePatchPolicy={a.updatePatchPolicy}
    />
  );
};
