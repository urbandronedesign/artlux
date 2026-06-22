import React, { useEffect } from 'react';
import { X, Github, BookOpen } from 'lucide-react';
import type { AppInfo } from '../../../shared/protocol';
import { Button } from './ui';

interface Props {
  open: boolean;
  onClose: () => void;
  info: AppInfo | null;
}

const REPO = 'https://github.com/urbandronedesign/artlux';
const DOCS = `${REPO}/blob/main/docs/FEATURES.md`;

// Branded About dialog — mirrors the Preferences modal pattern.
export const About: React.FC<Props> = ({ open, onClose, info }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const open_ = (url: string) => window.artlux?.openExternal?.(url);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 animate-overlay-in" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="About ArtLux"
        className="w-[400px] bg-surface-1 border border-line-2 rounded-[var(--r-lg)] shadow-2xl animate-modal-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-10 px-3 flex items-center justify-end border-b border-line-1 bg-surface-2">
          <button onClick={onClose} aria-label="Close about" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
        </div>

        <div className="p-6 flex flex-col items-center text-center">
          <div className="w-16 h-16 bg-gradient-to-br from-accent to-accent-press rounded-[var(--r-lg)] flex items-center justify-center font-bold text-3xl text-black shadow-lg">A</div>
          <div className="mt-3 text-lg font-bold text-fg-1 tracking-wide">ARTLUX</div>
          <div className="num text-xs text-fg-3 mt-0.5">Version {info?.version ?? '—'}</div>
          <p className="mt-3 text-xs text-fg-2 leading-relaxed">
            GPU-accelerated addressable-LED pixel mapping for Art-Net / sACN.
            WebGPU compute · native Rust output engine · 2D + 3D.
          </p>

          <div className="flex gap-2 mt-4">
            <Button variant="tonal" size="sm" onClick={() => open_(REPO)}><Github size={13} /> GitHub</Button>
            <Button variant="tonal" size="sm" onClick={() => open_(DOCS)}><BookOpen size={13} /> Docs</Button>
          </div>

          <div className="mt-5 pt-3 border-t border-line-1 w-full text-[10px] text-fg-3 leading-relaxed">
            © urbandronedesign · BSD/MIT components
            <br />Electron · React · WebGPU · Rust (napi-rs) · Spout2
          </div>
        </div>
      </div>
    </div>
  );
};
