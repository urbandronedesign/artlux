import { type Fixture, type Controller, ColorOrder, type OutputProtocol } from '../types';
import { isLight } from '../services/fixtureKind';
import { resolveDest, destKey } from '../services/addressing';

// UNIVERSE PACKING — the canonical LED buffer + the patch → DMX universes per destination.
//
// Extracted VERBATIM from frameEngine.packAndPublish (E1b, plans/native-engine.md §9c) so it has a seam:
// a pure function of its inputs, which the native engine's Rust port (engine/artlux-engine/src/pack.rs)
// is held to BYTE FOR BYTE by scripts/test-pack-parity.cjs. The frame engine still calls this every
// frame; nothing about the browser engine's output changed in the move.
//
// A LIGHT fixture (a profiled head) is not packed here: its channels come from authored values through
// the precedence stack (lighting clips, cues, automation, live faders), which the frame engine evaluates
// and hands in as `packLight`. That is also the engine split for E1–E2 — "the host evaluates, the engine
// draws" (§4): the host computes a light's channel bytes, the engine only places them.

/** Output channel source-index order per ColorOrder ([R=0,G=1,B=2]). */
export const COLOR_ORDER: Record<ColorOrder, [number, number, number]> = {
  [ColorOrder.RGB]: [0, 1, 2],
  [ColorOrder.RBG]: [0, 2, 1],
  [ColorOrder.GRB]: [1, 0, 2],
  [ColorOrder.GBR]: [1, 2, 0],
  [ColorOrder.BRG]: [2, 0, 1],
  [ColorOrder.BGR]: [2, 1, 0],
};

export interface PackDestination {
  ip: string; protocol: OutputProtocol; broadcast: boolean; sparse: boolean;
  priority?: number; universes: Record<number, number[]>;
}

export interface PackContext {
  controllerMap: ReadonlyMap<string, Controller>;
  defaults: { protocol: OutputProtocol; ip: string; broadcast: boolean };
  gammaLut: Uint8Array;
  /** Pooled 512-arrays, keyed `${destKey}#${universe}` — ZEROED by the caller before each frame. */
  pool: Record<string, number[]>;
  /** A light fixture's channels, written through `writeCh` (nothing written = it occupies nothing). */
  packLight: (f: Fixture, writeCh: (val: number) => void) => void;
}

/** Output gamma LUT (applied during universe packing). Identity when gamma = 1. */
export function buildGammaLut(gamma: number): Uint8Array {
  const lut = new Uint8Array(256);
  const g = gamma && gamma > 0 ? gamma : 1;
  for (let i = 0; i < 256; i++) lut[i] = Math.round(Math.pow(i / 255, g) * 255);
  return lut;
}

export function packUniverses(rawBytes: Uint8Array, currentFixtures: Fixture[], ctx: PackContext): Record<string, PackDestination> {
  let offset = 0;
  const pool = ctx.pool;
  const defaultIp = ctx.defaults.ip;
  const defaultBroadcast = ctx.defaults.broadcast;
  const defaultProtocol = ctx.defaults.protocol;

  // Per-destination universe maps, keyed by `${protocol}|${ip}|${broadcast}`.
  const destinations: Record<string, PackDestination> = {};

  for (let fIdx = 0; fIdx < currentFixtures.length; fIdx++) {
    const f = currentFixtures[fIdx];

    // Destination resolves from the per-fixture output override → controller → global settings.
    // Shared with the Routing collision detector via resolveDest/destKey so the UI's overlap check
    // and this real output never drift.
    const ctrl = f.controllerId ? ctx.controllerMap.get(f.controllerId) : undefined;
    const wire = resolveDest(f, ctrl, { protocol: defaultProtocol, ip: defaultIp, broadcast: defaultBroadcast });
    const proto = wire.protocol;
    // For a USB widget the COM path IS the address — it travels in the same `ip` slot the network
    // protocols use, so the frame codec and the Rust engine needed no new field.
    const ip = wire.protocol === 'enttec' ? (wire.port ?? '') : wire.ip;
    const bcast = wire.broadcast;
    const priority = f.output?.priority ?? ctrl?.priority;
    const sparse = f.output?.sparse ?? false;
    const dk = destKey(wire);
    let dest = destinations[dk];
    if (!dest) {
      dest = { ip, protocol: proto, broadcast: bcast, sparse: false, priority, universes: {} };
      destinations[dk] = dest;
    }
    dest.sparse = dest.sparse || sparse;

    // Fetch (or lazily create) a pooled 512-array for a universe in this dest.
    const getArr = (u: number): number[] => {
      const pk = `${dk}#${u}`;
      let arr = pool[pk];
      if (!arr) { arr = new Array(512).fill(0); pool[pk] = arr; }
      if (!dest!.universes[u]) dest!.universes[u] = arr;
      return arr;
    };

    let currentUniverse = f.universe;
    let currentChannel = f.startAddress - 1; // 0-based

    const order = COLOR_ORDER[f.colorOrder ?? ColorOrder.RGB];
    const o0 = order[0], o1 = order[1], o2 = order[2];
    const cpp = f.channelsPerPixel ?? 4;
    const lut = ctx.gammaLut;

    // Fetch the destination universe array lazily and re-fetch only when a write spills past
    // channel 512. The lazy fetch preserves the original registration semantics exactly: a universe
    // appears in `dest.universes` only if a channel is actually written into it (no trailing/empty
    // universe when a fixture ends on a 512 boundary, none for a 0-LED fixture).
    let arr: number[] | null = null;
    const writeCh = (val: number) => {
      if (currentChannel >= 512) { currentUniverse++; currentChannel = 0; arr = null; }
      if (!arr) arr = getArr(currentUniverse);
      arr[currentChannel] = val;
      currentChannel++;
    };

    // ── PROFILED FIXTURE (a moving head / wash / beam) ────────────────────────────
    // Its channels are named parameters at fixed offsets in the mode, not colour components, so it
    // packs from its authored values rather than from sampled pixels — and NOT through the gamma
    // LUT, which would move the head to the wrong angle. See services/profilePack.ts.
    //
    // It still consumes ONE pixel of the canonical buffer (ledCount is pinned to 1 for a profiled
    // fixture), so `offset` stays in step with the monitor and the 3D scene, both of which index
    // that buffer by cumulative ledCount.
    if (isLight(f)) {
      ctx.packLight(f, writeCh);
      offset += f.ledCount;
      continue;
    }

    for (let i = 0; i < f.ledCount; i++) {
      const idx = offset * 4;
      if (idx + 3 >= rawBytes.length) break;

      // rawBytes is linear RGBW; remap RGB to the fixture's color order + gamma-correct.
      const r = rawBytes[idx], g = rawBytes[idx + 1], b = rawBytes[idx + 2];
      writeCh(lut[o0 === 0 ? r : o0 === 1 ? g : b]);
      writeCh(lut[o1 === 0 ? r : o1 === 1 ? g : b]);
      writeCh(lut[o2 === 0 ? r : o2 === 1 ? g : b]);
      if (cpp === 4) writeCh(lut[rawBytes[idx + 3]]);

      offset++;
    }
  }
  return destinations;
}
