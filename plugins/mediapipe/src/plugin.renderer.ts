// MediaPipe pose-tracking plugin — renderer activation.
//
// Registers the contributions the host inverted onto its registries, mirroring the LiDAR plugin:
//   • MEDIAPIPE content source — the GPU marker drawable for surfaces/clips of type MEDIAPIPE, plus
//     acquire/release that refcount the webcam + inference engine (main window only).
//   • 'mediapipe' clip kind    — teaches the timeline engine to treat the lane as non-video.
//   • 'mediapipe' projector channel — snapshots detections to projector windows + self-renders there.
//   • Scene-viz overlay        — the 3D camera-field markers (gated on scene.mediapipeViz).
//   • Pose Monitor panel + settings section — camera/model config + a live debug modal.
//
// Inference (camera + BlazePose WASM) runs ONLY in the main editor window; projector windows consume
// detection snapshots over the bridge and never open a camera.

import type { ComponentType } from 'react';
import type { RendererPlugin, RendererPluginContext, ProjectorChannel } from '@artlux/sdk/renderer';
import type { SurfaceContent, Surface } from '@/types';
import * as poseStore from './poseStore';
import type { PoseSnapshot } from './poseStore';
import * as poseDrawable from './poseDrawable';
import * as poseProjector from './poseProjector';
import * as poseEngine from './poseEngine';
import PoseViz from './PoseViz';
import { PosePanel } from './PosePanel';
import { PoseCalibration } from './PoseCalibration';
import { PoseSettings } from './poseSettings';
import { PoseContentEditor } from './poseContentEditor';
import { setHost } from './poseHost';

export const plugin: RendererPlugin = {
  manifest: { id: 'mediapipe', name: 'MediaPipe Pose', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    setHost(ctx.host);
    poseEngine.setWindow(ctx.window);

    // Pose Monitor: a diagnostic panel (camera preview + fps + tracked count), a DOCK tab on the host's
    // `3d` context (the old `tracking` context merged into it — the 3D scene is where tracked people are
    // drawn). The floor-calibration wizard below stays a MODAL: it is a modal step-by-step flow over the
    // camera image, not something you leave open beside your work.
    ctx.panels.register({ id: 'pose-monitor', mount: 'dock', menuAction: 'pose-monitor', title: 'Pose Monitor', Component: PosePanel });
    ctx.contexts.extend('3d', { dock: ['pose-monitor'] });

    // Pose Floor Calibration: the 4-point wizard relating the camera feed to real floor space; writes
    // Scene3D.mediapipeFloor, which PoseViz reads to place people at real-world positions on the floor.
    ctx.panels.register({ id: 'pose-calibrate', mount: 'modal', menuAction: 'pose-calibrate', title: 'Pose Floor Calibration', Component: PoseCalibration });

    // Preferences section: camera device / model / delegate / max-people / confidence.
    ctx.settings.register({ id: 'mediapipe', title: 'Pose Tracking (MediaPipe)', Component: PoseSettings });

    // MEDIAPIPE content: the host compositor dispatches unknown content types through the registry.
    // acquire/release refcount the inference engine — it starts on the first MEDIAPIPE surface and
    // stops when the last one goes away (main window only; poseEngine gates on the window internally).
    ctx.contentSources.register({
      type: 'MEDIAPIPE', // SourceType.MEDIAPIPE — kept as a core enum value; only behavior lives here
      acquire: (key) => poseEngine.acquire(key),
      getDrawable: (key, content) => poseDrawable.getFor(key, content as SurfaceContent),
      release: (key) => { poseEngine.release(key); poseDrawable.release(key); },
      editor: PoseContentEditor,
      pickerButton: { label: 'MediaPipe', title: 'Camera pose tracking (BlazePose)' },
    });

    // Timeline lane kind: MEDIAPIPE content is a live camera source, not video — skip it on the video
    // sync path and exclude it from the PROGRAM composite (parity with the 'tracking' lane).
    ctx.clipKinds.register({ kind: 'mediapipe', skipVideoSync: true, excludeFromProgram: true });

    // Projector data channel: stream the detection snapshot to projector windows showing MEDIAPIPE
    // content, and self-render the markers there. Registered in BOTH windows — the host calls
    // build/subscribe in the main window (producer) and apply + the GPU trio in each projector window.
    ctx.projectorChannels.register({
      channel: 'mediapipe',
      throttleMs: 16,
      appliesTo: (surface) => (surface as Surface).content.type === 'MEDIAPIPE',
      subscribe: (cb) => poseStore.subscribe(cb),
      build: () => poseStore.snapshot(),
      apply: (payload) => poseStore.applySnapshot(payload as PoseSnapshot),
      projectorSourceSize: (surface) => poseProjector.sourceSize(surface as Surface),
      renderSource: (gl, surface, host) => poseProjector.renderSource(gl, surface as Surface, host),
      onConfig: (_surface, render) => poseProjector.configure(render as { trackingSmoothing?: number; trackingPredictMs?: number }),
    } as ProjectorChannel);

    // 3D scene overlay: the camera field + per-person markers, mounted inside Simulator3D's <Canvas>.
    // Gated on the scene's mediapipeViz flag (default off).
    ctx.sceneViz.register({
      id: 'mediapipe',
      enabled: (s) => (s as { mediapipeViz?: boolean }).mediapipeViz === true,
      Component: PoseViz as ComponentType<{ scene3D: unknown }>,
    });
  },

  deactivate(): void { /* engine stops itself when its last consumer is released */ },

  // On the startup splash. The WASM runtime + model are fetched lazily on the first MEDIAPIPE surface,
  // so "did the model load" is unknowable here — report the contributions, not a guess.
  status: () => ({ state: 'ok', detail: 'webcam pose source · monitor · floor calibration' }),
};
