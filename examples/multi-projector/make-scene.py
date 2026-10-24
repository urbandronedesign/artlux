# Builds the multi-projector venue: ONE wide curved screen and TWO projectors that share it.
#
#   "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup \
#       --python examples/multi-projector/make-scene.py
#
# Writes assets/models/panorama-venue.blend — the file the template loads, and the one to open in
# Blender — plus assets/models/panorama-venue.glb, its export, so the template also opens on a machine
# without Blender. Re-run after editing; both files are regenerated.
#
# THE SCREEN is a slice of a vertical cylinder, concave toward the audience: 6 m of ARC wide and 1.8 m
# tall (10:3 measured along its surface), radius 4 m — about 86 degrees of curve. Its middle is 3 m
# behind the origin and 2 m up. Its UVs follow the curve, so a 10:3 picture wraps around it.
#
# THE PROJECTORS stand 9 m in front, side by side, each aimed at a point a quarter of the way in from
# its end of the screen. Each throws a picture ~4.2 m wide (throw ratio 2.1), so each covers a little
# more than half the screen and the two OVERLAP by about 1.5 m in the middle — the region the rig
# blend cross-fades. The names are the contract with ArtLux:
#   screen_main                         — gets its own content picker
#   projector_left / projector_right    — where each Manual calibration starts

import math
import os
import bmesh
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, 'assets', 'models')
BLEND = os.path.join(MODELS, 'panorama-venue.blend')
GLB = os.path.join(MODELS, 'panorama-venue.glb')

ARC, HEIGHT, RADIUS = 6.0, 1.8, 4.0
CENTRE_Y, CENTRE_Z = 3.0, 2.0
SEGMENTS = 24                              # a column every 25 cm along the arc
THROW_RATIO = 2.1
PROJECTOR_X, PROJECTOR_Y, PROJECTOR_Z = 1.35, -6.0, 2.5

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.render.resolution_x, scene.render.resolution_y = 1920, 1080

theta = ARC / RADIUS
axis_y = CENTRE_Y - RADIUS


def on_arc(x):
    """The point of the screen's centre line at horizontal position x (Blender coordinates)."""
    a = math.asin(x / RADIUS)
    return (x, axis_y + RADIUS * math.cos(a), CENTRE_Z)


# ── The curved screen, vertex by vertex so its UVs are exactly arc-length ──────────────────────────
mesh = bpy.data.meshes.new('screen_main_mesh')
bm = bmesh.new()
uv = bm.loops.layers.uv.new('UVMap')
cols = []
for i in range(SEGMENTS + 1):
    a = -theta / 2 + theta * i / SEGMENTS
    x, y = RADIUS * math.sin(a), axis_y + RADIUS * math.cos(a)
    cols.append((bm.verts.new((x, y, CENTRE_Z - HEIGHT / 2)), bm.verts.new((x, y, CENTRE_Z + HEIGHT / 2)), i / SEGMENTS))
for (b0, t0, u0), (b1, t1, u1) in zip(cols, cols[1:]):
    f = bm.faces.new((b0, t0, t1, b1))
    for loop, (u, v) in zip(f.loops, ((u0, 0.0), (u0, 1.0), (u1, 1.0), (u1, 0.0))):
        loop[uv].uv = (u, v)
bm.normal_update()
bm.faces.ensure_lookup_table()
if bm.faces[len(bm.faces) // 2].normal.y > 0:   # face the audience (-Y), whatever the winding
    bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
bm.to_mesh(mesh)
bm.free()
screen = bpy.data.objects.new('screen_main', mesh)
scene.collection.objects.link(screen)
mat = bpy.data.materials.new('screen_mat')
mat.use_nodes = True
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.8, 0.8, 0.8, 1.0)
mesh.materials.append(mat)


# ── The two projectors ────────────────────────────────────────────────────────────────────────────
def add_projector(name, x):
    bpy.ops.object.camera_add(location=(x, PROJECTOR_Y, PROJECTOR_Z))
    cam = bpy.context.active_object
    cam.name = name
    cam.data.name = f'{name}_lens'
    cam.data.sensor_fit = 'HORIZONTAL'
    cam.data.sensor_width = 36
    cam.data.lens = THROW_RATIO * 36       # focal ÷ sensor width = throw ratio
    cam.data.clip_start, cam.data.clip_end = 0.1, 100
    target = bpy.data.objects.new(f'{name}_aim', None)
    target.location = on_arc(x)            # aimed at the screen straight ahead of it
    scene.collection.objects.link(target)
    track = cam.constraints.new('TRACK_TO')
    track.target, track.track_axis, track.up_axis = target, 'TRACK_NEGATIVE_Z', 'UP_Y'
    bpy.context.view_layer.update()
    cam.matrix_world = cam.matrix_world.copy()
    cam.constraints.remove(track)
    bpy.data.objects.remove(target)
    return cam


scene.camera = add_projector('projector_left', -PROJECTOR_X)
add_projector('projector_right', PROJECTOR_X)

os.makedirs(MODELS, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=BLEND)
bpy.ops.export_scene.gltf(filepath=GLB, export_format='GLB', export_yup=True,
                          export_texcoords=True, export_apply=True, export_cameras=True)
print('multi-projector: wrote assets/models/panorama-venue.blend + .glb')
