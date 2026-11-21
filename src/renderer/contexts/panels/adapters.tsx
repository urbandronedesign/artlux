import React from 'react';
import { MediaPanel } from '../../components/MediaPanel';
import { Preferences } from '../../components/Preferences';
import { StateGraphEditor } from '../../components/timeline/StateGraphEditor';
import { useEditorPick, useEditorActions } from '../../state/EditorStore';
import { revealBottom } from '../nav';

// Thin adapters: existing whole-panel components, fed from the editor store instead of ~10 props
// threaded down from App. No behaviour change — these components are already coherent panels, so
// unlike ScenePanel/InspectorPanel there is nothing to decompose.

export const MediaBrowserPanel: React.FC = () => {
  const { assets, globalTimeline, projectRefs, selectedSurfaceId, currentProjectPath } = useEditorPick('assets', 'globalTimeline', 'projectRefs', 'selectedSurfaceId', 'currentProjectPath');
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


// MonitorDock and PerfDock moved to ./monitors.tsx, the fixture library and wiring docks to
// ./fixtureDocks.tsx and Routing to ./routing.tsx: they may open in a panel window, and a panel window's
// import graph is its file's — this file also carries the media library and the state graph.



// The project-level show machine, as the `machine` context's viewport. Was a centred modal inside the
// timeline; a state graph is an authoring surface that wants the whole window.
//
// `scenes` carries a clip count per scene so the graph can show which states actually have content —
// read straight off each scene's own timeline (every scene owns one; see the Scene type).
export const StateMachineViewport: React.FC = () => {
  const { stateMachine, timeline, scenes, cueBanks } = useEditorPick('stateMachine', 'timeline', 'scenes', 'cueBanks');
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
      // Without this, graph edits are invisible to undo AND an unrelated Ctrl+Z silently reverts
      // them (stateMachine is in DocSnapshot). Guarded by verify:invariants.
      onRecordHistory={a.recordHistory}
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
  const { settings } = useEditorPick('settings');
  const a = useEditorActions();
  return <Preferences settings={settings} onChange={a.updateSettings} />;
};
