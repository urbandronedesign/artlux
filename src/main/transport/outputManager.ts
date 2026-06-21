import type { OutputConfig, ArtNetFramePayload } from '../../../shared/protocol';
import * as artnet from './artnet';
import * as sacn from './sacn';

// Routes each frame's targets to the appropriate protocol transport.
export function configure(cfg: OutputConfig): void {
  artnet.configure(cfg);
  sacn.configure(cfg);
}

export function isReady(): boolean {
  return artnet.isReady() || sacn.isReady();
}

export function sendFrame(payload: ArtNetFramePayload): void {
  if (!payload?.targets?.length) return;
  const artnetTargets = payload.targets.filter(t => t.protocol !== 'sacn');
  const sacnTargets = payload.targets.filter(t => t.protocol === 'sacn');
  if (artnetTargets.length) artnet.sendFrame({ targets: artnetTargets });
  if (sacnTargets.length) sacn.sendFrame({ targets: sacnTargets });
}

export function close(): void {
  artnet.close();
  sacn.close();
}
