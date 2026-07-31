import type { Surface, Timeline } from '../types';
import type { CornerPin, BezierWarp, SoftEdge, ProjectorCalibration, ProjectorBlend, Scene3D } from '../../../shared/protocol';

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
  | { t: 'config'; surface: Surface; sources?: Surface[]; playing: boolean; render: ProjectorRender } // geometry + look
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
  | { t: 'boot'; booting: boolean; ready: number; total: number }
  | { t: 'edit'; on: boolean }                                // toggle corner-pin / mesh editing
  | { t: 'frame'; bitmap: ImageBitmap }                       // streamed source frame (camera/Spout/DMX-in/NDI + video/layer, decoded once in main)
  // The streamed source has NOTHING to show (a timeline clip ended, a live source dropped). Without
  // this the pump simply stops sending and the window keeps drawing the last bitmap it received —
  // so a finished clip stayed frozen on the projector for the rest of the show. Sent once on the
  // transition, not per frame.
  | { t: 'frameIdle' }
  | { t: 'layerFrame'; layerId: string; bitmap: ImageBitmap } // a timeline layer frame, decoded once in main (TRACKING content background + layers bound to venue meshes in render-from-projector)
  | { t: 'pluginData'; channel: string; payload: unknown }    // generic per-frame plugin channel (see ProjectorChannel) — e.g. LiDAR tracking snapshots
  // --- calibration (physical-projector calibration: structured light + pose) ---
  // mode gates what the projector draws: 'pattern' = a Gray-code/flat field (SL intrinsics capture),
  // 'crosshair' = faint content + an aim crosshair (pose capture), 'render' = render-from-projector.
  // crosshair (raster px) JUMPS the aim crosshair — used when re-aiming an already-placed point.
  // points (raster px) are the placed pose picks, drawn numbered on the projection so the operator
  // sees which physical features are already anchored; selected highlights the one being edited.
  // wireframe: render mode draws the venue as bright edges instead of its materials — the verify look.
  // In crosshair mode (with a solved `calibration`) it is the PICKING underlay: the live wireframe +
  // vertex dots projected while the operator places points, so alignment is visible as it improves.
  // Materials can be legitimately near-black (a bound content layer is not streamed to render-mode
  // windows; metallic CAD GLBs go dark without an environment), and verify is about GEOMETRY: edges
  // landing on edges is readable on the real object when a shaded render is not.
  | { t: 'calib'; mode: 'idle' | 'pattern' | 'crosshair' | 'render'; crosshair?: [number, number]; calibration?: ProjectorCalibration | null; points?: [number, number][]; selected?: number | null; wireframe?: boolean }
  // Set the current structured-light pattern; the projector renders it raw (no warp/gamma) and acks.
  // 'fill' projects a flat RGB field at `rgb` (0..255) — used for camera-based gamma/colour measurement.
  // 'dots' additionally carries the projector-raster points to light (the drift check's probes).
  | { t: 'calibPattern'; kind: 'plane' | 'white' | 'black' | 'off' | 'fill' | 'dots'; index: number; rgb?: [number, number, number]; dots?: [number, number][] }
  // The 3D venue scene (models) for render-from-projector mode.
  | { t: 'scene'; scene3D: Scene3D };

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
  // dragging — main throttles the re-solve).
  | { t: 'calibPointDrag'; index: number; pixel: [number, number] };
