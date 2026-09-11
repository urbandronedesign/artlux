// Does a show copied out of ANOTHER project still point at itself? Run: npm run test:import
//
// Cross-project import re-mints every carried id and rewrites every reference to it. The failure mode
// it exists to prevent is silent: the show engine tolerates a dangling reference EVERYWHERE by design
// (services/stateMachine.ts enter() does `if (s?.sceneId) ctx.recallScene(...)`, so a state whose
// scene is missing recalls nothing and the show runs on all night reporting playing:true). Nothing
// downstream will ever tell you the import was wrong — so it is checked here, where it is pure: one
// second, no Electron, no app, no GPU.
//
// Two parts, because they prove different things:
//   A. against the SHIPPED example projects — real files, real hand-authored ids;
//   B. against a synthetic fixture — the edges the examples never reach (cues, lighting, zones,
//      automation, media, and two scenes that legitimately share timeline-local ids).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  enumerateUnits, closureOf, planImport, validateReferences,
  type ImportableDoc,
} from '../src/renderer/services/projectImport';

const ROOT = process.cwd();          // npm runs this from the repo root
const read = (p: string): ImportableDoc => JSON.parse(readFileSync(join(ROOT, p), 'utf-8')) as ImportableDoc;

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`);
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// PART A — the shipped examples
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n=== A. examples/state-machine/03 → 01 ===');

const exSrc = read('examples/state-machine/03-interactive-installation.artlux');
const exDest = read('examples/state-machine/01-hello-state-machine.artlux');

for (const u of enumerateUnits(exSrc)) console.log(`  unit  ${u.kind.padEnd(13)} ${u.name}  (${u.detail})`);

const exClosure = closureOf(exSrc, { stateMachine: true });
console.log(`  closure  scenes=${exClosure.sceneIds.size} surfaces=${exClosure.surfaceIds.size}` +
  ` fixtures=${exClosure.fixtureIds.size} media=${exClosure.assetPaths.size}`);

check('the state machine drags the scenes its states are bound to', exClosure.sceneIds.size > 0);

// A DETERMINISTIC minter, so a failure is reproducible and the ids are readable in a dump.
let na = 0;
const exPlan = planImport(exSrc, exDest, { stateMachine: true }, { mint: () => `new-${++na}` });

// THE headline assertion. examples/state-machine/03 carries HAND-AUTHORED ids — st_attract, sc_ember,
// to_ember, rg_show. Any project grown from that example shares them EXACTLY, so a surviving one is a
// guaranteed collision rather than a risk, and this is the cheapest place to notice.
const survivors = [...new Set(JSON.stringify(exPlan.patch).match(/"(st|sc|to|rg)_[a-z0-9]+"/g) ?? [])];
check('no hand-authored source id survives the remap', survivors.length === 0, survivors.join(', '));

const exStateIds = new Set(exPlan.patch.states.map((s) => s.id));
const exSceneIds = new Set(exPlan.patch.scenes.map((s) => s.id));
check('every transition resolves to imported states',
  exPlan.patch.transitions.every((t) => exStateIds.has(t.to) && (t.fromAny || exStateIds.has(t.from))));
check('every state that kept a scene binding points at an imported scene',
  exPlan.patch.states.every((s) => !s.sceneId || exSceneIds.has(s.sceneId)));

const exMerged: ImportableDoc = {
  scenes: [...(exDest.scenes ?? []), ...exPlan.patch.scenes],
  cueBanks: [...(exDest.cueBanks ?? []), ...exPlan.patch.cueBanks],
  surfaces: [...(exDest.surfaces ?? []), ...exPlan.patch.surfaces],
  fixtures: [...(exDest.fixtures ?? []), ...exPlan.patch.fixtures],
  groups: [...(exDest.groups ?? []), ...exPlan.patch.groups],
  lightingPoses: [...(exDest.lightingPoses ?? []), ...exPlan.patch.lightingPoses],
  scene3D: { models: [], trackingZones: exPlan.patch.trackingZones } as unknown as ImportableDoc['scene3D'],
  stateMachine: {
    enabled: false, initialStateId: null,
    states: exPlan.patch.states, transitions: exPlan.patch.transitions, regions: exPlan.patch.regions,
  },
};
check('the merged document has no dangling references', validateReferences(exMerged).length === 0,
  validateReferences(exMerged).slice(0, 6).map((p) => `${p.where} -> missing ${p.missing}`).join('\n        '));
check('the destination keeps all of its own scenes',
  (exDest.scenes ?? []).every((s) => exMerged.scenes!.some((m) => m.id === s.id)));

// Importing the SAME project twice must not fuse the two copies — the common real gesture of
// re-importing after the source changed.
let nb = 0;
const exPlan2 = planImport(exSrc, exMerged, { stateMachine: true }, { mint: () => `two-${++nb}` });
const allSceneIds = [...exMerged.scenes!.map((s) => s.id), ...exPlan2.patch.scenes.map((s) => s.id)];
check('a second import of the same project collides with nothing',
  new Set(allSceneIds).size === allSceneIds.length);
check('a second import renames rather than reusing names',
  exPlan2.warnings.some((w) => w.kind === 'renamed'));

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// PART B — the edges the examples never reach
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n=== B. synthetic fixture ===');

// SA and SB deliberately share 'layer-1' / 'clip-1' / 'marker-1'. That is not a mistake in the
// fixture — it is what Capture Scene actually produces (it deep-clones the bound timeline, ids and
// all), and fusing the two scenes' clips is the bug being tested for.
const sharedTimeline = (clipName: string, videoPath: string) => ({
  layers: [{ id: 'layer-1', name: 'Track 1', enabled: true }],
  clips: [
    { id: 'clip-1', layerId: 'layer-1', name: clipName, path: videoPath, start: 0, duration: 5, inPoint: 0 },
    {
      id: 'clip-2', layerId: 'layer-1', name: 'Sweep', path: '', start: 5, duration: 5, inPoint: 0,
      kind: 'lighting' as const,
      lighting: { takeId: 'ltake-1', sequenceId: 'seq-1', groupId: 'G1', phase: 0.2 },
    },
  ],
  markers: [{ id: 'marker-1', time: 2, color: '#fff' }],
  trackingTakes: [{ id: 'ttake-1', name: 'Walk', path: 'D:/Src/assets/tracking/walk.lblob', duration: 8 }],
  lightingTakes: [{ version: 1 as const, id: 'ltake-1', name: 'Take', duration: 4, parts: [] }],
  lightingSequences: [{
    version: 1 as const, id: 'seq-1', name: 'Seq', duration: 4,
    keys: [{ t: 0, slots: [], poseRef: 'P1' }],
  }],
  automation: [
    { id: 'lane-1', targetPath: 'surfaces.S1.content.opacity', keyframes: [] },
    { id: 'lane-2', targetPath: 'audio.clip.ac1.gain', keyframes: [] },
    { id: 'lane-3', targetPath: 'audio.master.gain', keyframes: [] },
  ],
  audio: {
    // busId names an AudioBus in the PROJECT-GLOBAL mix, which this import does not carry.
    tracks: [{ id: 'at1', name: 'Audio 1', busId: 'bus-from-the-source' }],
    clips: [{ id: 'ac1', trackId: 'at1', name: 'Bed', path: 'D:/Src/assets/audio/loop.wav', start: 0, duration: 4, inPoint: 0 }],
  },
  duration: 10,
});

const src = {
  surfaces: [
    { id: 'S1', name: 'Wall', x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 0,
      content: { type: 'VIDEO', url: 'D:/Src/assets/video/wall.mp4', cameraDeviceId: 'machine-salted-id' } },
    { id: 'S2', name: 'Floor', x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 1, content: { type: 'NONE' } },
  ],
  fixtures: [
    { id: 'F1', name: 'Bar 1', x: 0, y: 0, width: 1, height: 0.1, rotation: 0, universe: 0,
      startAddress: 1, ledCount: 60, reverse: false, colorData: [], surfaceId: 'S1',
      controllerId: 'CTRL-A', profileId: 'prof-a' },
    { id: 'F2', name: 'Head 1', x: 0, y: 0, width: 0.1, height: 0.1, rotation: 0, universe: 0,
      startAddress: 100, ledCount: 1, reverse: false, colorData: [], surfaceId: 'S2', profileId: 'prof-a' },
  ],
  // ORDER IS THE SPREAD AXIS — reversed on purpose, so a remap that filtered `fixtures` instead of
  // mapping through this list would silently re-sort it and the assertion below would catch it.
  groups: [{ id: 'G1', name: 'Heads', fixtureIds: ['F2', 'F1'] }],
  // A pose with NO usable slot is dropped by normalizeNamedPoses ("drives nothing"), so give it one.
  lightingPoses: [{ id: 'P1', name: 'Open', slots: [{ pan: 0.5, dimmer: 1 }] }],
  fixtureProfiles: [{ id: 'prof-a', name: 'Generic Head' }],
  scene3D: {
    models: [{ id: 'M1', name: 'Screen', kind: 'plane', path: 'D:/Src/assets/models/screen.glb',
      layerId: 'layer-1', surfaceId: 'S1', uvProjFrom: 'S2',
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1, visible: true }],
    trackingZones: [
      { id: 'Z1', name: 'Entrance', surface: 'SOL', u0: 0, v0: 0, u1: 0.5, v1: 0.5 },
      { id: 'Z2', name: 'Stage', surface: 'MUR', u0: 0.5, v0: 0.5, u1: 1, v1: 1 },
    ],
  },
  scenes: [
    {
      id: 'SA', name: 'Alpha', globalBrightness: 1,
      surfaces: [{ id: 'S1', name: 'Wall', x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 0,
        content: { type: 'LAYER', layerId: 'layer-1' } }],
      fixtures: [{ id: 'F1', name: 'Bar 1', x: 0, y: 0, width: 1, height: 0.1, rotation: 0, universe: 0,
        startAddress: 1, ledCount: 60, reverse: false, colorData: [], surfaceId: 'S1', profileId: 'prof-a' }],
      scene3D: { models: [], activeZoneIds: ['Z1'], camMask: { junk: true }, viewFrom: 'S1' },
      timeline: sharedTimeline('Wall clip', 'D:/Src/assets/video/a.mp4'),
      audio: [
        { path: 'audio.master.gain', value: 0.8 },
        { path: 'audio.track.BEDTRACK.gain', value: 0.5 },
      ],
    },
    { id: 'SB', name: 'Beta', globalBrightness: 1, fixtures: [], timeline: sharedTimeline('Floor clip', 'D:/Src/assets/video/b.mp4') },
  ],
  cueBanks: [{
    id: 'B1', name: 'Bank 1', rows: 8, cols: 16,
    sceneCells: [{ col: 0, sceneId: 'SA' }],
    cues: [{
      id: 'Q1', name: 'Warm', row: 1, col: 0, fadeSec: 1, transition: 'linear',
      entries: [
        { path: 'globalBrightness', value: 0.7 },
        { path: 'surfaces.S1.content.opacity', value: 0.5 },
        { path: 'fixtures.F1.intensity', value: 1 },
        { path: 'fixtures.GHOST.intensity', value: 1 },
      ],
      lighting: [{ poseId: 'P1', groupId: 'G1' }],
    }],
  }],
  stateMachine: {
    enabled: true, initialStateId: 'st1',
    regions: [{ id: 'rg1', name: 'Show', x: 0, y: 0, w: 100, h: 100 }],
    states: [
      { id: 'st1', name: 'One', x: 0, y: 0, sceneId: 'SA', regionId: 'rg1',
        entry: [{ kind: 'recallScene', sceneId: 'SB' }, { kind: 'fireCue', cueId: 'Q1' }] },
      { id: 'st2', name: 'Two', x: 100, y: 0, entry: [], sceneId: 'SB' },
    ],
    transitions: [
      // Both name 'marker-1', but they resolve in DIFFERENT scenes — the point of per-timeline maps.
      { id: 't1', from: 'st1', to: 'st2', trigger: { kind: 'onMarker', markerId: 'marker-1' } },
      { id: 't2', from: 'st2', to: 'st1', trigger: { kind: 'onMarker', markerId: 'marker-1' } },
      { id: 't3', from: 'st1', to: 'st2', trigger: { kind: 'plugin', source: 'lidar.zone', params: { zoneId: 'Z1', terms: [{ zone: 'Z2' }] } } },
    ],
  },
} as unknown as ImportableDoc;

// The destination already owns a scene called "Alpha": the collision must be caught, because scene
// recall resolves by id and then FALLS BACK TO NAME.
const dest = {
  scenes: [{ id: 'dest-scene', name: 'Alpha', globalBrightness: 1, fixtures: [], timeline: { layers: [], clips: [] } }],
  fixtures: [], surfaces: [], groups: [], lightingPoses: [], cueBanks: [],
  fixtureProfiles: [{ id: 'prof-a', name: 'Generic Head' }],
} as unknown as ImportableDoc;

let n = 0;
const plan = planImport(src, dest, { stateMachine: true, cueBankIds: ['B1'] }, { mint: () => `m${++n}` });

console.log(`  plan  scenes=${plan.patch.scenes.length} states=${plan.patch.states.length}` +
  ` transitions=${plan.patch.transitions.length} surfaces=${plan.patch.surfaces.length}` +
  ` fixtures=${plan.patch.fixtures.length} groups=${plan.patch.groups.length}` +
  ` poses=${plan.patch.lightingPoses.length} zones=${plan.patch.trackingZones.length}` +
  ` banks=${plan.patch.cueBanks.length} profiles=${plan.patch.fixtureProfiles.length}` +
  ` media=${plan.assetPaths.length}`);
for (const w of plan.warnings) console.log(`  [${w.kind}] ${w.message}`);

const SA = plan.patch.scenes.find((s) => s.name.startsWith('Alpha'))!;
const SB = plan.patch.scenes.find((s) => s.name === 'Beta')!;
const cue = plan.patch.cueBanks[0].cues[0];
const paths = cue.entries.map((e) => e.path);

// ── Timeline-local ids: the two scenes must NOT be fused ───────────────────────────────────────────
check('two scenes sharing a source clip id get distinct ids',
  SA.timeline.clips[0].id !== SB.timeline.clips[0].id,
  `${SA.timeline.clips[0].id} vs ${SB.timeline.clips[0].id}`);
check('two scenes sharing a source track id get distinct ids',
  SA.timeline.layers[0].id !== SB.timeline.layers[0].id);
check('each scene clip points at its own scene track',
  SA.timeline.clips.every((c) => c.layerId === SA.timeline.layers[0].id) &&
  SB.timeline.clips.every((c) => c.layerId === SB.timeline.layers[0].id));

// ── Markers resolve in the BOUND document, not globally ────────────────────────────────────────────
const t1 = plan.patch.transitions[0];
const t2 = plan.patch.transitions[1];
check('two transitions naming the same source marker resolve to different scenes',
  !!t1.trigger.markerId && !!t2.trigger.markerId && t1.trigger.markerId !== t2.trigger.markerId,
  `${t1.trigger.markerId} vs ${t2.trigger.markerId}`);
check("t1's marker belongs to state One's scene", SA.timeline.markers!.some((m) => m.id === t1.trigger.markerId));
check("t2's marker belongs to state Two's scene", SB.timeline.markers!.some((m) => m.id === t2.trigger.markerId));

// ── Ids hidden inside dot-path strings ─────────────────────────────────────────────────────────────
check('an ownerless path is left exactly alone', paths.includes('globalBrightness'));
const surfPath = paths.find((p) => p.startsWith('surfaces.'))!;
const fixPath = paths.find((p) => p.startsWith('fixtures.'))!;
check('a surface dot-path is rewritten to the imported surface',
  surfPath === `surfaces.${plan.patch.surfaces[0].id}.content.opacity`, surfPath);
check('a fixture dot-path is rewritten to the imported fixture',
  fixPath.split('.')[1] === plan.patch.fixtures.find((f) => f.name === 'Bar 1')!.id, fixPath);
check('a dot-path addressing a non-imported object is DROPPED, not left dangling',
  !paths.some((p) => p.includes('GHOST')) &&
  plan.warnings.some((w) => w.kind === 'dropped' && w.message.includes('GHOST')));

const lanes = SA.timeline.automation!.map((l) => l.targetPath);
check('an automation lane on a surface is rewritten',
  lanes.includes(`surfaces.${plan.patch.surfaces[0].id}.content.opacity`), lanes.join(' | '));
check('an automation lane on an audio CLIP is rewritten ONE SEGMENT DEEPER',
  lanes.some((p) => p.startsWith('audio.clip.') && p.split('.')[2] === SA.timeline.audio!.clips[0].id),
  lanes.join(' | '));
check('audio.master has no owner and keeps its path untouched', lanes.includes('audio.master.gain'));

// ── Scene-bound audio pointing at the (un-carried) bed ─────────────────────────────────────────────
check('a scene audio entry on the bed is dropped with a warning',
  !(SA.audio ?? []).some((e) => e.path.includes('BEDTRACK')) &&
  plan.warnings.some((w) => w.kind === 'dropped' && w.message.includes('audio bed')));
check('an audio track loses a bus that was not imported, and says so',
  !(SA.timeline.audio!.tracks[0] as { busId?: string }).busId &&
  plan.warnings.some((w) => w.kind === 'cleared' && w.message.includes('bus')),
  'a carried track routed to the source mix would point at nothing; it must fall back to master');

check('a scene audio entry on audio.master survives',
  (SA.audio ?? []).some((e) => e.path === 'audio.master.gain'));

// ── Group order is the spread axis ─────────────────────────────────────────────────────────────────
const g = plan.patch.groups[0];
const fByName = (nm: string) => plan.patch.fixtures.find((f) => f.name === nm)!.id;
check('group fixture ORDER is preserved through the remap',
  g.fixtureIds[0] === fByName('Head 1') && g.fixtureIds[1] === fByName('Bar 1'), g.fixtureIds.join(', '));

// ── Zones ──────────────────────────────────────────────────────────────────────────────────────────
const zoneIds = plan.patch.trackingZones.map((z) => z.id);
const params = plan.patch.transitions[2].trigger.params as { zoneId?: string; terms?: { zone?: string }[] };
check('a plugin trigger zoneId is remapped', zoneIds.includes(params.zoneId!), String(params.zoneId));
check('a combination term zone is remapped', zoneIds.includes(params.terms![0].zone!));
check('a zone surface KEY (SOL/MUR) is never mistaken for a surface id',
  plan.patch.trackingZones.every((z) => z.surface === 'SOL' || z.surface === 'MUR'));
check('a scene activeZoneIds subscription is remapped',
  (SA.scene3D!.activeZoneIds ?? []).every((z) => zoneIds.includes(z)));

// ── What must NOT travel ───────────────────────────────────────────────────────────────────────────
check('a browser cameraDeviceId is stripped',
  !plan.patch.surfaces.some((s) => (s.content as { cameraDeviceId?: string }).cameraDeviceId));
check('controllers do not travel with a fixture', plan.patch.fixtures.every((f) => f.controllerId === undefined));
check('venue-scoped scene3D fields are stripped',
  !(SA.scene3D as unknown as Record<string, unknown>).camMask && !(SA.scene3D as unknown as Record<string, unknown>).viewFrom);
check("a scene never carries a copy of the room's zones",
  (SA.scene3D as unknown as Record<string, unknown>).trackingZones === undefined);

// ── Profiles are LIBRARY data — the id is preserved, never re-minted ───────────────────────────────
check('profileId is preserved so the profile still resolves',
  plan.patch.fixtures.every((f) => f.profileId === 'prof-a'));
check('a profile the destination already has is not carried again', plan.patch.fixtureProfiles.length === 0);

// ── Names ──────────────────────────────────────────────────────────────────────────────────────────
check('a colliding scene name is changed and reported',
  SA.name !== 'Alpha' && plan.warnings.some((w) => w.kind === 'renamed'), SA.name);
check('a non-colliding name is left alone', SB.name === 'Beta');

// ── Media ──────────────────────────────────────────────────────────────────────────────────────────
// FIVE, not six: the project-level scene3D model's .glb is deliberately NOT collected, because the
// project-level 3D scene does not travel (only each carried scene's own snapshot does). Copying a
// file that nothing imported references would be its own kind of wrong.
check('every referenced media file is collected for copying, and nothing else',
  plan.assetPaths.length === 5, `${plan.assetPaths.length}: ${plan.assetPaths.join(', ')}`);

// ── The merged document validates ──────────────────────────────────────────────────────────────────
const merged: ImportableDoc = {
  scenes: [...(dest.scenes ?? []), ...plan.patch.scenes],
  cueBanks: [...(dest.cueBanks ?? []), ...plan.patch.cueBanks],
  surfaces: [...(dest.surfaces ?? []), ...plan.patch.surfaces],
  fixtures: [...(dest.fixtures ?? []), ...plan.patch.fixtures],
  groups: [...(dest.groups ?? []), ...plan.patch.groups],
  lightingPoses: [...(dest.lightingPoses ?? []), ...plan.patch.lightingPoses],
  scene3D: { models: [], trackingZones: plan.patch.trackingZones } as unknown as ImportableDoc['scene3D'],
  stateMachine: {
    enabled: false, initialStateId: null,
    states: plan.patch.states, transitions: plan.patch.transitions, regions: plan.patch.regions,
  },
};
const problems = validateReferences(merged);
check('the merged document has no dangling references', problems.length === 0,
  problems.map((p) => `${p.where} -> missing ${p.missing}`).join('\n        '));

// …and the validator is not simply blind. A checker that returns clean on everything proves nothing,
// so break the one edge that matters and confirm it speaks up.
check('the validator DOES report a reference it should',
  validateReferences({ ...merged, scenes: (merged.scenes ?? []).filter((s) => s.id !== plan.patch.states[0].sceneId) }).length > 0);


// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// PART C — rig: 'map', binding the look onto a rig that is already here
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n=== C. mapping onto an existing rig ===');

const rigDest = (fixtures: unknown[], surfaces: unknown[]) => ({
  scenes: [], cueBanks: [], groups: [], lightingPoses: [], fixtureProfiles: [],
  fixtures, surfaces,
} as unknown as ImportableDoc);

// C1 — a rig that answers for everything: one match by NAME, one by ORDER within the same footprint.
const destFull = rigDest(
  [
    { id: 'dBar', name: 'Bar 1', ledCount: 60, profileId: 'prof-a' },
    { id: 'dMover', name: 'Mover A', ledCount: 1, profileId: 'prof-a' },
  ],
  [{ id: 'dWall', name: 'Wall' }, { id: 'dFloor', name: 'Floor' }],
);
let nm = 0;
const mapped = planImport(src, destFull, { stateMachine: true, cueBankIds: ['B1'] },
  { rig: 'map', mint: () => `k${++nm}` });

check('mapping carries NO rig objects', mapped.patch.fixtures.length === 0 && mapped.patch.surfaces.length === 0,
  `fixtures=${mapped.patch.fixtures.length} surfaces=${mapped.patch.surfaces.length}`);
check('…and therefore carries no fixture profiles either', mapped.patch.fixtureProfiles.length === 0);

const rowFor = (name: string) => mapped.rig!.fixtures.find((r) => r.srcName === name)!;
check('a fixture with the same name in both projects matches BY NAME',
  rowFor('Bar 1').destId === 'dBar' && rowFor('Bar 1').how === 'name',
  JSON.stringify(rowFor('Bar 1')));
check('a renamed fixture of the same footprint matches BY ORDER',
  rowFor('Head 1').destId === 'dMover' && rowFor('Head 1').how === 'order',
  JSON.stringify(rowFor('Head 1')));

const mSA = mapped.patch.scenes.find((s) => s.name.startsWith('Alpha'))!;
check("a scene's look now names the DESTINATION fixture",
  mSA.fixtures[0].id === 'dBar', mSA.fixtures[0].id);
check("…and the destination surface it samples from",
  mSA.fixtures[0].surfaceId === 'dWall', String(mSA.fixtures[0].surfaceId));
const mPaths = mapped.patch.cueBanks[0].cues[0].entries.map((e) => e.path);
check('a cue dot-path is rebound onto the destination fixture',
  mPaths.includes('fixtures.dBar.intensity'), mPaths.join(' | '));
check('a cue dot-path is rebound onto the destination surface',
  mPaths.includes('surfaces.dWall.content.opacity'), mPaths.join(' | '));
check('group order survives mapping, on destination ids',
  mapped.patch.groups[0].fixtureIds.join(',') === 'dMover,dBar',
  mapped.patch.groups[0].fixtureIds.join(','));
check('nothing in the patch still references a SOURCE rig id',
  !/"(S1|S2|F1|F2)"/.test(JSON.stringify(mapped.patch)));

// C2 — a rig that answers for only some of it. The unmatched must be NAMED, and their looks dropped.
const destPartial = rigDest(
  [{ id: 'dBar', name: 'Bar 1', ledCount: 60, profileId: 'prof-a' }],
  [{ id: 'dWall', name: 'Wall' }],
);
let np = 0;
const partial = planImport(src, destPartial, { stateMachine: true, cueBankIds: ['B1'] },
  { rig: 'map', mint: () => `q${++np}` });

const lost = partial.rig!.fixtures.find((r) => r.srcName === 'Head 1')!;
check('a fixture with no counterpart is reported unmatched', lost.destId === null && lost.how === null);
check('…and is NAMED in a warning, not silently dropped',
  partial.warnings.some((w) => w.kind === 'dropped' && w.message.includes('Head 1')),
  partial.warnings.map((w) => w.message).join(' | '));
check('a surface with no counterpart is named too',
  partial.warnings.some((w) => w.kind === 'dropped' && w.message.includes('Floor')));
check('the unmatched fixture is dropped from the group rather than left dangling',
  partial.patch.groups[0].fixtureIds.join(',') === 'dBar',
  partial.patch.groups[0].fixtureIds.join(','));
check('the merged document still validates with a partial rig',
  validateReferences({
    scenes: partial.patch.scenes,
    cueBanks: partial.patch.cueBanks,
    surfaces: destPartial.surfaces,
    fixtures: destPartial.fixtures,
    groups: partial.patch.groups,
    lightingPoses: partial.patch.lightingPoses,
    scene3D: { models: [], trackingZones: partial.patch.trackingZones } as unknown as ImportableDoc['scene3D'],
    stateMachine: {
      enabled: false, initialStateId: null,
      states: partial.patch.states, transitions: partial.patch.transitions, regions: partial.patch.regions,
    },
  }).length === 0);


// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// PART D — one state at a time
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n=== D. importing individual states ===');

// D1 — ONE state out of example 03's five-state ring, into example 01.
let nd = 0;
const one = planImport(exSrc, exDest, { stateIds: ['st_ember'] }, { mint: () => `d${++nd}` });
check('one state is carried, not the whole graph',
  one.patch.states.length === 1, `${one.patch.states.length} states`);
check('…and it brings exactly the scene it is bound to',
  one.patch.scenes.length === 1, `${one.patch.scenes.length} scenes`);
check('the carried state still points at that scene',
  one.patch.states[0].sceneId === one.patch.scenes[0].id);
// Every edge of that state has its other end left behind, so no edge survives.
check('no transition survives when only one endpoint is imported',
  one.patch.transitions.length === 0, `${one.patch.transitions.length} transitions`);
check('…and the loss is reported once, not once per edge',
  one.warnings.filter((w) => w.message.includes('transition')).length === 1,
  one.warnings.map((w) => w.message).join(' | '));
check('a single-state import still validates',
  validateReferences({
    scenes: [...(exDest.scenes ?? []), ...one.patch.scenes],
    surfaces: [...(exDest.surfaces ?? []), ...one.patch.surfaces],
    fixtures: [...(exDest.fixtures ?? []), ...one.patch.fixtures],
    groups: one.patch.groups, lightingPoses: one.patch.lightingPoses,
    scene3D: { models: [], trackingZones: one.patch.trackingZones } as unknown as ImportableDoc['scene3D'],
    stateMachine: {
      enabled: false, initialStateId: null,
      states: [...(exDest.stateMachine?.states ?? []), ...one.patch.states],
      transitions: [...(exDest.stateMachine?.transitions ?? []), ...one.patch.transitions],
      regions: one.patch.regions,
    },
  }).length === 0);

// D2 — TWO states that are adjacent in the ring: the edge between them must come across.
const ring = (exSrc.stateMachine?.transitions ?? [])[0];
let ne = 0;
const pair = planImport(exSrc, exDest, { stateIds: [ring.from, ring.to] }, { mint: () => `e${++ne}` });
check('two states carry two scenes', pair.patch.scenes.length === 2, `${pair.patch.scenes.length}`);
check('an edge whose BOTH ends are imported survives',
  pair.patch.transitions.length >= 1, `${pair.patch.transitions.length} transitions`);
const pairStates = new Set(pair.patch.states.map((s) => s.id));
check('…and it points at the two imported states',
  pair.patch.transitions.every((t) => pairStates.has(t.to) && (t.fromAny || pairStates.has(t.from))));

// D3 — the whole graph is still exactly equivalent to ticking every state.
let nf = 0;
const all = planImport(exSrc, exDest, { stateMachine: true }, { mint: () => `f${++nf}` });
let ng = 0;
const each = planImport(exSrc, exDest,
  { stateIds: (exSrc.stateMachine?.states ?? []).map((s) => s.id) }, { mint: () => `f${++ng}` });
check('ticking every state equals ticking the whole graph',
  all.patch.states.length === each.patch.states.length &&
  all.patch.transitions.length === each.patch.transitions.length &&
  all.patch.scenes.length === each.patch.scenes.length,
  `graph: ${all.patch.states.length}/${all.patch.transitions.length}/${all.patch.scenes.length}` +
  ` vs states: ${each.patch.states.length}/${each.patch.transitions.length}/${each.patch.scenes.length}`);

// D4 — a state appears as its own unit, labelled with the look it carries.
const stateUnits = enumerateUnits(exSrc).filter((u) => u.kind === 'state');
check('every state is offered as its own unit',
  stateUnits.length === (exSrc.stateMachine?.states ?? []).length, `${stateUnits.length} state units`);
check('…each labelled with the look it would bring',
  stateUnits.every((u) => u.detail.startsWith('look: ')), stateUnits.map((u) => u.detail).join(' | '));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
