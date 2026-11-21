import React from 'react';
import { DMXMonitor } from '../../components/DMXMonitor';
import { PerfPanel } from '../../components/PerfPanel';
import { useEditorPick } from '../../state/EditorStore';

// The DMX Monitor and Performance panels — in a file of their own because they may open in a window
// (contexts/detachable.tsx), and the panel window's import graph is this file's: adapters.tsx, where they
// used to sit, also carries the media library and the state graph editor, which reach the transport.
// Their live readings come through seams (services/dmxFeed, services/editorHealth).

export const MonitorDock: React.FC = () => {
  const { fixtures, fixtureProfiles } = useEditorPick('fixtures', 'fixtureProfiles');
  return <DMXMonitor fixtures={fixtures} fixtureProfiles={fixtureProfiles} />;
};

export const PerfDock: React.FC = () => <PerfPanel />;
