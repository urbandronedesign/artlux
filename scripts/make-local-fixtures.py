"""Writes the hand-derived profiles in resources/fixture-library-local/ (the ones with no .gdtf).

Run:  python scripts/make-local-fixtures.py   then   npm run build:fixtures -- --ref <sha in MANIFEST.json>

Every channel table below is transcribed from the manufacturer document named in `ref`. Kept as a
script, not as hand-edited JSON, so the two Movo heads (which share most tables) cannot drift apart
and a correction is one edit. Output is deterministic: no timestamps.
"""
import json, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'resources', 'fixture-library-local')


def rng(*rows):
    return [{'from': a, 'to': b, 'label': l} for a, b, l in rows]


def ch(key, label, role, default=0, res=1, **extra):
    c = {'key': key, 'label': label, 'role': role, 'resolution': res, 'default': default}
    c.update(extra)
    return c


def mode(key, name, slots):
    out = []
    for s in slots:
        if isinstance(s, tuple):
            out.append({'channelKey': s[0], 'byte': s[1]})
        else:
            out.append({'channelKey': s, 'byte': 0})
    return {'key': key, 'name': name, 'footprint': len(out), 'slots': out}


def profile(pid, manufacturer, model, aliases, categories, channels, modes, ref, origin='pdf', verified=True, physical=None):
    used = {s['channelKey'] for m in modes for s in m['slots']}
    p = {'id': pid, 'manufacturer': manufacturer, 'model': model, 'aliases': aliases, 'categories': categories,
         'channels': [c for c in channels if c['key'] in used], 'modes': modes}
    if physical:
        p['physical'] = physical
    p['source'] = {'origin': origin, 'ref': ref}
    p['verified'] = verified
    return p


def write(name, p):
    with open(os.path.join(OUT, name + '.json'), 'w', encoding='utf8', newline='\n') as f:
        f.write(json.dumps(p, indent=1) + '\n')


# ── generic-1ch … generic-5ch: N plain channels for custom hardware ──────────────────────────────
for n in range(1, 6):
    chans = [ch(f'ch{i}', f'Channel {i}', 'unknown') for i in range(1, n + 1)]
    write(f'generic-{n}ch', profile(
        f'generic/generic-{n}ch', 'Generic', f'generic-{n}ch',
        [f'generic-{n}ch', f'generic {n}ch', f'generic{n}ch', f'{n} channel', f'{n}ch'], ['Other'],
        chans, [mode(f'{n}ch', f'{n}ch', [c['key'] for c in chans])],
        'scripts/make-local-fixtures.py', origin='manual'))

# ── Briteq BT-THEATRE 60FC ───────────────────────────────────────────────────────────────────────
rgbw = [ch('red', 'Red', 'red', highlight=1), ch('green', 'Green', 'green', highlight=1),
        ch('blue', 'Blue', 'blue', highlight=1), ch('white', 'White', 'white', highlight=1)]
bt = rgbw + [
    ch('dimmer', 'Master Dimmer', 'dimmer', highlight=1),
    # One channel that is dimmer, sound mode and strobe by range. Defaults to "master dimmer @ 100%".
    ch('dimmer-strobe', 'Dimmer / Sound / Strobe', 'shutter', default=1, ranges=rng(
        (0, 190, 'Master dimmer 0-100%'), (191, 200, 'Sound control (7 colors)'),
        (201, 247, 'Strobe slow-fast'), (248, 255, 'Master dimmer 100%'))),
    ch('sound-strobe', 'Sound / Strobe', 'shutter', ranges=rng(
        (0, 4, 'On'), (5, 24, 'Sound control (7 colors)'), (25, 34, 'On'), (35, 255, 'Strobe slow-fast'))),
    ch('strobe', 'Strobe', 'shutter', ranges=rng((0, 4, 'On'), (5, 255, 'Strobe slow-fast'))),
    ch('strobe-multi', 'Strobe', 'shutter', ranges=rng(
        (0, 7, 'On'), (8, 37, 'Random strobe slow-fast'), (38, 67, 'Sound strobe'), (68, 255, 'Strobe slow-fast'))),
    ch('color-macro', 'Color Macros', 'macro', ranges=rng(
        (0, 7, 'No function'), (8, 127, 'Color change slow-fast'), (128, 247, 'Color fade slow-fast'),
        (248, 255, 'Sound control'))),
]
write('briteq-bt-theatre-60fc', profile(
    'briteq/bt-theatre-60fc', 'Briteq', 'BT-THEATRE 60FC',
    ['BT-THEATRE 60FC', 'BT THEATRE 60FC', 'bttheatre60fc', 'Briteq BT-THEATRE 60FC', 'briteqbttheatre60fc', '06015', 'B06015'],
    ['Color Changer'], bt, [
        mode('4ch-rgb-dim', '4CH RGB+DIM', ['red', 'green', 'blue', 'dimmer-strobe']),
        mode('4ch-rgbw', '4CH RGBW', ['red', 'green', 'blue', 'white']),
        mode('5ch', '5CH RGBW+DIM', ['red', 'green', 'blue', 'white', 'dimmer-strobe']),
        mode('6ch', '6CH', ['red', 'green', 'blue', 'white', 'dimmer', 'sound-strobe']),
        mode('6ch-plus', '6CH+', ['red', 'green', 'blue', 'white', 'dimmer', 'strobe']),
        mode('7ch', '7CH', ['dimmer', 'strobe-multi', 'color-macro', 'red', 'green', 'blue', 'white']),
    ],
    'Beglec operation manual B06015-05.pdf (BT-THEATRE 60FC); datasheet BT-THEATRE_60FC_06015_en.pdf',
    physical={'dimsMm': [241, 251, 195], 'weightKg': 3.63, 'powerW': 62, 'lensDegMin': 10, 'lensDegMax': 50}))

# ── Briteq BT-HURRICANE (DMX fan, one channel) ───────────────────────────────────────────────────
write('briteq-bt-hurricane', profile(
    'briteq/bt-hurricane', 'Briteq', 'BT-HURRICANE',
    ['BT-HURRICANE', 'BT HURRICANE', 'bthurricane', 'Briteq BT-HURRICANE', 'briteqbthurricane', '04850', 'Hurricane'],
    ['Fan'], [ch('fan', 'Fan Speed', 'speed')], [mode('1ch', '1ch', ['fan'])],
    'datasheet BT-HURRICANE_04850_en.pdf ("DMX-control 1channel", seamless fan speed)',
    physical={'dimsMm': [496, 548, 397], 'weightKg': 16.5, 'powerW': 200}))

# ── Stairville DDS 405 (4-channel dimmer / switch pack) ──────────────────────────────────────────
dds = [ch(f'dimmer{i}', f'Dimmer {i}', 'dimmer', highlight=1) for i in range(1, 5)]
write('stairville-dds-405', profile(
    'stairville/dds-405', 'Stairville', 'DDS 405',
    ['DDS 405', 'DDS-405', 'dds405', 'Stairville DDS 405', 'stairvilledds405', 'DDS-405 DMX Dimmer & Switchpack'],
    ['Dimmer'], dds, [mode('4ch', '4ch', [c['key'] for c in dds])],
    'Thomann user manual DMX_Gradateur_DDS405.pdf (ID 174194) - continuous addressing, 4 dimmable channels',
    physical={'dimsMm': [200, 65, 180], 'weightKg': 2}))

# ── Cameo MOVO BEAM Z100 / MOVO BEAM 100 ─────────────────────────────────────────────────────────
STROBE_MULTI = rng(
    (0, 5, 'Open'), (6, 10, 'Closed'), (11, 33, 'Pulse random slow-fast'), (34, 56, 'Ramp up random slow-fast'),
    (57, 79, 'Ramp down random slow-fast'), (80, 102, 'Random strobe slow-fast'),
    (103, 127, 'Strobe break 5s-1s'), (128, 250, 'Strobe slow-fast <1-20 Hz'), (251, 255, 'Open'))
STROBE_SIMPLE = rng((0, 5, 'Open'), (6, 255, 'Strobe slow-fast <1-20 Hz'))
ENDLESS = lambda axis: rng(
    (0, 5, 'No function'), (6, 126, f'Clockwise {axis} rotation fast-slow'), (127, 128, 'No movement'),
    (129, 255, f'Counter-clockwise {axis} rotation slow-fast'))
AUTO = rng((0, 5, 'Off'), *[(6 + 31 * i, 36 + 31 * i if i < 7 else 255, f'Auto Program {i + 1}') for i in range(8)])
DEVICE = rng(
    (0, 5, 'No function'), (6, 32, 'Blackout while moving on (hold 3s)'), (33, 59, 'Blackout while moving off (hold 5s)'),
    (60, 86, 'Invert pan on (hold 3s)'), (87, 113, 'Invert pan off (hold 5s)'), (114, 140, 'Invert tilt on (hold 3s)'),
    (141, 167, 'Invert tilt off (hold 5s)'), (168, 194, 'Silent fan on (hold 3s)'), (195, 221, 'Silent fan off (hold 5s)'),
    (222, 255, 'Reset all functions (hold 3s)'))
RING_NAMES = ['Colour Jump', 'Red 1 Step', 'Green 1 Step', 'Blue 1 Step', 'Yellow 1 Step', 'Cyan 1 Step', 'Magenta 1 Step',
              '2step Magenta Yellow', '2step Red Green', '2step Red Blue', '2step Blue Yellow', '2step Green Blue',
              '2step Magenta Blue', '2step Green Yellow', '2step Cyan Magenta', '2step Cyan Red']
RING_MACRO = rng((0, 5, 'Colour off'), *[(6 + 8 * i, 13 + 8 * i, f'Macro {i + 1} ({n})') for i, n in enumerate(RING_NAMES)],
                 (134, 255, 'No function'))
COLOURS = ['Red', 'Amber', 'Yellow warm', 'Yellow', 'Green', 'Turquoise', 'Cyan', 'Blue', 'Lavender', 'Mauve', 'Magenta',
           'Pink', 'Warm White', 'White', 'Cold White']
COLOUR_MACRO = rng((0, 5, 'Colour off'), *[(6 + 8 * i, 13 + 8 * i, n) for i, n in enumerate(COLOURS)],
                   (126, 127, 'Colour jumping stop'), (128, 191, 'Colour jumping slow-fast'), (192, 255, 'Colour fading slow-fast'))
PT_MACRO = rng((0, 5, 'Off'), (6, 40, 'Pan small-big'), (41, 75, 'Tilt small-big'), (76, 110, 'Pan/Tilt small-big'),
               (111, 145, 'Pan/Tilt inverse small-big'), (146, 180, 'Circle small-big'), (181, 215, 'Circle inverse small-big'),
               (216, 255, 'Random small-big'))
CURVE = rng((0, 5, 'No function'), (6, 63, 'Linear'), (64, 127, 'Exponential'), (128, 191, 'Logarithmic'), (192, 255, 'S-Curve'))

# ⚠ The manuals give pan/tilt only as "0% to 100%" on heads whose axes rotate endlessly; 360 deg per
# axis is OUR ASSUMPTION (one full turn), which is why both Movo profiles ship verified:false.
movo = [
    ch('pan', 'Pan', 'pan', default=0.5, res=2, min=0, max=360, unit='deg'),
    ch('pan-endless', 'Endless Pan Rotation', 'unknown', ranges=ENDLESS('pan')),
    ch('tilt', 'Tilt', 'tilt', default=0.5, res=2, min=0, max=360, unit='deg'),
    ch('tilt-endless', 'Endless Tilt Rotation', 'unknown', ranges=ENDLESS('tilt')),
    ch('dimmer', 'Dimmer', 'dimmer', res=2, highlight=1),
    ch('strobe', 'Strobe', 'shutter', ranges=STROBE_SIMPLE),
    ch('strobe-functions', 'Strobe Functions', 'shutter', ranges=STROBE_MULTI),
    ch('red', 'Red', 'red', highlight=1), ch('green', 'Green', 'green', highlight=1),
    ch('blue', 'Blue', 'blue', highlight=1), ch('white', 'White', 'white', highlight=1),
    ch('colour-macro', 'Colour Macro', 'macro', ranges=COLOUR_MACRO),
    ch('zoom', 'Zoom', 'zoom'),
    ch('auto-program', 'Auto Program', 'macro', ranges=AUTO),
    ch('pan-tilt-macro', 'Pan/Tilt Macro', 'macro', ranges=PT_MACRO),
    ch('dimmer-curve', 'Dimmer Curve', 'maintenance', ranges=CURVE),
    ch('pan-tilt-speed', 'Pan/Tilt Speed', 'panTiltSpeed'),
    ch('device-settings', 'Device Settings', 'maintenance', ranges=DEVICE),
    # The LED ring is a second light source: its channels are deliberately NOT colour roles, which
    # would fold them into the beam's tint.
    ch('ring-dimmer', 'Ring Dimmer', 'unknown'),
    ch('ring-strobe', 'Ring Strobe', 'unknown', ranges=STROBE_SIMPLE),
    ch('ring-red', 'Ring Red', 'unknown'), ch('ring-green', 'Ring Green', 'unknown'), ch('ring-blue', 'Ring Blue', 'unknown'),
] + [ch(f'ring-{c}{i}', f'Ring {c.capitalize()} {i}', 'unknown') for i in range(1, 5) for c in ('red', 'green', 'blue')] + [
    ch('ring-macro', 'Ring Colour Macro', 'macro', ranges=RING_MACRO),
    ch('ring-macro-speed', 'Ring Macro Speed', 'speed'),
]
PT = [('pan', 0), ('pan', 1), 'pan-endless', ('tilt', 0), ('tilt', 1), 'tilt-endless']
RING12 = [f'ring-{c}{i}' for i in range(1, 5) for c in ('red', 'green', 'blue')]


def movo_modes(zoom):
    z = ['zoom'] if zoom else []
    basic = ['dimmer', 'strobe'] + z + ['auto-program', 'pan-tilt-speed']
    std = PT + ['dimmer', 'strobe-functions', 'red', 'green', 'blue', 'white'] + z + ['device-settings', 'ring-macro', 'ring-macro-speed']
    ring = PT + ['dimmer', 'strobe-functions', 'red', 'green', 'blue', 'white'] + z + [
        'device-settings', 'ring-dimmer', 'ring-strobe', 'ring-red', 'ring-green', 'ring-blue', 'ring-macro', 'ring-macro-speed']
    full = PT + [('dimmer', 0), ('dimmer', 1), 'strobe-functions', 'red', 'green', 'blue', 'white', 'colour-macro'] + z + [
        'auto-program', 'pan-tilt-macro', 'dimmer-curve', 'pan-tilt-speed', 'device-settings', 'ring-dimmer', 'ring-strobe',
    ] + RING12 + ['ring-macro', 'ring-macro-speed']
    return [mode(f'{len(m)}ch', f'{len(m)}ch', m) for m in (basic, std, ring, full)]


write('cameo-movo-beam-z100', profile(
    'cameo/movo-beam-z100', 'cameo', 'MOVO BEAM Z100',
    ['MOVO BEAM Z100', 'Movo Beam Z 100', 'movobeamz100', 'CLMBZ100', 'clmbz100', 'cameo MOVO BEAM Z100', 'cameomovobeamz100'],
    ['Moving Head', 'Color Changer'], movo, movo_modes(True),
    'Adam Hall CLMBZ100_Cameo_DMX_Control_Table.pdf (5 / 16 / 21 / 36 CH)', verified=False))
write('cameo-movo-beam-100', profile(
    'cameo/movo-beam-100', 'cameo', 'MOVO BEAM 100',
    ['MOVO BEAM 100', 'Movo Beam 100', 'movobeam100', 'CLMB100', 'clmb100', 'cameo MOVO BEAM 100', 'cameomovobeam100'],
    ['Moving Head', 'Color Changer'], movo, movo_modes(False),
    'Cameo MOVO BEAM 100 user manual CLMB100 REV 03, pages 69-74 (4 / 15 / 20 / 35 CH)', verified=False))

# ── BeamZ Zelos (battery LED tube, RGB + cool white + warm white, 150.654 / set of 8: 150.656) ───
# ONE PROFILE IS ONE TUBE: each tube of the set has its own address. The manual prints the channel
# tables without naming the mode above each one, so which 4-channel table is "4CHA" and which is "4CHB"
# (same for 6CH) is read from the ORDER of the tables against the order of the menu — hence unverified.
# The per-section channels of the 40/80/160CH modes are `unknown` on purpose, like the Movo ring: eight
# channels sharing the role `red` cannot be told apart by anything that drives a fixture by role.
Z_STROBE = rng((0, 10, 'No function'), (11, 255, 'Strobe'))
Z_EMIT = [('red', 'Red', 'red'), ('green', 'Green', 'green'), ('blue', 'Blue', 'blue'),
          ('cool-white', 'Cool White', 'coldWhite'), ('warm-white', 'Warm White', 'warmWhite')]
Z_COLOUR = rng(
    (0, 10, 'No function'), (11, 19, 'Red'), (20, 28, 'Green'), (29, 37, 'Blue'), (38, 46, 'Cool white'),
    (47, 55, 'Warm white'), (56, 64, 'Red + green'), (65, 73, 'Green + blue'), (74, 82, 'Red + blue'),
    (83, 91, 'Red + green'), (92, 100, 'Green + blue'), (101, 109, 'Red + warm white'), (110, 118, 'Red + green'),
    (119, 127, 'Green + blue'), (128, 136, 'Red + blue'), (137, 145, 'Blue + warm white'),
    (146, 154, 'Warm white + cool white'), (155, 163, 'Green + cool white'), (164, 172, 'Green + warm white'),
    (173, 181, 'Red + blue + cool white'), (182, 190, 'Red + warm white + cool white'),
    (191, 199, 'Green + blue + cool white'), (200, 208, 'Green + blue + warm white'),
    (209, 217, 'Blue + warm white + cool white'), (218, 226, 'Red + green + blue'),
    (227, 235, 'Red + green + blue + cool white'), (236, 244, 'Green + blue + cool white + warm white'),
    (245, 255, 'Red + green + blue + cool white + warm white'))
Z_BACKGROUND = rng(
    (0, 16, 'No function'), (17, 33, 'Background red'), (34, 50, 'Background green'), (51, 67, 'Background blue'),
    (68, 84, 'Background cool white'), (85, 101, 'Background warm white'), (102, 118, 'Background red + green'),
    (119, 135, 'Background green + blue'), (136, 152, 'Background red + blue'), (153, 169, 'Background red + green'),
    (170, 186, 'Background green + blue'), (187, 203, 'Background red + warm white'),
    (204, 220, 'Background red + green'), (221, 237, 'Background green + blue'), (238, 254, 'Background red + blue'),
    (255, 255, 'Background blue + warm white'))
Z_SECTIONS = 32
zelos = [
    ch('dimmer', 'Total Dimming', 'dimmer', highlight=1),
    ch('strobe', 'Strobe', 'shutter', ranges=Z_STROBE),
] + [ch(k, l, r, highlight=1) for k, l, r in Z_EMIT] + [
    ch('cct', 'Color Temperature', 'colorTemp', ranges=rng((0, 4, 'No function'), (5, 255, 'Color temperature'))),
    ch('green-magenta', 'Tune Green / Magenta', 'unknown', default=0.5),
    ch('hue', 'RGB Mixed Color', 'macro', ranges=rng((0, 4, 'No function'), (5, 255, 'RGB mixed color'))),
    ch('saturation', 'Color Saturation', 'unknown'),
    ch('colour', 'Color', 'macro', ranges=Z_COLOUR),
    ch('background', 'Background Color', 'macro', ranges=Z_BACKGROUND),
    ch('base-tint', 'Base Tint', 'macro', ranges=rng((0, 1, 'No function'), (2, 255, 'Base tint'))),
    ch('effect', 'Effects', 'macro', ranges=rng(
        (0, 10, 'No function'), (11, 220, 'Effects (68 types, 3 values each)'), (221, 255, 'No function'))),
    ch('effect-speed', 'Effect Speed', 'speed'),
] + [ch(f's{i}-{k}', f'{l} {i}', 'unknown') for i in range(1, Z_SECTIONS + 1) for k, l, _ in Z_EMIT]
Z_RGBCW = [k for k, _, _ in Z_EMIT]
z_sections = lambda n: [f's{i}-{k}' for i in range(1, n + 1) for k in Z_RGBCW]
write('beamz-zelos', profile(
    'beamz/zelos', 'BeamZ', 'Zelos',
    ['Zelos', 'BeamZ Zelos', 'beamzzelos', 'Zelos LED Tube', 'Zelos LED Tube Set', '150.654', '150.656', '150654', '150656'],
    ['Color Changer'], zelos, [
        mode('4ch-a', '4CH A (CCT)', ['dimmer', 'strobe', 'cct', 'green-magenta']),
        mode('4ch-b', '4CH B (hue)', ['dimmer', 'strobe', 'hue', 'saturation']),
        mode('5ch', '5CH (RGB CW WW)', Z_RGBCW),
        mode('6ch-a', '6CH A (hue + CCT)', ['dimmer', 'strobe', 'hue', 'saturation', 'cct', 'green-magenta']),
        mode('6ch-b', '6CH B (dimmer + RGB CW WW)', ['dimmer'] + Z_RGBCW),
        mode('7ch', '7CH (dimmer, strobe, RGB CW WW)', ['dimmer', 'strobe'] + Z_RGBCW),
        mode('12ch', '12CH (effects)', ['dimmer', 'strobe', 'colour', 'background', 'base-tint', 'effect', 'effect-speed'] + Z_RGBCW),
        mode('40ch', '40CH (8 sections)', z_sections(8)),
        mode('80ch', '80CH (16 sections)', z_sections(16)),
        mode('160ch', '160CH (32 sections)', z_sections(32)),
    ],
    'beamZ manual 150.654_150.656-Zelos_Manual_V1.3.pdf, DMX channels pages 34-37',
    verified=False, physical={'dimsMm': [65, 65, 1440]}))
print('wrote local profiles to', os.path.normpath(OUT))
