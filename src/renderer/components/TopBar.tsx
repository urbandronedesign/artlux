import React from 'react';
import { Settings, Activity, Network, Box, MonitorUp, HelpCircle } from 'lucide-react';
import { IconButton } from './ui';
import { helpProps } from '../services/helpBus';

interface TopBarProps {
  onOpenScene: () => void;
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
  onOpenScene, onOpenPreferences, onOpenRouting, onOpenOutputs, monitorOpen, onToggleMonitor, helpOpen, onToggleHelp,
}) => {
  return (
    <div className="flex items-center gap-1">
      <IconButton onClick={onOpenScene} title="3D Scene" {...helpProps({ en: 'Open the 3D Scene — load a venue model and place fixtures in real-world space.', fr: 'Ouvrir la Scène 3D — charger un modèle de lieu et placer les fixtures dans l’espace réel.' })}><Box size={15} /></IconButton>
      <IconButton onClick={onOpenOutputs} title="Outputs" {...helpProps({ en: 'Open Outputs — send each surface fullscreen to a projector/display with corner-pin mapping.', fr: 'Ouvrir Sorties — envoyer chaque surface en plein écran vers un projecteur/écran avec warp corner-pin.' })}><MonitorUp size={15} /></IconButton>
      <IconButton onClick={onOpenRouting} title="Routing" {...helpProps({ en: 'Open the Routing spreadsheet — controllers + per-fixture patch.', fr: 'Ouvrir le tableau Routing — contrôleurs + patch par fixture.' })}><Network size={15} /></IconButton>
      <IconButton active={monitorOpen} onClick={onToggleMonitor} title="DMX Monitor" {...helpProps({ en: 'Toggle the DMX Monitor dock — live per-fixture pixel output.', fr: 'Afficher le Moniteur DMX — sortie pixel par fixture en direct.' })}><Activity size={15} /></IconButton>
      <IconButton onClick={onOpenPreferences} title="Preferences" {...helpProps({ en: 'Open Preferences — DMX output protocol/target and engine settings.', fr: 'Ouvrir les Préférences — protocole/cible de sortie DMX et réglages du moteur.' })}><Settings size={15} /></IconButton>
      <IconButton active={helpOpen} onClick={onToggleHelp} title="Help (F1)" {...helpProps({ en: 'Toggle the Help panel (F1) — contextual help and topic guides, in English or French.', fr: 'Afficher le panneau d’Aide (F1) — aide contextuelle et guides, en anglais ou français.' })}><HelpCircle size={15} /></IconButton>
    </div>
  );
};
