import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { SurfaceContent } from '@/types';
import { listNdiSources, ndiAvailable } from './ndiReceiver';

// The NDI source picker shown in the content inspector when the content type is NDI. Discovery runs
// over the plugin IPC bridge (listNdiSources / ndiAvailable → pluginInvoke). Contributed to the host
// ContentEditor via the content-source provider's `editor`. Markup mirrors the former core fragment.
export const NdiEditor: React.FC<{ content: SurfaceContent; onChange: (patch: Partial<SurfaceContent>) => void }> = ({ content, onChange }) => {
  const [sources, setSources] = useState<string[]>([]);
  const [ok, setOk] = useState(true);
  const refresh = async () => { setOk(await ndiAvailable()); setSources(await listNdiSources()); };
  useEffect(() => { void refresh(); }, []);

  return (
    <div className="pt-1 space-y-1">
      <div className="flex items-center gap-1">
        <select value={content.ndiName ?? ''} onChange={(e) => onChange({ ndiName: e.target.value })}
          className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[10px] focus:border-accent focus:outline-none">
          <option value="">First source</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={refresh} title="Refresh NDI sources" className="p-1.5 rounded border border-line-1 text-fg-2 hover:bg-surface-3"><RefreshCw size={12} /></button>
      </div>
      {!ok && (
        <div className="text-[9px] text-warn">
          NDI runtime not found.{' '}
          <button onClick={() => window.artlux?.openExternal?.('https://ndi.video/tools/')} className="underline hover:text-fg-1">Install NDI Tools ↗</button>
        </div>
      )}
    </div>
  );
};
