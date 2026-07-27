import type { Fixture, FixtureGroup, NamedPose, Timeline, VideoClip } from '../types';
import { timeline as engine } from './timeline';
import * as overlay from './lightingOverlay';
import { rolesOf, sampleRole } from './lightingTake';
import { compile as compileSequence } from './lightingSequence';

// Replays LIGHTING clips during timeline playback: for every clip under the playhead, work out what
// each fixture of its target group should be doing and publish it to the lighting overlay.
//
// Modelled on the LiDAR take playback (plugins/lidar-tracking/trackingPlayback), including the part
// that matters most: it subscribes to the playhead EVERY FRAME, even while paused, so scrubbing the
// timeline moves the rig. A show is authored by dragging the playhead and watching, not by pressing
// play and hoping.
//
// It is a separate service rather than something inside services/timeline.ts for the same reason
// tracking playback is: the video engine must not couple to the lighting model.

let data: Timeline | null = null;
let fixtures: Fixture[] = [];
let groups: FixtureGroup[] = [];
// The project-level pose library, for keys that reference one instead of inlining slots.
let poses: NamedPose[] = [];
let started = false;
let hadOutput = false;

// ── THE CURSOR POOL ──────────────────────────────────────────────────────────────────────────
//
// `sampleLane` carries a cursor so steady playback costs ~0 steps instead of a binary search per
// fixture per role per frame (forty heads × six roles × 60 fps ≈ 14k searches/second).
//
// KEYED PER (CLIP, FIXTURE, ROLE) — NOT per slot. A take's parts WRAP, so two fixtures can share
// one part while sampling it at DIFFERENT times, because each carries its own `phaseOffset`. A
// cursor shared between them would ping-pong between two positions every frame: still correct
// (seekIdx falls back to a binary search) but silently O(log n) again, which is the kind of
// regression nothing visible would report.
//
// Held across frames deliberately — that is the whole point — and cleared when the clip set changes
// or the transport jumps, since a stale cursor for a different curve is just a cold one.
const cursors = new Map<string, { i: number }>();
let cursorKeys = '';

function cursorFor(clipId: string, fixtureId: string, role: string): { i: number } {
  const key = `${clipId}|${fixtureId}|${role}`;
  let c = cursors.get(key);
  if (!c) { c = { i: -1 }; cursors.set(key, c); }
  return c;
}

export function setData(t: Timeline | null): void { data = t; }
export function setRig(f: Fixture[], g: FixtureGroup[], p: NamedPose[] = poses): void { fixtures = f; groups = g; poses = p; }

/** Every lighting clip covering time `t`. Unlike video, clips LAYER — later ones win per role. */
function activeClips(t: number): VideoClip[] {
  if (!data) return [];
  const out: VideoClip[] = [];
  for (const c of data.clips) {
    if (c.kind !== 'lighting' || !c.lighting) continue;
    if (t >= c.start && t < c.start + c.duration) out.push(c);
  }
  return out;
}

/** The fixtures a clip drives, in the group's own order — which is the spread axis. */
function targetsOf(clip: VideoClip): Fixture[] {
  const groupId = clip.lighting?.groupId;
  if (!groupId) return [];
  const group = groups.find((g) => g.id === groupId);
  if (!group) return [];
  // Mapped through the group's id list rather than filtering `fixtures`, because ORDER IS THE
  // SHOW: filtering would silently re-sort the spread into fixture-list order.
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  return group.fixtureIds.map((id) => byId.get(id)).filter((f): f is Fixture => !!f);
}

function tick(playhead: number): void {
  const clips = activeClips(playhead);

  // Nothing playing: publish one empty frame so the rig RELEASES back to its authored values, then
  // stop writing. Without that trailing empty frame the last pose of a finished clip would stay
  // latched on the overlay forever — the same "stranded value" trap automationOverlay documents.
  if (!clips.length) {
    if (hadOutput) { overlay.begin(); overlay.commit(); hadOutput = false; }
    if (cursors.size) { cursors.clear(); cursorKeys = ''; }
    return;
  }

  // The active clip set changing means the curves behind those cursors changed. Dropping them costs
  // one binary search each; keeping them risks a cursor pointing into a different curve's array.
  const keys = clips.map((c) => c.id).join(',');
  if (keys !== cursorKeys) { cursors.clear(); cursorKeys = keys; }

  overlay.begin();
  for (const clip of clips) {
    const lighting = clip.lighting!;
    const take = lighting.takeId ? data?.lightingTakes?.find((t) => t.id === lighting.takeId) : undefined;
    const seq = lighting.sequenceId
      ? data?.lightingSequences?.find((s) => s.id === lighting.sequenceId) : undefined;
    // Compiled behind a WeakMap on the sequence object, so this is a lookup after the first frame
    // and a recompile only when an edit produced a new object. See services/lightingSequence.
    const sequence = seq ? compileSequence(seq, poses) : undefined;
    // An unresolved id drives NOTHING — never a fallback to another source. A clip whose sequence is
    // missing (a project opened without it) must go quiet, not silently play the take beside it.
    if (!sequence && !take && !lighting.effect) continue;

    const targets = targetsOf(clip);
    if (!targets.length) continue;

    const roles = rolesOf(lighting, take, sequence);
    if (!roles.length) continue;

    // Time within the clip, honouring its trim — so sliding a clip moves the look with it.
    const localTime = playhead - clip.start + (clip.inPoint ?? 0);

    for (let i = 0; i < targets.length; i++) {
      const ctx = { clip: lighting, take, sequence, localTime, index: i, total: targets.length };
      for (const role of roles) {
        const v = sampleRole(ctx, role, cursorFor(clip.id, targets[i].id, role));
        if (v !== undefined) overlay.set(targets[i].id, role, v);
      }
    }
  }
  overlay.commit();
  hadOutput = true;
}

/** Subscribe to the engine playhead. Main window only — call once. */
export function start(): void {
  if (started) return;
  started = true;
  engine.subscribe(tick);
}

export function stop(): void {
  overlay.clear();
  hadOutput = false;
  cursors.clear();
  cursorKeys = '';
}
