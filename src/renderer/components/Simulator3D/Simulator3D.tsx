import React, { Suspense, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport, Html } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { Move3d, Rotate3d, Maximize } from 'lucide-react';
import { Fixture, Vec3, Euler3 } from '../../types';
import { Scene3D, SceneModel, defaultScene3D, ProjectorCalibration, modelScaleXYZ } from '../../../../shared/protocol';
import { ProjectorFrustum } from './ProjectorFrustum';
import { InstancedLeds } from './InstancedLeds';
import { FixtureGizmo } from './FixtureGizmo';
import { FixtureLights } from './FixtureLights';
import { ModelObject, ModelTransform } from './ModelObject';
import { PlaneObject } from './PlaneObject';
import { ModelBoundary } from './ModelBoundary';
import { GroundGrid } from './GroundGrid';
import { ReflectiveFloor } from './ReflectiveFloor';
import { Lighting } from './Lighting';
import { sceneVizRegistry } from '../../host/registries';

interface Props {
  fixtures: Fixture[];
  selectedFixtureId: string | null;
  scene3D?: Scene3D;
  /** Resolved Blob/object URLs for each scene model, keyed by model id. */
  modelUrls?: Record<string, string>;
  selectedModelId?: string | null;
  onSelectFixture: (id: string) => void;
  onSelectModel?: (id: string | null) => void;
  onCommitFixture3D: (id: string, updates: { position3D?: Vec3; rotation3D?: Euler3; scale3D?: number }) => void;
  onCommitModel?: (id: string, t: ModelTransform) => void;
  onModelNaturalSize?: (id: string, maxDim: number) => void;
  onSceneConfig?: (patch: Partial<Scene3D>) => void;
  onRecordHistory: () => void;
  /** Projector calibration: pose-pick mode + frustum overlays. */
  calibPickMode?: boolean;
  onCalibPick?: (world: [number, number, number]) => void;
  projectorCalibs?: Array<{ surfaceId: string; calibration: ProjectorCalibration }>;
  activePicks?: Array<{ world: [number, number, number] }>;
  selectedPick?: number | null;                       // highlight the correspondence being edited
  onSelectPick?: (i: number) => void;                 // click a numbered marker → select it for editing
  /** Hide the built-in floating transform inspector (e.g. when an external panel already shows Pos/Rot/Scale). */
  hideInspector?: boolean;
}

type Mode = 'translate' | 'rotate' | 'scale';

const Exposure: React.FC<{ value: number }> = ({ value }) => {
  const gl = useThree((s) => s.gl);
  gl.toneMappingExposure = value;
  return null;
};

const ToolBtn: React.FC<{ active: boolean; title: string; onClick: () => void; children: React.ReactNode }> = ({ active, title, onClick, children }) => (
  <button
    onClick={onClick}
    title={title}
    aria-pressed={active}
    className={`p-1.5 rounded-[var(--r-sm)] border transition-colors ${active ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2/80 backdrop-blur-sm border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1'}`}
  >
    {children}
  </button>
);

const Simulator3D: React.FC<Props> = ({
  fixtures, selectedFixtureId, scene3D = defaultScene3D(), modelUrls = {},
  selectedModelId = null,
  onSelectFixture, onSelectModel, onCommitFixture3D, onCommitModel, onModelNaturalSize, onRecordHistory,
  calibPickMode = false, onCalibPick, projectorCalibs = [], activePicks = [], selectedPick = null, onSelectPick,
  hideInspector = false,
}) => {
  const [mode, setMode] = useState<Mode>('translate');
  const selectedFixture = (!selectedModelId && fixtures.find(f => f.id === selectedFixtureId)) || null;
  const models: SceneModel[] = scene3D.models ?? [];

  return (
    <div className="relative w-full h-full bg-surface-0">
      <div className="absolute top-2 left-2 z-10 flex gap-1">
        <ToolBtn active={mode === 'translate'} title="Move (W)" onClick={() => setMode('translate')}><Move3d size={14} /></ToolBtn>
        <ToolBtn active={mode === 'rotate'} title="Rotate (E)" onClick={() => setMode('rotate')}><Rotate3d size={14} /></ToolBtn>
        <ToolBtn active={mode === 'scale'} title="Scale (R)" onClick={() => setMode('scale')}><Maximize size={14} /></ToolBtn>
      </div>

      {/* Numeric transform inspector for the selected model — position, rotation, and per-axis scale. */}
      {!hideInspector && (() => {
        const m = models.find((mm) => mm.id === selectedModelId);
        return m && onCommitModel ? <ModelInspector model={m} onCommit={onCommitModel} /> : null;
      })()}

      <Canvas
        dpr={1}
        gl={{ powerPreference: 'high-performance', antialias: true }}
        camera={{ position: [0, 1.2, 3], fov: 50 }}
        onPointerMissed={() => { onSelectFixture(''); onSelectModel?.(null); }}
      >
        <color attach="background" args={['#0d0d0d']} />
        <Exposure value={scene3D.exposure ?? 1} />
        <Lighting env={scene3D.environment} />
        {scene3D.reflectiveFloor && <ReflectiveFloor />}
        {scene3D.gridVisible !== false && <GroundGrid />}
        {/* Plugin-contributed 3D overlays (e.g. LiDAR blob viz). Each plugin registers a scene-viz
            component + an `enabled` gate; the host stays agnostic of what they draw. */}
        {sceneVizRegistry.all().map((v) => (v.enabled?.(scene3D) ?? true) ? <v.Component key={v.id} scene3D={scene3D} /> : null)}
        {models.map((m) => m.kind === 'plane' ? (
          <PlaneObject
            key={m.id}
            model={m}
            selected={selectedModelId === m.id}
            mode={mode}
            onSelect={(id) => onSelectModel?.(id)}
            onCommit={(id, t) => onCommitModel?.(id, t)}
            onRecordHistory={onRecordHistory}
          />
        ) : modelUrls[m.id] ? (
          <ModelBoundary key={m.id}>
            <Suspense fallback={null}>
              <ModelObject
                model={m}
                url={modelUrls[m.id]}
                selected={selectedModelId === m.id}
                mode={mode}
                onSelect={(id) => onSelectModel?.(id)}
                onCommit={(id, t) => onCommitModel?.(id, t)}
                onNaturalSize={onModelNaturalSize}
                onRecordHistory={onRecordHistory}
                calibPickMode={calibPickMode}
                onCalibPick={onCalibPick}
              />
            </Suspense>
          </ModelBoundary>
        ) : null)}
        {projectorCalibs.map(({ surfaceId, calibration }) => (
          <ProjectorFrustum key={surfaceId} calibration={calibration} />
        ))}
        {/* Calibration anchor markers — one numbered marker per placed correspondence (board pose picks
            or Auto-Align anchors). Rendered independently of a solved calibration so they appear as you
            place them, and depth-test off so a far wall pick isn't hidden by the model. Cyan + number
            match the camera-preview markers. */}
        {activePicks.map((p, i) => {
          const on = selectedPick === i;
          const col = on ? '#ffffff' : '#00e5ff';
          return (
            <group key={`apick-${i}`} position={p.world}>
              {/* Clickable when an edit handler is wired (markerless), so selecting from the 3D side
                  mirrors selecting from the camera/list. Otherwise non-raycasting (board flow). */}
              <mesh renderOrder={999} raycast={onSelectPick ? undefined : () => null}
                onClick={onSelectPick ? (e) => { e.stopPropagation(); onSelectPick(i); } : undefined}>
                <sphereGeometry args={[on ? 0.055 : 0.04, 16, 16]} />
                <meshBasicMaterial color={col} depthTest={false} transparent opacity={0.95} />
              </mesh>
              <Html center style={{ pointerEvents: 'none' }}>
                <div style={{ transform: 'translateY(-15px)', font: 'bold 11px sans-serif', color: col, textShadow: '0 0 3px #000,0 0 3px #000', whiteSpace: 'nowrap' }}>{i + 1}</div>
              </Html>
            </group>
          );
        })}
        <FixtureLights fixtures={fixtures} scene3D={scene3D} />
        <InstancedLeds fixtures={fixtures} onSelectFixture={onSelectFixture} />
        <FixtureGizmo
          fixture={selectedFixture}
          mode={mode}
          onRecordHistory={onRecordHistory}
          onCommit={onCommitFixture3D}
        />
        <OrbitControls makeDefault />
        <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
          <GizmoViewport labelColor="white" axisHeadScale={1} />
        </GizmoHelper>
        <EffectComposer>
          <Bloom luminanceThreshold={0.1} intensity={0.6} mipmapBlur />
        </EffectComposer>
      </Canvas>
    </div>
  );
};

const AXES = ['x', 'y', 'z'] as const;

// Numeric transform editor for the selected model: position, rotation (deg), and per-axis (independent)
// scale. Overlays the 3D view; each edit commits the full transform so nothing is lost between fields.
// Buffered input: holds the raw text while focused (so decimals / intermediate values type freely) and
// only commits — clamped — on Enter or blur. A live controlled value would reset mid-keystroke.
const TInput: React.FC<{ value: number; step: number; title: string; min?: number; onChange: (v: number) => void }> = ({ value, step, title, min, onChange }) => {
  const [txt, setTxt] = useState<string | null>(null);
  const commit = () => {
    if (txt === null) return;
    const n = parseFloat(txt);
    setTxt(null);
    if (!Number.isNaN(n)) onChange(min != null ? Math.max(min, n) : n);
  };
  return (
    <input type="number" step={step} title={title}
      value={txt ?? String(+value.toFixed(4))}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); else if (e.key === 'Escape') setTxt(null); }}
      onPointerDown={(e) => e.stopPropagation()}
      className="w-14 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-right text-fg-1 num text-[10px] focus:border-accent focus:outline-none" />
  );
};

const ModelInspector: React.FC<{ model: SceneModel; onCommit: (id: string, t: ModelTransform) => void }> = ({ model, onCommit }) => {
  const scl = modelScaleXYZ(model);
  const base = (): ModelTransform => ({ position: { ...model.position }, rotation: { ...model.rotation }, scaleXYZ: [scl[0], scl[1], scl[2]] });
  const onPR = (field: 'position' | 'rotation') => (i: number, v: number) =>
    onCommit(model.id, { ...base(), [field]: { ...model[field], [AXES[i]]: v } });
  const onScale = (i: number, v: number) => { const s = [...scl] as [number, number, number]; s[i] = Math.max(0.0001, v); onCommit(model.id, { ...base(), scaleXYZ: s }); };
  const Row = (label: string, vals: number[], step: number, on: (i: number, v: number) => void, min?: number) => (
    <div className="flex items-center gap-1">
      <span className="text-fg-3 w-8 text-[10px]">{label}</span>
      {vals.map((val, i) => <TInput key={i} value={val} step={step} min={min} title={AXES[i].toUpperCase()} onChange={(v) => on(i, v)} />)}
    </div>
  );
  return (
    <div className="absolute top-2 right-2 z-10 bg-surface-1/95 border border-line-1 rounded-md p-2 space-y-1 shadow-xl backdrop-blur-sm"
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-fg-3 truncate max-w-[190px]">{model.name}</div>
      {Row('Pos', [model.position.x, model.position.y, model.position.z], 0.1, onPR('position'))}
      {Row('Rot°', [model.rotation.x, model.rotation.y, model.rotation.z], 5, onPR('rotation'))}
      {Row('Scale', [scl[0], scl[1], scl[2]], 0.1, onScale, 0.0001)}
    </div>
  );
};

export default Simulator3D;
