// The state graph's OSC bindings and drawer in a PANEL WINDOW (E5/W5i). A window receives no OSC and has
// no timeline drawer, so:
//   · the SENDER LIST (machine settings) is the editor's, from the 'editor.extras' stream, put into this
//     window's inbox (services/smOscInbox) as App puts it into the editor's;
//   · LEARN is armed in the editor ('osc.learn'): the next press there is sent here, once;
//   · "edit this state's timeline" opens the EDITOR's drawer ('shell.revealBottom').
import { liveClient } from './client';
import * as oscInbox from '../services/smOscInbox';
import { setRevealBottom } from '../services/editorShell';
import { setShowMachineLive } from '../services/showMachineLive';
import type { OscSender } from '../types';
import type { OscMessage } from '../../../shared/protocol';

export function installOscRemote(): void {
  let last: unknown;
  liveClient.subscribe('editor.extras', null, (v) => {
    const list = ((v as { settings?: { oscSenders?: OscSender[] } } | null)?.settings?.oscSenders);
    const key = JSON.stringify(list ?? null);
    if (key === last) return;
    last = key;
    oscInbox.setSenders(list);
  });
  oscInbox.setRemoteLearn((cb) => {
    let done = false;
    const stop = liveClient.subscribe('osc.learn', null, (m) => {
      if (done) return;
      done = true;
      stop();
      cb(m as OscMessage);
    });
    return () => { if (!done) { done = true; stop(); } };
  });
  setRevealBottom(() => { liveClient.action('shell.revealBottom', []).catch((e: Error) => console.warn('[panel] reveal timeline failed:', e.message)); });
  // The running machine: the editor's current state and fired edges, and the graph's two nudges.
  const fail = (what: string) => (e: Error) => console.warn(`[panel] ${what} failed:`, e.message);
  setShowMachineLive({
    subscribeState(cb) {
      let cur: string | null | undefined;
      return liveClient.subscribe('sm.state', null, (v) => { const id = (v as { id: string | null }).id; if (id !== cur) { cur = id; cb(id); } });
    },
    subscribeFired(cb) {
      let seen = 0;
      return liveClient.subscribe('sm.fired', null, (v) => { const f = v as { id: string; seq: number }; if (f.seq > seen) { seen = f.seq; cb(f.id); } });
    },
    triggerTransition: (id) => { liveClient.action('sm.trigger', [id]).catch(fail('fire transition')); },
    enterState: (id) => { liveClient.action('sm.enter', [id]).catch(fail('enter state')); },
  });
}
