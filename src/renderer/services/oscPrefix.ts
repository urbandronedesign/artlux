// THE OSC CONTROL PREFIX — what the controller listens under (AppSettings.oscControlPrefix, default
// '/artlux'). One rule for both readers: the controller that routes (services/oscController) and the
// binding fields that warn when an address collides with its `/state/` namespace — which may be drawn in
// a panel window, where the controller does not run (E5/W5i). Pure.
export const DEFAULT_CONTROL_PREFIX = '/artlux';
export function controlPrefixOf(raw: string | undefined | null): string { return raw || DEFAULT_CONTROL_PREFIX; }
