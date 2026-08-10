// The shader editor — a dock panel, not a workspace context.
//
// The shell has nine contexts and a standing rule against adding one so that two things can share a
// screen; the workspace is dockable, so an editor that wants half the window gets it by being dragged
// there. It edits whatever surface is selected, which is why it reads the shell's own EditorStore
// rather than being handed props: panels read state, App owns it.
//
// WHY CODEMIRROR AND NOT A TEXTAREA OR MONACO. Monaco's edge is language-server intelligence and there
// is no GLSL language server, so its ~5 MB and worker plumbing buy nothing a hand-written completion
// list does not. And CodeMirror's editable surface is a `contenteditable` div, which matters more than
// it sounds: the app asks "is the operator typing?" with `tagName === 'INPUT' || 'TEXTAREA' ||
// isContentEditable` in at least four places (App.tsx, useTimelineKeys, ContextRail, StateGraphEditor).
// A contenteditable satisfies all four unchanged. A canvas-drawn editor would satisfy none, and the
// first symptom would be pressing space inside a shader and starting the show.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap, type CompletionContext } from '@codemirror/autocomplete';
import { bracketMatching, indentUnit, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { cpp } from '@codemirror/lang-cpp';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { useEditor, useEditorActions } from '@/state/EditorStore'; // shell store (panels read state, App owns it)
import { compile, sourceOf, rearmKey } from './shaderDrawable';
import { STARTERS } from './starters';
import { UNIFORMS } from './wrapper';

// One place decides what a compile problem looks like, so the gutter and the message list agree.
// `ERROR: 0:12: 'x' : undeclared` — the driver's own shape, already translated into author lines by
// shaderContext.toAuthorSpace before it gets here.
function parseLog(log: string, doc: EditorState['doc']): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/i);
    const n = m ? Math.max(1, Math.min(doc.lines, Number(m[1]))) : 1;
    const info = doc.line(n);
    out.push({
      from: info.from,
      to: info.to,
      severity: /^warning/i.test(line) ? 'warning' : 'error',
      message: m ? m[2] : line,
    });
  }
  return out;
}

// A static completion source: the uniforms, plus the entry point. This is the part nobody can guess,
// and it is the cheapest useful thing an editor with no language server can offer.
const COMPLETIONS = [
  ...UNIFORMS.map((u) => ({ label: u.name, type: 'variable', detail: u.detail })),
  { label: 'shaderColor', type: 'function', detail: 'vec4 shaderColor(vec2 uv) — the entry point', apply: 'vec4 shaderColor(vec2 uv) {\n  \n}' },
];

function completeGlsl(ctx: CompletionContext) {
  const word = ctx.matchBefore(/\w*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return { from: word.from, options: COMPLETIONS };
}

const THEME = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'IBM Plex Mono, ui-monospace, monospace', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', opacity: 0.7 },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,.035)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
}, { dark: true });

export const ShaderEditorPanel: React.FC = () => {
  const { surfaces, selectedSurfaceId } = useEditor();
  const { updateSurface } = useEditorActions();
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const diagnostics = useRef<Diagnostic[]>([]);
  const lintComp = useRef(new Compartment());
  const [status, setStatus] = useState<{ ok: boolean; log: string; at: number } | null>(null);

  const surface = useMemo(
    () => surfaces.find((s) => s.id === selectedSurfaceId && s.content.type === 'SHADER') ?? null,
    [surfaces, selectedSurfaceId],
  );
  const surfaceId = surface?.id ?? null;

  // COMPILE ON COMMAND, NEVER ON KEYSTROKE. Compile-as-you-type is not a convenience here: a
  // half-typed `for (;;)` is a driver reset, and an editor that compiles what you have typed SO FAR
  // will eventually find one. Ctrl+Enter is the whole contract.
  const run = useCallback(() => {
    const v = view.current;
    if (!v || !surfaceId) return false;
    const text = v.state.doc.toString();
    const res = compile(text);
    diagnostics.current = res.ok ? [] : parseLog(res.log, v.state.doc);
    v.dispatch({ effects: lintComp.current.reconfigure(linter(() => diagnostics.current)) });
    setStatus({ ok: res.ok, log: res.log, at: Date.now() });
    if (res.ok) {
      // Only a shader that BUILDS is written to the document. A broken buffer stays in the editor,
      // where it belongs, and the surface keeps drawing the last thing that worked.
      updateSurface(surfaceId, { content: { ...surface!.content, shaderSource: text } });
      rearmKey(surfaceId); // a fixed shader deserves another go at the frame budget
    }
    return true;
  }, [surfaceId, surface, updateSurface]);

  const runRef = useRef(run);
  runRef.current = run;

  // Build the view once. The document is swapped on selection change rather than the whole editor
  // being torn down, so scroll position and undo history survive a click elsewhere and back.
  useEffect(() => {
    if (!host.current || view.current) return;
    view.current = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(), lintGutter(), highlightActiveLine(), highlightActiveLineGutter(),
          history(), bracketMatching(), highlightSelectionMatches(), indentUnit.of('  '),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          cpp(), // GLSL is close enough for braces, comments, numbers and keywords
          autocompletion({ override: [completeGlsl] }),
          lintComp.current.of(linter(() => diagnostics.current)),
          // Ctrl+Enter FIRST so nothing below can claim it. Ctrl+S is deliberately NOT bound: it
          // already means "save the project", and a second meaning inside one panel is how work is lost.
          keymap.of([{ key: 'Mod-Enter', run: () => runRef.current(), preventDefault: true }]),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, indentWithTab]),
          THEME,
          EditorView.lineWrapping,
        ],
      }),
    });
    return () => { view.current?.destroy(); view.current = null; };
  }, []);

  // Load the selected surface's source into the existing view.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    const v = view.current;
    if (!v || loadedFor.current === surfaceId) return;
    loadedFor.current = surfaceId;
    diagnostics.current = [];
    setStatus(null);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: surface ? sourceOf(surface.content) : '' } });
  }, [surfaceId, surface]);

  const resetToStarter = () => {
    const v = view.current;
    if (!v || !surface) return;
    const s = STARTERS.find((x) => x.id === (surface.content.shaderId ?? STARTERS[0].id)) ?? STARTERS[0];
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: s.source } });
  };

  return (
    <div className="flex h-full flex-col bg-surface-1 min-h-0">
      <div className="flex items-center gap-2 border-b border-line-1 px-2 py-1 text-micro shrink-0">
        <span className="text-fg-2 truncate">
          {surface ? surface.name : <span className="text-fg-3 italic">Select a shader surface</span>}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={resetToStarter} disabled={!surface}
            className="px-1.5 py-0.5 rounded border border-line-1 text-fg-2 disabled:opacity-40">
            Reset
          </button>
          <button onClick={() => runRef.current()} disabled={!surface}
            className="px-1.5 py-0.5 rounded border border-accent/60 text-accent disabled:opacity-40">
            Compile ⌃⏎
          </button>
        </div>
      </div>

      {/* min-h-0 on both this and the flex parent: without it the CodeMirror scroller grows the panel
          instead of scrolling inside it, and the compile log below is pushed off the bottom. */}
      <div ref={host} className="flex-1 min-h-0 overflow-auto" />

      {status && (
        <div className={`shrink-0 max-h-28 overflow-auto border-t border-line-1 px-2 py-1 text-micro font-mono whitespace-pre-wrap ${status.ok ? 'text-fg-3' : 'text-danger'}`}>
          {status.ok ? 'compiled — the surface is running this' : status.log}
        </div>
      )}
    </div>
  );
};
