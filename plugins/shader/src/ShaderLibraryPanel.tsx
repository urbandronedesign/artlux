// The effect library — a browser panel.
//
// An effect written for one show is a building block in the next, and this is where that happens.
// Cards, because a shader is recognised by its picture and not by its name.

import React, { useCallback, useEffect, useState } from 'react';
import { useEditor, useEditorActions } from '@/state/EditorStore';
import { useConfirm } from '@/components/ui/feedback'; // never a native dialog — see the invariant
import * as library from './libraryClient';
import { resolve as resolveParams } from './shaderParams';

export const ShaderLibraryPanel: React.FC = () => {
  const { surfaces, selectedSurfaceId } = useEditor();
  const { updateSurface } = useEditorActions();
  const [entries, setEntries] = useState(library.all());
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const confirmDialog = useConfirm();

  useEffect(() => {
    const un = library.subscribe(() => setEntries(library.all()));
    void library.refresh();
    return un;
  }, []);

  const surface = surfaces.find((s) => s.id === selectedSurfaceId) ?? null;
  const isShader = surface?.content.type === 'SHADER';

  const save = useCallback(async () => {
    if (!surface || !isShader) return;
    // The surface's name is the obvious default and almost always what the operator means; renaming
    // is a rename on the folder afterwards, which is one place rather than a dialog every time.
    const name = surface.name?.trim() || 'Untitled effect';
    setBusy(true);
    const res = await library.saveFromContent(name, surface.content, resolveParams(surface.id, surface.content));
    setBusy(false);
    setNote(res.ok ? `Saved as “${res.name}”` : `Could not save: ${res.error ?? 'unknown error'}`);
  }, [surface, isShader]);

  const apply = useCallback((entry: library.LibraryEntry) => {
    if (!surface) return;
    // Applying makes the surface a SHADER surface even if it was showing something else — picking an
    // effect and having nothing happen because the surface was a VIDEO would be the wrong lesson.
    updateSurface(surface.id, { content: { ...surface.content, ...library.contentPatch(entry) } });
    setNote(`Applied “${entry.name}” to ${surface.name}`);
  }, [surface, updateSurface]);

  const shown = filter
    ? entries.filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()))
    : entries;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-line-1 px-2 py-1 shrink-0">
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search effects"
          className="min-w-0 flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-0.5 text-fg-1 text-micro focus:border-accent focus:outline-none"
        />
        <button onClick={() => void library.reveal()} title="Open the library folder"
          className="px-1.5 py-0.5 rounded border border-line-1 text-fg-2 text-micro">Folder</button>
        <button onClick={() => void save()} disabled={!isShader || busy}
          title={isShader ? 'Save this surface’s shader as a reusable effect' : 'Select a shader surface first'}
          className="px-1.5 py-0.5 rounded border border-accent/60 text-accent text-micro disabled:opacity-40">
          {busy ? 'Saving…' : 'Save current'}
        </button>
      </div>

      {note && <div className="px-2 py-1 text-micro text-fg-3 shrink-0">{note}</div>}

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {shown.length === 0 && (
          <div className="text-micro text-fg-3 italic">
            {entries.length === 0
              ? 'No saved effects yet. Select a shader surface and press Save current.'
              : 'Nothing matches that search.'}
          </div>
        )}

        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
          {shown.map((e) => (
            <div key={e.name} className="group rounded border border-line-1 bg-surface-2 overflow-hidden">
              <button
                onClick={() => apply(e)} disabled={!surface}
                title={surface ? `Apply to ${surface.name}` : 'Select a surface first'}
                className="block w-full disabled:opacity-50"
              >
                {/* A shader is recognised by its picture. No thumbnail means it did not compile when it
                    was saved, which is worth showing rather than hiding behind a placeholder. */}
                {e.thumbnail
                  ? <img src={e.thumbnail} alt="" className="block h-[68px] w-full object-cover" />
                  : <div className="flex h-[68px] w-full items-center justify-center text-micro text-fg-3">no preview</div>}
              </button>
              <div className="flex items-center gap-1 px-1.5 py-1">
                <span className="min-w-0 flex-1 truncate text-micro text-fg-1" title={e.name}>{e.name}</span>
                <button
                  onClick={() => void (async () => {
                    // THE IN-APP DIALOG, NEVER THE NATIVE ONE. window.confirm blocks the JS thread, so
                    // the whole app stops until it is answered — and behind a fullscreen projector
                    // output the box is not even visible. It reads as a freeze, not as a question.
                    const ok = await confirmDialog({
                      title: `Delete “${e.name}”?`,
                      message: 'Removed from your library on this machine. Projects already using it keep their own copy.',
                      confirmLabel: 'Delete',
                      danger: true,
                    });
                    if (ok) await library.remove(e.name);
                  })()}
                  title="Delete from the library"
                  className="text-micro text-fg-3 opacity-0 group-hover:opacity-100"
                >×</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
