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

import type { RendererPlugin, RendererPluginContext } from '@artlux/sdk/renderer';
import * as calibController from './calibController';
import * as slCapture from './slCapture';

// The projector→main message shape we care about (a subset of the host's ProjectorToMain union —
// typed structurally so the plugin doesn't import a host module).
type PatternShown = { t: 'patternShown'; index: number; projW: number; projH: number };

let msgUnsub: (() => void) | null = null;

export const plugin: RendererPlugin = {
  manifest: { id: 'calibration', name: 'Projector Calibration', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    // Only the main window owns the bridge ports, so this fires there; in projector windows the host
    // service is inert and the callback is never invoked.
    msgUnsub = ctx.host.projectors.onMessage((_surfaceId, msg) => {
      const m = msg as { t?: string };
      if (m.t === 'patternShown') {
        const a = m as PatternShown;
        const ack = { index: a.index, projW: a.projW, projH: a.projH };
        calibController.onPatternShown(ack); // board flow
        slCapture.onPatternShown(ack);       // markerless flow (the inactive one is a no-op)
      }
    });
  },

  deactivate(): void { msgUnsub?.(); msgUnsub = null; },
};
