import type { HelpEntry } from '../types';

// Fixture editor / LED-map controls (group: "Fixtures"). Authored during the help-system migration.
export const fixturesHelp: HelpEntry[] = [
  {
    id: 'fixture.mount',
    title: 'Mount',
    short: 'Whether this light is rigged on the floor or on the ceiling — and therefore which way it points.',
    body: 'A moving head hangs from a truss with its yoke down, or stands on the floor with its yoke up. The DMX is identical either way; what changes is which way it faces before you aim it. CEILING points it down, FLOOR points it up, and FREE leaves the orientation entirely to the Pitch / Yaw / Roll fields below — which is how every project made before this setting existed behaves. Those three fields are your own trim ON TOP of the mounting, so a hung head yawed 30 degrees still reads as 30, not -90 and something. Applies to every selected light at once, because a rig is mounted a truss at a time. It does not MOVE the fixture: set the height in Position (Y) as well, 0 for a floor rig.',
    group: 'Fixtures',
    keywords: ['mount', 'rig', 'truss', 'hang', 'hanging', 'ceiling', 'floor', 'invert', 'upside down', 'orientation'],
  },
  {
    id: 'fixtures.add',
    title: 'Add fixture',
    short: 'Create a new fixture and select it for editing.',
    body: 'Adds a blank fixture to the project and selects it so you can set its LED count, patch and geometry in the panels to the right.',
    group: 'Fixtures',
    keywords: ['create', 'new', 'led', 'strip'],
  },
  {
    id: 'fixtures.auto-patch',
    title: 'Auto-patch',
    short: 'Assign universes and DMX start addresses to all fixtures.',
    body: 'Walks every fixture and packs it into sequential universes/addresses so the output is contiguous. Use it after adding or resizing fixtures instead of patching each one by hand.',
    group: 'Fixtures',
    keywords: ['patch', 'address', 'addresses', 'universe', 'dmx', 'artnet', 'sacn'],
  },
  {
    id: 'fixtures.profile-search',
    title: 'Add a fixture by reference',
    short: 'Type what is printed on the case — “MAC250”, “Martin MAC 250 Krypton”.',
    body: 'Searches the shipped DMX fixture library (about 500 fixtures) plus any profiles you have '
      + 'imported yourself. Spacing, capitalisation and punctuation are ignored, so “MAC250” and '
      + '“mac 250 krypton” both work, and fixtures that were renamed are still found by their old '
      + 'name. Pick the MODE before adding: it decides how many DMX channels the fixture occupies. '
      + 'If nothing matches, the fixture is genuinely not in the library — import a .gdtf or .qxf '
      + 'file for it, or build a profile by hand, rather than settling for a near match: a profile '
      + 'from the wrong fixture patches the wrong channels.',
    group: 'Fixtures',
    keywords: ['profile', 'library', 'dmx', 'moving head', 'personality', 'gdtf', 'search', 'reference'],
  },
  {
    id: 'fixtures.save-template',
    title: 'Save as template',
    short: 'Save the selected fixture as a reusable template.',
    body: 'Stores the current fixture (LED count, pixel type, geometry) in the library so you can stamp out identical fixtures later. Disabled until a fixture is selected.',
    group: 'Fixtures',
    keywords: ['template', 'library', 'preset', 'save'],
  },
  {
    id: 'fixtures.add-from-template',
    title: 'Add from template',
    short: 'Create a new fixture from this saved template.',
    body: 'Adds a fresh fixture pre-filled with the template’s pixel structure. Faster than building each identical fixture from scratch.',
    group: 'Fixtures',
    keywords: ['template', 'library', 'preset', 'clone', 'duplicate'],
  },
  {
    id: 'fixtures.delete-template',
    title: 'Delete template',
    short: 'Remove this template from the library.',
    body: 'Deletes the saved template. Fixtures already created from it are unaffected.',
    group: 'Fixtures',
    keywords: ['template', 'remove', 'library', 'delete'],
  },
  {
    id: 'fixtures.ledmap-load',
    title: 'Load ledmap',
    short: 'Load a ledmap.json that remaps physical pixel order to geometry.',
    body: 'Imports a WLED-style ledmap (an array, or {"map":[...]}). Only needed for irregular wiring that the Reverse and Serpentine options cannot express.',
    group: 'Fixtures',
    keywords: ['wled', 'remap', 'import', 'wiring', 'json', 'pixel'],
  },
  {
    id: 'fixtures.ledmap-export',
    title: 'Export ledmap',
    short: 'Export the current ledmap — or an identity template — as JSON.',
    body: 'Downloads the fixture’s ledmap as JSON. With no map loaded it exports an identity map sized to the fixture, giving you a starting point to hand-edit.',
    group: 'Fixtures',
    keywords: ['wled', 'remap', 'download', 'json', 'export', 'identity'],
  },
  {
    id: 'fixtures.ledmap-clear',
    title: 'Clear ledmap',
    short: 'Remove the ledmap and revert to identity pixel order.',
    body: 'Drops the loaded ledmap so pixels map straight through in their natural order.',
    group: 'Fixtures',
    keywords: ['wled', 'reset', 'remove', 'identity'],
  },
  {
    id: 'fixtures.generate-serpentine',
    title: 'Generate serpentine map',
    short: 'Build a serpentine ledmap from cols/rows and turn off the Serpentine toggle.',
    body: 'Bakes zig-zag matrix wiring into a ledmap and disables the Serpentine toggle so the engine does not flip rows twice (transform order is reverse → ledmap → serpentine).',
    group: 'Fixtures',
    keywords: ['serpentine', 'zigzag', 'zig-zag', 'matrix', 'boustrophedon', 'wiring'],
  },
];
