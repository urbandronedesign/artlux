import React from 'react';
import { Play, Pause, Settings, Activity, Network, Box, MonitorUp } from 'lucide-react';
import { IconButton } from './ui';
import { helpProps } from '../services/helpBus';

interface TopBarProps {
  isVideoPlaying: boolean;
  onTogglePlay: () => void;
  canPlay: boolean;
  onOpenScene: () => void;
  onOpenPreferences: () => void;
  onOpenRouting: () => void;
  onOpenOutputs: () => void;
  monitorOpen: boolean;
  onToggleMonitor: () => void;
}

// Slim top bar: a Scene (3D) entry on the left, transport in the center, and
// routing / monitor / preferences on the right. Project file ops + undo/redo live
// in the native File/Edit menu and keyboard shortcuts.
export const TopBar: React.FC<TopBarProps> = ({
  isVideoPlaying, onTogglePlay, canPlay,
  onOpenScene, onOpenPreferences, onOpenRouting, onOpenOutputs, monitorOpen, onToggleMonitor,
}) => {
  return (
    <div className="h-10 shrink-0 bg-surface-1 border-b border-line-1 flex items-center justify-between px-3 select-none">
      {/* Left: 3D Scene */}
      <div className="flex items-center gap-1">
        <button
          onClick={onOpenScene}
          title="Open the 3D Scene window"
          {...helpProps('Open the 3D Scene — load a venue model and place fixtures in real-world space.')}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded-[var(--r-sm)] text-[11px] text-fg-2 hover:text-fg-1 hover:bg-surface-3 transition-colors"
        >
          <Box size={15} />
          <span>Scene</span>
        </button>
      </div>

      {/* Center: transport — single play/pause toggle, enabled only for playable
          (video/camera) sources. */}
      <div className="absolute left-1/2 -translate-x-1/2 flex items-center bg-surface-0 rounded-[var(--r-md)] p-0.5 border border-line-1">
        <button
          onClick={onTogglePlay}
          disabled={!canPlay}
          title={!canPlay ? 'Play/Pause (video or camera source)' : isVideoPlaying ? 'Pause' : 'Play'}
          aria-label={isVideoPlaying ? 'Pause playback' : 'Play playback'}
          {...helpProps(canPlay ? 'Play / pause the video source.' : 'Play/Pause — only applies to video or camera sources.')}
          className={`p-1 rounded-[var(--r-sm)] w-9 flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            canPlay && isVideoPlaying ? 'bg-accent text-black' : 'text-fg-2 hover:text-fg-1'
          }`}
        >
          {isVideoPlaying ? <Pause size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
        </button>
      </div>

      {/* Right: outputs + routing + monitor + preferences */}
      <div className="flex items-center gap-1">
        <IconButton onClick={onOpenOutputs} title="Outputs" {...helpProps('Open Outputs — send each surface fullscreen to a projector/display with corner-pin mapping.')}><MonitorUp size={15} /></IconButton>
        <IconButton onClick={onOpenRouting} title="Routing" {...helpProps('Open the Routing spreadsheet — controllers + per-fixture patch.')}><Network size={15} /></IconButton>
        <IconButton active={monitorOpen} onClick={onToggleMonitor} title="DMX Monitor" {...helpProps('Toggle the DMX Monitor dock — live per-fixture pixel output.')}><Activity size={15} /></IconButton>
        <IconButton onClick={onOpenPreferences} title="Preferences" {...helpProps('Open Preferences — DMX output protocol/target and engine settings.')}><Settings size={15} /></IconButton>
      </div>
    </div>
  );
};
