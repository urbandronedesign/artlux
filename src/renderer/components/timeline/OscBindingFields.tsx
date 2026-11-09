import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Radio } from 'lucide-react';
import * as oscInbox from '../../services/smOscInbox';
import { getControlPrefix } from '../../services/oscController';

// The (sender, address) pair a state-machine OSC binding is made of — shared by the transition's
// `osc` trigger and the state's OSC jump, so both read and warn identically.
//
// The sender list lives in Preferences (machine-scoped IPs); a binding stores the sender's NAME. The
// two warnings below are the two ways a binding can look right and never fire: a name this machine
// has no entry for (a project carried from another PC), and an address under the control prefix's
// `/state/` namespace, which the built-in "fire transition by id" route also claims.

export function useOscSenders() {
  useSyncExternalStore(oscInbox.subscribe, oscInbox.getVersion);
  return oscInbox.getSenders();
}

interface Props {
  address: string;
  sender: string;
  onChange: (next: { address: string; sender: string }) => void;
}

export const OscBindingFields: React.FC<Props> = ({ address, sender, onChange }) => {
  const senders = useOscSenders();
  const [learning, setLearning] = useState(false);
  const [learnedFrom, setLearnedFrom] = useState<string | null>(null);

  // LEARN: the next press on the network fills both fields. The learner outlives no render it was
  // armed in — unmount (selection changed) cancels it, or the next press would land on another node.
  useEffect(() => {
    if (!learning) return;
    return oscInbox.learn((msg) => {
      setLearning(false);
      const name = oscInbox.senderNameFor(msg.from);
      setLearnedFrom(name ? null : msg.from ? `${msg.from.host}:${msg.from.port}` : null);
      onChange({ address: msg.address, sender: name ?? '' });
    });
    // onChange is a fresh closure every render; re-arming on it would reset the learn window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learning]);

  const missing = !!sender && oscInbox.resolveSender(sender) === 'missing';
  const norm = oscInbox.normalizeAddress(address);
  const collides = !!norm && norm.startsWith(getControlPrefix() + '/state/');

  return (
    <div className="space-y-1.5">
      <label className="block">
        <span className="text-fg-3 text-micro">Sender</span>
        <select value={sender} onChange={(e) => onChange({ address, sender: e.target.value })}
          className="w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none">
          <option value="">Any sender</option>
          {senders.map(s => <option key={s.name} value={s.name}>{s.name} — {s.host}{s.port ? `:${s.port}` : ''}</option>)}
          {/* Keep a dead name selectable so the select does not render BLANK for it (which reads as
              "Any" — the opposite of what the binding does). */}
          {missing && <option value={sender}>{sender} (not on this machine)</option>}
        </select>
      </label>
      {missing && (
        <div className="text-warn italic text-micro">
          ⚠ No sender named “{sender}” in Preferences ▸ OSC / Tracking on this machine — this binding cannot fire until one is added.
        </div>
      )}
      <label className="block">
        <span className="text-fg-3 text-micro">OSC address</span>
        <div className="flex gap-1 mt-0.5">
          <input value={address} placeholder="/show/next" spellCheck={false}
            onChange={(e) => onChange({ address: e.target.value, sender })}
            className="num flex-1 min-w-0 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none" />
          <button onClick={() => { setLearnedFrom(null); setLearning(l => !l); }}
            title="Learn: press the button on your device now — the next OSC message fills the address and sender"
            className={`inline-flex items-center gap-1 px-1.5 rounded border ${learning ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:text-fg-1'}`}>
            <Radio size={11} /> {learning ? 'Listening…' : 'Learn'}
          </button>
        </div>
      </label>
      {learnedFrom && (
        <div className="text-fg-3 italic text-micro">
          Learned from {learnedFrom}, which is not a named sender — the binding accepts any sender. Add it in Preferences ▸ OSC / Tracking to restrict it.
        </div>
      )}
      {collides && (
        <div className="text-warn italic text-micro">
          ⚠ This address is under {getControlPrefix()}/state/, which ArtLux also reads as “fire transition by id”. Use a different address.
        </div>
      )}
      <div className="text-fg-3 italic text-micro">
        Fires on a press: no argument, a string, or a non-zero number. A button’s release (0) does not fire. Needs OSC receive on.
      </div>
    </div>
  );
};
