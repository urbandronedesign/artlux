import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import type { SurfaceContent } from '@/types';
import { listSyphonServers, syphonIncompatibility, onSyphonStatus } from './syphonReceiver';
import type { SyphonIncompatibility, SyphonServerDesc } from './types';

// Why Syphon is not running, in the operator's terms. Syphon is GPU-only — the server's texture is
// shared straight onto this machine's GPU and never read back — so these are not degraded modes,
// they are "no picture", and each one names something the operator can actually check or change.
const REASON: Record<SyphonIncompatibility, string> = {
  'no-native': 'The Syphon receiver did not load. Syphon is macOS-only.',
  'no-shared-texture': 'This build cannot share GPU textures, which Syphon requires.',
  // Deliberately NOT Spout's "the sender is on a different graphics card". That is a Windows fact:
  // an IOSurface is not tied to one adapter, so suggesting a GPU switch here would send the operator
  // to a setting that does not exist and cannot help.
  'import-failed': 'The GPU refused the shared texture. Check the server is still publishing, and that it is running on this machine.',
  'editor-crashed': 'Syphon was turned off because the editor stopped while showing this server. Restart ArtLux to try again — and if it happens again, send the log.',
};

// The Syphon server picker shown in the content inspector when the content type is SYPHON.
// Discovery runs over the plugin IPC bridge (listSyphonServers → pluginInvoke('syphon:list')).
// Contributed to the host ContentEditor via the content-source provider's `editor`.
export const SyphonEditor: React.FC<{ content: SurfaceContent; onChange: (patch: Partial<SurfaceContent>) => void }> = ({ content, onChange }) => {
  const [servers, setServers] = useState<SyphonServerDesc[]>([]);
  const refresh = async () => setServers(await listSyphonServers());
  useEffect(() => { void refresh(); }, []);
  // Live, because the verdict only arrives once main has tried — the panel is usually already open.
  const why = useSyncExternalStore(onSyphonStatus, syphonIncompatibility);

  // ⚠ THE VALUE IS THE PAIR, NOT THE NAME. A Syphon server's own name is frequently empty and is not
  // unique, so a <select> keyed on the name alone would collapse distinct servers onto one option
  // and silently pick the wrong one. The option value encodes both halves and is split on write.
  const SEP = '\u0001';
  const current = `${content.syphonName ?? ''}${SEP}${content.syphonAppName ?? ''}`;

  return (
    <div className="flex flex-col gap-1 pt-1">
      <div className="flex items-center gap-1">
        <select
          value={current}
          onChange={(e) => {
            const [name, appName] = e.target.value.split(SEP);
            onChange({ syphonName: name, syphonAppName: appName });
          }}
          className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none">
          <option value={`${SEP}`}>Active server</option>
          {servers.map((s) => (
            <option key={`${s.name}${SEP}${s.appName}`} value={`${s.name}${SEP}${s.appName}`}>{s.label}</option>
          ))}
        </select>
        <button onClick={refresh} title="Refresh Syphon servers" className="p-1.5 rounded border border-line-1 text-fg-2 hover:bg-surface-3"><RefreshCw size={12} /></button>
      </div>
      {why && (
        // Said plainly and in place. Without this the surface is simply empty, and an empty surface
        // reads as "I picked the wrong server" — sending the operator to look in the wrong place.
        <div className="flex items-start gap-1.5 rounded border border-warn/40 bg-warn/10 px-1.5 py-1 text-micro text-fg-1">
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />
          <span><span className="font-medium">Syphon not compatible.</span> {REASON[why]}</span>
        </div>
      )}
    </div>
  );
};
