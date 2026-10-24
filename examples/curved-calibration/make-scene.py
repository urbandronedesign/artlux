# Builds the curved-calibration venue: ONE curved screen and ONE projector, nothing else.
#
#   "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup \
#       --python examples/curved-calibration/make-scene.py
#
# Writes assets/models/curved-venue.blend — the file the template loads, and the one to open in
# Blender — plus assets/models/curved-venue.glb, its export, so the template also opens on a machine
# without Blender. Re-run after editing; both files are regenerated.
#
# THE SCREEN is a slice of a vertical cylinder, concave toward the audience: 3.2 m of ARC wide and
# 1.8 m tall (16:9 measured along its surface), radius 3 m, its middle 3 m behind the origin and 2 m
# up. Its UVs follow the curve — u runs along the arc, v up the height — so a 16:9 picture wraps around
# it without stretching. The names are the contract with ArtLux:
#   screen_main     — an object whose name starts with "screen": it gets its own content picker.
#   projector_main  — a camera whose name starts with "projector": the Manual calibration starts there.

import math
import os
import bmesh
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, 'assets', 'models')
BLEND = os.path.join(MODELS, 'curved-venue.blend')
GLB = os.path.join(MODELS, 'curved-venue.glb')

ARC, HEIGHT, RADIUS = 3.2, 1.8, 3.0        # metres; ARC / HEIGHT = 16 / 9
CENTRE_Y, CENTRE_Z = 3.0, 2.0              # the middle of the screen (Blender: +Y away from the audience)
SEGMENTS = 24                              # columns along the arc — smooth enough to read as a curve
PROJECTOR_POS = (0.0, -6.0, 2.5)
THROW_RATIO = 2.0                          # at ~9 m the image is ~4.5 m wide: the screen fits with margin

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.render.resolution_x, scene.render.resolution_y = 1920, 1080

# ── The curved screen, built vertex by vertex so its UVs are exactly arc-length ─────────────────────
# The cylinder's axis is vertical, RADIUS in front of the screen's middle; angle 0 is the middle, the
# ends are ±half the arc's angle. Seen from the audience (looking along +Y), -X is LEFT, so u = 0 there.
theta = ARC / RADIUS
axis_y = CENTRE_Y - RADIUS
mesh = bpy.data.meshes.new('screen_main_mesh')
bm = bmesh.new()
uv = bm.loops.layers.uv.new('UVMap')
cols = []
for i in range(SEGMENTS + 1):
    a = -theta / 2 + theta * i / SEGMENTS
    x, y = RADIUS * math.sin(a), axis_y + RADIUS * math.cos(a)
    cols.append((bm.verts.new((x, y, CENTRE_Z - HEIGHT / 2)), bm.verts.new((x, y, CENTRE_Z + HEIGHT / 2)), i / SEGMENTS))
for (b0, t0, u0), (b1, t1, u1) in zip(cols, cols[1:]):
    # Wound so the face normal points TOWARD the audience (-Y): the side the projector lights.
    f = bm.faces.new((b0, t0, t1, b1))
    for loop, (u, v) in zip(f.loops, ((u0, 0.0), (u0, 1.0), (u1, 1.0), (u1, 0.0))):
        loop[uv].uv = (u, v)
bm.normal_update()
bm.faces.ensure_lookup_table()
if bm.faces[len(bm.faces) // 2].normal.y > 0:   # belt and braces: whatever the winding, face the audience
    bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
bm.to_mesh(mesh)
bm.free()
screen = bpy.data.objects.new('screen_main', mesh)
scene.collection.objects.link(screen)
mat = bpy.data.materials.new('screen_mat')
mat.use_nodes = True
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.8, 0.8, 0.8, 1.0)
mesh.materials.append(mat)

# ── The projector ─────────────────────────────────────────────────────────────────────────────────
# Aimed at the middle of the screen with a track-to constraint, then baked into a plain rotation.
bpy.ops.object.camera_add(location=PROJECTOR_POS)
cam = bpy.context.active_object
cam.name = 'projector_main'
cam.data.name = 'projector_main_lens'
cam.data.sensor_fit = 'HORIZONTAL'
cam.data.sensor_width = 36
cam.data.lens = THROW_RATIO * 36          # focal ÷ sensor width = throw ratio
cam.data.clip_start, cam.data.clip_end = 0.1, 100
target = bpy.data.objects.new('aim', None)
target.location = (0.0, CENTRE_Y, CENTRE_Z)
scene.collection.objects.link(target)
track = cam.constraints.new('TRACK_TO')
track.target, track.track_axis, track.up_axis = target, 'TRACK_NEGATIVE_Z', 'UP_Y'
bpy.context.view_layer.update()
cam.matrix_world = cam.matrix_world.copy()
cam.constraints.remove(track)
bpy.data.objects.remove(target)
scene.camera = cam

os.makedirs(MODELS, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=BLEND)
bpy.ops.export_scene.gltf(filepath=GLB, export_format='GLB', export_yup=True,
                          export_texcoords=True, export_apply=True, export_cameras=True)
print('curved-calibration: wrote assets/models/curved-venue.blend + .glb')
