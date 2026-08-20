#!/usr/bin/env node
// Re-derive the painted floor pads from a project's own trigger zones, and check the wiring.
//
//   node examples/lidar-tracking/sync-pads.cjs <project.artlux>            # sync + check, writes back
//   node examples/lidar-tracking/sync-pads.cjs <project.artlux> --check    # check only, writes nothing
//
// WHY THIS EXISTS. A trigger zone is a rectangle the SHOW reacts to; a pad is a rectangle a VISITOR
// sees. They are stored in different places and nothing in ArtLux ties them together — no render path
// draws zones (ZonePanel and the 3D TrackingViz are editor-only), so on a projector a pad is just
// content that happens to sit where a zone is. Drag a zone on site and the paint stays where it was:
// the piece still works, still looks deliberate, and now asks people to stand in the wrong place.
//
// So the pads are GENERATED from the zones, here, and this is the only writer.
//
// THE COORDINATE CHAIN, since one flip mirrors the whole piece:
//   tracker  → blobs arrive u,v, BOTTOM-LEFT origin
//   zones    → tested against RAW store u,v (plugins/lidar-tracking/src/zones.ts). Orientation is NOT
//              applied, and ZonePanel does not know flipH/flipV/rotate exist.
//   blobs    → drawn at y = (1-v)·H  ⇒  v = 1 at the top of the tracking canvas
//   bg layer → sampled with a top-left UV origin, no Y flip (blobPass.ts, "Full-screen quad with
//              top-left UV origin")
//   shader   → vUv = aPos*0.5+0.5  ⇒  uv.y = 1 at the top of its canvas
//   ⇒ shader uv.y maps DIRECTLY onto tracker v, so a pad rect is a zone's numbers copied across.
const fs = require('node:fs');

const [, , file, ...flags] = process.argv;
const CHECK_ONLY = flags.includes('--check');
if (!file) {
  console.error('usage: sync-pads.cjs <project.artlux> [--check]');
  process.exit(2);
}

const raw = fs.readFileSync(file, 'utf8');
const proj = JSON.parse(raw);

const ZONE_OF_PAD = { left: 'zn_left', right: 'zn_right', return: 'zn_home' };
const DEFAULT_TINT = { zn_left: [0.96, 0.62, 0.04], zn_right: [0.85, 0.27, 0.94], zn_home: [0.14, 0.83, 0.93] };

const f4 = (n) => Number(n).toFixed(4);
const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

function padShader(zones) {
  const z = (id) => zones.find((x) => x.id === id);
  const rect = (id) => {
    const r = z(id);
    if (!r) return 'vec4(0.0)';
    // Normalize min->max: a zone dragged right-to-left is legal in the store and the occupancy test
    // sorts it, so the paint has to sort it too or it would vanish.
    return `vec4(${f4(Math.min(r.u0, r.u1))}, ${f4(Math.min(r.v0, r.v1))}, ${f4(Math.max(r.u0, r.u1))}, ${f4(Math.max(r.v0, r.v1))})`;
  };
  const col = (id) => {
    const c = (z(id) && hexToRgb(z(id).color)) || DEFAULT_TINT[id] || [1, 1, 1];
    return `vec3(${c.map(f4).join(', ')})`;
  };
  return `/*{
  "TITLE": "Floor pads",
  "CATEGORIES": ["ambient"],
  "INPUTS": [
    { "NAME": "showLeft",   "LABEL": "Left pad",    "TYPE": "bool",  "DEFAULT": true },
    { "NAME": "showRight",  "LABEL": "Right pad",   "TYPE": "bool",  "DEFAULT": true },
    { "NAME": "showReturn", "LABEL": "Return pad",  "TYPE": "bool",  "DEFAULT": false },
    { "NAME": "border",     "LABEL": "Border",      "TYPE": "float", "MIN": 0.002, "MAX": 0.08, "DEFAULT": 0.014 },
    { "NAME": "pulse",      "LABEL": "Pulse rate",  "TYPE": "float", "MIN": 0.0,   "MAX": 3.0,  "DEFAULT": 0.9 },
    { "NAME": "interior",   "LABEL": "Interior",    "TYPE": "float", "MIN": 0.0,   "MAX": 0.6,  "DEFAULT": 0.10 }
  ]
}*/
// THE PADS A VISITOR STANDS ON. Drawn as the floor surface's BACKGROUND layer, with the live blobs
// composited on top by the TRACKING content - so one projector shows the thing you step on and the
// thing that proves the tracker saw you, in register, in one picture.
//
// uv HERE IS TRACKER SPACE: uv.x = u, uv.y = v, no flip. See the coordinate chain in sync-pads.cjs.
//
// GENERATED - do not hand-edit. Re-run sync-pads.cjs after moving a zone.
const vec4 R_LEFT   = ${rect('zn_left')};   // u0, v0, u1, v1
const vec4 R_RIGHT  = ${rect('zn_right')};
const vec4 R_RETURN = ${rect('zn_home')};
const vec3 C_LEFT   = ${col('zn_left')};
const vec3 C_RIGHT  = ${col('zn_right')};
const vec3 C_RETURN = ${col('zn_home')};

// Coverage of one pad at uv: a breathing border ring over a dim interior. The interior stays dim on
// purpose - a bright fill would wash out the blob markers drawn over it, and those markers are the
// reason the floor is projected at all.
float padCover(vec2 uv, vec4 r, float breath) {
  if (uv.x < r.x || uv.x > r.z || uv.y < r.y || uv.y > r.w) return 0.0;
  // Distance to the nearest edge, x scaled by iAspect so the ring reads about the same thickness along
  // a wall as across it. NOTE iAspect is the SHADER BUFFER aspect, and for a timeline-layer clip that
  // is the 16:9 fallback (shaderDrawable.aspectFor resolves surface ids, and this content key is
  // layer:lay_pads) - not the LiDAR zone aspect, which for the shipped emitter is 5.825/3.125 = 1.86.
  // Close enough that the correction is worth having, ~5% out; do not read it as exact.
  float dx = min(uv.x - r.x, r.z - uv.x) * iAspect;
  float dy = min(uv.y - r.y, r.w - uv.y);
  float ring = 1.0 - smoothstep(border * 0.45, border, min(dx, dy));
  return max(ring * breath, interior);
}

vec4 shaderColor(vec2 uv) {
  float breath = 0.65 + 0.35 * sin(iTime * pulse * 6.2831853);
  vec3 col = vec3(0.0);
  float a = 0.0;
  if (showLeft)   { float t = padCover(uv, R_LEFT,   breath); col += C_LEFT   * t; a = max(a, t); }
  if (showRight)  { float t = padCover(uv, R_RIGHT,  breath); col += C_RIGHT  * t; a = max(a, t); }
  if (showReturn) { float t = padCover(uv, R_RETURN, breath); col += C_RETURN * t; a = max(a, t); }
  return vec4(col, a);   // premultiplied - the shader context is premultipliedAlpha:true
}`;
}

// ── sync ─────────────────────────────────────────────────────────────────────────────────────────
const zones = (proj.scene3D && proj.scene3D.trackingZones) || [];
if (!zones.length) {
  console.error('FAIL  the project has no trackingZones — draw them in 3D ▸ Trigger Zones first');
  process.exit(1);
}
const wanted = padShader(zones);

const timelines = [['project', proj.timeline], ...(proj.scenes || []).map((s) => [s.id, s.timeline])];
let padClips = 0;
const stale = [];
for (const [where, tl] of timelines) {
  for (const clip of (tl && tl.clips) || []) {
    if (!clip.content || clip.content.type !== 'SHADER' || !/R_RETURN/.test(clip.content.shaderSource || '')) continue;
    padClips++;
    if (clip.content.shaderSource !== wanted) {
      // Collected, NOT announced. The wiring checks below can still refuse the project and exit before
      // the write, and printing "synced" for a clip that never reached disk is a lie an operator would
      // act on at a venue. Reported after the write actually happens.
      stale.push(`${where}/${clip.id}`);
      if (!CHECK_ONLY) clip.content.shaderSource = wanted;
    }
  }
}
if (!padClips) { console.error('FAIL  found no pad clip to sync (expected a SHADER clip declaring R_RETURN)'); process.exit(1); }

// ── check ────────────────────────────────────────────────────────────────────────────────────────
const problems = [];
const fail = (m) => problems.push(m);

for (const z of zones) {
  if (!(Math.min(z.u0, z.u1) >= 0 && Math.max(z.u1, z.u0) <= 1 && Math.min(z.v0, z.v1) >= 0 && Math.max(z.v1, z.v0) <= 1)) fail(`zone ${z.id}: outside 0..1`);
  if (Math.abs(z.u1 - z.u0) < 0.02 || Math.abs(z.v1 - z.v0) < 0.02) fail(`zone ${z.id}: smaller than the editor's own 0.02 minimum — probably a mis-click`);
  if (!z.surface) fail(`zone ${z.id}: no tracking surface`);
}
for (const need of Object.values(ZONE_OF_PAD)) {
  if (!zones.some((z) => z.id === need)) fail(`zone "${need}" is missing — a transition names it and the pad shader paints it`);
}

const looks = [['project', proj.surfaces], ...(proj.scenes || []).map((s) => [s.id, s.surfaces])];
for (const [where, surfs] of looks) {
  const floor = (surfs || []).find((s) => s.content && s.content.type === 'TRACKING');
  if (!floor) { fail(`${where}: no TRACKING surface — nothing shows the tracker's debug view`); continue; }
  const c = floor.content;
  // The one that silently breaks the piece.
  if (c.flipH || c.flipV || c.rotate) {
    fail(`${where}/${floor.id}: flipH/flipV/rotate are set. These mirror the BLOB LAYER only (markers, trails, ids, calibrate gizmo). The pads are a background layer drawn untransformed, and zones are tested in RAW tracker space, so neither moves - the show still fires correctly, but the debug markers stop landing where people are standing, which is what you align by. Orient at the projector's corner-pin instead.`);
  }
  if (!c.bgLayerId) fail(`${where}/${floor.id}: no bgLayerId — the pads will not be drawn`);
  const tl = where === 'project' ? proj.timeline : (proj.scenes.find((s) => s.id === where) || {}).timeline;
  const layers = (tl && tl.layers) || [];
  if (c.bgLayerId && !layers.some((l) => l.id === c.bgLayerId)) fail(`${where}: bgLayerId "${c.bgLayerId}" names no layer in that look's timeline — the pads vanish on this scene`);
}

for (const [where, tl] of timelines) {
  if (!tl) { fail(`${where}: no timeline`); continue; }
  if (!tl.loop) fail(`${where}: timeline does not loop — the pads stop when the clip runs out`);
  const pad = (tl.clips || []).find((c) => c.content && /R_RETURN/.test(c.content.shaderSource || ''));
  if (pad && pad.start > 0) fail(`${where}: the pad clip starts at ${pad.start}s, so nothing is under the playhead at 0`);
}

const outs = proj.projectorOutputs || [];
const surfaceIds = new Set((proj.surfaces || []).map((s) => s.id));
if (!outs.length) fail('no projectorOutputs — nothing reaches a projector');
for (const o of outs) {
  if (!surfaceIds.has(o.surfaceId)) fail(`output "${o.name || o.surfaceId}": surfaceId "${o.surfaceId}" does not exist`);
}
for (const id of surfaceIds) {
  if (!outs.some((o) => o.surfaceId === id)) fail(`surface "${id}" has no projector output`);
}

const sm = proj.stateMachine || {};
const zoneIds = new Set(zones.map((z) => z.id));
for (const tr of sm.transitions || []) {
  if (tr.trigger && tr.trigger.kind === 'plugin') {
    const zid = tr.trigger.params && tr.trigger.params.zoneId;
    if (!zoneIds.has(zid)) fail(`transition ${tr.id}: zoneId "${zid}" is not a zone — the trigger is inert`);
    const st = (sm.states || []).find((s) => s.id === tr.from);
    const sc = (proj.scenes || []).find((s) => s.id === (st || {}).sceneId);
    const active = sc && sc.scene3D && sc.scene3D.activeZoneIds;
    if (active && !active.includes(zid)) fail(`transition ${tr.id}: state "${tr.from}" does not listen to "${zid}" — inert`);
  }
}
for (const sc of proj.scenes || []) {
  if (sc.scene3D && sc.scene3D.trackingZones !== undefined) fail(`scene ${sc.id}: carries trackingZones — zone geometry is project scope only`);
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
if (problems.length) {
  console.log('');
  for (const p of problems) console.log('  FAIL  ' + p);
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}

if (CHECK_ONLY) {
  for (const c of stale) console.log(`  STALE   ${c}`);
  console.log(stale.length ? `\n${stale.length} pad clip(s) STALE — re-run without --check to sync` : `\npads match the zones (${padClips} clip(s)); wiring OK`);
  process.exit(stale.length ? 1 : 0);
}
if (stale.length) {
  fs.writeFileSync(file, JSON.stringify(proj, null, 2) + '\n');
  // Announced only now — after the wiring checks passed and the bytes are on disk. Saying "synced"
  // for a clip that never reached the file is a lie an operator would act on at a venue.
  for (const c of stale) console.log(`  synced  ${c}`);
  console.log(`\nsynced ${stale.length} pad clip(s) from ${zones.length} zone(s); wiring OK`);
} else {
  console.log(`\npads already match the zones (${padClips} clip(s)); wiring OK`);
}
