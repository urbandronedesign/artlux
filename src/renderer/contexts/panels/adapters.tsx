import React from 'react';
import { Preferences } from '../../components/Preferences';
import { useEditorPick, useEditorActions } from '../../state/EditorStore';

// Preferences as the `settings` context's viewport. It hosts every plugin's SettingsSection too, so this
// one adapter carries the whole app-settings surface — and it may open in a panel window
// (contexts/detachable.tsx), whose import graph is this file's.
//
// This file once held every "thin adapter" (an existing whole-panel component fed from the editor store
// instead of props from App). Each that may open in a window moved to a file of its own, because a panel
// window's import graph is its file's: media.tsx, monitors.tsx, fixtureDocks.tsx, routing.tsx,
// stateGraph.tsx. Preferences is the last, and this is now its file.
//
// In a panel window the app settings are edited through the editor (updateSettings), the plugin sections
// are the plugins' UI halves (host/pluginUi.ts), and the few settings of the EDITOR'S OWN WINDOW (its
// workbench, named workspaces, 3D view quality) are shown disabled with a pointer (Preferences' EditorOnly).
export const PreferencesViewport: React.FC = () => {
  const { settings } = useEditorPick('settings');
  const a = useEditorActions();
  return <Preferences settings={settings} onChange={a.updateSettings} />;
};
