import { Fixture, Surface } from '../types';

// Common surface implemented by both the WebGL (GPUMapper) and WebGPU
// (WebGPUMapper) backends so Stage can use either interchangeably.
export interface IPixelMapper {
  setBrightness(value: number): void;
  // `surfaces` lets the WebGPU backend sample each fixture from its linked surface
  // (strict per-surface). The WebGL fallback ignores it and samples the composite.
  updateMapping(fixtures: Fixture[], surfaces?: Surface[]): void;
  /** Cheap per-fixture effect/palette param refresh (no buffer realloc). Optional. */
  updateParams?(fixtures: Fixture[]): void;
  updateSource(source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement): void;
  /** True when the backend samples per-surface (uses renderSurfaces instead of updateSource). */
  readonly perSurface?: boolean;
  /** Per-surface render: the backend pulls each linked surface's drawable (and opacity 0..1) and dispatches it. */
  renderSurfaces?(getDrawable: (surfaceId: string) => CanvasImageSource | null, getOpacity?: (surfaceId: string) => number): void;
  /** Returns the latest RGBW bytes (4 per LED, in fixture order), or null if not ready. */
  read(): Uint8Array | null;
  /**
   * GPU time for the last timed sampling pass, in microseconds, on the GPU's own clock, plus a
   * sequence number that increments once per measurement. Optional — only the WebGPU backend can
   * measure it, and only where the device grants `timestamp-query`.
   *
   * **null is "not measured", which is NOT `us: 0`.** Without this the app could not tell a
   * saturated GPU from one that nothing submitted work to, because both looked like a busy CPU.
   * `us: 0` is its own third state: the pass was quicker than the (quantized) GPU clock can resolve.
   * De-duplicate on `seq`, never on `us`.
   */
  gpuSample?(): { us: number; seq: number } | null;
  /** True when the backend is actually able to produce the above. */
  readonly gpuTimingAvailable?: boolean;
  dispose(): void;
}
