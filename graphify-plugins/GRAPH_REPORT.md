# Graph Report - plugins  (2026-07-04)

## Corpus Check
- 99 files · ~62,461 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 954 nodes · 1501 edges · 54 communities (52 shown, 2 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 52 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Pose Calibration UI (MediaPipe)|Pose Calibration UI (MediaPipe)]]
- [[_COMMUNITY_Host Registries & Plugin Wiring|Host Registries & Plugin Wiring]]
- [[_COMMUNITY_NDI ManagerContent Source|NDI Manager/Content Source]]
- [[_COMMUNITY_Blob Motion Filtering (LiDAR)|Blob Motion Filtering (LiDAR)]]
- [[_COMMUNITY_NDI+Spout Cross-Process Content Sources|NDI+Spout Cross-Process Content Sources]]
- [[_COMMUNITY_Calib Manager & Native Camera|Calib Manager & Native Camera]]
- [[_COMMUNITY_Spout ManagerContent Source|Spout Manager/Content Source]]
- [[_COMMUNITY_MP4 Decoder|MP4 Decoder]]
- [[_COMMUNITY_Calibration Plugin Modules|Calibration Plugin Modules]]
- [[_COMMUNITY_Calib Camera Capture|Calib Camera Capture]]
- [[_COMMUNITY_Calib Host & Workspace|Calib Host & Workspace]]
- [[_COMMUNITY_MediaPipe Pose Modules|MediaPipe Pose Modules]]
- [[_COMMUNITY_Blob Clustering & Tracking|Blob Clustering & Tracking]]
- [[_COMMUNITY_CV Camera Geometry|CV Camera Geometry]]
- [[_COMMUNITY_Calib Controller (Intrinsics)|Calib Controller (Intrinsics)]]
- [[_COMMUNITY_Calib Native Bindings|Calib Native Bindings]]
- [[_COMMUNITY_Video-Codec Contributions (HAP+MP4)|Video-Codec Contributions (HAP+MP4)]]
- [[_COMMUNITY_OSC Monitor UI|OSC Monitor UI]]
- [[_COMMUNITY_Tracking Store|Tracking Store]]
- [[_COMMUNITY_Auto-Align Wizard  Markerless|Auto-Align Wizard / Markerless]]
- [[_COMMUNITY_HAP Decode|HAP Decode]]
- [[_COMMUNITY_Tracking Playback & Takes|Tracking Playback & Takes]]
- [[_COMMUNITY_Calib Wizard UI|Calib Wizard UI]]
- [[_COMMUNITY_Calib Renderer  Venue Raycast|Calib Renderer / Venue Raycast]]
- [[_COMMUNITY_HAP Manager (Native)|HAP Manager (Native)]]
- [[_COMMUNITY_Structured-Light Capture|Structured-Light Capture]]
- [[_COMMUNITY_mp4box Typings|mp4box Typings]]
- [[_COMMUNITY_Plugin Manifest (package.json)|Plugin Manifest (package.json)]]
- [[_COMMUNITY_Calib Projector & Gray Code|Calib Projector & Gray Code]]
- [[_COMMUNITY_Plugin Manifest (package.json)|Plugin Manifest (package.json)]]
- [[_COMMUNITY_Tracking Drawable (GLCPU)|Tracking Drawable (GL/CPU)]]
- [[_COMMUNITY_Pose GL Pass|Pose GL Pass]]
- [[_COMMUNITY_Pose Store|Pose Store]]
- [[_COMMUNITY_MP4 Codec Contribution|MP4 Codec Contribution]]
- [[_COMMUNITY_Camera Params Panel|Camera Params Panel]]
- [[_COMMUNITY_HAP Player|HAP Player]]
- [[_COMMUNITY_Tracking Recorder|Tracking Recorder]]
- [[_COMMUNITY_MediaPipe Manifest|MediaPipe Manifest]]
- [[_COMMUNITY_Pose Drawable (GLCPU)|Pose Drawable (GL/CPU)]]
- [[_COMMUNITY_Pose Floor Homography|Pose Floor Homography]]
- [[_COMMUNITY_Pose Renderer|Pose Renderer]]
- [[_COMMUNITY_Plugin Manifest (package.json)|Plugin Manifest (package.json)]]
- [[_COMMUNITY_MP4 Manifest|MP4 Manifest]]
- [[_COMMUNITY_Gamma Controller|Gamma Controller]]
- [[_COMMUNITY_HAP GL Renderer|HAP GL Renderer]]
- [[_COMMUNITY_Tracking Viz|Tracking Viz]]
- [[_COMMUNITY_Projector Blend Compute|Projector Blend Compute]]
- [[_COMMUNITY_Venue Raycast Geometry|Venue Raycast Geometry]]
- [[_COMMUNITY_Camera Viewport|Camera Viewport]]
- [[_COMMUNITY_HAP Codec Contribution|HAP Codec Contribution]]
- [[_COMMUNITY_Pose Projector|Pose Projector]]
- [[_COMMUNITY_Camera Mask|Camera Mask]]
- [[_COMMUNITY_HAP Main Plugin|HAP Main Plugin]]
- [[_COMMUNITY_Community 53|Community 53]]

## God Nodes (most connected - your core abstractions)
1. `Calibration RendererPlugin (activate)` - 36 edges
2. `CalibNative` - 16 edges
3. `inv()` - 13 edges
4. `FileDecoder` - 13 edges
5. `AutoAlignWizard (markerless wizard UI)` - 12 edges
6. `startEngine()` - 11 edges
7. `NdiNative` - 10 edges
8. `cameraPixelRayWorld()` - 9 edges
9. `CalibWizard (board wizard UI)` - 9 edges
10. `poseStore (detection pub/sub)` - 9 edges

## Surprising Connections (you probably didn't know these)
- `ingest()` --indirect_call--> `minCutoff()`  [INFERRED]
  mediapipe/src/poseTracking.ts → lidar-tracking/src/blobMotion.ts
- `Calibration RendererPlugin (activate)` --contributes--> `host contribution registries`  [EXTRACTED]
  plugins/calibration/src/plugin.renderer.ts → src/renderer/host/registries.ts
- `trackingStore (OSC blob sink)` --semantically_similar_to--> `mediapipe poseStore (sibling)`  [INFERRED] [semantically similar]
  plugins/lidar-tracking/src/trackingStore.ts → plugins/mediapipe/src/poseStore.ts
- `trackingRenderer (blob viz compute)` --semantically_similar_to--> `mediapipe poseRenderer (sibling)`  [INFERRED] [semantically similar]
  plugins/lidar-tracking/src/trackingRenderer.ts → plugins/mediapipe/src/poseRenderer.ts
- `trackingProjector (projector source render)` --semantically_similar_to--> `mediapipe poseProjector (sibling)`  [INFERRED] [semantically similar]
  plugins/lidar-tracking/src/trackingProjector.ts → plugins/mediapipe/src/poseProjector.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Board structured-light calibration flow** — plugins_calibration_src_calibwizard_component, plugins_calibration_src_calibcontroller_module, plugins_calibration_src_calibcapture_module, plugins_calibration_src_graycode_module, plugins_calibration_src_calibprojector_component, plugins_calibration_src_calibnative_module [INFERRED 0.85]
- **Markerless auto-align geometry flow** — plugins_calibration_src_autoalignwizard_component, plugins_calibration_src_markerlesscontroller_module, plugins_calibration_src_slcapture_module, plugins_calibration_src_cvcamera_module, plugins_calibration_src_venueraycast_module, plugins_calibration_src_cammask_module, plugins_calibration_src_calibnative_module [INFERRED 0.85]
- **Cross-process plugin contribution + IPC bridge wiring** — pluginmain_plugin, pluginrenderer_plugin, plugins_calibration_src_main_barrel, plugins_calibration_src_renderer_barrel, plugins_calibration_src_calibmanager_module, plugins_calibration_src_calibnative_module, plugins_calibration_src_calibhost_module, plugins_calibration_src_calibprojector_component [INFERRED 0.80]
- **Pose tracking capture-to-render flow** — plugins_mediapipe_src_posecamera_capture, plugins_mediapipe_src_poseengine_engine, plugins_mediapipe_src_posestore_store, plugins_mediapipe_src_posetracking_tracker, plugins_mediapipe_src_poserenderer_compute, plugins_mediapipe_src_posepass_gl, plugins_mediapipe_src_posedrawable_stage [EXTRACTED 0.90]
- **MediaPipe projector-channel contribution** — pluginrenderer_plugin, plugins_mediapipe_src_posestore_store, plugins_mediapipe_src_poseprojector_channel, plugins_mediapipe_src_poserenderer_compute, plugins_mediapipe_src_posepass_gl [EXTRACTED 0.85]
- **Floor calibration + real-world preview** — plugins_mediapipe_src_posecalibration_wizard, plugins_mediapipe_src_posehomography_math, plugins_mediapipe_src_posefloor_helpers, plugins_mediapipe_src_poseviz_scene3d, shared_protocol_scene3d [EXTRACTED 0.85]
- **LiDAR take record/playback flow** — plugins_lidar_tracking_src_trackingrecorder_record, plugins_lidar_tracking_src_trackingplayback_replay, plugins_lidar_tracking_src_trackingtake_take, plugins_lidar_tracking_src_trackingstore_snapshot, plugins_lidar_tracking_src_trackingstore_replaysource [EXTRACTED 0.90]
- **TRACKING projector-channel contribution (data+GPU+config)** — pluginrenderer_plugin, ext_projectorchannel_registry, plugins_lidar_tracking_src_trackingprojector_render, plugins_lidar_tracking_src_trackingstore_snapshot, plugins_lidar_tracking_src_blobclustering_clusterandtrack [EXTRACTED 0.85]
- **Shared blob viz render pipeline (store→motion→compute→GL)** — plugins_lidar_tracking_src_trackingstore_store, plugins_lidar_tracking_src_blobmotion_filter, plugins_lidar_tracking_src_trackingrenderer_compute, plugins_lidar_tracking_src_blobpass_compositor, plugins_lidar_tracking_src_trackingdrawable_stage, plugins_lidar_tracking_src_trackingprojector_render [EXTRACTED 0.85]
- **VideoCodec contribution shape (hap + mp4)** — plugins_hap_src_hapcodec_hapcodec, plugins_mp4_src_mp4codec_mp4codec, videoCodecRegistry [INFERRED 0.85]
- **HAP decode pipeline: decode ring → GPU upload → surface clock** — plugins_hap_src_hapdecode_module, plugins_hap_src_hapgl_module, plugins_hap_src_happlayer_module, plugins_hap_src_hapcodec_hapcodec [INFERRED 0.80]
- **Shared codec frame paths: surface / layer / thumbnail** — plugins_hap_src_hapcodec_hapcodec, plugins_mp4_src_mp4codec_mp4codec, plugins_hap_src_happlayer_module, plugins_mp4_src_mp4decoder_module [INFERRED 0.70]
- **NDI cross-process content-source pipeline (native main → IPC → renderer canvas)** — ndi_pluginMain, ndi_manager, ndi_nativeAddon, ndi_receiver, ndi_contentSource, ndi_editor [EXTRACTED 0.90]
- **Spout cross-process content-source pipeline (native main → IPC → renderer canvas)** — spout_pluginMain, spout_manager, spout_nativeAddon, spout_receiver, spout_contentSource, spout_editor [EXTRACTED 0.90]
- **Shared manager+receiver+contentSource+editor plugin template (near-duplicated across NDI and Spout)** — ndi_manager, ndi_receiver, ndi_contentSource, ndi_editor, spout_manager, spout_receiver, spout_contentSource, spout_editor [INFERRED 0.90]

## Communities (54 total, 2 thin omitted)

### Community 0 - "Pose Calibration UI (MediaPipe)"
Cohesion: 0.06
Nodes (40): plugin, CORNERS, DEFAULT_HANDLES, PoseCalibration(), Pt, CameraDevice, start(), stop() (+32 more)

### Community 1 - "Host Registries & Plugin Wiring"
Cohesion: 0.07
Nodes (55): host clipKinds registry, host contentSources registry, window.artlux.onOscMessage IPC bridge, host panels registry, host projectorChannels registry, window.artlux.readFile IPC, host scene3D config service, host sceneViz registry (+47 more)

### Community 2 - "NDI Manager/Content Source"
Cohesion: 0.06
Nodes (27): ndiManager, consumers, ndiContentSource, reconcile(), NdiEditor(), available(), ensureNdiOnPath(), loadNative() (+19 more)

### Community 3 - "Blob Motion Filtering (LiDAR)"
Cohesion: 0.06
Nodes (35): alpha(), Axis, cfg, Config, ingest(), LiveTrack, minCutoff(), newAxis() (+27 more)

### Community 4 - "NDI+Spout Cross-Process Content Sources"
Cohesion: 0.06
Nodes (42): ndiContentSource (ContentSourceProvider), NdiEditor (content picker), NDI /main barrel, ndiManager (native addon loader), native/ndi/ndi.node addon, dependencies, @artlux/sdk, description (+34 more)

### Community 5 - "Calib Manager & Native Camera"
Cohesion: 0.06
Nodes (12): CalibNative, calibrateGuided(), cameraGrab(), cameraGrabColor(), decodeDense(), loadNative(), mapCorners(), native (+4 more)

### Community 6 - "Spout Manager/Content Source"
Cohesion: 0.09
Nodes (19): spoutManager, plugin, plugin, consumers, reconcile(), spoutContentSource, SpoutEditor(), loadNative() (+11 more)

### Community 7 - "MP4 Decoder"
Cohesion: 0.10
Nodes (16): close(), decoders, Enc, ensureOpen(), FileDecoder, frame(), Info, layerDecoders (+8 more)

### Community 8 - "Calibration Plugin Modules"
Cohesion: 0.19
Nodes (24): Calibration MainPlugin (activate), AutoAlignWizard (markerless wizard UI), blendCompute (world-space edge blend), CameraParamsPanel (camera prop sliders), CameraViewport (zoomable pick viewport), calibCapture (camera source browser/native), calibController (board intrinsics orchestration), calibHost (host-services access) (+16 more)

### Community 9 - "Calib Camera Capture"
Cohesion: 0.10
Nodes (12): CameraDevice, CaptureSource, grab(), grabBrowser(), GrayFrame, nativeDims, PropRange, start() (+4 more)

### Community 10 - "Calib Host & Workspace"
Cohesion: 0.13
Nodes (8): getCalibration(), setHost(), storeCalibration(), clearPoses(), pick(), solvePose(), PatternShown, plugin

### Community 11 - "MediaPipe Pose Modules"
Cohesion: 0.11
Nodes (16): poseDrawable, poseEngine, poseFloor, poseHomography, posePass, poseProjector, poseRenderer, poseStore (+8 more)

### Community 12 - "Blob Clustering & Tracking"
Cohesion: 0.11
Nodes (19): clusterAndTrack(), clusterBlobs(), mergeGroup(), resetPeopleTracking(), state, SurfState, Track, trackSurface() (+11 more)

### Community 13 - "CV Camera Geometry"
Cohesion: 0.16
Nodes (15): cameraCenter(), cameraPose(), cameraToWorldRot(), frustumCorners(), glProjectionMatrix(), Mat3, matT(), matToQuat() (+7 more)

### Community 14 - "Calib Controller (Intrinsics)"
Cohesion: 0.12
Nodes (10): Ack, capturePose(), CaptureResult, delay(), imagePoints, IntrinsicsSolve, objectPoints, pointCounts (+2 more)

### Community 15 - "Calib Native Bindings"
Cohesion: 0.19
Nodes (13): calibCalibrateGuided(), calibCalibrateProjector(), calibCameraGetProp(), calibCameraGrab(), calibCameraGrabColor(), calibDecodeDense(), calibDetectAruco(), calibDetectBoard() (+5 more)

### Community 16 - "Video-Codec Contributions (HAP+MP4)"
Cohesion: 0.18
Nodes (17): HAP /main barrel, HAP Main Plugin, HAP Renderer Plugin, HAP /renderer barrel, HAP types (HapInfo/HapFrame), VideoSettings (Preferences section), MP4 index barrel, MP4 Renderer Plugin (+9 more)

### Community 17 - "OSC Monitor UI"
Cohesion: 0.16
Nodes (12): Accum, AddrStat, freshAccum(), OscMonitor(), Row, SurfRow, SurfStat, plugin (+4 more)

### Community 18 - "Tracking Store"
Cohesion: 0.15
Nodes (7): applySnapshot(), getBlob(), getSurface(), ingest(), markDirty(), subs, surfaces

### Community 19 - "Auto-Align Wizard / Markerless"
Cohesion: 0.19
Nodes (12): AutoAlignWizard(), nominalK(), Props, Step, STEPS, CameraPose, CamPick, camPicksFromAruco() (+4 more)

### Community 20 - "HAP Decode"
Cohesion: 0.17
Nodes (9): fill(), Frame, getFrame(), getPipe(), infos, Pipe, pipes, probing (+1 more)

### Community 21 - "Tracking Playback & Takes"
Cohesion: 0.14
Nodes (7): TrackingSnapshot, cache, EMPTY, ensureLoaded(), loading, parse(), TrackingTakeFrame

### Community 22 - "Calib Wizard UI"
Cohesion: 0.16
Nodes (10): BoardConfig, defaultBoardConfig(), bandColor, CalibWizard(), Detect, intrinsicsBand(), poseBand(), Props (+2 more)

### Community 23 - "Calib Renderer / Venue Raycast"
Cohesion: 0.16
Nodes (13): calibCapture, calibController, calibNative, calibWorkspace, slCapture, cast(), _d, groups (+5 more)

### Community 24 - "HAP Manager (Native)"
Cohesion: 0.20
Nodes (10): close(), closeAll(), decode(), HapNative, loadNative(), native, open$, req (+2 more)

### Community 25 - "Structured-Light Capture"
Cohesion: 0.19
Nodes (7): Ack, captureGrayCode(), delay(), GrayCodeCapture, projectField(), Sender, showPattern()

### Community 26 - "mp4box Typings"
Cohesion: 0.15
Nodes (5): MP4File, MP4Info, MP4Sample, MP4Track, MP4VideoTrack

### Community 27 - "Plugin Manifest (package.json)"
Cohesion: 0.17
Nodes (11): dependencies, @artlux/sdk, description, exports, ./main, ./renderer, name, private (+3 more)

### Community 28 - "Calib Projector & Gray Code"
Cohesion: 0.26
Nodes (10): CalibMode, CalibProjector(), hintBox, bitsFor(), CalibPatternKind, fillPattern(), grayCode(), graycodeLayout (+2 more)

### Community 29 - "Plugin Manifest (package.json)"
Cohesion: 0.17
Nodes (11): dependencies, @artlux/sdk, description, exports, ./main, ./renderer, name, private (+3 more)

### Community 30 - "Tracking Drawable (GL/CPU)"
Cohesion: 0.26
Nodes (9): CPUSurf, cpuSurfaces, get(), getFor(), getGL(), GLSurf, glSurfaces, renderCPU() (+1 more)

### Community 31 - "Pose GL Pass"
Cohesion: 0.20
Nodes (7): cache, compile(), GL, linkProg(), PoseInst, Progs, TrailVerts

### Community 32 - "Pose Store"
Cohesion: 0.20
Nodes (5): applySnapshot(), detections, ingest(), markDirty(), subs

### Community 33 - "MP4 Codec Contribution"
Cohesion: 0.26
Nodes (8): ensureRaf(), mp4Codec, setEnabled(), surfaces, tick(), plugin, Settings, VideoSettings()

### Community 34 - "Camera Params Panel"
Cohesion: 0.18
Nodes (10): CameraParamsPanel(), EXPOSURE, FOCUS, FPS_OPTS, GAIN, Props, RESOLUTIONS, SIMPLE (+2 more)

### Community 35 - "HAP Player"
Cohesion: 0.22
Nodes (5): active, ensureRaf(), open(), Src, tick()

### Community 36 - "Tracking Recorder"
Cohesion: 0.27
Nodes (8): cancel(), notify(), start(), stop(), subs, subscribe(), buildDensity(), TrackingTake

### Community 37 - "MediaPipe Manifest"
Cohesion: 0.18
Nodes (10): dependencies, @artlux/sdk, @mediapipe/tasks-vision, description, main, name, private, sideEffects (+2 more)

### Community 38 - "Pose Drawable (GL/CPU)"
Cohesion: 0.29
Nodes (9): CPUSurf, cpuSurfaces, get(), getFor(), getGL(), GLSurf, glSurfaces, renderCPU() (+1 more)

### Community 39 - "Pose Floor Homography"
Cohesion: 0.29
Nodes (6): footPoint(), imageCornerPin(), worldQuad(), imageToWorld(), invert(), multiply()

### Community 40 - "Pose Renderer"
Cohesion: 0.35
Nodes (9): colorFor(), instances(), liveCache, overlayCanvas(), POSE_CONNECTIONS, sourceSize(), tickOnce(), trails() (+1 more)

### Community 41 - "Plugin Manifest (package.json)"
Cohesion: 0.20
Nodes (9): dependencies, @artlux/sdk, description, main, name, private, sideEffects, type (+1 more)

### Community 42 - "MP4 Manifest"
Cohesion: 0.20
Nodes (9): dependencies, @artlux/sdk, mp4box, description, name, private, sideEffects, type (+1 more)

### Community 43 - "Gamma Controller"
Cohesion: 0.33
Nodes (8): delay(), fitGamma(), GammaOpts, GammaResult, GammaSample, luma(), measureGamma(), sampleField()

### Community 44 - "HAP GL Renderer"
Cohesion: 0.31
Nodes (4): GLRenderer, release(), renderers, uploadFrame()

### Community 45 - "Tracking Viz"
Cohesion: 0.29
Nodes (5): Dims, LabelDesc, rect(), SURFACE_COLOR, TrackingViz()

### Community 46 - "Projector Blend Compute"
Cohesion: 0.29
Nodes (4): BlendMap, BlendOptions, Grid, ProjectorBlendInput

### Community 47 - "Venue Raycast Geometry"
Cohesion: 0.57
Nodes (6): cameraPixelRayWorld(), solveGeometry(), blendToAlpha(), regionFromCalibration(), hasVenueMeshes(), raycastVenueBatch()

### Community 48 - "Camera Viewport"
Cohesion: 0.40
Nodes (5): CameraViewport, CameraViewportHandle, Detect, Props, ColorFrame

### Community 49 - "HAP Codec Contribution"
Cohesion: 0.47
Nodes (3): hapCodec, layerState, plugin

### Community 50 - "Pose Projector"
Cohesion: 0.47
Nodes (4): glTex, renderSource(), sourceSize(), texturesFor()

### Community 51 - "Camera Mask"
Cohesion: 0.83
Nodes (3): applyCamMask(), inPoly(), masked()

## Knowledge Gaps
- **257 isolated node(s):** `name`, `version`, `private`, `description`, `type` (+252 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ingest()` connect `Blob Motion Filtering (LiDAR)` to `MediaPipe Pose Modules`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Why does `Calibration RendererPlugin (activate)` connect `Host Registries & Plugin Wiring` to `Calibration Plugin Modules`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _257 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Pose Calibration UI (MediaPipe)` be split into smaller, more focused modules?**
  _Cohesion score 0.056107539450613676 - nodes in this community are weakly interconnected._
- **Should `Host Registries & Plugin Wiring` be split into smaller, more focused modules?**
  _Cohesion score 0.06936026936026936 - nodes in this community are weakly interconnected._
- **Should `NDI Manager/Content Source` be split into smaller, more focused modules?**
  _Cohesion score 0.06377551020408163 - nodes in this community are weakly interconnected._
- **Should `Blob Motion Filtering (LiDAR)` be split into smaller, more focused modules?**
  _Cohesion score 0.06028368794326241 - nodes in this community are weakly interconnected._