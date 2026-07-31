// Calibration plugin — renderer activation (Stage 2, "foundation" slice).
//
// Stage 1 moved the engine + logic here but kept the wizards host-side, so there was no renderer
// `plugin` yet. This registers the first renderer contribution: the projector→main **back-channel**
// tap. The projector windows ack each structured-light pattern with `{ t:'patternShown', … }`; the
// host used to route that from App directly into calibController/slCapture. Now the plugin subscribes
// to the host's projector message stream (`ctx.host.projectors.onMessage`) and feeds its own capture
// controllers — App no longer knows about the calibration ack.
//
// The wizard UIs (CalibWizard/AutoAlignWizard) + their embedded-3D pick workspace stay host-side for
// now (Stage 2b); they'll consume host.projectorOutputs/scene3D/projectors when moved.

import React from 'react';
import { Timer } from 'lucide-react';
import type { RendererPlugin, RendererPluginContext } from '@artlux/sdk/renderer';
import * as calibController from './calibController';
import * as slCapture from './slCapture';
import * as calibWorkspace from './calibWorkspace';
import { setHost } from './calibHost';
import { CalibViewport } from './CalibViewport';
import { CalibProjector } from './CalibProjector';
import { RecalPanel } from './RecalPanel';
import * as venueRegistrar from './venueRegistrar';
import * as autoRecal from './autoRecal';
import { registerCommandHandler } from '@artlux/plugin-show-control/renderer';

// The projector→main message shape we care about (a subset of the host's ProjectorToMain union —
// typed structurally so the plugin doesn't import a host module).
type PatternShown = { t: 'patternShown'; index: number; projW: number; projH: number };

let msgUnsub: (() => void) | null = null;
let venueUnsub: (() => void) | null = null;
let cmdUnsubs: (() => void)[] = [];

// A hidden show-engine window (--broadcast / --headless). App renders null there, so Simulator3D —
// and with it the ONLY caller of registerVenueMesh — never mounts. Read the same query string App
// reads rather than inventing a second notion of run mode.
function isShowEngineWindow(): boolean {
  try {
    const qs = new URLSearchParams(window.location.search);
    return qs.get('broadcast') === '1' || qs.get('headless') === '1';
  } catch { return false; }
}

export const plugin: RendererPlugin = {
  manifest: { id: 'calibration', name: 'Projector Calibration', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    // Give the wizard components host-services access (they mutate outputs/scene + send to projectors
    // through this instead of App callback props). Harmless in projector windows (inert host).
    setHost(ctx.host);

    // The projector-window calibration overlay (structured-light pattern / pose crosshair / render-from-
    // projector). Projector windows mount every registered panel; the editor window ignores this registry.
    ctx.projectorPanels.register({ id: 'calibration', Component: CalibProjector });

    // The calibration WORKBENCH (ROADMAP Stage 2b, closed 2026-07-23). The wizards lived here all
    // along but App mounted them and held their state, because a Stage-coupled workspace had no mount
    // point; the `calib` context is one. The host declares that context (rail slot, title, the 3D as
    // its right pane) and this plugin claims its viewport — so App now imports no calibration UI.
    ctx.panels.register({ id: 'calibration.workbench', mount: 'viewport', title: 'Calibration', Component: CalibViewport });
    ctx.contexts.extend('calib', { viewport: 'calibration.workbench' });

    // Commissioning + status for the unattended recalibration. A Preferences section rather than
    // anything in the wizard: it is a property of the INSTALLATION (which camera, which thresholds,
    // may it write), set once when the venue is handed over, not part of calibrating one projector.
    ctx.settings.register({
      id: 'recalibration', title: 'Recalibration',
      icon: React.createElement(Timer, { size: 12 }),
      Component: RecalPanel,
    } as unknown as Parameters<typeof ctx.settings.register>[0]);

    // Venue meshes for the raycaster in a window that has no 3D viewport. Without this, every
    // markerless solve in a permanent (--broadcast) installation fails with "no venue model loaded" —
    // the pipeline could not run in the mode the venue actually runs in. See venueRegistrar.
    if (isShowEngineWindow()) {
      venueUnsub = venueRegistrar.start(
        () => ctx.host.scene3D.get() as never,
        (cb) => ctx.host.scene3D.subscribe(cb),
      );
    }

    // Maintenance commands. Registering them here — rather than show-control knowing about
    // calibration — means the nightly scheduler and the tablet's POST /command both reach them with
    // no extra plumbing: ScheduleEntry.action is any ShowCommand.
    //
    // Only in the window that owns the projector bridge; a projector window has inert host services
    // and would silently "run" a recalibration that can talk to nothing.
    if (ctx.host.projectors) {
      cmdUnsubs = [
        registerCommandHandler('recalibrate', (c) => {
          const cmd = c as { surfaceId?: string; mode?: 'check' | 'full' };
          void autoRecal.run({ mode: cmd.mode ?? 'check', surfaceId: cmd.surfaceId });
        }),
        registerCommandHandler('calibRevert', (c) => {
          void autoRecal.revertCalibration((c as { surfaceId: string }).surfaceId);
        }),
      ];
      // A run killed part-way (watchdog relaunch, power cut) leaves a marker and no other trace —
      // the project file looks untouched because its single save never happened. Say so, once.
      void autoRecal.reportInterrupted();
    }

    // Only the main window owns the bridge ports, so this fires there; in projector windows the host
    // service is inert and the callback is never invoked.
    msgUnsub = ctx.host.projectors.onMessage((_surfaceId, msg) => {
      const m = msg as { t?: string };
      if (m.t === 'patternShown') {
        const a = m as PatternShown;
        const ack = { index: a.index, projW: a.projW, projH: a.projH };
        calibController.onPatternShown(ack); // board flow
        slCapture.onPatternShown(ack);       // markerless flow (the inactive one is a no-op)
      } else if (m.t === 'calibCrosshair') {
        calibWorkspace.onCrosshair((m as { pixel: [number, number] }).pixel); // projector aim → pending pose pixel
      } else if (m.t === 'calibConfirm') {
        calibWorkspace.onConfirm(); // Enter: releases a live re-aim
      } else if (m.t === 'calibPointDrag') {
        const d = m as { index: number; pixel: [number, number] };
        calibWorkspace.onPointDrag(d.index, d.pixel); // a point grabbed + dragged on the projection
      }
    });
  },

  deactivate(): void {
    msgUnsub?.(); msgUnsub = null;
    venueUnsub?.(); venueUnsub = null;
    for (const u of cmdUnsubs) u();
    cmdUnsubs = [];
  },
};
