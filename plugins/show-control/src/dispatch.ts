// Map a ShowCommand (from the tablet or the in-project scheduler) onto the host `show` service, which
// wires to the same cueBus/timeline singletons the OSC controller uses. Parity with
// src/renderer/services/oscController.ts:handleControl — one dispatcher serves both trigger sources.

import type { RendererHostServices } from '@artlux/sdk/renderer';
import type { ShowCommand } from './types';

export function dispatch(host: RendererHostServices, c: ShowCommand): void {
  const show = host.show;
  switch (c.kind) {
    case 'recallScene': show.recallScene(c.ref); break;
    case 'fireCue': show.fireCue(c.ref); break;
    case 'fireColumn': show.fireColumn(c.bank, c.col); break;
    case 'transport': show.transport({ kind: c.action, sec: c.sec, loopOn: c.loopOn }); break;
    case 'triggerTransition': show.triggerTransition(c.id); break;
    case 'enterState': show.enterState(c.id); break;
    case 'setFsmEnabled': show.setFsmEnabled(c.on); break;
  }
}
