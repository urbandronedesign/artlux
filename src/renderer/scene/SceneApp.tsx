import React, { useEffect, useRef, useState } from 'react';
import { Fixture, Surface, Vec3, Euler3, Timeline, defaultTimeline } from '../types';
import { Scene3D, SceneModel, defaultScene3D } from '../../../shared/protocol';
import { useGLTF } from '@react-three/drei';
import { dmxSignal } from '../services/dmxSignal';
import { timeline as engine } from '../services/timeline';
import * as trackingStore from '../services/trackingStore';
import Simulator3D from '../components/Simulator3D/Simulator3D';
import type { ModelTransform } from '../components/Simulator3D/ModelObject';
import { Plus, Trash2, Eye, EyeOff, Box, Lightbulb, Save, Check, MonitorPlay } from 'lucide-react';
import type { MainToScene, SceneToMain } from './bridge';

const basename = (p: string) => (p.replace(/\\/g, '/').split('/').pop() || p).replace(/\.(glb|gltf)$/i, '');

// The 3D Scene window: live fixtures + multiple GLB meshes, each selectable in the
// outliner and transformable (move/rotate/scale) via the gizmo. Live LED colors arrive
// from the main window over a MessagePort and are re-published into this window's
// dmxSignal so Simulator3D/useLedColors light up unchanged. Edits flow back to main.
export const SceneApp: React.FC = () => {
  const portRef = useRef<MessagePort | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [, setSurfaces] = useState<Surface[]>([]);
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [scene3D, setScene3D] = useState<Scene3D>(defaultScene3D());
  const [modelUrls, setModelUrls] = useState<Record<string, string>>({});
  const [naturalSizes, setNaturalSizes] = useState<Record<string, number>>({});
  const [fitMeters, setFitMeters] = useState(5);
  const [connected, setConnected] = useState(false);
  const [saved, setSaved] = useState(false);
  const [timeline, setTimelineState] = useState<Timeline>(defaultTimeline());

  // This window's timeline engine is driven by the bridge (the main window owns the clock).
  useEffect(() => { engine.setExternal(true); }, []);

  // Tell main which layers our planes display so it streams just those frames (decoded once
  // in main, mirrored here as ImageBitmaps — keeps this window from holding its own decoders).
  useEffect(() => {
    const layerIds = Array.from(new Set(
      (scene3D.models ?? []).filter(m => m.kind === 'plane' && m.visible && m.layerId).map(m => m.layerId!)
    ));
    portRef.current?.postMessage({ t: 'sceneLayers', layerIds } satisfies SceneToMain);
  }, [scene3D.models]);
  // Blob URL per unique file PATH (not per model id) so the same GLB placed multiple
  // times loads once and is instanced — each ModelObject clones the shared loaded scene
  // (clones share geometry + materials, so extra copies are nearly free).
  const urlCache = useRef<Record<string, string>>({});

  const send = (m: SceneToMain) => portRef.current?.postMessage(m);
  const applyConfig = (patch: Partial<Scene3D>) => { setScene3D(s => ({ ...s, ...patch })); send({ t: 'sceneConfig', patch }); };

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data !== 'artlux:scene-port' || !e.ports[0]) return;
      const port = e.ports[0];
      portRef.current = port;
      port.onmessage = (ev: MessageEvent) => {
        const m = ev.data as MainToScene;
        if (m.t === 'state') {
          setFixtures(m.fixtures);
          setSurfaces(m.surfaces);
          setSelectedFixtureId(m.selectedId);
          setScene3D({ ...m.scene3D, models: m.scene3D.models ?? [] });
          setConnected(true);
        } else if (m.t === 'pixels') {
          dmxSignal.publish(new Uint8Array(m.buf), {});
        } else if (m.t === 'saved') {
          if (m.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
        } else if (m.t === 'timeline') {
          setTimelineState(m.timeline); engine.setData(m.timeline);
        } else if (m.t === 'transport') {
          engine.setPlaying(m.playing); engine.seek(m.playhead);
        } else if (m.t === 'frame') {
          engine.setLayerBitmap(m.layerId, m.bitmap);
        } else if (m.t === 'tracking') {
          trackingStore.applySnapshot(m.snap);
        }
      };
      port.start();
      send({ t: 'ready' });
    };
    window.addEventListener('message', onMsg);
    window.postMessage('artlux:scene-port-request', '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Load each unique file path once → a shared Blob URL; map every model id to its path's
  // URL (so duplicate meshes reuse one loaded asset). Re-runs are idempotent and can't drop
  // an already-loaded model. Paths no longer used by any model are revoked + cache-cleared.
  useEffect(() => {
    const models = scene3D.models ?? [];
    let alive = true;
    (async () => {
      const meshes = models.filter(m => m.kind !== 'plane' && m.path);
      const paths = Array.from(new Set(meshes.map(m => m.path)));
      for (const path of paths) {
        if (urlCache.current[path]) continue; // already loaded
        const bytes = await window.artlux?.readModel?.(path);
        if (!alive) return;
        if (!bytes) continue;
        urlCache.current[path] = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
      }
      if (!alive) return;
      const next: Record<string, string> = {};
      for (const m of meshes) { const u = urlCache.current[m.path]; if (u) next[m.id] = u; }
      setModelUrls(next);
      // Free paths no longer referenced by any mesh.
      const used = new Set(meshes.map(m => m.path));
      for (const path of Object.keys(urlCache.current)) {
        if (!used.has(path)) {
          try { useGLTF.clear(urlCache.current[path]); } catch { /* ignore */ }
          URL.revokeObjectURL(urlCache.current[path]);
          delete urlCache.current[path];
        }
      }
    })();
    return () => { alive = false; };
  }, [scene3D.models]);

  // --- selection ---
  const selectFixture = (id: string | null) => { setSelectedModelId(null); setSelectedFixtureId(id); send({ t: 'select', id }); };
  const selectModel = (id: string | null) => { setSelectedModelId(id); if (id) { setSelectedFixtureId(null); send({ t: 'select', id: null }); } };

  // --- model CRUD ---
  const setModels = (models: SceneModel[]) => applyConfig({ models });
  const addModel = async () => {
    const path = await window.artlux?.pickModel?.();
    if (!path) return;
    const count = (scene3D.models ?? []).length;
    // Stagger new meshes so they don't stack exactly on the origin.
    const m: SceneModel = { id: crypto.randomUUID(), name: basename(path), path, position: { x: count * 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1, visible: true };
    setModels([...(scene3D.models ?? []), m]);
    selectModel(m.id);
  };
  const addPlane = () => {
    const count = (scene3D.models ?? []).length;
    const m: SceneModel = { id: crypto.randomUUID(), name: `Screen ${count + 1}`, kind: 'plane', path: '', position: { x: count * 2, y: 1.2, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 2, visible: true };
    setModels([...(scene3D.models ?? []), m]);
    selectModel(m.id);
  };
  const updateModel = (id: string, patch: Partial<SceneModel>) => setModels((scene3D.models ?? []).map(m => m.id === id ? { ...m, ...patch } : m));
  const removeModel = (id: string) => { setModels((scene3D.models ?? []).filter(m => m.id !== id)); if (selectedModelId === id) setSelectedModelId(null); };
  const commitModel = (id: string, t: ModelTransform) => updateModel(id, t);

  const models = scene3D.models ?? [];
  const selModel = models.find(m => m.id === selectedModelId) || null;

  const rowCls = (active: boolean) => `flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer text-[11px] group ${active ? 'bg-accent/15 text-accent' : 'text-fg-2 hover:bg-surface-3'}`;

  return (
    <div className="relative w-full h-screen bg-surface-0 text-fg-1 font-sans overflow-hidden">
      {!connected && (
        <div className="absolute inset-0 z-20 flex items-center justify-center text-fg-3 text-xs pointer-events-none">
          Connecting to the main window…
        </div>
      )}

      <Simulator3D
        fixtures={fixtures}
        selectedFixtureId={selectedFixtureId}
        scene3D={scene3D}
        modelUrls={modelUrls}
        selectedModelId={selectedModelId}
        onSelectFixture={(id: string) => selectFixture(id || null)}
        onSelectModel={selectModel}
        onCommitFixture3D={(id: string, updates: { position3D?: Vec3; rotation3D?: Euler3; scale3D?: number }) => send({ t: 'commit', id, ...updates })}
        onCommitModel={commitModel}
        onModelNaturalSize={(id, maxDim) => setNaturalSizes(s => (s[id] === maxDim ? s : { ...s, [id]: maxDim }))}
        onSceneConfig={applyConfig}
        onRecordHistory={() => { /* history lives in the main window */ }}
      />

      {/* Outliner */}
      <div className="absolute top-2 right-2 z-10 w-60 bg-surface-1/95 backdrop-blur-sm border border-line-1 rounded-[var(--r-md)] text-xs flex flex-col max-h-[calc(100vh-1rem)]">
        <div className="flex items-center justify-between px-3 h-9 border-b border-line-1">
          <span className="text-[11px] font-bold text-fg-1">3D Scene</span>
          <button
            onClick={() => send({ t: 'save' })}
            title="Save the project (includes the 3D scene)"
            className={`flex items-center gap-1.5 px-2 py-1 rounded-[var(--r-sm)] text-[11px] transition-colors ${saved ? 'bg-ok/20 text-ok' : 'bg-accent text-black hover:bg-accent-hover'}`}
          >
            {saved ? <Check size={13} /> : <Save size={13} />} {saved ? 'Saved' : 'Save'}
          </button>
        </div>
        <div className="flex items-center justify-between px-3 h-8 border-b border-line-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-fg-3 flex items-center gap-1.5"><Box size={12} /> Objects</span>
          <div className="flex items-center gap-2">
            <button onClick={addPlane} title="Add screen plane" className="text-fg-2 hover:text-fg-1"><MonitorPlay size={14} /></button>
            <button onClick={addModel} title="Add GLB mesh" className="text-fg-2 hover:text-fg-1"><Plus size={14} /></button>
          </div>
        </div>
        <div className="p-1 space-y-0.5 max-h-40 overflow-y-auto">
          {models.length === 0 && <div className="text-fg-3 italic px-2 py-1">No objects — add a GLB or screen</div>}
          {models.map(m => (
            <div key={m.id} className={rowCls(selectedModelId === m.id)} onClick={() => selectModel(m.id)}>
              {m.kind === 'plane' ? <MonitorPlay size={12} className="shrink-0" /> : <Box size={12} className="shrink-0" />}
              <span className="flex-1 truncate" title={m.path}>{m.name}</span>
              <button onClick={(e) => { e.stopPropagation(); updateModel(m.id, { visible: !m.visible }); }} className="text-fg-3 hover:text-fg-1" title={m.visible ? 'Hide' : 'Show'}>
                {m.visible ? <Eye size={12} /> : <EyeOff size={12} />}
              </button>
              <button onClick={(e) => { e.stopPropagation(); removeModel(m.id); }} className="text-fg-3 hover:text-danger opacity-0 group-hover:opacity-100" title="Remove"><Trash2 size={11} /></button>
            </div>
          ))}
        </div>

        <div className="px-3 h-8 flex items-center border-y border-line-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-fg-3 flex items-center gap-1.5"><Lightbulb size={12} /> Fixtures</span>
        </div>
        <div className="p-1 space-y-0.5 max-h-40 overflow-y-auto">
          {fixtures.length === 0 && <div className="text-fg-3 italic px-2 py-1">No fixtures</div>}
          {fixtures.map(f => (
            <div key={f.id} className={rowCls(!selectedModelId && selectedFixtureId === f.id)} onClick={() => selectFixture(f.id)}>
              <Lightbulb size={12} className="shrink-0" />
              <span className="flex-1 truncate">{f.name}</span>
            </div>
          ))}
        </div>

        {/* Selected model transform */}
        {selModel && (
          <div className="border-t border-line-1 p-2.5 space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-fg-3 truncate">{selModel.name}</div>
            {selModel.kind === 'plane' && (
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="text-fg-2 shrink-0">Layer</span>
                <select value={selModel.layerId ?? ''} onChange={(e) => updateModel(selModel.id, { layerId: e.target.value || undefined })}
                  className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[10px] focus:border-accent focus:outline-none">
                  <option value="">— no layer —</option>
                  {timeline.layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            )}
            <NumRow label="Scale" value={selModel.scale} step={0.1} onChange={(v) => updateModel(selModel.id, { scale: Math.max(0.0001, v) })} />
            {selModel.kind !== 'plane' && (
              <>
                <div className="flex gap-1.5">
                  {[1, 10, 100, 1000].map(v => (
                    <button key={v} onClick={() => updateModel(selModel.id, { scale: v })} className="flex-1 px-1 py-0.5 rounded-[var(--r-sm)] bg-surface-2 border border-line-1 text-fg-2 hover:text-fg-1 num text-[10px]">×{v}</button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-fg-2 shrink-0">Fit longest</span>
                  <input type="number" min={0.01} step={0.5} value={fitMeters} onChange={(e) => { const v = parseFloat(e.target.value); if (v > 0) setFitMeters(v); }} className={numCls} />
                  <span className="text-fg-3">m</span>
                  <button
                    onClick={() => { const nat = naturalSizes[selModel.id]; if (nat) updateModel(selModel.id, { scale: fitMeters / nat }); }}
                    disabled={!naturalSizes[selModel.id]}
                    className="px-2 py-0.5 rounded-[var(--r-sm)] bg-accent text-black hover:bg-accent-hover num text-[10px] disabled:opacity-40"
                  >Fit</button>
                </div>
              </>
            )}
            <Vec3Row label="Pos" v={selModel.position} onChange={(p) => updateModel(selModel.id, { position: p })} step={0.1} />
            <Vec3Row label="Rot°" v={selModel.rotation} onChange={(r) => updateModel(selModel.id, { rotation: r })} step={5} />
          </div>
        )}

        {/* Lighting / view */}
        <div className="border-t border-line-1 p-2.5 space-y-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-fg-3">Lighting</div>
          <NumRow label="Light gain" value={scene3D.lightIntensity} step={0.1} onChange={(v) => applyConfig({ lightIntensity: Math.max(0, v) })} />
          <NumRow label="Exposure" value={scene3D.exposure} step={0.05} onChange={(v) => applyConfig({ exposure: Math.max(0.1, v) })} />
          <Toggle label="Ambient (env)" checked={scene3D.environment} onChange={(v) => applyConfig({ environment: v })} />
          <Toggle label="Reflective floor" checked={scene3D.reflectiveFloor ?? false} onChange={(v) => applyConfig({ reflectiveFloor: v })} />
          <Toggle label="Grid" checked={scene3D.gridVisible} onChange={(v) => applyConfig({ gridVisible: v })} />
          <Toggle label="Tracking zones (LiDAR)" checked={scene3D.trackingViz ?? false} onChange={(v) => applyConfig({ trackingViz: v })} />
          {scene3D.trackingViz && (
            <div className="pl-2 border-l border-line-1 space-y-2">
              <NumRow label="Smoothing" value={scene3D.trackingSmoothing ?? 0.5} step={0.05} onChange={(v) => applyConfig({ trackingSmoothing: Math.max(0, Math.min(1, v)) })} />
              <NumRow label="Predict (ms)" value={scene3D.trackingPredictMs ?? 80} step={10} onChange={(v) => applyConfig({ trackingPredictMs: Math.max(0, Math.min(300, v)) })} />
              <Toggle label="Show IDs" checked={scene3D.trackingLabels !== false} onChange={(v) => applyConfig({ trackingLabels: v })} />
            </div>
          )}
          <Toggle label="Merge people (2 blobs → 1)" checked={scene3D.trackingMergePeople ?? false} onChange={(v) => applyConfig({ trackingMergePeople: v })} />
          {scene3D.trackingMergePeople && (
            <div className="pl-2 border-l border-line-1 space-y-2">
              <NumRow label="Merge radius (m)" value={scene3D.trackingMergeRadius ?? 0.6} step={0.05} onChange={(v) => applyConfig({ trackingMergeRadius: Math.max(0.05, Math.min(3, v)) })} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const numCls = 'w-14 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-right text-fg-1 num text-[11px] focus:border-accent focus:outline-none';

const NumRow: React.FC<{ label: string; value: number; step?: number; onChange: (v: number) => void }> = ({ label, value, step = 1, onChange }) => (
  <div className="flex items-center justify-between gap-2 text-[11px]">
    <span className="text-fg-2">{label}</span>
    <input type="number" step={step} value={+value.toFixed(4)} onChange={(e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange(v); }} className={numCls} />
  </div>
);

const Vec3Row: React.FC<{ label: string; v: { x: number; y: number; z: number }; step?: number; onChange: (v: { x: number; y: number; z: number }) => void }> = ({ label, v, step = 0.1, onChange }) => (
  <div className="flex items-center justify-between gap-1 text-[11px]">
    <span className="text-fg-2 w-8">{label}</span>
    {(['x', 'y', 'z'] as const).map(ax => (
      <input key={ax} type="number" step={step} value={+v[ax].toFixed(3)} title={ax.toUpperCase()}
        onChange={(e) => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) onChange({ ...v, [ax]: n }); }}
        className="w-12 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-right text-fg-1 num text-[10px] focus:border-accent focus:outline-none" />
    ))}
  </div>
);

const Toggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, checked, onChange }) => (
  <div className="flex items-center justify-between gap-2 text-[11px]">
    <span className="text-fg-2">{label}</span>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
  </div>
);
