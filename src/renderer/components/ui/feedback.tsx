import React from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';

// The app's ONE feedback substrate. Before this there was nowhere to put a message: every confirmation
// and error went through a blocking native window.confirm/alert (unthemed, focus-stealing, no aria) or
// nothing at all — saves failed silently, imports swallowed errors, and status never reached a screen
// reader. This provides two channels:
//   • useToast()   — transient, non-blocking notices with an aria-live region.
//   • useConfirm() — a themed, focus-trapped confirmation (an awaitable replacement for window.confirm).
//
// Mount <FeedbackProvider> once, above App. Both hooks throw if used outside it.

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
  danger?: boolean; // destructive → red confirm, and focus defaults to Cancel
}
type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ToastCtx = React.createContext<ToastApi | null>(null);
const ConfirmCtx = React.createContext<ConfirmFn | null>(null);

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
  const resolver = React.useRef<((v: boolean) => void) | null>(null);
  const confirm = React.useCallback<ConfirmFn>((opts) => new Promise<boolean>((resolve) => {
    resolver.current = resolve;
    setConfirmState(opts);
  }), []);
  const closeConfirm = React.useCallback((result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setConfirmState(null);
  }, []);

  return (
    <ToastCtx.Provider value={toastApi}>
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
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
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

const ConfirmDialog: React.FC<{ opts: ConfirmOptions; onClose: (result: boolean) => void }> = ({ opts, onClose }) => {
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
