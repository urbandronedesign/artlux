import React from 'react';
import { Image, Grid3x3, Lightbulb, Box } from 'lucide-react';
import { Module } from '../types';

const MODULES: { m: Module; icon: React.ComponentType<{ size?: number }>; label: string }[] = [
  { m: Module.MEDIA, icon: Image, label: 'Media' },
  { m: Module.MAP, icon: Grid3x3, label: 'Map' },
  { m: Module.FIXTURES, icon: Lightbulb, label: 'Fixtures' },
  { m: Module.THREE_D, icon: Box, label: '3D' },
];

export const ModuleSwitcher: React.FC<{ module: Module; onChange: (m: Module) => void }> = ({ module, onChange }) => (
  <div className="flex items-center gap-1">
    {MODULES.map(({ m, icon: Icon, label }) => {
      const active = module === m;
      return (
        <button
          key={m}
          onClick={() => onChange(m)}
          title={label}
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
