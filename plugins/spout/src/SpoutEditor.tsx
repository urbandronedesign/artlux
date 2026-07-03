import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { SurfaceContent } from '@/types';
import { listSpoutSenders } from './spoutReceiver';

// The Spout sender picker shown in the content inspector when the content type is SPOUT. Discovery runs
// over the plugin IPC bridge (listSpoutSenders → pluginInvoke('spout:list')). Contributed to the host
// ContentEditor via the content-source provider's `editor`. Markup mirrors the former core fragment.
export const SpoutEditor: React.FC<{ content: SurfaceContent; onChange: (patch: Partial<SurfaceContent>) => void }> = ({ content, onChange }) => {
  const [senders, setSenders] = useState<string[]>([]);
  const refresh = async () => setSenders(await listSpoutSenders());
  useEffect(() => { void refresh(); }, []);

  return (
    <div className="flex items-center gap-1 pt-1">
      <select value={content.spoutName ?? ''} onChange={(e) => onChange({ spoutName: e.target.value })}
        className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none">
        <option value="">Active sender</option>
        {senders.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <button onClick={refresh} title="Refresh Spout senders" className="p-1.5 rounded border border-line-1 text-fg-2 hover:bg-surface-3"><RefreshCw size={12} /></button>
    </div>
  );
};
