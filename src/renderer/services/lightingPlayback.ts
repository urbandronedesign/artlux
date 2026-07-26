import type { Fixture, FixtureGroup, Timeline, VideoClip } from '../types';
import { timeline as engine } from './timeline';
import * as overlay from './lightingOverlay';
import { rolesOf, sampleRole } from './lightingTake';

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
let started = false;
let hadOutput = false;

export function setData(t: Timeline | null): void { data = t; }
export function setRig(f: Fixture[], g: FixtureGroup[]): void { fixtures = f; groups = g; }

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
    return;
  }

  overlay.begin();
  for (const clip of clips) {
    const lighting = clip.lighting!;
    const take = lighting.takeId ? data?.lightingTakes?.find((t) => t.id === lighting.takeId) : undefined;
    if (!take && !lighting.effect) continue;

    const targets = targetsOf(clip);
    if (!targets.length) continue;

    const roles = rolesOf(lighting, take);
    if (!roles.length) continue;

    // Time within the clip, honouring its trim — so sliding a clip moves the look with it.
    const localTime = playhead - clip.start + (clip.inPoint ?? 0);

    for (let i = 0; i < targets.length; i++) {
      const ctx = { clip: lighting, take, localTime, index: i, total: targets.length };
      for (const role of roles) {
        const v = sampleRole(ctx, role);
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
}
