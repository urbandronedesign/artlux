# Graph Report - plugins  (2026-07-05)

## Corpus Check
- 131 files · ~83,848 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1110 nodes · 1735 edges · 64 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.61)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_poseEngine.ts|poseEngine.ts]]
- [[_COMMUNITY_ndiManager.ts|ndiManager.ts]]
- [[_COMMUNITY_mp4Decoder.ts|mp4Decoder.ts]]
- [[_COMMUNITY_trackingRenderer.ts|trackingRenderer.ts]]
- [[_COMMUNITY_calibManager.ts|calibManager.ts]]
- [[_COMMUNITY_spoutManager.ts|spoutManager.ts]]
- [[_COMMUNITY_server.ts|server.ts]]
- [[_COMMUNITY_renderer.ts|renderer.ts]]
- [[_COMMUNITY_plugin.renderer.ts|plugin.renderer.ts]]
- [[_COMMUNITY_scheduler.ts|scheduler.ts]]
- [[_COMMUNITY_calibWorkspace.ts|calibWorkspace.ts]]
- [[_COMMUNITY_index.ts|index.ts]]
- [[_COMMUNITY_types.ts|types.ts]]
- [[_COMMUNITY_calibCapture.ts|calibCapture.ts]]
- [[_COMMUNITY_AutoAlignWizard.tsx|AutoAlignWizard.tsx]]
- [[_COMMUNITY_augmentaStore.ts|augmentaStore.ts]]
- [[_COMMUNITY_calibNative.ts|calibNative.ts]]
- [[_COMMUNITY_graycode.ts|graycode.ts]]
- [[_COMMUNITY_trackingStore.ts|trackingStore.ts]]
- [[_COMMUNITY_index.ts|index.ts]]
- [[_COMMUNITY_motion.ts|motion.ts]]
- [[_COMMUNITY_calibController.ts|calibController.ts]]
- [[_COMMUNITY_qr.ts|qr.ts]]
- [[_COMMUNITY_hapDecode.ts|hapDecode.ts]]
- [[_COMMUNITY_blobMotion.ts|blobMotion.ts]]
- [[_COMMUNITY_CalibWizard.tsx|CalibWizard.tsx]]
- [[_COMMUNITY_cvCamera.ts|cvCamera.ts]]
- [[_COMMUNITY_OscMonitor.tsx|OscMonitor.tsx]]
- [[_COMMUNITY_auth.ts|auth.ts]]
- [[_COMMUNITY_AugmentaMonitor.tsx|AugmentaMonitor.tsx]]
- [[_COMMUNITY_trackingTake.ts|trackingTake.ts]]
- [[_COMMUNITY_poseTracking.ts|poseTracking.ts]]
- [[_COMMUNITY_MP4File|MP4File]]
- [[_COMMUNITY_augmentaDrawable.ts|augmentaDrawable.ts]]
- [[_COMMUNITY_augmentaRenderer.ts|augmentaRenderer.ts]]
- [[_COMMUNITY_blobPass.ts|blobPass.ts]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_slCapture.ts|slCapture.ts]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_trackingRecorder.ts|trackingRecorder.ts]]
- [[_COMMUNITY_posePass.ts|posePass.ts]]
- [[_COMMUNITY_poseStore.ts|poseStore.ts]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_CameraParamsPanel.tsx|CameraParamsPanel.tsx]]
- [[_COMMUNITY_hapManager.ts|hapManager.ts]]
- [[_COMMUNITY_hapPlayer.ts|hapPlayer.ts]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_index.ts|index.ts]]
- [[_COMMUNITY_poseDrawable.ts|poseDrawable.ts]]
- [[_COMMUNITY_PoseViz.tsx|PoseViz.tsx]]
- [[_COMMUNITY_poseRenderer.ts|poseRenderer.ts]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_gammaController.ts|gammaController.ts]]
- [[_COMMUNITY_hapGL.ts|hapGL.ts]]
- [[_COMMUNITY_HapFrame|HapFrame]]
- [[_COMMUNITY_TrackingViz.tsx|TrackingViz.tsx]]
- [[_COMMUNITY_augmentaProjector.ts|augmentaProjector.ts]]
- [[_COMMUNITY_CameraViewport.tsx|CameraViewport.tsx]]
- [[_COMMUNITY_hapCodec.ts|hapCodec.ts]]
- [[_COMMUNITY_poseProjector.ts|poseProjector.ts]]

## God Nodes (most connected - your core abstractions)
1. `CalibNative` - 16 edges
2. `inv()` - 13 edges
3. `FileDecoder` - 13 edges
4. `route()` - 13 edges
5. `startEngine()` - 11 edges
6. `getPlaylist()` - 11 edges
7. `NdiNative` - 10 edges
8. `load()` - 10 edges
9. `cameraPixelRayWorld()` - 9 edges
10. `solveGeometry()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `begin()` --calls--> `send()`  [INFERRED]
  calibration/src/calibController.ts → show-control/src/server.ts
- `beginScan()` --calls--> `send()`  [INFERRED]
  calibration/src/slCapture.ts → show-control/src/server.ts
- `capturePose()` --calls--> `graycodeLayout`  [EXTRACTED]
  calibration/src/calibController.ts → calibration/src/graycode.ts
- `clearPoses()` --calls--> `storeCalibration()`  [EXTRACTED]
  calibration/src/calibWorkspace.ts → calibration/src/calibHost.ts
- `solveGeometry()` --calls--> `cameraPixelRayWorld()`  [EXTRACTED]
  calibration/src/markerlessController.ts → calibration/src/cvCamera.ts

## Import Cycles
- None detected.

## Communities (64 total, 0 thin omitted)

### Community 0 - "poseEngine.ts"
Cohesion: 0.06
Nodes (40): plugin, CORNERS, DEFAULT_HANDLES, PoseCalibration(), Pt, CameraDevice, start(), stop() (+32 more)

### Community 1 - "ndiManager.ts"
Cohesion: 0.06
Nodes (27): ndiManager, consumers, ndiContentSource, reconcile(), NdiEditor(), available(), ensureNdiOnPath(), loadNative() (+19 more)

### Community 2 - "mp4Decoder.ts"
Cohesion: 0.07
Nodes (24): ensureRaf(), mp4Codec, setEnabled(), surfaces, tick(), close(), decoders, Enc (+16 more)

### Community 3 - "trackingRenderer.ts"
Cohesion: 0.08
Nodes (30): BlobInst, cache, compile(), GL, linkProg(), Progs, TrailVerts, CPUSurf (+22 more)

### Community 4 - "calibManager.ts"
Cohesion: 0.06
Nodes (12): CalibNative, calibrateGuided(), cameraGrab(), cameraGrabColor(), decodeDense(), loadNative(), mapCorners(), native (+4 more)

### Community 5 - "spoutManager.ts"
Cohesion: 0.09
Nodes (19): spoutManager, plugin, plugin, consumers, reconcile(), spoutContentSource, SpoutEditor(), loadNative() (+11 more)

### Community 6 - "server.ts"
Cohesion: 0.10
Nodes (24): begin(), beginScan(), FILE_EXTS, scanProjects(), bearer(), Client, clients, close() (+16 more)

### Community 7 - "renderer.ts"
Cohesion: 0.11
Nodes (21): BlendMap, BlendOptions, Grid, ProjectorBlendInput, blendToAlpha(), regionFromCalibration(), calibCapture, calibController (+13 more)

### Community 8 - "plugin.renderer.ts"
Cohesion: 0.11
Nodes (17): dispatch(), plugin, timers, unsubs, toSvg(), DEFAULTS, EMPTY, getIpc() (+9 more)

### Community 9 - "scheduler.ts"
Cohesion: 0.14
Nodes (22): empty(), file(), getPlaylist(), minuteOfWeek(), occurrences(), parseHM(), resolve(), Resolved (+14 more)

### Community 10 - "calibWorkspace.ts"
Cohesion: 0.12
Nodes (9): getCalibration(), setHost(), storeCalibration(), CalibProjector(), clearPoses(), pick(), solvePose(), PatternShown (+1 more)

### Community 11 - "index.ts"
Cohesion: 0.12
Nodes (20): clusterAndTrack(), clusterBlobs(), mergeGroup(), resetPeopleTracking(), state, SurfState, Track, trackSurface() (+12 more)

### Community 12 - "types.ts"
Cohesion: 0.11
Nodes (15): plugin, DeviceInfo, EngineMetrics, MetricsSnapshot, RenderMetrics, ServerEvent, ShowSnapshot, ShowStatus (+7 more)

### Community 13 - "calibCapture.ts"
Cohesion: 0.10
Nodes (12): CameraDevice, CaptureSource, grab(), grabBrowser(), GrayFrame, nativeDims, PropRange, start() (+4 more)

### Community 14 - "AutoAlignWizard.tsx"
Cohesion: 0.16
Nodes (16): AutoAlignWizard(), nominalK(), Props, Step, STEPS, applyCamMask(), inPoly(), masked() (+8 more)

### Community 15 - "augmentaStore.ts"
Cohesion: 0.15
Nodes (11): applySnapshot(), getObject(), getObjects(), ingestBundle(), markDirty(), num(), objects, scene (+3 more)

### Community 16 - "calibNative.ts"
Cohesion: 0.19
Nodes (13): calibCalibrateGuided(), calibCalibrateProjector(), calibCameraGetProp(), calibCameraGrab(), calibCameraGrabColor(), calibDecodeDense(), calibDetectAruco(), calibDetectBoard() (+5 more)

### Community 17 - "graycode.ts"
Cohesion: 0.16
Nodes (12): CalibMode, hintBox, glProjectionMatrix(), bitsFor(), CalibPatternKind, fillPattern(), grayCode(), graycodeLayout (+4 more)

### Community 18 - "trackingStore.ts"
Cohesion: 0.14
Nodes (8): applySnapshot(), getBlob(), getSurface(), ingest(), markDirty(), subs, surfaces, SurfaceTrack

### Community 19 - "index.ts"
Cohesion: 0.15
Nodes (13): AugmentaContentEditor(), AugmentaSettings(), HostSettings, AugmentaObject, AugmentaScene, AugmentaSnapshot, augmentaDrawable, augmentaProjector (+5 more)

### Community 20 - "motion.ts"
Cohesion: 0.15
Nodes (13): alpha(), Axis, cfg, Config, ingest(), LiveTrack, minCutoff(), MotionSample (+5 more)

### Community 21 - "calibController.ts"
Cohesion: 0.13
Nodes (10): Ack, capturePose(), CaptureResult, delay(), imagePoints, IntrinsicsSolve, objectPoints, pointCounts (+2 more)

### Community 22 - "qr.ts"
Cohesion: 0.20
Nodes (16): addEccAndInterleave(), draw(), ECC_CODEWORDS_PER_BLOCK, Ecl, encode(), getAlignmentPatternPositions(), getBit(), getNumDataCodewords() (+8 more)

### Community 23 - "hapDecode.ts"
Cohesion: 0.17
Nodes (9): fill(), Frame, getFrame(), getPipe(), infos, Pipe, pipes, probing (+1 more)

### Community 24 - "blobMotion.ts"
Cohesion: 0.16
Nodes (12): alpha(), Axis, cfg, Config, ingest(), LiveTrack, minCutoff(), newAxis() (+4 more)

### Community 25 - "CalibWizard.tsx"
Cohesion: 0.16
Nodes (10): BoardConfig, defaultBoardConfig(), bandColor, CalibWizard(), Detect, intrinsicsBand(), poseBand(), Props (+2 more)

### Community 26 - "cvCamera.ts"
Cohesion: 0.28
Nodes (13): cameraCenter(), cameraPixelRayWorld(), cameraPose(), cameraToWorldRot(), frustumCorners(), Mat3, matT(), matToQuat() (+5 more)

### Community 27 - "OscMonitor.tsx"
Cohesion: 0.16
Nodes (11): Accum, AddrStat, freshAccum(), OscMonitor(), Row, SurfRow, SurfStat, EMPTY (+3 more)

### Community 28 - "auth.ts"
Cohesion: 0.27
Nodes (14): Device, deviceName(), file(), genPin(), getPin(), listDevices(), load(), pair() (+6 more)

### Community 29 - "AugmentaMonitor.tsx"
Cohesion: 0.18
Nodes (9): EMPTY, OscSettings, setHost(), useHostSettings(), Accum, AddrStat, AugmentaMonitor(), freshAccum() (+1 more)

### Community 30 - "trackingTake.ts"
Cohesion: 0.15
Nodes (5): cache, EMPTY, ensureLoaded(), loading, parse()

### Community 31 - "poseTracking.ts"
Cohesion: 0.19
Nodes (8): PoseLandmark, alphaFor(), dist2(), ingest(), LiveTrack, OneEuro, Track, tracks

### Community 32 - "MP4File"
Cohesion: 0.15
Nodes (5): MP4File, MP4Info, MP4Sample, MP4Track, MP4VideoTrack

### Community 33 - "augmentaDrawable.ts"
Cohesion: 0.26
Nodes (9): CPUSurf, cpuSurfaces, get(), getFor(), getGL(), GLSurf, glSurfaces, renderCPU() (+1 more)

### Community 34 - "augmentaRenderer.ts"
Cohesion: 0.33
Nodes (10): aspect(), colorFor(), drawCalibration(), instances(), liveCache, overlayCanvas(), sourceSize(), tickOnce() (+2 more)

### Community 35 - "blobPass.ts"
Cohesion: 0.20
Nodes (7): BlobInst, cache, compile(), GL, linkProg(), Progs, TrailVerts

### Community 36 - "package.json"
Cohesion: 0.17
Nodes (11): dependencies, @artlux/sdk, description, exports, ./main, ./renderer, name, private (+3 more)

### Community 37 - "slCapture.ts"
Cohesion: 0.21
Nodes (7): Ack, captureGrayCode(), delay(), GrayCodeCapture, projectField(), Sender, showPattern()

### Community 38 - "package.json"
Cohesion: 0.17
Nodes (11): dependencies, @artlux/sdk, description, exports, ./main, ./renderer, name, private (+3 more)

### Community 39 - "trackingRecorder.ts"
Cohesion: 0.24
Nodes (9): cancel(), notify(), start(), stop(), subs, subscribe(), buildDensity(), TrackingTake (+1 more)

### Community 40 - "posePass.ts"
Cohesion: 0.20
Nodes (7): cache, compile(), GL, linkProg(), PoseInst, Progs, TrailVerts

### Community 41 - "poseStore.ts"
Cohesion: 0.20
Nodes (5): applySnapshot(), detections, ingest(), markDirty(), subs

### Community 42 - "package.json"
Cohesion: 0.17
Nodes (11): dependencies, @artlux/sdk, description, exports, ./main, ./renderer, name, private (+3 more)

### Community 43 - "package.json"
Cohesion: 0.17
Nodes (11): dependencies, @artlux/sdk, description, exports, ./main, ./renderer, name, private (+3 more)

### Community 44 - "package.json"
Cohesion: 0.17
Nodes (11): dependencies, @artlux/sdk, description, exports, ./main, ./renderer, name, private (+3 more)

### Community 45 - "CameraParamsPanel.tsx"
Cohesion: 0.18
Nodes (10): CameraParamsPanel(), EXPOSURE, FOCUS, FPS_OPTS, GAIN, Props, RESOLUTIONS, SIMPLE (+2 more)

### Community 46 - "hapManager.ts"
Cohesion: 0.25
Nodes (8): close(), closeAll(), loadNative(), native, open$, req, hapManager, plugin

### Community 47 - "hapPlayer.ts"
Cohesion: 0.22
Nodes (5): active, ensureRaf(), open(), Src, tick()

### Community 48 - "package.json"
Cohesion: 0.18
Nodes (10): dependencies, @artlux/sdk, @mediapipe/tasks-vision, description, main, name, private, sideEffects (+2 more)

### Community 49 - "index.ts"
Cohesion: 0.18
Nodes (10): poseDrawable, poseEngine, poseFloor, poseHomography, posePass, poseProjector, poseRenderer, poseStore (+2 more)

### Community 50 - "poseDrawable.ts"
Cohesion: 0.29
Nodes (9): CPUSurf, cpuSurfaces, get(), getFor(), getGL(), GLSurf, glSurfaces, renderCPU() (+1 more)

### Community 51 - "PoseViz.tsx"
Cohesion: 0.29
Nodes (6): footPoint(), imageCornerPin(), worldQuad(), imageToWorld(), invert(), multiply()

### Community 52 - "poseRenderer.ts"
Cohesion: 0.35
Nodes (9): colorFor(), instances(), liveCache, overlayCanvas(), POSE_CONNECTIONS, sourceSize(), tickOnce(), trails() (+1 more)

### Community 53 - "package.json"
Cohesion: 0.20
Nodes (9): dependencies, @artlux/sdk, description, main, name, private, sideEffects, type (+1 more)

### Community 54 - "package.json"
Cohesion: 0.20
Nodes (9): dependencies, @artlux/sdk, description, main, name, private, sideEffects, type (+1 more)

### Community 55 - "package.json"
Cohesion: 0.20
Nodes (9): dependencies, @artlux/sdk, mp4box, description, name, private, sideEffects, type (+1 more)

### Community 56 - "gammaController.ts"
Cohesion: 0.33
Nodes (8): delay(), fitGamma(), GammaOpts, GammaResult, GammaSample, luma(), measureGamma(), sampleField()

### Community 57 - "hapGL.ts"
Cohesion: 0.31
Nodes (4): GLRenderer, release(), renderers, uploadFrame()

### Community 58 - "HapFrame"
Cohesion: 0.29
Nodes (4): decode(), HapNative, HapFrame, HapInfo

### Community 59 - "TrackingViz.tsx"
Cohesion: 0.29
Nodes (5): Dims, LabelDesc, rect(), SURFACE_COLOR, TrackingViz()

### Community 60 - "augmentaProjector.ts"
Cohesion: 0.47
Nodes (4): glTex, renderSource(), sourceSize(), texturesFor()

### Community 61 - "CameraViewport.tsx"
Cohesion: 0.40
Nodes (5): CameraViewport, CameraViewportHandle, Detect, Props, ColorFrame

### Community 62 - "hapCodec.ts"
Cohesion: 0.47
Nodes (3): hapCodec, layerState, plugin

### Community 63 - "poseProjector.ts"
Cohesion: 0.47
Nodes (4): glTex, renderSource(), sourceSize(), texturesFor()

## Knowledge Gaps
- **308 isolated node(s):** `name`, `version`, `private`, `description`, `type` (+303 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `begin()` connect `server.ts` to `calibController.ts`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Why does `beginScan()` connect `server.ts` to `slCapture.ts`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _308 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `poseEngine.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.056107539450613676 - nodes in this community are weakly interconnected._
- **Should `ndiManager.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06377551020408163 - nodes in this community are weakly interconnected._
- **Should `mp4Decoder.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06976744186046512 - nodes in this community are weakly interconnected._
- **Should `trackingRenderer.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07549361207897794 - nodes in this community are weakly interconnected._