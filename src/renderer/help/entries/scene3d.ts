import type { HelpEntry } from '../types';

// 3D scene / simulator controls (group: "3D Scene"). Filled during migration.
export const scene3dHelp: HelpEntry[] = [
  // ── Transform gizmo (viewport toolbar) ──────────────────────────────────────────────────────
  {
    id: 'scene3d.gizmo-translate',
    title: 'Move',
    short: 'Switch the transform gizmo to move (translate) mode.',
    body: 'Drag the on-object handles to reposition the selected fixture or model along an axis. Use it to place things in the venue rather than reorient or resize them.',
    group: '3D Scene',
    keywords: ['translate', 'position', 'gizmo', 'transform', 'move'],
    shortcut: 'W',
  },
  {
    id: 'scene3d.gizmo-rotate',
    title: 'Rotate',
    short: 'Switch the transform gizmo to rotate mode.',
    body: 'Drag the rings to reorient the selected fixture or model around an axis. Use it to aim a fixture or angle a screen.',
    group: '3D Scene',
    keywords: ['rotate', 'orientation', 'gizmo', 'transform'],
    shortcut: 'E',
  },
  {
    id: 'scene3d.gizmo-scale',
    title: 'Scale',
    short: 'Switch the transform gizmo to scale mode.',
    body: 'Drag the handles to resize the selected object. Use it to size a screen plane or an imported mesh in the scene.',
    group: '3D Scene',
    keywords: ['scale', 'resize', 'gizmo', 'transform'],
    shortcut: 'R',
  },

  // ── Objects browser + header actions ────────────────────────────────────────────────────────
  {
    id: 'scene3d.model-visibility',
    title: 'Show / hide object',
    short: 'Toggle whether this object is drawn in the 3D scene.',
    body: 'Hides the model from the venue view without removing it or its transform. Handy for decluttering while you position other objects.',
    group: '3D Scene',
    keywords: ['visibility', 'hide', 'show', 'eye'],
  },
  {
    id: 'scene3d.add-plane',
    title: 'Add screen plane',
    short: 'Add a flat screen plane to the 3D scene.',
    body: 'Drops a rectangular surface you can position and bind to a timeline layer or Program. Use it for a wall, floor or projection screen.',
    group: '3D Scene',
    keywords: ['screen', 'plane', 'add', 'surface'],
  },
  {
    id: 'scene3d.add-model',
    title: 'Add GLB mesh',
    short: 'Import a GLB/GLTF mesh into the 3D scene.',
    body: 'Loads a 3D model of the real venue or a prop so fixtures and projections can be placed against it. Scale it to real-world size after import.',
    group: '3D Scene',
    keywords: ['glb', 'gltf', 'mesh', 'import', 'model'],
  },
  {
    id: 'scene3d.save-scene',
    title: 'Save project',
    short: 'Save the project, including the 3D scene.',
    body: 'Persists the current scene layout, transforms and lighting along with the rest of the project. Shows a brief Saved confirmation.',
    group: '3D Scene',
    keywords: ['save', 'persist', 'project'],
  },

  // ── Selected-model transform ────────────────────────────────────────────────────────────────
  {
    id: 'scene3d.model-layer',
    title: 'Screen content (layer)',
    short: 'Choose which timeline layer or content this object displays.',
    body: "Planes show the chosen layer directly; meshes get it UV-mapped onto their GLB. Reads the bound timeline, so a model shows what the engine is currently playing.",
    group: '3D Scene',
    keywords: ['layer', 'content', 'texture', 'timeline', 'program'],
  },
  {
    id: 'scene3d.model-program',
    title: 'Show Program',
    short: 'Display the whole timeline (Program composite) on this object.',
    body: "Binds the object to the Program layer so it shows every contributing timeline layer, z-ordered. Toggle off to return to a single layer or the GLB's own materials.",
    group: '3D Scene',
    keywords: ['program', 'composite', 'timeline', 'tl'],
  },
  {
    id: 'scene3d.model-uvs',
    title: 'UV source',
    short: 'Texture the mesh with its own UVs, or UVs projected from a viewpoint.',
    body: 'Mesh UVs uses the TEXCOORD map authored in the GLB — if the file has none (common for CAD '
      + 'exports), the layer collapses to a single flat color. Projected from view bakes UVs by '
      + 'projecting the mesh through a captured 3D viewpoint, like a virtual projector: from that '
      + 'viewpoint the layer reads as a fullscreen image. Switching back to Mesh UVs keeps the baked '
      + 'viewpoint, so the two can be compared freely.',
    group: '3D Scene',
    keywords: ['uv', 'texture', 'projection', 'projected', 'mapping', 'texcoord'],
  },
  {
    id: 'scene3d.model-uv-bake',
    title: 'Project UVs from view',
    short: 'Bake projected UVs from the current 3D camera position.',
    body: 'Captures the current viewpoint and re-projects the layer texture onto the mesh from it. '
      + 'Frame the mesh the way the content should land, then bake. The texture stays glued to the '
      + 'mesh if it is moved afterwards — bake again to re-project. Faces the viewpoint cannot see '
      + 'get stretched, exactly as with a real projector.',
    group: '3D Scene',
    keywords: ['uv', 'bake', 'project', 'view', 'camera', 'reproject'],
  },
  {
    id: 'scene3d.model-fit',
    title: 'Fit to size',
    short: 'Scale the mesh so its longest dimension matches the given size.',
    body: "Uses the model's natural bounds to compute a uniform scale, so an imported GLB lands at real-world meters. Set the target length first, then apply.",
    group: '3D Scene',
    keywords: ['fit', 'scale', 'size', 'meters', 'glb'],
  },

  // ── Lighting ────────────────────────────────────────────────────────────────────────────────
  {
    id: 'scene3d.light-gain',
    title: 'Light gain',
    short: 'Overall intensity of the scene lighting.',
    body: 'Scales the lights that illuminate meshes and the venue model. Raise it if imported geometry looks too dark.',
    group: '3D Scene',
    keywords: ['light', 'intensity', 'brightness', 'gain'],
  },
  {
    id: 'scene3d.haze',
    title: 'Haze',
    short: 'How much atmosphere the room has — how visible the beams are.',
    body: 'A beam is only visible because of what is suspended in the air. This scales the volumetric '
      + 'cones drawn for every lit DMX fixture: at 0 you see pools of light on surfaces and no beams at '
      + 'all, which is exactly what a venue without a hazer looks like; turn it up to preview the same '
      + 'rig once the hazers are running. It changes the PREVIEW only — no DMX, no output, nothing the '
      + 'audience sees.',
    group: '3D Scene',
    keywords: ['haze', 'fog', 'atmosphere', 'beam', 'volumetric', 'smoke'],
  },
  {
    id: 'scene3d.exposure',
    title: 'Exposure',
    short: 'Tone-mapping exposure of the 3D view.',
    body: 'Brightens or darkens the whole rendered image without changing light placement. Use it to balance a bright bloom or a dim scene.',
    group: '3D Scene',
    keywords: ['exposure', 'tone mapping', 'brightness'],
  },
  {
    id: 'scene3d.ambient-env',
    title: 'Ambient (env)',
    short: 'Toggle image-based ambient environment lighting.',
    body: 'Adds soft, even fill light from an environment map so meshes are lit from all sides. Turn off for a darker, more contrasty look.',
    group: '3D Scene',
    keywords: ['ambient', 'environment', 'ibl', 'lighting'],
  },
  {
    id: 'scene3d.reflective-floor',
    title: 'Reflective floor',
    short: 'Toggle a mirror-like reflective ground plane.',
    body: 'Renders reflections of the scene on the floor for a showroom look. Costs extra GPU, so disable it on weaker hardware.',
    group: '3D Scene',
    keywords: ['floor', 'reflection', 'mirror', 'ground'],
  },
  {
    id: 'scene3d.grid',
    title: 'Grid',
    short: 'Toggle the ground reference grid.',
    body: 'Shows a metric floor grid to gauge scale and placement in the venue. Hide it for a clean preview or screenshot.',
    group: '3D Scene',
    keywords: ['grid', 'floor', 'reference'],
  },

  // ── Tracking scene-viz overlays + tuning ────────────────────────────────────────────────────
  {
    id: 'scene3d.tracking-viz',
    title: 'Tracking zones (LiDAR)',
    short: 'Show LiDAR tracking blobs and trigger zones in the 3D scene.',
    body: 'Overlays live tracked people and the configured trigger zones so you can see what the show is reacting to. Reveals per-source smoothing and dwell tuning below.',
    group: '3D Scene',
    keywords: ['lidar', 'tracking', 'zones', 'blobs', 'viz'],
  },
  {
    id: 'scene3d.tracking-smoothing',
    title: 'Tracking smoothing',
    short: 'How much incoming tracking positions are smoothed (0-1).',
    body: 'Higher values steady jittery blobs at the cost of responsiveness. Lower it if tracked people feel laggy.',
    group: '3D Scene',
    keywords: ['smoothing', 'filter', 'jitter', 'tracking'],
  },
  {
    id: 'scene3d.tracking-predict',
    title: 'Tracking predict (ms)',
    short: 'How far ahead tracked positions are extrapolated.',
    body: 'Compensates for tracking latency by projecting motion forward in milliseconds. Raise it if visuals trail moving visitors.',
    group: '3D Scene',
    keywords: ['predict', 'latency', 'extrapolate', 'tracking'],
  },
  {
    id: 'scene3d.tracking-labels',
    title: 'Show IDs',
    short: 'Draw the numeric id next to each tracked blob.',
    body: 'Labels each tracked person with their stable id, useful while debugging tracking or tuning zones. Turn off for a clean stage view.',
    group: '3D Scene',
    keywords: ['ids', 'labels', 'tracking', 'debug'],
  },
  {
    id: 'scene3d.zone-enter-dwell',
    title: 'Zone enter dwell (s)',
    short: 'Venue-wide default time a visitor must dwell before a zone triggers.',
    body: 'Raise it when a zone flickers or fires on people passing through; lower it when arrivals feel laggy. A zone can override it in the Trigger Zones panel.',
    group: '3D Scene',
    keywords: ['dwell', 'enter', 'zone', 'trigger', 'debounce'],
  },
  {
    id: 'scene3d.zone-exit-dwell',
    title: 'Zone exit dwell (s)',
    short: 'Venue-wide default time before an emptied zone is considered exited.',
    body: 'Raise it if a standing visitor briefly drops out and re-triggers the zone; lower it for a snappier release. Overridable per zone.',
    group: '3D Scene',
    keywords: ['dwell', 'exit', 'zone', 'trigger', 'release'],
  },
  {
    id: 'scene3d.mediapipe-viz',
    title: 'Camera pose markers (MediaPipe)',
    short: 'Show MediaPipe BlazePose skeleton markers in the 3D scene.',
    body: 'Overlays camera-based body pose landmarks so you can verify webcam pose tracking. Independent of the LiDAR tracking source.',
    group: '3D Scene',
    keywords: ['mediapipe', 'blazepose', 'camera', 'pose', 'markers'],
  },
  {
    id: 'scene3d.augmenta-viz',
    title: 'Augmenta field + objects',
    short: 'Show the Augmenta tracking field and detected objects.',
    body: "Draws the Augmenta box's coverage area and its tracked objects in the venue view. Use it to confirm the OSC tracking source is aligned.",
    group: '3D Scene',
    keywords: ['augmenta', 'osc', 'field', 'objects', 'tracking'],
  },
  {
    id: 'scene3d.merge-people',
    title: 'Merge people',
    short: 'Combine the two blobs a person emits into one tracked person.',
    body: 'The venue emits ~2 blobs per visitor; this spatially clusters them into a single stable person id. Reveals the merge radius below.',
    group: '3D Scene',
    keywords: ['merge', 'cluster', 'blobs', 'people', 'tracking'],
  },
  {
    id: 'scene3d.merge-radius',
    title: 'Merge radius (m)',
    short: 'Maximum distance between blobs that get merged into one person.',
    body: 'Blobs within this radius are treated as the same person. Tune it to the venue: too small splits a person, too large fuses neighbours.',
    group: '3D Scene',
    keywords: ['merge', 'radius', 'cluster', 'distance', 'tracking'],
  },
];
