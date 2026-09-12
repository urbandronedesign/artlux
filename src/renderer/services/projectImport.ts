// CROSS-PROJECT IMPORT — the closure + remap engine.
//
// Takes a SECOND project (read read-only through window.artlux.peekProject — never opened, see
// main/persistence.peekProject) plus a selection of units, and produces a PLAN: the objects to append
// to the open document, the media files to copy in, and the warnings an operator must see BEFORE any
// of it lands.
//
// ── WHY THIS FILE IS SHAPED THE WAY IT IS ──────────────────────────────────────────────────────────
//
// 1. THERE IS NO SMALL UNIT. A state machine's closure is very nearly the whole show half of the
//    document: SmState.sceneId names a Scene, and a Scene is a full look snapshot owning its own
//    surfaces, fixtures, scene3D and a REQUIRED timeline — which owns layers, clips, markers, tracking
//    and lighting takes, sequences, automation and audio, and escapes to project scope for groups,
//    lighting poses and tracking zones. So "copy the state machine" is really "merge two shows", and
//    the interesting question is not what to carry but what must NOT travel.
//
// 2. EVERY CARRIED ID IS RE-MINTED, and the reason is not probability. Most ids are crypto.randomUUID
//    and would never collide by chance. They collide DETERMINISTICALLY: the shipped examples carry
//    hand-authored ids (st_attract, sc_ember, to_ember, rg_show in
//    examples/state-machine/03-interactive-installation.artlux), so two projects grown from the same
//    example share every one — and project B is very often a Save-As copy of project A, in which case
//    they share ALL of them.
//
// 3. NAMES ARE DE-DUPLICATED TOO, because a name collision is as dangerous as an id collision here:
//    scene recall resolves by id and then FALLS BACK TO NAME (App.tsx recallByRef, and the same for
//    cues and banks). Two scenes called "Ember" and an OSC recall reaches whichever is first.
//
// 4. IDS HIDE INSIDE STRINGS. CueEntry.path, AutomationLane.targetPath and Scene.audio[].path address
//    their owner as text ("surfaces.<id>.content.opacity"), where no object-graph walker will find
//    them. They are rewritten through paramPath.withPathOwner — the same grammar the app reads them
//    with, never a regex, because the audio forms put the id one segment deeper.
//
// 5. TIMELINE-LOCAL IDS ARE REMAPPED PER TIMELINE, NOT GLOBALLY. Capture Scene deep-clones the bound
//    timeline ids and all, so two scenes in ONE project legitimately hold byte-identical clip ids —
//    the app defends this by resolving a clip id in the bound document ONLY and treating a miss as a
//    drop (App.tsx, rule 3). A single global clip map would fuse those two scenes' clips together.
//
// 6. IT VALIDATES BEFORE IT COMMITS, because nothing downstream ever will. A dangling reference is
//    silent BY DESIGN everywhere in the show engine: services/stateMachine.ts enter() does
//    `if (s?.sceneId) ctx.recallScene(...)`, so a state whose scene is missing recalls nothing and the
//    show runs on reporting playing:true all night. Same for jumpMarker, onMarker, onClipEnd, an
//    unregistered plugin trigger source, and LightingKey.poseRef. A broken import would present itself
//    as a perfectly healthy show.
//
// React-free and side-effect-free on purpose: it takes documents and returns a plan, so it can be run
// headlessly from a throwaway tsc script (docs/DEVELOPMENT.md → Testing) against the examples.

import type {
  Scene, Cue, CueBank, CueEntry, Timeline, VideoClip, VideoLayer, Marker,
  StateMachine, SmState, SmTransition, SmTrigger, SmRegion, LightingCueEntry,
  Surface, Fixture, FixtureGroup, NamedPose,
  TrackingTakeRef, LightingTake, LightingSequence, AutomationLane,
  AudioTrack, AudioClip,
} from '../types';
import type {
  Scene3D, SceneModel, TrackingZone, AssetEntry, FixtureProfile,
} from '../../../shared/protocol';
import {
  normalizeTimeline, normalizeStateMachine, normalizeCueBanks, normalizeNamedPoses,
} from '../types';
import { withPathOwner, pathOwner } from './paramPath';
// ⚠ THE NEUTRAL SDK ENTRY, NOT '@artlux/sdk/renderer'. Both re-export these two, but `/renderer`
// imports React at runtime, and this module has to stay loadable by a plain `tsc` + `node` harness
// with no bundler, no DOM and no React (scripts/tsconfig.test.json states that constraint for the
// standalone logic tests). Importing the pure entry is what keeps this file testable in a second.
import { nameStem, nextNumberedName } from '@artlux/sdk';

// ── The document, as this engine sees it ───────────────────────────────────────────────────────────
// ProjectData keeps scenes/timeline/stateMachine deliberately loose (`unknown`) so shared/ stays
// decoupled from renderer types. The importer needs the real shapes, so it declares its own view of
// the same JSON. Everything is optional: a hand-written or older .artlux may be missing any of it.
export interface ImportableDoc {
  scenes?: Scene[];
  cueBanks?: CueBank[];
  stateMachine?: StateMachine;
  surfaces?: Surface[];
  fixtures?: Fixture[];
  groups?: FixtureGroup[];
  lightingPoses?: NamedPose[];
  scene3D?: Scene3D;
  assets?: AssetEntry[];
  fixtureProfiles?: FixtureProfile[];
}

// ── What an operator can pick ──────────────────────────────────────────────────────────────────────
export type ImportUnitKind = 'stateMachine' | 'state' | 'scene' | 'cueBank' | 'pose';

export interface ImportUnit {
  kind: ImportUnitKind;
  /** Absent for the singleton state machine; the object's own (source) id otherwise. */
  id?: string;
  name: string;
  /** One line for the picker — "5 states, 4 transitions", "12 clips", … */
  detail: string;
}

export interface ImportSelection {
  /** The whole graph — every state, transition and region. */
  stateMachine?: boolean;
  /**
   * Individual states, for taking one node rather than a whole show.
   *
   * A transition is carried only when BOTH of its endpoints are, so picking one state gives you the
   * node and its look with no edges. That is deliberate: a transition with one end missing is exactly
   * the dangling reference the FSM swallows in silence.
   */
  stateIds?: string[];
  sceneIds?: string[];
  cueBankIds?: string[];
  poseIds?: string[];
}

// ⚠ THE TWO SINGLETONS ARE NOT UNITS, AND THAT IS DELIBERATE.
//
// The global timeline (ProjectData.timeline) and the audio bed (ProjectData.audio) are one-per-project
// by definition — the bed's whole identity is "one per project, rides the SHOW clock, survives a scene
// recall". They cannot be APPENDED the way a scene or a state can; importing one can only REPLACE or
// MERGE the destination's, which is a product decision about the operator's existing show rather than
// a remapping problem. Everything in this file is additive, so they stay out until that is decided.
// A scene's OWN timeline and its own Timeline.audio are unaffected: those travel with the scene, by
// value, and are fully handled here.

// ── Id namespaces ──────────────────────────────────────────────────────────────────────────────────
// PROJECT-SCOPE namespaces get one map for the whole import. TIMELINE-LOCAL ones get a fresh map per
// timeline (see note 5 in the header) and deliberately do not appear here.
type ProjectNs = 'scene' | 'state' | 'transition' | 'region' | 'surface' | 'fixture'
  | 'group' | 'pose' | 'zone' | 'model' | 'cue' | 'bank';

type Maps = Record<ProjectNs, Map<string, string>>;

const emptyMaps = (): Maps => ({
  scene: new Map(), state: new Map(), transition: new Map(), region: new Map(),
  surface: new Map(), fixture: new Map(), group: new Map(), pose: new Map(),
  zone: new Map(), model: new Map(), cue: new Map(), bank: new Map(),
});

/** The timeline-local id maps for ONE timeline — never shared between two of them. */
interface Locals {
  layer: Map<string, string>;
  clip: Map<string, string>;
  marker: Map<string, string>;
  trackingTake: Map<string, string>;
  lightingTake: Map<string, string>;
  sequence: Map<string, string>;
  audioTrack: Map<string, string>;
  audioClip: Map<string, string>;
}

const emptyLocals = (): Locals => ({
  layer: new Map(), clip: new Map(), marker: new Map(), trackingTake: new Map(),
  lightingTake: new Map(), sequence: new Map(), audioTrack: new Map(), audioClip: new Map(),
});

// Every carried object is minted with randomUUID, not App's 9-char generateId. Both schemes already
// coexist inside one document (a graph can hold 9-char state ids from handleCreateState alongside
// UUIDs from the graph editor), so uniformity here costs nothing — and it keeps imported objects out
// of the one id space that App shares across every category it mints.
export type Mint = () => string;
const defaultMint: Mint = () => crypto.randomUUID();

/** Allocate a fresh id for `id` in `m` (idempotent), and return it. */
function alloc(m: Map<string, string>, id: string, mint: Mint): string {
  const found = m.get(id);
  if (found) return found;
  const next = mint();
  m.set(id, next);
  return next;
}

// ── Asset paths ────────────────────────────────────────────────────────────────────────────────────
// Mirrors main/projectFolder.isFilePath: a blob:/http(s):/data: url is not a file on disk and must
// never be offered for copying.
const isFilePath = (p: unknown): p is string =>
  typeof p === 'string' && p.length > 0 && !/^(blob:|https?:|data:)/i.test(p);

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// NORMALIZE — the source arrives RAW
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Put a peeked document into the shape the app itself would have loaded.
 *
 * ⚠ THIS IS NOT DEFENSIVE TIDYING, IT IS A CORRECTNESS REQUIREMENT. peekProject deliberately does no
 * normalization — it reads, parses and resolves paths, nothing more — while every shape in the app
 * has been through applyProjectData's normalizers. The gap is not theoretical: the shipped example
 * examples/state-machine/03-interactive-installation.artlux has scenes with NO `timeline` key at all,
 * even though Scene.timeline is REQUIRED in the type.
 *
 * Importing one of those verbatim would recreate the timeline-less scene — the shape deleted on
 * 2026-07-14 because it materialised a copy of the global doc on its first edit, retagged its
 * automation from the show clock to the scene clock, and made a house fade on audio.master.gain jump
 * +9.6 dB on every GO. normalizeTimeline turns a missing timeline into an EMPTY one, never a fallback
 * to the global document, which is exactly what is wanted here.
 */
export function normalizeSource(doc: ImportableDoc): ImportableDoc {
  return {
    ...doc,
    scenes: (doc.scenes ?? []).map((sc) => ({
      ...sc,
      fixtures: sc.fixtures ?? [],
      timeline: normalizeTimeline(sc.timeline),
    })),
    cueBanks: normalizeCueBanks(doc.cueBanks),
    stateMachine: doc.stateMachine ? normalizeStateMachine(doc.stateMachine) : undefined,
    lightingPoses: normalizeNamedPoses(doc.lightingPoses),
    surfaces: doc.surfaces ?? [],
    fixtures: doc.fixtures ?? [],
    groups: doc.groups ?? [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// ENUMERATE — what the source offers
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

export function enumerateUnits(raw: ImportableDoc): ImportUnit[] {
  const doc = normalizeSource(raw);
  const out: ImportUnit[] = [];
  const sm = doc.stateMachine;
  if (sm && ((sm.states?.length ?? 0) > 0 || (sm.transitions?.length ?? 0) > 0)) {
    out.push({
      kind: 'stateMachine',
      name: 'State machine',
      detail: `${sm.states?.length ?? 0} states, ${sm.transitions?.length ?? 0} transitions`,
    });
  }
  // Individual states, so one node can be taken without its whole show. Listed with the scene each is
  // bound to, because that is what actually arrives with it — a state on its own is a name and a
  // position, and the look is the reason anyone wants it.
  for (const st of sm?.states ?? []) {
    const scene = (doc.scenes ?? []).find((s) => s.id === st.sceneId);
    out.push({
      kind: 'state', id: st.id, name: st.name,
      detail: scene ? `look: ${scene.name}` : 'no scene bound',
    });
  }
  for (const sc of doc.scenes ?? []) {
    const clips = sc.timeline?.clips?.length ?? 0;
    out.push({ kind: 'scene', id: sc.id, name: sc.name, detail: clips ? `${clips} clips` : 'no clips' });
  }
  for (const b of doc.cueBanks ?? []) {
    out.push({ kind: 'cueBank', id: b.id, name: b.name, detail: `${b.cues?.length ?? 0} cues` });
  }
  for (const p of doc.lightingPoses ?? []) {
    out.push({ kind: 'pose', id: p.id, name: p.name, detail: `${p.slots?.length ?? 0} slots` });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CLOSURE — what the selection actually drags with it
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

export interface Closure {
  /** True when any state is carried at all. */
  stateMachine: boolean;
  /** Exactly which states — the whole graph, a hand-picked few, or none. */
  stateIds: Set<string>;
  sceneIds: Set<string>;
  bankIds: Set<string>;
  cueIds: Set<string>;
  groupIds: Set<string>;
  poseIds: Set<string>;
  zoneIds: Set<string>;
  surfaceIds: Set<string>;
  fixtureIds: Set<string>;
  /** Absolute source paths of every media file the carried objects reference. */
  assetPaths: Set<string>;
}

/**
 * Does this transition survive the selection?
 *
 * BOTH endpoints must be carried. Picking one state out of a graph therefore gives you the node and
 * its look with no edges, which is the honest result: an edge with one end missing is precisely the
 * dangling reference the FSM swallows without a word — it would sit in the graph looking wired and
 * never fire, or fire into nothing.
 *
 * A `fromAny` global rule has no meaningful `from`, so only its destination has to be here.
 */
function carriesTransition(tr: SmTransition, states: Set<string>): boolean {
  return states.has(tr.to) && (!!tr.fromAny || states.has(tr.from));
}

/** Pull the zone ids out of a plugin trigger's opaque params (`lidar.zone` is the only source today). */
function zonesOfTrigger(t: SmTrigger | undefined): string[] {
  const p = t?.params as { zoneId?: unknown; terms?: { zone?: unknown }[] } | undefined;
  if (!p) return [];
  const out: string[] = [];
  if (typeof p.zoneId === 'string') out.push(p.zoneId);
  for (const term of Array.isArray(p.terms) ? p.terms : []) {
    if (term && typeof term.zone === 'string') out.push(term.zone);
  }
  return out;
}

/** Every media path a timeline references, including its own audio. */
function timelineAssetPaths(tl: Timeline | undefined, into: Set<string>): void {
  if (!tl) return;
  for (const c of tl.clips ?? []) {
    if (isFilePath(c.path)) into.add(c.path);
    if (isFilePath(c.content?.url)) into.add(c.content.url);
  }
  for (const t of tl.trackingTakes ?? []) if (isFilePath(t.path)) into.add(t.path);
  for (const c of tl.audio?.clips ?? []) if (isFilePath(c.path)) into.add(c.path);
}

function sceneAssetPaths(sc: Scene, into: Set<string>): void {
  for (const s of sc.surfaces ?? []) if (isFilePath(s.content?.url)) into.add(s.content.url);
  for (const m of sc.scene3D?.models ?? []) if (isFilePath(m.path)) into.add(m.path);
  timelineAssetPaths(sc.timeline, into);
}

/** Public entry: normalizes first, because a peeked document is raw (see normalizeSource). */
export function closureOf(raw: ImportableDoc, sel: ImportSelection): Closure {
  return closureOfNormalized(normalizeSource(raw), sel);
}

/** The real body. Assumes `doc` has already been through normalizeSource. */
function closureOfNormalized(doc: ImportableDoc, sel: ImportSelection): Closure {
  const c: Closure = {
    stateMachine: false,                 // decided below, once the carried states are known
    stateIds: new Set(),
    sceneIds: new Set(), bankIds: new Set(), cueIds: new Set(), groupIds: new Set(),
    poseIds: new Set(), zoneIds: new Set(), surfaceIds: new Set(), fixtureIds: new Set(),
    assetPaths: new Set(),
  };

  for (const id of sel.sceneIds ?? []) c.sceneIds.add(id);
  for (const id of sel.cueBankIds ?? []) c.bankIds.add(id);
  for (const id of sel.poseIds ?? []) c.poseIds.add(id);

  // The state machine drags scenes (its whole reason for existing), cues, and any zone a trigger
  // watches. A state with no sceneId is a legitimate bare node and drags nothing.
  if (doc.stateMachine) {
    const sm = doc.stateMachine;
    // Ticking the whole graph is the same thing as ticking every state in it, so there is one rule
    // below rather than two code paths that could disagree about what a state drags.
    if (sel.stateMachine) for (const st of sm.states ?? []) c.stateIds.add(st.id);
    for (const id of sel.stateIds ?? []) if ((sm.states ?? []).some((st) => st.id === id)) c.stateIds.add(id);
    c.stateMachine = c.stateIds.size > 0;

    for (const st of sm.states ?? []) {
      if (!c.stateIds.has(st.id)) continue;
      if (st.sceneId) c.sceneIds.add(st.sceneId);
      for (const a of st.entry ?? []) {
        if (a.sceneId) c.sceneIds.add(a.sceneId);
        if (a.cueId) c.cueIds.add(a.cueId);
      }
    }
    // Only the zones a SURVIVING transition watches. A transition that will not be carried must not
    // drag the room along with it.
    for (const tr of sm.transitions ?? []) {
      if (!carriesTransition(tr, c.stateIds)) continue;
      for (const z of zonesOfTrigger(tr.trigger)) c.zoneIds.add(z);
    }
  }

  // A carried cue lives in a bank; carrying the cue without its bank would put it nowhere. And a
  // carried bank carries all of its cues.
  const banks = doc.cueBanks ?? [];
  for (const b of banks) {
    if (c.bankIds.has(b.id)) for (const q of b.cues ?? []) c.cueIds.add(q.id);
    else if ((b.cues ?? []).some((q) => c.cueIds.has(q.id))) c.bankIds.add(b.id);
  }
  // A carried bank's row 0 names scenes.
  for (const b of banks) {
    if (!c.bankIds.has(b.id)) continue;
    for (const cell of b.sceneCells ?? []) if (cell.sceneId) c.sceneIds.add(cell.sceneId);
  }

  // Scenes: their looks name project-scope surfaces and fixtures, their timelines name groups, poses
  // and media, and their scene3D subscribes to zones.
  const scenes = (doc.scenes ?? []).filter((s) => c.sceneIds.has(s.id));
  for (const sc of scenes) {
    for (const s of sc.surfaces ?? []) c.surfaceIds.add(s.id);
    for (const f of sc.fixtures ?? []) {
      c.fixtureIds.add(f.id);
      if (f.surfaceId) c.surfaceIds.add(f.surfaceId);
    }
    for (const z of sc.scene3D?.activeZoneIds ?? []) c.zoneIds.add(z);
    for (const cl of sc.timeline?.clips ?? []) {
      if (cl.lighting?.groupId) c.groupIds.add(cl.lighting.groupId);
    }
    for (const seq of sc.timeline?.lightingSequences ?? []) {
      for (const k of seq.keys ?? []) if (k.poseRef) c.poseIds.add(k.poseRef);
    }
    sceneAssetPaths(sc, c.assetPaths);
  }

  // Carried cues name poses and groups too.
  for (const b of banks) {
    for (const q of b.cues ?? []) {
      if (!c.cueIds.has(q.id)) continue;
      for (const l of q.lighting ?? []) {
        if (l.poseId) c.poseIds.add(l.poseId);
        if (l.groupId) c.groupIds.add(l.groupId);
      }
    }
  }

  // A carried group names fixtures — and ORDER IS THE SHOW (it is the phase-spread axis), so the
  // group's own id list is the authority, never a filter over `fixtures`.
  for (const g of doc.groups ?? []) {
    if (!c.groupIds.has(g.id)) continue;
    for (const fid of g.fixtureIds ?? []) c.fixtureIds.add(fid);
  }
  // …and a carried fixture needs the surface it samples from.
  for (const f of doc.fixtures ?? []) {
    if (c.fixtureIds.has(f.id) && f.surfaceId) c.surfaceIds.add(f.surfaceId);
  }
  // Project-level surfaces that were carried also carry their own media.
  for (const s of doc.surfaces ?? []) {
    if (c.surfaceIds.has(s.id) && isFilePath(s.content?.url)) c.assetPaths.add(s.content.url);
  }

  return c;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// PLAN — re-mint, rebind, and report
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * How a carried look meets the destination's rig.
 *
 * `append` — the source's surfaces and fixtures come too, with fresh ids, added AFTER the existing rig
 *   so nothing already patched changes address. Always self-consistent; grows the rig.
 * `map` — the look is rebound onto the rig that is already here and no rig objects are carried at all.
 *   Keeps the rig clean, but anything with no counterpart has nowhere to land.
 */
export type RigStrategy = 'append' | 'map';

/** One source rig object and what it was matched to, or null when nothing here corresponds. */
export interface RigMatchRow {
  srcId: string;
  srcName: string;
  destId: string | null;
  /** How it was matched — by name, or by position within a compatible group. */
  how: 'name' | 'order' | null;
}

export interface RigCorrespondence {
  fixtures: RigMatchRow[];
  surfaces: RigMatchRow[];
}

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase();

/**
 * Pair the source rig against the destination's, for `rig: 'map'`.
 *
 * Two passes, in this order and no other:
 *
 *  1. **By name.** An operator who calls a head "SL Wash 3" in both projects means the same head. This
 *     is the only signal that carries intent, so it wins outright.
 *  2. **By order, within a compatible bucket.** Whatever is left is paired positionally against
 *     destination fixtures of the same `profileId` and `ledCount` — a 6-head bar of identical movers
 *     named "Head 1..6" over there and "Mover 1..6" here is the ordinary case. Bucketing on the
 *     footprint is what stops a 60-LED strip being paired with a moving head just because both were
 *     third in their list.
 *
 * Each destination object is claimed at most once. Anything left unpaired comes back with
 * `destId: null` — REPORTED, and the caller drops its look rather than importing a reference to a
 * fixture that is not here.
 */
export function matchRig(
  srcSurfaces: Surface[], srcFixtures: Fixture[], dest: ImportableDoc,
): RigCorrespondence {
  const pair = <T extends { id: string; name: string }>(
    from: T[], to: T[], bucket: (x: T) => string,
  ): RigMatchRow[] => {
    const claimed = new Set<string>();
    const rows: RigMatchRow[] = from.map((s) => ({ srcId: s.id, srcName: s.name, destId: null, how: null }));

    // Pass 1 — name.
    rows.forEach((row, i) => {
      const hit = to.find((d) => !claimed.has(d.id) && norm(d.name) === norm(from[i].name));
      if (hit) { row.destId = hit.id; row.how = 'name'; claimed.add(hit.id); }
    });

    // Pass 2 — order within a bucket, over what is still unpaired on both sides.
    const freeBy = new Map<string, T[]>();
    for (const d of to) {
      if (claimed.has(d.id)) continue;
      const k = bucket(d);
      const list = freeBy.get(k) ?? [];
      list.push(d);
      freeBy.set(k, list);
    }
    rows.forEach((row, i) => {
      if (row.destId) return;
      const list = freeBy.get(bucket(from[i]));
      const hit = list?.shift();
      if (hit) { row.destId = hit.id; row.how = 'order'; claimed.add(hit.id); }
    });

    return rows;
  };

  return {
    // A surface has no footprint to bucket on, so order is over the whole remaining set.
    surfaces: pair(srcSurfaces, dest.surfaces ?? [], () => ''),
    fixtures: pair(srcFixtures, dest.fixtures ?? [], (f) => `${(f as Fixture).profileId ?? ''}|${(f as Fixture).ledCount ?? 0}`),
  };
}

export interface ImportOptions {
  rig?: RigStrategy;
  mint?: Mint;
}

export type WarningKind = 'renamed' | 'dropped' | 'cleared' | 'note';

export interface ImportWarning {
  kind: WarningKind;
  /** Operator-facing, one line, and specific enough to act on. */
  message: string;
}

/** Objects to APPEND to the open document. Nothing here replaces anything. */
export interface ImportPatch {
  scenes: Scene[];
  cueBanks: CueBank[];
  states: SmState[];
  transitions: SmTransition[];
  regions: SmRegion[];
  surfaces: Surface[];
  fixtures: Fixture[];
  groups: FixtureGroup[];
  lightingPoses: NamedPose[];
  trackingZones: TrackingZone[];
  fixtureProfiles: FixtureProfile[];
  /**
   * The source graph's initial state, remapped — or null when it had none / was not carried.
   *
   * Offered, not imposed: the caller applies it ONLY when the destination has no initial state of its
   * own. Importing a graph into an empty project otherwise produces a machine that can never start,
   * and the FSM would say nothing about it (it simply never enters anything).
   */
  initialStateId: string | null;
}

export interface ImportPlan {
  patch: ImportPatch;
  /** Absolute source paths to copy into the destination project (P2 does the copying). */
  assetPaths: string[];
  /**
   * How the source rig paired with this one, for `rig: 'map'` — null under 'append', which carries
   * the rig instead of matching it. The UI shows the unmatched rows BEFORE committing, because a
   * look with nowhere to land is the one loss an operator has to agree to.
   */
  rig: RigCorrespondence | null;
  warnings: ImportWarning[];
}

const emptyPatch = (): ImportPatch => ({
  scenes: [], cueBanks: [], states: [], transitions: [], regions: [],
  surfaces: [], fixtures: [], groups: [], lightingPoses: [], trackingZones: [],
  fixtureProfiles: [],
  initialStateId: null,
});

/**
 * A name unique against `existing`. Untouched when it does not collide — an import that renamed
 * everything on principle would be its own kind of noise.
 */
function uniqueName(name: string, existing: readonly { name?: string }[]): string {
  const want = (name ?? '').trim();
  if (!existing.some((e) => (e.name ?? '').trim() === want)) return name;
  return nextNumberedName(nameStem(want), existing);
}

/**
 * Rewrite one {path, value} entry's owner id. Returns null when the owner was not carried — the
 * caller DROPS the entry and warns, because an entry addressing a fixture that is not here is not a
 * smaller cue, it is a cue that silently does less than it says.
 */
function remapEntryPath(path: string, maps: Maps, locals: Locals | null): string | null {
  const owner = pathOwner(path);
  if (!owner) return path;                       // globalBrightness, audio.master.* — nothing to rewrite
  const table =
    owner.ns === 'surface' ? maps.surface
      : owner.ns === 'fixture' ? maps.fixture
        : owner.ns === 'audioClip' ? locals?.audioClip
          : locals?.audioTrack;
  const next = table?.get(owner.id);
  return next ? withPathOwner(path, next) : null;
}

/** Remap a timeline in full, returning it plus the local maps its owners need. */
function remapTimeline(
  tl: Timeline, maps: Maps, mint: Mint, warn: (w: ImportWarning) => void, where: string,
): { timeline: Timeline; locals: Locals } {
  const L = emptyLocals();

  // Allocate first, so a clip can point at a layer declared after it.
  for (const l of tl.layers ?? []) alloc(L.layer, l.id, mint);
  for (const c of tl.clips ?? []) alloc(L.clip, c.id, mint);
  for (const m of tl.markers ?? []) alloc(L.marker, m.id, mint);
  for (const t of tl.trackingTakes ?? []) alloc(L.trackingTake, t.id, mint);
  for (const t of tl.lightingTakes ?? []) alloc(L.lightingTake, t.id, mint);
  for (const s of tl.lightingSequences ?? []) alloc(L.sequence, s.id, mint);
  for (const t of tl.audio?.tracks ?? []) alloc(L.audioTrack, t.id, mint);
  for (const c of tl.audio?.clips ?? []) alloc(L.audioClip, c.id, mint);

  const layers: VideoLayer[] = (tl.layers ?? []).map((l) => ({ ...l, id: L.layer.get(l.id)! }));

  const clips: VideoClip[] = (tl.clips ?? []).map((c) => {
    const next: VideoClip = { ...c, id: L.clip.get(c.id)!, layerId: L.layer.get(c.layerId) ?? c.layerId };
    if (c.takeId) next.takeId = L.trackingTake.get(c.takeId) ?? c.takeId;
    if (c.lighting) {
      const lg = { ...c.lighting };
      if (lg.takeId) lg.takeId = L.lightingTake.get(lg.takeId) ?? lg.takeId;
      if (lg.sequenceId) lg.sequenceId = L.sequence.get(lg.sequenceId) ?? lg.sequenceId;
      if (lg.groupId) {
        const g = maps.group.get(lg.groupId);
        if (g) lg.groupId = g;
        else {
          // A lighting clip whose group is missing "stays on the timeline, reads as correctly
          // configured, and drives nothing" — the exact failure the group doctrine warns about.
          delete lg.groupId;
          warn({ kind: 'cleared', message: `${where}: lighting clip "${c.name}" lost its group — the group was not imported, so it would drive nothing.` });
        }
      }
      next.lighting = lg;
    }
    // A clip's generalized content can name a layer of THIS timeline (LAYER/PROGRAM sources).
    if (c.content) {
      const content = { ...c.content };
      if (content.layerId) content.layerId = L.layer.get(content.layerId) ?? content.layerId;
      if (content.bgLayerId) content.bgLayerId = L.layer.get(content.bgLayerId) ?? content.bgLayerId;
      next.content = content;
    }
    return next;
  });

  const markers: Marker[] = (tl.markers ?? []).map((m) => ({ ...m, id: L.marker.get(m.id)! }));
  const trackingTakes: TrackingTakeRef[] = (tl.trackingTakes ?? []).map((t) => ({ ...t, id: L.trackingTake.get(t.id)! }));
  const lightingTakes: LightingTake[] = (tl.lightingTakes ?? []).map((t) => ({ ...t, id: L.lightingTake.get(t.id)! }));

  const lightingSequences: LightingSequence[] = (tl.lightingSequences ?? []).map((s) => ({
    ...s,
    id: L.sequence.get(s.id)!,
    keys: (s.keys ?? []).map((k) => {
      if (!k.poseRef) return k;
      const p = maps.pose.get(k.poseRef);
      if (p) return { ...k, poseRef: p };
      const { poseRef: _dropped, ...rest } = k;
      warn({ kind: 'cleared', message: `${where}: a pose key in sequence "${s.name}" lost its stored pose — the pose was not imported.` });
      return rest;
    }),
  }));

  // AUDIO TRACKS LOSE THEIR BUS, and that is the correct outcome rather than an omission.
  //
  // `AudioTrack.busId` names an `AudioBus` in the PROJECT-GLOBAL mix (ProjectData.audio) — the bed,
  // which this import does not carry (see the singletons note at the top). Buses are minted with
  // random ids and a project starts with none, so a source bus id will essentially never exist here.
  // Carrying it would leave the track routed to nothing; dropping it falls back to the master, which
  // is `busId`'s documented default and is at least audible. Reported, never silent.
  let lostBus = 0;
  const audioTracks: AudioTrack[] = (tl.audio?.tracks ?? []).map((t) => {
    const next: AudioTrack = { ...t, id: L.audioTrack.get(t.id)! };
    if (t.busId) { delete next.busId; lostBus++; }
    return next;
  });
  if (lostBus) {
    warn({ kind: 'cleared', message: `${where}: ${lostBus} audio ${lostBus === 1 ? 'track was' : 'tracks were'} routed to a bus in the source project's mix, which is not imported — ${lostBus === 1 ? 'it now plays' : 'they now play'} through the master.` });
  }
  const audioClips: AudioClip[] = (tl.audio?.clips ?? []).map((c) => ({
    ...c, id: L.audioClip.get(c.id)!, trackId: L.audioTrack.get(c.trackId) ?? c.trackId,
  }));

  const automation: AutomationLane[] = [];
  for (const lane of tl.automation ?? []) {
    const path = remapEntryPath(lane.targetPath, maps, L);
    if (path === null) {
      warn({ kind: 'dropped', message: `${where}: automation lane "${lane.targetPath}" was dropped — the object it drives was not imported.` });
      continue;
    }
    automation.push({ ...lane, id: mint(), targetPath: path });
  }

  return {
    timeline: {
      ...tl, layers, clips, markers, trackingTakes, lightingTakes, lightingSequences, automation,
      audio: { tracks: audioTracks, clips: audioClips },
    },
    locals: L,
  };
}

/** Remap a surface. `layers` is the layer map of the timeline this surface is bound to. */
// ── ID-BEARING FIELDS THIS IMPORTER DELIBERATELY DOES NOT REMAP ─────────────────────────────────
//
// The invariant that guards this file asks only that every `*Id` / `*Ids` field declared in a
// persisted shape be MENTIONED here, so the decision is made once and written down rather than
// rediscovered as a silent dangling reference. These five are named for that reason. They surfaced
// together when the guard was widened to scan `shared/protocol.ts` as well as `renderer/types.ts` —
// persisted shapes live in both, and everything declared in protocol.ts had been invisible to it.
//
//   · docId          — a documentation search-index key ("<docId>#<heading>"). Not project data.
//   · pluginId       — on a renderer-fault record, naming the plugin whose render threw. Not project
//                      data; it is telemetry about this session.
//   · rigIds         — inside ProjectorBlend → ProjectorCalibration → ProjectorOutput. Projector
//                      outputs are THE BUILDING, NOT THE SHOW: this importer does not carry them at
//                      all (a scene's copy is deleted outright, below), so there is nothing to
//                      re-point. A blend is only meaningful for the rig it was solved on anyway.
//   · sourceSurfaceId, sliceIds — inside OutputSpan (ProjectData.outputSpans): authoring metadata
//                      recording how one surface was cut into SLICE surfaces for several projectors.
//                      Also not carried, for the same reason — the cut describes this room's screens.
//   · bakes[].surfaceId — pre-rendered surfaces (ProjectData.bakes). NOT CARRIED, and this one is a
//                      deliberate scope decision rather than a category judgement: carrying them means
//                      growing ImportPatch and its three consumers, and the degradation without it is
//                      safe — an imported surface simply plays its live content, which is correct, just
//                      slower, and re-rendering is one action. Carrying a bake WITHOUT remapping would
//                      not be safe (a stale surfaceId still resolves, against the source project), so
//                      the choice is carry-and-remap or neither. When it is worth doing: mint
//                      `bakes` on ImportPatch, fill it in the 'append' branch beside surfaces, and
//                      re-point `surfaceId` through `maps.surface`, dropping any whose surface did not
//                      come across.
//
// If any of these ever DOES start travelling, it needs a real remap here and this note must go.

function remapSurface(s: Surface, maps: Maps, layers: Map<string, string> | null,
  warn: (w: ImportWarning) => void, where: string): Surface {
  const content = { ...s.content };
  // A LAYER/PROGRAM surface names a layer of its BOUND document. With no bound timeline carried
  // (a project-level surface, whose layers live on the global timeline this import does not take),
  // the reference cannot resolve — so clear it rather than ship a dangling id that renders nothing
  // while reading as configured.
  for (const key of ['layerId', 'bgLayerId'] as const) {
    const v = content[key];
    if (!v) continue;
    const next = layers?.get(v);
    if (next) content[key] = next;
    else {
      delete content[key];
      warn({ kind: 'cleared', message: `${where}: surface "${s.name}" referenced a timeline track that was not imported; its content was cleared.` });
    }
  }
  // A STACK names several tracks (SurfaceContent.layerIds). Each is re-minted like `layerId`; any that
  // did not come across is DROPPED rather than carried, because a carried id still resolves — against
  // the SOURCE project — and would composite a track from another show, or silently nothing.
  // Falling back below two leaves an ordinary single-track binding, which is the honest result.
  if (content.layerIds?.length) {
    const kept = content.layerIds.map((v) => layers?.get(v)).filter((v): v is string => !!v);
    if (kept.length !== content.layerIds.length) {
      warn({ kind: 'cleared', message: `${where}: surface "${s.name}" stacked ${content.layerIds.length} timeline tracks but ${content.layerIds.length - kept.length} were not imported; the rest were kept.` });
    }
    if (kept.length > 1) { content.layerIds = kept; content.layerId = kept[0]; }
    else { delete content.layerIds; if (kept.length === 1) content.layerId = kept[0]; }
  }
  // A SLICE names the surface it was cut from. Cleared rather than kept when that surface has no
  // counterpart here, for the same reason as everything else: a stale id is a reference into the
  // other project that nothing will ever report.
  if (content.sliceOf) {
    const s = maps.surface.get(content.sliceOf);
    if (s) content.sliceOf = s; else delete content.sliceOf;
  }
  // `shaderId` names a BUILT-IN shader, not an object in the document — the same category as
  // `effectId` / `paletteId`, which are indices into EFFECT_NAMES / PALETTE_NAMES. Build-coupled,
  // not project-coupled, so all three carry across unchanged. (`shaderSource` / `shaderGraph` are
  // the operator's own GLSL, inline in the content, and travel with it by value.)
  // A browser deviceId is salted per machine and per origin — it identifies nothing on the
  // destination, so carrying it would bind the surface to a camera that cannot exist.
  if (content.cameraDeviceId) delete content.cameraDeviceId;
  return { ...s, id: maps.surface.get(s.id) ?? s.id, content };
}

function remapFixture(f: Fixture, maps: Maps): Fixture {
  const next: Fixture = {
    ...f,
    id: maps.fixture.get(f.id) ?? f.id,
    // The live DMX frame, not authored state — the same field a Scene snapshot strips.
    colorData: [],
  };
  // Under 'append' every carried surface is mapped, so this always resolves. Under 'map' a surface
  // with no counterpart here leaves the fixture UNBOUND rather than pointing at a surface that does
  // not exist — `surfaceId` is one of the fields a recall writes back, so a stale one would aim a
  // real fixture at nothing on every GO. The unmatched surfaces are named once, in the report.
  if (f.surfaceId) {
    const s = maps.surface.get(f.surfaceId);
    if (s) next.surfaceId = s; else delete next.surfaceId;
  }
  // Controllers are the BUILDING, not the show: they never travel, so a carried fixture is
  // unassigned and auto-patch's `controllers[0]` fallback places it on arrival.
  delete next.controllerId;
  // ⚠ profileId is NOT re-minted. A FixtureProfile is library data resolved THIS → userData →
  // bundled; a fresh id would resolve to nothing and a fixture with no resolvable profile has no
  // known footprint, which silently shifts the patch of everything after it on that controller.
  return next;
}

function remapScene3D(s3: Scene3D, maps: Maps, layers: Map<string, string> | null,
  warn: (w: ImportWarning) => void, where: string): Scene3D {
  const models: SceneModel[] = (s3.models ?? []).map((m) => {
    const next: SceneModel = { ...m, id: maps.model.get(m.id) ?? m.id };
    if (m.layerId) {
      const l = layers?.get(m.layerId);
      if (l) next.layerId = l;
      else {
        delete next.layerId;
        warn({ kind: 'cleared', message: `${where}: model "${m.name}" referenced a timeline track that was not imported.` });
      }
    }
    // Both of these are Surface ids — uvProjFrom holds a ProjectorOutput's surfaceId — so both map in
    // that namespace, and both are CLEARED rather than left pointing into the source project when the
    // surface has no counterpart here.
    if (m.surfaceId) {
      const s = maps.surface.get(m.surfaceId);
      if (s) next.surfaceId = s; else delete next.surfaceId;
    }
    if (m.uvProjFrom) {
      const s = maps.surface.get(m.uvProjFrom);
      if (s) next.uvProjFrom = s; else delete next.uvProjFrom;
    }
    return next;
  });

  const next: Scene3D = { ...s3, models };
  // VENUE, NOT SHOW — the same doctrine these fields already carry in shared/protocol.ts: they
  // describe THIS room, and moving the show to another venue must not carry them along.
  delete next.camMask;
  delete next.markerMap;
  delete next.calibRig;
  delete next.viewFrom;
  // The room's zones are project scope and are carried separately (patch.trackingZones); a scene
  // snapshot must never bring its own copy of them.
  delete next.trackingZones;
  if (s3.activeZoneIds) {
    const kept: string[] = [];
    for (const z of s3.activeZoneIds) {
      const n = maps.zone.get(z);
      if (n) kept.push(n);
    }
    // ⚠ ABSENT means "every zone is live"; an EMPTY ARRAY means "listens to nothing". Turning a
    // subscription that lost its zones into `[]` would silently deafen the scene, so drop the field.
    if (kept.length) next.activeZoneIds = kept;
    else delete next.activeZoneIds;
  }
  return next;
}

/**
 * Build the plan. Pure: `dest` is read for name collisions only and is never mutated.
 */
export function planImport(
  rawSrc: ImportableDoc, dest: ImportableDoc, sel: ImportSelection, opts: ImportOptions = {},
): ImportPlan {
  // Normalize ONCE, here, and use the normalized document everywhere below — including for the
  // closure, so the two passes can never disagree about what the source contains.
  const src = normalizeSource(rawSrc);
  const mint = opts.mint ?? defaultMint;
  const maps = emptyMaps();
  const warnings: ImportWarning[] = [];
  const warn = (w: ImportWarning) => warnings.push(w);
  const patch = emptyPatch();
  const closure = closureOfNormalized(src, sel);

  const strategy: RigStrategy = opts.rig ?? 'append';

  // ── Allocate every project-scope id up front ────────────────────────────────────────────────────
  // Two passes are unavoidable: a scene's look names surfaces and fixtures, a state names a scene, a
  // cue names a pose. Allocating first means no remap step ever has to care about ordering.
  // The rig is the one part whose ids depend on the strategy.
  //
  // 'append' mints a fresh id for every carried surface and fixture, so every reference resolves by
  // construction. 'map' seeds the SAME two maps with ids that already exist here — so every remap
  // below is unchanged and simply lands on the destination's own rig — and deliberately leaves the
  // unmatched ones UNMAPPED, which is what makes the existing drop-and-warn paths fire for them.
  let rig: RigCorrespondence | null = null;
  if (strategy === 'map') {
    // Only what the selection actually reaches. A scene's look carries whole Fixture objects, so the
    // candidates are the union of the project arrays and every carried snapshot.
    const wantSurfaces = new Map<string, Surface>();
    const wantFixtures = new Map<string, Fixture>();
    for (const s of src.surfaces ?? []) if (closure.surfaceIds.has(s.id)) wantSurfaces.set(s.id, s);
    for (const f of src.fixtures ?? []) if (closure.fixtureIds.has(f.id)) wantFixtures.set(f.id, f);
    for (const sc of src.scenes ?? []) {
      if (!closure.sceneIds.has(sc.id)) continue;
      for (const s of sc.surfaces ?? []) if (!wantSurfaces.has(s.id)) wantSurfaces.set(s.id, s);
      for (const f of sc.fixtures ?? []) if (!wantFixtures.has(f.id)) wantFixtures.set(f.id, f);
    }
    rig = matchRig([...wantSurfaces.values()], [...wantFixtures.values()], dest);
    for (const r of rig.surfaces) if (r.destId) maps.surface.set(r.srcId, r.destId);
    for (const r of rig.fixtures) if (r.destId) maps.fixture.set(r.srcId, r.destId);

    const lostF = rig.fixtures.filter((r) => !r.destId);
    const lostS = rig.surfaces.filter((r) => !r.destId);
    if (lostF.length) {
      warn({ kind: 'dropped', message: `${lostF.length} of ${rig.fixtures.length} fixtures have no counterpart here — ${lostF.map((r) => r.srcName).join(', ')}. Their looks are not imported.` });
    }
    if (lostS.length) {
      warn({ kind: 'dropped', message: `${lostS.length} of ${rig.surfaces.length} surfaces have no counterpart here — ${lostS.map((r) => r.srcName).join(', ')}. Their content is not imported.` });
    }
  } else {
    for (const s of src.surfaces ?? []) if (closure.surfaceIds.has(s.id)) alloc(maps.surface, s.id, mint);
    for (const f of src.fixtures ?? []) if (closure.fixtureIds.has(f.id)) alloc(maps.fixture, f.id, mint);
  }
  for (const g of src.groups ?? []) if (closure.groupIds.has(g.id)) alloc(maps.group, g.id, mint);
  for (const p of src.lightingPoses ?? []) if (closure.poseIds.has(p.id)) alloc(maps.pose, p.id, mint);
  for (const z of src.scene3D?.trackingZones ?? []) if (closure.zoneIds.has(z.id)) alloc(maps.zone, z.id, mint);
  for (const sc of src.scenes ?? []) {
    if (!closure.sceneIds.has(sc.id)) continue;
    alloc(maps.scene, sc.id, mint);
    // A scene's look holds whole Surface/Fixture objects with the SAME ids as the project arrays,
    // so under 'append' any id the project arrays did not supply still needs one.
    //
    // ⚠ NOT under 'map'. There the maps are the correspondence, and minting here would hand an
    // unmatched fixture a brand-new id — which reads as "matched" to every remap below and would
    // import a look for a fixture that does not exist here, silently. Leaving it unmapped is what
    // makes it get dropped and reported.
    if (strategy === 'append') {
      for (const s of sc.surfaces ?? []) alloc(maps.surface, s.id, mint);
      for (const f of sc.fixtures ?? []) alloc(maps.fixture, f.id, mint);
    }
    for (const m of sc.scene3D?.models ?? []) alloc(maps.model, m.id, mint);
  }
  for (const b of src.cueBanks ?? []) {
    if (!closure.bankIds.has(b.id)) continue;
    alloc(maps.bank, b.id, mint);
    for (const q of b.cues ?? []) if (closure.cueIds.has(q.id)) alloc(maps.cue, q.id, mint);
  }
  if (closure.stateMachine && src.stateMachine) {
    // Only the states the selection actually carries, and only the transitions both of whose ends
    // are among them — allocating an id for a transition that will not be carried would leave a
    // mapped-but-absent edge, which is the shape every drop-and-warn branch below tests for.
    for (const st of src.stateMachine.states ?? []) {
      if (closure.stateIds.has(st.id)) alloc(maps.state, st.id, mint);
    }
    for (const tr of src.stateMachine.transitions ?? []) {
      if (carriesTransition(tr, closure.stateIds)) alloc(maps.transition, tr.id, mint);
    }
    // A region is scenery for the states inside it: carried only when it still contains one.
    const liveRegions = new Set(
      (src.stateMachine.states ?? [])
        .filter((st) => closure.stateIds.has(st.id))
        .map((st) => st.regionId)
        .filter((r): r is string => !!r),
    );
    for (const rg of src.stateMachine.regions ?? []) {
      if (liveRegions.has(rg.id)) alloc(maps.region, rg.id, mint);
    }
  }

  // ── Zones ───────────────────────────────────────────────────────────────────────────────────────
  // TrackingZone.surface is 'SOL' | 'MUR' | 'SOL_MUR' — a trackingStore surface KEY, not a Surface
  // id. It is carried verbatim; remapping it would point the zone at nothing.
  for (const z of src.scene3D?.trackingZones ?? []) {
    if (!closure.zoneIds.has(z.id)) continue;
    patch.trackingZones.push({
      ...z,
      id: maps.zone.get(z.id)!,
      name: uniqueName(z.name, [...(dest.scene3D?.trackingZones ?? []), ...patch.trackingZones]),
    });
  }

  // ── Poses and groups ────────────────────────────────────────────────────────────────────────────
  for (const p of src.lightingPoses ?? []) {
    if (!closure.poseIds.has(p.id)) continue;
    patch.lightingPoses.push({
      ...p,
      id: maps.pose.get(p.id)!,
      name: uniqueName(p.name, [...(dest.lightingPoses ?? []), ...patch.lightingPoses]),
    });
  }
  for (const g of src.groups ?? []) {
    if (!closure.groupIds.has(g.id)) continue;
    // ORDER IS THE SPREAD AXIS — map THROUGH the id list, never filter `fixtures`, or the phase
    // spread silently re-sorts into fixture-list order.
    const fixtureIds: string[] = [];
    for (const fid of g.fixtureIds ?? []) {
      const n = maps.fixture.get(fid);
      if (n) fixtureIds.push(n);
    }
    if (fixtureIds.length !== (g.fixtureIds ?? []).length) {
      warn({ kind: 'dropped', message: `Group "${g.name}": ${(g.fixtureIds ?? []).length - fixtureIds.length} of ${(g.fixtureIds ?? []).length} fixtures were not imported and were removed from it.` });
    }
    patch.groups.push({
      ...g,
      id: maps.group.get(g.id)!,
      name: uniqueName(g.name, [...(dest.groups ?? []), ...patch.groups]),
      fixtureIds,
    });
  }

  // ── Project-level rig ───────────────────────────────────────────────────────────────────────────
  // Only 'append' carries rig objects. 'map' adds none at all — the whole point is that the rig
  // already here is the rig.
  //
  // Appended, never inserted: fixture array order drives the auto-patch cursors AND the canonical
  // pixel buffer offset walk, so anything already patched must keep its position.
  if (strategy === 'append') {
    for (const s of src.surfaces ?? []) {
      if (!closure.surfaceIds.has(s.id)) continue;
      const next = remapSurface(s, maps, null, warn, 'Rig');
      patch.surfaces.push({ ...next, name: uniqueName(s.name, [...(dest.surfaces ?? []), ...patch.surfaces]) });
    }
    for (const f of src.fixtures ?? []) {
      if (!closure.fixtureIds.has(f.id)) continue;
      const next = remapFixture(f, maps);
      patch.fixtures.push({ ...next, name: uniqueName(f.name, [...(dest.fixtures ?? []), ...patch.fixtures]) });
    }
  }
  // Carry the profiles those fixtures reference, by their ORIGINAL ids (see remapFixture).
  const wantProfiles = new Set(patch.fixtures.map((f) => f.profileId).filter((p): p is string => !!p));
  const haveProfiles = new Set((dest.fixtureProfiles ?? []).map((p) => p.id));
  for (const p of src.fixtureProfiles ?? []) {
    if (wantProfiles.has(p.id) && !haveProfiles.has(p.id)) patch.fixtureProfiles.push(p);
  }

  // ── Scenes ──────────────────────────────────────────────────────────────────────────────────────
  // Each scene's timeline is remapped FIRST, because its surfaces and 3D models address that
  // timeline's layers — and its locals are kept so the state machine can resolve markers and layers
  // against the right document.
  const sceneLocals = new Map<string, Locals>();
  for (const sc of src.scenes ?? []) {
    if (!closure.sceneIds.has(sc.id)) continue;
    const name = uniqueName(sc.name, [...(dest.scenes ?? []), ...patch.scenes]);
    if (name !== sc.name) {
      warn({ kind: 'renamed', message: `Scene "${sc.name}" already exists here and was imported as "${name}" — recall falls back to NAME when an id misses, so two identical names would reroute each other.` });
    }
    const where = `Scene "${name}"`;
    const { timeline, locals } = remapTimeline(sc.timeline, maps, mint, warn, where);
    sceneLocals.set(sc.id, locals);

    // A LOOK FOR SOMETHING THAT IS NOT HERE IS DROPPED, NOT CARRIED.
    //
    // Under 'append' every rig object is mapped, so both filters pass everything. Under 'map' an
    // unmatched fixture has no entry, and keeping its snapshot row would put a fixture id in the
    // document that no rig object answers to — inert on recall, invisible in the UI, and exactly the
    // kind of thing nothing downstream would ever report. The correspondence already named it in a
    // warning, once, rather than once per scene.
    const next: Scene = {
      ...sc,
      id: maps.scene.get(sc.id)!,
      name,
      timeline,
      fixtures: (sc.fixtures ?? []).filter((f) => maps.fixture.has(f.id)).map((f) => remapFixture(f, maps)),
    };
    if (sc.surfaces) {
      next.surfaces = sc.surfaces
        .filter((s) => maps.surface.has(s.id))
        .map((s) => remapSurface(s, maps, locals.layer, warn, where));
    }
    if (sc.scene3D) next.scene3D = remapScene3D(sc.scene3D, maps, locals.layer, warn, where);
    // `groups` and `projectorOutputs` are written undefined by buildSceneSnapshot and ignored on
    // recall — dead data in older files. Drop rather than carry a stale copy of project scope.
    delete next.groups;
    delete next.projectorOutputs;
    if (sc.audio) {
      const audio: CueEntry[] = [];
      for (const e of sc.audio) {
        // Scene.audio addresses the BED (audio.master/track/clip) or the look. The bed is a
        // singleton this import does not carry, so a bed-track entry has nothing to land on.
        const path = remapEntryPath(e.path, maps, null);
        if (path === null) {
          warn({ kind: 'dropped', message: `${where}: bound audio parameter "${e.path}" was dropped — it addresses the source project's audio bed, which is not imported.` });
          continue;
        }
        audio.push({ ...e, path });
      }
      if (audio.length) next.audio = audio; else delete next.audio;
    }
    patch.scenes.push(next);
  }

  // ── Cue banks ───────────────────────────────────────────────────────────────────────────────────
  for (const b of src.cueBanks ?? []) {
    if (!closure.bankIds.has(b.id)) continue;
    const bankName = uniqueName(b.name, [...(dest.cueBanks ?? []), ...patch.cueBanks]);
    const cues: Cue[] = [];
    for (const q of b.cues ?? []) {
      if (!closure.cueIds.has(q.id)) continue;
      const entries: CueEntry[] = [];
      for (const e of q.entries ?? []) {
        const path = remapEntryPath(e.path, maps, null);
        if (path === null) {
          warn({ kind: 'dropped', message: `Cue "${q.name}": parameter "${e.path}" was dropped — the object it addresses was not imported.` });
          continue;
        }
        entries.push({ ...e, path });
      }
      const lighting: LightingCueEntry[] = [];
      for (const l of q.lighting ?? []) {
        const poseId = maps.pose.get(l.poseId);
        const groupId = maps.group.get(l.groupId);
        if (!poseId || !groupId) {
          warn({ kind: 'dropped', message: `Cue "${q.name}": a pose entry was dropped — its ${!poseId ? 'pose' : 'group'} was not imported.` });
          continue;
        }
        lighting.push({ ...l, poseId, groupId });
      }
      const next: Cue = {
        ...q,
        id: maps.cue.get(q.id)!,
        name: uniqueName(q.name, cues),
        entries,
      };
      if (lighting.length) next.lighting = lighting; else delete next.lighting;
      cues.push(next);
    }
    const sceneCells: { col: number; sceneId: string }[] = [];
    for (const cell of b.sceneCells ?? []) {
      const sceneId = maps.scene.get(cell.sceneId);
      if (sceneId) sceneCells.push({ ...cell, sceneId });
    }
    patch.cueBanks.push({ ...b, id: maps.bank.get(b.id)!, name: bankName, cues, sceneCells });
  }

  // ── State machine ───────────────────────────────────────────────────────────────────────────────
  if (closure.stateMachine && src.stateMachine) {
    const sm = src.stateMachine;
    // Which scene a state is bound to decides which timeline its markers and layers resolve in.
    const localsForState = new Map<string, Locals | undefined>();
    for (const st of sm.states ?? []) localsForState.set(st.id, st.sceneId ? sceneLocals.get(st.sceneId) : undefined);

    for (const rg of sm.regions ?? []) {
      if (!maps.region.has(rg.id)) continue;      // no carried state lives in it
      patch.regions.push({
        ...rg,
        id: maps.region.get(rg.id)!,
        name: uniqueName(rg.name, [...(dest.stateMachine?.regions ?? []), ...patch.regions]),
      });
    }

    for (const st of sm.states ?? []) {
      if (!closure.stateIds.has(st.id)) continue;
      const L = localsForState.get(st.id);
      const next: SmState = {
        ...st,
        id: maps.state.get(st.id)!,
        name: uniqueName(st.name, [...(dest.stateMachine?.states ?? []), ...patch.states]),
        entry: [],
      };
      if (st.sceneId) {
        const s = maps.scene.get(st.sceneId);
        if (s) next.sceneId = s;
        else {
          delete next.sceneId;
          warn({ kind: 'cleared', message: `State "${st.name}" lost its scene binding — the scene was not imported, so the state would recall nothing.` });
        }
      }
      if (st.regionId) next.regionId = maps.region.get(st.regionId) ?? st.regionId;
      for (const a of st.entry ?? []) {
        const act = { ...a };
        let ok = true;
        if (a.sceneId) { const s = maps.scene.get(a.sceneId); if (s) act.sceneId = s; else ok = false; }
        if (a.cueId) { const q = maps.cue.get(a.cueId); if (q) act.cueId = q; else ok = false; }
        if (a.markerId) { const m = L?.marker.get(a.markerId); if (m) act.markerId = m; else ok = false; }
        if (!ok) {
          warn({ kind: 'dropped', message: `State "${st.name}": a "${a.kind}" entry action was dropped — what it targets was not imported.` });
          continue;
        }
        next.entry.push(act);
      }
      patch.states.push(next);
    }

    let droppedEdges = 0;
    for (const tr of sm.transitions ?? []) {
      const from = maps.state.get(tr.from);
      const to = maps.state.get(tr.to);
      // `fromAny` transitions do not use `from`, so only `to` has to resolve for them.
      if (!to || (!tr.fromAny && !from)) { droppedEdges++; continue; }
      const next: SmTransition = { ...tr, id: maps.transition.get(tr.id)!, from: from ?? tr.from, to };
      const L = localsForState.get(tr.from);
      const trig: SmTrigger = { ...tr.trigger };
      if (trig.markerId) {
        const m = L?.marker.get(trig.markerId);
        if (m) trig.markerId = m;
        else {
          warn({ kind: 'cleared', message: `A "${trig.kind}" trigger lost its marker and was made manual — the marker was not imported.` });
          next.trigger = { kind: 'manual' };
          patch.transitions.push(next);
          continue;
        }
      }
      if (trig.layerId) {
        const l = L?.layer.get(trig.layerId);
        if (l) trig.layerId = l;
        else {
          warn({ kind: 'cleared', message: `A "${trig.kind}" trigger lost its track and was made manual — the track was not imported.` });
          next.trigger = { kind: 'manual' };
          patch.transitions.push(next);
          continue;
        }
      }
      // Plugin triggers carry opaque params; only the zone ids inside are ours to rewrite.
      if (trig.params) {
        const p = { ...(trig.params as Record<string, unknown>) };
        if (typeof p.zoneId === 'string') {
          const z = maps.zone.get(p.zoneId);
          if (z) p.zoneId = z;
        }
        if (Array.isArray(p.terms)) {
          p.terms = (p.terms as { zone?: unknown }[]).map((t) => {
            if (!t || typeof t.zone !== 'string') return t;
            const z = maps.zone.get(t.zone);
            return z ? { ...t, zone: z } : t;
          });
        }
        trig.params = p;
      }
      next.trigger = trig;
      patch.transitions.push(next);
    }

    // Dropped edges are counted and reported ONCE. Taking one state out of a five-state ring drops
    // every edge it touches, and eight identical lines would bury the warnings that name something
    // specific — the report is only useful if an operator reads all of it.
    if (droppedEdges) {
      warn({ kind: 'dropped', message: `${droppedEdges} transition${droppedEdges === 1 ? '' : 's'} led to or from a state that was not imported, and ${droppedEdges === 1 ? 'was' : 'were'} left behind.` });
    }

    // Offered for the caller to use only if the destination has no initial state of its own.
    patch.initialStateId = sm.initialStateId ? maps.state.get(sm.initialStateId) ?? null : null;
  }

  return { patch, assetPaths: [...closure.assetPaths], warnings, rig };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// RE-POINT — after the media has been copied in
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Rewrite every media path in a patch through `remap` (source path → where it now lives).
 *
 * Runs AFTER main has copied the files, because only main knows where each one landed — `uniqueDest`
 * may have reused an identical file already in the destination, or suffixed a same-named but
 * different one. A path with no entry in the map is left exactly as it was: it is either already
 * inside the destination or was deliberately left external, and inventing a path for it would point
 * the show at a file that does not exist.
 *
 * This mirrors main's `mapAssetPaths` (the ONE sanctioned traversal) over the shapes a patch holds —
 * project-level surfaces plus, for each carried scene, its own surfaces, scene3D and timeline. Keep
 * the two in step: a new place a path can hide has to be added to both.
 */
export function applyAssetRemap(patch: ImportPatch, remap: Record<string, string>): ImportPatch {
  const at = (p: string | undefined): string | undefined => (p && remap[p] ? remap[p] : p);

  const surface = (s: Surface): Surface =>
    (s.content?.url && remap[s.content.url]
      ? { ...s, content: { ...s.content, url: remap[s.content.url] } }
      : s);

  const timeline = (tl: Timeline): Timeline => ({
    ...tl,
    clips: (tl.clips ?? []).map((c) => {
      const next: VideoClip = { ...c, path: at(c.path) ?? c.path };
      if (c.content?.url) next.content = { ...c.content, url: at(c.content.url) };
      return next;
    }),
    trackingTakes: (tl.trackingTakes ?? []).map((t) => ({ ...t, path: at(t.path) ?? t.path })),
    audio: {
      tracks: tl.audio?.tracks ?? [],
      clips: (tl.audio?.clips ?? []).map((c) => ({ ...c, path: at(c.path) ?? c.path })),
    },
  });

  return {
    ...patch,
    surfaces: patch.surfaces.map(surface),
    scenes: patch.scenes.map((sc) => {
      const next: Scene = { ...sc, timeline: timeline(sc.timeline) };
      if (sc.surfaces) next.surfaces = sc.surfaces.map(surface);
      if (sc.scene3D) {
        next.scene3D = {
          ...sc.scene3D,
          models: (sc.scene3D.models ?? []).map((m) => ({ ...m, path: at(m.path) ?? m.path })),
        };
      }
      return next;
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// VALIDATE — the pre-commit proof
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

export interface RefProblem {
  /** Where the broken reference lives, in words an operator can act on. */
  where: string;
  /** What it points at that is not there. */
  missing: string;
}

/**
 * Walk every reference edge of a MERGED document and report the ones that resolve to nothing.
 *
 * This exists because the show engine tolerates all of them in silence, by design: a state whose
 * scene is gone recalls nothing and keeps running. Run it on the merged result BEFORE committing.
 */
export function validateReferences(doc: ImportableDoc): RefProblem[] {
  const out: RefProblem[] = [];
  const scenes = new Set((doc.scenes ?? []).map((s) => s.id));
  const groups = new Set((doc.groups ?? []).map((g) => g.id));
  const poses = new Set((doc.lightingPoses ?? []).map((p) => p.id));
  const zones = new Set((doc.scene3D?.trackingZones ?? []).map((z) => z.id));
  const fixtures = new Set((doc.fixtures ?? []).map((f) => f.id));
  const cues = new Set((doc.cueBanks ?? []).flatMap((b) => (b.cues ?? []).map((q) => q.id)));

  const checkTimeline = (tl: Timeline | undefined, where: string) => {
    if (!tl) return;
    const layers = new Set((tl.layers ?? []).map((l) => l.id));
    const tTakes = new Set((tl.trackingTakes ?? []).map((t) => t.id));
    const lTakes = new Set((tl.lightingTakes ?? []).map((t) => t.id));
    const seqs = new Set((tl.lightingSequences ?? []).map((s) => s.id));
    for (const c of tl.clips ?? []) {
      if (!layers.has(c.layerId)) out.push({ where: `${where}: clip "${c.name}"`, missing: `track ${c.layerId}` });
      if (c.takeId && !tTakes.has(c.takeId)) out.push({ where: `${where}: clip "${c.name}"`, missing: `tracking take ${c.takeId}` });
      const lg = c.lighting;
      if (lg?.takeId && !lTakes.has(lg.takeId)) out.push({ where: `${where}: clip "${c.name}"`, missing: `lighting take ${lg.takeId}` });
      if (lg?.sequenceId && !seqs.has(lg.sequenceId)) out.push({ where: `${where}: clip "${c.name}"`, missing: `pose sequence ${lg.sequenceId}` });
      if (lg?.groupId && !groups.has(lg.groupId)) out.push({ where: `${where}: clip "${c.name}"`, missing: `group ${lg.groupId}` });
    }
    for (const s of tl.lightingSequences ?? []) {
      for (const k of s.keys ?? []) {
        if (k.poseRef && !poses.has(k.poseRef)) out.push({ where: `${where}: sequence "${s.name}"`, missing: `pose ${k.poseRef}` });
      }
    }
    const aTracks = new Set((tl.audio?.tracks ?? []).map((t) => t.id));
    for (const c of tl.audio?.clips ?? []) {
      if (!aTracks.has(c.trackId)) out.push({ where: `${where}: audio clip "${c.name}"`, missing: `audio track ${c.trackId}` });
    }
  };

  for (const sc of doc.scenes ?? []) {
    const where = `Scene "${sc.name}"`;
    checkTimeline(sc.timeline, where);
    const surfaces = new Set((sc.surfaces ?? []).map((s) => s.id));
    for (const f of sc.fixtures ?? []) {
      if (f.surfaceId && surfaces.size && !surfaces.has(f.surfaceId)) {
        out.push({ where: `${where}: fixture "${f.name}"`, missing: `surface ${f.surfaceId}` });
      }
    }
    for (const z of sc.scene3D?.activeZoneIds ?? []) {
      if (!zones.has(z)) out.push({ where, missing: `tracking zone ${z}` });
    }
  }

  for (const g of doc.groups ?? []) {
    for (const fid of g.fixtureIds ?? []) {
      if (!fixtures.has(fid)) out.push({ where: `Group "${g.name}"`, missing: `fixture ${fid}` });
    }
  }

  for (const b of doc.cueBanks ?? []) {
    for (const cell of b.sceneCells ?? []) {
      if (!scenes.has(cell.sceneId)) out.push({ where: `Bank "${b.name}" row 0`, missing: `scene ${cell.sceneId}` });
    }
    for (const q of b.cues ?? []) {
      for (const l of q.lighting ?? []) {
        if (!poses.has(l.poseId)) out.push({ where: `Cue "${q.name}"`, missing: `pose ${l.poseId}` });
        if (!groups.has(l.groupId)) out.push({ where: `Cue "${q.name}"`, missing: `group ${l.groupId}` });
      }
    }
  }

  const sm = doc.stateMachine;
  if (sm) {
    const states = new Set((sm.states ?? []).map((s) => s.id));
    const regions = new Set((sm.regions ?? []).map((r) => r.id));
    for (const st of sm.states ?? []) {
      if (st.sceneId && !scenes.has(st.sceneId)) out.push({ where: `State "${st.name}"`, missing: `scene ${st.sceneId}` });
      if (st.regionId && !regions.has(st.regionId)) out.push({ where: `State "${st.name}"`, missing: `region ${st.regionId}` });
      for (const a of st.entry ?? []) {
        if (a.sceneId && !scenes.has(a.sceneId)) out.push({ where: `State "${st.name}" entry`, missing: `scene ${a.sceneId}` });
        if (a.cueId && !cues.has(a.cueId)) out.push({ where: `State "${st.name}" entry`, missing: `cue ${a.cueId}` });
      }
    }
    for (const tr of sm.transitions ?? []) {
      if (!tr.fromAny && !states.has(tr.from)) out.push({ where: 'Transition', missing: `source state ${tr.from}` });
      if (!states.has(tr.to)) out.push({ where: 'Transition', missing: `target state ${tr.to}` });
      for (const z of zonesOfTrigger(tr.trigger)) {
        if (!zones.has(z)) out.push({ where: 'Transition trigger', missing: `tracking zone ${z}` });
      }
    }
    if (sm.initialStateId && !states.has(sm.initialStateId)) {
      out.push({ where: 'State machine', missing: `initial state ${sm.initialStateId}` });
    }
  }

  return out;
}
