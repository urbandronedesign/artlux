# Builds the blender-screens test venue: a room with ONE 16:9 screen named `screen_main` and one
# projector, a camera named `projector_main` aimed at it.
#
#   "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup \
#       --python examples/blender-screens/make-venue.py
#
# Writes venue.blend (open it in Blender to see how the screen is named and UV-mapped) and venue.glb
# (what ArtLux loads) next to this script. Re-run after editing; both files are regenerated.
#
# What it tests: ArtLux treats any object whose name starts with `screen` (any case) as a screen of its
# own, with its own content. The floor and the wall are ordinary geometry, so you can see the two
# rules at once — bind the WHOLE model to one thing and `screen_main` to another.

import os
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))

# 16:9, in metres. ArtLux reads glTF units as metres, so this lands at its real size.
SCREEN_W, SCREEN_H = 3.2, 1.8

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'


def material(name, rgb):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1.0)
    m.use_nodes = True
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*rgb, 1.0)
    return m


# The floor: 8 x 6 m, ordinary venue geometry.
bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0))
floor = bpy.context.active_object
floor.name = 'floor'
floor.scale = (8, 6, 1)
floor.data.materials.append(material('floor_mat', (0.18, 0.18, 0.2)))

# The back wall: 8 m wide, 4 m high, 0.2 m thick, at the back of the room (Blender +Y = away from the
# front view; glTF/ArtLux -Z).
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 3, 2))
wall = bpy.context.active_object
wall.name = 'back_wall'
wall.scale = (8, 0.2, 4)
wall.data.materials.append(material('wall_mat', (0.35, 0.35, 0.38)))

# THE SCREEN. A plane's default UVs already cover 0..1 across the face, which is exactly what ArtLux
# maps the picture through. Rotated +90° about X it stands up facing the front view (-Y), with its
# local +Y — UV v = 1 — at the TOP, so the content arrives upright. 1 cm in front of the wall so the
# two never z-fight.
bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 3 - 0.1 - 0.01, 2))
screen = bpy.context.active_object
screen.name = 'screen_main'          # ← the whole feature: the OBJECT name starts with "screen"
screen.data.name = 'screen_main_mesh'
screen.rotation_euler = (1.5707963267948966, 0, 0)
screen.scale = (SCREEN_W, SCREEN_H, 1)
screen.data.materials.append(material('screen_mat', (0.05, 0.05, 0.05)))

# Bake the scale/rotation into the vertices, so the exported nodes carry no odd transforms and the
# UVs stay 0..1 over the real 3.2 x 1.8 m face.
for ob in (floor, wall, screen):
    ob.select_set(True)
bpy.context.view_layer.objects.active = screen
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

# THE PROJECTOR — a camera named `projector_main`, 6 m back from the screen at its height, aimed
# straight at it. Its lens is set the way a projector spec sheet reads: a THROW RATIO of 1.0 (throw
# distance ÷ image width) on a 1920×1080 raster, which in Blender terms is a 36 mm lens on a 36 mm
# sensor fitted HORIZONTALLY. A camera at rest looks down its local -Z; +90° about X turns it to +Y.
THROW_RATIO = 1.0
scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
bpy.ops.object.camera_add(location=(0, -6, 2), rotation=(1.5707963267948966, 0, 0))
cam = bpy.context.active_object
cam.name = 'projector_main'          # ← the keyword: the OBJECT name starts with "projector"
cam.data.name = 'projector_main_lens'
cam.data.sensor_fit = 'HORIZONTAL'
cam.data.sensor_width = 36
cam.data.lens = THROW_RATIO * 36
scene.camera = cam

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'venue.blend'))
bpy.ops.export_scene.gltf(
    filepath=os.path.join(HERE, 'venue.glb'),
    export_format='GLB',
    export_yup=True,
    export_texcoords=True,
    export_apply=True,
    export_cameras=True,           # the projector travels in the .glb as a glTF camera
)
print('blender-screens: wrote venue.blend + venue.glb')
