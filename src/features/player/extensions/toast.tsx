/**
 * Minimal player toast bus shared by extensions (issue #23 feedback, issue
 * #18 copy confirmation). One host renders into the `overlay` slot; producers
 * call `showToast(text)`. Independent React subtrees communicate through
 * this store — the documented pattern (spec §S2.8).
 */

import { useSyncExternalStore, type ReactElement } from "react";
import type { PlayerExtension, Unsubscribe } from "./types";
import "./toast.css";

export type ToastItem = {
  id: number;
  text: string;
};

const TOAST_MS = 2600;
const MAX_TOASTS = 3;

let items: readonly ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function showToast(text: string): void {
  const item: ToastItem = { id: nextId++, text: String(text ?? "") };
  items = [...items, item].slice(-MAX_TOASTS);
  notify();
  timers.set(
    item.id,
    setTimeout(() => {
      timers.delete(item.id);
      items = items.filter((t) => t.id !== item.id);
      notify();
    }, TOAST_MS),
  );
}

export function subscribeToasts(cb: () => void): Unsubscribe {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getToasts(): readonly ToastItem[] {
  return items;
}

/** Test helper — drop all toasts and pending timers. */
export function resetToasts(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  items = [];
  notify();
}

export function ToastHost(): ReactElement | null {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  if (toasts.length === 0) return null;
  return (
    <div className="player-ext-toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="player-ext-toast">
          {toast.text}
        </div>
      ))}
    </div>
  );
}

/**
 * Toast host extension — mounts `<ToastHost/>` into the overlay slot so
 * every extension can `showToast` without owning UI.
 */
export const toastHost: PlayerExtension = {
  id: "toast-host",
  name: "Уведомления",
  setup(ctx): Unsubscribe {
    return ctx.ui.add("overlay", () => <ToastHost />);
  },
};
