#!/usr/bin/env node
// Build the bundled DMX fixture library: Open Fixture Library → ArtLux FixtureProfile.
//
//   npm run build:fixtures            # convert from a pinned OFL checkout
//   npm run build:fixtures -- --ref <sha|branch>
//
// WHY A BUILD SCRIPT AND NOT A RUNTIME IMPORTER. OFL's own docs say its JSON format "is not
// intended to be used directly by other software" and may break between releases. Converting once,
// offline, into the shape the packer wants means: the app carries no OFL parser, a schema change
// upstream breaks a BUILD (loudly, here) rather than an operator's show, and the output is a diff a
// human can read before it ships.
//
// The output is COMMITTED. That is deliberate: `npm run package` then needs no network, and any
// change to a thousand fixtures' channel tables shows up in review.
//
// LICENCE. OFL is MIT repo-wide — the licence covers `fixtures/` and `resources/gobos/`, so
// redistribution is fine PROVIDED the notice travels with it. We copy LICENSE-OFL.txt and write a
// NOTICE next to the data. Do not remove them.
//
// IDEMPOTENCE IS A REQUIREMENT, not a nicety: same source commit in ⇒ byte-identical output. Object
// keys are emitted in sorted order and nothing embeds a wall-clock time except the pinned commit's
// own date. `git diff` after a re-run must be empty.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'resources', 'fixture-library');
const CACHE = path.join(os.tmpdir(), 'artlux-ofl-cache');
const REPO = 'https://github.com/OpenLightingProject/open-fixture-library.git';

const argRef = (() => {
  const i = process.argv.indexOf('--ref');
  return i > 0 ? process.argv[i + 1] : null;
})();

// ── 1. Fetch, pinned ───────────────────────────────────────────────────────────────────────────
// A shallow clone, kept in a temp cache so repeated runs are fast. `git` rather than a tarball
// because Node ships no tar extractor, and rather than the contents API because that is ~630
// rate-limited requests.
function fetchSource() {
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!fs.existsSync(path.join(CACHE, '.git'))) {
    fs.rmSync(CACHE, { recursive: true, force: true });
    console.log(`[fixtures] cloning ${REPO} → ${CACHE}`);
    git(['clone', '--depth', '1', REPO, CACHE]);
  }
  // Then always land on the wanted ref. `origin/HEAD` is not reliably present in a shallow clone,
  // so fetch the ref explicitly and reset onto FETCH_HEAD rather than a remote-tracking branch that
  // may not exist. Unconditional, so a cached checkout and a fresh clone end up identical.
  console.log(`[fixtures] checking out ${argRef ?? 'HEAD'}`);
  git(['fetch', '--depth', '1', 'origin', argRef ?? 'HEAD'], CACHE);
  git(['reset', '--hard', 'FETCH_HEAD'], CACHE);
  return {
    sha: git(['rev-parse', 'HEAD'], CACHE),
    date: git(['log', '-1', '--format=%cI'], CACHE),
  };
}

// ── 2. Role mapping ────────────────────────────────────────────────────────────────────────────
// OFL capability `type` → ArtLux ChannelRole. Measured against the whole library rather than
// guessed: every type below occurs in the real data (the frequency comments are from that survey),
// and anything NOT listed falls through to 'unknown'.
//
// 'unknown' is not a failure — it is an honest label. The channel is still addressed, still
// occupies its DMX slot and is still controllable by hand; it just gets no role-aware behaviour
// (no colour mixing, no 3D aim, not matched when a recorded take is retargeted to another head).
// What 'unknown' must NEVER mean is "dropped": a fixture whose footprint shrank because we did not
// recognise channel 12 is mis-patched, and every fixture after it on the same controller moves.
const ROLE_BY_TYPE = {
  Pan: 'pan', PanContinuous: 'pan',
  Tilt: 'tilt', TiltContinuous: 'tilt',
  PanTiltSpeed: 'panTiltSpeed',
  Intensity: 'dimmer',
  ColorTemperature: 'colorTemp',
  ShutterStrobe: 'shutter',
  StrobeSpeed: 'strobe', StrobeDuration: 'strobe',
  WheelRotation: 'goboRotation', WheelSlotRotation: 'goboRotation',
  Prism: 'prism', PrismRotation: 'prismRotation',
  Zoom: 'zoom', BeamAngle: 'zoom',
  Focus: 'focus',
  Iris: 'iris', IrisEffect: 'iris',
  Frost: 'frost', FrostEffect: 'frost',
  Speed: 'speed', EffectSpeed: 'speed', Rotation: 'speed',
  Maintenance: 'maintenance',
  ColorPreset: 'macro', Effect: 'macro',
  Fog: 'fog', FogOutput: 'fog',
  // Deliberately 'unknown' rather than forced into a role: Generic, NoFunction, Time,
  // SoundSensitivity, EffectParameter, EffectDuration, FogType, BladeInsertion, BladeRotation,
  // BladeSystemRotation, BeamPosition. Each is real and addressable; none maps onto a role the
  // engine or the 3D scene can act on, and inventing one would be a lie the take retargeter would
  // then act upon.
  //
  // HUE / SATURATION are the notable absence, and it is a deliberate one. 86 channels in the source
  // are named exactly 'Hue' or 'Saturation', but they carry the type `Generic` — the source format
  // has no semantic type for them at all, so the only signal is the channel's NAME. Name-sniffing is
  // what this table exists to avoid (it is why wheels are classified from their slot types, which
  // ARE authoritative), and nothing in the engine consumes a hue role yet. They stay 'unknown':
  // fully addressable and controllable by hand, just not role-aware. Revisit when a colour-mixing
  // feature actually needs them, and add them by name THEN, with the trade-off written down.
};

// OFL ColorIntensity `color` → role. All thirteen values that occur in the library.
const ROLE_BY_COLOR = {
  Red: 'red', Green: 'green', Blue: 'blue',
  White: 'white', 'Warm White': 'warmWhite', 'Cold White': 'coldWhite',
  Amber: 'amber', UV: 'uv', Lime: 'lime', Indigo: 'indigo',
  Cyan: 'cyan', Magenta: 'magenta', Yellow: 'yellow',
};

// The wheels a capability refers to.
//
// `wheel` IS USUALLY ABSENT, and absent does not mean "no wheel" — per the OFL format it DEFAULTS TO
// THE CHANNEL NAME. Missing that default is not a cosmetic slip: with no wheel resolved, a colour
// wheel classifies as a gobo wheel, every range label degrades to the literal string "WheelSlot",
// and every slot colour and gobo image is silently dropped. (Measured: that is exactly what the
// first version of this script produced for Martin's MAC 250 Krypton.)
function wheelNames(channelName, capabilities) {
  const names = new Set();
  for (const c of capabilities) {
    if (c.wheel) for (const w of [].concat(c.wheel)) names.add(w);
    else names.add(channelName);
  }
  return names;
}

// The slot a capability selects. OFL spells this two ways: `slotNumber` for a capability that lands
// on one slot, and `slotNumberStart`/`slotNumberEnd` for one that sweeps across slots (where a
// fractional value means "between two slots"). Take the start and floor it; slots are 1-based.
function slotOfCapability(fixture, channelName, c) {
  const n = c.slotNumber ?? c.slotNumberStart;
  const index = Array.isArray(n) ? n[0] : n;
  if (typeof index !== 'number') return undefined;
  for (const w of wheelNames(channelName, [c])) {
    const slots = fixture.wheels?.[w]?.slots;
    const slot = slots?.[Math.max(0, Math.floor(index) - 1)];
    if (slot) return slot;
  }
  return undefined;
}

// Which role a WheelSlot/WheelShake channel gets — decided from the WHEEL's slot types, not from
// the channel's name. Name-sniffing gets 'Color Gobo Wheel' wrong, and plenty of fixtures name the
// channel something like 'Effects Wheel'.
function wheelRole(fixture, channelName, capabilities) {
  let gobo = 0, color = 0;
  for (const name of wheelNames(channelName, capabilities)) {
    for (const slot of fixture.wheels?.[name]?.slots ?? []) {
      if (slot.type === 'Gobo' || slot.type?.startsWith('AnimationGobo')) gobo++;
      else if (slot.type === 'Color') color++;
    }
  }
  if (gobo === 0 && color === 0) return 'goboWheel'; // a wheel we cannot classify is still a wheel
  return gobo >= color ? 'goboWheel' : 'colorWheel';
}

// A channel's role comes from the capability types present on it, in priority order — NOT from the
// most frequent one. A gobo wheel channel is mostly WheelSlot capabilities with an Open and a
// couple of Maintenance bands mixed in; frequency would pick correctly there but not on a Pan
// channel that carries a single Pan capability and three Maintenance ones.
const ROLE_PRIORITY = [
  'Pan', 'PanContinuous', 'Tilt', 'TiltContinuous', 'PanTiltSpeed',
  'ColorIntensity', 'ColorTemperature', 'Intensity',
  'WheelSlot', 'WheelShake', 'WheelRotation', 'WheelSlotRotation',
  'ShutterStrobe', 'StrobeSpeed', 'StrobeDuration',
  'Zoom', 'BeamAngle', 'Focus', 'Iris', 'IrisEffect', 'Frost', 'FrostEffect',
  'Prism', 'PrismRotation',
  'Fog', 'FogOutput',
  'ColorPreset', 'Effect', 'Speed', 'EffectSpeed', 'Rotation', 'Maintenance',
];

function channelRole(fixture, channelName, capabilities) {
  const byType = new Map();
  for (const c of capabilities) if (c.type) (byType.get(c.type) ?? byType.set(c.type, []).get(c.type)).push(c);
  for (const type of ROLE_PRIORITY) {
    const caps = byType.get(type);
    if (!caps) continue;
    if (type === 'ColorIntensity') return ROLE_BY_COLOR[caps[0].color] ?? 'unknown';
    if (type === 'WheelSlot' || type === 'WheelShake') return wheelRole(fixture, channelName, caps);
    if (ROLE_BY_TYPE[type]) return ROLE_BY_TYPE[type];
  }
  return 'unknown';
}

// ── 3. Value + range helpers ───────────────────────────────────────────────────────────────────
// An OFL DMX value may be a plain number (8-bit) or a [value, resolution] pair. Normalise to 0..255.
function dmxByte(v) {
  if (Array.isArray(v)) {
    const [value, res] = v;
    const max = 256 ** (res ?? 1) - 1;
    return max > 0 ? Math.round((value / max) * 255) : 0;
  }
  return typeof v === 'number' ? Math.max(0, Math.min(255, Math.round(v))) : null;
}

// '540deg' / '-270deg' → 540 / -270. OFL writes physical quantities as unit-suffixed strings.
function num(str) {
  if (typeof str === 'number') return str;
  if (typeof str !== 'string') return undefined;
  const m = str.match(/^(-?[\d.]+)/);
  return m ? Number(m[1]) : undefined;
}

// A gobo image key, if the wheel slot points at one of OFL's shared gobo resources.
function goboKeyOf(slot) {
  const res = slot?.resource;
  if (typeof res !== 'string') return undefined;
  return res.startsWith('gobos/') ? res.slice('gobos/'.length) : undefined;
}

// The discrete bands of a channel, when it HAS discrete bands. A channel whose capabilities are one
// continuous sweep (a dimmer) gets none — the UI shows it a slider, not a dropdown.
function rangesOf(fixture, channelName, capabilities) {
  if (capabilities.length < 2) return undefined;
  const out = [];
  for (const c of capabilities) {
    if (!Array.isArray(c.dmxRange)) continue;
    const from = dmxByte(c.dmxRange[0]), to = dmxByte(c.dmxRange[1]);
    if (from == null || to == null) continue;

    // A label the operator can actually read, most specific first. The WHEEL SLOT wins over the
    // capability's own `comment`: a gobo's comment is often a modifier like "indexing" while the
    // slot carries the name that is printed in the manual ("Eclipse"). Keep the comment as a
    // qualifier rather than throwing it away, since "Eclipse (indexing)" and "Eclipse (shake)" are
    // different selections on the same wheel and an operator picking blind needs both.
    const slot = slotOfCapability(fixture, channelName, c);
    const primary = slot?.name
      ?? c.shutterEffect
      ?? c.effectName
      ?? c.effectPreset
      ?? c.colorTemperature
      ?? slot?.colorTemperature
      ?? slot?.type
      ?? c.comment
      ?? c.type
      ?? '—';
    const qualifier = c.comment && String(c.comment) !== String(primary) ? ` (${c.comment})` : '';
    const entry = { from, to, label: `${primary}${qualifier}` };

    const color = slot?.colors?.[0] ?? c.colors?.[0];
    if (typeof color === 'string') entry.color = color;
    const gobo = goboKeyOf(slot);
    if (gobo) entry.goboKey = gobo;
    out.push(entry);
  }
  return out.length ? out : undefined;
}

// ── 4. Convert one fixture ─────────────────────────────────────────────────────────────────────
// Throws SkipError for a fixture we deliberately do not carry; the reason lands in the manifest's
// skip report, which is the honest measure of the library's coverage.
class SkipError extends Error {}

function convert(manufacturerKey, fixtureKey, fixture, manufacturers, extraAliases) {
  if (fixture.matrix || fixture.templateChannels) {
    // A matrix fixture's modes address per-pixel channels generated from templates, which is a
    // second addressing model on top of the flat one. Measured: 114 of 627 fixtures, and they are
    // the ONLY source of mode entries this converter cannot resolve (verified — zero unresolvable
    // entries in non-matrix fixtures). Carrying them half-converted would mis-address them.
    throw new SkipError('multi-cell (matrix/templateChannels) — not supported in v1');
  }
  const available = fixture.availableChannels ?? {};
  if (!fixture.modes?.length) throw new SkipError('no modes');

  // Pass 1: every base channel becomes a ProfileChannel; fine aliases are folded into it as extra
  // BYTES rather than becoming channels of their own, which is what makes 16-bit pan a single
  // parameter to the operator and to a take.
  const channels = [];
  const byKey = new Map();          // profile channel key → ProfileChannel
  const slotOf = new Map();         // OFL mode-entry name → { channelKey, byte }
  const switchAliases = new Map();  // switching alias → resolved OFL channel name

  const keyFor = (name) => {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ch';
    if (!byKey.has(base)) return base;
    for (let i = 2; ; i++) if (!byKey.has(`${base}-${i}`)) return `${base}-${i}`;
  };

  for (const [name, raw] of Object.entries(available)) {
    const ch = raw ?? {};
    const capabilities = ch.capabilities ?? (ch.capability ? [ch.capability] : []);
    const aliases = ch.fineChannelAliases ?? [];
    const resolution = Math.min(3, 1 + aliases.length);
    const key = keyFor(name);
    const role = channelRole(fixture, name, capabilities);
    const ranges = rangesOf(fixture, name, capabilities);

    // NORMALISING defaultValue / highlightValue — get this wrong and every moving head in the
    // library powers up pointing at its end stop.
    //
    // These are RAW DMX numbers, and the resolution they are expressed at is NOT necessarily the
    // channel's own. Martin's MAC 250 Krypton declares Pan as 16-bit (it has a `Pan fine` alias) but
    // writes `dmxValueResolution: "8bit"` with `defaultValue: 128` — meaning "centred", 128/255.
    // Dividing by 65535 instead yields 0.00195: hard against the mechanical stop, 269° out. Measured:
    // 95 channels across 60 fixtures declare a resolution that differs from their own.
    // A value may also arrive as an explicit `[value, resolution]` pair, which wins over everything.
    const RES_BYTES = { '8bit': 1, '16bit': 2, '24bit': 3, '32bit': 4 };
    const declared = RES_BYTES[ch.dmxValueResolution] ?? resolution;
    const norm01 = (raw) => {
      const [value, bytes] = Array.isArray(raw) ? [raw[0], raw[1] ?? declared] : [raw, declared];
      if (typeof value !== 'number') return undefined;
      const max = 256 ** bytes - 1;
      return max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    };

    const profileChannel = { key, label: name, role, resolution, default: norm01(ch.defaultValue) ?? 0 };
    const highlight = norm01(ch.highlightValue);
    if (highlight !== undefined) profileChannel.highlight = highlight;
    if (ch.invert) profileChannel.invert = true;

    // Physical range. Pan/tilt in DEGREES is load-bearing: it is what lets a recorded movement
    // replay on a head with a different sweep, and what lets the 3D scene aim a beam at a point.
    const single = capabilities.length === 1 ? capabilities[0] : undefined;
    const angleStart = num(single?.angleStart), angleEnd = num(single?.angleEnd);
    if (angleStart !== undefined && angleEnd !== undefined) {
      profileChannel.min = angleStart; profileChannel.max = angleEnd; profileChannel.unit = 'deg';
    }
    if (ranges) profileChannel.ranges = ranges;

    channels.push(profileChannel);
    byKey.set(key, profileChannel);
    slotOf.set(name, { channelKey: key, byte: 0 });
    aliases.forEach((alias, i) => slotOf.set(alias, { channelKey: key, byte: Math.min(2, i + 1) }));

    // Switching channels: this channel's capabilities may say "while I am in this band, alias X
    // means channel Y". Record the DEFAULT capability's target — the one that applies at the
    // channel's default value — because that is the mode's resting behaviour.
    for (const c of capabilities) {
      for (const [alias, target] of Object.entries(c.switchChannels ?? {})) {
        if (!switchAliases.has(alias)) switchAliases.set(alias, target);
      }
    }
  }

  // Pass 2: modes. Each entry resolves to a slot, or to null. Five entry kinds, all measured as
  // actually occurring in the source (see the survey in the commit that added this script).
  const modes = [];
  for (const mode of fixture.modes) {
    const slots = [];
    for (const entry of mode.channels ?? []) {
      if (entry === null) { slots.push(null); continue; }             // reserved-but-unused
      if (typeof entry === 'object') throw new SkipError('mode inserts matrix channels');
      const direct = slotOf.get(entry);
      if (direct) { slots.push({ ...direct }); continue; }            // base channel or fine alias
      const target = switchAliases.get(entry);                        // switching-channel alias
      const resolved = target ? slotOf.get(target) : undefined;
      if (resolved) { slots.push({ ...resolved }); continue; }
      throw new SkipError(`mode "${mode.name}" references unknown channel "${entry}"`);
    }
    if (!slots.length) continue;                                     // a 0-channel mode is not a mode
    modes.push({
      key: (mode.shortName ?? mode.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      name: mode.name,
      footprint: slots.length,
      slots,
    });
  }
  if (!modes.length) throw new SkipError('no usable modes');

  // Drop channels no mode actually references — otherwise the inspector shows an operator controls
  // that cannot reach the wire in the mode they picked.
  const used = new Set();
  for (const m of modes) for (const s of m.slots) if (s) used.add(s.channelKey);
  const kept = channels.filter((c) => used.has(c.key));

  const manufacturerName = manufacturers[manufacturerKey]?.name ?? manufacturerKey;
  const physical = {};
  const p = fixture.physical ?? {};
  if (Array.isArray(p.dimensions)) physical.dimsMm = p.dimensions.map(Number);
  if (typeof p.weight === 'number') physical.weightKg = p.weight;
  if (typeof p.power === 'number') physical.powerW = p.power;
  const lens = p.lens?.degreesMinMax;
  if (Array.isArray(lens)) { physical.lensDegMin = Number(lens[0]); physical.lensDegMax = Number(lens[1]); }

  return {
    id: `${manufacturerKey}/${fixtureKey}`,
    manufacturer: manufacturerName,
    model: fixture.name,
    aliases: aliasesFor(manufacturerName, fixture, extraAliases),
    ...(fixture.categories?.length ? { categories: fixture.categories } : {}),
    channels: kept,
    modes,
    ...(Object.keys(physical).length ? { physical } : {}),
    source: { origin: 'ofl', ref: `${manufacturerKey}/${fixtureKey}` },
    verified: true,
  };
}

// Search keys for "add a fixture by typing its reference". WITHOUT these, a real-world part code
// ('MAC250') matches nothing and the library reads as though it lacked the fixture entirely.
function aliasesFor(manufacturerName, fixture, extraAliases = []) {
  const out = new Set();
  const add = (s) => { if (typeof s === 'string' && s.trim()) out.add(s.trim()); };
  add(fixture.name);
  add(fixture.shortName);
  add(`${manufacturerName} ${fixture.name}`);
  // Names this fixture used to have. OFL keeps a redirect stub for every renamed fixture, and those
  // stale names are exactly what someone reading an older spec sheet or inventory will type — so
  // they belong in the search index, pointing at the fixture that replaced them.
  for (const a of extraAliases) { add(a); add(`${manufacturerName} ${a}`); }
  // Punctuation- and space-stripped forms, so 'mac250krypton' and 'MAC 250 Krypton' both land.
  for (const s of [...out]) add(s.toLowerCase().replace(/[^a-z0-9]+/g, ''));
  return [...out].sort();
}

// ── 5. Validate ────────────────────────────────────────────────────────────────────────────────
// Hard checks. A profile that fails is DROPPED and reported, never patched around: a silently
// repaired channel table is worse than a missing fixture, because the operator trusts it.
function validate(profile) {
  const keys = new Set(profile.channels.map((c) => c.key));
  if (!profile.channels.length) return 'no channels';
  if (!profile.modes.length) return 'no modes';
  for (const c of profile.channels) {
    if (!(c.resolution >= 1 && c.resolution <= 3)) return `channel ${c.key} resolution ${c.resolution}`;
    if (!(c.default >= 0 && c.default <= 1)) return `channel ${c.key} default ${c.default} out of 0..1`;
    for (const r of c.ranges ?? []) {
      if (!(r.from >= 0 && r.to <= 255 && r.from <= r.to)) return `channel ${c.key} range ${r.from}..${r.to}`;
    }
  }
  for (const m of profile.modes) {
    if (m.slots.length !== m.footprint) return `mode ${m.key}: ${m.slots.length} slots vs footprint ${m.footprint}`;
    if (m.footprint > 512) return `mode ${m.key} footprint ${m.footprint} > 512`;
    const seen = new Set();
    for (const s of m.slots) {
      if (!s) continue;
      if (!keys.has(s.channelKey)) return `mode ${m.key} references missing channel ${s.channelKey}`;
      if (!(s.byte >= 0 && s.byte <= 2)) return `mode ${m.key} byte ${s.byte}`;
      const id = `${s.channelKey}#${s.byte}`;
      if (seen.has(id)) return `mode ${m.key} emits ${id} twice`;
      seen.add(id);
    }
  }
  return null;
}

// ── 6. Emit ────────────────────────────────────────────────────────────────────────────────────
// Sorted keys + a trailing newline, so the committed output is stable and diffable.
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`, 'utf8');

function main() {
  const src = fetchSource();
  console.log(`[fixtures] source ${src.sha.slice(0, 12)} (${src.date})`);

  const fixturesDir = path.join(CACHE, 'fixtures');
  const manufacturers = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manufacturers.json'), 'utf8'));

  const manufacturerKeys = fs.readdirSync(fixturesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();

  // Every fixture file, read once.
  const source = [];
  for (const mk of manufacturerKeys) {
    for (const file of fs.readdirSync(path.join(fixturesDir, mk)).sort()) {
      if (!file.endsWith('.json')) continue;
      const fk = file.slice(0, -'.json'.length);
      source.push({ mk, fk, id: `${mk}/${fk}`, json: JSON.parse(fs.readFileSync(path.join(fixturesDir, mk, file), 'utf8')) });
    }
  }

  // Pass 1 — REDIRECTS. A redirect file is a stub whose only content is `redirectTo` plus the name
  // the fixture used to carry. It is not a fixture and must not become a profile, but throwing the
  // name away would be a small, silent loss of exactly the thing "add by reference" is for: the old
  // part number on someone's inventory sheet. Fold each old name into its target's aliases.
  const aliasesById = new Map();
  const redirects = [];
  for (const { id, json } of source) {
    if (typeof json.redirectTo !== 'string') continue;
    const list = aliasesById.get(json.redirectTo) ?? [];
    if (typeof json.name === 'string') list.push(json.name);
    list.push(id.split('/')[1]);   // the old fixture KEY too, e.g. 'mh-x30'
    aliasesById.set(json.redirectTo, list);
    redirects.push({ id, to: json.redirectTo, reason: json.reason ?? 'redirect' });
  }

  // Pass 2 — real fixtures.
  const profiles = [];
  const skipped = [];
  for (const { mk, fk, id, json } of source) {
    if (typeof json.redirectTo === 'string') continue;
    let profile;
    try {
      profile = convert(mk, fk, json, manufacturers, aliasesById.get(id) ?? []);
    } catch (e) {
      skipped.push({ id, reason: e instanceof SkipError ? e.message : `convert failed: ${e.message}` });
      continue;
    }
    const bad = validate(profile);
    if (bad) { skipped.push({ id, reason: `invalid: ${bad}` }); continue; }
    profile.source.rev = src.sha;
    profiles.push(profile);
  }

  // A redirect whose target we did not convert (e.g. it is a matrix fixture) leaves the old name
  // pointing at nothing. Report it rather than let it look like it resolved.
  const built = new Set(profiles.map((p) => p.id));
  const danglingRedirects = redirects.filter((r) => !built.has(r.to));

  // Fail the build rather than ship a library that lost most of its content to a silent upstream
  // schema change. 114 matrix fixtures of 627 are expected skips; anything approaching half is not.
  const skipRate = skipped.length / (profiles.length + skipped.length);
  if (profiles.length === 0) throw new Error('converted 0 fixtures — refusing to write an empty library');
  if (skipRate > 0.35) throw new Error(`skipped ${(skipRate * 100).toFixed(1)}% of fixtures — upstream format likely changed`);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'gobos'), { recursive: true });

  // Per-manufacturer chunks, fetched lazily at runtime.
  const byManufacturer = new Map();
  for (const p of profiles) {
    const mk = p.id.split('/')[0];
    (byManufacturer.get(mk) ?? byManufacturer.set(mk, []).get(mk)).push(p);
  }
  for (const [mk, list] of [...byManufacturer].sort(([a], [b]) => a.localeCompare(b))) {
    writeJson(path.join(OUT, `${mk}.json`), list);
  }

  // The eager catalogue: enough to search and to show a picker, small enough to load at startup.
  writeJson(path.join(OUT, 'index.json'), profiles.map((p) => ({
    id: p.id,
    manufacturer: p.manufacturer,
    model: p.model,
    aliases: p.aliases,
    ...(p.categories ? { categories: p.categories } : {}),
    modes: p.modes.map((m) => ({ key: m.key, name: m.name, footprint: m.footprint })),
  })));

  // Gobo images, referenced by ProfileRange.goboKey. Same MIT licence as the rest of the repo.
  let gobos = 0;
  const goboDir = path.join(CACHE, 'resources', 'gobos');
  if (fs.existsSync(goboDir)) {
    for (const f of fs.readdirSync(goboDir).sort()) {
      if (!/\.(png|svg)$/i.test(f)) continue;
      fs.copyFileSync(path.join(goboDir, f), path.join(OUT, 'gobos', f));
      gobos++;
    }
  }

  // Attribution — MIT requires the notice to travel with redistribution.
  fs.copyFileSync(path.join(CACHE, 'LICENSE'), path.join(OUT, 'LICENSE-OFL.txt'));
  fs.writeFileSync(path.join(OUT, 'NOTICE.txt'),
    'This directory is GENERATED — do not edit by hand.\n'
    + 'Run `npm run build:fixtures` to regenerate it.\n\n'
    + 'The fixture definitions and gobo images here are derived from the Open Fixture Library\n'
    + `(https://open-fixture-library.org/), MIT licensed, at commit ${src.sha}.\n`
    + 'The full licence text is in LICENSE-OFL.txt and must ship with this data.\n', 'utf8');

  writeJson(path.join(OUT, 'MANIFEST.json'), {
    generator: 'scripts/build-fixture-library.mjs',
    source: { repo: REPO, sha: src.sha, date: src.date, license: 'MIT' },
    counts: {
      profiles: profiles.length,
      manufacturers: byManufacturer.size,
      modes: profiles.reduce((n, p) => n + p.modes.length, 0),
      gobos,
      skipped: skipped.length,
      redirects: redirects.length,
      danglingRedirects: danglingRedirects.length,
    },
    // THE HONEST MEASURE OF COVERAGE. Read this file, not the profile count: a conversion that
    // quietly dropped a third of the library still reports a big number above.
    skipped: skipped.sort((a, b) => a.id.localeCompare(b.id)),
    // Old names folded into a live profile's aliases, and the ones whose target we did not build.
    danglingRedirects: danglingRedirects.sort((a, b) => a.id.localeCompare(b.id)),
  });

  console.log(`[fixtures] wrote ${profiles.length} profiles across ${byManufacturer.size} manufacturers, ${gobos} gobos`);
  console.log(`[fixtures] ${redirects.length} renamed fixtures folded in as aliases`
    + (danglingRedirects.length ? ` (${danglingRedirects.length} point at unbuilt targets)` : ''));
  console.log(`[fixtures] skipped ${skipped.length} (${(skipRate * 100).toFixed(1)}%) — see MANIFEST.json`);
}

main();
