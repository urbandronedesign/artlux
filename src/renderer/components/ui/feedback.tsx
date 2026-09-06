import React from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';

// The app's ONE feedback substrate. Before this there was nowhere to put a message: every confirmation
// and error went through a blocking native window.confirm/alert (unthemed, focus-stealing, no aria) or
// nothing at all — saves failed silently, imports swallowed errors, and status never reached a screen
// reader. This provides three channels:
//   • useToast()   — transient, non-blocking notices with an aria-live region.
//   • useConfirm() — a themed, focus-trapped confirmation (an awaitable replacement for window.confirm).
//   • usePrompt()  — the same, for a single line of text (an awaitable replacement for window.prompt).
//
// Mount <FeedbackProvider> once, above App. All three hooks throw if used outside it.

// ── Toasts ──────────────────────────────────────────────────────────────────────────────────────
type ToastKind = 'success' | 'error' | 'info' | 'warn';
interface ToastItem { id: number; kind: ToastKind; message: string; detail?: string; }

interface ToastApi {
  success: (message: string, detail?: string) => void;
  error: (message: string, detail?: string) => void;
  info: (message: string, detail?: string) => void;
  warn: (message: string, detail?: string) => void;
}

// ── Confirm ─────────────────────────────────────────────────────────────────────────────────────
interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // A THIRD answer, for the one question that genuinely has three: "you have unsaved work — save,
  // throw it away, or go back?". Two buttons cannot ask it, and chaining two dialogs to fake a third
  // makes the destructive path the one that takes fewest clicks. Only shown when a label is given, so
  // every existing caller is a plain yes/no and can never receive 'alt'.
  altLabel?: string;
  danger?: boolean; // destructive → red confirm, and focus defaults to Cancel
}
// `false` = cancelled (also Escape and backdrop click), `true` = the confirm button, 'alt' = the
// third one. Truthiness is deliberate: 'alt' is truthy, but no caller without `altLabel` can get it.
type ConfirmResult = boolean | 'alt';
type ConfirmFn = (opts: ConfirmOptions) => Promise<ConfirmResult>;

// ── Prompt ──────────────────────────────────────────────────────────────────────────────────────
// The third question this substrate has to be able to ask: "what should this be called?". Naming a
// workspace, renaming one. Without it the only ways to ask are a native window.prompt (unthemed,
// focus-stealing, no aria — the exact thing this module exists to replace) or a bespoke modal per
// feature. Same shape as confirm, so it inherits the focus trap, Escape, and the backdrop rule.
interface PromptOptions {
  title: string;
  message?: string;
  /** Pre-filled and selected, so Enter alone accepts the suggestion. */
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
}
/** null = cancelled (Escape, backdrop, Cancel). An empty string can never come back — see the dialog. */
type PromptFn = (opts: PromptOptions) => Promise<string | null>;

const ToastCtx = React.createContext<ToastApi | null>(null);
const ConfirmCtx = React.createContext<ConfirmFn | null>(null);
const PromptCtx = React.createContext<PromptFn | null>(null);

export function useToast(): ToastApi {
  const ctx = React.useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used within <FeedbackProvider>');
  return ctx;
}
export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmCtx);
  if (!ctx) throw new Error('useConfirm must be used within <FeedbackProvider>');
  return ctx;
}
export function usePrompt(): PromptFn {
  const ctx = React.useContext(PromptCtx);
  if (!ctx) throw new Error('usePrompt must be used within <FeedbackProvider>');
  return ctx;
}

const KIND_META: Record<ToastKind, { Icon: React.FC<{ size?: number; className?: string }>; color: string; hold: number }> = {
  success: { Icon: CheckCircle2, color: 'text-ok', hold: 3500 },
  info:    { Icon: Info, color: 'text-accent', hold: 3500 },
  warn:    { Icon: AlertTriangle, color: 'text-warn', hold: 5000 },
  error:   { Icon: XCircle, color: 'text-danger', hold: 0 }, // errors are sticky — dismiss by hand
};

export const FeedbackProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const idRef = React.useRef(0);

  const dismiss = React.useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const push = React.useCallback((kind: ToastKind, message: string, detail?: string) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, kind, message, detail }]);
    const hold = KIND_META[kind].hold;
    if (hold > 0) window.setTimeout(() => dismiss(id), hold);
  }, [dismiss]);

  const toastApi = React.useMemo<ToastApi>(() => ({
    success: (m, d) => push('success', m, d),
    error: (m, d) => push('error', m, d),
    info: (m, d) => push('info', m, d),
    warn: (m, d) => push('warn', m, d),
  }), [push]);

  // Confirm — a single dialog resolved through a ref'd promise.
  const [confirmState, setConfirmState] = React.useState<ConfirmOptions | null>(null);
  const resolver = React.useRef<((v: ConfirmResult) => void) | null>(null);
  const confirm = React.useCallback<ConfirmFn>((opts) => new Promise<ConfirmResult>((resolve) => {
    resolver.current = resolve;
    setConfirmState(opts);
  }), []);
  const closeConfirm = React.useCallback((result: ConfirmResult) => {
    resolver.current?.(result);
    resolver.current = null;
    setConfirmState(null);
  }, []);

  // Prompt — the same ref'd-promise pattern, kept separate so a confirmation and a naming question
  // cannot cancel one another.
  const [promptState, setPromptState] = React.useState<PromptOptions | null>(null);
  const promptResolver = React.useRef<((v: string | null) => void) | null>(null);
  const prompt = React.useCallback<PromptFn>((opts) => new Promise<string | null>((resolve) => {
    promptResolver.current = resolve;
    setPromptState(opts);
  }), []);
  const closePrompt = React.useCallback((value: string | null) => {
    promptResolver.current?.(value);
    promptResolver.current = null;
    setPromptState(null);
  }, []);

  return (
    <ToastCtx.Provider value={toastApi}>
      <PromptCtx.Provider value={prompt}>
      <ConfirmCtx.Provider value={confirm}>
        {children}

        {/* Two live regions: polite for routine notices, assertive for errors/warnings the operator
            must not miss. They do NOT steal focus (toasts must never grab focus from the show). */}
        <div className="fixed bottom-3 right-3 z-toast flex flex-col gap-2 items-end pointer-events-none" aria-label="Notifications">
          <div aria-live="assertive" className="flex flex-col gap-2 items-end">
            {toasts.filter((t) => t.kind === 'error' || t.kind === 'warn').map((t) => (
              <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
            ))}
          </div>
          <div aria-live="polite" className="flex flex-col gap-2 items-end">
            {toasts.filter((t) => t.kind === 'success' || t.kind === 'info').map((t) => (
              <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
            ))}
          </div>
        </div>

        {confirmState && <ConfirmDialog opts={confirmState} onClose={closeConfirm} />}
        {promptState && <PromptDialog opts={promptState} onClose={closePrompt} />}
      </ConfirmCtx.Provider>
      </PromptCtx.Provider>
    </ToastCtx.Provider>
  );
};

const PromptDialog: React.FC<{ opts: PromptOptions; onClose: (v: string | null) => void }> = ({ opts, onClose }) => {
  const trapRef = useFocusTrap(true);
  const [value, setValue] = React.useState(opts.initial ?? '');
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // An empty name is never an answer — the caller would have to guard it every time, and a nameless
  // thing in a list is worse than no thing. Submitting empty is simply inert.
  const accept = () => { if (value.trim()) onClose(value.trim()); };

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 animate-overlay-in" onClick={() => onClose(null)}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={opts.title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm bg-surface-1 border border-line-2 rounded-lg shadow-e3 p-5 animate-modal-in"
      >
        {/* A <form> so Enter in the field accepts — the shortest path from "type a name" to done. */}
        <form onSubmit={(e) => { e.preventDefault(); accept(); }}>
        <h2 className="text-sm font-semibold text-fg-1 mb-1">{opts.title}</h2>
        {opts.message && <p className="text-fg-2 text-xs whitespace-pre-line mb-3">{opts.message}</p>}
        <input
          data-autofocus
          value={value}
          placeholder={opts.placeholder}
          onChange={(e) => setValue(e.target.value)}
          // Selected on mount, so Enter alone accepts the suggested name and typing replaces it.
          onFocus={(e) => e.currentTarget.select()}
          className="w-full bg-surface-0 border border-line-1 rounded-sm px-2 py-1.5 text-xs text-fg-1 focus:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button type="button" onClick={() => onClose(null)} className="px-3 py-1.5 text-xs rounded-md border border-line-2 text-fg-1">Cancel</button>
          <button type="submit" disabled={!value.trim()} className="px-3 py-1.5 text-xs rounded-md font-medium bg-accent text-black disabled:opacity-40">
            {opts.confirmLabel ?? 'OK'}
          </button>
        </div>
        </form>
      </div>
    </div>
  );
};

const ToastCard: React.FC<{ toast: ToastItem; onDismiss: () => void }> = ({ toast, onDismiss }) => {
  const { Icon, color } = KIND_META[toast.kind];
  return (
    <div className="pointer-events-auto min-w-[240px] max-w-[380px] bg-surface-2 border border-line-2 rounded-md shadow-e2 px-3 py-2 flex items-start gap-2">
      <Icon size={15} className={`${color} shrink-0 mt-0.5`} />
      <div className="flex-1 min-w-0">
        <div className="text-fg-1 text-xs">{toast.message}</div>
        {toast.detail && <div className="text-fg-3 text-micro mt-0.5 break-words">{toast.detail}</div>}
      </div>
      <button type="button" onClick={onDismiss} title="Dismiss" className="text-fg-3 hover:text-fg-1 shrink-0">
        <X size={13} />
      </button>
    </div>
  );
};

const ConfirmDialog: React.FC<{ opts: ConfirmOptions; onClose: (result: ConfirmResult) => void }> = ({ opts, onClose }) => {
  const trapRef = useFocusTrap(true);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 animate-overlay-in" onClick={() => onClose(false)}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={opts.title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm bg-surface-1 border border-line-2 rounded-lg shadow-e3 p-5 animate-modal-in"
      >
        <h2 className="text-sm font-semibold text-fg-1 mb-1">{opts.title}</h2>
        {opts.message && <p className="text-fg-2 text-xs whitespace-pre-line mb-4">{opts.message}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={() => onClose(false)}
            data-autofocus={opts.danger ? true : undefined}
            className="px-3 py-1.5 text-xs rounded-md border border-line-2 text-fg-1"
          >
            {opts.cancelLabel ?? 'Cancel'}
          </button>
          {opts.altLabel && (
            // Deliberately NOT styled as the primary action: this is usually the discarding path, and
            // it must not be the easiest button to hit by reflex.
            <button type="button" onClick={() => onClose('alt')} className="px-3 py-1.5 text-xs rounded-md border border-line-2 text-fg-2">
              {opts.altLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => onClose(true)}
            data-autofocus={opts.danger ? undefined : true}
            className={`px-3 py-1.5 text-xs rounded-md font-medium ${opts.danger ? 'bg-danger text-white' : 'bg-accent text-black'}`}
          >
            {opts.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
};
