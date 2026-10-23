// Minimal ambient types for the `mp4box` package (it ships no .d.ts). Only what this plugin uses.
declare module 'mp4box' {
  export interface MP4VideoTrack {
    id: number;
    codec: string;            // e.g. 'avc1.42E01E' / 'hvc1.1.6.L93.B0'
    timescale: number;
    nb_samples: number;
    video: { width: number; height: number };
    movie_duration: number;
    movie_timescale: number;
  }
  export interface MP4Info {
    videoTracks: MP4VideoTrack[];
    duration: number;         // in movie timescale units
    timescale: number;
    isFragmented: boolean;    // samples live in moof boxes through the file, not in the moov's sample table
  }
  export interface MP4Sample {
    is_sync: boolean;
    cts: number;              // composition time (track timescale)
    duration: number;
    timescale: number;
    data: Uint8Array;
  }
  // One row of the moov's sample table (getTrackSamplesInfo) — where the sample IS, without its bytes.
  export interface MP4SampleInfo {
    offset: number;           // absolute byte position in the file
    size: number;
    cts: number;              // composition time (track timescale)
    duration: number;
    timescale: number;
    is_sync: boolean;
  }
  export interface MP4Track { id: number; }
  export interface MP4File {
    onReady?: (info: MP4Info) => void;
    onError?: (e: string) => void;
    onSamples?: (id: number, user: unknown, samples: MP4Sample[]) => void;
    appendBuffer(data: ArrayBuffer & { fileStart?: number }): number;
    start(): void;
    stop(): void;
    flush(): void;
    getTrackById(id: number): unknown;
    getTrackSamplesInfo(id: number): MP4SampleInfo[] | undefined;
    setExtractionOptions(id: number, user: unknown, opts: { nbSamples?: number }): void;
  }
  export function createFile(): MP4File;
  const MP4Box: { createFile(): MP4File };
  export default MP4Box;
}
