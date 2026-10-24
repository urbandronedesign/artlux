# Builds the manual-calibration venue: ONE 16:9 screen and ONE projector, nothing else.
#
#   "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup \
#       --python examples/manual-calibration/make-scene.py
#
# Writes assets/models/screen-venue.blend — the file the template loads, and the one to open in
# Blender — plus assets/models/screen-venue.glb, its export, so the template also opens on a machine
# without Blender. Re-run after editing; both files are regenerated.
#
# The two names are the whole contract with ArtLux:
#   screen_main     — an object whose name starts with "screen": it gets its own content picker.
#   projector_main  — a camera whose name starts with "projector": the Manual calibration can start
#                     from where it stands, with its lens as the throw ratio.

import math
import os
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, 'assets', 'models')
BLEND = os.path.join(MODELS, 'screen-venue.blend')
GLB = os.path.join(MODELS, 'screen-venue.glb')

# The screen: 16:9, 3.2 × 1.8 m, its centre 2 m up, 3 m behind the origin (Blender +Y).
SCREEN_W, SCREEN_H = 3.2, 1.8
SCREEN_CENTRE = (0.0, 3.0, 2.0)

# The projector: 9 m in front of the screen and 0.5 m above its centre, aimed at that centre.
# THROW RATIO 2.0 (throw distance ÷ image width) on a 1920 × 1080 raster: at 9 m the image is
# 4.5 m wide, so the screen fills ~70% of it — the margin a real install leaves for alignment.
PROJECTOR_POS = (0.0, -6.0, 2.5)
THROW_RATIO = 2.0

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.render.resolution_x, scene.render.resolution_y = 1920, 1080

# ── The screen ────────────────────────────────────────────────────────────────────────────────────
# A plane's default UVs cover 0..1 across its face, which is what ArtLux maps the picture through.
# +90° about X stands it up facing the front view (-Y) with UV v = 1 at the TOP, so content is upright.
bpy.ops.mesh.primitive_plane_add(size=1, location=SCREEN_CENTRE, rotation=(math.pi / 2, 0, 0))
screen = bpy.context.active_object
screen.name = 'screen_main'
screen.data.name = 'screen_main_mesh'
screen.scale = (SCREEN_W, SCREEN_H, 1)
mat = bpy.data.materials.new('screen_mat')
mat.use_nodes = True
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.8, 0.8, 0.8, 1.0)
screen.data.materials.append(mat)
# Bake rotation + scale into the vertices: a clean node, and UVs still 0..1 over the real 3.2 × 1.8 m.
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

# ── The projector ─────────────────────────────────────────────────────────────────────────────────
# A camera at rest looks down its local -Z. Aim it with a track-to constraint at the screen centre,
# then bake the result into a plain rotation so the export carries no constraint.
bpy.ops.object.camera_add(location=PROJECTOR_POS)
cam = bpy.context.active_object
cam.name = 'projector_main'
cam.data.name = 'projector_main_lens'
cam.data.sensor_fit = 'HORIZONTAL'
cam.data.sensor_width = 36
cam.data.lens = THROW_RATIO * 36          # focal ÷ sensor width = throw ratio
cam.data.clip_start, cam.data.clip_end = 0.1, 100
target = bpy.data.objects.new('aim', None)
target.location = SCREEN_CENTRE
scene.collection.objects.link(target)
track = cam.constraints.new('TRACK_TO')
track.target, track.track_axis, track.up_axis = target, 'TRACK_NEGATIVE_Z', 'UP_Y'
bpy.context.view_layer.update()
cam.matrix_world = cam.matrix_world.copy()    # freeze the evaluated aim
cam.constraints.remove(track)
bpy.data.objects.remove(target)
scene.camera = cam

os.makedirs(os.path.dirname(GLB), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=BLEND)
bpy.ops.export_scene.gltf(
    filepath=GLB,
    export_format='GLB',
    export_yup=True,
    export_texcoords=True,
    export_apply=True,
    export_cameras=True,   # the projector travels in the .glb as a glTF camera
)
print('manual-calibration: wrote assets/models/screen-venue.blend + .glb')
