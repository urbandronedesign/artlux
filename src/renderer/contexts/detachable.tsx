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
// Today that is the four outliner/browser panels of contexts/panels/browser.tsx; the inspectors follow
// once their files stop importing the engine.

import React from 'react';
import { Layers, Box, Users, SlidersHorizontal } from 'lucide-react';
import type { PanelContribution } from '@artlux/sdk/renderer';
import {
  SurfacesPanel, SurfacesHeaderActions, FixturesPanel, FixturesHeaderActions,
  GroupsPanel, GroupsHeaderActions, GlobalParamsPanel,
} from './panels/browser';

export const DETACHABLE_PANELS: PanelContribution[] = [
  { id: 'core.browser.surfaces', mount: 'browser', detachable: true, title: 'Surfaces', icon: <Layers size={12} />, grow: true, Component: SurfacesPanel, HeaderActions: SurfacesHeaderActions },
  { id: 'core.browser.fixtures', mount: 'browser', detachable: true, title: 'Fixtures', icon: <Box size={12} />, grow: true, Component: FixturesPanel, HeaderActions: FixturesHeaderActions },
  { id: 'core.browser.groups', mount: 'browser', detachable: true, title: 'Groups', icon: <Users size={12} />, Component: GroupsPanel, HeaderActions: GroupsHeaderActions },
  { id: 'core.browser.globals', mount: 'browser', detachable: true, title: 'Global Params', icon: <SlidersHorizontal size={12} />, Component: GlobalParamsPanel },
];
