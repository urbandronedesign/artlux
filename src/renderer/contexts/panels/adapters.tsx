import React from 'react';
import { MediaPanel } from '../../components/MediaPanel';
import { Preferences } from '../../components/Preferences';
import { useEditorPick, useEditorActions } from '../../state/EditorStore';

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
// ./fixtureDocks.tsx, Routing to ./routing.tsx and the state graph to ./stateGraph.tsx: they may open in a panel window, and a panel window's
// import graph is its file's — this file also carries the media library and the state graph.



// Preferences as the `settings` context's viewport. It hosts every plugin's SettingsSection too, so
// this one adapter carries the whole app-settings surface.
export const PreferencesViewport: React.FC = () => {
  const { settings } = useEditorPick('settings');
  const a = useEditorActions();
  return <Preferences settings={settings} onChange={a.updateSettings} />;
};
