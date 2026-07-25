// docs/INSTALL.md's triage table, as data.
//
// THE MAP CURATES FRAMING, NEVER VISIBILITY. An id with no entry here renders verbatim — name,
// status, detail and the script's own remedy. That rule is what keeps this file from quietly
// becoming a filter: preflight.ps1 is the authority on what a machine is missing, and a launcher
// that only showed the checks someone remembered to describe would hide the next new one.
//
// Keyed by the script's own check ids (see scripts/preflight.ps1 -> Add-Result).

export type Severity = 'blocking' | 'repairable' | 'expected' | 'note';

export interface Triage {
  severity: Severity;
  /** Plain language, in place of the script's terse detail. */
  plain: string;
}

/** Exact-id entries. */
const BY_ID: Record<string, Triage> = {
  'gpu.present': {
    severity: 'blocking',
    plain:
      'The whole pixel-mapping pipeline is GPU compute. With only a fallback adapter, ArtLux will not ' +
      'render — install the graphics vendor’s driver before relying on this machine.',
  },
  vcredist: {
    severity: 'repairable',
    plain: 'Expected on a clean machine. The ArtLux installer adds it, or Repair can install it now.',
  },
  'ndi.runtime': {
    severity: 'repairable',
    plain:
      'Expected on a clean machine. Without it, NDI sources and outputs are silently absent. The ArtLux ' +
      'installer adds it, or Repair can install it now.',
  },
  'install.found': {
    severity: 'expected',
    plain: 'ArtLux is not installed yet — install it from the Install tab.',
  },
  'net.nic': {
    severity: 'note',
    plain:
      'More than one network adapter is up, so sACN multicast has no obvious interface to bind to. Pin ' +
      'the output interface in ArtLux, or disable the adapter you are not using.',
  },
  'audio.device': {
    severity: 'note',
    plain: 'No audio output device. The audio UI will render and play nothing, with no error.',
  },
  'priv.admin': {
    severity: 'note',
    plain: 'Not running as administrator. Only affects checks that need it — installing does its own elevation.',
  },
};

/** Prefix entries, for the families the script generates one result per item for. */
const BY_PREFIX: Array<[string, Triage]> = [
  ['res.', {
    severity: 'blocking',
    plain:
      'A file that should be inside the install is missing. This cannot be repaired from here — the ' +
      'installer itself was built incomplete. Reinstall from a newer release.',
  }],
  ['imp.', {
    severity: 'blocking',
    plain:
      'A native module is present but cannot load everything it needs. Its feature will be silently ' +
      'absent. Reinstall from a newer release.',
  }],
  ['net.profile.', {
    severity: 'note',
    plain:
      'This network is set to Public, so Windows Firewall blocks inbound OSC and the tablet remote. Set ' +
      'the show network to Private.',
  }],
  ['port.', {
    severity: 'note',
    plain: 'Something already holds this port. ArtLux will fail to bind it and that feature goes quiet.',
  }],
  ['gpu.', {
    severity: 'note',
    plain: 'Graphics adapter information, for the record.',
  }],
];

export function triage(id: string): Triage | null {
  if (BY_ID[id]) return BY_ID[id];
  for (const [prefix, t] of BY_PREFIX) if (id.startsWith(prefix)) return t;
  return null;
}

/** Severity for an item, given its status. Only FAIL/WARN carry a severity worth ranking. */
export function severityOf(id: string, status: string): Severity {
  const t = triage(id);
  if (t) return t.severity;
  return status === 'FAIL' ? 'blocking' : 'note';
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  blocking: 'Fix before relying on this machine',
  repairable: 'Expected — can be repaired',
  expected: 'Expected',
  note: 'Worth knowing',
};

/** Token names, not raw colour — and never colour alone; every row also carries its status word. */
export const STATUS_COLOR: Record<string, string> = {
  PASS: 'var(--ok)',
  WARN: 'var(--warn)',
  FAIL: 'var(--danger)',
  SKIP: 'var(--text-2)',
};
