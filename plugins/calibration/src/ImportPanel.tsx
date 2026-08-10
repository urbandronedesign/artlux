import React, { useState, useSyncExternalStore } from 'react';
import { Download, X } from 'lucide-react';
import type { ProjectorOutput } from '../../../shared/protocol';
import * as baked from './bakedStore';
import { describe } from './bakedStore';
import { getHost, setUseCalibration } from './calibHost';

// LOADING A VENUE'S CALIBRATION — the half of calibration that is not authoring.
//
// Importing a baked map is PLAYBACK, not calibration: no camera, no wizard, no solve, no OpenCV. The
// file already answers "where does each of my pixels land", and the projector window plays it through
// one fragment shader. So this must be reachable in a plain editor launch, which drops the whole
// authoring half — and that is why this panel exists separately from the calibration workbench rather
// than only living on its no-session screen.
//
// It is contributed to the PROJECTION OUTPUTS context, where the outputs it applies to already are.
// The alternative — a rail entry of its own — would put a whole workbench behind one button, and the
// question "which of my outputs has a calibration loaded" belongs beside the outputs table.
//
// ⚠ Venue-scoped, not project data. The map belongs to the ROOM: one file serves every project you run
// there, so re-calibrating must not mean re-saving twelve .artlux files, and a 10 MB payload has no
// business in an undo snapshot. It therefore does NOT survive a restart — which is a deliberate
// property, not an omission, and the reason this panel always states what is currently loaded.

export const ImportPanel: React.FC = () => {
  const imported = useSyncExternalStore(baked.subscribe, baked.get);
  const [note, setNote] = useState<string | null>(null);

  // Import is a MAIN-process dialog + parse; the regions arrive as plain structured-cloned data.
  //
  // The PATH is remembered in prefs — per machine, never in the project, because a calibration
  // describes the room rather than the show. That is also the only thing that makes a baked map reach
  // a `--broadcast` install, which has no chrome to import from and nobody to click it. The pixels are
  // never persisted: ~10 MB per projector, re-read from this path at startup.
  const importRig = async (): Promise<void> => {
    setNote(null);
    const res = await window.artlux?.importMpcdi?.();
    if (!res) { setNote('Import cancelled, or the file could not be read.'); return; }
    if (!res.regions.length) { setNote('That file parsed but declares no regions.'); return; }
    baked.set({ path: res.path, regions: res.regions, importedAt: new Date().toISOString() });
    void window.artlux?.setPrefs?.({ calibrationFile: res.path });
  };

  const unload = (): void => {
    baked.set(null);
    // Forget the path too, or the next start would silently re-load what was just withdrawn.
    void window.artlux?.setPrefs?.({ calibrationFile: '' });
    // ⚠ …AND RETURN EVERY OUTPUT TO ITS OWN WARP, WHICH IS WHAT THIS BUTTON SAYS IT DOES.
    //
    // Withdrawing the map was only half of it, and the missing half turned the projector BLACK.
    // While a map is loaded, ProjectorApp.applyCalibMode downgrades calib mode 'render' → 'idle' —
    // the map supersedes render-from-projector — and the base canvas draws content through it. Take
    // the map away and nothing downgrades any more, so an output with `useCalibration` on drops
    // straight back into render mode: the base canvas early-returns (render mode is meant to be
    // covered by an opaque overlay), App stops streaming it frames at all, and the overlay that
    // should be painting needs the venue 3D scene. No venue, no picture, black wall.
    //
    // And it SURVIVED A CLOSE AND REOPEN, which is what made it look like a stuck window:
    // `useCalibration` is persisted on the output, so a fresh window rebuilt the same state. It was
    // never the window — it was the document.
    //
    // The pose (`calibration`) is deliberately left alone: it is expensive authoring data, and this
    // is a reversible switch, not a delete.
    for (const o of (getHost()?.projectorOutputs.list() ?? []) as ProjectorOutput[]) {
      if (o.useCalibration) setUseCalibration(o.surfaceId, false);
    }
  };

  return (
    <div className="p-3 flex flex-col gap-2 text-mini">
      <div className="flex items-center gap-2">
        <button onClick={() => void importRig()}
          title="Load a calibration file (.mpcdi) exported from here or another media server"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-surface-2 border border-line-1 text-fg-1">
          <Download size={12} /> Import calibration (.mpcdi)
        </button>
        {imported && (
          // Withdrawing has to be as reachable as loading: a stale map keeps warping the output through
          // geometry the venue no longer has, and re-calibrating an output means clearing its import
          // first (a wizard's Verify step renders live, and a loaded map supersedes exactly that).
          <button onClick={unload}
            title="Unload the calibration and return every output to its own warp"
            className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-surface-2 border border-line-1 text-fg-2">
            <X size={12} /> Unload
          </button>
        )}
      </div>

      {imported ? (
        <div className="text-micro text-fg-3">
          <div className="text-fg-2">
            {imported.regions.length} region(s) — {imported.path.split(/[\\/]/).pop()}
          </div>
          {describe(imported).map((l) => <div key={l} className="num">· {l}</div>)}
        </div>
      ) : (
        <div className="text-micro text-fg-3">
          No calibration loaded. Outputs use their own corner-pin / Bézier warp.
        </div>
      )}

      {note && <div className="text-micro text-warn">{note}</div>}
    </div>
  );
};
