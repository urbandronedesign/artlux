import React, { Suspense, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { Move3d, Rotate3d, Maximize } from 'lucide-react';
import { Fixture, Vec3, Euler3 } from '../../types';
import { Scene3D, SceneModel, defaultScene3D } from '../../../../shared/protocol';
import { InstancedLeds } from './InstancedLeds';
import { FixtureGizmo } from './FixtureGizmo';
import { FixtureLights } from './FixtureLights';
import { ModelObject, ModelTransform } from './ModelObject';
import { PlaneObject } from './PlaneObject';
import { ModelBoundary } from './ModelBoundary';
import { GroundGrid } from './GroundGrid';
import { ReflectiveFloor } from './ReflectiveFloor';
import { Lighting } from './Lighting';
import TrackingViz from './TrackingViz';

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
        {scene3D.trackingViz && <TrackingViz />}
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
              />
            </Suspense>
          </ModelBoundary>
        ) : null)}
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

export default Simulator3D;
