import React, { useEffect } from 'react';
import { X, VolumeX } from 'lucide-react';
import { useDraggableModal } from '../hooks/useDraggableModal';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Shown at startup when the native audio engine did not load. The app graceful-degrades PERFECTLY — no
// crash, the audio UI renders, every engine call no-ops — and that is exactly the problem: it draws a
// complete, healthy-looking mixer over a silent room. The only other warning lives in Settings ▸ Audio,
// which you reach only by already suspecting the answer. Wave 3 acceptance test 0.3.
//
// Dismissible, and deliberately NOT permanently silenceable: a warning you can switch off forever is how
// a venue machine ends up mute with nobody knowing. Closing it leaves the `no audio engine` badge in the
// Audio Bed panel, so the app never LOOKS healthy while it is mute.
export const AudioEngineMissing: React.FC<Props> = ({ open, onClose }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const { positionerStyle, handleProps } = useDraggableModal('audio-engine-missing');

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 animate-overlay-in" onClick={onClose}>
      <div style={positionerStyle}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="No audio engine"
        className="w-[420px] bg-surface-1 border border-line-2 rounded-lg shadow-e3 animate-modal-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div {...handleProps} className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2 cursor-move select-none">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-warn uppercase tracking-wider">
            <VolumeX size={14} /> No audio engine
          </span>
          <button onClick={onClose} aria-label="Close" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
        </div>

        <div className="p-5">
          <p className="text-xs text-fg-1 leading-relaxed">
            ARTLux started without its audio engine. The app works normally, but{' '}
            <strong className="text-warn">there will be no sound</strong> — the audio bed, scene audio and
            the mixer are all disabled.
          </p>
          <p className="mt-3 text-micro text-fg-3 leading-relaxed">
            Expected <span className="num">audio-engine.node</span> in the app’s resources. If you are
            running from source, build it with <span className="num">npm run build:audio</span>.
          </p>
        </div>
      </div>
      </div>
    </div>
  );
};
