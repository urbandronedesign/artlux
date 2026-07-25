import React, { useEffect, useState } from 'react';
import { X, Github, BookOpen, RefreshCw, Download, RotateCcw, ExternalLink, Check } from 'lucide-react';
import type { AppInfo, UpdateEvent } from '../../../shared/protocol';
import { Button } from './ui';
import { useDraggableModal } from '../hooks/useDraggableModal';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface Props {
  open: boolean;
  onClose: () => void;
  info: AppInfo | null;
}

const RELEASES = 'https://github.com/urbandronedesign/artlux/releases/latest';

const REPO = 'https://github.com/urbandronedesign/artlux';
const DOCS = `${REPO}/blob/main/docs/FEATURES.md`;

// Branded About dialog — mirrors the Preferences modal pattern.
export const About: React.FC<Props> = ({ open, onClose, info }) => {
  const [upd, setUpd] = useState<UpdateEvent | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const unsub = window.artlux?.onUpdate?.((e) => setUpd(e));
    return () => { window.removeEventListener('keydown', onKey); unsub?.(); };
  }, [open, onClose]);

  const { positionerStyle, handleProps } = useDraggableModal('about');
  const trapRef = useFocusTrap(open); // initial focus + Tab trap + return focus to the opener on close

  if (!open) return null;
  const open_ = (url: string) => window.artlux?.openExternal?.(url);
  const s = upd?.status;
  const checkUpdates = () => { setUpd({ status: 'checking' }); window.artlux?.checkForUpdates?.(); };

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 animate-overlay-in" onClick={onClose}>
      <div style={positionerStyle}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label="About ArtLux"
        className="w-[400px] bg-surface-1 border border-line-2 rounded-lg shadow-e3 animate-modal-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div {...handleProps} className="h-10 px-3 flex items-center justify-end border-b border-line-1 bg-surface-2 cursor-move select-none">
          <button onClick={onClose} aria-label="Close about" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
        </div>

        <div className="p-6 flex flex-col items-center text-center">
          <div className="w-16 h-16 bg-gradient-to-br from-accent to-accent-press rounded-lg flex items-center justify-center font-bold text-3xl text-black shadow-e2">A</div>
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

          {/* Updates */}
          <div className="mt-4 w-full flex flex-col items-center gap-1.5">
            {(!s || s === 'checking' || s === 'not-available' || s === 'error') && (
              <Button variant="tonal" size="sm" onClick={checkUpdates} disabled={s === 'checking'}>
                <RefreshCw size={13} className={s === 'checking' ? 'animate-spin' : ''} /> Check for updates
              </Button>
            )}
            {s === 'available' && (
              <Button variant="primary" size="sm" onClick={() => window.artlux?.downloadUpdate?.()}>
                <Download size={13} /> Download v{upd?.version}
              </Button>
            )}
            {s === 'progress' && <div className="text-mini text-fg-2">Downloading… {upd?.percent ?? 0}%</div>}
            {s === 'downloaded' && (
              <Button variant="primary" size="sm" onClick={() => window.artlux?.installUpdate?.()}>
                <RotateCcw size={13} /> Restart & install v{upd?.version}
              </Button>
            )}
            {s === 'manual' && (
              <Button variant="tonal" size="sm" onClick={() => open_(upd?.url || RELEASES)}>
                <ExternalLink size={13} /> Update available — open Releases
              </Button>
            )}
            <div className="text-micro text-fg-3 h-3">
              {s === 'checking' && 'Checking…'}
              {s === 'not-available' && <span className="inline-flex items-center gap-1"><Check size={10} /> You’re up to date</span>}
              {s === 'error' && <span className="text-danger">Update check failed</span>}
            </div>
          </div>

          <div className="mt-5 pt-3 border-t border-line-1 w-full text-micro text-fg-3 leading-relaxed">
            © urbandronedesign · BSD/MIT components
            <br />Electron · React · WebGPU · Rust (napi-rs) · Spout2
          </div>
        </div>
      </div>
      </div>
    </div>
  );
};
