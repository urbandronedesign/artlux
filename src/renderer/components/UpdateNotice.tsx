import React from 'react';
import { Download, RefreshCw, X, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';
import type { UpdateEvent } from '../../../shared/protocol';

interface Props {
  event: UpdateEvent;
  /** True when the check was started from the Help menu (so we also surface "up to date"). */
  userInitiated: boolean;
  onDownload: () => void;
  onInstall: () => void;
  onOpenExternal: (url: string) => void;
  onDismiss: () => void;
}

const btn = 'px-2.5 py-1 rounded-sm text-xs font-medium transition-colors';
const primary = `${btn} bg-accent text-black hover:bg-accent-hover`;
const ghost = `${btn} text-fg-2 hover:bg-surface-3 hover:text-fg-1`;

// Bottom-right toast for the auto-update flow. Nothing here downloads or installs
// on its own — the user clicks Download, then Restart & Install.
export const UpdateNotice: React.FC<Props> = ({ event, userInitiated, onDownload, onInstall, onOpenExternal, onDismiss }) => {
  const s = event.status;

  // Hide the silent states unless the user explicitly asked to check.
  if ((s === 'checking' || s === 'not-available') && !userInitiated) return null;

  return (
    <div className="fixed bottom-9 right-3 z-toast w-72 bg-surface-1 border border-line-1 rounded-md shadow-e3 text-xs">
      <div className="flex items-start gap-2 p-3">
        <div className="mt-0.5 text-accent shrink-0">
          {s === 'downloaded' ? <CheckCircle2 size={15} className="text-ok" />
            : s === 'error' ? <AlertCircle size={15} className="text-danger" />
            : s === 'manual' ? <ExternalLink size={15} />
            : <Download size={15} />}
        </div>
        <div className="flex-1 min-w-0">
          {s === 'checking' && <p className="text-fg-2">Checking for updates…</p>}
          {s === 'not-available' && <p className="text-fg-2">You’re on the latest version.</p>}
          {s === 'available' && (
            <>
              <p className="text-fg-1 font-semibold">Update available{event.version ? ` — v${event.version}` : ''}</p>
              <p className="text-fg-3 mt-0.5">Download it now? The app keeps running.</p>
            </>
          )}
          {s === 'progress' && (
            <>
              <p className="text-fg-1 font-semibold">Downloading update… {event.percent ?? 0}%</p>
              <div className="h-1 mt-1.5 bg-surface-0 rounded-full overflow-hidden">
                <div className="h-full bg-accent rounded-full transition-[width]" style={{ width: `${event.percent ?? 0}%` }} />
              </div>
            </>
          )}
          {s === 'downloaded' && (
            <>
              <p className="text-fg-1 font-semibold">Update ready{event.version ? ` — v${event.version}` : ''}</p>
              <p className="text-fg-3 mt-0.5">Restart now to install it.</p>
            </>
          )}
          {s === 'manual' && (
            <>
              <p className="text-fg-1 font-semibold">A new version is available</p>
              <p className="text-fg-3 mt-0.5">Auto-update isn’t supported on this build — download it from GitHub.</p>
            </>
          )}
          {s === 'error' && (
            <>
              <p className="text-fg-1 font-semibold">Update failed</p>
              <p className="text-fg-3 mt-0.5 break-words">{event.message ?? 'Unknown error.'}</p>
            </>
          )}

          {(s === 'available' || s === 'downloaded' || s === 'manual') && (
            <div className="flex items-center gap-1.5 mt-2.5">
              {s === 'available' && <button className={primary} onClick={onDownload}><span className="inline-flex items-center gap-1"><Download size={12} /> Download</span></button>}
              {s === 'downloaded' && <button className={primary} onClick={onInstall}><span className="inline-flex items-center gap-1"><RefreshCw size={12} /> Restart & Install</span></button>}
              {s === 'manual' && <button className={primary} onClick={() => onOpenExternal(event.url || 'https://github.com/urbandronedesign/artlux/releases/latest')}><span className="inline-flex items-center gap-1"><ExternalLink size={12} /> Open GitHub</span></button>}
              <button className={ghost} onClick={onDismiss}>Later</button>
            </div>
          )}
        </div>
        <button className="text-fg-3 hover:text-fg-1 shrink-0" onClick={onDismiss} aria-label="Dismiss"><X size={14} /></button>
      </div>
    </div>
  );
};
