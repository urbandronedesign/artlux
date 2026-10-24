// Writes interactive-show.artlux — the template behind the interactive-show course and the screenshots
// in the user guide that show the show workflow.
//
//   node make-project.cjs            # (re)write the project next to this script
//
// WHY A GENERATOR. The project is the single source for a whole course's screenshots, so it has to be
// reproducible: a tweak (a zone moved, a dwell changed) is one edit here, re-run, re-shoot — never a
// hand-edit nobody can repeat. The media comes from make-media.cjs; run that first.
//
// THE SHOW. A lobby: nobody there → ATTRACT. Someone walks into the Entrance → WELCOME, which asks them
// to choose a side. They hold the Left or the Right pad → STORY A or STORY B (the branch). The room
// empties → back to ATTRACT, from wherever the show is, by ONE global rule.
//
// Every transition is a LiDAR zone rule, so each one can be explained by pointing at a zone in 3D.
// Each zone wears the colour of the state it leads to, and so does that state's clip.
//
// SEPARATE TRACK IDS PER SCENE, on purpose. MP4 layer decoders are keyed by track id; scenes that
// share ids share a decoder, so a state change re-seeks it on the cut (~5 frames held, see
// plans/2026-10-24-session-record.md). Distinct ids let the preloader warm each next state's clip on
// its own decoder, which is the clean cut a template should demonstrate.

const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const OUT = join(__dirname, 'interactive-show.artlux');
const CLIP_SEC = 20; // make-media.cjs DURATION

// ── The three zones (tracker space, normalised 0..1 on the floor, SOL) ──────────────────────────────
// v = 1 is the WALL edge of the floor and v = 0 the edge facing it (TrackingViz.blobPosition), so the
// Entrance is the strip at v ≈ 0 where people come in, and the two pads sit either side, near the wall
// where the story plays.
const ZONES = [
  { id: 'zn_entrance', name: 'Entrance', surface: 'SOL', u0: 0.36, u1: 0.64, v0: 0.04, v1: 0.30, color: '#f59e0b', minBlobs: 1 },
  { id: 'zn_left', name: 'Left pad', surface: 'SOL', u0: 0.06, u1: 0.32, v0: 0.45, v1: 0.85, color: '#10b981', minBlobs: 1 },
  { id: 'zn_right', name: 'Right pad', surface: 'SOL', u0: 0.68, u1: 0.94, v0: 0.45, v1: 0.85, color: '#d946ef', minBlobs: 1 },
];

// ── The screens in the 3D scene ─────────────────────────────────────────────────────────────────────
// The venue, at the tracker's own scale (TrackingViz: floor x ∈ ±W/2, z ∈ 0..D, the wall in the z = 0
// plane), so a zone, a visitor's marker and the picture on the wall all line up in one view — which is
// what lets the course explain a transition by pointing at the room. A screen is a 16:9 plane, 1 m tall
// at scale 1, showing a SURFACE's live picture (surfaceId), so it plays whatever that state is playing.
const ROOM_W = 5.825, ROOM_D = 3.125;
const MODELS = [
  {
    // The wall screen: 4.6 m × 2.6 m, centred, 0.3 m off the floor, a hair in front of the wall plane.
    id: 'mdl_wall_screen', name: 'Wall screen', kind: 'plane', path: '', surfaceId: 'srf_wall',
    position: { x: 0, y: 1.6, z: 0.02 }, rotation: { x: 0, y: 0, z: 0 }, scale: 2.6, visible: true,
  },
  {
    // The floor projection, covering the tracked floor exactly — non-uniform scale turns the 16:9
    // plane into the 5.825 × 3.125 m floor. Laid flat (-90° about x) and lifted 2 mm off the grid.
    id: 'mdl_floor_screen', name: 'Floor projection', kind: 'plane', path: '', surfaceId: 'srf_floor',
    position: { x: 0, y: 0.002, z: ROOM_D / 2 }, rotation: { x: -90, y: 0, z: 0 },
    scale: 1, scaleXYZ: [ROOM_W / (16 / 9), ROOM_D, 1], visible: true,
  },
];

// ── The four states ─────────────────────────────────────────────────────────────────────────────────
const STATES = [
  { key: 'attract', name: 'Attract', accent: '#22d3ee', clip: 'attract.mp4', title: 'ARTLUX', line: 'Walk in to begin', x: 80, y: 190 },
  { key: 'welcome', name: 'Welcome', accent: '#f59e0b', clip: 'welcome.mp4', title: 'WELCOME', line: 'Step onto a pad: left or right', x: 380, y: 190 },
  { key: 'story_a', name: 'Story A', accent: '#10b981', clip: 'story-a.mp4', title: 'STORY A', line: 'The left path', x: 700, y: 90 },
  { key: 'story_b', name: 'Story B', accent: '#d946ef', clip: 'story-b.mp4', title: 'STORY B', line: 'The right path', x: 700, y: 300 },
];

const WALL = { id: 'srf_wall', name: 'Wall', x: 0, y: 0, width: 1, height: 0.5625, rotation: 0, zIndex: 1, aspect: '16:9', portrait: false };
const FLOOR = { id: 'srf_floor', name: 'Floor', x: 0.2, y: 0.6, width: 0.6, height: 0.36, rotation: 0, zIndex: 0 };
const FLOOR_CONTENT = {
  type: 'TRACKING', trackingSource: 'SOL', blobSize: 0.06, showIds: true, trail: true, trailSeconds: 0.8,
  flipH: false, flipV: false, rotate: 0, calibration: false, opacity: 1,
};

// One LED strip along the bottom of the wall, so the LED path (and the DMX monitor) has something to
// show. Output goes to the loopback controller: opening the template transmits nothing to real fixtures.
const FIXTURES = [{
  id: 'fix_wall_strip', name: 'Wall strip', x: 0.05, y: 0.5, width: 0.9, height: 0.03, universe: 0,
  startAddress: 1, ledCount: 120, reverse: false, rotation: 0, colorData: [], surfaceId: 'srf_wall',
}];

// Every scene carries the models too: a scene's scene3D is a snapshot, and one with `models: []` would
// make the screens vanish the moment that state is recalled.
const SCENE3D_BASE = {
  models: MODELS, lightIntensity: 1, environment: true, gridVisible: true, reflectiveFloor: false,
  trackingViz: true, augmentaViz: false, trackingSmoothing: 0.6, trackingPredictMs: 50, trackingLabels: true,
  trackingMergePeople: true, trackingMergeRadius: 0.8, trackingZoneEnterSec: 0.25, trackingZoneExitSec: 0.8,
  activeZoneIds: ZONES.map((z) => z.id),
};

const layerIds = (s) => ({ text: `lay_${s.key}_text`, video: `lay_${s.key}_video`, floor: `lay_${s.key}_floor` });

// ── The floor: pads painted where the zones are ─────────────────────────────────────────────────────
// A zone is what the SHOW reacts to; a pad is what a VISITOR sees. Nothing ties the two together in
// ArtLux, so the pads are generated from ZONES here and cannot drift (the same doctrine as
// examples/lidar-tracking/sync-pads.cjs, which also documents the coordinate chain: in the floor's
// background layer, shader uv IS tracker space — uv.x = u, uv.y = v, no flip).
//
// The floor also TELLS the visitor what to do, per state: Attract lights the Entrance ("come in"),
// Welcome lights the two pads ("choose"), a story lights the Entrance again (the way out).
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => (c / 255).toFixed(4)); };
const f4 = (n) => n.toFixed(4);
const PADS_SHADER = `/*{
  "TITLE": "Floor pads",
  "CATEGORIES": ["ambient"],
  "INPUTS": [
${ZONES.map((z) => `    { "NAME": "show_${z.id}", "LABEL": "${z.name}", "TYPE": "bool", "DEFAULT": true },`).join('\n')}
    { "NAME": "border",   "LABEL": "Border",     "TYPE": "float", "MIN": 0.002, "MAX": 0.08, "DEFAULT": 0.016 },
    { "NAME": "pulse",    "LABEL": "Pulse rate", "TYPE": "float", "MIN": 0.0,   "MAX": 3.0,  "DEFAULT": 0.8 },
    { "NAME": "interior", "LABEL": "Interior",   "TYPE": "float", "MIN": 0.0,   "MAX": 0.6,  "DEFAULT": 0.12 }
  ]
}*/
// THE PADS A VISITOR STANDS ON — the floor surface's background, with the live visitor markers drawn
// over it by the TRACKING content. GENERATED by make-project.cjs from the trigger zones: do not
// hand-edit, move a zone there and re-run it.
float padCover(vec2 uv, vec4 r, float breath) {
  if (uv.x < r.x || uv.x > r.z || uv.y < r.y || uv.y > r.w) return 0.0;
  float dx = min(uv.x - r.x, r.z - uv.x) * iAspect;
  float dy = min(uv.y - r.y, r.w - uv.y);
  float ring = 1.0 - smoothstep(border * 0.45, border, min(dx, dy));
  return max(ring * breath, interior);
}

vec4 shaderColor(vec2 uv) {
  float breath = 0.65 + 0.35 * sin(iTime * pulse * 6.2831853);
  vec3 col = vec3(0.0);
  float a = 0.0;
${ZONES.map((z) => `  if (show_${z.id}) { float t = padCover(uv, vec4(${[z.u0, z.v0, z.u1, z.v1].map(f4).join(', ')}), breath); col += vec3(${hexRgb(z.color).join(', ')}) * t; a = max(a, t); }`).join('\n')}
  return vec4(col, a);   // premultiplied — the shader context is premultipliedAlpha:true
}`;
const PADS_LIT = {
  attract: ['zn_entrance'],
  welcome: ['zn_left', 'zn_right'],
  story_a: ['zn_entrance'],
  story_b: ['zn_entrance'],
};

function timelineOf(s) {
  const L = layerIds(s);
  return {
    // ORDER IS DEPTH: the first track is front-most, so the text sits over the video.
    layers: [
      { id: L.text, name: 'Text', kind: 'video', enabled: true, opacity: 1, blendMode: 'normal' },
      { id: L.video, name: 'Video', kind: 'video', enabled: true, opacity: 1, blendMode: 'normal' },
      // Not on the wall: the Floor surface's TRACKING content draws this track behind the markers.
      { id: L.floor, name: 'Floor pads', kind: 'video', enabled: true, opacity: 1, blendMode: 'normal' },
    ],
    clips: [
      {
        id: `clip_${s.key}_video`, layerId: L.video, name: s.clip.replace('.mp4', ''), path: `assets/video/${s.clip}`,
        start: 0, duration: CLIP_SEC, inPoint: 0, sourceDuration: CLIP_SEC,
      },
      {
        // The words cannot be keyframed (docs/TEXT.md) — which is exactly why each state carries its own
        // text clip on its own timeline. The fades are the clip's corner handles.
        id: `clip_${s.key}_text`, layerId: L.text, name: `${s.name} title`, path: '',
        start: 0.5, duration: CLIP_SEC - 1, inPoint: 0, fadeIn: 1, fadeOut: 1,
        content: {
          type: 'TEXT', textBody: `${s.title}\n${s.line}`, textWeight: 700, textSize: 0.12, textLineHeight: 1.25,
          textAlign: 'center', textVAlign: 'middle', textColor: '#ffffff', textStrokeColor: '#000000',
          textStrokeWidth: 0.03, opacity: 1,
        },
      },
      {
        id: `clip_${s.key}_floor`, layerId: L.floor, name: 'Floor pads', path: '',
        start: 0, duration: CLIP_SEC, inPoint: 0,
        content: {
          type: 'SHADER', shaderId: 'plasma', shaderSource: PADS_SHADER, shaderRes: 1080, opacity: 1,
          shaderParams: Object.fromEntries(ZONES.map((z) => [`show_${z.id}`, PADS_LIT[s.key].includes(z.id)])),
        },
      },
    ],
    duration: CLIP_SEC, fps: 30, markers: [], inPoint: null, outPoint: null, loop: true, holdAtEnd: false,
    trackingTakes: [], automation: [], audio: { tracks: [], clips: [] }, boundedDuration: true,
    lightingTakes: [], lightingSequences: [], colorLanes: [],
  };
}

function surfacesOf(s) {
  const L = layerIds(s);
  return [
    { ...WALL, content: { type: 'LAYER', layerId: L.text, layerIds: [L.text, L.video], opacity: 1 } },
    { ...FLOOR, content: { ...FLOOR_CONTENT, bgLayerId: L.floor } },
  ];
}

const scenes = STATES.map((s) => ({
  id: `sc_${s.key}`, name: s.name, accent: s.accent, fadeSec: 0, globalBrightness: 1,
  surfaces: surfacesOf(s), fixtures: FIXTURES.map((f) => ({ ...f })),
  scene3D: { ...SCENE3D_BASE }, timeline: timelineOf(s),
}));

const zone = (zoneId, edge, extra = {}) => ({ kind: 'plugin', source: 'lidar.zone', params: { zoneId, edge, ...extra } });
// A GLOBAL rule has no source state: `from: ''`, exactly what the graph editor writes (StateGraphEditor) —
// with a `from` it would also be drawn as an edge, on top of that edge's own label.
const T = (id, from, to, trigger, extra = {}) => ({ id, from: from ? `st_${from}` : '', to: `st_${to}`, trigger, fadeSec: 1, waitForContent: true, ...extra });

const transitions = [
  T('tr_enter', 'attract', 'welcome', zone('zn_entrance', 'enter')),
  // THE BRANCH: two rules out of one state. A dwell, not an edge, so a visitor crossing a pad on their
  // way to the other one does not fire it.
  T('tr_left', 'welcome', 'story_a', zone('zn_left', 'occupiedFor', { seconds: 1.5 })),
  T('tr_right', 'welcome', 'story_b', zone('zn_right', 'occupiedFor', { seconds: 1.5 })),
  // THE WAY BACK: one GLOBAL rule (fromAny) with a COMBINATION trigger — all three zones empty for 6 s.
  // A global whose target is the current state is skipped, so it never restarts Attract.
  T('tr_room_empty', '', 'attract', {
    kind: 'plugin', source: 'lidar.zone', params: {
      match: 'all',
      terms: ZONES.map((z) => ({ zone: z.id, edge: 'emptyFor', seconds: 6 })),
    },
  }, { fromAny: true, fadeSec: 2 }),
];

const states = STATES.map((s) => ({
  id: `st_${s.key}`, name: s.name, sceneId: `sc_${s.key}`, x: s.x, y: s.y,
  entry: s.key === 'attract' ? [{ kind: 'play' }] : [],
  regionId: s.key === 'attract' ? 'rg_waiting' : 'rg_visitor',
}));

const first = scenes[0];
const project = {
  version: '1.2',
  timestamp: new Date(0).toISOString(), // fixed, so re-running the generator produces no diff
  surfaces: first.surfaces,
  fixtures: first.fixtures,
  controllers: [{ id: 'ctl_local', name: 'Loopback', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, startUniverse: 0 }],
  fixtureProfiles: [], reserveLockedRanges: false, globalBrightness: 1, groups: [], lightingPoses: [], colorPalette: [],
  scenes,
  cueBanks: [{ id: 'bank1', name: 'Bank 1', rows: 8, cols: 16, cues: [], sceneCells: scenes.map((sc, col) => ({ col, sceneId: sc.id })) }],
  scene3D: { ...SCENE3D_BASE, trackingZones: ZONES },
  timeline: first.timeline,
  stateMachine: {
    enabled: true,
    initialStateId: 'st_attract',
    regions: [
      { id: 'rg_waiting', name: 'Waiting', x: 40, y: 120, w: 240, h: 200, color: '#155e75' },
      { id: 'rg_visitor', name: 'A visitor is in the room', x: 340, y: 40, w: 560, h: 380, color: '#4c1d95' },
    ],
    states, transitions,
    idleResetSec: 0,
  },
  schedule: [],
  audio: { tracks: [], clips: [], buses: [] },
  assets: STATES.map((s) => ({ id: `asset_${s.key}`, name: s.clip.replace('.mp4', ''), type: 'video', path: `assets/video/${s.clip}` })),
  bakes: [],
  projectorOutputs: [WALL, FLOOR].map((s) => ({
    surfaceId: s.id, name: s.name, enabled: false, displayId: null,
    cornerPin: { tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1] }, warp: null,
    softEdge: { left: 0, right: 0, top: 0, bottom: 0, gamma: 2.2 }, gamma: 1,
  })),
  outputSpans: [], projectorFpsCap: 0, projectorBrightness: 1,
};

writeFileSync(OUT, JSON.stringify(project, null, 2) + '\n');
console.log(`wrote ${OUT}: ${states.length} states, ${transitions.length} transitions, ${ZONES.length} zones`);
