import React from 'react';
import { Image, Grid3x3, Lightbulb, Box } from 'lucide-react';
import { Module } from '../types';
import { helpProps } from '../services/helpBus';

const MODULES: { m: Module; icon: React.ComponentType<{ size?: number }>; label: string; help: string }[] = [
  { m: Module.MEDIA, icon: Image, label: 'Media', help: 'Media — choose a content source (video, image, camera, or DMX in).' },
  { m: Module.MAP, icon: Grid3x3, label: 'Map', help: 'Map — drag fixtures over the content on the stage.' },
  { m: Module.FIXTURES, icon: Lightbulb, label: 'Fixtures', help: 'Fixtures — patch DMX: universe, address, color order, segments, routing.' },
  { m: Module.THREE_D, icon: Box, label: '3D', help: '3D — arrange fixtures in space; drag the gizmo to move/rotate.' },
];

export const ModuleSwitcher: React.FC<{ module: Module; onChange: (m: Module) => void }> = ({ module, onChange }) => (
  <div className="flex items-center gap-1" role="tablist" aria-label="Module switcher">
    {MODULES.map(({ m, icon: Icon, label, help }) => {
      const active = module === m;
      return (
        <button
          key={m}
          onClick={() => onChange(m)}
          title={label}
          role="tab"
          aria-selected={active}
          {...helpProps(help)}
          className={`flex items-center gap-1.5 h-7 px-2.5 rounded-[var(--r-sm)] text-[11px] transition-colors ${
            active ? 'bg-accent/15 text-accent' : 'text-fg-2 hover:text-fg-1 hover:bg-surface-3'
          }`}
        >
          <Icon size={15} />
          <span>{label}</span>
        </button>
      );
    })}
  </div>
);
