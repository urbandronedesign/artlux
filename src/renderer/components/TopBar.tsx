import React, { useState } from 'react';
import { Play, Pause, Save, FolderOpen, ChevronDown, Undo, Redo, Settings, Activity, FileDown, FileUp, Clock } from 'lucide-react';
import { Module } from '../types';
import { ModuleSwitcher } from './ModuleSwitcher';
import { IconButton } from './ui';
import { helpProps } from '../services/helpBus';

interface TopBarProps {
  isVideoPlaying: boolean;
  onTogglePlay: () => void;
  canPlay: boolean;
  module: Module;
  onChangeModule: (m: Module) => void;
  onSaveProject: () => void;
  onSaveAs: () => void;
  onOpenProject: () => void;
  recentFiles: string[];
  onOpenRecent: (path: string) => void;
  onExportRig: () => void;
  onImportRig: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onOpenPreferences: () => void;
  monitorOpen: boolean;
  onToggleMonitor: () => void;
}

const basename = (p: string) => p.replace(/\\/g, '/').split('/').pop() || p;

export const TopBar: React.FC<TopBarProps> = ({
  isVideoPlaying, onTogglePlay, canPlay, module, onChangeModule,
  onSaveProject, onSaveAs, onOpenProject, recentFiles, onOpenRecent, onExportRig, onImportRig,
  onUndo, onRedo, canUndo, canRedo,
  onOpenPreferences, monitorOpen, onToggleMonitor,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const run = (fn: () => void) => () => { setMenuOpen(false); fn(); };

  const MenuItem: React.FC<{ icon?: React.ReactNode; onClick: () => void; children: React.ReactNode }> = ({ icon, onClick, children }) => (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 h-7 text-left text-[11px] text-fg-2 hover:text-fg-1 hover:bg-surface-3"
    >
      {icon}
      {children}
    </button>
  );

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
        <div className="flex items-center gap-0.5">
          <IconButton onClick={onSaveProject} title="Save Project" {...helpProps('Save the project to its file (prompts the first time).')}><Save size={14} /></IconButton>
          <IconButton onClick={onOpenProject} title="Open Project" {...helpProps('Open a project file (.artlux).')}><FolderOpen size={14} /></IconButton>
          <div className="relative">
            <IconButton active={menuOpen} onClick={() => setMenuOpen((o) => !o)} title="File menu" aria-haspopup="menu" aria-expanded={menuOpen}><ChevronDown size={14} /></IconButton>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-[140]" onClick={() => setMenuOpen(false)} />
                <div role="menu" className="absolute left-0 mt-1 w-56 z-[150] bg-surface-2 border border-line-2 rounded-[var(--r-md)] shadow-2xl py-1 animate-modal-in">
                  <MenuItem icon={<Save size={13} />} onClick={run(onSaveProject)}>Save</MenuItem>
                  <MenuItem icon={<Save size={13} />} onClick={run(onSaveAs)}>Save As…</MenuItem>
                  <MenuItem icon={<FolderOpen size={13} />} onClick={run(onOpenProject)}>Open…</MenuItem>
                  <div className="my-1 border-t border-line-1" />
                  <MenuItem icon={<FileDown size={13} />} onClick={run(onExportRig)}>Export Rig…</MenuItem>
                  <MenuItem icon={<FileUp size={13} />} onClick={run(onImportRig)}>Import Rig…</MenuItem>
                  <div className="my-1 border-t border-line-1" />
                  <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-fg-3 flex items-center gap-1.5"><Clock size={10} /> Recent</div>
                  {recentFiles.length === 0 ? (
                    <div className="px-3 py-1 text-[11px] text-fg-3 italic">No recent files</div>
                  ) : (
                    recentFiles.slice(0, 8).map((p) => (
                      <button
                        key={p}
                        onClick={run(() => onOpenRecent(p))}
                        title={p}
                        className="w-full px-3 h-7 text-left text-[11px] text-fg-2 hover:text-fg-1 hover:bg-surface-3 truncate"
                      >
                        {basename(p)}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="h-5 w-px bg-line-2" />
        <ModuleSwitcher module={module} onChange={onChangeModule} />
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

      {/* Right: monitor + preferences */}
      <div className="flex items-center gap-1">
        <IconButton active={monitorOpen} onClick={onToggleMonitor} title="DMX Monitor" {...helpProps('Toggle the DMX Monitor dock — live per-fixture pixel output.')}><Activity size={15} /></IconButton>
        <IconButton onClick={onOpenPreferences} title="Preferences" {...helpProps('Open Preferences — DMX output protocol/target and engine settings.')}><Settings size={15} /></IconButton>
      </div>
    </div>
  );
};
