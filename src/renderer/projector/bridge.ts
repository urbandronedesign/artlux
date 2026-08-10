import type { Surface, Timeline } from '../types';
// Type-only, so this is erased at runtime and adds no module edge to the gate.
import type { BootPhase } from '../services/bootGate';
import type { CornerPin, BezierWarp, SoftEdge, ProjectorCalibration, ProjectorBlend, Scene3D } from '../../../shared/protocol';
import type { AlignAidSpec } from './AlignAids';

export interface ProjectorRender {
  cornerPin: CornerPin;
  warp?: BezierWarp | null;
  softEdge?: SoftEdge;
  gamma?: number;
  brightness?: number; // projector-content master brightness (1 = full)
  colorGain?: [number, number, number]; // per-projector white-point/brightness match (1,1,1 = off)
  blackLift?: [number, number, number]; // per-projector additive black floor (0,0,0 = off)
  // Solved world-space rig blend. Consumed ONLY by the calibrated render path (calibration's
  // ProjectorScene) — the 2D ProjectorGL path blends from softEdge alone, because a 2D warp has no
  // notion of where on the venue geometry a pixel lands.
  blend?: ProjectorBlend | null;
  // Who applies the blend. 'scanout' means NVAPI already carries it in the display's intensity map,
  // so the GPU path must NOT apply it again — a doubled blend is alpha-squared, a dark seam that
  // reads exactly like a mis-set gamma. Mirrors the existing double-WARP guard in App.
  blendOwner?: 'gpu' | 'scanout';
  fpsCap?: number;   // 0 = uncapped
  ndiSend?: boolean; // also publish this output as an NDI source
  ndiFullRes?: boolean; // Broadcast: capture the NDI send at up to 1080p instead of 720p
  trackingSmoothing?: number; // TRACKING content: One-Euro smoothing 0..1
  trackingPredictMs?: number; // TRACKING content: prediction horizon (ms)
}

// Messages over the MessagePort linking the main window and one projector output window
// (set up in main/projector.ts). The projector renders the surface independently at native
// resolution; only the surface config, corner-pin, and transport clock cross the bridge.

export type MainToProjector =
  // `sources` = the surfaces this window's surface DEPENDS ON — today only the surface a SLICE crops.
  // A projector window syncs its own surface alone, so without this a slice could not resolve its
  // source locally and a sliced EFFECT/IMAGE would drop from display-rate local rendering to the
  // 30 fps frame push. Empty/absent for every non-slice surface.
  // `identity` is what this window CALLS ITSELF on screen — the operator's output label and the
  // display it is bound to. The window already put a name on its own overlays (the cold-start sign
  // names the output "so a wall of six projectors tells you WHICH one you are looking at") but it
  // could only read the SURFACE's name, which is the name of the picture, not of the machine.
  // `windowed` is the "this is not a real projector" flag — a movable window on the operator's own
  // screen, used for testing on one monitor. It is what licenses the branding in the corner: on a
  // fullscreen output that would be a watermark burnt onto a wall.
  | { t: 'config'; surface: Surface; sources?: Surface[]; playing: boolean; render: ProjectorRender; identity?: { label?: string; display?: string; windowed?: boolean } } // geometry + look
  | { t: 'timeline'; timeline: Timeline }                     // for LAYER content
  // ~30 fps clock. showTime rides along because an EFFECT SURFACE is drawn against the SHOW clock
  // (surfaceMedia.getDrawable), and a mirror window does not RUN that clock — it is told it. Without it,
  // every generative surface on every projector would be frozen at 0.
  | { t: 'transport'; playing: boolean; playhead: number; showTime: number }
  | { t: 'brightness'; value: number }                        // projector-content master brightness (live drag)
  // THE COLD-START HOLD, MIRRORED TO THE OUTPUT. While the main window is waiting for a freshly-opened
  // project's content to decode (services/bootGate), this window must not put a HALF-LOADED PICTURE on a
  // real projector — a warm pool's first frame with three of four layers still black is not the show, it
  // just looks like the show is broken. So the window draws NOTHING and says "PRELOADING SHOW" instead,
  // which an operator in a venue can read from the floor. Pushed on every gate change and once with the
  // config (a window opened mid-preload has to learn the state it missed).
  | { t: 'boot'; booting: boolean; ready: number; total: number; phase: BootPhase }
  | { t: 'edit'; on: boolean }                                // toggle corner-pin / mesh editing
  // IDENTIFY — put this output's label on the projection, big enough to read from the floor. The
  // question it answers is the one nothing else in the app can: which of the six machines in the
  // ceiling is "Stage Left". Transient and NEVER persisted (it lives in App state beside
  // editingOutputIds, not on ProjectorOutput), so it cannot survive into a show through a save.
  //
  // Drawn as DOM over the canvas, deliberately: it is therefore UNWARPED — legible whatever the
  // corner-pin, calibration or blend is doing, which is the point when you are still rigging — and
  // it is absent from an NDI send of this output, for the same reason the cold-start sign is: an NDI
  // consumer is another machine's input, not a person who needs to be told things.
  | { t: 'identify'; on: boolean }
  // ALIGNMENT AIDS — the patterns you project while physically hanging a rig (grid, blend ladder,
  // focus, greys, bars, 1:1, flat fields). `null` clears. Transient like `identify`, and for the same
  // reason. Drawn unwarped in the raw raster — see projector/AlignAids.tsx for why that is the whole
  // principle rather than a shortcut, and plans/projector-alignment-aids.md for the design.
  | { t: 'aid'; aid: AlignAidSpec | null }
  | { t: 'frame'; bitmap: ImageBitmap }                       // streamed source frame (camera/Spout/DMX-in/NDI + video/layer, decoded once in main)
  // The streamed source has NOTHING to show (a timeline clip ended, a live source dropped). Without
  // this the pump simply stops sending and the window keeps drawing the last bitmap it received —
  // so a finished clip stayed frozen on the projector for the rest of the show. Sent once on the
  // transition, not per frame.
  | { t: 'frameIdle' }
  | { t: 'layerFrame'; layerId: string; bitmap: ImageBitmap } // a timeline layer frame, decoded once in main (TRACKING content background + layers bound to venue meshes in render-from-projector)
  // ANOTHER surface's picture, for a venue mesh bound to it in render-from-projector mode. Distinct
  // from `frame` (this window's OWN surface, which is also the base canvas's picture and whose bitmap
  // ProjectorApp owns): these are transferred to the calibration panel's channel, which owns closing
  // them. Sent only for surfaces a render-active output's VISIBLE geometry actually references — a
  // calibrated window is otherwise streamed nothing, because its base canvas is not what it displays.
  | { t: 'surfaceFrame'; surfaceId: string; bitmap: ImageBitmap }
  // That surface has nothing to show. Same reason `frameIdle` exists: the pump simply stops sending,
  // and a mesh that trusted the last frame would hold a finished clip for the rest of the show.
  | { t: 'surfaceFrameIdle'; surfaceId: string }
  // Main has stopped streaming this layer. A mirror normally expires a held frame ITSELF by
  // re-deriving activeClip() from the timeline + playhead it already has, which is why layerFrame
  // needs no idle for ordinary layers — but PROGRAM_LAYER_ID has no clips, so its composite would be
  // un-expirable. Sent on the stream-stopping transition (binding removed, model hidden, output left
  // render mode), which also fixes the ordinary case of a mesh unbound mid-show holding its picture.
  | { t: 'layerFrameIdle'; layerId: string }
  | { t: 'pluginData'; channel: string; payload: unknown }    // generic per-frame plugin channel (see ProjectorChannel) — e.g. LiDAR tracking snapshots
  // --- calibration (physical-projector calibration: structured light + pose) ---
  // mode gates what the projector draws: 'pattern' = a Gray-code/flat field (SL intrinsics capture),
  // 'crosshair' = faint content + an aim crosshair (pose capture), 'render' = render-from-projector.
  // crosshair (raster px) JUMPS the aim crosshair — used when re-aiming an already-placed point.
  // points (raster px) are the placed pose picks, drawn numbered on the projection so the operator
  // sees which physical features are already anchored; selected highlights the one being edited.
  // meshLook: how render mode draws the venue. 'shaded' = its materials; 'edges' = crease/silhouette
  // edges only (the alignment look — a full wireframe of a dense CAD mesh is noise, and materials can
  // be legitimately near-black: a bound content layer is not streamed to render-mode windows and
  // metallic GLBs go dark without an environment); 'wireframe' = every triangle. In crosshair mode
  // (with a solved `calibration`) the same look is the PICKING underlay, projected live so the
  // operator watches alignment converge as points land.
  // predicted (raster px, parallel to `points`) is where the CURRENT solve reprojects each pick's
  // world point. Drawn as a leader line from the pick — the residual, visible in place on the object.
  | { t: 'calib'; mode: 'idle' | 'pattern' | 'crosshair' | 'render'; crosshair?: [number, number]; calibration?: ProjectorCalibration | null; points?: [number, number][]; selected?: number | null; meshLook?: 'shaded' | 'edges' | 'wireframe'; predicted?: ([number, number] | null)[] }
  // Set the current structured-light pattern; the projector renders it raw (no warp/gamma) and acks.
  // 'fill' projects a flat RGB field at `rgb` (0..255) — used for camera-based gamma/colour measurement.
  // 'dots' additionally carries the projector-raster points to light (the drift check's probes).
  | { t: 'calibPattern'; kind: 'plane' | 'white' | 'black' | 'off' | 'fill' | 'dots'; index: number; rgb?: [number, number, number]; dots?: [number, number][] }
  // The 3D venue scene (models) for render-from-projector mode.
  | { t: 'scene'; scene3D: Scene3D }
  // A BAKED CALIBRATION MAP for this output — the imported-file path (plugins/calibration bakedStore).
  //
  // `uv` is w*h*3, (u, v, spare) per projector pixel, NaN where the projector has no content. V is
  // Y-UP (v=0 is the bottom of the picture) because the bake measures it off geometry — the mesh's own
  // uv attribute, or NDC mapped to [0,1]. A consumer sampling a top-row-first texture must flip it;
  // ProjectorGL's baked shader does, and says why there.
  //
  // The window uploads it once and then warps every frame through it, which is the whole point: it stops
  // needing the venue model, the 3D scene and the depth pass that render-from-projector requires.
  //
  // Sent ONCE per import, not per frame — it is ~10 MB at native raster, and the buffer is transferred
  // rather than copied. `null` withdraws it and returns the window to the mesh warp; without that,
  // clearing a calibration would leave the output silently frozen on the last map it was given.
  | { t: 'bakedMap'; map: { w: number; h: number; uv: Float32Array } | null };

export type ProjectorToMain =
  | { t: 'ready' }                           // window mounted; (re)send config
  | { t: 'cornerPin'; cornerPin: CornerPin } // committed corner-pin (drag end / nudge)
  | { t: 'warp'; warp: BezierWarp }          // committed Bézier control net
  | { t: 'editOff' }                         // user dismissed edit mode (Esc) in the window
  // --- calibration ---
  | { t: 'patternShown'; index: number; projW: number; projH: number } // ack: pattern on screen (raster reported so main knows projector resolution)
  | { t: 'calibCrosshair'; pixel: [number, number] }  // current crosshair position in projector raster px (float)
  | { t: 'calibConfirm' }                             // Enter: releases a live re-aim (otherwise a no-op)
  // A placed pose pick grabbed and dragged directly ON the projection (raster px, streamed while
  // dragging — main solves provisionally and commits the document once, on the release below).
  | { t: 'calibPointDrag'; index: number; pixel: [number, number] }
  | { t: 'calibPointDragEnd' };
