import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { zipRead } from './mpcdi';
import { ensureUserDir, invalidateUserProfiles } from './fixtureLibrary';
import type {
  ChannelRole, FixtureProfile, ProfileChannel, ProfileGeoNode, ProfileMode, ProfileRange,
} from '../../shared/protocol';

// IMPORTING A .gdtf — the one source that carries a fixture's real GEOMETRY.
//
// The bundled library (Open Fixture Library) has excellent channel coverage and no meshes at all, so
// a profiled fixture is drawn as a procedural base/yoke/head. GDTF ships the actual model, split per
// moving part, plus the tree that says how those parts hinge — which is what turns "a box that
// rotates" into a fixture you can recognise and aim.
//
// A .gdtf is a ZIP of:
//   description.xml     the fixture: models, geometry tree, DMX modes
//   models/gltf/*.glb   ONE MESH PER GEOMETRY NODE — not a single model for the fixture
//   wheels/, thumbnail
//
// It carries complete DMX modes too, so an import produces a WHOLE profile (channels + modes +
// geometry) rather than geometry bolted onto an OFL one. That avoids having to reconcile two
// descriptions of the same fixture, which is a merge nobody could verify.

// ── A very small XML reader ──────────────────────────────────────────────────────────────────
// The geometry tree nests arbitrarily, so regex is not an option (mpcdi.ts gets away with it
// because its XML is flat). This is ~50 lines instead of a dependency: GDTF is machine-generated,
// attribute-quoted, and free of CDATA and exotic entities.

interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
}

function parseXml(xml: string): XNode | null {
  const root: XNode = { tag: '#root', attrs: {}, children: [] };
  const stack: XNode[] = [root];
  const re = /<(\/)?([A-Za-z_][\w.-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/)?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [, closing, tag, rawAttrs, selfClose] = m;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    const ar = /([\w.:-]+)\s*=\s*"([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(rawAttrs))) attrs[a[1]] = decode(a[2]);
    const node: XNode = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root.children[0] ?? null;
}

const decode = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const find = (n: XNode | undefined, tag: string): XNode | undefined =>
  n?.children.find((c) => c.tag === tag);
const all = (n: XNode | undefined, tag: string): XNode[] =>
  n?.children.filter((c) => c.tag === tag) ?? [];

// ── GDTF value formats ───────────────────────────────────────────────────────────────────────

/**
 * A GDTF DMX value is `value/bytes` — "255/1" is 8-bit full, "32768/2" is 16-bit half. Normalised
 * to 0..1 against the resolution it was WRITTEN at, which is the same trap the OFL converter hit:
 * dividing an 8-bit default by 65535 puts a head against its end stop.
 */
function dmxValue01(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /^(-?\d+)\s*\/\s*(\d+)$/.exec(raw.trim());
  if (!m) return undefined;
  const value = Number(m[1]);
  const bytes = Math.max(1, Math.min(4, Number(m[2])));
  const max = 256 ** bytes - 1;
  return max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
}

/** The DMX byte a value maps to, for a discrete range boundary. */
function dmxByte(raw: string | undefined): number | undefined {
  const v = dmxValue01(raw);
  return v === undefined ? undefined : Math.round(v * 255);
}

/**
 * A GDTF transform: four brace groups of four numbers.
 *
 * CONFIRMED AGAINST THE SPEC, because guessing here decides whether every imported fixture renders
 * upright or lying on its side:
 *   · stored row-major, but mathematically column-major — so the TRANSLATION IS THE 4TH COLUMN,
 *     i.e. the fourth number of each of the first three rows (NOT the fourth brace group, which is
 *     always {0,0,0,1});
 *   · GDTF is Z-UP: X left→right, Y into the screen, Z bottom→top, origin at the centre of the base;
 *   · a device is described HANGING, and the beam "emits its light into negative Z" — downward.
 *
 * Sanity-checked on a real file: the sample PAR puts its Beam at Z −0.134 (13 cm below the body, at
 * the lens) and its Yoke at Z +0.161 (16 cm above, the bracket). Both correct for a hanging fixture.
 *
 * ⚠ THE MESHES ARE NOT IN THIS SPACE. glTF mandates Y-up, so an exporter converts the geometry while
 * the XML keeps GDTF coordinates — verified on the sample, whose Body.glb measures X = Length,
 * Y = Height, Z = Width while the spec maps Length→X, Width→Y, Height→Z. So only these offsets need
 * converting; the meshes arrive already Y-up.
 */
function parseTransform(raw: string | undefined): { x: number; y: number; z: number } {
  if (!raw) return { x: 0, y: 0, z: 0 };
  const rows = [...raw.matchAll(/\{([^}]*)\}/g)].map((m) => m[1].split(',').map(Number));
  if (rows.length < 3 || rows[0].length < 4) return { x: 0, y: 0, z: 0 };
  const [gx, gy, gz] = [rows[0][3], rows[1][3], rows[2][3]];
  // GDTF (X right, Y into screen, Z up) → three.js (X right, Y up, Z out of screen).
  return { x: gx, y: gz, z: -gy };
}

// ── Attribute → role ─────────────────────────────────────────────────────────────────────────
// GDTF names attributes from a published vocabulary, so this is an exact table rather than the
// heuristics the OFL converter needs.
const ROLE_BY_ATTRIBUTE: Record<string, ChannelRole> = {
  Dimmer: 'dimmer',
  ColorAdd_R: 'red', ColorAdd_G: 'green', ColorAdd_B: 'blue', ColorAdd_W: 'white',
  ColorAdd_WW: 'warmWhite', ColorAdd_CW: 'coldWhite',
  ColorAdd_A: 'amber', ColorAdd_UV: 'uv', ColorAdd_L: 'lime', ColorAdd_C: 'cyan',
  ColorAdd_M: 'magenta', ColorAdd_Y: 'yellow',
  ColorSub_C: 'cyan', ColorSub_M: 'magenta', ColorSub_Y: 'yellow',
  CTO: 'colorTemp', CTC: 'colorTemp', CTB: 'colorTemp',
  Pan: 'pan', Tilt: 'tilt', PanTiltSpeed: 'panTiltSpeed',
  Zoom: 'zoom', Focus: 'focus', Iris: 'iris', Frost: 'frost',
  Shutter1: 'shutter', Shutter1Strobe: 'strobe', Shutter1StrobeRandom: 'strobe',
  Color1: 'colorWheel', Color2: 'colorWheel',
  Gobo1: 'goboWheel', Gobo2: 'goboWheel',
  Gobo1Pos: 'goboRotation', Gobo1PosRotate: 'goboRotation',
  Gobo2Pos: 'goboRotation', Gobo2PosRotate: 'goboRotation',
  Prism1: 'prism', Prism1Pos: 'prismRotation', Prism1PosRotate: 'prismRotation',
  Fog: 'fog', Haze: 'fog',
  Function: 'maintenance', Control1: 'maintenance',
};

const roleOf = (attribute: string | undefined): ChannelRole => {
  if (!attribute) return 'unknown';
  if (ROLE_BY_ATTRIBUTE[attribute]) return ROLE_BY_ATTRIBUTE[attribute];
  // Numbered variants (Gobo3, Shutter2, …) follow the same shape as their first sibling.
  const base = attribute.replace(/\d+$/, '1');
  return ROLE_BY_ATTRIBUTE[base] ?? 'unknown';
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

export interface GdtfImport {
  profile: FixtureProfile;
  /** Warnings worth showing the operator — an import that half-worked must say so. */
  notes: string[];
}

/**
 * Read a .gdtf into a complete FixtureProfile, extracting its meshes into userData.
 *
 * Throws only on a file that is not a GDTF at all; anything partial degrades to a usable profile
 * plus a note, because a fixture with no mesh is still far better than no fixture.
 */
export async function importGdtf(filePath: string): Promise<GdtfImport> {
  const bytes = await readFile(filePath);
  const entries = zipRead(bytes);
  const descBuf = entries.get('description.xml');
  if (!descBuf) throw new Error('not a GDTF: description.xml is missing');

  const root = parseXml(descBuf.toString('utf8'));
  const ft = find(root, 'FixtureType');
  if (!ft) throw new Error('not a GDTF: no <FixtureType>');

  const notes: string[] = [];
  const manufacturer = ft.attrs.Manufacturer || 'Unknown';
  const model = ft.attrs.LongName || ft.attrs.Name || 'Fixture';
  const id = `gdtf/${slug(manufacturer)}-${slug(model)}`;

  // ── models: name → file stem ───────────────────────────────────────────────────────────────
  const modelFile = new Map<string, string>();
  const modelSize = new Map<string, { w: number; h: number; d: number }>();
  for (const m of all(find(ft, 'Models'), 'Model')) {
    if (m.attrs.Name) {
      if (m.attrs.File) modelFile.set(m.attrs.Name, m.attrs.File);
      modelSize.set(m.attrs.Name, {
        w: Number(m.attrs.Width) || 0, h: Number(m.attrs.Height) || 0, d: Number(m.attrs.Length) || 0,
      });
    }
  }

  // ── geometry tree ──────────────────────────────────────────────────────────────────────────
  // <Geometry> nests <Axis> (a moving part) and <Beam> (where light leaves). The tag names the KIND;
  // which axis is pan and which is tilt is NOT here — it comes from the DMX channels below.
  const nodes: ProfileGeoNode[] = [];
  const nodeModel = new Map<string, string>();
  const walk = (n: XNode, parent?: string) => {
    for (const child of n.children) {
      const kind = child.tag === 'Axis' ? 'axis' : child.tag === 'Beam' ? 'beam'
        : child.tag === 'Geometry' || child.tag === 'GeometryReference' ? 'normal' : null;
      if (!kind || !child.attrs.Name) continue;
      const name = child.attrs.Name;
      const t = parseTransform(child.attrs.Position);
      nodes.push({ name, parent, kind, offset: t, model: child.attrs.Model || undefined });
      if (child.attrs.Model) nodeModel.set(name, child.attrs.Model);
      walk(child, name);
    }
  };
  walk(find(ft, 'Geometries') ?? { tag: 'x', attrs: {}, children: [] });

  // ── DMX modes ──────────────────────────────────────────────────────────────────────────────
  const channels: ProfileChannel[] = [];
  const byKey = new Map<string, ProfileChannel>();
  const modes: ProfileMode[] = [];
  // Which geometry each axis-driving attribute targets — this is how an <Axis> learns it is Pan.
  const axisRole = new Map<string, 'pan' | 'tilt'>();

  for (const mode of all(find(ft, 'DMXModes'), 'DMXMode')) {
    // offset (0-based) → slot
    const slots: Array<{ channelKey: string; byte: 0 | 1 | 2 } | null> = [];
    const put = (index: number, slot: { channelKey: string; byte: 0 | 1 | 2 } | null) => {
      while (slots.length <= index) slots.push(null);
      slots[index] = slot;
    };

    for (const ch of all(find(mode, 'DMXChannels'), 'DMXChannel')) {
      const offsets = (ch.attrs.Offset ?? '').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
      if (!offsets.length) continue;                       // a virtual channel occupies no DMX
      const logical = find(ch, 'LogicalChannel');
      const fn = find(logical, 'ChannelFunction');
      const attribute = logical?.attrs.Attribute ?? fn?.attrs.Attribute;
      const role = roleOf(attribute);

      // THE AXIS RESOLUTION. A Pan channel whose Geometry is "Yoke" is what makes the Yoke the pan
      // axis; GDTF never states it directly. Get this backwards and the head yaws while the yoke
      // tilts — visibly wrong, and only visible in 3D.
      if ((role === 'pan' || role === 'tilt') && ch.attrs.Geometry) axisRole.set(ch.attrs.Geometry, role);

      const label = fn?.attrs.Name || attribute || `Ch ${offsets[0]}`;
      let key = slug(`${label}-${role}`);
      if (byKey.has(key) && byKey.get(key)!.label !== label) key = slug(`${label}-${offsets[0]}`);

      let channel = byKey.get(key);
      if (!channel) {
        const resolution = Math.min(3, offsets.length) as 1 | 2 | 3;
        channel = { key, label, role, resolution, default: dmxValue01(fn?.attrs.Default) ?? 0 };
        const highlight = dmxValue01(ch.attrs.Highlight);
        if (highlight !== undefined) channel.highlight = highlight;

        // PhysicalFrom/To are the real-world range — degrees for pan/tilt, which is exactly what a
        // take stores and what the 3D scene aims with.
        const from = Number(fn?.attrs.PhysicalFrom), to = Number(fn?.attrs.PhysicalTo);
        if (Number.isFinite(from) && Number.isFinite(to) && (role === 'pan' || role === 'tilt' || role === 'zoom')) {
          channel.min = from; channel.max = to; channel.unit = 'deg';
        }
        const ranges = channelSets(fn);
        if (ranges) channel.ranges = ranges;
        if (ch.attrs.Geometry) channel.geometry = ch.attrs.Geometry;

        channels.push(channel);
        byKey.set(key, channel);
      }
      offsets.forEach((off, i) => put(off - 1, { channelKey: key, byte: Math.min(2, i) as 0 | 1 | 2 }));
    }

    if (!slots.length) continue;
    modes.push({
      key: slug(mode.attrs.Name || 'default'),
      name: mode.attrs.Name || 'Default',
      footprint: slots.length,
      slots,
    });
  }

  if (!modes.length) throw new Error('GDTF has no usable DMX mode');

  // Stamp the resolved axes onto the geometry nodes.
  let axes = 0;
  for (const n of nodes) {
    const r = axisRole.get(n.name);
    if (n.kind === 'axis' && r) { n.axis = r; axes++; }
  }
  if (nodes.some((n) => n.kind === 'axis') && axes === 0) {
    notes.push('No DMX channel drives an axis, so nothing will articulate — the mesh is static.');
  }

  // ── meshes ─────────────────────────────────────────────────────────────────────────────────
  // Prefer the low-LOD set: a high-detail mover is 50k+ triangles and a rig is dozens of them.
  const dir = join(await ensureUserDir(), 'models', slug(id));
  await mkdir(dir, { recursive: true });
  let written = 0;
  for (const [nodeName, mdl] of nodeModel) {
    const stem = modelFile.get(mdl);
    if (!stem) continue;
    const candidates = [
      `models/gltf_low/${stem}.glb`, `models/gltf/${stem}.glb`, `models/gltf_high/${stem}.glb`,
      `models/gltf_low/${stem}.gltf`, `models/gltf/${stem}.gltf`,
    ];
    const hit = candidates.map((c) => entries.get(c)).find(Boolean);
    if (!hit) continue;
    const out = join(dir, `${slug(stem)}.glb`);
    await writeFile(out, hit);
    written++;
    const node = nodes.find((n) => n.name === nodeName);
    if (node) node.modelPath = out;
  }
  if (!written) notes.push('No glTF meshes in this GDTF — the fixture will use the procedural body.');

  const profile: FixtureProfile = {
    id,
    manufacturer,
    model,
    aliases: [model, `${manufacturer} ${model}`, ft.attrs.ShortName || ''].filter(Boolean),
    channels,
    modes,
    geometry: written ? { modelPath: dir, nodes } : undefined,
    physical: physicalOf(ft, modelSize),
    source: { origin: 'gdtf', ref: filePath, rev: ft.attrs.FixtureTypeID, importedAt: new Date().toISOString() },
    // A GDTF is the MANUFACTURER'S OWN description, not something extracted from a PDF or guessed —
    // it is as authoritative as the shipped library.
    verified: true,
  };

  await writeFile(join(await ensureUserDir(), `${slug(id)}.json`), `${JSON.stringify(profile, null, 1)}\n`, 'utf8');
  invalidateUserProfiles();
  return { profile, notes };
}

/** Discrete slots from a channel function's ChannelSets. */
function channelSets(fn: XNode | undefined): ProfileRange[] | undefined {
  const sets = all(fn, 'ChannelSet').filter((s) => s.attrs.Name);
  if (sets.length < 2) return undefined;
  const out: ProfileRange[] = [];
  for (let i = 0; i < sets.length; i++) {
    const from = dmxByte(sets[i].attrs.DMXFrom) ?? 0;
    // A ChannelSet has no end — it runs to the start of the next one.
    const next = i + 1 < sets.length ? (dmxByte(sets[i + 1].attrs.DMXFrom) ?? 256) : 256;
    out.push({ from, to: Math.max(from, next - 1), label: sets[i].attrs.Name });
  }
  return out;
}

function findBeamXml(ft: XNode): XNode | undefined {
  const stack = [...(find(ft, 'Geometries')?.children ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.tag === 'Beam') return n;
    stack.push(...n.children);
  }
  return undefined;
}

function physicalOf(
  ft: XNode,
  modelSize: Map<string, { w: number; h: number; d: number }>,
): FixtureProfile['physical'] {
  const out: NonNullable<FixtureProfile['physical']> = {};
  const beam = findBeamXml(ft);
  const angle = Number(beam?.attrs.BeamAngle);
  if (Number.isFinite(angle) && angle > 0) { out.lensDegMin = angle; out.lensDegMax = angle; }
  const power = Number(beam?.attrs.PowerConsumption);
  if (Number.isFinite(power) && power > 0) out.powerW = power;
  const weight = Number(find(find(ft, 'PhysicalDescriptions'), 'Properties')?.children
    .find((c) => c.tag === 'Weight')?.attrs.Value);
  if (Number.isFinite(weight) && weight > 0) out.weightKg = weight;
  // Overall size from the ROOT geometry's model, in metres — GDTF is metric throughout.
  const first = [...modelSize.values()][0];
  if (first && first.w > 0) out.dimsMm = [first.w * 1000, first.h * 1000, first.d * 1000];
  return Object.keys(out).length ? out : undefined;
}
