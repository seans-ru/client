/**
 * Auto-hide extension (spec: docs/compose/spec/clean-screen.md §S2.3).
 *
 * Hides the player chrome (transport + cursor) after an idle delay while
 * playing — default product behavior, like VLC/mpv. Settings live in the
 * player settings menu («Задержка», «Не скрывать»); visibility itself goes
 * through `ctx.ui.setChromeHidden`. `dispose` restores the chrome.
 */

import {
  useSyncExternalStore,
  type ReactElement,
} from "react";
import type {
  ExtensionStorage,
  PlayerExtension,
  Unsubscribe,
} from "./types";
import {
  clampDelaySec,
  DEFAULT_DELAY_SEC,
  MAX_DELAY_SEC,
  MIN_DELAY_SEC,
  shouldHideChrome,
} from "./autoHidePolicy";

const DELAY_KEY = "delaySec";
const NEVER_HIDE_KEY = "neverHide";

/** Delay chips offered in the settings row (seconds). */
export const DELAY_OPTIONS: readonly number[] = Array.from(
  { length: MAX_DELAY_SEC - MIN_DELAY_SEC + 1 },
  (_, index) => MIN_DELAY_SEC + index,
);

const ACTIVITY_EVENTS = [
  "pointermove",
  "pointerdown",
  "keydown",
  "wheel",
] as const;

/**
 * Surface-level activity that brings the chrome back: any pointer movement,
 * click, key or wheel. `target` is `window` in the app and a plain
 * `EventTarget` in tests.
 */
export function startActivityListener(
  target: EventTarget,
  onActivity: () => void,
): Unsubscribe {
  for (const type of ACTIVITY_EVENTS) {
    if (type === "wheel") {
      target.addEventListener(type, onActivity, { passive: true });
    } else {
      target.addEventListener(type, onActivity);
    }
  }
  return () => {
    for (const type of ACTIVITY_EVENTS) {
      target.removeEventListener(type, onActivity);
    }
  };
}

export type AutoHideSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getDelaySec(): number;
  getNeverHide(): boolean;
  setDelaySec(sec: number): void;
  setNeverHide(next: boolean): void;
};

/** One settings store per storage instance — player row and settings section share state. */
const settingsByStorage = new WeakMap<ExtensionStorage, AutoHideSettings>();

/** Shared settings state for the menu row and the idle timer. */
export function createAutoHideSettings(
  storage: ExtensionStorage,
): AutoHideSettings {
  const cached = settingsByStorage.get(storage);
  if (cached) return cached;
  let delaySec = clampDelaySec(storage.get(DELAY_KEY, DEFAULT_DELAY_SEC));
  let neverHide = Boolean(storage.get(NEVER_HIDE_KEY, false));
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const settings: AutoHideSettings = {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getDelaySec: () => delaySec,
    getNeverHide: () => neverHide,
    setDelaySec(sec) {
      delaySec = clampDelaySec(sec);
      storage.set(DELAY_KEY, delaySec);
      notify();
    },
    setNeverHide(next) {
      neverHide = next;
      storage.set(NEVER_HIDE_KEY, next);
      notify();
    },
  };
  settingsByStorage.set(storage, settings);
  return settings;
}

/** Settings row for auto-hide (player menu + settings screen). */
export function AutoHideRow({
  settings,
}: {
  settings: AutoHideSettings;
}): ReactElement {
  const delaySec = useSyncExternalStore(
    settings.subscribe,
    settings.getDelaySec,
    settings.getDelaySec,
  );
  const neverHide = useSyncExternalStore(
    settings.subscribe,
    settings.getNeverHide,
    settings.getNeverHide,
  );
  return (
    <section>
      <h4 className="player-menu-title">Автоскрытие</h4>
      <div className="player-menu-row">
        {DELAY_OPTIONS.map((sec) => (
          <button
            key={sec}
            type="button"
            role="menuitemradio"
            aria-checked={sec === delaySec}
            className={`player-chip${sec === delaySec ? " player-chip-active" : ""}`}
            onClick={() => settings.setDelaySec(sec)}
          >
            {sec} с
          </button>
        ))}
      </div>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={neverHide}
          className={`player-menu-item${neverHide ? " player-menu-item-active" : ""}`}
          onClick={() => settings.setNeverHide(!neverHide)}
        >
          {neverHide ? "Не скрывать: включено" : "Не скрывать: выключено"}
        </button>
      </div>
    </section>
  );
}

export const autoHide: PlayerExtension = {
  id: "autohide",
  name: "Автоскрытие контролов",
  setup(ctx): Unsubscribe {
    const settings = createAutoHideSettings(ctx.storage);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let hidden = false;

    const policy = (): boolean => {
      const s = ctx.getSnapshot();
      return shouldHideChrome({
        neverHide: settings.getNeverHide(),
        fileLoaded: s.file_loaded,
        pause: s.pause,
        eof: s.eof,
      });
    };

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    /** Toggle the actuator only on real transitions. */
    const show = (): void => {
      if (hidden) {
        hidden = false;
        ctx.ui.setChromeHidden(false);
      }
    };

    const hide = (): void => {
      if (!hidden) {
        hidden = true;
        ctx.ui.setChromeHidden(true);
      }
    };

    /** (Re)start the idle countdown; no-op when hiding is not allowed. */
    const arm = (): void => {
      clearTimer();
      if (!policy()) return;
      timer = setTimeout(() => {
        timer = null;
        if (policy()) hide();
      }, settings.getDelaySec() * 1000);
    };

    /**
     * Re-evaluate chrome visibility. `rearm` restarts the countdown — used
     * for user actions (activity, settings change); snapshot ticks only
     * start a countdown when none is running, so position updates do not
     * keep pushing the deadline away.
     */
    const reconcile = (rearm: boolean): void => {
      if (!policy()) {
        show();
        clearTimer();
        return;
      }
      if (rearm || (timer === null && !hidden)) arm();
    };

    const stopActivity = startActivityListener(window, () => {
      show();
      reconcile(true);
    });
    const stopSnapshot = ctx.onSnapshot(() => reconcile(false));
    const stopSettings = settings.subscribe(() => reconcile(true));
    const stopRow = ctx.ui.add("settings.menu", () => (
      <AutoHideRow settings={settings} />
    ));

    // A file may already be playing when the extension mounts.
    reconcile(false);

    return () => {
      stopRow();
      stopActivity();
      stopSnapshot();
      stopSettings();
      clearTimer();
      show();
    };
  },
};
