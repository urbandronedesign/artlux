/**
 * The NDI send's capture cap — ONE place, read by the app's projector window (ProjectorApp captureNdi) and by
 * the native engine link (nativeLink: the engine captures its own window to the same size, E6f). An editor sends
 * at up to 720p (light readback + IPC); a broadcast machine at up to 1080p.
 */
export const NDI_MAX_W = 1280, NDI_MAX_H = 720;
export const NDI_BCAST_W = 1920, NDI_BCAST_H = 1080;
export function ndiCap(fullRes: boolean): [number, number] { return fullRes ? [NDI_BCAST_W, NDI_BCAST_H] : [NDI_MAX_W, NDI_MAX_H]; }
