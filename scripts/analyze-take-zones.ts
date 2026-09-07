// What would each ZONE have counted? Run: npm run analyze:take:zones -- <project.artlux> <take.lblob>
//
// analyze-take.ts answers "what does this sensor report"; this answers the question an operator
// actually asks — *"my zone says People needed 2, why did it take four visitors?"* — by replaying a
// recorded take through the project's real zone rectangles at a range of merge radii, using the same
// clustering the app uses.
//
// The number to look at is the ratio: raw blobs inside the zone ÷ people counted there. At 2.0 the
// zone is counting halves of people and every threshold means half what it says.
import * as fs from 'node:fs';
import { clusterBlobs } from '../plugins/lidar-tracking/src/blobClustering';
import type { Blob } from '../plugins/lidar-tracking/src/trackingStore';

interface Zone { id: string; name: string; surface: string; u0: number; v0: number; u1: number; v1: number; minBlobs?: number }
interface Frame { snap: { surfaces: { surface: string; blobs: Blob[] }[] } }

const RADII = [0, 0.5, 0.8, 1.0, 1.2, 1.5];
const inside = (z: Zone, u: number, v: number): boolean =>
  u >= Math.min(z.u0, z.u1) && u <= Math.max(z.u0, z.u1) && v >= Math.min(z.v0, z.v1) && v <= Math.max(z.v0, z.v1);

const [projFile, takeFile] = process.argv.slice(2);
if (!projFile || !takeFile) { console.error('usage: npm run analyze:take:zones -- <project.artlux> <take.lblob>'); process.exit(1); }

const proj = JSON.parse(fs.readFileSync(projFile, 'utf8'));
const zones: Zone[] = proj?.scene3D?.trackingZones ?? [];
const take = JSON.parse(fs.readFileSync(takeFile, 'utf8')) as { name: string; frames: Frame[] };
if (!zones.length) { console.error('no trackingZones in that project'); process.exit(1); }

console.log(`\n${take.name} — ${take.frames.length} frames, through ${zones.length} real zones`);
console.log(`merge radius:        ${RADII.map((r) => r.toFixed(2).padStart(6)).join('')}`);
console.log(`${'-'.repeat(30 + RADII.length * 6)}`);

for (const z of zones) {
  // Peak occupancy per radius: the number a "People needed N" threshold is compared against, and the
  // one that decides whether the zone ever latches at all.
  const peak = new Map<number, number>(RADII.map((r) => [r, 0]));
  const sum = new Map<number, number>(RADII.map((r) => [r, 0]));
  let frames = 0;
  for (const fr of take.frames) {
    const s = fr.snap.surfaces.find((x) => x.surface === z.surface);
    if (!s) continue;
    frames++;
    for (const r of RADII) {
      const pts = clusterBlobs(s.blobs, r);
      let n = 0;
      for (const b of pts) if (inside(z, b.u, b.v)) n++;
      if (n > peak.get(r)!) peak.set(r, n);
      sum.set(r, sum.get(r)! + n);
    }
  }
  if (!frames) { console.log(`${z.name.padEnd(12)} (surface ${z.surface} not in this take)`); continue; }
  // ⚠ READ THIS RATIO THE RIGHT WAY ROUND. raw/merged ≈ 2 means merging is WORKING — it turned four
  // blobs into two people, which is exactly what a two-blobs-per-person sensor needs. ≈ 1 means the
  // merge changed nothing, which is the state to worry about: either the radius is too small for this
  // venue's pairs, or these really are separate people. (This label said the opposite on its first
  // draft and nearly produced the reverse conclusion from correct numbers.)
  const raw = peak.get(0)!, at8 = peak.get(0.8)!;
  const ratio = at8 ? raw / at8 : 0;
  const flag = ratio >= 1.8 ? '  <- merging halves it: the raw count WOULD need double the threshold'
    : ratio > 1.05 ? '  <- merging partly reduces it'
    : raw > 1 ? '  <- merging changes NOTHING here (radius too small, or genuinely separate people)' : '';
  console.log(`${z.name.padEnd(12)} peak ${RADII.map((r) => String(peak.get(r)).padStart(6)).join('')}${flag}`);
  console.log(`${' '.repeat(12)} avg  ${RADII.map((r) => (sum.get(r)! / frames).toFixed(2).padStart(6)).join('')}`);
}
console.log('\n"peak" is the most this zone ever held; "avg" is over every frame of the take.');
console.log('Radius 0.00 = no merging at all, i.e. raw blobs — the column every other one is fixing.\n');
