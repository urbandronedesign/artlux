import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { OutputConfig, ArtNetFramePayload } from '../../../shared/protocol';
import * as artnet from './artnet';
import * as sacn from './sacn';

// Prefers the native Rust engine (native/output-engine/output-engine.node) when
// present; otherwise routes to the TypeScript Art-Net/sACN transports. The native
// addon builds + sends packets in Rust (run `npm run build:native` to produce it).

interface NativeUniverse { universe: number; data: Buffer; }
interface NativeTarget {
  ip: string; port: number; protocol: string; broadcast: boolean;
  sparse: boolean; priority: number; universes: NativeUniverse[];
}
interface NativeEngine {
  configure(broadcast: boolean): void;
  isReady(): boolean;
  sendFrame(targets: NativeTarget[]): void;
  close(): void;
}

const req = createRequire(__filename);

function loadNative(): NativeEngine | null {
  const candidates = [
    join(process.cwd(), 'native/output-engine/output-engine.node'),
    join(__dirname, '../../native/output-engine/output-engine.node'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return req(p) as NativeEngine;
    } catch (e) {
      console.warn('[output] native engine load failed at', p, e);
    }
  }
  return null;
}

const native = loadNative();
console.log(native ? '[output] native Rust engine loaded' : '[output] using TypeScript transport');

export function configure(cfg: OutputConfig): void {
  if (native) {
    native.configure(cfg.broadcast);
    return;
  }
  artnet.configure(cfg);
  sacn.configure(cfg);
}

export function isReady(): boolean {
  if (native) return native.isReady();
  return artnet.isReady() || sacn.isReady();
}

export function sendFrame(payload: ArtNetFramePayload): void {
  if (!payload?.targets?.length) return;

  if (native) {
    const targets: NativeTarget[] = payload.targets.map(t => ({
      ip: t.ip,
      port: t.port,
      protocol: t.protocol,
      broadcast: t.broadcast,
      sparse: t.sparse,
      priority: t.priority ?? 100,
      universes: Object.entries(t.universes).map(([u, arr]) => ({
        universe: Number(u),
        data: Buffer.from(arr),
      })),
    }));
    native.sendFrame(targets);
    return;
  }

  const artnetTargets = payload.targets.filter(t => t.protocol !== 'sacn');
  const sacnTargets = payload.targets.filter(t => t.protocol === 'sacn');
  if (artnetTargets.length) artnet.sendFrame({ targets: artnetTargets });
  if (sacnTargets.length) sacn.sendFrame({ targets: sacnTargets });
}

export function close(): void {
  if (native) { native.close(); return; }
  artnet.close();
  sacn.close();
}
