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
  Layers, Box, Boxes, Users, SlidersHorizontal, Image as ImageIcon, Film, Lightbulb, MonitorPlay, Crosshair, Clapperboard, Music, Radar, Radio, Activity, Gauge, Hash, Plus, RefreshCw, Workflow, Timer, Network, Settings, FolderOpen, Save, Trash2, Copy, Grid3x3, Cable, Play, Move3d, Diamond, Bookmark, Library, Route,
} from 'lucide-react';
import { panelRegistry, contextRegistry } from '../host/registries';
import { SCENE_3D_VIEWPORT } from '../components/shell/WorkspaceShell';
import { goToContext, revealBottom } from './nav';
import {
  SurfacesPanel, SurfacesHeaderActions, FixturesPanel, FixturesHeaderActions,
  GroupsPanel, GroupsHeaderActions, GlobalParamsPanel,
} from './panels/browser';
import {
  SurfaceContentPanel, SurfaceTransformPanel, FixturePatchPanel, FixtureMappingPanel, FixtureSegmentsPanel,
  FixtureOutputPanel, FixtureRoutingPanel, FixtureLayout3DPanel,
  FixtureProfilePanel, FixtureChannelsPanel, FixturePositionPanel,
} from './panels/inspector';
import { MediaBrowserPanel, FixtureLibraryDock, FixtureWiringDock, MonitorDock, PerfDock, RoutingDock, StateMachineViewport } from './panels/adapters';
import { ProgramPreviewPanel, ProgramMonitorViewport, OutputsPreviewPanel } from './panels/preview';
import { TimingPanel, TimingHeaderActions } from './panels/timing';
import { PreferencesViewport } from './panels/adapters';
import {
  ModelsPanel, ModelsHeaderActions, Scene3DFixturesPanel, ModelTransformPanel,
  SceneLightingPanel, SceneTrackingPanel, FixtureArrangePanel,
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
// The timeline is not a workbench, it is a TOOL — so it has no context of its own. Nearly every
// context names it as its `bottom`, and the shell keeps it there at one fixed tree position, collapsed
// to a title strip until pulled up (Ctrl+T). That is what lets you cut video against the 2D stage,
// record a lighting take against the 3D rig, or author a scene's timeline from the cue grid without
// leaving the viewport you are working in — which is exactly what a `timeline` context could not do.
export const VIEWPORT_TIMELINE = 'core.viewport.timeline';
export const VIEWPORT_SCENES = 'core.viewport.scenes';
export const VIEWPORT_OUTPUTS = 'core.viewport.outputs';
// Not persistent — a monitor is cheap to remount, so it resolves from the panel registry.
export const VIEWPORT_MACHINE = 'core.viewport.machine';
export const VIEWPORT_PREFERENCES = 'core.viewport.preferences';

let registered = false;

export function registerCoreWorkspace(): void {
  if (registered) return;
  registered = true;

  // ── Browser panels ─────────────────────────────────────────────────────────────────────────
  panelRegistry.register({ id: 'core.browser.surfaces', mount: 'browser', title: 'Surfaces', icon: <Layers size={12} />, grow: true, Component: SurfacesPanel, HeaderActions: SurfacesHeaderActions });
  panelRegistry.register({ id: 'core.browser.fixtures', mount: 'browser', title: 'Fixtures', icon: <Box size={12} />, grow: true, Component: FixturesPanel, HeaderActions: FixturesHeaderActions });
  panelRegistry.register({ id: 'core.browser.groups', mount: 'browser', title: 'Groups', icon: <Users size={12} />, Component: GroupsPanel, HeaderActions: GroupsHeaderActions });
  panelRegistry.register({ id: 'core.browser.globals', mount: 'browser', title: 'Global Params', icon: <SlidersHorizontal size={12} />, Component: GlobalParamsPanel });
  // Browser-mounted flavours for contexts whose left column is a monitor rather than an outliner.
  panelRegistry.register({ id: 'core.browser.programPreview', mount: 'browser', title: 'Program', icon: <MonitorPlay size={12} />, Component: ProgramPreviewPanel });
  panelRegistry.register({ id: 'core.browser.timing', mount: 'browser', title: 'Timing', icon: <Timer size={12} />, Component: TimingPanel, HeaderActions: TimingHeaderActions });
  panelRegistry.register({ id: 'core.browser.media', mount: 'browser', bare: true, grow: true, title: 'Media Library', icon: <ImageIcon size={12} />, Component: MediaBrowserPanel });
  panelRegistry.register({ id: 'core.browser.models', mount: 'browser', title: 'Objects', icon: <Box size={12} />, grow: true, Component: ModelsPanel, HeaderActions: ModelsHeaderActions });
  panelRegistry.register({ id: 'core.browser.scene3dFixtures', mount: 'browser', title: 'Fixtures', icon: <Lightbulb size={12} />, grow: true, Component: Scene3DFixturesPanel });

  // ── Parameter panels ───────────────────────────────────────────────────────────────────────
  panelRegistry.register({ id: 'core.inspector.surface.content', mount: 'inspector', title: 'Content', icon: <Layers size={12} />, appliesTo: ['surface'], Component: SurfaceContentPanel });
  panelRegistry.register({ id: 'core.inspector.surface.transform', mount: 'inspector', title: 'Transform', icon: <Box size={12} />, appliesTo: ['surface'], Component: SurfaceTransformPanel });
  // The DMX profile comes FIRST in the fixture column: it decides what kind of light this is, and
  // therefore whether the pixel-oriented sections below it are even meaningful.
  panelRegistry.register({ id: 'core.inspector.fixture.profile', mount: 'inspector', title: 'DMX Profile', icon: <Lightbulb size={12} />, appliesTo: ['fixture'], Component: FixtureProfilePanel });
  // ── EVERY FIXTURE SECTION DECLARES ITS KIND ───────────────────────────────────────────────
  // An LED strip and a moving head are two different devices, and this is where the shell is told
  // so. Before this, exactly ONE of these gated on kind, so selecting a moving head offered you
  // Serpentine, colour order, a ledmap upload, LED spacing — and an editable LED Count that
  // silently shifted every fixture patched after it in the canonical pixel buffer.
  //
  // `fixture` (both kinds): profile — it is how you CHANGE the kind; patch/routing — every fixture
  // is on a wire; arrange — rig-building is kind-agnostic. Everything else names one kind.
  panelRegistry.register({ id: 'core.inspector.fixture.channels', mount: 'inspector', title: 'Channels', icon: <SlidersHorizontal size={12} />, appliesTo: ['fixture.light'], Component: FixtureChannelsPanel });
  panelRegistry.register({ id: 'core.inspector.fixture.patch', mount: 'inspector', title: 'Patch', icon: <Hash size={12} />, appliesTo: ['fixture'], Component: FixturePatchPanel });
  panelRegistry.register({ id: 'core.inspector.fixture.mapping', mount: 'inspector', title: 'Mapping', icon: <Grid3x3 size={12} />, appliesTo: ['fixture.pixel'], Component: FixtureMappingPanel });
  panelRegistry.register({ id: 'core.inspector.fixture.segments', mount: 'inspector', title: 'Segments', icon: <Cable size={12} />, appliesTo: ['fixture.pixel'], Component: FixtureSegmentsPanel });
  panelRegistry.register({ id: 'core.inspector.fixture.output', mount: 'inspector', title: '2D / Output', icon: <Grid3x3 size={12} />, appliesTo: ['fixture.pixel'], Component: FixtureOutputPanel });
  panelRegistry.register({ id: 'core.inspector.fixture.routing', mount: 'inspector', title: 'Routing', icon: <Network size={12} />, appliesTo: ['fixture'], Component: FixtureRoutingPanel });
  // Pixel-only: it authors LED spacing and arc sweep for a RUN of LEDs, which a one-emitter head
  // does not have. A light gets `position` instead — the same numbers without the layout half, so it
  // is not left reachable only by dragging the gizmo.
  panelRegistry.register({ id: 'core.inspector.fixture.layout3d', mount: 'inspector', title: '3D Layout', icon: <Box size={12} />, appliesTo: ['fixture.pixel'], Component: FixtureLayout3DPanel });
  panelRegistry.register({ id: 'core.inspector.fixture.position', mount: 'inspector', title: 'Position', icon: <Move3d size={12} />, appliesTo: ['fixture.light'], Component: FixturePositionPanel });
  panelRegistry.register({ id: 'core.inspector.model.transform', mount: 'inspector', title: 'Model', icon: <Box size={12} />, appliesTo: ['model'], Component: ModelTransformPanel });
  // Rig-building for a multi-selection. Lives in the fixture column so it sits beside the 3D layout
  // it rearranges.
  panelRegistry.register({ id: 'core.inspector.fixture.arrange', mount: 'inspector', title: 'Arrange', icon: <Grid3x3 size={12} />, appliesTo: ['fixture'], Component: FixtureArrangePanel });
  // No appliesTo — scene lighting is a property of the SCENE, not of whatever is selected.
  panelRegistry.register({ id: 'core.inspector.scene.lighting', mount: 'inspector', title: 'Lighting', icon: <Lightbulb size={12} />, defaultOpen: false, Component: SceneLightingPanel });
  // Also no appliesTo — the tracking overlays are a property of the SCENE, not of a selection.
  panelRegistry.register({ id: 'core.inspector.scene.tracking', mount: 'inspector', title: 'Tracking', icon: <Radar size={12} />, defaultOpen: false, Component: SceneTrackingPanel });

  // ── Dock panels ────────────────────────────────────────────────────────────────────────────
  // The seven-card Fixture Editor is gone: five of its cards were a second rendering of controls
  // the kind-gated inspector already owns, and the same field could be edited in two places with
  // only one of them explaining itself. What is left is the two things that exist nowhere else.
  panelRegistry.register({ id: 'core.dock.fixtureLibrary', mount: 'dock', title: 'Library', icon: <Library size={13} />, Component: FixtureLibraryDock });
  // Pixel-only, and gated in its REGISTRATION like every fixture section — a moving head has named
  // channels, not a pixel order, so the tab is simply absent when one is selected.
  panelRegistry.register({ id: 'core.dock.fixtureWiring', mount: 'dock', title: 'Wiring & Ledmap', icon: <Route size={13} />, appliesTo: ['fixture.pixel'], Component: FixtureWiringDock });
  panelRegistry.register({ id: 'core.dock.monitor', mount: 'dock', title: 'DMX Monitor', icon: <Activity size={13} />, Component: MonitorDock });
  panelRegistry.register({ id: 'core.dock.perf', mount: 'dock', title: 'Performance', icon: <Gauge size={13} />, Component: PerfDock });
  panelRegistry.register({ id: 'core.dock.routing', mount: 'dock', title: 'Routing', icon: <Network size={13} />, Component: RoutingDock });
  // Live monitors. Both blit machinery that already runs each frame — see panels/preview.tsx.
  panelRegistry.register({ id: 'core.dock.outputsPreview', mount: 'dock', title: 'Output Preview', icon: <MonitorPlay size={13} />, Component: OutputsPreviewPanel });
  panelRegistry.register({ id: 'core.inspector.programPreview', mount: 'inspector', title: 'Program Preview', icon: <MonitorPlay size={12} />, Component: ProgramPreviewPanel });
  // The FULL-BLEED monitor in the dock, the padded card in the narrow columns. This was the old
  // `timeline` context's viewport; a dock tab is the same shape (a full pane), so nothing was lost when
  // that context dissolved — the program monitor and the timeline drawer now sit one above the other in
  // whichever workbench you are cutting in.
  panelRegistry.register({ id: 'core.dock.programPreview', mount: 'dock', title: 'Program', icon: <MonitorPlay size={13} />, Component: ProgramMonitorViewport });
  // The media library, in the DOCK as well as the browser column. A thumbnail grid wants width, and in
  // a 288px browser column it is a `bare`+`grow` panel that eats every section stacked under it — which
  // is why Mapping takes it as a dock tab and Audio keeps the column flavour.
  panelRegistry.register({ id: 'core.dock.media', mount: 'dock', title: 'Media Library', icon: <ImageIcon size={13} />, Component: MediaBrowserPanel });
  panelRegistry.register({ id: VIEWPORT_MACHINE, mount: 'viewport', title: 'Show Machine', Component: StateMachineViewport });
  panelRegistry.register({ id: VIEWPORT_PREFERENCES, mount: 'viewport', menuAction: 'preferences', title: 'Preferences', Component: PreferencesViewport });

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
    cluster: 'build', order: 0,
    viewport: VIEWPORT_STAGE_2D,
    // The timeline, on demand. This is where the old `timeline` context's work happens now: the stage
    // above, the lanes across the full width below, the program monitor and the media library as dock
    // tabs. Its media library and monitor were the only things it carried that this context lacked.
    bottom: VIEWPORT_TIMELINE,
    browser: ['core.browser.surfaces', 'core.browser.fixtures', 'core.browser.groups', 'core.browser.globals'],
    inspector: [
      // Surface sections first: the surface is the thing you place, the fixture samples it.
      'core.inspector.surface.content', 'core.inspector.surface.transform',
      'core.inspector.fixture.profile', 'core.inspector.fixture.channels',
      'core.inspector.fixture.patch',
      'core.inspector.fixture.mapping', 'core.inspector.fixture.segments',
      'core.inspector.fixture.output', 'core.inspector.fixture.routing',
      'core.inspector.fixture.position',
      'core.inspector.fixture.layout3d', 'core.inspector.fixture.arrange',
    ],
    dock: ['core.dock.fixtureLibrary', 'core.dock.fixtureWiring', 'core.dock.media', 'core.dock.programPreview', 'core.dock.routing', 'core.dock.monitor', 'core.dock.perf'],
    layout: { showLeft: true, showRight: true, dockOpen: true, splitView: false, bottomOpen: false },
    // 5: the fixture column gained `patch` (split out of Mapping) and every section declares a kind;
    // then the seven-card Fixture Editor dock became `Library` + `Wiring & Ledmap`. A banked slice
    // from before still names `core.dock.fixtureEditor`, which no longer resolves — without the bump
    // the operator keeps an empty tab and never sees either replacement.
    layoutRev: 5,
    hint: {
      en: 'Place surfaces, map content onto them, then patch fixtures. Ctrl+T pulls the timeline up.',
      fr: 'Placez les surfaces, mappez le contenu dessus, puis patchez les fixtures. Ctrl+T ouvre la timeline.',
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
      // Followed the media library here from the dissolved `timeline` context — you collect the assets
      // of the project you are cutting, and the library is a dock tab away.
      { id: 'collect', label: 'Collect Assets', icon: <Save size={13} />, menuAction: 'collect-assets', group: 'assets' },
      { id: 'collect-copy', label: 'Collect a Copy', menuAction: 'collect-copy', group: 'assets' },
    ],
  });

  // VENUE & RIG — the 3D scene, and everything that is only meaningful *in* it.
  //
  // It absorbed the old `tracking` context, which had turned into a near-duplicate: no browser, one
  // inspector section (`scene.tracking`) that this context already declared, and a layout of
  // `splitView: true` whose entire purpose was to get the 3D scene on screen beside the stage, because
  // the 3D scene is where live blobs are drawn. Being IN the 3D scene is the better version of that.
  // Its three plugins contributed only DOCK TABS — and this context had no dock at all, so the region
  // was free. They now extend '3d'.
  //
  // It is also where a light show is prepped: pick heads, point them, pull the timeline drawer up, and
  // record a take against the rig you can see.
  contextRegistry.register({
    id: '3d', title: 'Venue & Rig', shortTitle: '3D', icon: <Box size={16} />,
    cluster: 'build', order: 1,
    viewport: VIEWPORT_SCENE_3D,
    // The shell pins the 3D scene to the RIGHT pane (one WebGL context, never remounted), so with split
    // view on this context's left pane would be an empty half. The 2D stage goes there — which is the
    // stage-beside-3D arrangement `tracking` used to provide, now a toggle instead of a rail entry.
    companion: VIEWPORT_STAGE_2D,
    bottom: VIEWPORT_TIMELINE,
    browser: ['core.browser.models', 'core.browser.scene3dFixtures'],
    // The WHOLE light-fixture loop lives here now: place it, position it, patch it, drive its
    // channels — with the timeline a Ctrl+T away to store what you just set. Patch, Routing and
    // Position joined the column so that loop needs no context switch.
    inspector: [
      'core.inspector.model.transform',
      'core.inspector.fixture.profile', 'core.inspector.fixture.channels',
      'core.inspector.fixture.patch', 'core.inspector.fixture.routing',
      'core.inspector.fixture.position',
      'core.inspector.fixture.layout3d', 'core.inspector.fixture.arrange',
      'core.inspector.scene.lighting', 'core.inspector.scene.tracking',
    ],
    // The tracking plugins (lidar-tracking, mediapipe, augmenta) append their monitors after these.
    dock: ['core.dock.monitor', 'core.dock.perf'],
    layout: { showLeft: true, showRight: true, dockOpen: false, splitView: false, bottomOpen: false },
    // 3: gained patch + routing + position, so the light loop is one workbench.
    layoutRev: 3,
    hint: {
      en: 'The venue and the rig in 3D — place fixtures, aim them, track live blobs, record lighting takes (Ctrl+T for the timeline).',
      fr: 'Le lieu et le kit en 3D — placez les fixtures, visez, suivez les blobs, enregistrez des takes (Ctrl+T pour la timeline).',
    },
    actions: [
      { id: 'save', label: 'Save Project', icon: <Save size={13} />, menuAction: 'save' },
      // Arm the lighting recorder without hunting for the Takes bin: busk a look on the selected heads
      // and it lands in the bin, ready to place on a lighting lane. See services/lightingRecorder.
      // The two capture verbs, side by side, because they are the same gesture at two time scales:
      // Store key is ONE INSTANT of the rig, Record is a stream of them. Having them together is
      // what makes the drawer-not-a-context decision pay off — the rig, the channel strip and the
      // lanes are on screen at once, so Ctrl+T, position, store, scrub, store is one loop with no
      // context switch.
      { id: 'store-key', label: 'Store Key', icon: <Diamond size={13} />, menuAction: 'store-lighting-key', group: 'lighting',
        enabled: (s) => (s.ids.fixture?.length ?? 0) > 0 },
      // The same capture, stored under a NAME instead of at a time — the library pose cues fire from.
      { id: 'save-pose', label: 'Save Pose', icon: <Bookmark size={13} />, menuAction: 'save-lighting-pose', group: 'lighting',
        enabled: (s) => (s.ids.fixture?.length ?? 0) > 0 },
      { id: 'record-take', label: 'Record Lighting Take', icon: <Radio size={13} />, menuAction: 'record-lighting-take', group: 'lighting',
        enabled: (s) => (s.ids.fixture?.length ?? 0) > 0 },
      // Followed the tracking context here — a modal step-by-step flow, so it stays an action.
      { id: 'pose-cal', label: 'Pose Floor Calibration…', icon: <Crosshair size={13} />, menuAction: 'pose-calibrate', group: 'tracking' },
    ],
  });

  contextRegistry.register({
    id: 'project', title: 'Projection Outputs', shortTitle: 'Proj', icon: <MonitorPlay size={16} />,
    cluster: 'align', order: 0,
    viewport: VIEWPORT_OUTPUTS,
    bottom: VIEWPORT_TIMELINE,
    browser: ['core.browser.surfaces'],
    inspector: ['core.inspector.surface.transform'],
    // Dock OPEN by default and on the preview tab: the table tells you how an output is configured,
    // the preview tells you what is actually on that screen — which is the question a multi-projector
    // rig fails at, and the reason the preview exists.
    dock: ['core.dock.outputsPreview', 'core.dock.programPreview', 'core.dock.monitor'],
    layout: { showLeft: true, showRight: false, dockOpen: true, splitView: false, bottomOpen: false },
    layoutRev: 3,
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
    // Declared, not opened. A venue mesh at the wrong SCALE still reprojects with a low RMS and still
    // lands off the wall — the one error this method cannot detect from its own numbers — so the
    // transform has to be reachable from here. The default workbench is unchanged (`showRight: false`,
    // the camera + 3D pairing stays as designed); this only stops the function being locked away.
    inspector: ['core.inspector.model.transform'],
    layout: { showLeft: false, showRight: false, dockOpen: false, splitView: true, splitRatio: 0.55, bottomOpen: false },
    // Bumped for the inspector panel above: the compiled tree changed, and a banked slice from an
    // earlier session would otherwise keep the old one forever (docs/WORKSPACE.md).
    layoutRev: 3,
    hint: {
      en: 'Start a calibration from Projection Outputs — camera here, 3D venue scene alongside.',
      fr: 'Lancez un calibrage depuis les Sorties — la caméra ici, la scène 3D à côté.',
    },
    actions: [
      { id: 'outputs', label: 'Outputs…', icon: <MonitorPlay size={13} />, menuAction: 'outputs' },
      // The venue mesh is this context's metric reference, and it was only obtainable from the Scene
      // workspace — so an operator who got here without one had to leave, losing the session. Also
      // offered inline on the wizards' failing prerequisite row.
      { id: 'add-model', label: 'Load Venue Model…', icon: <Boxes size={13} />, menuAction: 'add-model' },
    ],
  });

  // There is NO `timeline` context, deliberately — it was dissolved (2026-07-26).
  //
  // It led the Build cluster and its shape was the NLE one: a program monitor on top, the timeline
  // across the full width underneath. But the timeline is a TOOL, not a place: you want it while
  // cutting against the 2D stage, while recording a lighting take against the 3D rig, while authoring a
  // scene's timeline from the cue grid. Reaching it cost you the viewport you were working in, which is
  // also why a 12th `light` context looked necessary — a rail entry was the only way to get the 3D
  // scene and the timeline on screen together.
  //
  // So the timeline became every context's `bottom` drawer, and this context had nothing left of its
  // own: its program monitor is `core.dock.programPreview` (the same full-bleed component), its media
  // library is `core.dock.media`, and both live in Mapping along with its two asset actions. Nothing was
  // lost, one rail entry and one remount-per-visit were.

  contextRegistry.register({
    id: 'scenes', title: 'Scenes & Cues', shortTitle: 'Cues', icon: <Clapperboard size={16} />,
    cluster: 'show', order: 0,
    viewport: VIEWPORT_SCENES,
    // A scene's own timeline is authored right here now, instead of a trip to a context that took the
    // cue grid away — see SceneCard's Edit Timeline (panels/adapters.tsx) and docs/SCENE-TIMELINES.md.
    bottom: VIEWPORT_TIMELINE,
    // Firing cues is a WATCHING job: you want to see what you just put on air and how long it has been
    // there. Master brightness (the old Global Params here) is a rig setting, not a cue-firing one —
    // it lives in Mapping and on the Show deck.
    browser: ['core.browser.programPreview', 'core.browser.timing'],
    inspector: [],
    layout: { showLeft: true, showRight: false, dockOpen: false, splitView: false, bottomOpen: false },
    layoutRev: 3,
    hint: {
      en: "Capture looks as scenes, then fire them from the cue grid. Ctrl+T authors the active scene's timeline.",
      fr: 'Capturez des ambiances en scènes, puis déclenchez-les depuis la grille. Ctrl+T ouvre la timeline.',
    },
    actions: [],
  });

  // Preferences. Machine-level settings (output protocol, engine, appearance, watchdog, GPU) plus every
  // plugin's SettingsSection — read and compared, not acknowledged, so a dialog was the wrong shape. Its
  // own `app` cluster keeps it off the end of the show group, below a rule on the rail.
  contextRegistry.register({
    id: 'settings', title: 'Preferences', shortTitle: 'Prefs', icon: <Settings size={16} />,
    cluster: 'app', order: 0,
    viewport: VIEWPORT_PREFERENCES,
    browser: [],
    inspector: [],
    layout: { showLeft: false, showRight: false, dockOpen: false, splitView: false, bottomOpen: false },
    layoutRev: 1,
    hint: {
      en: "App and machine settings — output, engine, appearance, and each plugin's own section.",
      fr: "Réglages de l'application et de la machine — sortie, moteur, apparence, et chaque extension.",
    },
    actions: [],
  });

  // The show machine — the state graph over the scenes. It was a modal inside the timeline, which
  // capped it at a fixed 1000×640 box over the work it describes; as a context it gets the window.
  contextRegistry.register({
    id: 'machine', title: 'Show Machine', shortTitle: 'Machine', icon: <Workflow size={16} />,
    cluster: 'show', order: 1,
    viewport: VIEWPORT_MACHINE,
    bottom: VIEWPORT_TIMELINE,
    browser: [],
    inspector: [],
    layout: { showLeft: false, showRight: false, dockOpen: false, splitView: false, bottomOpen: false },
    layoutRev: 2,
    hint: {
      en: 'The show graph over your scenes — double-click empty space to add a state, drag a nub to link.',
      fr: 'Le graphe du spectacle sur vos scènes — double-clic pour ajouter un état, glissez un nub pour relier.',
    },
    actions: [
      { id: 'scenes', label: 'Scenes & Cues', icon: <Clapperboard size={13} />, run: () => goToContext('scenes') },
      // Opens the drawer BELOW the graph rather than switching away from it — the state you just wired
      // and the lanes it plays stay on screen together.
      { id: 'timeline', label: 'Timeline', icon: <Film size={13} />, run: () => revealBottom() },
    ],
  });

  contextRegistry.register({
    id: 'audio', title: 'Audio', shortTitle: 'Audio', icon: <Music size={16} />,
    cluster: 'show', order: 2,
    // The audio PLUGIN claims this viewport (the mixer) via contextRegistry.extend. The stage below is
    // only the fallback for a build with that plugin disabled — the rail entry then still opens on
    // something rather than a blank pane.
    viewport: VIEWPORT_STAGE_2D,
    // Keeps the media library as a BROWSER panel (the dock flavour is Mapping's): here the column is
    // the only thing in it, so a full-height grid is the right shape.
    browser: ['core.browser.media'],
    bottom: VIEWPORT_TIMELINE,
    inspector: [],
    layout: { showLeft: true, showRight: false, dockOpen: false, splitView: false, bottomOpen: false },
    layoutRev: 3,
    hint: {
      en: 'The bed, the mix and the insert chains — drag audio in from the library on the left.',
      fr: "Le lit sonore, le mixage et les chaînes d'effets — glissez l'audio depuis la bibliothèque à gauche.",
    },
    actions: [],
  });

  // There is NO `tracking` context — it merged into `3d` (2026-07-26). See the comment there for why:
  // no browser, one inspector section `3d` already carried, and a layout whose whole purpose was to get
  // the 3D scene on screen. Its plugins now extend '3d'.

  contextRegistry.register({
    id: 'show', title: 'Show / Perform', shortTitle: 'Show', icon: <Play size={16} />,
    cluster: 'show', order: 3,
    viewport: VIEWPORT_STAGE_2D,
    bottom: VIEWPORT_TIMELINE,
    browser: ['core.browser.globals'],
    inspector: [],
    // The show-control plugin appends Schedule / Playlist / Metrics / Show Control here and claims
    // the viewport (its operator deck) — see plugins/show-control/src/plugin.renderer.ts.
    dock: ['core.dock.outputsPreview', 'core.dock.programPreview', 'core.dock.monitor', 'core.dock.perf'],
    // The old `perform` preset — everything out of the way except the stage.
    layout: { showLeft: false, showRight: false, dockOpen: true, splitView: false, bottomOpen: false },
    layoutRev: 3,
    hint: {
      en: 'Running the show — scenes, transport, schedule, playlist and live metrics.',
      fr: 'Conduite du spectacle — scènes, transport, planning, playlist et métriques live.',
    },
    // show-control appends its operator panel as a dock tab (contextRegistry.extend).
    actions: [],
  });
}
