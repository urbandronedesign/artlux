// A TRACKING TAKE'S BLOB DENSITY — what its sparkline draws (components/timeline/BlobSparkline) — by
// path, wherever the sparkline is drawn (E5/W5j). The take files are the LiDAR plugin's to read
// (trackingTake, through its barrel, which is runtime); a panel window may import neither. So:
//   EDITOR — live/editorAccess.ts installs the plugin's own cache and loader;
//   WINDOW — live/takesRemote.ts asks the editor once per path ('takes.density') and keeps the answer.
// This module imports nothing that runs.

export interface TakeDensity { density: number[]; duration: number }
export interface TakeDensitySource {
  /** Already known, synchronously (no flash of an empty sparkline on a re-render). */
  getCached(path: string): TakeDensity | null;
  ensure(path: string): Promise<TakeDensity | null>;
}
let source: TakeDensitySource = { getCached: () => null, ensure: async () => null };
export function setTakeDensitySource(s: TakeDensitySource): void { source = s; }
export function takeDensity(): TakeDensitySource { return source; }
