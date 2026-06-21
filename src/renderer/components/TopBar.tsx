import React, { useRef } from 'react';
import { Play, Pause, Save, FolderOpen, Undo, Redo, Settings, Activity } from 'lucide-react';
import { Module } from '../types';
import { ModuleSwitcher } from './ModuleSwitcher';
import { IconButton } from './ui';
import { helpProps } from '../services/helpBus';

interface TopBarProps {
  isVideoPlaying: boolean;
  onTogglePlay: () => void;
  module: Module;
  onChangeModule: (m: Module) => void;
  onSaveProject: () => void;
  onLoadProject: (file: File) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onOpenPreferences: () => void;
  monitorOpen: boolean;
  onToggleMonitor: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  isVideoPlaying, onTogglePlay, module, onChangeModule,
  onSaveProject, onLoadProject, onUndo, onRedo, canUndo, canRedo,
  onOpenPreferences, monitorOpen, onToggleMonitor,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) onLoadProject(e.target.files[0]);
    e.target.value = '';
  };

  return (
    <div className="h-10 shrink-0 bg-surface-1 border-b border-line-1 flex items-center justify-between px-3 select-none">
      {/* Left: brand · history · project · modules */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-gradient-to-br from-accent to-accent-press rounded flex items-center justify-center font-bold text-xs text-black">A</div>
          <span className="font-bold text-fg-1 text-sm tracking-wide">ARTLUX</span>
        </div>
        <div className="h-5 w-px bg-line-2" />
        <div className="flex gap-0.5">
          <IconButton onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)" {...helpProps('Undo the last change (Ctrl+Z).')}><Undo size={14} /></IconButton>
          <IconButton onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)" {...helpProps('Redo the last undone change (Ctrl+Y).')}><Redo size={14} /></IconButton>
        </div>
        <div className="h-5 w-px bg-line-2" />
        <div className="flex gap-0.5">
          <IconButton onClick={onSaveProject} title="Save Project (JSON)" {...helpProps('Save the project (fixtures, settings, scenes) to a JSON file.')}><Save size={14} /></IconButton>
          <IconButton onClick={() => fileInputRef.current?.click()} title="Load Project (JSON)" {...helpProps('Load a project from a JSON file.')}><FolderOpen size={14} /></IconButton>
          <input type="file" ref={fileInputRef} className="hidden" accept=".json" onChange={handleFileChange} />
        </div>
        <div className="h-5 w-px bg-line-2" />
        <ModuleSwitcher module={module} onChange={onChangeModule} />
      </div>

      {/* Center: transport */}
      <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1 bg-surface-0 rounded-[var(--r-md)] p-0.5 border border-line-1">
        <button
          onClick={onTogglePlay}
          title="Pause"
          aria-label="Pause playback"
          {...helpProps('Pause the content source.')}
          className={`p-1 rounded-[var(--r-sm)] w-8 flex items-center justify-center transition-colors ${!isVideoPlaying ? 'bg-surface-3 text-fg-1' : 'text-fg-3 hover:text-fg-1'}`}
        >
          <Pause size={12} fill="currentColor" />
        </button>
        <button
          onClick={onTogglePlay}
          title="Play"
          aria-label="Play playback"
          {...helpProps('Play the content source.')}
          className={`p-1 rounded-[var(--r-sm)] w-8 flex items-center justify-center transition-colors ${isVideoPlaying ? 'bg-accent text-black' : 'text-fg-3 hover:text-fg-1'}`}
        >
          <Play size={12} fill="currentColor" />
        </button>
      </div>

      {/* Right: monitor + preferences */}
      <div className="flex items-center gap-1">
        <IconButton active={monitorOpen} onClick={onToggleMonitor} title="DMX Monitor" {...helpProps('Toggle the DMX Monitor dock — live per-fixture pixel output.')}><Activity size={15} /></IconButton>
        <IconButton onClick={onOpenPreferences} title="Preferences" {...helpProps('Open Preferences — DMX output protocol/target and engine settings.')}><Settings size={15} /></IconButton>
      </div>
    </div>
  );
};
