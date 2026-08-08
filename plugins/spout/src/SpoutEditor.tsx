import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import type { SurfaceContent } from '@/types';
import { listSpoutSenders, spoutIncompatibility, onSpoutStatus } from './spoutReceiver';
import type { SpoutIncompatibility } from './types';

// Why Spout is not running, in the operator's terms. Spout is GPU-only — the sender's texture is
// shared straight onto this machine's GPU and never read back — so these are not degraded modes, they
// are "no picture", and each one names something the operator can actually check or change.
const REASON: Record<SpoutIncompatibility, string> = {
  'no-native': 'The Spout receiver did not load. Spout is Windows-only.',
  'no-shared-texture': 'This build cannot share GPU textures, which Spout requires.',
  'import-failed': 'The GPU refused the shared texture. This usually means the sender is running on a different graphics card — put both on the same GPU.',
};

// The Spout sender picker shown in the content inspector when the content type is SPOUT. Discovery runs
// over the plugin IPC bridge (listSpoutSenders → pluginInvoke('spout:list')). Contributed to the host
// ContentEditor via the content-source provider's `editor`.
export const SpoutEditor: React.FC<{ content: SurfaceContent; onChange: (patch: Partial<SurfaceContent>) => void }> = ({ content, onChange }) => {
  const [senders, setSenders] = useState<string[]>([]);
  const refresh = async () => setSenders(await listSpoutSenders());
  useEffect(() => { void refresh(); }, []);
  // Live, because the verdict only arrives once main has tried — the panel is usually already open.
  const why = useSyncExternalStore(onSpoutStatus, spoutIncompatibility);

  return (
    <div className="flex flex-col gap-1 pt-1">
      <div className="flex items-center gap-1">
        <select value={content.spoutName ?? ''} onChange={(e) => onChange({ spoutName: e.target.value })}
          className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none">
          <option value="">Active sender</option>
          {senders.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={refresh} title="Refresh Spout senders" className="p-1.5 rounded border border-line-1 text-fg-2 hover:bg-surface-3"><RefreshCw size={12} /></button>
      </div>
      {why && (
        // Said plainly and in place. Without this the surface is simply empty, and an empty surface
        // reads as "I picked the wrong sender" — sending the operator to look in the wrong place.
        <div className="flex items-start gap-1.5 rounded border border-warn/40 bg-warn/10 px-1.5 py-1 text-micro text-fg-1">
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />
          <span><span className="font-medium">Spout not compatible.</span> {REASON[why]}</span>
        </div>
      )}
    </div>
  );
};
