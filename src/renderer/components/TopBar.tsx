import React from 'react';
import { Settings, Activity, Network, MonitorUp, HelpCircle } from 'lucide-react';
import { IconButton } from './ui';
import { help } from '../services/helpBus';

interface TopBarProps {
  onOpenPreferences: () => void;
  onOpenRouting: () => void;
  onOpenOutputs: () => void;
  monitorOpen: boolean;
  onToggleMonitor: () => void;
  helpOpen: boolean;
  onToggleHelp: () => void;
}

// Toolbar action icons — 3D Scene, outputs, routing, monitor, preferences, help. Rendered inline
// in the menu ribbon (see MenuBar's `actions` slot), so this is just the icon group with no chrome
// of its own. Project file ops + undo/redo and transport live in the menu bar, the timeline
// panel, and keyboard shortcuts. Hover hints are bilingual ({ en, fr }) for the Help panel.
export const TopBar: React.FC<TopBarProps> = ({
  onOpenPreferences, onOpenRouting, onOpenOutputs, monitorOpen, onToggleMonitor, helpOpen, onToggleHelp,
}) => {
  return (
    <div className="flex items-center gap-1">
      <IconButton onClick={onOpenOutputs} title="Outputs" {...help('general.outputs')}><MonitorUp size={15} /></IconButton>
      <IconButton onClick={onOpenRouting} title="Routing" {...help('general.routing')}><Network size={15} /></IconButton>
      <IconButton active={monitorOpen} onClick={onToggleMonitor} title="DMX Monitor" {...help('general.dmx-monitor')}><Activity size={15} /></IconButton>
      <IconButton onClick={onOpenPreferences} title="Preferences" {...help('general.preferences')}><Settings size={15} /></IconButton>
      <IconButton active={helpOpen} onClick={onToggleHelp} title="Help (F1)" {...help('general.help')}><HelpCircle size={15} /></IconButton>
    </div>
  );
};
