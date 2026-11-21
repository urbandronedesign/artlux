import React from 'react';
import { FixtureLibrary, FixtureWiring } from '../../components/FixtureEditor';
import { useEditorPick, useEditorActions } from '../../state/EditorStore';

// The fixture Library and Wiring & Ledmap docks — in a file of its own because it may open in a panel window (contexts/detachable.tsx), and the
// window's import graph is this file's. It reads only the editor store and dispatches only editor
// actions, so in a window it is the replica and the editor's handlers (live/panelStore).

// The old seven-card `FixtureEditorDock` is gone — five of its cards were a second rendering of the
// kind-gated inspector. What is left is two docks, each holding something that exists nowhere else.
export const FixtureLibraryDock: React.FC = () => {
  const { fixtures, selectedFixtureId, templates } = useEditorPick('fixtures', 'selectedFixtureId', 'templates');
  const a = useEditorActions();
  return (
    <FixtureLibrary
      fixture={fixtures.find((f) => f.id === selectedFixtureId) ?? null}
      templates={templates}
      onSaveTemplate={a.saveTemplate}
      onAddFromTemplate={a.addFromTemplate}
      onRemoveTemplate={a.removeTemplate}
      onAddFromProfile={a.addFixtureFromProfile}
    />
  );
};

export const FixtureWiringDock: React.FC = () => {
  const { fixtures, selectedFixtureId } = useEditorPick('fixtures', 'selectedFixtureId');
  const a = useEditorActions();
  return (
    <FixtureWiring
      fixture={fixtures.find((f) => f.id === selectedFixtureId) ?? null}
      onUpdateFixture={a.updateFixture}
    />
  );
};
