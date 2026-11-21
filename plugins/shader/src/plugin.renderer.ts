// Shader plugin — renderer activation.
//
// Phase 0 registers exactly one contribution: the SHADER content source. No panel, no editor, no
// library. What it proves is the seam — that a plugin can put GPU-generated pixels on a surface with
// no core rendering change — and what it measures is fill-rate, which is the number every later phase
// is budgeted against.
//
// It activates in BOTH windows. The main window renders at LED density for the mapper; a projector
// window will render the same source at its native raster (Phase 6) rather than being sent pixels —
// which is why the source text, not the picture, is the thing that travels.

import type { RendererPlugin, RendererPluginContext, ProjectorChannel } from '@artlux/sdk/renderer';
import type { Surface, SurfaceContent } from '@/types';
import * as trackingTap from './trackingTap';
import { sourceOf } from './shaderSource';
import * as shaderDrawable from './shaderDrawable';
import { isAvailable } from './shaderContext';
import { maxRenderHeight, rendererDescription } from './shaderContext';
import { ShaderEditorPanel } from './ShaderEditorPanel';
import { ShaderNodePanel } from './ShaderNodePanel';
import { shaderAutomation, setSurfaces } from './shaderParams';
import { ShaderLibraryPanel } from './ShaderLibraryPanel';
import * as libraryClient from './libraryClient';
import * as audioTap from './audioTap';
import { ShaderSettings, readCfg } from './ShaderSettings';
import { DEFAULT_BAND_FALL_SEC } from './audioTap';
import { DEFAULT_BEAT_FALL_SEC } from './beatDetect';

let unsubSurfaces: (() => void) | null = null;
let unsubSettings: (() => void) | null = null;
let unsubTracking: (() => void) | null = null;

export const plugin: RendererPlugin = {
  manifest: { id: 'shader', name: 'Shaders', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    // Tell the drawable which window it is in — a projector renders at its display's own resolution,
    // the main window at LED density. See sizeFor.
    shaderDrawable.setWindowKind(ctx.window);

    // Sound, for shaders that react to it. The analyser lives in the audio engine, which belongs to
    // another plugin — the two meet at a channel NAME rather than an import, because importing that
    // plugin here would give the bundler a second identity for its native handle. See audioTap.ts.
    audioTap.setIpc(ctx.ipc);
    audioTap.start();

    // The dampers, live. Applied on every settings change rather than read once at activation: the
    // whole point is to dial them while the music is playing and see the difference.
    const applyDamping = () => {
      const cfg = readCfg(ctx.host.settings.get());
      audioTap.setDamping(cfg.bandFallSec ?? DEFAULT_BAND_FALL_SEC, cfg.beatFallSec ?? DEFAULT_BEAT_FALL_SEC);
    };
    applyDamping();
    unsubSettings = ctx.host.settings.subscribe(applyDamping);

    // 'SHADER' is an OPEN content-type string, not a SourceType enum value: `SurfaceContent.type`
    // accepts any plugin type id and the compositor dispatches unknown types through this registry
    // (contentSource.getDrawable's default branch). So a new content type costs zero core enum edits
    // and zero project-file migration.
    ctx.contentSources.register({
      // Deterministic enough to render off the wall clock, once the three things that were not are
      // handled: iWallTime and iFrame now come from the render clock (shaderContext), and every
      // feedback buffer is dropped on each mode flip so a render starts cold. What remains -- a
      // feedback shader's dependence on the rate it is stepped at -- is inherent to feedback, and a
      // fixed-rate render is MORE reproducible than live playback, not less.
      offlineSafe: true,
      type: 'SHADER',
      getDrawable: (key, content, timeSec) => shaderDrawable.getFor(key, content as SurfaceContent, timeSec),
      // Lets the 3D texture upload, the projector pump and each projector window skip a frame whose
      // pixels did not change — which, because timeSec is SHOW time, is every frame of a paused show.
      getDrawableGeneration: (key) => shaderDrawable.generationOf(key),
      release: (key) => shaderDrawable.release(key),
      // Its editor fragment is the UI half's (ui.ts), activated by the host in every window.
    });

    // What the content editor fragment needs from THIS window's GL context, for whichever window it
    // is drawn in (ui.ts reads them through the live view). The compile is the drawable's own cached
    // one, so asking costs nothing the surface had not already paid. The GPU's name is learned when the
    // context is first made, which is not an event, so it is polled once a second while watched.
    ctx.live.stream('shader.compile', { watch: () => () => {}, read: (p) => shaderDrawable.compileStatus(p as SurfaceContent) });
    ctx.live.stream('shader.gpu', {
      watch: (onNew) => {
        let last = rendererDescription();
        const t = setInterval(() => { const n = rendererDescription(); if (n !== last) { last = n; onNew(); } }, 1000);
        return () => clearInterval(t);
      },
      read: () => ({ maxHeight: maxRenderHeight(), renderer: rendererDescription() }),
    });

    // People, for shaders that react to them (the Tracking nodes). The MAIN window reads the LiDAR
    // plugin's tracked people once per frame; a projector window has no OSC and no tracker, so the main
    // window sends it the finished buffers over this channel — only to projectors showing a shader that
    // actually reads them. Registered in both windows: main produces, projectors apply.
    //
    // THE TICK IS onPlayhead, NOT the tracking store's subscription. The store only notifies when OSC
    // arrives, so the frame somebody's last blob went stale would never be sent and a projector would
    // keep drawing a person who has left. onPlayhead fires every frame, paused included — and it fires
    // AFTER the LiDAR plugin's own per-frame people.refresh(), because that plugin activates first.
    if (ctx.window === 'main') {
      unsubTracking = ctx.onPlayhead(() => trackingTap.update(performance.now()));
    }
    ctx.projectorChannels.register({
      channel: 'shader-tracking',
      throttleMs: 16,
      appliesTo: (surface) => {
        const c = (surface as Surface).content as SurfaceContent | undefined;
        return c?.type === 'SHADER' && trackingTap.readsPeople(sourceOf(c));
      },
      subscribe: (cb) => ctx.onPlayhead(() => cb()),
      build: () => trackingTap.toPayload(),
      apply: (payload) => trackingTap.applyPayload(payload as trackingTap.TrackingPayload),
    } as ProjectorChannel);

    // Everything below belongs to the window that has an editor and a document. A projector window
    // activates this plugin too — it must render shaders — but it has no selection to edit, no
    // surfaces list to enumerate, and no business standing up a CodeMirror it can never show.
    if (ctx.window !== 'main') return;

    // NO AUTHORING UI IN A SHOW LAUNCH. --broadcast runs with the editor window hidden and nobody at
    // the keyboard, so a CodeMirror and a library browser there are pure cost with no operator to use
    // them — and the plan's rule that a shader must never be compiled on the show path is easiest to
    // keep when the thing that compiles is not there. Shaders still RENDER: the outputs are the point.
    if (new URLSearchParams(location.search).get('broadcast') === '1') return;

    // The editor: a DOCK TAB on the mapping workbench, beside the media library and the monitor —
    // not a workspace context of its own.
    ctx.panels.register({ id: 'shader-editor', mount: 'dock', title: 'Shader', Component: ShaderEditorPanel });
    ctx.panels.register({ id: 'shader-nodes', mount: 'dock', title: 'Shader Nodes', Component: ShaderNodePanel });

    // The library goes in the BROWSER column, beside Surfaces and the Media Library — it is a place you
    // pick content FROM, which is what that column is for. The editor is a dock tab because it is a
    // place you work IN.
    ctx.panels.register({ id: 'shader-library', mount: 'browser', title: 'Effects', grow: true, Component: ShaderLibraryPanel });
    ctx.contexts.extend('mapping', { dock: ['shader-editor', 'shader-nodes'], browser: ['shader-library'] });

    // The library lives in files, and only main has a filesystem.
    libraryClient.setIpc(ctx.ipc);
    void libraryClient.refresh();

    // Every declared input becomes a timeline lane, an OSC address and a state-machine value at once,
    // because the host resolves an automation path by its HEAD and hands the rest to whoever owns it —
    // core never learns what a shader parameter is. The provider has to SEE the surfaces to enumerate
    // their parameters, which is what the subscription is for.
    ctx.settings.register({ id: 'shader', title: 'Shaders', Component: ShaderSettings } as never);

    ctx.automationTargets.register(shaderAutomation);
    setSurfaces(ctx.host.surfaces.list() as Surface[]);
    unsubSurfaces = ctx.host.surfaces.subscribe(() => setSurfaces(ctx.host.surfaces.list() as Surface[]));
  },

  deactivate(): void {
    unsubSurfaces?.(); unsubSurfaces = null;
    unsubSettings?.(); unsubSettings = null;
    unsubTracking?.(); unsubTracking = null;
  },

  // On the startup splash. The honest thing to report is whether this machine gave us a context at
  // all: without WebGL2 every shader surface is black, and that must not be discovered on stage.
  status: () => (isAvailable()
    ? { state: 'ok', detail: 'GLSL generative content · one shared WebGL2 context' }
    : { state: 'degraded', detail: 'webgl2 unavailable — shader content disabled' }),
};
