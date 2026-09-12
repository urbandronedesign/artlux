// RENDERER SIDE OF THE BAKE — one dock panel in the Surfaces workbench, and the host handle it needs.
//
// No new workspace context, deliberately. A bake is an authoring action ON a surface, and the place
// an operator already goes to work on surfaces is `mapping`; adding a tenth context so that a form
// could have somewhere to live would be adding to the shell instead of asking what it is for.

import type { RendererPlugin, RendererPluginContext } from '@artlux/sdk/renderer';
import { BakePanel } from './BakePanel';
import { setBakeHost } from './bakeHost';
import * as client from './bakeClient';
import * as runner from './bakeRunner';
import type { BakeRequest } from './types';
import type { Surface } from '@/types';
import { timeline } from '@/services/timeline';
import { videoCodecRegistry } from '@/host/registries';

export const bakeRendererPlugin: RendererPlugin = {
  manifest: { id: 'bake', name: 'Bake', version: '0.0.0' },

  activate(ctx: RendererPluginContext) {
    // Projector windows have no editor state and never render; a render belongs to the main window
    // only, and the host's NOOP_HOST there would make every service a no-op anyway.
    if (ctx.window !== 'main') return;

    client.setIpc(ctx.ipc);
    setBakeHost(ctx.host);

    // `menuAction` is not decoration: it is how the host resolves "go to the owning context and select
    // that tab", so one entry serves the View menu and anything that wants to open this by name. A
    // panel an operator cannot find by name reads as a missing feature.
    ctx.panels.register({
      id: 'bake',
      mount: 'dock',
      menuAction: 'bake',
      title: 'Bake',
      Component: BakePanel,
    });

    // Append to the workbench that already owns surfaces rather than declaring a new one.
    ctx.contexts.extend('mapping', { dock: ['bake'] });

    // A DIAGNOSTIC DOOR, the same idiom as window.__artluxProjPump(). A render is the one operation
    // here that can run for minutes, and reproducing a stall by clicking through a dock panel makes
    // the measurement depend on the UI being reachable — which, when a render hangs, it is not.
    // Takes the same request the panel builds; returns the same result.
    (window as unknown as { __artluxBake?: unknown }).__artluxBake = async (req: Partial<BakeRequest>) => {
      const surfaces = (ctx.host.surfaces.list() as Surface[]) ?? [];
      const s = req.surfaceId ? surfaces.find((x) => x.id === req.surfaceId) : surfaces[0];
      if (!s) return { kind: 'refused', reason: 'no surfaces' };
      return runner.run({
        surfaceId: s.id, startSec: 0, endSec: 1, fps: 5, width: 320, height: 240,
        clock: 'show', bitrate: 4_000_000, audio: false, ...req,
      }, surfaces, (p) => console.info(`[bake] progress ${p.frame}/${p.frames} ${p.rate.toFixed(1)}fps`));
    };
    // What range the panel would offer, and where a render would land — the two things an operator
    // reads off this panel before pressing anything, so they are worth being able to ask for directly.
    (window as unknown as { __artluxBakeRange?: unknown }).__artluxBakeRange = () => ({
      boundIn: timeline.getStart(), boundOut: timeline.getEnd(),
      showIn: timeline.getGlobalStart(), showOut: timeline.getGlobalEnd(),
      docFps: timeline.getFps(), project: ctx.host.project.path(),
    });
    (window as unknown as { __artluxProbeSources?: unknown }).__artluxProbeSources = (ids: string[] | null, a: number, b: number) =>
      timeline.contributingSources(ids, a, b).map((src) => {
        const codec = videoCodecRegistry.forPath(src.path);
        const info = codec?.sourceInfo ? codec.sourceInfo(src.path) : null;
        return { file: src.path.split(/[\/]/).pop(), codec: codec?.id ?? null, info };
      });
    (window as unknown as { __artluxSurfaces?: unknown }).__artluxSurfaces = () =>
      (ctx.host.surfaces.list() as Surface[]).map((s) => ({ id: s.id, name: s.name, type: String(s.content.type) }));
  },
};
