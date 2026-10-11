import { useEffect, useRef } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open dialogs, newest last. Only the newest answers Escape and Tab, so a panel over a panel works. */
const stack: HTMLElement[] = [];

/**
 * Keyboard behaviour for side panels and full-screen dialogs: focus moves in when it opens, Tab
 * stays inside, Escape closes (unless `escape` is false), and focus goes back where it was. Keys
 * are heard on the window, so Escape still works after the focused button disables itself.
 * Spread the result onto the element with role="dialog".
 */
export function useDialog<T extends HTMLElement = HTMLDivElement>(onClose: () => void, { escape = true }: { escape?: boolean } = {}) {
  const ref = useRef<T>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const before = document.activeElement as HTMLElement | null;
    stack.push(node);
    if (!node.contains(document.activeElement)) (node.querySelector<HTMLElement>('[autofocus]') ?? node).focus({ preventScroll: true });

    function onKey(e: KeyboardEvent) {
      if (stack[stack.length - 1] !== node) return;
      if (e.key === 'Escape' && escape) {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...node!.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!node!.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      stack.splice(stack.indexOf(node), 1);
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [escape]);

  return { ref, tabIndex: -1, 'aria-modal': true as const, role: 'dialog' as const };
}
