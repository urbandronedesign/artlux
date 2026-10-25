import React, { useState, useSyncExternalStore } from 'react';
import { Download, Plus, X } from 'lucide-react';
import type { CalibAssign, ProjectorOutput } from '../../../shared/protocol';
import * as baked from './bakedStore';
import { describe } from './bakedStore';
import { getHost, getScene, setUseCalibration } from './calibHost';
import { projectorName, useOutputs, useSurfaces } from './useHostData';

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

// The value of a projector's row in the per-output table: 'auto', 'none', or `<file>\n<region>`.
const AUTO = 'auto', NONE = 'none';
const choiceKey = (a: CalibAssign | undefined): string => (!a ? AUTO : 'none' in a ? NONE : `${a.file}\n${a.region}`);
const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/**
 * An output that stops playing a map falls back to what it would draw without one — and with
 * `useCalibration` on and no venue to render, that is a BLACK wall (see unload below). Same rule for
 * one output as for all of them.
 */
function releaseIfBlind(ids: string[]): void {
  const venue = (getScene().models ?? []).some((m) => m.visible);
  for (const o of (getHost()?.projectorOutputs.list() ?? []) as ProjectorOutput[]) {
    if (!ids.includes(o.surfaceId)) continue;
    if (o.useCalibration && !(venue && o.calibration?.poseRms != null)) setUseCalibration(o.surfaceId, false);
  }
}

export const ImportPanel: React.FC = () => {
  const imported = useSyncExternalStore(baked.subscribe, baked.get);
  const bs = useSyncExternalStore(baked.subscribe, baked.getState);
  const [note, setNote] = useState<string | null>(null);
  const outputs = useOutputs();
  const surfaces = useSurfaces();
  const nameOf = (id: string): string => projectorName(id, outputs, surfaces);

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
    const previous = bs.rig?.path;
    baked.set({ path: res.path, regions: res.regions, importedAt: new Date().toISOString() });
    // A choice that pointed into the REPLACED rig file points at nothing now — back to Auto, which
    // reads the new file, rather than a projector quietly left with no map.
    const assign = Object.fromEntries(Object.entries(bs.assign).filter(([, a]) => !('file' in a && a.file === previous && previous !== res.path)));
    if (Object.keys(assign).length !== Object.keys(bs.assign).length) baked.setAssign(assign);
    void window.artlux?.setPrefs?.({ calibrationFile: res.path, calibrationAssign: assign });
  };

  const unload = (): void => {
    // Everything: the rig file, any extra file and every per-output choice — "Unload" means no file.
    baked.clearAll();
    // Forget the paths too, or the next start would silently re-load what was just withdrawn.
    void window.artlux?.setPrefs?.({ calibrationFile: '', calibrationExtraFiles: [], calibrationAssign: {} });
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
    //
    // ⚠ BUT ONLY WHERE THE OUTPUT CANNOT DRAW THE VENUE. Switching every output off threw away the live
    // calibration on the machine that HAS the venue — the authoring machine, where an operator who had
    // re-calibrated after an import pressed Unload and got flat, uncalibrated outputs (measured: the
    // two-projector template after a Blender re-aim). An output with a solved pose and a visible venue
    // model renders from its pose again; only one that would draw nothing goes back to its own warp.
    // Same rule as App's rendersVenue, which also falls back on its own — this keeps the document
    // honest instead of leaning on that.
    releaseIfBlind(((getHost()?.projectorOutputs.list() ?? []) as ProjectorOutput[]).map((o) => o.surfaceId));
  };

  // ── PER PROJECTOR ────────────────────────────────────────────────────────────────────────────
  // Another file to pick regions from — one exported by another project or another media server.
  const addFile = async (): Promise<void> => {
    setNote(null);
    const res = await window.artlux?.importMpcdi?.();
    if (!res) { setNote('Import cancelled, or the file could not be read.'); return; }
    if (!res.regions.length) { setNote('That file parsed but declares no regions.'); return; }
    const next = [...bs.extras.filter((e) => e.path !== res.path), { path: res.path, regions: res.regions, importedAt: new Date().toISOString() }];
    baked.setExtras(next);
    void window.artlux?.setPrefs?.({ calibrationExtraFiles: next.map((e) => e.path) });
  };
  const removeFile = (path: string): void => {
    const next = bs.extras.filter((e) => e.path !== path);
    // Outputs that played a region of it go back to Auto — never silently to a map that is gone.
    const assign = Object.fromEntries(Object.entries(bs.assign).filter(([, a]) => !('file' in a && a.file === path)));
    const dropped = Object.keys(bs.assign).filter((id) => !(id in assign));
    baked.setExtras(next);
    baked.setAssign(assign);
    releaseIfBlind(dropped.filter((id) => !baked.regionFor(id)));
    void window.artlux?.setPrefs?.({ calibrationExtraFiles: next.map((e) => e.path), calibrationAssign: assign });
  };
  const choose = (surfaceId: string, key: string): void => {
    const assign = { ...bs.assign };
    if (key === AUTO) delete assign[surfaceId];
    else if (key === NONE) assign[surfaceId] = { none: true };
    else { const [file, region] = key.split('\n'); assign[surfaceId] = { file, region }; }
    baked.setAssign(assign);
    if (!baked.regionFor(surfaceId)) releaseIfBlind([surfaceId]);
    void window.artlux?.setPrefs?.({ calibrationAssign: assign });
  };

  const projectors = outputs.filter((o) => o.enabled);
  const loaded = baked.files();
  const mixed = baked.mixedExports(projectors.map((o) => o.surfaceId));
  // What Auto resolves to for one output, said in the option itself so "Auto" is never a guess.
  const autoLabel = (id: string): string => {
    const r = bs.rig?.regions.find((x) => x.id === id);
    return r ? `Auto — ${fileName(bs.rig!.path)}` : bs.rig ? 'Auto — not in the file' : 'Auto — no file loaded';
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
            title="Unload the calibration file. Outputs go back to their live calibration where the venue model is loaded, otherwise to their own warp"
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
          {describe(imported, nameOf).map((l) => <div key={l} className="num">· {l}</div>)}
        </div>
      ) : (
        <div className="text-micro text-fg-3">
          No calibration loaded. Outputs use their own corner-pin / Bézier warp.
        </div>
      )}

      {/* WHICH REGION EACH PROJECTOR PLAYS. Auto is the rig file matched by surface id — what a file
          exported by this project wants. A region can be picked by hand for a file whose ids match
          nothing here, or None to keep a projector on its live calibration / own warp. */}
      {projectors.length > 0 && (loaded.length > 0 || Object.keys(bs.assign).length > 0) && (
        <div className="flex flex-col gap-1.5 pt-2 mt-1 border-t border-line-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-micro uppercase tracking-wider text-fg-2">Per projector</span>
            <button onClick={() => void addFile()}
              title="Load another calibration file to pick regions from — one from another project or another media server"
              className="flex items-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-fg-2 text-micro">
              <Plus size={11} /> Add a file…
            </button>
          </div>
          {projectors.map((o) => {
            const src = baked.sourceFor(o.surfaceId);
            return (
              <label key={o.surfaceId} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] items-center gap-2">
                <span className="truncate text-fg-1" title={o.surfaceId}>{nameOf(o.surfaceId)}</span>
                <select value={choiceKey(bs.assign[o.surfaceId])} onChange={(e) => choose(o.surfaceId, e.target.value)}
                  className={`min-w-0 bg-surface-0 border rounded px-1 py-0.5 text-micro ${src ? 'border-line-1 text-fg-1' : 'border-line-1 text-fg-3'}`}>
                  <option value={AUTO}>{autoLabel(o.surfaceId)}</option>
                  <option value={NONE}>None — live calibration or own warp</option>
                  {loaded.map((f) => (
                    <optgroup key={f.path} label={fileName(f.path)}>
                      {f.regions.map((r) => (
                        <option key={r.id} value={`${f.path}\n${r.id}`}>{nameOf(r.id)}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
            );
          })}
          {bs.extras.length > 0 && (
            <div className="flex flex-col gap-0.5 text-micro text-fg-3">
              {bs.extras.filter((e) => e.path !== bs.rig?.path).map((e) => (
                <div key={e.path} className="flex items-center gap-1.5">
                  <span className="truncate" title={e.path}>+ {fileName(e.path)} · {e.regions.length} region(s)</span>
                  <button onClick={() => removeFile(e.path)} title="Remove this file — projectors that played one of its regions go back to Auto"
                    className="text-fg-3 hover:text-fg-1"><X size={11} /></button>
                </div>
              ))}
            </div>
          )}
          {mixed.length > 0 && (
            <div className="text-micro text-warn">
              ⚠ The projectors play regions from {mixed.length} different files. A blend is solved for one set of
              projectors, so the soft edges between files were not made to add up — check the overlaps on the wall.
            </div>
          )}
        </div>
      )}

      {note && <div className="text-micro text-warn">{note}</div>}
    </div>
  );
};
