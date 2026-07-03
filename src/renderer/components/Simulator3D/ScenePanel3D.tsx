import React, { useState } from 'react';
import { Fixture, Timeline } from '../../types';
import { PROGRAM_LAYER_ID } from '../../services/timeline';
import { Scene3D, SceneModel, modelScaleXYZ } from '../../../../shared/protocol';
import { Plus, Trash2, Eye, EyeOff, Box, Lightbulb, Save, Check, MonitorPlay, ChevronDown, ChevronUp } from 'lucide-react';

// The 3D scene outliner — OBJECTS / FIXTURES / selected-model transform / LIGHTING, plus a Save
// button. Floats over the embedded Simulator3D in the main window's split view. Purely presentational:
// every edit is delegated to the parent (App owns scene3D), so there is no MessagePort bridge.

interface ScenePanel3DProps {
  scene3D: Scene3D;
  fixtures: Fixture[];
  selectedModelId: string | null;
  selectedFixtureId: string | null;
  timeline: Timeline;
  naturalSizes: Record<string, number>;
  saved: boolean;
  onSelectModel: (id: string | null) => void;
  onSelectFixture: (id: string | null) => void;
  onAddModel: () => void;
  onAddPlane: () => void;
  onRemoveModel: (id: string) => void;
  onUpdateModel: (id: string, patch: Partial<SceneModel>) => void;
  onSceneConfig: (patch: Partial<Scene3D>) => void;
  onSave: () => void;
}

const ScenePanel3DBase: React.FC<ScenePanel3DProps> = ({
  scene3D, fixtures, selectedModelId, selectedFixtureId, timeline, naturalSizes, saved,
  onSelectModel, onSelectFixture, onAddModel, onAddPlane, onRemoveModel, onUpdateModel, onSceneConfig, onSave,
}) => {
  const [fitMeters, setFitMeters] = useState(5);
  const [collapsed, setCollapsed] = useState(false);

  const models = scene3D.models ?? [];
  const selModel = models.find(m => m.id === selectedModelId) || null;

  const rowCls = (active: boolean) => `flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer text-mini group ${active ? 'bg-accent/15 text-accent' : 'text-fg-2 hover:bg-surface-3'}`;

  return (
    <div
      className="absolute top-2 right-2 z-10 w-60 bg-surface-1/95 backdrop-blur-sm border border-line-1 rounded-md text-xs flex flex-col max-h-[calc(100%-1rem)]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-3 h-9 border-b border-line-1">
        <button onClick={() => setCollapsed(c => !c)} title={collapsed ? 'Expand' : 'Collapse'} className="flex items-center gap-1.5 text-mini font-bold text-fg-1 hover:text-accent">
          {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />} 3D Scene
        </button>
        <button
          onClick={onSave}
          title="Save the project (includes the 3D scene)"
          className={`flex items-center gap-1.5 px-2 py-1 rounded-sm text-mini transition-colors ${saved ? 'bg-ok/20 text-ok' : 'bg-accent text-black hover:bg-accent-hover'}`}
        >
          {saved ? <Check size={13} /> : <Save size={13} />} {saved ? 'Saved' : 'Save'}
        </button>
      </div>

      {!collapsed && (
        <div className="flex flex-col min-h-0 overflow-y-auto">
          <div className="flex items-center justify-between px-3 h-8 border-b border-line-1">
            <span className="text-micro font-bold uppercase tracking-wider text-fg-3 flex items-center gap-1.5"><Box size={12} /> Objects</span>
            <div className="flex items-center gap-2">
              <button onClick={onAddPlane} title="Add screen plane" className="text-fg-2 hover:text-fg-1"><MonitorPlay size={14} /></button>
              <button onClick={onAddModel} title="Add GLB mesh" className="text-fg-2 hover:text-fg-1"><Plus size={14} /></button>
            </div>
          </div>
          <div className="p-1 space-y-0.5 max-h-40 overflow-y-auto">
            {models.length === 0 && <div className="text-fg-3 italic px-2 py-1">No objects — add a GLB or screen</div>}
            {models.map(m => (
              <div key={m.id} role="button" tabIndex={0} className={rowCls(selectedModelId === m.id)}
                onClick={() => onSelectModel(m.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectModel(m.id); } }}>
                {m.kind === 'plane' ? <MonitorPlay size={12} className="shrink-0" /> : <Box size={12} className="shrink-0" />}
                <span className="flex-1 truncate" title={m.path}>{m.name}</span>
                <button onClick={(e) => { e.stopPropagation(); onUpdateModel(m.id, { visible: !m.visible }); }} className="text-fg-3 hover:text-fg-1" title={m.visible ? 'Hide' : 'Show'}>
                  {m.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
                <button onClick={(e) => { e.stopPropagation(); onRemoveModel(m.id); }} className="text-fg-3 hover:text-danger opacity-0 group-hover:opacity-100" title="Remove"><Trash2 size={11} /></button>
              </div>
            ))}
          </div>

          <div className="px-3 h-8 flex items-center border-y border-line-1">
            <span className="text-micro font-bold uppercase tracking-wider text-fg-3 flex items-center gap-1.5"><Lightbulb size={12} /> Fixtures</span>
          </div>
          <div className="p-1 space-y-0.5 max-h-40 overflow-y-auto">
            {fixtures.length === 0 && <div className="text-fg-3 italic px-2 py-1">No fixtures</div>}
            {fixtures.map(f => (
              <div key={f.id} role="button" tabIndex={0} className={rowCls(!selectedModelId && selectedFixtureId === f.id)}
                onClick={() => onSelectFixture(f.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectFixture(f.id); } }}>
                <Lightbulb size={12} className="shrink-0" />
                <span className="flex-1 truncate">{f.name}</span>
              </div>
            ))}
          </div>

          {/* Selected model transform */}
          {selModel && (
            <div className="border-t border-line-1 p-2.5 space-y-2">
              <div className="text-micro font-bold uppercase tracking-wider text-fg-3 truncate">{selModel.name}</div>
              {/* Timeline-layer texture: planes display it; meshes get it UV-mapped onto their GLB. */}
              <div className="flex items-center gap-1.5 text-mini">
                <span className="text-fg-2 shrink-0">Layer</span>
                <select value={selModel.layerId ?? ''} onChange={(e) => onUpdateModel(selModel.id, { layerId: e.target.value || undefined })}
                  className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none">
                  <option value="">{selModel.kind === 'plane' ? '— no layer —' : '— GLB materials —'}</option>
                  <option value={PROGRAM_LAYER_ID}>★ Timeline (Program)</option>
                  {timeline.layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <button
                  onClick={() => onUpdateModel(selModel.id, { layerId: selModel.layerId === PROGRAM_LAYER_ID ? undefined : PROGRAM_LAYER_ID })}
                  title="Show the whole timeline (Program composite) on this screen"
                  className={`shrink-0 px-1.5 py-1 rounded text-micro border ${selModel.layerId === PROGRAM_LAYER_ID ? 'bg-accent text-black border-transparent' : 'bg-surface-2 border-line-1 text-fg-2 hover:text-fg-1'}`}
                >TL</button>
              </div>
              <Vec3Row label="Scl" v={(() => { const [x, y, z] = modelScaleXYZ(selModel); return { x, y, z }; })()} step={0.1} min={0.0001}
                onChange={(s) => onUpdateModel(selModel.id, { scaleXYZ: [Math.max(0.0001, s.x), Math.max(0.0001, s.y), Math.max(0.0001, s.z)] })} />
              {selModel.kind !== 'plane' && (
                <>
                  <div className="flex gap-1.5">
                    {[1, 10, 100, 1000].map(v => (
                      <button key={v} onClick={() => onUpdateModel(selModel.id, { scaleXYZ: [v, v, v] })} className="flex-1 px-1 py-0.5 rounded-sm bg-surface-2 border border-line-1 text-fg-2 hover:text-fg-1 num text-micro">×{v}</button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 text-mini">
                    <span className="text-fg-2 shrink-0">Fit longest</span>
                    <input type="number" min={0.01} step={0.5} value={fitMeters} onChange={(e) => { const v = parseFloat(e.target.value); if (v > 0) setFitMeters(v); }} className={numCls} />
                    <span className="text-fg-3">m</span>
                    <button
                      onClick={() => { const nat = naturalSizes[selModel.id]; if (nat) { const s = fitMeters / nat; onUpdateModel(selModel.id, { scaleXYZ: [s, s, s] }); } }}
                      disabled={!naturalSizes[selModel.id]}
                      className="px-2 py-0.5 rounded-sm bg-accent text-black hover:bg-accent-hover num text-micro disabled:opacity-40"
                    >Fit</button>
                  </div>
                </>
              )}
              <Vec3Row label="Pos" v={selModel.position} onChange={(p) => onUpdateModel(selModel.id, { position: p })} step={0.1} />
              <Vec3Row label="Rot°" v={selModel.rotation} onChange={(r) => onUpdateModel(selModel.id, { rotation: r })} step={5} />
            </div>
          )}

          {/* Lighting / view */}
          <div className="border-t border-line-1 p-2.5 space-y-2">
            <div className="text-micro font-bold uppercase tracking-wider text-fg-3">Lighting</div>
            <NumRow label="Light gain" value={scene3D.lightIntensity} step={0.1} onChange={(v) => onSceneConfig({ lightIntensity: Math.max(0, v) })} />
            <NumRow label="Exposure" value={scene3D.exposure} step={0.05} onChange={(v) => onSceneConfig({ exposure: Math.max(0.1, v) })} />
            <Toggle label="Ambient (env)" checked={scene3D.environment} onChange={(v) => onSceneConfig({ environment: v })} />
            <Toggle label="Reflective floor" checked={scene3D.reflectiveFloor ?? false} onChange={(v) => onSceneConfig({ reflectiveFloor: v })} />
            <Toggle label="Grid" checked={scene3D.gridVisible} onChange={(v) => onSceneConfig({ gridVisible: v })} />
            <Toggle label="Tracking zones (LiDAR)" checked={scene3D.trackingViz ?? false} onChange={(v) => onSceneConfig({ trackingViz: v })} />
            {scene3D.trackingViz && (
              <div className="pl-2 border-l border-line-1 space-y-2">
                <NumRow label="Smoothing" value={scene3D.trackingSmoothing ?? 0.5} step={0.05} onChange={(v) => onSceneConfig({ trackingSmoothing: Math.max(0, Math.min(1, v)) })} />
                <NumRow label="Predict (ms)" value={scene3D.trackingPredictMs ?? 80} step={10} onChange={(v) => onSceneConfig({ trackingPredictMs: Math.max(0, Math.min(300, v)) })} />
                <Toggle label="Show IDs" checked={scene3D.trackingLabels !== false} onChange={(v) => onSceneConfig({ trackingLabels: v })} />
              </div>
            )}
            <Toggle label="Camera pose markers (MediaPipe)" checked={scene3D.mediapipeViz ?? false} onChange={(v) => onSceneConfig({ mediapipeViz: v })} />
            <Toggle label="Merge people (2 blobs → 1)" checked={scene3D.trackingMergePeople ?? false} onChange={(v) => onSceneConfig({ trackingMergePeople: v })} />
            {scene3D.trackingMergePeople && (
              <div className="pl-2 border-l border-line-1 space-y-2">
                <NumRow label="Merge radius (m)" value={scene3D.trackingMergeRadius ?? 0.8} step={0.05} onChange={(v) => onSceneConfig({ trackingMergeRadius: Math.max(0.05, Math.min(3, v)) })} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Memoized on its DATA props only — App re-renders frequently (live preview/transport), and a native
// <select> popup closes if the panel repaints under it. Callback props are intentionally ignored
// (they're stable enough; the handlers use functional setState), so the panel stays still while the
// user interacts with its dropdowns.
const ScenePanel3D = React.memo(ScenePanel3DBase, (a, b) =>
  a.scene3D === b.scene3D &&
  a.selectedModelId === b.selectedModelId &&
  a.selectedFixtureId === b.selectedFixtureId &&
  a.fixtures === b.fixtures &&
  a.timeline === b.timeline &&
  a.naturalSizes === b.naturalSizes &&
  a.saved === b.saved,
);

export default ScenePanel3D;

const numCls = 'w-14 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-right text-fg-1 num text-mini focus:border-accent focus:outline-none';

// Buffered numeric input: type freely (decimals, intermediate values) and commit on Enter/blur, so a
// live controlled value can't reset the field mid-keystroke.
const NumInput: React.FC<{ value: number; step?: number; title?: string; min?: number; className?: string; onChange: (v: number) => void }> = ({ value, step = 1, title, min, className, onChange }) => {
  const [txt, setTxt] = useState<string | null>(null);
  const commit = () => { if (txt === null) return; const n = parseFloat(txt); setTxt(null); if (!Number.isNaN(n)) onChange(min != null ? Math.max(min, n) : n); };
  return (
    <input type="number" step={step} title={title} value={txt ?? String(+value.toFixed(4))}
      onChange={(e) => setTxt(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); else if (e.key === 'Escape') setTxt(null); }}
      className={className ?? numCls} />
  );
};

const NumRow: React.FC<{ label: string; value: number; step?: number; onChange: (v: number) => void }> = ({ label, value, step = 1, onChange }) => (
  <div className="flex items-center justify-between gap-2 text-mini">
    <span className="text-fg-2">{label}</span>
    <NumInput value={value} step={step} onChange={onChange} />
  </div>
);

const Vec3Row: React.FC<{ label: string; v: { x: number; y: number; z: number }; step?: number; min?: number; onChange: (v: { x: number; y: number; z: number }) => void }> = ({ label, v, step = 0.1, min, onChange }) => (
  <div className="flex items-center justify-between gap-1 text-mini">
    <span className="text-fg-2 w-8">{label}</span>
    {(['x', 'y', 'z'] as const).map(ax => (
      <NumInput key={ax} value={v[ax]} step={step} title={ax.toUpperCase()} min={min}
        onChange={(n) => onChange({ ...v, [ax]: n })}
        className="w-12 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-right text-fg-1 num text-micro focus:border-accent focus:outline-none" />
    ))}
  </div>
);

const Toggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, checked, onChange }) => (
  <div className="flex items-center justify-between gap-2 text-mini">
    <span className="text-fg-2">{label}</span>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
  </div>
);
