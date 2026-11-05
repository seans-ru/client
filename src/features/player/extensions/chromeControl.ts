/**
 * Chrome visibility control (spec: docs/compose/spec/clean-screen.md §S2.1).
 *
 * Small store mirroring the `frameHub` pattern: extensions push visibility
 * through `ctx.ui.setChromeHidden`, `PlayerSurface` subscribes and toggles
 * the `player-chrome-hidden` class. Default is visible; `reset()` restores
 * the default when a player session ends.
 */

import type { Unsubscribe } from "./types";

export type ChromeControl = {
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  subscribe(cb: () => void): Unsubscribe;
  /** Restore the default (visible) state. Subscriptions stay live. */
  reset(): void;
};

export function createChromeControl(): ChromeControl {
  let hidden = false;
  const listeners = new Set<() => void>();
  const setHidden = (next: boolean): void => {
    if (hidden === next) return;
    hidden = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    setHidden,
    isHidden: () => hidden,
    subscribe(cb: () => void): Unsubscribe {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    reset: () => setHidden(false),
  };
}

/** Player session is a singleton — the default mirrors the Rust session. */
export const chromeControl: ChromeControl = createChromeControl();
