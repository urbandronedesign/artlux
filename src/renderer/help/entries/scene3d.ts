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

  {
    id: 'scene3d.gizmo-space',
    title: 'World / Object axes',
    short: 'Align the gizmo handles to the world, or to the fixture itself.',
    body: 'World keeps the handles on the room\'s X/Y/Z, which is what you want for hanging things level. Object turns them to match the selected fixture, so a bar angled across a truss can be slid along its OWN length or aimed around its own axis. With several fixtures selected, the handles take the orientation of the last one you clicked and still pivot on the middle of the selection.',
    group: '3D Scene',
    keywords: ['world', 'object', 'local', 'space', 'axes', 'gizmo', 'align', 'orientation'],
    shortcut: 'X',
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
      + 'exports) the content collapses to a single flat color, and if the exporter flipped V it '
      + 'arrives upside down. Projecting sidesteps both, because the mapping comes from a matrix '
      + 'rather than from the file. Projected from view freezes the current 3D viewpoint. Projected '
      + 'from a projector is the live option: it follows that calibrated projector, so re-solving it '
      + 'or moving the mesh re-projects instead of leaving a stale mapping behind — content lands on '
      + 'the real object the way that projector actually sees it.',
    group: '3D Scene',
    keywords: ['uv', 'texture', 'projection', 'projected', 'mapping', 'texcoord', 'projector'],
  },
  {
    id: 'scene3d.model-uv-soft',
    title: 'Projected edge falloff',
    short: 'Fade the projected content out at the edge of the frustum.',
    body: 'Softens the boundary of the projected footprint, in normalized units (0 = a hard edge, '
      + '0.5 = fading across half the frame). With two projectors covering one object this is what '
      + 'makes their content cross-fade instead of meeting at a visible cookie edge. It affects only '
      + 'where the content lands on the geometry, not the rig blend that balances projector brightness.',
    group: '3D Scene',
    keywords: ['uv', 'projected', 'soft', 'edge', 'falloff', 'feather', 'frustum'],
  },
  {
    id: 'scene3d.model-uv-cull',
    title: 'Cull back faces',
    short: 'Do not project onto faces turned away from the projector.',
    body: 'A real projector cannot light the far side of an object, so this drops faces pointing away '
      + 'from it — without this the content wraps around and appears mirrored on the back. It answers '
      + 'only "is this face turned away?", never "is something else in the way?" — that is what '
      + 'Occlude is for. On a closed convex object this is exact and free; on a concave venue you '
      + 'want Occlude as well.',
    group: '3D Scene',
    keywords: ['uv', 'projected', 'cull', 'back face', 'backface'],
  },
  {
    id: 'scene3d.model-uv-occlude',
    title: 'Occlude',
    short: 'Do not light geometry another surface is standing in front of.',
    body: 'A real projector cannot light what it cannot see. With this on, a nearer surface shadows a '
      + 'farther one exactly as the light itself would: content stops at the silhouette of whatever '
      + 'is in front, instead of carrying on through onto the wall behind. Everything visible in the '
      + '3D scene casts, including screens and meshes with no content of their own. Turn it off to '
      + 'get the old behaviour, where the whole frustum is lit through. If a surface breaks up into '
      + 'shadow stripes, raise Bias.',
    group: '3D Scene',
    keywords: ['uv', 'projected', 'occlusion', 'occlude', 'shadow', 'hidden', 'depth', 'concave'],
  },
  {
    id: 'scene3d.model-uv-bias',
    title: 'Occlusion bias',
    short: 'How much closer than the blocker a surface may be and still be lit, in metres.',
    body: 'The margin the occlusion test allows before it calls a surface hidden, in metres. Too '
      + 'small and a surface shadows itself — you get stripes or a speckled pattern across flat '
      + 'geometry, worst where the projector rakes across it at a shallow angle. Too large and '
      + 'content creeps a little past a silhouette onto what is behind it. The default of 0.02 m '
      + 'suits venue-scale geometry; raise it a few centimetres at a time until the stripes go.',
    group: '3D Scene',
    keywords: ['uv', 'projected', 'occlusion', 'bias', 'acne', 'stripes', 'shadow', 'depth'],
  },
  {
    id: 'scene3d.model-uv-bake',
    title: 'Project UVs from view',
    short: 'Freeze a projection from the current 3D camera position.',
    body: 'Captures the current viewpoint and projects the content onto the mesh from it. Frame the '
      + 'mesh the way the content should land, then press it. This viewpoint is FROZEN — it does not '
      + 'follow the camera, and it clears any live projector source. To have the mapping track a real '
      + 'projector instead, pick that projector in the UVs list.',
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
    id: 'scene3d.glow',
    title: 'Glow (bloom)',
    short: 'Bleed light out of bright pixels — LEDs and beams glow.',
    body: 'Adds a soft halo around anything bright, which is what makes a rig of LEDs and beams read '
      + 'as light rather than as coloured dots. It is off by default because it costs a full-screen '
      + 'pass plus a blur every frame, at whatever resolution the viewport is — one of the more '
      + 'expensive things in this view, and it does nothing for a venue mesh carrying video, which is '
      + 'what projection mapping spends its time looking at. Turn it on for a rig you want to show '
      + 'off; leave it off while mapping or on weaker hardware.',
    group: '3D Scene',
    keywords: ['glow', 'bloom', 'halo', 'performance', 'fps', 'postprocessing'],
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
