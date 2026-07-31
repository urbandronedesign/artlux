import React, { Suspense, useState, useMemo, useCallback, useEffect } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import type * as THREE from 'three';
import { Move3d, Rotate3d, Maximize, BoxSelect } from 'lucide-react';
import { Fixture, Vec3, Euler3, FixtureProfile } from '../../types';

// One shared empty map, so a scene with no profiled fixtures allocates nothing per render.
const EMPTY_PROFILES: ReadonlyMap<string, FixtureProfile> = new Map();
import { lightState, profileOf } from '../../services/fixtureKind';
import * as placement from '../../services/fixturePlacement';
import { PlacementPlane } from './PlacementPlane';
import { Scene3D, SceneModel, defaultScene3D, ProjectorCalibration } from '../../../../shared/protocol';
import { ProjectorFrustum } from './ProjectorFrustum';
import { AnchorMarker } from './AnchorMarker';
import { SnapCursor } from './SnapCursor';
import { setSnapHover } from './vertexSnap';
import { registerViewerCamera } from './viewerCamera';
import { InstancedLeds } from './InstancedLeds';
import { FixtureBodies } from './FixtureBodies';
import { FixtureGizmo } from './FixtureGizmo';
import { MarqueePicker, type MarqueeRect } from './MarqueePicker';
import { MoverBodies } from './MoverBodies';
import { GdtfFixture } from './GdtfFixture';
import { Beams } from './Beams';
import { MoverLights } from './MoverLights';
import { FixtureLights } from './FixtureLights';
import { ModelObject, ModelTransform } from './ModelObject';
import { PlaneObject } from './PlaneObject';
import { ModelBoundary } from './ModelBoundary';
import { GroundGrid } from './GroundGrid';
import { ReflectiveFloor } from './ReflectiveFloor';
import { Lighting } from './Lighting';
import { sceneVizRegistry } from '../../host/registries';
import { ErrorBoundary } from '../ErrorBoundary';
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
  /** Resolved DMX profiles — a profiled fixture is drawn as an articulated mover, not a bar. */
  fixtureProfiles?: ReadonlyMap<string, FixtureProfile>;
  onSelectFixture: (id: string) => void;
  /** Replace (or extend) the whole fixture selection — the marquee's output. */
  onSelectFixtures?: (ids: string[]) => void;
  onSelectModel?: (id: string | null) => void;
  /**
   * Commit a transform gesture. Takes an ARRAY because the gizmo moves the whole selection: ten
   * fixtures dragged together must land as ONE state change and therefore one undo step.
   */
  onCommitFixture3D: (updates: Array<{ id: string; position3D?: Vec3; rotation3D?: Euler3; scale3D?: number }>) => void;
  onCommitModel?: (id: string, t: ModelTransform) => void;
  onModelNaturalSize?: (id: string, maxDim: number) => void;
  onSceneConfig?: (patch: Partial<Scene3D>) => void;
  onRecordHistory: () => void;
  /** Projector calibration: pose-pick mode + frustum overlays. */
  calibPickMode?: boolean;
  onCalibPick?: (world: [number, number, number], source?: string) => void;
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

// 'select' is a MARQUEE tool, not a transform: it takes the left button away from OrbitControls for
// the duration, which is why it is a mode rather than a modifier. Shift/Ctrl-drag were both already
// taken by orbit and pan.
type Mode = 'translate' | 'rotate' | 'scale' | 'select';

const Exposure: React.FC<{ value: number }> = ({ value }) => {
  const gl = useThree((s) => s.gl);
  gl.toneMappingExposure = value;
  return null;
};

// THE CLIP PLANES FOLLOW THE ORBIT DISTANCE, because the scene has no fixed scale. r3f's default near
// plane is a fixed 0.1 world units — fine for a 12 m venue, a wall you cannot get past on a 20 cm
// model: you zoom in to place a calibration anchor precisely and the mesh is sliced away before it
// fills the viewport. Tying near to how far the camera is from what it is orbiting makes "close" mean
// the same thing at every scale.
//
// NEAR_MAX is today's fixed 0.1, so this can only ever clip LESS than before, and FAR_MIN is today's
// fixed 1000, so nothing that renders today stops rendering. The far/near ratio does widen at extreme
// close range; that costs depth precision only for things hundreds of units away, which is not what
// you are looking at when you have zoomed to 2 cm. (drei's Grid is `infiniteGrid` and fades at 22
// units, so it is never what pins the far plane.)
const NEAR_FRAC = 0.005;                     // near = 0.5% of the orbit distance
const NEAR_MIN = 1e-4, NEAR_MAX = 0.1;
const FAR_FRAC = 50, FAR_MIN = 1000;
// Expose the viewport camera to the Model panel (UV projection bake) — see viewerCamera.ts.
const ViewerCameraBridge: React.FC = () => {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    registerViewerCamera(camera);
    return () => registerViewerCamera(null);
  }, [camera]);
  return null;
};

const AdaptiveClipping: React.FC = () => {
  useFrame(({ camera, controls }) => {
    const cam = camera as THREE.PerspectiveCamera;
    if (!cam.isPerspectiveCamera) return;
    // OrbitControls is `makeDefault`, so its target is the point the operator is working around —
    // a better reference than the origin, which they may have panned far away from.
    const target = (controls as { target?: THREE.Vector3 } | null)?.target;
    const d = Math.max(1e-5, target ? cam.position.distanceTo(target) : cam.position.length());
    const near = Math.min(NEAR_MAX, Math.max(NEAR_MIN, d * NEAR_FRAC));
    const far = Math.max(FAR_MIN, d * FAR_FRAC);
    // Only rebuild the projection matrix on a real change — this runs every frame.
    if (Math.abs(cam.near - near) > near * 0.02 || Math.abs(cam.far - far) > far * 0.02) {
      cam.near = near; cam.far = far; cam.updateProjectionMatrix();
    }
  });
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
  fixtureProfiles = EMPTY_PROFILES, onSelectFixture, onSelectFixtures, onSelectModel, onCommitFixture3D, onCommitModel, onModelNaturalSize, onRecordHistory,
  calibPickMode = false, onCalibPick, projectorCalibs = [], activePicks = [], selectedPick = null, onSelectPick,
  paused = false,
}) => {
  const [mode, setMode] = useState<Mode>('translate');
  // Leaving pick mode drops the snap preview. It lives outside React (pointer-rate channel), so
  // unmounting SnapCursor would otherwise leave a stale vertex behind for the next session.
  useEffect(() => { if (!calibPickMode) setSnapHover(null); return () => setSnapHover(null); }, [calibPickMode]);
  // ── CLICK-TO-PLACE ────────────────────────────────────────────────────────────────────────
  // Armed from outside (adding a light from the library), consumed by one click on the pick plane.
  // Subscribed rather than read as a prop so arming does not re-render App and the whole 3D tree.
  const [placing, setPlacing] = useState(placement.get());
  useEffect(() => placement.subscribe(setPlacing), []);
  // Escape cancels — the same key that closes every other transient mode in the app. Bound only
  // while armed, so it never competes with anything else for the key.
  useEffect(() => {
    if (!placing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') placement.disarm(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placing]);
  const place = useCallback((p: Vec3) => {
    const req = placement.consume();
    if (!req) return;
    onRecordHistory();
    onCommitFixture3D([{ id: req.fixtureId, position3D: p }]);
  }, [onCommitFixture3D, onRecordHistory]);
  // The live marquee rectangle, in CSS pixels relative to the canvas. Drawn as a DOM overlay rather
  // than in the scene: it is screen-space chrome, and painting it in 3D would put it behind geometry.
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  // The gizmo drives the WHOLE selection. `selectedModelId` still wins — Simulator3D gates the
  // fixture gizmo on it so the two never fight over the same handles.
  const gizmoFixtures = useMemo(
    () => (selectedModelId ? [] : fixtures.filter(f => selectedFixtureIds.includes(f.id) || f.id === selectedFixtureId)),
    [selectedModelId, fixtures, selectedFixtureIds, selectedFixtureId],
  );
  const selectionCount = gizmoFixtures.length;
  // ⚠ InstancedLeds and FixtureLights still receive the FULL list: they index the canonical pixel
  // buffer by cumulative ledCount, so handing them a filtered array would silently misalign every
  // fixture after the first profiled one. Only the BODY is split.
  // ⚠ This deliberately keeps 'light-unresolved' OUT of the mover renderers AND out of here, so a
  // light we cannot describe is drawn by neither path rather than as a stray LED sphere — the two
  // predicates used to disagree about exactly that case. (Its buffer slot is untouched — see above.)
  const pixelFixtures = useMemo(
    () => fixtures.filter(f => lightState(f, fixtureProfiles) === 'pixel'),
    [fixtures, fixtureProfiles]);
  // Fixtures whose GDTF meshes turned out to be unusable. Held here rather than inside GdtfFixture so
  // the fallback is decided ONCE per fixture and the procedural body takes over cleanly.
  const [meshFailed, setMeshFailed] = useState<Set<string>>(() => new Set());
  const onMeshUnavailable = useCallback((id: string) => {
    setMeshFailed(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  // A profiled fixture is drawn from its REAL GDTF geometry when it has some, and from the
  // procedural base/yoke/head otherwise — which stays the permanent fallback, because a rig always
  // contains a fixture nobody has a GDTF for.
  const gdtfFixtures = useMemo(() => fixtures.filter((f) => {
    const p = profileOf(f, fixtureProfiles);
    return !!p?.geometry?.nodes.length && !meshFailed.has(f.id);
  }), [fixtures, fixtureProfiles, meshFailed]);
  const proceduralFixtures = useMemo(
    () => fixtures.filter(f => !gdtfFixtures.includes(f)),
    [fixtures, gdtfFixtures],
  );
  // Model gizmos only understand the three transform modes. 'select' is a fixture-marquee tool, so
  // models fall back to translate rather than the mode type leaking into their props.
  const transformMode = mode === 'select' ? 'translate' : mode;
  const models: SceneModel[] = scene3D.models ?? [];

  return (
    <div className="flex flex-col w-full h-full bg-surface-0">
      {/* Docked viewport header — transform-mode tools live in reserved chrome, not over the canvas
          (Houdini-style). The 3D view below renders clean with nothing painted on top. */}
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 bg-surface-1 border-b border-line-1">
        <ToolBtn active={mode === 'translate'} title="Move (W)" helpId="scene3d.gizmo-translate" onClick={() => setMode('translate')}><Move3d size={14} /></ToolBtn>
        <ToolBtn active={mode === 'rotate'} title="Rotate (E)" helpId="scene3d.gizmo-rotate" onClick={() => setMode('rotate')}><Rotate3d size={14} /></ToolBtn>
        <ToolBtn active={mode === 'scale'} title="Scale (R)" helpId="scene3d.gizmo-scale" onClick={() => setMode('scale')}><Maximize size={14} /></ToolBtn>
        <div className="w-px h-4 bg-line-1 mx-1" />
        <ToolBtn active={mode === 'select'} title="Box select (Q) — drag to select fixtures; hold Shift to add" helpId="scene3d.gizmo-select" onClick={() => setMode('select')}><BoxSelect size={14} /></ToolBtn>
        {selectionCount > 1 && (
          <span className="ml-2 text-mini text-fg-3 tabular-nums">{selectionCount} selected</span>
        )}
        {/* AN ARMED MODE WITH NO INDICATOR IS A TRAP: the next click would do something the operator
            has forgotten they asked for. Says what is being placed and how to get out. */}
        {placing && (
          <div className="ml-auto flex items-center gap-2 text-mini">
            <span className="text-accent">Click the floor to place <strong>{placing.label}</strong></span>
            <button
              onClick={() => placement.disarm()}
              className="px-1.5 py-0.5 rounded-sm border border-line-1 bg-surface-2 text-fg-2 hover:text-fg-1"
            >Esc to cancel</button>
          </div>
        )}
        {/* Calibration picking is an armed mode too, and snapping silently moves the point you clicked
            — so both have to be on screen. Same rule as `placing` above. */}
        {calibPickMode && !placing && (
          <div className="ml-auto flex items-center gap-1.5 text-mini text-fg-3">
            <span className="text-accent">Click the model to place an anchor</span>
            <span>· the <span style={{ color: '#ffd400' }}>amber dot</span> is the vertex it will snap to — solid means it captures the click · hold <strong>Alt</strong> for the exact surface point</span>
          </div>
        )}
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
        <AdaptiveClipping />
        <ViewerCameraBridge />
        <Exposure value={scene3D.exposure ?? 1} />
        <Lighting env={scene3D.environment} />
        {scene3D.reflectiveFloor && <ReflectiveFloor />}
        {scene3D.gridVisible !== false && <GroundGrid />}
        {/* Mounted ONLY while armed: an always-present pick plane would sit in front of the venue and
            swallow clicks meant for the models behind it. While armed, swallowing IS the job. */}
        {placing && <PlacementPlane onPlace={place} />}
        {/* Plugin-contributed 3D overlays (e.g. LiDAR blob viz). Each plugin registers a scene-viz
            component + an `enabled` gate; the host stays agnostic of what they draw. */}
        {/* `silent` — this is INSIDE the R3F <Canvas>, where a DOM fallback is illegal (the same
            reason ModelBoundary renders null). A throwing scene-viz plugin drops its own objects and
            the rest of the scene keeps rendering, instead of taking the canvas with it. */}
        {sceneVizRegistry.all().map((v) => (v.enabled?.(scene3D) ?? true)
          ? <ErrorBoundary key={v.id} scope={`plugin:${v.id}`} pluginId={v.id} silent>
              <v.Component scene3D={scene3D} />
            </ErrorBoundary>
          : null)}
        {models.map((m) => m.kind === 'plane' ? (
          <PlaneObject
            key={m.id}
            model={m}
            selected={selectedModelId === m.id}
            mode={transformMode}
            onSelect={(id) => onSelectModel?.(id)}
            onCommit={(id, t) => onCommitModel?.(id, t)}
            onRecordHistory={onRecordHistory}
            calibPickMode={calibPickMode}
            onCalibPick={onCalibPick}
          />
        ) : modelUrls[m.id] ? (
          <ModelBoundary key={m.id}>
            <Suspense fallback={null}>
              <ModelObject
                model={m}
                url={modelUrls[m.id]}
                selected={selectedModelId === m.id}
                mode={transformMode}
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
            place them. Cyan + number match the camera-preview markers, and so does their SIZE: see
            AnchorMarker on why a world-sized marker made a small mesh unpickable. Clickable only when
            an edit handler is wired (markerless), so selecting from the 3D side mirrors selecting from
            the camera/list; display-only in the board flow. */}
        {activePicks.map((p, i) => (
          <AnchorMarker key={`apick-${i}`} world={p.world} index={i} selected={selectedPick === i} onSelect={onSelectPick} />
        ))}
        {/* The vertex the next click will snap to. Mounted only while picking — see vertexSnap.ts. */}
        {calibPickMode && <SnapCursor />}
        <FixtureLights fixtures={fixtures} scene3D={scene3D} />
        {/* The housing goes in FIRST so the LEDs draw over it. It is also the click target — see
            FixtureBodies: a 12mm sphere is not something an operator can reliably hit. */}
        {/* Pixel fixtures get a bar sized from their LED run; PROFILED fixtures get an articulated
            base/yoke/head instead, because a moving head is not a strip and must visibly aim.
            Split by list rather than inside the components so each keeps its instanceId → fixture
            mapping intact. */}
        <FixtureBodies fixtures={pixelFixtures} selectedIds={selectedFixtureIds} onSelectFixture={onSelectFixture} />
        {gdtfFixtures.map((f) => (
          <GdtfFixture
            key={f.id}
            fixture={f}
            profile={fixtureProfiles.get(f.profileId!)!}
            selected={selectedFixtureIds.includes(f.id)}
            onSelect={onSelectFixture}
            onUnavailable={onMeshUnavailable}
          />
        ))}
        <MoverBodies fixtures={proceduralFixtures} profiles={fixtureProfiles} selectedIds={selectedFixtureIds} onSelectFixture={onSelectFixture} />
        {/* Tier 1 of the beam budget: every lit fixture's volumetric cone, in ONE draw call. */}
        <Beams fixtures={fixtures} profiles={fixtureProfiles} hazeDensity={scene3D.hazeDensity} />
        {/* Tier 2: a few REAL spotlights so the brightest beams actually light the room. Capped —
            see MoverLights on why lights are not additive in cost. */}
        <MoverLights fixtures={fixtures} profiles={fixtureProfiles} gain={scene3D.lightIntensity} />
        <InstancedLeds fixtures={fixtures} onSelectFixture={onSelectFixture} />
        {mode !== 'select' && <FixtureGizmo
          fixtures={gizmoFixtures}
          mode={mode}
          onRecordHistory={onRecordHistory}
          onCommit={onCommitFixture3D}
        />}
        {mode === 'select' && onSelectFixtures && (
          <MarqueePicker
            fixtures={fixtures}
            selectedIds={selectedFixtureIds}
            onRect={setMarquee}
            onSelect={(ids) => onSelectFixtures(ids)}
          />
        )}
        {/* The marquee owns the left button while it is active, so orbit keeps only pan/zoom. */}
        <OrbitControls makeDefault enableRotate={mode !== 'select'} />
        <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
          <GizmoViewport labelColor="white" axisHeadScale={1} />
        </GizmoHelper>
        <EffectComposer>
          <Bloom luminanceThreshold={0.1} intensity={0.6} mipmapBlur />
        </EffectComposer>
      </Canvas>

      {marquee && (
        <div
          className="pointer-events-none absolute border border-accent bg-accent/15"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}
      </div>
    </div>
  );
};

export default Simulator3D;
