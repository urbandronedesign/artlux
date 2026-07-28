// Sidecar storage for calibration artifacts too big to live inside the .artlux file.
//
// A dense per-pixel 3D map is 10^4–10^5 points (projector pixel ↔ world XYZ) per projector. It must
// not go in the project document — that file is opened, diffed, hand-inspected and rewritten on every
// save — but it cannot simply be thrown away either: the world-space blend between two projectors
// needs BOTH maps, so re-solving after recalibrating one of them requires the other's, which may have
// been scanned weeks earlier. So it lands beside the project, in `<project>/calib/`.
//
// Written with the same temp-file + rename dance persistence.ts uses: a half-written map that still
// parses is worse than none, because it would silently produce a wrong blend.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface DenseMapFile {
  version: 1;
  surfaceId: string;
  raster: [number, number];
  capturedAt: string;
  proj: number[];
  world: number[];
}

// `projectFile` is the absolute path of the .artlux; artifacts live in a sibling `calib/` folder so a
// portable project folder carries them along with assets/.
const dir = (projectFile: string): string => path.join(path.dirname(projectFile), 'calib');
const fileFor = (projectFile: string, surfaceId: string): string =>
  // Surface ids are generated, but never trust one as a filename — a traversal here would write
  // outside the project folder.
  path.join(dir(projectFile), `${surfaceId.replace(/[^a-zA-Z0-9_-]/g, '_')}.densemap.json`);

export async function writeDenseMap(projectFile: string, data: DenseMapFile): Promise<boolean> {
  try {
    await fs.mkdir(dir(projectFile), { recursive: true });
    const target = fileFor(projectFile, data.surfaceId);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fs.rename(tmp, target);
    return true;
  } catch (e) {
    console.warn('[calib] dense-map write failed:', (e as Error).message);
    return false;
  }
}

export async function readDenseMap(projectFile: string, surfaceId: string): Promise<DenseMapFile | null> {
  try {
    const raw = await fs.readFile(fileFor(projectFile, surfaceId), 'utf8');
    const d = JSON.parse(raw) as DenseMapFile;
    // Reject anything whose arrays do not agree rather than blending against a truncated map.
    if (d?.version !== 1 || !Array.isArray(d.proj) || !Array.isArray(d.world)) return null;
    if (d.proj.length / 2 !== d.world.length / 3) return null;
    return d;
  } catch {
    return null; // absent is normal — that projector has simply never been scanned in this project
  }
}

export async function deleteDenseMap(projectFile: string, surfaceId: string): Promise<void> {
  try { await fs.unlink(fileFor(projectFile, surfaceId)); } catch { /* already gone */ }
}
