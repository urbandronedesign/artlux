// Writes multi-projector.artlux — two projectors calibrated onto one wide curved screen, and blended.
//
//   node make-project.cjs            # (re)write the project next to this script
//
// Run make-scene.py (in Blender) first: it writes assets/models/panorama-venue.blend and its .glb.
//
// THE SHAPE OF A RIG. One surface, Screen, carries the PICTURE: the test card, bound to screen_main,
// so it wraps the whole panorama. Each projector has an output of its own (Projector Left / Projector
// Right) — once calibrated, an output draws the venue from where its projector stands, so both show
// their own part of the same Screen picture, and the rig blend cross-fades them where they overlap.
// Until then each output shows the test card flat, so a window is never blank while setting up.
// The test card is the manual-calibration template's, shared rather than copied.

const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { TESTCARD } = require('../manual-calibration/make-project.cjs');

const OUT = join(__dirname, 'multi-projector.artlux');
const VENUE_NAME = 'panorama-venue';

const card = (opacity = 1) => ({ type: 'SHADER', shaderId: 'plasma', shaderSource: TESTCARD, shaderRes: 1080, opacity });
// Screen is 10:3 — the arc's 6 m by its 1.8 m, so the card's cells stay square along the curve.
const SCREEN = { id: 'srf_screen', name: 'Screen', x: 0.05, y: 0.05, width: 0.9, height: 0.27, rotation: 0, zIndex: 0, content: card() };
const LEFT = { id: 'srf_proj_left', name: 'Projector Left', x: 0.05, y: 0.45, width: 0.4, height: 0.225, rotation: 0, zIndex: 1, aspect: '16:9', portrait: false, content: card() };
const RIGHT = { id: 'srf_proj_right', name: 'Projector Right', x: 0.55, y: 0.45, width: 0.4, height: 0.225, rotation: 0, zIndex: 1, aspect: '16:9', portrait: false, content: card() };

const output = (s) => ({
  surfaceId: s.id, name: s.name, enabled: true, displayId: -1, // windowed: opens on any machine
  cornerPin: { tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1] }, warp: null,
  softEdge: { left: 0, right: 0, top: 0, bottom: 0, gamma: 2.2 }, gamma: 1,
});

// The venue: the .blend itself, with its own origin, so ArtLux coordinates are Blender's.
const VENUE = {
  id: 'mdl_venue', name: VENUE_NAME, kind: 'mesh',
  source: `assets/models/${VENUE_NAME}.blend`, path: `assets/models/${VENUE_NAME}.glb`, origin: 'file',
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1, visible: true,
  screens: { screen_main: { surfaceId: SCREEN.id } },
};

const project = {
  version: '1.2',
  timestamp: new Date(0).toISOString(),
  globalBrightness: 1,
  groups: [],
  scenes: [],
  cueBanks: [],
  schedule: undefined,
  assets: [{ id: 'asset_venue', name: VENUE_NAME, type: 'model', path: VENUE.source }],
  projectorOutputs: [output(LEFT), output(RIGHT)],
  controllers: [{ id: 'ctl_local', name: 'Loopback', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, startUniverse: 0 }],
  scene3D: {
    models: [VENUE], lightIntensity: 1, environment: true, exposure: 1, gridVisible: true,
    reflectiveFloor: false, trackingViz: false, augmentaViz: false, trackingSmoothing: 0.6, trackingPredictMs: 50,
  },
  timeline: { layers: [], clips: [], duration: 40, fps: 30, markers: [], inPoint: null, outPoint: null, loop: true, trackingTakes: [] },
  surfaces: [SCREEN, LEFT, RIGHT],
  fixtures: [],
};

writeFileSync(OUT, JSON.stringify(project, null, 2) + '\n');
console.log(`wrote ${OUT}`);
