// What does this venue's LiDAR actually report? Run: npm run analyze:take -- <file.lblob> [...]
//
// The merge radius is the one tracking setting that cannot be guessed from a desk: a person's blobs
// merge only if they are closer together than it, and when they are not, nothing merges, every count
// silently doubles, and the only symptom is a zone threshold meaning half what was typed. That is the
// defect this tool exists to prevent — it was found in a venue, by hand, after an operator had to type
// "4" to mean two visitors.
//
// A recorded take is the venue's own answer. This reads one (or several) and prints, per surface:
//   • how many blobs are live per frame — the raw number every threshold is really compared against
//   • the distribution of nearest-neighbour distances — where the "two blobs of one person" cluster is
//   • the person count the app would compute at a range of radii, using the REAL clustering code
//
// It imports blobClustering directly, so these are the numbers the running app would produce, not a
// re-implementation that can drift from it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { clusterBlobs } from '../plugins/lidar-tracking/src/blobClustering';
import type { Blob } from '../plugins/lidar-tracking/src/trackingStore';

interface Frame { t: number; snap: { surfaces: { surface: string; scaleX: number; scaleY: number; blobs: Blob[] }[] } }
interface Take { name: string; duration: number; fps?: number; frames: Frame[] }

// The radii worth reporting: the shipped default sits in the middle, and the ends are the values an
// operator would reach for if the default were wrong in either direction.
const RADII = [0, 0.3, 0.5, 0.65, 0.8, 1.0, 1.2, 1.5, 2.0];

const pct = (sorted: number[], p: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN;

function analyze(file: string): void {
  const take = JSON.parse(fs.readFileSync(file, 'utf8')) as Take;
  console.log(`\n${'='.repeat(78)}`);
  console.log(`${take.name}  —  ${take.duration.toFixed(1)}s, ${take.frames.length} frames @ ~${take.fps ?? '?'}fps`);
  console.log(`${path.basename(file)}`);

  const bySurface = new Map<string, { blobs: number[]; nn: number[]; radii: Map<number, number[]> }>();
  for (const fr of take.frames) {
    for (const s of fr.snap.surfaces) {
      let e = bySurface.get(s.surface);
      if (!e) { e = { blobs: [], nn: [], radii: new Map(RADII.map((r) => [r, [] as number[]])) }; bySurface.set(s.surface, e); }
      e.blobs.push(s.blobs.length);
      // Nearest-neighbour distance for every blob that has one. tx/ty are metres about the surface
      // centre, so this is a real-world distance directly comparable to the merge radius.
      for (let i = 0; i < s.blobs.length; i++) {
        let best = Infinity;
        for (let j = 0; j < s.blobs.length; j++) {
          if (i === j) continue;
          best = Math.min(best, Math.hypot(s.blobs[i].tx - s.blobs[j].tx, s.blobs[i].ty - s.blobs[j].ty));
        }
        if (Number.isFinite(best)) e.nn.push(best);
      }
      for (const r of RADII) e.radii.get(r)!.push(clusterBlobs(s.blobs, r).length);
    }
  }

  for (const [name, e] of bySurface) {
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const nn = [...e.nn].sort((a, b) => a - b);
    console.log(`\n  ${name}`);
    console.log(`    raw blobs/frame   avg ${avg(e.blobs).toFixed(2)}   max ${Math.max(...e.blobs)}`);
    if (nn.length) {
      console.log(`    nearest-neighbour distance (m), over ${nn.length} samples:`);
      console.log(`      min ${nn[0].toFixed(2)}   p10 ${pct(nn, 10).toFixed(2)}   p25 ${pct(nn, 25).toFixed(2)}` +
                  `   median ${pct(nn, 50).toFixed(2)}   p75 ${pct(nn, 75).toFixed(2)}   max ${nn[nn.length - 1].toFixed(2)}`);
      // A histogram is worth more than the quantiles here: two blobs of ONE person and two DIFFERENT
      // people are two separate populations, and the merge radius has to be set between them. If they
      // overlap, no radius is right and the answer is not a radius at all.
      const buckets = [0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, Infinity];
      let lo = 0;
      console.log('      histogram:');
      for (const hi of buckets) {
        const n = nn.filter((d) => d >= lo && d < hi).length;
        if (n) console.log(`        ${lo.toFixed(2)}–${hi === Infinity ? '  ∞' : hi.toFixed(2)}m  ${String(n).padStart(6)}  ${'█'.repeat(Math.round((n / nn.length) * 50))}`);
        lo = hi;
      }
    }
    console.log('    people the app would count, by merge radius:');
    for (const r of RADII) {
      const c = e.radii.get(r)!;
      const mark = r === 0.8 ? '  <- shipped default' : '';
      console.log(`      ${r.toFixed(2)}m -> avg ${avg(c).toFixed(2)}  max ${Math.max(...c)}${mark}`);
    }
  }
}

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: npm run analyze:take -- <file.lblob> [...]'); process.exit(1); }
for (const f of files) analyze(f);
console.log('');
