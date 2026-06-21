import { Fixture } from '../types';

// Common surface implemented by both the WebGL (GPUMapper) and WebGPU
// (WebGPUMapper) backends so Stage can use either interchangeably.
export interface IPixelMapper {
  setBrightness(value: number): void;
  updateMapping(fixtures: Fixture[]): void;
  /** Cheap per-fixture effect/palette param refresh (no buffer realloc). Optional. */
  updateParams?(fixtures: Fixture[]): void;
  updateSource(source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement): void;
  /** Returns the latest RGBW bytes (4 per LED, in fixture order), or null if not ready. */
  read(): Uint8Array | null;
  dispose(): void;
}
