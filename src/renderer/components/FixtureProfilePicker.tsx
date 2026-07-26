import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, BadgeCheck, AlertTriangle, Loader2, FileDown } from 'lucide-react';
import type { FixtureProfileSummary } from '../types';
import * as profiles from '../services/fixtureProfiles';
import { search } from '../services/fixtureSearch';
import { Tooltip } from './ui/Tooltip';
import { help } from '../services/helpBus';

// "Add a fixture by typing its reference."
//
// The operator has a name on a case, an invoice or a rider — `MAC250`, `Martin MAC 250 Krypton`,
// `mac 250 krypton` — and needs the fixture behind it. services/fixtureSearch does the matching
// (normalised, alias-aware); this is the list, the mode choice and the "not in the library" exit.
//
// Shared by the inspector (narrow, changing one fixture's profile) and the Fixture Editor's Library
// card (wide, adding a new one), so it owns no layout beyond its own column.

interface Props {
  /** Highlighted row (the fixture's current profile), if any. */
  selectedId?: string;
  /** Picking a row. `modeKey` is whichever mode the row's dropdown is showing. */
  onPick: (profileId: string, modeKey: string) => void;
  /** Rows to show at once before the list scrolls. */
  maxHeight?: string;
  autoFocus?: boolean;
}

export const FixtureProfilePicker: React.FC<Props> = ({ selectedId, onPick, maxHeight = 'max-h-64', autoFocus }) => {
  const [index, setIndex] = useState<FixtureProfileSummary[] | null>(null);
  const [query, setQuery] = useState('');
  // Which mode each row is showing. Keyed by profile id; absent ⇒ the profile's first mode, which is
  // what the library lists first and what the packer falls back to.
  const [modes, setModes] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);

  // Importing a manufacturer's own .gdtf — the answer to "my fixture is not in the library", and the
  // only source that carries real geometry. Refreshes the index in place so the new profile is
  // immediately selectable rather than needing a restart.
  const importGdtf = async () => {
    setImporting(true);
    setImportNote(null);
    try {
      const r = await window.artlux?.importGdtf?.();
      if (!r) return;                                  // cancelled
      if (!r.id) { setImportNote(r.notes[0] ?? 'Import failed'); return; }
      profiles.invalidateIndex();
      setIndex(await profiles.index());
      setQuery(r.model);
      setImportNote(r.notes.length ? r.notes.join(' ') : `Imported ${r.model}`);
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => { let alive = true; void profiles.index().then((rows) => { if (alive) setIndex(rows); }); return () => { alive = false; }; }, []);
  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  // 506 rows and a keystroke per character: memoise so typing does not re-rank on unrelated renders.
  const results = useMemo(() => (index ? search(index, query, 60) : []), [index, query]);

  if (!index) {
    return (
      <div className="flex items-center gap-2 text-mini text-fg-3 px-2 py-3">
        <Loader2 size={12} className="animate-spin" /> Loading fixture library…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <Tooltip id="fixtures.profile-search">
        <div className="flex items-center gap-1.5 bg-surface-0 border border-line-1 rounded-sm px-1.5 focus-within:border-accent">
          <Search size={12} className="text-fg-3 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Manufacturer or model — e.g. MAC250"
            aria-label="Search the fixture library"
            className="flex-1 min-w-0 bg-transparent py-1 text-xs text-fg-1 placeholder:text-fg-3 focus:outline-none"
            {...help('fixtures.profile-search')}
          />
        </div>
      </Tooltip>

      <div className={`${maxHeight} overflow-y-auto -mx-1 px-1`} role="listbox" aria-label="Fixture profiles">
        {results.map((row) => {
          const mode = modes[row.id] ?? row.modes[0]?.key ?? '';
          const footprint = row.modes.find((m) => m.key === mode)?.footprint ?? row.modes[0]?.footprint ?? 0;
          const isSelected = row.id === selectedId;
          return (
            <div
              key={row.id}
              role="option"
              aria-selected={isSelected}
              className={`group flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs ${isSelected ? 'bg-accent/15 text-fg-0' : 'text-fg-1'}`}
            >
              <button
                className="flex-1 min-w-0 text-left truncate"
                title={`${row.manufacturer} ${row.model}`}
                onClick={() => onPick(row.id, mode)}
              >
                <span className="text-fg-3">{row.manufacturer} </span>{row.model}
              </button>

              {/* A draft profile is usable but never silently trusted — see docs/FIXTURE-LIBRARY.md. */}
              {row.verified === false && (
                <span title="Unverified — this profile has not been checked against the manufacturer's manual" className="text-warn shrink-0">
                  <AlertTriangle size={11} />
                </span>
              )}
              {row.origin && row.origin !== 'ofl' && row.verified !== false && (
                <span title={`Imported (${row.origin})`} className="text-fg-3 shrink-0"><BadgeCheck size={11} /></span>
              )}

              {/* The MODE is part of the choice, not an afterthought: it decides the footprint, so it
                  must be visible before the fixture is patched rather than corrected afterwards. */}
              {row.modes.length > 1 ? (
                <select
                  value={mode}
                  aria-label={`Mode for ${row.model}`}
                  onChange={(e) => setModes((m) => ({ ...m, [row.id]: e.target.value }))}
                  className="shrink-0 max-w-[8rem] bg-surface-0 border border-line-1 rounded-sm px-1 py-0.5 text-mini text-fg-2 focus:border-accent focus:outline-none"
                >
                  {row.modes.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
                </select>
              ) : (
                <span className="shrink-0 text-mini text-fg-3 truncate max-w-[8rem]">{row.modes[0]?.name ?? '—'}</span>
              )}
              <span className="shrink-0 text-mini text-fg-3 tabular-nums w-10 text-right">{footprint}ch</span>
            </div>
          );
        })}

        {importNote && (
          <div className="px-1.5 py-1 text-mini text-fg-2 bg-surface-2 rounded-sm">{importNote}</div>
        )}

        {!results.length && (
          // An honest miss. The library is ~500 fixtures, not every fixture ever made, and pretending
          // otherwise by showing a near-match would get the wrong thing patched.
          <div className="px-1.5 py-3 text-mini text-fg-3">
            {query
              ? <>No fixture matches “{query}”.<br />Check the spelling, try just the model number, or
                  import the manufacturer’s <span className="text-fg-2">.gdtf</span> below.</>
              : 'The fixture library is empty.'}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-1.5">
        <span className="text-mini text-fg-3">
          {results.length === 60 ? 'first 60 matches' : `${results.length} of ${index.length}`}
        </span>
        <button
          onClick={importGdtf}
          disabled={importing}
          title="Import a manufacturer .gdtf — its own channels, modes and 3D model"
          className="inline-flex items-center gap-1 text-mini text-fg-2 hover:text-fg-1 disabled:opacity-40"
        >
          {importing ? <Loader2 size={11} className="animate-spin" /> : <FileDown size={11} />} Import .gdtf
        </button>
      </div>
    </div>
  );
};
