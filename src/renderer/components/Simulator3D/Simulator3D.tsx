import React, { Suspense, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import type * as THREE from 'three';
import { Move3d, Rotate3d, Maximize, BoxSelect, Video, Globe, Box, Magnet } from 'lucide-react';
import { Fixture, Vec3, Euler3, FixtureProfile } from '../../types';

// One shared empty map, so a scene with no profiled fixtures allocates nothing per render.
const EMPTY_PROFILES: ReadonlyMap<string, FixtureProfile> = new Map();
import { lightState, profileOf } from '../../services/fixtureKind';
import * as placement from '../../services/fixturePlacement';
import { PlacementPlane } from './PlacementPlane';
import { Scene3D, SceneModel, defaultScene3D, ProjectorCalibration } from '../../../../shared/protocol';
import { ProjectorFrustum } from './ProjectorFrustum';
import { cameraPose, glProjectionMatrix, resolveProjectedScene } from '@artlux/plugin-calibration/renderer';
import { AnchorMarker } from './AnchorMarker';
import { SnapCursor } from './SnapCursor';
import { setSnapHover, getSnapHover } from './vertexSnap';
import { registerViewerCamera, getViewerCamera } from './viewerCamera';
import { InstancedLeds } from './InstancedLeds';
import { FixtureBodies } from './FixtureBodies';
import { FixtureGizmo } from './FixtureGizmo';
import { GizmoReadout } from './GizmoReadout';
import { nudgeUpdates, nudgeStep, type NudgeDir } from './nudge';
import { MarqueePicker, type MarqueeRect } from './MarqueePicker';
import { MoverBodies } from './MoverBodies';
import { GdtfFixture } from './GdtfFixture';
import { Beams } from './Beams';
import { MoverLights } from './MoverLights';
import { FixtureLights } from './FixtureLights';
import { ModelObject, ModelTransform } from './ModelObject';
import { PlaneObject } from './PlaneObject';
import { ProjectorDepthPass } from './projectorDepth';
import { ProjectorBakePass } from './projectorBake';
import { ModelBoundary } from './ModelBoundary';
import { GroundGrid } from './GroundGrid';
import { ReflectiveFloor } from './ReflectiveFloor';
import { Lighting } from './Lighting';
import { sceneVizRegistry } from '../../host/registries';
import {
  useRenderScale, useMaxFps, useGizmoSpace, getGizmoSpace, setGizmoSpace,
  useSnap, getSnap, setSnap, SNAP_MOVE_CHOICES, SNAP_ROTATE_CHOICES, SNAP_SCALE_CHOICES,
} from '../../services/scene3dQuality';
import { FrameRateCap } from './FrameRateCap';
import { glProp, wantsWebGPU } from './renderer3d';
import { AxisTriad } from './AxisTriad';
import { ErrorBoundary } from '../ErrorBoundary';
import { Tooltip } from '../ui/Tooltip';
import { help } from '../../services/helpBus';
import { keymap } from '../../shortcuts/keymapStore';
import { formatChord, eventToChord } from '../../shortcuts/chord';

/** " (W)" for a bound action, "" for one the operator has unbound. Read live, never hardcoded. */
function keyHint(id: string): string {
  const c = keymap.resolve(id)[0];
  return c ? ` (${formatChord(c)})` : '';
}

// Streams the dragged anchor's new position while a marker drag is live: the venue meshes update the
// snap-hover channel on every pointermove (ModelObject/PlaneObject), so the drag target is simply
// "whatever the cursor snaps to right now" — identical preview + snap rules as placing a new anchor.
// Skips unchanged frames; the workspace throttles the store/solve behind onMove.
const PickDragRunner: React.FC<{ index: number; onMove: (i: number, world: [number, number, number]) => void }> = ({ index, onMove }) => {
  const last = React.useRef('');
  useFrame(() => {
    const h = getSnapHover();
    if (!h) return; // cursor is off the venue — the pick stays where it last was
    const key = `${h.point.x},${h.point.y},${h.point.z}`;
    if (key === last.current) return;
    last.current = key;
    onMove(index, [h.point.x, h.point.y, h.point.z]);
  });
  return null;
};

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
  onCommitFixture3D: (updates: Array<{ id: string; position3D?: Vec3; rotation3D?: Euler3; scaleXYZ?: [number, number, number]; scale3D?: number }>) => void;
  onCommitModel?: (id: string, t: ModelTransform) => void;
  onModelNaturalSize?: (id: string, maxDim: number) => void;
  onSceneConfig?: (patch: Partial<Scene3D>) => void;
  onRecordHistory: () => void;
  /** Projector calibration: pose-pick mode + frustum overlays. */
  calibPickMode?: boolean;
  onCalibPick?: (world: [number, number, number], source?: string) => void;
  projectorCalibs?: Array<{ surfaceId: string; name?: string; calibration: ProjectorCalibration }>;
  activePicks?: Array<{ world: [number, number, number] }>;
  selectedPick?: number | null;                       // highlight the correspondence being edited
  onSelectPick?: (i: number) => void;                 // click a numbered marker → select it for editing
  /** Drag a numbered marker across the venue to MOVE its pick (vertex-snapped, streamed live). */
  onMovePick?: (i: number, world: [number, number, number]) => void;
  /** Released — the holder of the provisional position commits it (see calibWorkspace.endPickDrag). */
  onMovePickEnd?: () => void;
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

// NO TONE MAPPING — see the Canvas's `flat` prop below.

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

// LOOK THROUGH A CALIBRATED PROJECTOR (Scene3D.viewFrom). Drives the viewport camera from the solved
// calibration each frame — the same pose + exact intrinsic projection the projector window itself
// uses (cvCamera), so what you see here is what that projector covers, including the content on the
// mesh. Everything else in the scene keeps working: picking, gizmos and the calibration overlays all
// read this camera.
//
// THE PROJECTION IS REFITTED, NOT REUSED VERBATIM. The projector's matrix maps its own raster; a
// pane with a different aspect would stretch the image and quietly lie about coverage. Scaling the
// axis that has spare room letterboxes it instead — the picture stays the projector's, with slack
// around it (the toolbar draws the raster frame so the slack is legible as slack).
const ProjectorView: React.FC<{ calibration: ProjectorCalibration }> = ({ calibration }) => {
  useFrame(({ camera, size }) => {
    const { position, quaternion } = cameraPose(calibration.rotation, calibration.translation as [number, number, number]);
    camera.position.set(position[0], position[1], position[2]);
    camera.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
    camera.updateMatrixWorld(true);
    const [rw, rh] = calibration.imageSize;
    const m = glProjectionMatrix(calibration.intrinsics, calibration.imageSize, 0.05, 500);
    if (rw > 0 && rh > 0 && size.width > 0 && size.height > 0) {
      const rasterAR = rw / rh, viewAR = size.width / size.height;
      if (viewAR > rasterAR) { const s = rasterAR / viewAR; m[0] *= s; m[8] *= s; } // pane wider → fit height
      else { const s = viewAR / rasterAR; m[5] *= s; m[9] *= s; }                    // pane taller → fit width
    }
    camera.projectionMatrix.fromArray(m);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  });
  return null;
};

// The viewport's rate cap lives in FrameRateCap.tsx — SHARED with the calibrated projector's scene,
// which can saturate this machine the same way. Its own header carries the why and the vsync-rounding
// subtlety. What was measured HERE, for this Canvas:
//
// The throttle is exact: WebGPU presents fall linearly with the setting (60/s uncapped → 25/s at
// 10 fps; the 10-against-15 ratio came out 0.675 against a predicted 0.667) and the scene keeps
// animating at every step. But with the pane at 705x217 and the viewport already on WebGPU, capping did
// NOT measurably raise the engine's own rate: 20.4/20.6 fps uncapped against 21.2/24.0 capped is inside
// the run-to-run noise, and one pair of runs collapsed to 8.1 fps at BOTH settings. Read that as the
// WebGPU swap having already bought back what this would have. The lever still matters where the
// viewport is genuinely expensive — a maximized pane, a hiDPI panel, a machine forced onto WebGL —
// which is why it defaults to uncapped instead of guessing a value on the operator's behalf.

const AdaptiveClipping: React.FC<{ off?: boolean }> = ({ off }) => {
  useFrame(({ camera, controls }) => {
    if (off) return; // a projector view owns the projection matrix — see ProjectorView
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
  fixtureProfiles = EMPTY_PROFILES, onSelectFixture, onSelectFixtures, onSelectModel, onCommitFixture3D, onCommitModel, onModelNaturalSize, onRecordHistory, onSceneConfig,
  calibPickMode = false, onCalibPick, projectorCalibs = [], activePicks = [], selectedPick = null, onSelectPick, onMovePick, onMovePickEnd,
  paused = false,
}) => {
  const [mode, setMode] = useState<Mode>('translate');
  // ── TOOL KEYS ─────────────────────────────────────────────────────────────────────────────
  // W/E/R/Q, scoped to this viewport by HOVER — the same gate the timeline uses, and the only one
  // available here: the canvas is not a focusable element and clicking it is a selection gesture, so
  // there is nothing to focus. Hover is tracked on a ref rather than in state because a bare pointer
  // crossing must not re-render a tree that owns a WebGL context.
  //
  // These are single unmodified letters, which is only safe because of the scope: bare W/E/R/Q are
  // free everywhere else in the app, and both this and the timeline's block bail out while an input is
  // focused, so typing a fixture name never reaches here.
  const hovered = useRef(false);
  // What the key handler needs to read at press time. Mirrored into a ref, not closed over: the
  // listener attaches once (a re-registering window listener per render is its own bug), and a nudge
  // has to act on the CURRENT selection and step, not the ones that existed when it mounted.
  const keyCtx = useRef<{
    fixtures: Fixture[]; mode: Mode; step: number;
    commit: Props['onCommitFixture3D']; record: () => void;
  }>({ fixtures: [], mode: 'translate', step: 0.01, commit: () => {}, record: () => {} });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hovered.current) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (keymap.matches(e, 'scene3d.modeTranslate')) setMode('translate');
      else if (keymap.matches(e, 'scene3d.modeRotate')) setMode('rotate');
      else if (keymap.matches(e, 'scene3d.modeScale')) setMode('scale');
      else if (keymap.matches(e, 'scene3d.modeSelect')) setMode('select');
      else if (keymap.matches(e, 'scene3d.gizmoSpace')) setGizmoSpace(getGizmoSpace() === 'world' ? 'local' : 'world');
      else if (keymap.matches(e, 'scene3d.toggleSnap')) setSnap({ on: !getSnap().on });
      else {
        // NUDGE. One press = one commit and one history entry, exactly like the projector's warp
        // nudge — holding a key repeats, and each repeat is its own undo step, which is the behaviour
        // an operator can predict without being told.
        const dirs: Array<[string, NudgeDir]> = [
          ['scene3d.nudgeLeft', 'left'], ['scene3d.nudgeRight', 'right'],
          ['scene3d.nudgeFwd', 'fwd'], ['scene3d.nudgeBack', 'back'],
          ['scene3d.nudgeUp', 'up'], ['scene3d.nudgeDown', 'down'],
        ];
        // Shift/Alt are ORTHOGONAL step modifiers, not part of the binding, so match with any leading
        // modifier stripped — the same trick the timeline's ripple-delete uses.
        const chord = eventToChord(e).replace(/^(?:Shift|Alt)\+/, '');
        const hit = dirs.find(([id]) => keymap.resolve(id).includes(chord));
        if (!hit) return;
        const c = keyCtx.current;
        if (c.mode === 'select' || !c.fixtures.length) return;
        const updates = nudgeUpdates(
          c.fixtures, hit[1], nudgeStep(c.step, e), c.mode, getViewerCamera(),
        );
        if (!updates.length) return;   // e.g. PageUp in rotate mode — no meaning, so no keystroke eaten
        e.preventDefault();            // arrows would otherwise scroll the workspace behind the canvas
        c.record();
        c.commit(updates);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Per-machine render scale (Preferences › GPU rendering). Subscribed here rather than passed down,
  // so a slider drag re-renders this component and nothing else — see services/scene3dQuality.
  const renderScale = useRenderScale();
  const maxFps = useMaxFps();
  // Which axes the gizmo handles follow. Per-machine (see scene3dQuality) — a grip preference, not
  // anything about the show, so it must not travel inside a project.
  const gizmoSpace = useGizmoSpace();
  const snap = useSnap();
  // The renderer is built ONCE, at Canvas mount. Memoized with no deps on purpose: r3f only reads `gl`
  // when it has no renderer yet, and handing it a new factory later would do nothing but churn.
  const [glFallback, setGlFallback] = useState<string | null>(null);
  const glConfig = useMemo(() => glProp(setGlFallback), []);
  const webgpuSpike = useMemo(() => wantsWebGPU(), []);
  // Leaving pick mode drops the snap preview. It lives outside React (pointer-rate channel), so
  // unmounting SnapCursor would otherwise leave a stale vertex behind for the next session.
  useEffect(() => { if (!calibPickMode) setSnapHover(null); return () => setSnapHover(null); }, [calibPickMode]);
  // ── DRAG-A-PICK ───────────────────────────────────────────────────────────────────────────
  // Direct manipulation of a calibration anchor: press ON its marker and drag across the venue —
  // the pick follows the snap-hover position (vertex-snapped, same preview as placing). Grabbing
  // the marker IS the consent, so this needs no armed mode (the trap was selection-implies-move,
  // not drag-implies-move). Orbit is suspended for the gesture; pointerup anywhere ends it.
  const [dragPick, setDragPick] = useState<number | null>(null);
  useEffect(() => {
    if (dragPick == null) return;
    const up = () => { setDragPick(null); onMovePickEnd?.(); };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragPick]);
  useEffect(() => { if (!calibPickMode) setDragPick(null); }, [calibPickMode]);
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
  // The stored projector viewpoint (Scene3D.viewFrom), resolved against the calibrated outputs. A
  // saved id whose output was un-calibrated or deleted simply falls back to the editor camera rather
  // than freezing the view — the selector then shows "Editor camera" and the scene is orbitable again.
  const viewFrom = useMemo(
    () => (scene3D.viewFrom ? projectorCalibs.find((p) => p.surfaceId === scene3D.viewFrom) ?? null : null),
    [scene3D.viewFrom, projectorCalibs]);
  // Model gizmos only understand the three transform modes. 'select' is a fixture-marquee tool, so
  // models fall back to translate rather than the mode type leaking into their props.
  const transformMode = mode === 'select' ? 'translate' : mode;
  // Refresh what the key handler reads. The nudge step is the SNAP step when snapping is on, so the
  // header's one control governs both ways of moving a fixture exactly; with the magnet off it falls
  // back to a fine 10 mm / 1°, which is a nudge rather than a jump.
  keyCtx.current = {
    fixtures: gizmoFixtures,
    mode,
    step: mode === 'rotate' ? (snap.on ? snap.rotate : 1) : (snap.on ? snap.move : 0.01),
    commit: onCommitFixture3D,
    record: onRecordHistory,
  };
  // Resolve any LIVE projected-mapping source (a model's uvProjFrom → that projector's solved matrix)
  // before rendering. The same call runs at App's scene push for the projector windows, so the editor
  // and the wall are driven by one function rather than two implementations of the same matrix.
  const models: SceneModel[] = useMemo(
    () => resolveProjectedScene(scene3D, projectorCalibs).models ?? [],
    [scene3D, projectorCalibs]);
  // Does the venue want SIMULATED fixture lighting at all? Absent gain means 1 (the historical
  // default), so only an explicit 0 turns the real lights off — see the two mount sites below.
  const venueLit = (scene3D.lightIntensity ?? 1) > 0;

  return (
    <div
      className="flex flex-col w-full h-full bg-surface-0"
      // The tool keys above answer only while the pointer is over this viewport. Ref writes, not state.
      onPointerEnter={() => { hovered.current = true; }}
      onPointerLeave={() => { hovered.current = false; }}
    >
      {/* Docked viewport header — transform-mode tools live in reserved chrome, not over the canvas
          (Houdini-style). The 3D view below renders clean with nothing painted on top. */}
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 bg-surface-1 border-b border-line-1">
        {/* The key in each tooltip is READ FROM THE KEYMAP, never spelled out here. A hardcoded "(W)"
            is how these tooltips came to promise four keys that nothing was listening for, and it
            would go wrong a second way now that they are rebindable. */}
        <ToolBtn active={mode === 'translate'} title={`Move${keyHint('scene3d.modeTranslate')}`} helpId="scene3d.gizmo-translate" onClick={() => setMode('translate')}><Move3d size={14} /></ToolBtn>
        <ToolBtn active={mode === 'rotate'} title={`Rotate${keyHint('scene3d.modeRotate')}`} helpId="scene3d.gizmo-rotate" onClick={() => setMode('rotate')}><Rotate3d size={14} /></ToolBtn>
        <ToolBtn active={mode === 'scale'} title={`Scale${keyHint('scene3d.modeScale')}`} helpId="scene3d.gizmo-scale" onClick={() => setMode('scale')}><Maximize size={14} /></ToolBtn>
        {/* WORLD ⇄ OBJECT. Not a ToolBtn pair: this is one setting with two states, and the label is
            the state it is IN — a rigger reads "Object" and knows the handles are on the fixture.
            Only the axes change; the pivot stays on the middle of the selection (see FixtureGizmo). */}
        <ToolBtn
          active={gizmoSpace === 'local'}
          title={`Handle axes: ${gizmoSpace === 'local' ? 'the selected fixture\'s own' : "the room's"}${keyHint('scene3d.gizmoSpace')} — the pivot stays on the selection's centre either way`}
          helpId="scene3d.gizmo-space"
          onClick={() => setGizmoSpace(gizmoSpace === 'local' ? 'world' : 'local')}
        >
          {gizmoSpace === 'local' ? <Box size={14} /> : <Globe size={14} />}
        </ToolBtn>
        <span className="text-micro text-fg-3 -ml-0.5 mr-0.5 select-none">{gizmoSpace === 'local' ? 'Object' : 'World'}</span>
        <div className="w-px h-4 bg-line-1 mx-1" />
        {/* SNAP — a magnet and the step for whichever gesture is armed. The step select follows the
            mode rather than showing three of them: only one can apply to the drag you are about to
            make, and a header is not a preferences page. */}
        <ToolBtn
          active={snap.on}
          title={`Snap ${snap.on ? 'on' : 'off'}${keyHint('scene3d.toggleSnap')} — hold Ctrl during a drag to invert it`}
          helpId="scene3d.gizmo-snap"
          onClick={() => setSnap({ on: !snap.on })}
        >
          <Magnet size={14} />
        </ToolBtn>
        <select
          value={String(mode === 'rotate' ? snap.rotate : mode === 'scale' ? snap.scale : snap.move)}
          onChange={(e) => setSnap(
            mode === 'rotate' ? { rotate: Number(e.target.value) }
              : mode === 'scale' ? { scale: Number(e.target.value) }
                : { move: Number(e.target.value) },
          )}
          title="Step a snapped drag — and an arrow-key nudge — lands on"
          className={`bg-surface-0 border rounded px-1 py-0.5 text-micro focus:outline-none ${snap.on ? 'border-line-2 text-fg-1' : 'border-line-1 text-fg-3'}`}
        >
          {mode === 'rotate'
            ? SNAP_ROTATE_CHOICES.map((v) => <option key={v} value={v}>{v}°</option>)
            : mode === 'scale'
              ? SNAP_SCALE_CHOICES.map((v) => <option key={v} value={v}>{v}×</option>)
              : SNAP_MOVE_CHOICES.map((v) => <option key={v} value={v}>{v < 1 ? `${v * 1000} mm` : `${v} m`}</option>)}
        </select>
        <div className="w-px h-4 bg-line-1 mx-1" />
        <ToolBtn active={mode === 'select'} title={`Box select${keyHint('scene3d.modeSelect')} — drag to select fixtures; hold Shift to add`} helpId="scene3d.gizmo-select" onClick={() => setMode('select')}><BoxSelect size={14} /></ToolBtn>
        {/* LOOK THROUGH A PROJECTOR. Only calibrated outputs can offer a viewpoint, so the control
            appears once one exists rather than sitting there empty. The choice is stored on the
            scene (Scene3D.viewFrom), so it is still the view you left when the project reopens. */}
        {projectorCalibs.length > 0 && (
          <>
            <div className="w-px h-4 bg-line-1 mx-1" />
            <Video size={13} className={viewFrom ? 'text-accent' : 'text-fg-3'} />
            <select
              value={viewFrom?.surfaceId ?? ''}
              onChange={(e) => onSceneConfig?.({ viewFrom: e.target.value || undefined })}
              title="Render the scene from a calibrated projector's own viewpoint"
              className={`bg-surface-0 border rounded px-1 py-0.5 text-micro focus:outline-none ${viewFrom ? 'border-accent text-fg-1' : 'border-line-1 text-fg-2'}`}
            >
              <option value="">Editor camera</option>
              {projectorCalibs.map((p) => <option key={p.surfaceId} value={p.surfaceId}>{p.name ?? 'Projector'}</option>)}
            </select>
          </>
        )}
        {selectionCount > 1 && (
          <span className="ml-2 text-mini text-fg-3 tabular-nums">{selectionCount} selected</span>
        )}
        {/* The live drag readout. Pushed right by its own `ml-auto`; empty (and so invisible) between
            gestures. It writes its own text node — see GizmoReadout on why it must not re-render. */}
        {!placing && !calibPickMode && <GizmoReadout />}
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
        // 'never' covers BOTH reasons this viewport stops driving itself: hidden (paused), and capped
        // — in which case <FrameRateCap> below is what advances it. Uncapped and visible is r3f's
        // ordinary 'always', i.e. exactly what this has always done.
        frameloop={paused || maxFps > 0 ? 'never' : 'always'}
        // NOT `[1, 2]`. That range let a hiDPI panel render this viewport at twice the linear
        // resolution — four times the pixels, and four times every per-fragment cost in it (the
        // ground grid's full-screen shader plane, additive beam overdraw, every textured screen) —
        // with no way for an operator on a weak GPU to decline. It is now a per-machine preference
        // that defaults to 1; see services/scene3dQuality for why it is a pref and not a Scene3D field.
        dpr={renderScale}
        // `flat` = NO TONE MAPPING, and it is r3f's own switch for it: without it r3f installs
        // ACESFilmic. That matters more than it looks, because @react-three/postprocessing's
        // EffectComposer forces NoToneMapping while mounted and RESTORES whatever it found on
        // unmount — so with the default, toggling Glow off would have swung the whole viewport
        // through a tone curve as a side effect of a library's lifecycle, three files away. With
        // `flat` both states are NoToneMapping and the composer's save/restore is a no-op.
        //
        // Nothing here needs a tone curve: LEDs, beams and content-bearing meshes are all unlit
        // MeshBasicMaterial rendered at the colour they were authored in, and what an operator is
        // judging is whether the picture matches the wall — a filmic roll-off on the highlights
        // would actively lie about that. `Scene3D.exposure` was removed with this (see protocol.ts).
        flat
        // WebGL config object, or — when this machine opted into the WebGPU spike — an async factory
        // r3f awaits so `renderer.init()` can complete. See renderer3d.ts for the flag and the why.
        gl={glConfig}
        camera={{ position: [0, 1.2, 3], fov: 50 }}
        onPointerMissed={() => { onSelectFixture(''); onSelectModel?.(null); }}
      >
        <color attach="background" args={['#0d0d0d']} />
        {/* Not while paused: a hidden canvas must draw nothing at all, which is the whole point of the
            `paused` prop. Mounting it capped-but-hidden would redraw a zero-width pane at `maxFps`. */}
        {maxFps > 0 && !paused && <FrameRateCap hz={maxFps} />}
        <AdaptiveClipping off={!!viewFrom} />
        {viewFrom && <ProjectorView calibration={viewFrom.calibration} />}
        <ViewerCameraBridge />
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
        {/* Renders the projector depth maps that make projected mapping occlude, once per frame and
            only when the venue or a projector actually moved. Must be INSIDE the Canvas — it borrows
            this renderer and this scene. Without it the models still register, nothing ever draws,
            and occlusion is silently off. See projectorDepth.ts. */}
        <ProjectorDepthPass />
        {/* Services one-shot calibration bakes — see projectorBake.ts. Without it every bake times
            out into the CPU raycast fallback, silently and at a fortieth of the resolution. */}
        <ProjectorBakePass />
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
        {/* The frustum you are looking THROUGH is skipped: from its own apex it collapses to lines
            radiating out of the camera, drawn over everything it is meant to help you judge. */}
        {projectorCalibs.filter((p) => p.surfaceId !== viewFrom?.surfaceId).map(({ surfaceId, calibration }) => (
          <ProjectorFrustum key={surfaceId} calibration={calibration} />
        ))}
        {/* Calibration anchor markers — one numbered marker per placed correspondence (board pose picks
            or Auto-Align anchors). Rendered independently of a solved calibration so they appear as you
            place them. Cyan + number match the camera-preview markers, and so does their SIZE: see
            AnchorMarker on why a world-sized marker made a small mesh unpickable. Clickable only when
            an edit handler is wired (markerless), so selecting from the 3D side mirrors selecting from
            the camera/list; display-only in the board flow. */}
        {activePicks.map((p, i) => (
          // `live` on the dragged one: its committed world point stays put until release now (the
          // document is written once, not per tick), so the marker follows the snap cursor itself.
          <AnchorMarker key={`apick-${i}`} world={p.world} index={i} selected={selectedPick === i} onSelect={onSelectPick}
            live={dragPick === i}
            onDragStart={calibPickMode && onMovePick ? ((idx) => { setDragPick(idx); onSelectPick?.(idx); }) : undefined} />
        ))}
        {dragPick != null && onMovePick && <PickDragRunner index={dragPick} onMove={onMovePick} />}
        {/* The vertex the next click will snap to. Mounted only while picking — see vertexSnap.ts. */}
        {calibPickMode && <SnapCursor />}
        {/* A LIGHT AT INTENSITY 0 IS NOT A FREE LIGHT. three forward-renders every MOUNTED light for
            every fragment of every lit material and the intensity only scales the result, so at
            "Light gain 0" the 12 point lights here and the 8 spots in MoverLights were still being
            evaluated per pixel, and still forcing a lights-heavy shader permutation on every
            MeshStandardMaterial in the venue. Unmounting them at zero gain is provably free of visual
            change — both components multiply by this exact gain — and it is the single biggest saving
            available to a scene that drives its look from content rather than from simulated fixtures.
            The cost of the switch is one shader recompile when the gain leaves or returns to 0. */}
        {venueLit && <FixtureLights fixtures={fixtures} scene3D={scene3D} />}
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
        <Beams
          fixtures={fixtures}
          profiles={fixtureProfiles}
          hazeDensity={scene3D.hazeDensity}
          // The heads being aimed get the whole diagram; see Beams' `selectedIds`.
          selectedIds={selectedFixtureIds}
          cones={scene3D.beamCones !== false}
        />
        {/* Tier 2: a few REAL spotlights so the brightest beams actually light the room. Capped —
            see MoverLights on why lights are not additive in cost — and skipped outright at zero
            gain, for the reason spelled out on FixtureLights above. */}
        {venueLit && <MoverLights fixtures={fixtures} profiles={fixtureProfiles} gain={scene3D.lightIntensity} />}
        <InstancedLeds fixtures={fixtures} onSelectFixture={onSelectFixture} />
        {mode !== 'select' && <FixtureGizmo
          fixtures={gizmoFixtures}
          mode={mode}
          space={gizmoSpace}
          // The handles orient to the fixture the operator clicked LAST — the one they are thinking in
          // the frame of — not to whichever happens to sort first in the selection.
          activeId={selectedFixtureId}
          snap={snap}
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
        {/* Suspended (not unmounted) during a pick drag — the same gesture must not also orbit — and
            while looking through a projector, whose camera is driven from the calibration. */}
        <OrbitControls makeDefault enabled={dragPick == null && !viewFrom} enableRotate={mode !== 'select'} />
        {/* drei's GizmoViewport builds its axis-head sprites through `gl.capabilities.getMaxAnisotropy()`,
            which only a WebGLRenderer has — on the WebGPU path it throws during render, and because that
            happens inside the Canvas it takes the whole viewport down rather than just the widget. The
            GizmoHelper frame itself is fine on both, so only the viewport contents are swapped. */}
        <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
          {webgpuSpike ? <AxisTriad /> : <GizmoViewport labelColor="white" axisHeadScale={1} />}
        </GizmoHelper>
        {/* GLOW — opt-in, and the composer is skipped ENTIRELY rather than left mounted with the
            Bloom disabled. Mounting an EffectComposer at all costs a full-screen render-to-texture
            plus a copy back every frame even when it does nothing, which is the same reasoning that
            put `needsBlendPass` in front of the projector window's composer. Bloom itself adds the
            mipmap blur chain on top, at viewport resolution.
            It flatters a rig of LEDs and beams; it does nothing for a venue mesh carrying content,
            which is what the projection-mapping workflow spends its time looking at. */}
        {/* @react-three/postprocessing v3 is a WebGL library — its EffectComposer reaches for
            WebGLRenderTarget and the renderer's GL state directly, so under the WebGPU spike it is
            skipped rather than mounted and left to throw inside the canvas. Porting Glow means three's
            own PostProcessing + a TSL bloom node; it is opt-in and off by default, so it is not what
            blocks the swap. */}
        {scene3D.glow === true && !webgpuSpike && (
          <EffectComposer>
            <Bloom luminanceThreshold={0.1} intensity={0.6} mipmapBlur />
          </EffectComposer>
        )}
      </Canvas>

      {marquee && (
        <div
          className="pointer-events-none absolute border border-accent bg-accent/15"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}

      {/* SAY SO ONLY WHEN THIS IS NOT THE NORMAL PATH. WebGPU is the default now, so a permanent badge
          would be chrome nobody reads — but BOTH ways of ending up on WebGL stay loud, for the same
          reason the Stage banners the WebGL mapper fallback: on this hardware WebGL puts the GPU
          process at 99.8% occupancy for a scene of two planes, so "why is the viewport slow" must be
          answerable by looking at it. `glFallback` is the machine's answer (no adapter, init threw);
          `!webgpuSpike` is the operator's (Preferences ▸ GPU rendering, or the localStorage opt-out). */}
      {(glFallback || !webgpuSpike) && (
        <div className="pointer-events-none absolute left-2 bottom-2 px-1.5 py-0.5 rounded-sm border num text-micro bg-warn/15 border-warn text-warn">
          {glFallback ? `3D: WebGL (WebGPU failed — ${glFallback})` : '3D: WebGL (forced)'}
        </div>
      )}
      </div>
    </div>
  );
};

export default Simulator3D;
