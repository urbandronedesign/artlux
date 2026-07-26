import React from 'react';
import { MediaPanel } from '../../components/MediaPanel';
import { FixtureEditor } from '../../components/FixtureEditor';
import { DMXMonitor } from '../../components/DMXMonitor';
import { PerfPanel } from '../../components/PerfPanel';
import { RoutingModal } from '../../components/RoutingModal';
import { Preferences } from '../../components/Preferences';
import { StateGraphEditor } from '../../components/timeline/StateGraphEditor';
import { useEditor, useEditorActions } from '../../state/EditorStore';
import { revealBottom } from '../nav';

// Thin adapters: existing whole-panel components, fed from the editor store instead of ~10 props
// threaded down from App. No behaviour change — these components are already coherent panels, so
// unlike ScenePanel/InspectorPanel there is nothing to decompose.

export const MediaBrowserPanel: React.FC = () => {
  const { assets, globalTimeline, projectRefs, selectedSurfaceId, currentProjectPath } = useEditor();
  const a = useEditorActions();
  return (
    <MediaPanel
      assets={assets}
      // The GLOBAL doc, not the bound one: the take library lives on the project's own timeline.
      timeline={globalTimeline}
      refs={projectRefs}
      selectedSurfaceId={selectedSurfaceId}
      hasProjectFolder={!!currentProjectPath}
      onImport={a.importAssets}
      onScan={a.scanAssets}
      onRemoveAsset={a.removeAsset}
      onRelinkAsset={a.relinkAsset}
      onUseOnSurface={a.useAssetOnSurface}
      onSelectSurface={a.selectSurface}
    />
  );
};

export const FixtureEditorDock: React.FC = () => {
  const { fixtures, selectedFixtureId, templates } = useEditor();
  const a = useEditorActions();
  return (
    <FixtureEditor
      fixture={fixtures.find((f) => f.id === selectedFixtureId) ?? null}
      onUpdateFixture={a.updateFixture}
      onAdd={a.addFixture}
      onAutoPatch={a.autoPatch}
      templates={templates}
      onSaveTemplate={a.saveTemplate}
      onAddFromTemplate={a.addFromTemplate}
      onRemoveTemplate={a.removeTemplate}
      onAddFromProfile={a.addFixtureFromProfile}
    />
  );
};

export const MonitorDock: React.FC = () => {
  const { fixtures, fixtureProfiles } = useEditor();
  return <DMXMonitor fixtures={fixtures} fixtureProfiles={fixtureProfiles} />;
};

export const PerfDock: React.FC = () => <PerfPanel />;

// Was the Routing MODAL. Patching belongs beside the fixture list and the DMX monitor, so it is a dock
// panel in the `led` context now.
export const RoutingDock: React.FC = () => {
  const { fixtures, surfaces, controllers, fixtureProfiles, settings, patchPolicy } = useEditor();
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


// The project-level show machine, as the `machine` context's viewport. Was a centred modal inside the
// timeline; a state graph is an authoring surface that wants the whole window.
//
// `scenes` carries a clip count per scene so the graph can show which states actually have content —
// read straight off each scene's own timeline (every scene owns one; see the Scene type).
export const StateMachineViewport: React.FC = () => {
  const { stateMachine, timeline, scenes, cueBanks } = useEditor();
  const a = useEditorActions();
  return (
    <StateGraphEditor
      sm={stateMachine}
      markers={timeline.markers ?? []}
      layers={timeline.layers}
      // …plus whether the state ENDS BY HOLDING its last frame, which is what a ⏱ (requireEnd) edge
      // out of it waits for. LOOP WINS in the engine, so a looping timeline never claims to hold.
      scenes={scenes.map((s) => ({ id: s.id, name: s.name, accent: s.accent, clipCount: s.timeline.clips.length, holdsAtEnd: !!s.timeline.holdAtEnd && !s.timeline.loop }))}
      cues={cueBanks.flatMap((b) => b.cues.map((c) => ({ id: c.id, name: c.name })))}
      onChange={a.setStateMachine}
      // Editing a state's timeline binds that scene and pulls the timeline DRAWER up underneath the
      // graph. It used to switch to the `timeline` context, which took the graph away — the whole
      // point of the drawer is that the state you just wired stays on screen beside its lanes.
      onEditTimeline={(sceneId) => { a.enterAuthorScene(sceneId); revealBottom(); }}
    />
  );
};

// Preferences as the `settings` context's viewport. It hosts every plugin's SettingsSection too, so
// this one adapter carries the whole app-settings surface.
export const PreferencesViewport: React.FC = () => {
  const { settings } = useEditor();
  const a = useEditorActions();
  return <Preferences settings={settings} onChange={a.updateSettings} />;
};
