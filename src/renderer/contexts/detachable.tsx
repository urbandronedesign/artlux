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
// Today: the four outliner/browser panels of contexts/panels/browser.tsx and the parameter sections of
// contexts/panels/inspector.tsx (all but Content).

import React from 'react';
import { Box, Cable, Grid3x3, Hash, Layers, Lightbulb, Move3d, Network, SlidersHorizontal, Users } from 'lucide-react';
import type { PanelContribution } from '@artlux/sdk/renderer';
import {
  SurfacesPanel, SurfacesHeaderActions, FixturesPanel, FixturesHeaderActions,
  GroupsPanel, GroupsHeaderActions, GlobalParamsPanel,
} from './panels/browser';
import {
  FixtureChannelsPanel, FixtureLayout3DPanel, FixtureMappingPanel, FixtureOutputPanel, FixturePatchPanel, FixturePositionPanel, FixtureProfilePanel, FixtureRoutingPanel, FixtureSegmentsPanel, SurfaceTransformPanel,
} from './panels/inspector';

export const DETACHABLE_PANELS: PanelContribution[] = [
  { id: 'core.browser.surfaces', mount: 'browser', detachable: true, title: 'Surfaces', icon: <Layers size={12} />, grow: true, Component: SurfacesPanel, HeaderActions: SurfacesHeaderActions },
  { id: 'core.browser.fixtures', mount: 'browser', detachable: true, title: 'Fixtures', icon: <Box size={12} />, grow: true, Component: FixturesPanel, HeaderActions: FixturesHeaderActions },
  { id: 'core.browser.groups', mount: 'browser', detachable: true, title: 'Groups', icon: <Users size={12} />, Component: GroupsPanel, HeaderActions: GroupsHeaderActions },
  { id: 'core.browser.globals', mount: 'browser', detachable: true, title: 'Global Params', icon: <SlidersHorizontal size={12} />, Component: GlobalParamsPanel },
  // The parameter sections of contexts/panels/inspector.tsx. Each one in a window shows what it shows
  // docked, for the current selection (a fixture's Channels faders on a second screen, say). NOT the
  // surface Content section: it lists PLUGIN content sources (NDI, Spout, text, shaders), and plugins do
  // not activate in a panel window yet, so it would offer a smaller menu than the editor's.
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
];

/** One entry, for the editor's registration (contexts/index.tsx). Throws on an id that is not here. */
export function detachablePanel(id: string): PanelContribution {
  const p = DETACHABLE_PANELS.find((x) => x.id === id);
  if (!p) throw new Error(`[detachable] no panel '${id}'`);
  return p;
}
