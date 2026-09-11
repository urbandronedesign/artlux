// IMPORT FROM PROJECT — pick units out of another show and bring them into this one.
//
// The dialog's real job is not the picking, it is the REPORT. A cross-project import re-mints every
// carried id and rewrites every reference to it, and when it gets one wrong the show engine says
// nothing at all: a state whose scene is missing recalls nothing and keeps running, reporting
// playing:true all night (services/stateMachine.ts). So everything the import is about to do —
// what it drags in, what it renames, what it drops, and any reference that would still dangle — is
// put on screen BEFORE the operator commits, because nothing downstream will ever raise it.
//
// The source project is PEEKED, never opened (main/persistence.peekProject): reading it must not
// disturb the open show's media allowlist, thumbnails or recents.
import React, { useEffect, useMemo, useState } from 'react';
import { X, FolderOpen, AlertTriangle, Info, FileWarning } from 'lucide-react';
import type { OpenProjectResult } from '../../../shared/protocol';
import {
  enumerateUnits, planImport, applyAssetRemap, validateReferences,
  type ImportableDoc, type ImportSelection, type ImportPatch, type ImportUnit, type RigStrategy,
} from '../services/projectImport';
import { Button, Segmented, useToast } from './ui';
import { useDraggableModal } from '../hooks/useDraggableModal';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The open document, read for name collisions and for the merge preview. Never mutated. */
  dest: ImportableDoc;
  /** Where the open project lives. Null ⇒ unsaved, and there is nowhere to copy media into. */
  projectPath: string | null;
  onCommit: (patch: ImportPatch, assets: unknown[], summary: string) => void;
}

const KIND_LABEL: Record<ImportUnit['kind'], string> = {
  stateMachine: 'Show graph',
  state: 'Individual states',
  scene: 'Scenes',
  cueBank: 'Cue banks',
  pose: 'Lighting poses',
};
const KIND_ORDER: ImportUnit['kind'][] = ['stateMachine', 'state', 'scene', 'cueBank', 'pose'];

// Which selection array a unit kind ticks. The show graph is the odd one out — it is a boolean,
// because there is only ever one of it.
const KIND_KEY = {
  state: 'stateIds', scene: 'sceneIds', cueBank: 'cueBankIds', pose: 'poseIds',
} as const;

export const ImportFromProject: React.FC<Props> = ({ open, onClose, dest, projectPath, onCommit }) => {
  const toast = useToast();
  const [source, setSource] = useState<OpenProjectResult | null>(null);
  const [sel, setSel] = useState<ImportSelection>({});
  const [rig, setRig] = useState<RigStrategy>('append');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, busy]);

  // A fresh dialog every time: carrying the last source over would make "Import…" ambiguous about
  // which project it is about to read.
  useEffect(() => { if (!open) { setSource(null); setSel({}); setBusy(false); } }, [open]);

  const { positionerStyle, handleProps } = useDraggableModal('import-project');
  const trapRef = useFocusTrap(open);

  const units = useMemo(() => (source ? enumerateUnits(source.data as ImportableDoc) : []), [source]);
  const anySelected = !!sel.stateMachine || !!sel.stateIds?.length || !!sel.sceneIds?.length
    || !!sel.cueBankIds?.length || !!sel.poseIds?.length;

  // The plan is recomputed on every tick of a checkbox — it is pure and operates on documents already
  // in memory, so there is nothing to debounce.
  const plan = useMemo(
    () => (source && anySelected ? planImport(source.data as ImportableDoc, dest, sel, { rig }) : null),
    [source, sel, dest, rig, anySelected],
  );

  // What the document WOULD look like, checked before anything is committed.
  const problems = useMemo(() => {
    if (!plan) return [];
    return validateReferences({
      scenes: [...(dest.scenes ?? []), ...plan.patch.scenes],
      cueBanks: [...(dest.cueBanks ?? []), ...plan.patch.cueBanks],
      surfaces: [...(dest.surfaces ?? []), ...plan.patch.surfaces],
      fixtures: [...(dest.fixtures ?? []), ...plan.patch.fixtures],
      groups: [...(dest.groups ?? []), ...plan.patch.groups],
      lightingPoses: [...(dest.lightingPoses ?? []), ...plan.patch.lightingPoses],
      scene3D: {
        ...(dest.scene3D ?? {}),
        trackingZones: [...(dest.scene3D?.trackingZones ?? []), ...plan.patch.trackingZones],
      } as ImportableDoc['scene3D'],
      stateMachine: {
        enabled: dest.stateMachine?.enabled ?? false,
        initialStateId: dest.stateMachine?.initialStateId ?? null,
        states: [...(dest.stateMachine?.states ?? []), ...plan.patch.states],
        transitions: [...(dest.stateMachine?.transitions ?? []), ...plan.patch.transitions],
        regions: [...(dest.stateMachine?.regions ?? []), ...plan.patch.regions],
      },
    });
  }, [plan, dest]);

  if (!open) return null;

  const pick = async () => {
    const r = await window.artlux?.peekProjectPick?.();
    if (!r) return;                                  // cancelled, or unreadable — main already logged
    setSource(r);
    setSel({});
  };

  const toggle = (u: ImportUnit) => {
    setSel((prev) => {
      if (u.kind === 'stateMachine') return { ...prev, stateMachine: !prev.stateMachine };
      const key = KIND_KEY[u.kind];
      const cur = prev[key] ?? [];
      return { ...prev, [key]: cur.includes(u.id!) ? cur.filter((x) => x !== u.id) : [...cur, u.id!] };
    });
  };

  const isOn = (u: ImportUnit): boolean => {
    // Ticking the whole graph implies every state in it, so the individual rows show as on rather
    // than leaving the operator wondering whether they also need to tick them.
    if (u.kind === 'stateMachine') return !!sel.stateMachine;
    if (u.kind === 'state' && sel.stateMachine) return true;
    const key = KIND_KEY[u.kind];
    return (sel[key] ?? []).includes(u.id!);
  };

  const commit = async () => {
    if (!plan) return;
    // MEDIA NEEDS SOMEWHERE TO LAND. An unsaved project has no folder, so the copy has nothing to
    // copy into — and referencing the source project's files instead would quietly make this show
    // depend on another project's disk. Say so and stop, rather than importing something half-real.
    if (plan.assetPaths.length && !projectPath) {
      toast.error('Save this project first',
        `${plan.assetPaths.length} media files need a project folder to be copied into.`);
      return;
    }
    setBusy(true);
    try {
      let patch = plan.patch;
      let entries: unknown[] = [];
      if (plan.assetPaths.length && projectPath) {
        const r = await window.artlux?.importAssetPaths?.(projectPath, plan.assetPaths);
        if (r) {
          patch = applyAssetRemap(patch, r.remap);
          entries = r.entries;
          if (r.missing.length) {
            toast.warn(`${r.missing.length} media files were missing`,
              'They are imported as references and will read as undecodable until relinked.');
          }
        }
      }
      const bits = [
        plan.patch.scenes.length && `${plan.patch.scenes.length} scenes`,
        plan.patch.states.length && `${plan.patch.states.length} states`,
        plan.patch.cueBanks.length && `${plan.patch.cueBanks.length} cue banks`,
      ].filter(Boolean).join(', ');
      onCommit(patch, entries, bits || 'nothing');
      toast.success('Imported', bits ? `${bits} from ${source?.path.split(/[\\/]/).pop()}` : undefined);
      onClose();
    } catch (e) {
      toast.error('Import failed', String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const p = plan?.patch;
  const counts = p ? [
    [p.scenes.length, 'scenes'], [p.states.length, 'states'], [p.transitions.length, 'transitions'],
    [p.cueBanks.length, 'cue banks'], [p.surfaces.length, 'surfaces'], [p.fixtures.length, 'fixtures'],
    [p.groups.length, 'groups'], [p.lightingPoses.length, 'poses'], [p.trackingZones.length, 'zones'],
  ].filter(([n]) => (n as number) > 0) as [number, string][] : [];

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 animate-overlay-in" onClick={() => !busy && onClose()}>
      <div style={positionerStyle}>
        <div
          ref={trapRef}
          role="dialog"
          aria-modal="true"
          aria-label="Import from another project"
          className="w-[760px] bg-surface-1 border border-line-2 rounded-lg shadow-e3 animate-modal-in overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-3 h-9 border-b border-line-1 select-none" {...handleProps}>
            <div className="text-xs font-medium text-fg-1">Import from Project</div>
            <button onClick={onClose} aria-label="Close" className="text-fg-3 hover:text-fg-1"><X size={14} /></button>
          </div>

          {/* Source ------------------------------------------------------------------------ */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-line-1">
            <Button size="sm" variant="tonal" onClick={pick}><FolderOpen size={12} /> Choose project…</Button>
            <div className="text-mini text-fg-3 truncate flex-1" title={source?.path}>
              {source ? source.path : 'No project chosen'}
            </div>
          </div>

          {!source ? (
            // Empty state names the next action rather than the absence.
            <div className="px-3 py-10 text-center text-xs text-fg-3">
              Choose a project to copy a show out of — its state machine, scenes, cue banks or poses.
              <div className="mt-1 text-mini text-fg-3">It is read only; nothing about it changes.</div>
            </div>
          ) : (
            <div className="flex" style={{ height: 380 }}>
              {/* Units --------------------------------------------------------------------- */}
              <div className="w-1/2 overflow-auto border-r border-line-1 py-1">
                {units.length === 0 && <div className="px-3 py-6 text-mini text-fg-3">This project has nothing importable.</div>}
                {KIND_ORDER.map((kind) => {
                  const group = units.filter((u) => u.kind === kind);
                  if (!group.length) return null;
                  return (
                    <div key={kind} className="mb-1">
                      <div className="px-3 py-1 text-mini uppercase tracking-wide text-fg-3">{KIND_LABEL[kind]}</div>
                      {group.map((u) => (
                        <label key={`${u.kind}:${u.id ?? ''}`} className="flex items-center gap-2 px-3 py-1 cursor-pointer hover:bg-surface-2">
                          <input type="checkbox" checked={isOn(u)} onChange={() => toggle(u)} className="accent-accent" />
                          <span className="text-xs text-fg-1 truncate flex-1">{u.name}</span>
                          <span className="text-mini text-fg-3 shrink-0">{u.detail}</span>
                        </label>
                      ))}
                    </div>
                  );
                })}
              </div>

              {/* Report -------------------------------------------------------------------- */}
              <div className="w-1/2 overflow-auto p-3 space-y-3">
                {!anySelected && <div className="text-mini text-fg-3">Tick something on the left to see what it brings with it.</div>}

                {plan && (
                  <>
                    <div>
                      <div className="text-mini uppercase tracking-wide text-fg-3 mb-1">This will add</div>
                      <div className="text-xs text-fg-1 leading-relaxed">
                        {counts.map(([n, label]) => `${n} ${label}`).join(' · ') || 'nothing'}
                      </div>
                      {plan.assetPaths.length > 0 && (
                        <div className="text-mini text-fg-3 mt-1">
                          {plan.assetPaths.length} media files copied into this project
                        </div>
                      )}
                    </div>

                    {plan.rig && (
                      // THE CORRESPONDENCE, SHOWN AS A COUNT PLUS THE LOSSES BY NAME. A ratio alone
                      // ("18 of 24") is a number an operator can nod at; the six names are what they
                      // can actually check against the rig in front of them.
                      <div>
                        <div className="text-mini uppercase tracking-wide text-fg-3 mb-1">Onto this rig</div>
                        {(() => {
                          const f = plan.rig.fixtures;
                          const s = plan.rig.surfaces;
                          const lost = [...f, ...s].filter((r) => !r.destId);
                          return (
                            <>
                              <div className="text-xs text-fg-1 leading-relaxed">
                                {f.filter((r) => r.destId).length} of {f.length} fixtures matched
                                {s.length > 0 && ` · ${s.filter((r) => r.destId).length} of ${s.length} surfaces`}
                              </div>
                              {lost.length > 0 && (
                                <div className="text-mini text-warn mt-1 leading-snug">
                                  No counterpart here: {lost.map((r) => r.srcName).join(', ')} — their looks are not imported.
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )}

                    {plan.warnings.length > 0 && (
                      <div>
                        <div className="text-mini uppercase tracking-wide text-fg-3 mb-1">
                          {plan.warnings.length} things to know
                        </div>
                        <ul className="space-y-1">
                          {plan.warnings.map((w, i) => (
                            <li key={i} className="flex gap-1.5 text-mini text-fg-2 leading-snug">
                              {w.kind === 'dropped'
                                ? <FileWarning size={11} className="shrink-0 mt-0.5 text-warn" />
                                : <Info size={11} className="shrink-0 mt-0.5 text-fg-3" />}
                              <span>{w.message}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {problems.length > 0 && (
                      // If this ever appears it is a defect in the importer, not operator error — the
                      // engine would accept the document in silence, so it is surfaced loudly here.
                      <div className="border border-danger/40 rounded-md p-2">
                        <div className="flex items-center gap-1.5 text-mini text-danger mb-1">
                          <AlertTriangle size={11} /> {problems.length} references would not resolve
                        </div>
                        <ul className="space-y-0.5">
                          {problems.slice(0, 6).map((pr, i) => (
                            <li key={i} className="text-mini text-fg-2">{pr.where} — missing {pr.missing}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* Footer ------------------------------------------------------------------------ */}
          <div className="flex items-center gap-2 px-3 h-11 border-t border-line-1">
            <span className="text-mini text-fg-3">Rig</span>
            <Segmented<RigStrategy>
              value={rig}
              onChange={setRig}
              options={[
                { value: 'append', label: 'Append source rig' },
                { value: 'map', label: 'Map onto this rig' },
              ]}
            />
            <span className="text-mini text-fg-3">
              {rig === 'append'
                ? 'Nothing already patched moves.'
                : 'No rig is added; looks bind to the fixtures already here.'}
            </span>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={commit} disabled={!plan || busy}>
              {busy ? 'Importing…' : 'Import'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
