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
  /** Per-surface render: the backend pulls each linked surface's drawable and dispatches it. */
  renderSurfaces?(getDrawable: (surfaceId: string) => CanvasImageSource | null): void;
  /** Returns the latest RGBW bytes (4 per LED, in fixture order), or null if not ready. */
  read(): Uint8Array | null;
  dispose(): void;
}
