import type { Fixture, Controller } from '../types';

// Automatic DMX patch (S5). Packs each fixture's channels sequentially per
// controller: starting at the controller's startUniverse + channel 1, consuming
// ledCount × channelsPerPixel channels and wrapping at the 512-channel boundary
// (a fixture may span universes — the Stage packer handles that). Fixtures with
// `patchLocked` keep their manual universe/startAddress (and are skipped, not
// reserved). Fixtures with no/invalid controller share one implicit bucket.

const GLOBAL = '__global__';

export function autoPatch(fixtures: Fixture[], controllers: Controller[], defaultControllerId?: string): Fixture[] {
  const ctrlById = new Map(controllers.map((c) => [c.id, c]));
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
    const universe = cur.universe;
    const startAddress = cur.channel + 1;
    const total = cur.channel + f.ledCount * cpp;
    cur.universe += Math.floor(total / 512);
    cur.channel = total % 512;
    return real ? { ...f, universe, startAddress, controllerId: real } : { ...f, universe, startAddress };
  });
}
