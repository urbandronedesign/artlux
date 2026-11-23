// THE PANELS THAT MAY OPEN IN THEIR OWN WINDOW (E5/W5), and the one place they are declared.
//
// The editor registers these exactly as before (contexts/index.tsx spreads them into panelRegistry), and
// the panel window (panel.tsx) mounts them from here. One list, so the two can never disagree about a
// panel's title, icon or header buttons.
//
// ⚠ WHAT MAY BE ON THIS LIST IS DECIDED BY THE IMPORT GRAPH, NOT BY TASTE. A panel window is a client:
// it must produce nothing (plans/native-engine.md §9a rule 1). A panel whose module reaches the
// transport (services/timeline), the frame engine, a decoder, the GPU code or three.js would, in its
// own window, either run a second copy of that work or — worse, and silently — read that window's idle
// copy: a playhead stuck at 0, an empty media cache, a state machine that never entered a state.
// verify:invariants bundles panel.tsx and fails if any such module is in it, so adding a panel here
// whose file is tainted is caught at the next `npm run verify`, with the offending module named.
//
// Every panel here reads ONLY useEditor()/useEditorPick() and dispatches ONLY useEditorActions() — in a
// panel window those are the replica and the editor's actions over the live channel (live/panelStore).
// Today: the four outliner/browser panels of contexts/panels/browser.tsx, the parameter sections of
// contexts/panels/inspector.tsx, the surface Content section (contexts/panels/surfaceContent.tsx), and
// the monitors — Timing, DMX Monitor, Performance — whose live readings come through seams.

import React from 'react';
import { Activity, Box, Cable, Film, Gauge, Grid3x3, Hash, Image as ImageIcon, Layers, Library, Lightbulb, Move3d, Network, Radar, Route, SlidersHorizontal, Timer, Users } from 'lucide-react';
import type { PanelContribution } from '@artlux/sdk/renderer';
import {
  SurfacesPanel, SurfacesHeaderActions, FixturesPanel, FixturesHeaderActions,
  GroupsPanel, GroupsHeaderActions, GlobalParamsPanel,
} from './panels/browser';
import {
  FixtureChannelsPanel, FixtureLayout3DPanel, FixtureMappingPanel, FixtureOutputPanel, FixturePatchPanel, FixturePositionPanel, FixtureProfilePanel, FixtureRoutingPanel, FixtureSegmentsPanel, SurfaceTransformPanel,
} from './panels/inspector';
import { SurfaceContentPanel } from './panels/surfaceContent';
import { MonitorDock, PerfDock } from './panels/monitors';
import { FixtureLibraryDock, FixtureWiringDock } from './panels/fixtureDocks';
import { RoutingDock } from './panels/routing';
import { StateMachineViewport } from './panels/stateGraph';
import { LightingTakesDock, TrackingTakesDock } from './panels/takes';
import { MediaBrowserPanel } from './panels/media';
import { PreferencesViewport } from './panels/adapters';
import {
  ModelsPanel, ModelsHeaderActions, Scene3DFixturesPanel, ModelTransformPanel,
  SceneLightingPanel, SceneTrackingPanel, FixtureArrangePanel,
} from './panels/scene3d';
import { TimingPanel, TimingHeaderActions } from './panels/timing';
import { TimelineDock } from '../components/timeline/TimelineDock';

/**
 * THE TIMELINE'S id when it is out in a panel window. NOT the drawer's viewport id (contexts/index.tsx
 * VIEWPORT_TIMELINE): the drawer is one persistent element at one fixed place in the editor, and this is
 * the copy a window mounts. The editor never registers this id (it is `mount: 'dock'`, and the editor
 * registers this list's entries one by one), so nothing there can dock a second timeline; while it is
 * out the drawer shows where it went (App.tsx, services/panelsOut).
 */
export const TIMELINE_WINDOW_PANEL = 'core.timeline';
// No maximise in a window (the window IS the room), and no "open in window" (it is in one).
const TimelineWindowPanel: React.FC = () => <TimelineDock />;

export const DETACHABLE_PANELS: PanelContribution[] = [
  { id: 'core.browser.surfaces', mount: 'browser', detachable: true, title: 'Surfaces', icon: <Layers size={12} />, grow: true, Component: SurfacesPanel, HeaderActions: SurfacesHeaderActions },
  { id: 'core.browser.fixtures', mount: 'browser', detachable: true, title: 'Fixtures', icon: <Box size={12} />, grow: true, Component: FixturesPanel, HeaderActions: FixturesHeaderActions },
  { id: 'core.browser.groups', mount: 'browser', detachable: true, title: 'Groups', icon: <Users size={12} />, Component: GroupsPanel, HeaderActions: GroupsHeaderActions },
  { id: 'core.browser.globals', mount: 'browser', detachable: true, title: 'Global Params', icon: <SlidersHorizontal size={12} />, Component: GlobalParamsPanel },
  // The parameter sections of contexts/panels/inspector.tsx. Each one in a window shows what it shows
  // docked, for the current selection (a fixture's Channels faders on a second screen, say).
  //
  // CONTENT shows plugin sources' settings too. A panel window activates only the plugins' UI halves
  // (host/pluginUi.ts), and the camera inspector asks the editor (services/cameraAccess.ts); a plugin
  // whose UI half is not split out yet says, in the window, that it is set up in the editor.
  { id: 'core.inspector.surface.content', detachable: true, mount: 'inspector', title: 'Content', icon: <Layers size={12} />, appliesTo: ['surface'], Component: SurfaceContentPanel },
  { id: 'core.inspector.surface.transform', detachable: true, mount: 'inspector', title: 'Transform', icon: <Box size={12} />, appliesTo: ['surface'], Component: SurfaceTransformPanel },
  { id: 'core.inspector.fixture.profile', detachable: true, mount: 'inspector', title: 'DMX Profile', icon: <Lightbulb size={12} />, appliesTo: ['fixture.light'], Component: FixtureProfilePanel },
  { id: 'core.inspector.fixture.channels', detachable: true, mount: 'inspector', title: 'Channels', icon: <SlidersHorizontal size={12} />, appliesTo: ['fixture.light'], Component: FixtureChannelsPanel },
  { id: 'core.inspector.fixture.patch', detachable: true, mount: 'inspector', title: 'Patch', icon: <Hash size={12} />, appliesTo: ['fixture'], Component: FixturePatchPanel },
  { id: 'core.inspector.fixture.mapping', detachable: true, mount: 'inspector', title: 'Mapping', icon: <Grid3x3 size={12} />, appliesTo: ['fixture.pixel'], Component: FixtureMappingPanel },
  { id: 'core.inspector.fixture.segments', detachable: true, mount: 'inspector', title: 'Segments', icon: <Cable size={12} />, appliesTo: ['fixture.pixel'], Component: FixtureSegmentsPanel },
  { id: 'core.inspector.fixture.output', detachable: true, mount: 'inspector', title: '2D / Output', icon: <Grid3x3 size={12} />, appliesTo: ['fixture.pixel'], Component: FixtureOutputPanel },
  { id: 'core.inspector.fixture.routing', detachable: true, mount: 'inspector', title: 'Routing', icon: <Network size={12} />, appliesTo: ['fixture'], Component: FixtureRoutingPanel },
  { id: 'core.inspector.fixture.layout3d', detachable: true, mount: 'inspector', title: '3D Layout', icon: <Box size={12} />, appliesTo: ['fixture.pixel'], Component: FixtureLayout3DPanel },
  { id: 'core.inspector.fixture.position', detachable: true, mount: 'inspector', title: 'Position', icon: <Move3d size={12} />, appliesTo: ['fixture.light'], Component: FixturePositionPanel },
  // THE MONITORS. What they show is the editor's — its output frames, its render loop, its clocks — so
  // each reads through a seam (services/dmxFeed, services/editorHealth): the services when docked, the
  // live channel here. On a second screen beside the rig is where they are most wanted.
  { id: 'core.browser.timing', mount: 'browser', detachable: true, title: 'Timing', icon: <Timer size={12} />, Component: TimingPanel, HeaderActions: TimingHeaderActions },
  { id: 'core.dock.monitor', mount: 'dock', detachable: true, title: 'DMX Monitor', icon: <Activity size={13} />, Component: MonitorDock },
  { id: 'core.dock.perf', mount: 'dock', detachable: true, title: 'Performance', icon: <Gauge size={13} />, Component: PerfDock },
  // THE PATCHING DOCKS. The fixture library (templates, and the profile library — main answers, so it is
  // the same in any window), a pixel fixture's wiring and ledmap, and Routing: all document edits.
  { id: 'core.dock.fixtureLibrary', mount: 'dock', detachable: true, title: 'Library', icon: <Library size={13} />, Component: FixtureLibraryDock },
  { id: 'core.dock.fixtureWiring', mount: 'dock', detachable: true, title: 'Wiring & Ledmap', icon: <Route size={13} />, appliesTo: ['fixture.pixel'], Component: FixtureWiringDock },
  { id: 'core.dock.routing', mount: 'dock', detachable: true, title: 'Routing', icon: <Network size={13} />, Component: RoutingDock },
  // THE 3D SCENE'S SIDE PANELS — the venue's objects and fixtures, a model's and a fixture's placement,
  // the scene's lighting and tracking settings. Document edits, plus two things that are the 3D VIEW's
  // (a model's named screens, the viewer camera for a UV bake), which come through seams
  // (services/modelScreenNames, services/viewerView) — the editor's 3D view, over the live channel. The
  // 3D view itself stays in the editor (a GPU viewport, docked until the engine).
  { id: 'core.browser.models', mount: 'browser', detachable: true, title: 'Objects', icon: <Box size={12} />, grow: true, Component: ModelsPanel, HeaderActions: ModelsHeaderActions },
  { id: 'core.browser.scene3dFixtures', mount: 'browser', detachable: true, title: 'Fixtures', icon: <Lightbulb size={12} />, grow: true, Component: Scene3DFixturesPanel },
  { id: 'core.inspector.model.transform', mount: 'inspector', detachable: true, title: 'Model', icon: <Box size={12} />, appliesTo: ['model'], Component: ModelTransformPanel },
  { id: 'core.inspector.fixture.arrange', mount: 'inspector', detachable: true, title: 'Arrange', icon: <Grid3x3 size={12} />, appliesTo: ['fixture'], Component: FixtureArrangePanel },
  { id: 'core.inspector.scene.lighting', mount: 'inspector', detachable: true, title: 'Lighting', icon: <Lightbulb size={12} />, defaultOpen: false, Component: SceneLightingPanel },
  { id: 'core.inspector.scene.tracking', mount: 'inspector', detachable: true, title: 'Tracking', icon: <Radar size={12} />, defaultOpen: false, Component: SceneTrackingPanel },
  // THE SHOW MACHINE — a viewport, but not a GPU one: an authoring surface for the state graph, which
  // on a second screen beside the stage is exactly where it is wanted. Its OSC learn and sender list
  // and its "edit this state's timeline" are the editor's (services/smOscInbox, services/editorShell).
  // The id is contexts/index.tsx's VIEWPORT_MACHINE (not imported: that file imports this one).
  { id: 'core.viewport.machine', mount: 'viewport', detachable: true, title: 'Show Machine', Component: StateMachineViewport },
  // THE TAKES DOCKS. Recording is the editor's (services/takesAccess): a window shows the editor's
  // recorder and drives it — Record in a window starts the editor recording what the editor sees.
  { id: 'core.dock.lightingTakes', mount: 'dock', detachable: true, title: 'Lighting Takes', icon: <Lightbulb size={13} />, Component: LightingTakesDock },
  { id: 'core.dock.trackingTakes', mount: 'dock', detachable: true, title: 'Tracking Takes', icon: <Radar size={13} />, Component: TrackingTakesDock },
  // THE MEDIA LIBRARY, in both of its places (the browser column and the dock). Its stills and take
  // sparklines come from the editor (services/thumbView, services/takeDensity).
  { id: 'core.browser.media', mount: 'browser', bare: true, grow: true, detachable: true, title: 'Media Library', icon: <ImageIcon size={12} />, Component: MediaBrowserPanel },
  { id: 'core.dock.media', mount: 'dock', detachable: true, title: 'Media Library', icon: <ImageIcon size={13} />, Component: MediaBrowserPanel },
  // PREFERENCES — a viewport that draws no GPU. The app settings go through the editor; plugin sections
  // are the UI halves'; the editor window's own settings show disabled with a pointer (EditorOnly). The
  // id is contexts/index.tsx's VIEWPORT_PREFERENCES (not imported: that file imports this one).
  { id: 'core.viewport.preferences', mount: 'viewport', detachable: true, menuAction: 'preferences', title: 'Preferences', Component: PreferencesViewport },
  // THE TIMELINE. Its transport, waveforms, stills and OSC sender are the editor's, through seams
  // (services/transportView, peaksView, thumbView, oscTrackView): the playhead here is the editor's clock
  // extrapolated from its anchors, and a seek or a Stop runs there. Its props come from the editor store
  // (components/timeline/TimelineDock — the same adapter the drawer mounts).
  { id: TIMELINE_WINDOW_PANEL, mount: 'dock', detachable: true, title: 'Timeline', icon: <Film size={13} />, Component: TimelineWindowPanel },
];

/** One entry, for the editor's registration (contexts/index.tsx). Throws on an id that is not here. */
export function detachablePanel(id: string): PanelContribution {
  const p = DETACHABLE_PANELS.find((x) => x.id === id);
  if (!p) throw new Error(`[detachable] no panel '${id}'`);
  return p;
}
