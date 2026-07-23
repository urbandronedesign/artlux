import React, { useState } from 'react';
import { Plus, Trash2, Eye, EyeOff, Box, Lightbulb, Save, Check, MonitorPlay } from 'lucide-react';
import { PROGRAM_LAYER_ID } from '../../services/timeline';
import { modelScaleXYZ } from '../../../../shared/protocol';
import { useEditor, useEditorActions } from '../../state/EditorStore';

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

const NumRow: React.FC<{ label: string; value: number; step?: number; onChange: (v: number) => void }> = ({ label, value, step = 1, onChange }) => (
  <div className="flex items-center justify-between gap-2 text-mini">
    <span className="text-fg-2">{label}</span>
    <NumInput value={value} step={step} onChange={onChange} />
  </div>
);

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

const Toggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, checked, onChange }) => (
  <label className="flex items-center justify-between gap-2 text-mini cursor-pointer select-none">
    <span className="text-fg-2">{label}</span>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
  </label>
);

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
          <button onClick={(e) => { e.stopPropagation(); a.updateModel(m.id, { visible: !m.visible }); }} className="text-fg-3 hover:text-fg-1" title={m.visible ? 'Hide' : 'Show'}>
            {m.visible ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
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
      <button onClick={a.addPlane} title="Add screen plane" className="text-fg-2 hover:text-fg-1"><MonitorPlay size={14} /></button>
      <button onClick={a.addModel} title="Add GLB mesh" className="text-fg-2 hover:text-fg-1"><Plus size={14} /></button>
      <button
        onClick={a.saveScene}
        title="Save the project (includes the 3D scene)"
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-micro transition-colors ${sceneSaved ? 'bg-ok/20 text-ok' : 'bg-accent text-black hover:bg-accent-hover'}`}
      >
        {sceneSaved ? <Check size={12} /> : <Save size={12} />} {sceneSaved ? 'Saved' : 'Save'}
      </button>
    </>
  );
};

// ── Fixtures (read-only picker inside the 3D context) ───────────────────────────────────────
export const Scene3DFixturesPanel: React.FC = () => {
  const { fixtures, selectedFixtureId, selectedModelId } = useEditor();
  const a = useEditorActions();
  return (
    <div className="p-1 space-y-0.5">
      {fixtures.length === 0 && <div className="text-fg-3 italic px-2 py-1">No fixtures</div>}
      {fixtures.map((f) => (
        <div
          key={f.id} role="button" tabIndex={0} className={rowCls(!selectedModelId && selectedFixtureId === f.id)}
          onClick={() => a.selectFixture(f.id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); a.selectFixture(f.id); } }}
        >
          <Lightbulb size={12} className="shrink-0" />
          <span className="flex-1 truncate">{f.name}</span>
        </div>
      ))}
    </div>
  );
};

// ── Selected model transform ────────────────────────────────────────────────────────────────
export const ModelTransformPanel: React.FC = () => {
  const { scene3D, selectedModelId, timeline, modelNaturalSizes } = useEditor();
  const a = useEditorActions();
  const [fitMeters, setFitMeters] = useState(5);
  const m = (scene3D.models ?? []).find((x) => x.id === selectedModelId) ?? null;
  if (!m) return null;
  const [sx, sy, sz] = modelScaleXYZ(m);
  return (
    <>
      <div className="text-micro font-bold uppercase tracking-wider text-fg-3 truncate">{m.name}</div>
      {/* Timeline-layer texture: planes display it; meshes get it UV-mapped onto their GLB. This reads
          the BOUND timeline, not the global one — a model shows what the engine is PLAYING, which while
          authoring a scene is that scene's own document. */}
      <div className="flex items-center gap-1.5 text-mini">
        <span className="text-fg-2 shrink-0">Layer</span>
        <select
          value={m.layerId ?? ''}
          onChange={(e) => a.updateModel(m.id, { layerId: e.target.value || undefined })}
          className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none"
        >
          <option value="">{m.kind === 'plane' ? '— no layer —' : '— GLB materials —'}</option>
          <option value={PROGRAM_LAYER_ID}>★ Timeline (Program)</option>
          {timeline.layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button
          onClick={() => a.updateModel(m.id, { layerId: m.layerId === PROGRAM_LAYER_ID ? undefined : PROGRAM_LAYER_ID })}
          title="Show the whole timeline (Program composite) on this screen"
          className={`shrink-0 px-1.5 py-1 rounded text-micro border ${m.layerId === PROGRAM_LAYER_ID ? 'bg-accent text-black border-transparent' : 'bg-surface-2 border-line-1 text-fg-2 hover:text-fg-1'}`}
        >TL</button>
      </div>
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
            <button
              onClick={() => { const nat = modelNaturalSizes[m.id]; if (nat) { const s = fitMeters / nat; a.updateModel(m.id, { scaleXYZ: [s, s, s] }); } }}
              disabled={!modelNaturalSizes[m.id]}
              className="px-2 py-0.5 rounded-sm bg-accent text-black hover:bg-accent-hover num text-micro disabled:opacity-40"
            >Fit</button>
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
      <NumRow label="Light gain" value={scene3D.lightIntensity} step={0.1} onChange={(v) => a.sceneConfig({ lightIntensity: Math.max(0, v) })} />
      <NumRow label="Exposure" value={scene3D.exposure} step={0.05} onChange={(v) => a.sceneConfig({ exposure: Math.max(0.1, v) })} />
      <Toggle label="Ambient (env)" checked={scene3D.environment} onChange={(v) => a.sceneConfig({ environment: v })} />
      <Toggle label="Reflective floor" checked={scene3D.reflectiveFloor ?? false} onChange={(v) => a.sceneConfig({ reflectiveFloor: v })} />
      <Toggle label="Grid" checked={scene3D.gridVisible} onChange={(v) => a.sceneConfig({ gridVisible: v })} />
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
  return (
    <>
      <Toggle label="Tracking zones (LiDAR)" checked={scene3D.trackingViz ?? false} onChange={(v) => a.sceneConfig({ trackingViz: v })} />
      {scene3D.trackingViz && (
        <div className="pl-2 border-l border-line-1 space-y-2">
          <NumRow label="Smoothing" value={scene3D.trackingSmoothing ?? 0.5} step={0.05} onChange={(v) => a.sceneConfig({ trackingSmoothing: Math.max(0, Math.min(1, v)) })} />
          <NumRow label="Predict (ms)" value={scene3D.trackingPredictMs ?? 80} step={10} onChange={(v) => a.sceneConfig({ trackingPredictMs: Math.max(0, Math.min(300, v)) })} />
          <Toggle label="Show IDs" checked={scene3D.trackingLabels !== false} onChange={(v) => a.sceneConfig({ trackingLabels: v })} />
        </div>
      )}
      <Toggle label="Camera pose markers (MediaPipe)" checked={scene3D.mediapipeViz ?? false} onChange={(v) => a.sceneConfig({ mediapipeViz: v })} />
      <Toggle label="Augmenta field + objects" checked={scene3D.augmentaViz ?? false} onChange={(v) => a.sceneConfig({ augmentaViz: v })} />
      <Toggle label="Merge people (2 blobs → 1)" checked={scene3D.trackingMergePeople ?? false} onChange={(v) => a.sceneConfig({ trackingMergePeople: v })} />
      {scene3D.trackingMergePeople && (
        <div className="pl-2 border-l border-line-1 space-y-2">
          <NumRow label="Merge radius (m)" value={scene3D.trackingMergeRadius ?? 0.8} step={0.05} onChange={(v) => a.sceneConfig({ trackingMergeRadius: Math.max(0.05, Math.min(3, v)) })} />
        </div>
      )}
    </>
  );
};
