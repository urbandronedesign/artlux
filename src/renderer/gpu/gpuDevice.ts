// THE ONE GPUDevice, published so the 3D scene can share it with the pixel mapper.
//
// The mapper (gpu/WebGPUMapper) acquires a device at boot and owns it. Until now the 3D scene stood up
// an entirely separate graphics stack beside it — its own context, its own textures — so a frame of
// video bound to a venue mesh was uploaded to the GPU TWICE per frame: once into the mapper's atlas for
// LED sampling, once into a three.js texture for the viewport. On a weak GPU that duplication is the
// single largest avoidable cost in the renderer, and it can only be removed if both sides are talking
// to the same device: a GPUTexture cannot cross devices.
//
// WHY A SUBSCRIBE CHANNEL AND NOT AN IMPORT. The two are built on unrelated schedules — the mapper is
// created asynchronously inside frameEngine's own rAF, which starts at module load; the 3D canvas is
// mounted lazily by the shell, the first time an operator opens that workbench, which may be minutes
// later or never. Either can be first. So this hands out a promise: whoever asks gets the device when
// it exists, and `null` once the mapper has said it will not have one (WebGL fallback, forceWebGL, or
// a machine with no WebGPU at all).
//
// Same shape and the same reasoning as dmxSignal/fixtureSignal — a module singleton the engine
// publishes into and the view reads from, with no React in between.

type Resolver = (d: GPUDevice | null) => void;

let device: GPUDevice | null = null;
let settled = false;
const waiting: Resolver[] = [];

/**
 * Publish the outcome of the mapper's device acquisition. Called exactly once, by frameEngine, with
 * the device it got — or with null when it fell back to WebGL, which is just as much an answer and
 * must not leave a consumer waiting forever.
 */
export function publishGpuDevice(d: GPUDevice | null): void {
  if (settled) return;
  settled = true;
  device = d;
  for (const r of waiting.splice(0)) r(d);
}

/** The device if it is already known, else null. For code that cannot wait. */
export function gpuDeviceNow(): GPUDevice | null { return device; }

/**
 * The shared device once the mapper has decided, or null if there will not be one.
 *
 * Resolves immediately if that has already happened. Note it never rejects and never times out: the
 * caller's fallback is "build your own", which is exactly what a null resolution means.
 */
export function gpuDevice(): Promise<GPUDevice | null> {
  if (settled) return Promise.resolve(device);
  return new Promise<GPUDevice | null>((resolve) => { waiting.push(resolve); });
}
