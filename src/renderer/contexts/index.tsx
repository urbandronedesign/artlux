// Core workspace contexts + the panels they are made of.
//
// This is the one place the host declares its own workbenches, through exactly the same SDK
// contracts a plugin uses (`panelRegistry.register` + `contextRegistry.register`). There is no
// privileged core path: if a context can be expressed here, a plugin can express the same thing.
//
// A context names panels by ID and owns no components — so `contextRegistry.extend('tracking', …)`
// from a plugin adds to a workbench without touching this file. Contexts are SOFT: they set the
// default workbench, they never lock a function away.

import React from 'react';
import {
  Layers, Box, Users, SlidersHorizontal, Image as ImageIcon, Film, Lightbulb, MonitorPlay, Crosshair, Clapperboard, Music, Radar, Radio, Activity, Gauge, Hash, Plus, RefreshCw, Workflow, Network, Settings, FolderOpen, Save, Trash2, Copy, Grid3x3, Cable, Play,
} from 'lucide-react';
import { panelRegistry, contextRegistry } from '../host/registries';
import { SCENE_3D_VIEWPORT } from '../components/shell/WorkspaceShell';
import { goToContext } from './nav';
import {
  SurfacesPanel, SurfacesHeaderActions, FixturesPanel, FixturesHeaderActions,
  GroupsPanel, GroupsHeaderActions, GlobalParamsPanel,
} from './panels/browser';
import {
  SurfaceContentPanel, SurfaceTransformPanel, FixtureMappingPanel, FixtureSegmentsPanel,
  FixtureOutputPanel, FixtureRoutingPanel, FixtureLayout3DPanel,
} from './panels/inspector';
import { MediaBrowserPanel, FixtureEditorDock, MonitorDock, PerfDock, RoutingDock, StateMachineViewport } from './panels/adapters';
import { ProgramPreviewPanel, ProgramMonitorViewport, OutputsPreviewPanel } from './panels/preview';
import {
  ModelsPanel, ModelsHeaderActions, Scene3DFixturesPanel, ModelTransformPanel, SceneLightingPanel,
} from './panels/scene3d';

// ── Viewport ids ─────────────────────────────────────────────────────────────────────────────
// These four are PERSISTENT: App mounts them once and hands them to the shell as elements, which is
// what keeps `Stage` (the Art-Net source) and the single `TimelinePanel` alive across every context
// switch. They are ids only here — nothing in this file imports them.
export const VIEWPORT_STAGE_2D = 'core.viewport.stage2d';
// Re-exported from the shell, NEVER re-declared. The shell pins this one viewport to the right pane
// and filters it OUT of the left-pane list by comparing against its own constant — so if these two ids
// ever drifted, the 3D scene would render in BOTH panes: two <Simulator3D> mounts, two WebGL contexts,
// two render loops fighting over the same scene. One typo, silent, and only visible as halved frame
// rate. There is exactly one string.
export const VIEWPORT_SCENE_3D = SCENE_3D_VIEWPORT;
export const VIEWPORT_TIMELINE = 'core.viewport.timeline';
export const VIEWPORT_SCENES = 'core.viewport.scenes';
export const VIEWPORT_OUTPUTS = 'core.viewport.outputs';
// Not persistent — a monitor is cheap to remount, so it resolves from the panel registry.
export const VIEWPORT_PROGRAM = 'core.viewport.program';
export const VIEWPORT_MACHINE = 'core.viewport.machine';

let registered = false;

export function registerCoreWorkspace(): void {
  if (registered) return;
  registered = true;

  // ── Browser panels ─────────────────────────────────────────────────────────────────────────
  panelRegistry.register({ id: 'core.browser.surfaces', mount: 'browser', title: 'Surfaces', icon: <Layers size={12} />, grow: true, Component: SurfacesPanel, HeaderActions: SurfacesHeaderActions });
  panelRegistry.register({ id: 'core.browser.fixtures', mount: 'browser', title: 'Fixtures', icon: <Box size={12} />, grow: true, Component: FixturesPanel, HeaderActions: FixturesHeaderActions });
  panelRegistry.register({ id: 'core.browser.groups', mount: 'browser', title: 'Groups', icon: <Users size={12} />, Component: GroupsPanel, HeaderActions: GroupsHeaderActions });
  panelRegistry.register({ id: 'core.browser.globals', mount: 'browser', title: 'Global Params', icon: <SlidersHorizontal size={12} />, Component: GlobalParamsPanel });
  panelRegistry.register({ id: 'core.browser.media', mount: 'browser', bare: true, grow: true, title: 'Media Library', icon: <ImageIcon size={12} />, Component: MediaBrowserPanel });
  panelRegistry.register({ id: 'core.browser.models', mount: 'browser', title: 'Objects', icon: <Box size={12} />, grow: true, Component: ModelsPanel, HeaderActions: ModelsHeaderActions });
  panelRegistry.register({ id: 'core.browser.scene3dFixtures', mount: 'browser', title: 'Fixtures', icon: <Lightbulb size={12} />, grow: true, Component: Scene3DFixturesPanel });

  // ── Parameter panels ───────────────────────────────────────────────────────────────────────
  panelRegistry.register({ id: 'core.inspector.surface.content', mount: 'inspector', title: 'Content', icon: <Layers size={12} />, appliesTo: ['surface'], Component: SurfaceContentPanel });
  panelRegistry.register({ id: 'core.inspector.surface.transform', mount: 'inspector', title: 'Transform', icon: <Box size={12} />, appliesTo: ['surface'], Component: SurfaceTransformPanel });
  panelRegistry.register({ id: 'core.inspector.fixture.mapping', mount: 'inspector', title: 'Mapping', icon: <Grid3x3 size={12} />, appliesTo: ['fixture'], Component: FixtureMappingPanel });
  panelRegistry.register({ id: 'core.inspector.fixture.segments', mount: 'inspector', title: 'Segments', icon: <Cable size={12} />, appliesTo: ['fixture'], Component: FixtureSegmentsPanel });
  panelRegistry.register({ id: 'core.inspector.fixture.output', mount: 'inspector', title: '2D / Output', icon: <Grid3x3 size={12} />, appliesTo: ['fixture'], Component: FixtureOutputPanel });
  panelRegistry.register({ id: 'core.inspector.fixture.routing', mount: 'inspector', title: 'Routing', icon: <Network size={12} />, appliesTo: ['fixture'], Component: FixtureRoutingPanel });
  panelRegistry.register({ id: 'core.inspector.fixture.layout3d', mount: 'inspector', title: '3D Layout', icon: <Box size={12} />, appliesTo: ['fixture'], Component: FixtureLayout3DPanel });
  panelRegistry.register({ id: 'core.inspector.model.transform', mount: 'inspector', title: 'Model', icon: <Box size={12} />, appliesTo: ['model'], Component: ModelTransformPanel });
  // No appliesTo — scene lighting is a property of the SCENE, not of whatever is selected.
  panelRegistry.register({ id: 'core.inspector.scene.lighting', mount: 'inspector', title: 'Lighting', icon: <Lightbulb size={12} />, defaultOpen: false, Component: SceneLightingPanel });

  // ── Dock panels ────────────────────────────────────────────────────────────────────────────
  panelRegistry.register({ id: 'core.dock.fixtureEditor', mount: 'dock', title: 'Fixture Editor', icon: <SlidersHorizontal size={13} />, Component: FixtureEditorDock });
  panelRegistry.register({ id: 'core.dock.monitor', mount: 'dock', title: 'DMX Monitor', icon: <Activity size={13} />, Component: MonitorDock });
  panelRegistry.register({ id: 'core.dock.perf', mount: 'dock', title: 'Performance', icon: <Gauge size={13} />, Component: PerfDock });
  panelRegistry.register({ id: 'core.dock.routing', mount: 'dock', title: 'Routing', icon: <Network size={13} />, Component: RoutingDock });
  // Live monitors. Both blit machinery that already runs each frame — see panels/preview.tsx.
  panelRegistry.register({ id: 'core.dock.outputsPreview', mount: 'dock', title: 'Output Preview', icon: <MonitorPlay size={13} />, Component: OutputsPreviewPanel });
  panelRegistry.register({ id: 'core.inspector.programPreview', mount: 'inspector', title: 'Program Preview', icon: <MonitorPlay size={12} />, Component: ProgramPreviewPanel });
  panelRegistry.register({ id: 'core.dock.programPreview', mount: 'dock', title: 'Program Preview', icon: <MonitorPlay size={13} />, Component: ProgramPreviewPanel });
  panelRegistry.register({ id: VIEWPORT_PROGRAM, mount: 'viewport', title: 'Program', Component: ProgramMonitorViewport });
  panelRegistry.register({ id: VIEWPORT_MACHINE, mount: 'viewport', title: 'Show Machine', Component: StateMachineViewport });

  // ── Contexts ───────────────────────────────────────────────────────────────────────────────
  // Actions reuse App's menu dispatcher by id wherever the function already exists there, so no
  // function is re-plumbed to appear on a bar.

  // MAPPING — surfaces AND fixtures in one workbench.
  //
  // These were two contexts (`map` for surface placement, `led` for the DMX patch) and splitting them
  // was wrong in practice: you place a surface in order to map LEDs onto it, and you check the patch
  // against the surface it samples. Both selections drive the same stage, and the parameter column
  // shows whichever is live — a surface and a fixture can both contribute sections at once, which is
  // exactly what `appliesTo` was built for.
  contextRegistry.register({
    id: 'mapping', title: 'Mapping', shortTitle: 'Map', icon: <Layers size={16} />,
    cluster: 'build', order: 1,
    viewport: VIEWPORT_STAGE_2D,
    browser: ['core.browser.surfaces', 'core.browser.fixtures', 'core.browser.groups', 'core.browser.globals'],
    inspector: [
      // Surface sections first: the surface is the thing you place, the fixture samples it.
      'core.inspector.surface.content', 'core.inspector.surface.transform',
      'core.inspector.fixture.mapping', 'core.inspector.fixture.segments',
      'core.inspector.fixture.output', 'core.inspector.fixture.routing',
      'core.inspector.fixture.layout3d',
    ],
    dock: ['core.dock.fixtureEditor', 'core.dock.routing', 'core.dock.monitor', 'core.dock.perf'],
    layout: { showLeft: true, showRight: true, dockOpen: true, splitView: false },
    layoutRev: 2,
    hint: {
      en: 'Place surfaces, map content onto them, then patch fixtures and check the DMX monitor.',
      fr: 'Placez les surfaces, mappez le contenu dessus, puis patchez les fixtures et vérifiez le moniteur DMX.',
    },
    actions: [
      { id: 'add-surface', label: 'Add Surface', icon: <Layers size={13} />, menuAction: 'add-surface' },
      { id: 'add', label: 'Add Fixture', icon: <Plus size={13} />, menuAction: 'add-fixture' },
      { id: 'auto-patch', label: 'Auto-patch', icon: <Hash size={13} />, menuAction: 'auto-patch' },
      { id: 'routing', label: 'Routing', icon: <Network size={13} />, menuAction: 'routing' },
      { id: 'group', label: 'Group Selection', icon: <Users size={13} />, menuAction: 'create-group', group: 'groups',
        enabled: (s) => (s.ids.fixture?.length ?? 0) > 0 },
      { id: 'save-template', label: 'Save as Template', icon: <Copy size={13} />, menuAction: 'save-template', group: 'groups',
        enabled: (s) => !!s.ids.fixture?.length },
      { id: 'remove', label: 'Delete', icon: <Trash2 size={13} />, menuAction: 'remove-fixture', group: 'edit', danger: true,
        enabled: (s) => !!s.ids.fixture?.length },
    ],
  });

  contextRegistry.register({
    id: '3d', title: 'Venue / 3D Scene', shortTitle: '3D', icon: <Box size={16} />,
    cluster: 'build', order: 3,
    viewport: VIEWPORT_SCENE_3D,
    browser: ['core.browser.models', 'core.browser.scene3dFixtures'],
    inspector: ['core.inspector.model.transform', 'core.inspector.fixture.layout3d', 'core.inspector.scene.lighting'],
    layout: { showLeft: true, showRight: true, dockOpen: false, splitView: false },
    layoutRev: 1,
    hint: {
      en: 'Lay the venue out in 3D — objects on the left, transform and lighting on the right.',
      fr: 'Disposez le lieu en 3D — objets à gauche, transformation et éclairage à droite.',
    },
    actions: [
      { id: 'save', label: 'Save Project', icon: <Save size={13} />, menuAction: 'save' },
    ],
  });

  contextRegistry.register({
    id: 'project', title: 'Projection Outputs', shortTitle: 'Proj', icon: <MonitorPlay size={16} />,
    cluster: 'align', order: 0,
    viewport: VIEWPORT_OUTPUTS,
    browser: ['core.browser.surfaces'],
    inspector: ['core.inspector.surface.transform'],
    // Dock OPEN by default and on the preview tab: the table tells you how an output is configured,
    // the preview tells you what is actually on that screen — which is the question a multi-projector
    // rig fails at, and the reason the preview exists.
    dock: ['core.dock.outputsPreview', 'core.dock.programPreview', 'core.dock.monitor'],
    layout: { showLeft: true, showRight: false, dockOpen: true, splitView: false },
    layoutRev: 2,
    hint: {
      en: 'Bind surfaces to displays, then warp and blend each projector. The dock previews every output live.',
      fr: 'Associez les surfaces aux écrans, puis déformez et fondez chaque projecteur.',
    },
    actions: [
      { id: 'rescan', label: 'Re-scan Displays', icon: <RefreshCw size={13} />, menuAction: 'outputs' },
    ],
  });

  contextRegistry.register({
    id: 'calib', title: 'Calibration', shortTitle: 'Calib', icon: <Crosshair size={16} />,
    cluster: 'align', order: 1,
    // The calibration PLUGIN claims this viewport (wizard rail + camera). The stage below is only the
    // fallback for a build with that plugin disabled. splitView puts the 3D venue scene in the right
    // pane, which the pose step needs open beside the camera — that pairing is the whole workbench.
    viewport: VIEWPORT_STAGE_2D,
    browser: [],
    inspector: [],
    layout: { showLeft: false, showRight: false, dockOpen: false, splitView: true, splitRatio: 0.55 },
    layoutRev: 2,
    hint: {
      en: 'Start a calibration from Projection Outputs — camera here, 3D venue scene alongside.',
      fr: 'Lancez un calibrage depuis les Sorties — la caméra ici, la scène 3D à côté.',
    },
    actions: [
      { id: 'outputs', label: 'Outputs…', icon: <MonitorPlay size={13} />, menuAction: 'outputs' },
    ],
  });

  // TIMELINE leads the Build cluster — it replaced the old "Media & Content" context, which was only
  // ever a media browser beside the stage. The library it carried is this context's browser, and the
  // asset manager its dock, so nothing was lost; you now import media where you actually cut it.
  // The parameter column holds a LIVE PROGRAM PREVIEW: editing a timeline without seeing the composite
  // it produces meant scrubbing and guessing.
  contextRegistry.register({
    id: 'timeline', title: 'Timeline', shortTitle: 'Time', icon: <Film size={16} />,
    cluster: 'build', order: 0,
    // The NLE shape: PROGRAM MONITOR on top, TIMELINE across the full width underneath. The timeline
    // is the bottom REGION, not the dock — the dock is flanked by the browser and the parameter
    // column, and lanes need the window's whole width.
    viewport: VIEWPORT_PROGRAM,
    bottom: VIEWPORT_TIMELINE,
    browser: ['core.browser.media'],
    inspector: [],
    // The Media Library in the browser column is the ONLY asset UI. There was a second, wider
    // "Asset Manager" panel that duplicated the same grid; it was deleted (2026-07-23) once the
    // library was shown to cover import / relink / reveal / remove / usage badges, and consolidate
    // lives on the action bar as Collect Assets.
    dock: ['core.dock.outputsPreview', 'core.dock.monitor'],
    layout: { showLeft: true, showRight: false, dockOpen: false, splitView: false, bottomHeight: 360 },
    layoutRev: 3,
    hint: {
      en: 'Edit the show timeline — drag media from the library onto a layer; the preview shows the composite.',
      fr: "Montez la timeline — glissez un média depuis la bibliothèque; l'aperçu montre le composite.",
    },
    actions: [
      { id: 'collect', label: 'Collect Assets', icon: <Save size={13} />, menuAction: 'collect-assets' },
      { id: 'collect-copy', label: 'Collect a Copy', menuAction: 'collect-copy' },
    ],
  });

  contextRegistry.register({
    id: 'scenes', title: 'Scenes & Cues', shortTitle: 'Cues', icon: <Clapperboard size={16} />,
    cluster: 'show', order: 1,
    viewport: VIEWPORT_SCENES,
    browser: ['core.browser.globals'],
    inspector: [],
    layout: { showLeft: true, showRight: false, dockOpen: false, splitView: false },
    layoutRev: 1,
    hint: {
      en: 'Capture looks as scenes, then fire them from the cue grid.',
      fr: 'Capturez des ambiances en scènes, puis déclenchez-les depuis la grille.',
    },
    actions: [],
  });

  // The show machine — the state graph over the scenes. It was a modal inside the timeline, which
  // capped it at a fixed 1000×640 box over the work it describes; as a context it gets the window.
  contextRegistry.register({
    id: 'machine', title: 'Show Machine', shortTitle: 'Logic', icon: <Workflow size={16} />,
    cluster: 'show', order: 2,
    viewport: VIEWPORT_MACHINE,
    browser: [],
    inspector: [],
    layout: { showLeft: false, showRight: false, dockOpen: false, splitView: false },
    layoutRev: 1,
    hint: {
      en: 'The show graph over your scenes — double-click empty space to add a state, drag a nub to link.',
      fr: 'Le graphe du spectacle sur vos scènes — double-clic pour ajouter un état, glissez un nub pour relier.',
    },
    actions: [
      { id: 'scenes', label: 'Scenes & Cues', icon: <Clapperboard size={13} />, run: () => goToContext('scenes') },
      { id: 'timeline', label: 'Timeline', icon: <Film size={13} />, run: () => goToContext('timeline') },
    ],
  });

  contextRegistry.register({
    id: 'audio', title: 'Audio', shortTitle: 'Audio', icon: <Music size={16} />,
    cluster: 'show', order: 3,
    // The audio PLUGIN claims this viewport (the mixer) via contextRegistry.extend. The stage below is
    // only the fallback for a build with that plugin disabled — the rail entry then still opens on
    // something rather than a blank pane.
    viewport: VIEWPORT_STAGE_2D,
    browser: ['core.browser.media'],
    inspector: [],
    layout: { showLeft: true, showRight: false, dockOpen: false, splitView: false },
    layoutRev: 2,
    hint: {
      en: 'The bed, the mix and the insert chains — drag audio in from the library on the left.',
      fr: "Le lit sonore, le mixage et les chaînes d'effets — glissez l'audio depuis la bibliothèque à gauche.",
    },
    actions: [],
  });

  contextRegistry.register({
    id: 'tracking', title: 'Tracking', shortTitle: 'Track', icon: <Radar size={16} />,
    cluster: 'show', order: 4,
    viewport: VIEWPORT_STAGE_2D,
    browser: [],
    inspector: [],
    layout: { showLeft: false, showRight: false, dockOpen: false, splitView: true },
    layoutRev: 1,
    hint: {
      en: 'LiDAR, camera pose and Augmenta sources — the 3D scene shows live blobs.',
      fr: 'Sources LiDAR, pose caméra et Augmenta — la scène 3D affiche les blobs en direct.',
    },
    // The three tracking plugins append their own monitors as DOCK TABS here, via
    // `ctx.contexts.extend('tracking', { dock: [...] })` — this context declares none of them itself.
    // Only the floor-calibration WIZARD stays an action: it is a modal step-by-step flow, not a monitor.
    actions: [
      { id: 'pose-cal', label: 'Pose Floor Calibration…', icon: <Crosshair size={13} />, menuAction: 'pose-calibrate' },
    ],
  });

  contextRegistry.register({
    id: 'show', title: 'Show / Perform', shortTitle: 'Show', icon: <Play size={16} />,
    cluster: 'show', order: 5,
    viewport: VIEWPORT_STAGE_2D,
    browser: ['core.browser.globals'],
    inspector: [],
    dock: ['core.dock.outputsPreview', 'core.dock.programPreview', 'core.dock.monitor', 'core.dock.perf'],
    // The old `perform` preset — everything out of the way except the stage.
    layout: { showLeft: false, showRight: false, dockOpen: true, splitView: false },
    layoutRev: 2,
    hint: {
      en: 'Running the show: master levels, live monitoring and the tablet remote.',
      fr: 'Conduite du spectacle : niveaux maîtres, monitoring live et télécommande tablette.',
    },
    // show-control appends its operator panel as a dock tab (contextRegistry.extend).
    actions: [
      { id: 'prefs', label: 'Preferences…', icon: <Settings size={13} />, menuAction: 'preferences', group: 'app' },
    ],
  });
}
