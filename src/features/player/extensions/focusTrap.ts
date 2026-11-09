/**
 * Focus trap for player modals (issue #26) — Tab / Shift+Tab cycle inside a
 * container, focus enters on activate and returns to the opener on release.
 * Used by the command palette and (via `keyboardNav`) the core settings menu.
 */

export type Unsubscribe = () => void;

export type FocusTrapOptions = {
  /** Move focus to the first focusable child on activate (default true). */
  autoFocus?: boolean;
  /** Where to restore focus on release (usually the opener button). */
  restoreTo?: HTMLElement | null;
};

export type FocusTrap = {
  release: () => void;
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isVisible(el: HTMLElement): boolean {
  // getClientRects is 0 for display:none / detached nodes.
  return el.getClientRects().length > 0;
}

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    isVisible,
  );
}

/**
 * Trap Tab focus inside `container`. Returns a `release` that removes the
 * handler and restores focus (best-effort) to `restoreTo`.
 */
export function trapFocus(
  container: HTMLElement,
  options: FocusTrapOptions = {},
): FocusTrap {
  const { autoFocus = true, restoreTo = null } = options;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const items = focusableElements(container);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const inside = active ? container.contains(active) : false;
    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener("keydown", onKeyDown);
  if (autoFocus) {
    const items = focusableElements(container);
    (items[0] ?? container).focus();
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      container.removeEventListener("keydown", onKeyDown);
      if (restoreTo && typeof restoreTo.focus === "function" && document.contains(restoreTo)) {
        restoreTo.focus();
      }
    },
  };
}
