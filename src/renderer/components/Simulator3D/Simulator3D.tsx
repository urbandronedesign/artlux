import React, { Suspense, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport, Html } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { Move3d, Rotate3d, Maximize } from 'lucide-react';
import { Fixture, Vec3, Euler3 } from '../../types';
import { Scene3D, SceneModel, defaultScene3D, ProjectorCalibration } from '../../../../shared/protocol';
import { ProjectorFrustum } from './ProjectorFrustum';
import { InstancedLeds } from './InstancedLeds';
import { FixtureBodies } from './FixtureBodies';
import { FixtureGizmo } from './FixtureGizmo';
import { FixtureLights } from './FixtureLights';
import { ModelObject, ModelTransform } from './ModelObject';
import { PlaneObject } from './PlaneObject';
import { ModelBoundary } from './ModelBoundary';
import { GroundGrid } from './GroundGrid';
import { ReflectiveFloor } from './ReflectiveFloor';
import { Lighting } from './Lighting';
import { sceneVizRegistry } from '../../host/registries';
import { Tooltip } from '../ui/Tooltip';
import { help } from '../../services/helpBus';

interface Props {
  fixtures: Fixture[];
  selectedFixtureId: string | null;
  /** Every selected fixture — the bodies highlight all of them, not just the primary. */
  selectedFixtureIds?: string[];
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
  /**
   * Stop rendering without unmounting. The workspace shell keeps this canvas MOUNTED across context
   * switches (remounting it would rebuild the WebGL context and reload every model), so while it is
   * hidden it must not keep burning a render loop on a zero-width pane — r3f's default `frameloop`
   * is 'always' and does not care that the canvas is invisible.
   */
  paused?: boolean;
}

type Mode = 'translate' | 'rotate' | 'scale';

const Exposure: React.FC<{ value: number }> = ({ value }) => {
  const gl = useThree((s) => s.gl);
  gl.toneMappingExposure = value;
  return null;
};

// `helpId` opts the tool into the rich help system: it spreads help() onto the host <button> and wraps
// it in a Tooltip (the button is a real DOM element, which is what Tooltip needs to clone + ref).
const ToolBtn: React.FC<{ active: boolean; title: string; helpId?: string; onClick: () => void; children: React.ReactNode }> = ({ active, title, helpId, onClick, children }) => {
  const btn = (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`p-1.5 rounded-sm border transition-colors ${active ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1'}`}
      {...(helpId ? help(helpId) : {})}
    >
      {children}
    </button>
  );
  return helpId ? <Tooltip id={helpId}>{btn}</Tooltip> : btn;
};

const Simulator3D: React.FC<Props> = ({
  fixtures, selectedFixtureId, selectedFixtureIds = [], scene3D = defaultScene3D(), modelUrls = {},
  selectedModelId = null,
  onSelectFixture, onSelectModel, onCommitFixture3D, onCommitModel, onModelNaturalSize, onRecordHistory,
  calibPickMode = false, onCalibPick, projectorCalibs = [], activePicks = [], selectedPick = null, onSelectPick,
  paused = false,
}) => {
  const [mode, setMode] = useState<Mode>('translate');
  const selectedFixture = (!selectedModelId && fixtures.find(f => f.id === selectedFixtureId)) || null;
  const models: SceneModel[] = scene3D.models ?? [];

  return (
    <div className="flex flex-col w-full h-full bg-surface-0">
      {/* Docked viewport header — transform-mode tools live in reserved chrome, not over the canvas
          (Houdini-style). The 3D view below renders clean with nothing painted on top. */}
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 bg-surface-1 border-b border-line-1">
        <ToolBtn active={mode === 'translate'} title="Move (W)" helpId="scene3d.gizmo-translate" onClick={() => setMode('translate')}><Move3d size={14} /></ToolBtn>
        <ToolBtn active={mode === 'rotate'} title="Rotate (E)" helpId="scene3d.gizmo-rotate" onClick={() => setMode('rotate')}><Rotate3d size={14} /></ToolBtn>
        <ToolBtn active={mode === 'scale'} title="Scale (R)" helpId="scene3d.gizmo-scale" onClick={() => setMode('scale')}><Maximize size={14} /></ToolBtn>
      </div>

      {/* Canvas region — fills the pane below the header. The inspector overlays only this area. */}
      <div className="flex-1 relative">
      {/* The floating transform inspector that used to overlay this canvas is GONE. It was already
          dead code — App always passed `hideInspector`, so it never rendered in the main window — and
          the `3d` context's `core.inspector.model.transform` panel is its real replacement. */}

      <Canvas
        frameloop={paused ? 'never' : 'always'}
        dpr={[1, 2]}
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
        {/* The housing goes in FIRST so the LEDs draw over it. It is also the click target — see
            FixtureBodies: a 12mm sphere is not something an operator can reliably hit. */}
        <FixtureBodies fixtures={fixtures} selectedIds={selectedFixtureIds} onSelectFixture={onSelectFixture} />
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
    </div>
  );
};

export default Simulator3D;
