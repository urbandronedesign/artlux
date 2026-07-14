import type { Fixture, Controller, OutputProtocol, PatchPolicy } from '../types';

// Automatic DMX patch (S5). Packs each fixture's channels sequentially per
// controller: starting at the controller's startUniverse + channel 1, consuming
// ledCount × channelsPerPixel channels and wrapping at the 512-channel boundary
// (a fixture may span universes — the Stage packer handles that). Fixtures with
// `patchLocked` keep their manual universe/startAddress. With `reserveLockedRanges`
// on, auto fixtures pack AROUND locked ranges (default off = today's behaviour,
// where locked rows are skipped but their channels are NOT reserved). Fixtures with
// no/invalid controller share one implicit bucket.

const GLOBAL = '__global__';

// The wire destination a fixture resolves to: per-fixture output override → controller → global
// default. This resolution MUST match Stage.tsx's per-frame output loop (same fixtures, same wires);
// both call resolveDest so the collision detector and the real output can never drift apart.
export interface Dest { protocol: OutputProtocol; ip: string; broadcast: boolean; }
export interface DestDefaults { protocol: OutputProtocol; ip: string; broadcast: boolean; }

export function resolveDest(f: Fixture, ctrl: Controller | undefined, def: DestDefaults): Dest {
  return {
    protocol: f.output?.protocol || ctrl?.protocol || def.protocol,
    ip: f.output?.ip || ctrl?.ip || def.ip,
    broadcast: f.output?.broadcast ?? ctrl?.broadcast ?? def.broadcast,
  };
}

// Group key for fixtures sharing a wire (protocol|ip|broadcast). Collisions are per-destination,
// not per-controller — two controllers can point at the same IP. Matches Stage.tsx's destinations key.
export const destKey = (d: Dest): string => `${d.protocol}|${d.ip}|${d.broadcast ? 1 : 0}`;

// Absolute [startAbs, endAbs] channel span of a fixture on its resolved destination.
export interface Span { fixtureId: string; destKey: string; startAbs: number; endAbs: number; }

export function fixtureSpans(fixtures: Fixture[], controllers: Controller[], def: DestDefaults): Span[] {
  const ctrlById = new Map(controllers.map((c) => [c.id, c]));
  return fixtures.map((f) => {
    const ctrl = f.controllerId ? ctrlById.get(f.controllerId) : undefined;
    const cpp = f.channelsPerPixel ?? 4;
    const startAbs = f.universe * 512 + (f.startAddress - 1);
    const endAbs = startAbs + Math.max(0, f.ledCount * cpp - 1);
    return { fixtureId: f.id, destKey: destKey(resolveDest(f, ctrl, def)), startAbs, endAbs };
  });
}

// Every unordered pair of fixtures whose channel ranges intersect on the same destination.
// O(n²) within each destination bucket — fine for realistic fixture counts, and only run in the
// Routing modal on a memoized deps change (never in the frame loop).
export function findCollisions(spans: Span[]): Array<[string, string]> {
  const byDest = new Map<string, Span[]>();
  for (const s of spans) {
    const arr = byDest.get(s.destKey);
    if (arr) arr.push(s); else byDest.set(s.destKey, [s]);
  }
  const out: Array<[string, string]> = [];
  for (const arr of byDest.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        // Half-open? No — both endAbs are inclusive last channels, so intervals touch iff they overlap.
        if (arr[i].startAbs <= arr[j].endAbs && arr[j].startAbs <= arr[i].endAbs) {
          out.push([arr[i].fixtureId, arr[j].fixtureId]);
        }
      }
    }
  }
  return out;
}

export function autoPatch(
  fixtures: Fixture[],
  controllers: Controller[],
  policy: PatchPolicy,
  defaultControllerId?: string,
): Fixture[] {
  const ctrlById = new Map(controllers.map((c) => [c.id, c]));
  const reserve = policy.reserveLockedRanges;

  // The packing bucket a fixture belongs to — the SAME rule for locked and auto fixtures, so a
  // locked fixture's reserved range lands in the exact bucket the auto fixtures on its controller
  // pack into.
  const bucketFor = (f: Fixture): string => {
    const real = f.controllerId && ctrlById.has(f.controllerId) ? f.controllerId
      : (defaultControllerId && ctrlById.has(defaultControllerId)) ? defaultControllerId
      : (controllers[0]?.id);
    return real ?? GLOBAL;
  };

  // Phase B: reserved absolute intervals per bucket, harvested from locked fixtures, sorted ascending.
  const reserved = new Map<string, Array<[number, number]>>();
  if (reserve) {
    for (const f of fixtures) {
      if (!f.patchLocked) continue;
      const cpp = f.channelsPerPixel ?? 4;
      const startAbs = f.universe * 512 + (f.startAddress - 1);
      const endAbs = startAbs + f.ledCount * cpp - 1;
      const key = bucketFor(f);
      const arr = reserved.get(key);
      if (arr) arr.push([startAbs, endAbs]); else reserved.set(key, [[startAbs, endAbs]]);
    }
    for (const arr of reserved.values()) arr.sort((a, b) => a[0] - b[0]);
  }

  const cursors = new Map<string, { universe: number; channel: number }>();
  const cursorFor = (cid: string) => {
    let cur = cursors.get(cid);
    if (!cur) { cur = { universe: ctrlById.get(cid)?.startUniverse ?? 0, channel: 0 }; cursors.set(cid, cur); }
    return cur;
  };

  return fixtures.map((f) => {
    if (f.patchLocked) return f;
    const real = f.controllerId && ctrlById.has(f.controllerId) ? f.controllerId
      : (defaultControllerId && ctrlById.has(defaultControllerId)) ? defaultControllerId
      : (controllers[0]?.id);
    const key = real ?? GLOBAL;
    const cur = cursorFor(key);
    const cpp = f.channelsPerPixel ?? 4;
    const need = f.ledCount * cpp;

    // Phase B: hop the cursor forward past every reserved (locked) interval this fixture would
    // straddle. Intervals are sorted ascending and the cursor only ever moves forward, so this
    // single pass terminates — no infinite loop even for a locked fixture that spans universes.
    if (reserve) {
      const intervals = reserved.get(key);
      if (intervals) {
        let abs = cur.universe * 512 + cur.channel;
        for (const [rs, re] of intervals) {
          if (abs <= re && rs <= abs + need - 1) abs = re + 1; // overlap → jump past this range
        }
        cur.universe = Math.floor(abs / 512);
        cur.channel = abs % 512;
      }
    }

    const universe = cur.universe;
    const startAddress = cur.channel + 1;
    const total = cur.channel + need;
    cur.universe += Math.floor(total / 512);
    cur.channel = total % 512;
    return real ? { ...f, universe, startAddress, controllerId: real } : { ...f, universe, startAddress };
  });
}
