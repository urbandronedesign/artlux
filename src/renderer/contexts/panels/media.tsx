import React from 'react';
import { MediaPanel } from '../../components/MediaPanel';
import { useEditorPick, useEditorActions } from '../../state/EditorStore';

// The Media Library — in a file of its own because it may open in a panel window (contexts/detachable.tsx),
// and the window's import graph is this file's. Its video stills and take sparklines come through seams
// (services/thumbView, services/takeDensity): the editor's caches when docked, the live channel in a
// window. Imports are the editor's actions (main copies the files); pictures stream over artlux-media://.

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
