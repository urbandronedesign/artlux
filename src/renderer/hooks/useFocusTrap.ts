import { useEffect, useRef } from 'react';

// Modal focus management, done once. `role="dialog" aria-modal="true"` is a PROMISE to assistive tech
// that focus is contained — but none of ArtLux's dialogs kept it: Tab escaped into the obscured editor
// behind the overlay, and closing dropped focus onto <body>. This hook keeps that promise:
//   • on activate: remember what was focused, then move focus into the dialog (a [data-autofocus]
//     element if present, else the first focusable, else the container);
//   • while active: Tab / Shift+Tab wrap within the dialog;
//   • on deactivate/unmount: restore focus to the element that opened it.
//
// Pass the dialog container ref and whether the dialog is currently open.
export function useFocusTrap(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Initial focus — prefer an explicit [data-autofocus] target.
    const initial = node.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? node;
    initial.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (activeEl === first || !node.contains(activeEl))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault(); first.focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      // Restore focus to the opener, if it's still in the document.
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, [active]);

  return ref;
}
