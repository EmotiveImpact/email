import { useEffect, useRef, type KeyboardEvent } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard behaviour for side panels and full-screen dialogs: focus moves in when it opens, Tab
 * stays inside, Escape closes (unless `escape` is false), and focus goes back where it was.
 * Spread the result onto the element with role="dialog".
 */
export function useDialog<T extends HTMLElement = HTMLDivElement>(onClose: () => void, { escape = true }: { escape?: boolean } = {}) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const node = ref.current;
    if (node && !node.contains(document.activeElement)) {
      const first = node.querySelector<HTMLElement>('[autofocus]') ?? node;
      first.focus({ preventScroll: true });
    }
    return () => {
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, []);

  function onKeyDown(e: KeyboardEvent<T>) {
    if (e.key === 'Escape' && escape) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return { ref, onKeyDown, tabIndex: -1, 'aria-modal': true as const, role: 'dialog' as const };
}
