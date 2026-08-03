import React, { useState } from 'react';
import { Plus, Trash2, Eye, EyeOff, Box, Lightbulb, Save, Check, MonitorPlay, Radar } from 'lucide-react';
import { panelRegistry } from '../../host/registries';
import { PROGRAM_LAYER_ID } from '../../services/timeline';
import { modelScaleXYZ } from '../../../../shared/protocol';
import { useEditor, useEditorActions } from '../../state/EditorStore';
import { Tooltip } from '../../components/ui/Tooltip';
import { help } from '../../services/helpBus';
import { Button, NumberField } from '../../components/ui';
import * as layout from '../../services/fixtureLayout';
import { isLight } from '../../services/fixtureKind';
import { captureViewerViewProj } from '../../components/Simulator3D/viewerCamera';
import { DEFAULT_BIAS_M } from '../../components/Simulator3D/projectedMapping';

// The 3D venue workbench, as panels — Objects and Fixtures in the browser column, the selected
// model's transform and the scene lighting in the parameter column.
//
// These were `ScenePanel3D`, a 240px column floated inside the 3D viewport with a collapse rail of its
// own. It predated the shell: it had to float because there was nowhere to dock it. Now the `3d`
// context has real browser and parameter columns, so the floating column and its bespoke collapse
// chrome are gone — the shell's own section headers and panel toggles do that job.
//
// The numeric inputs below are BUFFERED (type freely, commit on Enter/blur) so a live controlled value
// can't reset the field mid-keystroke. Kept verbatim from ScenePanel3D.

const numCls = 'w-14 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-right text-fg-1 num text-mini focus:border-accent focus:outline-none';

// The menu action the LiDAR plugin's Trigger Zones panel declares. A STRING, deliberately: core owns
// no zone code and must not import the plugin — this is the same soft coupling the View menu uses, and
// the one place it appears in a parameter column (see SceneTrackingPanel).
const ZONE_EDITOR_ACTION = 'zone-editor';

const NumInput: React.FC<{ value: number; step?: number; title?: string; min?: number; className?: string; onChange: (v: number) => void }> =
({ value, step = 1, title, min, className, onChange }) => {
  const [txt, setTxt] = useState<string | null>(null);
  const commit = () => { if (txt === null) return; const n = parseFloat(txt); setTxt(null); if (!Number.isNaN(n)) onChange(min != null ? Math.max(min, n) : n); };
  return (
    <input
      type="number" step={step} title={title} value={txt ?? String(+value.toFixed(4))}
      onChange={(e) => setTxt(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); else if (e.key === 'Escape') setTxt(null); }}
      className={className ?? numCls}
    />
  );
};

// `helpId` opts the row into the rich help system: the whole row is the hover target (its <div> is a
// real host element, which is what Tooltip clones + refs), and help() spreads the hint props onto it.
const NumRow: React.FC<{ label: string; value: number; step?: number; helpId?: string; onChange: (v: number) => void }> = ({ label, value, step = 1, helpId, onChange }) => {
  const row = (
    <div className="flex items-center justify-between gap-2 text-mini" {...(helpId ? help(helpId) : {})}>
      <span className="text-fg-2">{label}</span>
      <NumInput value={value} step={step} onChange={onChange} />
    </div>
  );
  return helpId ? <Tooltip id={helpId}>{row}</Tooltip> : row;
};

const Vec3Row: React.FC<{ label: string; v: { x: number; y: number; z: number }; step?: number; min?: number; onChange: (v: { x: number; y: number; z: number }) => void }> =
({ label, v, step = 0.1, min, onChange }) => (
  <div className="flex items-center justify-between gap-1 text-mini">
    <span className="text-fg-2 w-8">{label}</span>
    {(['x', 'y', 'z'] as const).map((ax) => (
      <NumInput
        key={ax} value={v[ax]} step={step} title={ax.toUpperCase()} min={min}
        onChange={(n) => onChange({ ...v, [ax]: n })}
        className="w-12 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-right text-fg-1 num text-micro focus:border-accent focus:outline-none"
      />
    ))}
  </div>
);

// `helpId` (see NumRow) makes the whole <label> the hover target for the rich help tooltip.
const Toggle: React.FC<{ label: string; checked: boolean; helpId?: string; onChange: (v: boolean) => void }> = ({ label, checked, helpId, onChange }) => {
  const el = (
    <label className="flex items-center justify-between gap-2 text-mini cursor-pointer select-none" {...(helpId ? help(helpId) : {})}>
      <span className="text-fg-2">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
    </label>
  );
  return helpId ? <Tooltip id={helpId}>{el}</Tooltip> : el;
};

const rowCls = (active: boolean) =>
  `flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer text-mini group ${active ? 'bg-accent/15 text-accent' : 'text-fg-2 hover:bg-surface-3'}`;

// ── Objects ─────────────────────────────────────────────────────────────────────────────────
export const ModelsPanel: React.FC = () => {
  const { scene3D, selectedModelId } = useEditor();
  const a = useEditorActions();
  const models = scene3D.models ?? [];
  return (
    <div className="p-1 space-y-0.5">
      {models.length === 0 && <div className="text-fg-3 italic px-2 py-1">No objects — add a GLB or screen</div>}
      {models.map((m) => (
        <div
          key={m.id} role="button" tabIndex={0} className={rowCls(selectedModelId === m.id)}
          onClick={() => a.selectModel(m.id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); a.selectModel(m.id); } }}
        >
          {m.kind === 'plane' ? <MonitorPlay size={12} className="shrink-0" /> : <Box size={12} className="shrink-0" />}
          <span className="flex-1 truncate" title={m.path}>{m.name}</span>
          <Tooltip id="scene3d.model-visibility">
            <button onClick={(e) => { e.stopPropagation(); a.updateModel(m.id, { visible: !m.visible }); }} className="text-fg-3 hover:text-fg-1" title={m.visible ? 'Hide' : 'Show'} {...help('scene3d.model-visibility')}>
              {m.visible ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
          </Tooltip>
          <button onClick={(e) => { e.stopPropagation(); a.removeModel(m.id); }} className="text-fg-3 hover:text-danger opacity-0 group-hover:opacity-100" title="Remove"><Trash2 size={11} /></button>
        </div>
      ))}
    </div>
  );
};

// Add-object buttons plus the scene Save — Save lives here rather than on the action bar because it
// carries transient "Saved" feedback, which a static ContextAction label cannot show.
export const ModelsHeaderActions: React.FC = () => {
  const { sceneSaved } = useEditor();
  const a = useEditorActions();
  return (
    <>
      <Tooltip id="scene3d.add-plane">
        <button onClick={a.addPlane} title="Add screen plane" className="text-fg-2 hover:text-fg-1" {...help('scene3d.add-plane')}><MonitorPlay size={14} /></button>
      </Tooltip>
      <Tooltip id="scene3d.add-model">
        <button onClick={a.addModel} title="Add GLB mesh" className="text-fg-2 hover:text-fg-1" {...help('scene3d.add-model')}><Plus size={14} /></button>
      </Tooltip>
      <Tooltip id="scene3d.save-scene">
        <button
          onClick={a.saveScene}
          title="Save the project (includes the 3D scene)"
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-micro transition-colors ${sceneSaved ? 'bg-ok/20 text-ok' : 'bg-accent text-black hover:bg-accent-hover'}`}
          {...help('scene3d.save-scene')}
        >
          {sceneSaved ? <Check size={12} /> : <Save size={12} />} {sceneSaved ? 'Saved' : 'Save'}
        </button>
      </Tooltip>
    </>
  );
};

// ── Fixtures (read-only picker inside the 3D context) ───────────────────────────────────────
export const Scene3DFixturesPanel: React.FC = () => {
  const { fixtures, selectedFixtureId, selectedFixtureIds, selectedModelId } = useEditor();
  const a = useEditorActions();
  // Anchor for shift-range selection, in list order.
  const anchor = React.useRef<string | null>(null);

  // This list used to select ONE fixture per click and highlight only the primary — so in the very
  // context where a rig is laid out, a multi-selection could be neither built nor seen, and the
  // transform gizmo had nothing to act on. Ctrl/⌘ toggles, Shift takes a range, exactly as the
  // Mapping browser already does.
  const onClick = (id: string, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current) {
      const order = fixtures.map((f) => f.id);
      const from = order.indexOf(anchor.current);
      const to = order.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        a.selectFixtures(order.slice(lo, hi + 1));
        return;
      }
    }
    anchor.current = id;
    a.selectFixture(id, e.ctrlKey || e.metaKey);
  };

  return (
    <div className="p-1 space-y-0.5">
      {fixtures.length === 0 && <div className="text-fg-3 italic px-2 py-1">No fixtures</div>}
      {fixtures.map((f) => (
        <div
          key={f.id} role="button" tabIndex={0}
          // Highlight the whole selection, not just the primary — otherwise ten selected fixtures
          // look like one and the Arrange panel appears to be talking about nothing.
          className={rowCls(!selectedModelId && (selectedFixtureIds.includes(f.id) || selectedFixtureId === f.id))}
          onClick={(e) => onClick(f.id, e)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); anchor.current = f.id; a.selectFixture(f.id, false); } }}
        >
          {/* By KIND, like the Mapping list. This panel predates the split and showed a lightbulb
              for LED tape too, which reads as "everything here is a light". */}
          {isLight(f)
            ? <Lightbulb size={12} className="shrink-0" />
            : <Box size={12} className="shrink-0" />}
          <span className="flex-1 truncate">{f.name}</span>
        </div>
      ))}
    </div>
  );
};

// ── Selected model transform ────────────────────────────────────────────────────────────────
// ── Fixture ▸ Arrange (multi-selection) ─────────────────────────────────────────────────────
// Rig-building for a SELECTION: align, even out, lay on a line or an arc, fan the aim. Hidden for a
// single fixture, because every one of these is meaningless with nothing to arrange relative to.
//
// Each action commits the whole selection at once, so it is ONE undo step — see
// services/fixtureLayout.ts for the maths and for why selection order is preserved.
export const FixtureArrangePanel: React.FC = () => {
  const { fixtures, selectedFixtureIds } = useEditor();
  const a = useEditorActions();
  const [spacing, setSpacing] = useState(1);
  const [radius, setRadius] = useState(4);
  const [sweep, setSweep] = useState(180);
  const [fanAmount, setFanAmount] = useState(45);

  // Selection ORDER, not list order — a spread runs along the order the operator picked.
  const selection = selectedFixtureIds
    .map((id) => fixtures.find((f) => f.id === id))
    .filter((f): f is NonNullable<typeof f> => !!f);

  if (selection.length < 2) {
    return <div className="text-mini text-fg-3">Select two or more fixtures to arrange them.</div>;
  }

  // RECORD FIRST, THEN COMMIT. The gizmo latches history on its first drag movement; these buttons
  // have no drag to latch on, so without this an arrange is invisible to undo — you lay twelve heads
  // on an arc, dislike it, press Ctrl+Z, and either nothing happens or the PREVIOUS edit disappears
  // instead. Verified against the running app: the group moved correctly and undo did nothing.
  const apply = (updates: layout.LayoutUpdate[]) => {
    if (!updates.length) return;
    a.recordHistory();
    a.commitFixture3D(updates);
  };
  const Row: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="flex items-center gap-1">{children}</div>
  );

  return (
    <>
      <div className="text-mini text-fg-3">{selection.length} fixtures, in selection order</div>

      <div className="text-mini text-fg-2 mt-1">Align</div>
      <Row>
        {(['x', 'y', 'z'] as const).map((ax) => (
          <Button key={ax} size="sm" variant="ghost" className="flex-1"
            onClick={() => apply(layout.align(selection, ax))}>{ax.toUpperCase()}</Button>
        ))}
      </Row>

      <div className="text-mini text-fg-2 mt-1">Distribute evenly</div>
      <Row>
        {(['x', 'y', 'z'] as const).map((ax) => (
          <Button key={ax} size="sm" variant="ghost" className="flex-1"
            onClick={() => apply(layout.distribute(selection, ax))}>{ax.toUpperCase()}</Button>
        ))}
      </Row>

      <div className="text-mini text-fg-2 mt-1">Lay on a line</div>
      <NumberField label="Spacing m" value={spacing} min={0.01} step={0.1} onChange={setSpacing} />
      <Row>
        {(['x', 'y', 'z'] as const).map((ax) => (
          <Button key={ax} size="sm" variant="ghost" className="flex-1"
            onClick={() => apply(layout.line(selection, ax, spacing))}>{ax.toUpperCase()}</Button>
        ))}
      </Row>

      <div className="text-mini text-fg-2 mt-1">Lay on an arc</div>
      <NumberField label="Radius m" value={radius} min={0.01} step={0.25} onChange={setRadius} />
      <NumberField label="Sweep °" value={sweep} min={1} max={360} step={5} onChange={setSweep} />
      <Row>
        <Button size="sm" variant="ghost" className="flex-1"
          onClick={() => apply(layout.arc(selection, radius, sweep, true))}>Arc + aim out</Button>
        <Button size="sm" variant="ghost" className="flex-1"
          onClick={() => apply(layout.arc(selection, radius, sweep, false))}>Arc only</Button>
      </Row>

      <div className="text-mini text-fg-2 mt-1">Fan the aim</div>
      <NumberField label="Spread °" value={fanAmount} min={-360} max={360} step={5} onChange={setFanAmount} />
      <Row>
        <Button size="sm" variant="ghost" className="flex-1"
          onClick={() => apply(layout.fan(selection, 'yaw', fanAmount))}>Yaw</Button>
        <Button size="sm" variant="ghost" className="flex-1"
          onClick={() => apply(layout.fan(selection, 'pitch', fanAmount))}>Pitch</Button>
        <Button size="sm" variant="ghost" className="flex-1"
          onClick={() => apply(layout.fan(selection, 'roll', fanAmount))}>Roll</Button>
      </Row>
    </>
  );
};

export const ModelTransformPanel: React.FC = () => {
  const { scene3D, selectedModelId, timeline, modelNaturalSizes, surfaces, projectorOutputs } = useEditor();
  const a = useEditorActions();
  const [fitMeters, setFitMeters] = useState(5);
  const m = (scene3D.models ?? []).find((x) => x.id === selectedModelId) ?? null;
  // Only a SOLVED projector can project — an output with no pose has no matrix to offer, and listing
  // it would read as "this does nothing".
  const projectors = (projectorOutputs ?? [])
    .filter((o) => o.calibration?.poseRms != null)
    .map((o) => ({ surfaceId: o.surfaceId, name: surfaces.find((s) => s.id === o.surfaceId)?.name ?? o.surfaceId }));
  if (!m) return null;
  const [sx, sy, sz] = modelScaleXYZ(m);
  return (
    <>
      <div className="text-micro font-bold uppercase tracking-wider text-fg-3 truncate">{m.name}</div>
      {/* Timeline-layer texture: planes display it; meshes get it UV-mapped onto their GLB. This reads
          the BOUND timeline, not the global one — a model shows what the engine is PLAYING, which while
          authoring a scene is that scene's own document. */}
      {/* One picker, two binding kinds — a timeline layer OR a whole surface. A surface is what the
          operator actually routes to a projector, so binding the venue mesh to one is how "the show
          plays on the object" is expressed; it also covers every source type in a single path
          (video / image / camera / NDI / Spout / effect / a layer / the program composite). The two
          ids are mutually exclusive, so setting either clears the other. */}
      <div className="flex items-center gap-1.5 text-mini">
        <span className="text-fg-2 shrink-0">Content</span>
        <Tooltip id="scene3d.model-layer">
          <select
            value={m.surfaceId ? `s:${m.surfaceId}` : m.layerId ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              if (v.startsWith('s:')) a.updateModel(m.id, { surfaceId: v.slice(2), layerId: undefined });
              else a.updateModel(m.id, { layerId: v || undefined, surfaceId: undefined });
            }}
            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none"
            {...help('scene3d.model-layer')}
          >
            <option value="">{m.kind === 'plane' ? '— no layer —' : '— GLB materials —'}</option>
            <option value={PROGRAM_LAYER_ID}>★ Timeline (Program)</option>
            {surfaces.length > 0 && (
              <optgroup label="Surfaces">
                {surfaces.map((s) => <option key={s.id} value={`s:${s.id}`}>{s.name}</option>)}
              </optgroup>
            )}
            <optgroup label="Timeline layers">
              {timeline.layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </optgroup>
          </select>
        </Tooltip>
        <Tooltip id="scene3d.model-program">
          <button
            // CLEARS surfaceId — the two ids are mutually exclusive (see the note above the select),
            // and this button used to set `layerId` while leaving `surfaceId` behind. That left the two
            // halves disagreeing in OPPOSITE directions: the select's value prefers `surfaceId`, so the
            // panel went on naming the surface, while ModelObject binds
            // `useSurfaceTexture(model.layerId ? undefined : model.surfaceId)` — layerId wins — so the
            // surface hook was inert and the mesh showed the program (or `#161616` for "no texture").
            // Picking a surface from the select afterwards then appeared to do nothing at all, because
            // the stale layerId still outranked it. The UI claimed one binding and the engine served
            // another; toggling TL off was the only way out, and nothing said so.
            onClick={() => a.updateModel(m.id, m.layerId === PROGRAM_LAYER_ID
              ? { layerId: undefined }
              : { layerId: PROGRAM_LAYER_ID, surfaceId: undefined })}
            title="Show the whole timeline (Program composite) on this screen"
            className={`shrink-0 px-1.5 py-1 rounded text-micro border ${m.layerId === PROGRAM_LAYER_ID ? 'bg-accent text-black border-transparent' : 'bg-surface-2 border-line-1 text-fg-2 hover:text-fg-1'}`}
            {...help('scene3d.model-program')}
          >TL</button>
        </Tooltip>
      </div>
      {/* UV source for the layer texture — meshes only (planes own their full-frame UVs). 'Projected'
          bakes UVs through the CURRENT viewer camera (viewerCamera.ts), so it needs the 3D viewport
          mounted; picking it with no bake yet captures one immediately. The baked matrix survives a
          switch back to Mesh UVs, so present-vs-projected is a two-click A/B. */}
      {m.kind !== 'plane' && (m.layerId || m.surfaceId) && (
        <div className="flex items-center gap-1.5 text-mini">
          <span className="text-fg-2 shrink-0">UVs</span>
          <Tooltip id="scene3d.model-uvs">
            <select
              value={m.uvProjFrom ? `p:${m.uvProjFrom}` : m.uvMode === 'projected' ? 'projected' : 'authored'}
              onChange={(e) => {
                const v = e.target.value;
                if (v.startsWith('p:')) {
                  // LIVE from a real projector: store only the SOURCE. The matrix is derived on every
                  // publish (resolveProjectedScene), so re-solving that projector or moving the mesh
                  // re-projects instead of leaving a stale bake behind.
                  a.updateModel(m.id, { uvMode: 'projected', uvProjFrom: v.slice(2) });
                } else if (v === 'projected') {
                  // Keep an existing bake rather than silently re-capturing from wherever the camera
                  // happens to be right now — the two-click A/B against Mesh UVs depends on the
                  // matrix surviving the round trip.
                  if (m.uvProjView?.length === 16) {
                    a.updateModel(m.id, { uvMode: 'projected', uvProjFrom: undefined });
                  } else {
                    const cap = captureViewerViewProj();
                    if (cap) a.updateModel(m.id, { uvMode: 'projected', uvProjView: cap.view, uvProjEye: cap.eye, uvProjFrom: undefined });
                  }
                } else {
                  a.updateModel(m.id, { uvMode: undefined, uvProjFrom: undefined });
                }
              }}
              className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none"
              {...help('scene3d.model-uvs')}
            >
              <option value="authored">Mesh UVs</option>
              <option value="projected">Projected from view</option>
              {projectors.length > 0 && (
                <optgroup label="Projected from a projector">
                  {projectors.map((p) => <option key={p.surfaceId} value={`p:${p.surfaceId}`}>{p.name}</option>)}
                </optgroup>
              )}
            </select>
          </Tooltip>
          <Tooltip id="scene3d.model-uv-bake">
            <button
              // Captures the eye as well as the matrix: the back-face test and the occlusion bias
              // both need to know where the projector IS, and a bake used to store only the matrix.
              onClick={() => { const cap = captureViewerViewProj(); if (cap) a.updateModel(m.id, { uvMode: 'projected', uvProjView: cap.view, uvProjEye: cap.eye, uvProjFrom: undefined }); }}
              title="Freeze projected UVs from the current 3D viewpoint"
              className="shrink-0 px-1.5 py-1 rounded text-micro border bg-surface-2 border-line-1 text-fg-2 hover:text-fg-1"
              {...help('scene3d.model-uv-bake')}
            >From view</button>
          </Tooltip>
        </div>
      )}
      {/* Footprint + occlusion controls — only meaningful while something is being projected. Soft
          edge fades the content out at the edge of the projector's frustum so two projectors covering
          one object cross-fade instead of meeting at a hard cookie edge; cull drops faces turned away
          from it; Occlude is the general case — it stops content reaching geometry that something
          else is standing in front of, which cull cannot answer. */}
      {m.kind !== 'plane' && (m.layerId || m.surfaceId) && m.uvMode === 'projected' && (
        <>
        <div className="flex items-center gap-1.5 text-mini">
          <span className="text-fg-2 shrink-0">Edge</span>
          <Tooltip id="scene3d.model-uv-soft">
            <input
              type="number" min={0} max={0.5} step={0.02}
              value={m.uvProjSoft ?? 0}
              onChange={(e) => a.updateModel(m.id, { uvProjSoft: Math.max(0, Math.min(0.5, Number(e.target.value) || 0)) })}
              className="w-16 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 num text-micro focus:border-accent focus:outline-none"
              {...help('scene3d.model-uv-soft')}
            />
          </Tooltip>
          <Tooltip id="scene3d.model-uv-cull">
            <label className="flex items-center gap-1.5 cursor-pointer text-fg-2" {...help('scene3d.model-uv-cull')}>
              <input
                type="checkbox"
                checked={!!m.uvProjCull}
                onChange={(e) => a.updateModel(m.id, { uvProjCull: e.target.checked || undefined })}
                className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0"
              />
              Cull back faces
            </label>
          </Tooltip>
        </div>
        <div className="flex items-center gap-1.5 text-mini">
          <Tooltip id="scene3d.model-uv-occlude">
            <label className="flex items-center gap-1.5 cursor-pointer text-fg-2" {...help('scene3d.model-uv-occlude')}>
              <input
                type="checkbox"
                // ABSENCE MEANS ON — see SceneModel.uvProjOccludeOff for why the persisted field is
                // named for the OFF polarity. `|| undefined` keeps a default-on model's record clean.
                checked={!m.uvProjOccludeOff}
                onChange={(e) => a.updateModel(m.id, { uvProjOccludeOff: !e.target.checked || undefined })}
                className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0"
              />
              Occlude
            </label>
          </Tooltip>
          <span className="text-fg-2 shrink-0">Bias</span>
          <Tooltip id="scene3d.model-uv-bias">
            <input
              type="number" min={0} max={1} step={0.01}
              value={m.uvProjBias ?? DEFAULT_BIAS_M}
              onChange={(e) => a.updateModel(m.id, { uvProjBias: Math.max(0, Math.min(1, Number(e.target.value) || 0)) })}
              disabled={!!m.uvProjOccludeOff}
              className="w-16 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 num text-micro focus:border-accent focus:outline-none disabled:opacity-40"
              {...help('scene3d.model-uv-bias')}
            />
          </Tooltip>
          <span className="text-fg-3 shrink-0">m</span>
        </div>
        </>
      )}
      <Vec3Row
        label="Scl" v={{ x: sx, y: sy, z: sz }} step={0.1} min={0.0001}
        onChange={(s) => a.updateModel(m.id, { scaleXYZ: [Math.max(0.0001, s.x), Math.max(0.0001, s.y), Math.max(0.0001, s.z)] })}
      />
      {m.kind !== 'plane' && (
        <>
          <div className="flex gap-1.5">
            {[1, 10, 100, 1000].map((v) => (
              <button key={v} onClick={() => a.updateModel(m.id, { scaleXYZ: [v, v, v] })} className="flex-1 px-1 py-0.5 rounded-sm bg-surface-2 border border-line-1 text-fg-2 hover:text-fg-1 num text-micro">×{v}</button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 text-mini">
            <span className="text-fg-2 shrink-0">Fit longest</span>
            <input
              type="number" min={0.01} step={0.5} value={fitMeters}
              onChange={(e) => { const v = parseFloat(e.target.value); if (v > 0) setFitMeters(v); }}
              className={numCls}
            />
            <span className="text-fg-3">m</span>
            <Tooltip id="scene3d.model-fit">
              <button
                onClick={() => { const nat = modelNaturalSizes[m.id]; if (nat) { const s = fitMeters / nat; a.updateModel(m.id, { scaleXYZ: [s, s, s] }); } }}
                disabled={!modelNaturalSizes[m.id]}
                className="px-2 py-0.5 rounded-sm bg-accent text-black hover:bg-accent-hover num text-micro disabled:opacity-40"
                {...help('scene3d.model-fit')}
              >Fit</button>
            </Tooltip>
          </div>
        </>
      )}
      <Vec3Row label="Pos" v={m.position} onChange={(pos) => a.updateModel(m.id, { position: pos })} step={0.1} />
      <Vec3Row label="Rot°" v={m.rotation} onChange={(r) => a.updateModel(m.id, { rotation: r })} step={5} />
    </>
  );
};

// ── Lighting ────────────────────────────────────────────────────────────────────────────────
export const SceneLightingPanel: React.FC = () => {
  const { scene3D } = useEditor();
  const a = useEditorActions();
  return (
    <>
      <NumRow label="Light gain" value={scene3D.lightIntensity} step={0.1} helpId="scene3d.light-gain" onChange={(v) => a.sceneConfig({ lightIntensity: Math.max(0, v) })} />
      {/* Haze is what makes a beam visible at all. Turning it to 0 shows the room as it will look
          WITHOUT atmosphere — pools of light on surfaces and no beams in the air — which is the
          honest preview for a venue that is not hazing. */}
      <NumRow label="Haze" value={scene3D.hazeDensity ?? 0.35} step={0.05} helpId="scene3d.haze"
        onChange={(v) => a.sceneConfig({ hazeDensity: Math.max(0, Math.min(1, v)) })} />
      <Toggle label="Ambient (env)" checked={scene3D.environment} helpId="scene3d.ambient-env" onChange={(v) => a.sceneConfig({ environment: v })} />
      <Toggle label="Reflective floor" checked={scene3D.reflectiveFloor ?? false} helpId="scene3d.reflective-floor" onChange={(v) => a.sceneConfig({ reflectiveFloor: v })} />
      <Toggle label="Glow (bloom)" checked={scene3D.glow === true} helpId="scene3d.glow" onChange={(v) => a.sceneConfig({ glow: v || undefined })} />
      <Toggle label="Grid" checked={scene3D.gridVisible} helpId="scene3d.grid" onChange={(v) => a.sceneConfig({ gridVisible: v })} />
    </>
  );
};

// ── Tracking (the scene-viz overlays) ───────────────────────────────────────────────────────
// Its own section rather than a tail on Lighting: these are three separate tracking SOURCES, each
// with sub-options, and they had grown to outweigh the lighting controls they were tacked onto.
//
// Every flag here lives on `Scene3D` (core persisted state) and gates a PLUGIN's scene-viz
// contribution — core owns the flag, the plugin owns what it draws. That split is why a toggle can
// stay in core while nothing here imports lidar-tracking, mediapipe or augmenta.
export const SceneTrackingPanel: React.FC = () => {
  const { scene3D } = useEditor();
  const a = useEditorActions();
  // THE WAY TO THE AUTHORING SURFACE, from the place an operator is already standing when they think
  // about zones. Everything else in this section VIEWS or TUNES them; the rectangles themselves are
  // drawn in a dock tab, and this column is where people came looking for it.
  //
  // Gated on a panel actually declaring that action, so with the tracking plugin disabled the button is
  // absent rather than dead — core names a plugin's action id here and nothing else about it.
  const hasZoneEditor = panelRegistry.all().some((p) => p.menuAction === ZONE_EDITOR_ACTION);
  return (
    <>
      {hasZoneEditor && (
        <Button size="sm" variant="ghost" className="w-full" onClick={() => a.menuAction(ZONE_EDITOR_ACTION)}>
          <Radar size={12} /> Draw trigger zones…
        </Button>
      )}
      <Toggle label="Tracking zones (LiDAR)" checked={scene3D.trackingViz ?? false} helpId="scene3d.tracking-viz" onChange={(v) => a.sceneConfig({ trackingViz: v })} />
      {scene3D.trackingViz && (
        <div className="pl-2 border-l border-line-1 space-y-2">
          <NumRow label="Smoothing" value={scene3D.trackingSmoothing ?? 0.5} step={0.05} helpId="scene3d.tracking-smoothing" onChange={(v) => a.sceneConfig({ trackingSmoothing: Math.max(0, Math.min(1, v)) })} />
          <NumRow label="Predict (ms)" value={scene3D.trackingPredictMs ?? 80} step={10} helpId="scene3d.tracking-predict" onChange={(v) => a.sceneConfig({ trackingPredictMs: Math.max(0, Math.min(300, v)) })} />
          <Toggle label="Show IDs" checked={scene3D.trackingLabels !== false} helpId="scene3d.tracking-labels" onChange={(v) => a.sceneConfig({ trackingLabels: v })} />
          {/* THE ON-SITE ZONE DWELL. The venue-wide default every trigger zone follows — the value you
              reach for when arrivals feel laggy or a standing visitor drops out, because the real room
              flickers differently from the recording it was tuned against. A zone can still override it
              in the Trigger Zones panel; this moves all the rest at once. See docs/TRACKING_SYNC.md. */}
          <NumRow label="Zone enter dwell (s)" value={scene3D.trackingZoneEnterSec ?? 0.2} step={0.05} helpId="scene3d.zone-enter-dwell" onChange={(v) => a.sceneConfig({ trackingZoneEnterSec: Math.max(0, Math.min(10, v)) })} />
          <NumRow label="Zone exit dwell (s)" value={scene3D.trackingZoneExitSec ?? 0.5} step={0.05} helpId="scene3d.zone-exit-dwell" onChange={(v) => a.sceneConfig({ trackingZoneExitSec: Math.max(0, Math.min(10, v)) })} />
        </div>
      )}
      <Toggle label="Camera pose markers (MediaPipe)" checked={scene3D.mediapipeViz ?? false} helpId="scene3d.mediapipe-viz" onChange={(v) => a.sceneConfig({ mediapipeViz: v })} />
      <Toggle label="Augmenta field + objects" checked={scene3D.augmentaViz ?? false} helpId="scene3d.augmenta-viz" onChange={(v) => a.sceneConfig({ augmentaViz: v })} />
      <Toggle label="Merge people (2 blobs → 1)" checked={scene3D.trackingMergePeople ?? false} helpId="scene3d.merge-people" onChange={(v) => a.sceneConfig({ trackingMergePeople: v })} />
      {scene3D.trackingMergePeople && (
        <div className="pl-2 border-l border-line-1 space-y-2">
          <NumRow label="Merge radius (m)" value={scene3D.trackingMergeRadius ?? 0.8} step={0.05} helpId="scene3d.merge-radius" onChange={(v) => a.sceneConfig({ trackingMergeRadius: Math.max(0.05, Math.min(3, v)) })} />
        </div>
      )}
    </>
  );
};
