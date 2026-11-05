import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampDelaySec,
  DEFAULT_DELAY_SEC,
  MAX_DELAY_SEC,
  MIN_DELAY_SEC,
  shouldHideChrome,
} from "../src/features/player/extensions/autoHidePolicy";
import {
  autoHide,
  startActivityListener,
} from "../src/features/player/extensions/autoHide";
import {
  createExtensionRuntime,
  type ExtensionRuntimeDeps,
} from "../src/features/player/extensions/registry";
import type { ExtensionStorage } from "../src/features/player/extensions/types";
import { DEFAULT_SNAPSHOT } from "../src/features/player/playerTypes";

describe("shouldHideChrome", () => {
  const playing = {
    neverHide: false,
    fileLoaded: true,
    pause: false,
    eof: false,
  };

  it("hides during active playback", () => {
    expect(shouldHideChrome(playing)).toBe(true);
  });

  it("keeps chrome visible on pause, eof, without a file and with «Не скрывать»", () => {
    expect(shouldHideChrome({ ...playing, pause: true })).toBe(false);
    expect(shouldHideChrome({ ...playing, eof: true })).toBe(false);
    expect(shouldHideChrome({ ...playing, fileLoaded: false })).toBe(false);
    expect(shouldHideChrome({ ...playing, neverHide: true })).toBe(false);
  });
});

describe("clampDelaySec", () => {
  it("keeps in-range values and rounds fractional ones", () => {
    expect(clampDelaySec(3)).toBe(3);
    expect(clampDelaySec(MIN_DELAY_SEC)).toBe(MIN_DELAY_SEC);
    expect(clampDelaySec(MAX_DELAY_SEC)).toBe(MAX_DELAY_SEC);
    expect(clampDelaySec(5.6)).toBe(6);
  });

  it("clamps out-of-range values and falls back to the default", () => {
    expect(clampDelaySec(0)).toBe(MIN_DELAY_SEC);
    expect(clampDelaySec(1)).toBe(MIN_DELAY_SEC);
    expect(clampDelaySec(99)).toBe(MAX_DELAY_SEC);
    expect(clampDelaySec(null)).toBe(DEFAULT_DELAY_SEC);
    expect(clampDelaySec(undefined)).toBe(DEFAULT_DELAY_SEC);
    expect(clampDelaySec(Number.NaN)).toBe(DEFAULT_DELAY_SEC);
  });
});

describe("startActivityListener", () => {
  it("fires on pointer/key/wheel activity and stops after unsubscribe", () => {
    const target = new EventTarget();
    const cb = vi.fn();
    const stop = startActivityListener(target, cb);
    for (const type of ["pointermove", "pointerdown", "keydown", "wheel"]) {
      target.dispatchEvent(new Event(type));
    }
    expect(cb).toHaveBeenCalledTimes(4);
    stop();
    target.dispatchEvent(new Event("pointermove"));
    expect(cb).toHaveBeenCalledTimes(4);
  });
});

/** Mutable player state the fake host reports through `getSnapshot`. */
function makeHost(overrides: Partial<ExtensionRuntimeDeps> = {}) {
  const snapshot = { ...DEFAULT_SNAPSHOT };
  const hiddenCalls: boolean[] = [];
  const store = new Map<string, unknown>();
  const storage: ExtensionStorage = {
    get: <T,>(key: string, fallback: T): T =>
      (store.has(key) ? (store.get(key) as T) : fallback),
    set: (key, value) => {
      store.set(key, value);
    },
  };
  const deps: ExtensionRuntimeDeps = {
    transport: {
      play: async () => {},
      pause: async () => {},
      togglePause: async () => {},
      seek: async () => {},
      setSpeed: async () => {},
      setVolume: async () => {},
      setMute: async () => {},
      setFullscreen: async () => {},
    },
    getSnapshot: () => snapshot,
    mpv: {
      getProperty: async () => "",
      setProperty: async () => {},
      command: async () => null,
    },
    frames: { subscribe: () => () => {} },
    storageFor: () => storage,
    setChromeHidden: (hidden) => hiddenCalls.push(hidden),
    ...overrides,
  };
  const host = {
    deps,
    hiddenCalls,
    store,
    snapshot,
    runtime: null as ReturnType<typeof createExtensionRuntime> | null,
    /** Emulate a `player://state` event. */
    emit(next: Partial<typeof DEFAULT_SNAPSHOT>) {
      Object.assign(snapshot, next);
      host.runtime?.notifySnapshot(snapshot);
    },
  };
  return host;
}

describe("autoHide extension (registry scenarios)", () => {
  const realWindow = globalThis.window;

  afterEach(() => {
    vi.useRealTimers();
    if (realWindow === undefined) {
      vi.unstubAllGlobals();
    } else {
      globalThis.window = realWindow;
    }
    vi.restoreAllMocks();
  });

  function setup(overrides: Partial<ExtensionRuntimeDeps> = {}) {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    const host = makeHost(overrides);
    host.runtime = createExtensionRuntime([autoHide], host.deps);
    return host;
  }

  function fireActivity() {
    (globalThis.window as unknown as EventTarget).dispatchEvent(
      new Event("pointermove"),
    );
  }

  it("hides after the default delay while playing, activity shows it again", () => {
    const host = setup();
    host.emit({ file_loaded: true, pause: false });
    vi.advanceTimersByTime(2999);
    expect(host.hiddenCalls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(host.hiddenCalls).toEqual([true]);

    fireActivity();
    expect(host.hiddenCalls).toEqual([true, false]);
    // Countdown restarts after activity.
    vi.advanceTimersByTime(3000);
    expect(host.hiddenCalls).toEqual([true, false, true]);
    host.runtime?.dispose();
  });

  it("position ticks do not extend the idle deadline", () => {
    const host = setup();
    host.emit({ file_loaded: true, pause: false });
    // Frequent `player://state` ticks must not re-arm the countdown:
    // the hide happens at the original deadline, not tick + delay.
    vi.advanceTimersByTime(1000);
    host.emit({ position: 1 });
    vi.advanceTimersByTime(1000);
    host.emit({ position: 2 });
    vi.advanceTimersByTime(1000);
    expect(host.hiddenCalls).toEqual([true]);
    host.runtime?.dispose();
  });

  it("respects a custom delay from storage", () => {
    const host = setup({
      storageFor: () => ({
        get: <T,>(key: string, fallback: T): T =>
          (key === "delaySec" ? 2 : fallback) as T,
        set: () => {},
      }),
    });
    host.emit({ file_loaded: true, pause: false });
    vi.advanceTimersByTime(1999);
    expect(host.hiddenCalls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(host.hiddenCalls).toEqual([true]);
    host.runtime?.dispose();
  });

  it("never hides while paused and hides again after resume", () => {
    const host = setup();
    host.emit({ file_loaded: true, pause: false });
    vi.advanceTimersByTime(3000);
    expect(host.hiddenCalls).toEqual([true]);

    host.emit({ pause: true });
    expect(host.hiddenCalls).toEqual([true, false]);
    vi.advanceTimersByTime(10_000);
    expect(host.hiddenCalls).toEqual([true, false]);

    host.emit({ pause: false });
    vi.advanceTimersByTime(3000);
    expect(host.hiddenCalls).toEqual([true, false, true]);
    host.runtime?.dispose();
  });

  it("«Не скрывать» keeps the chrome visible", () => {
    const host = setup({
      storageFor: () => ({
        get: <T,>(key: string, fallback: T): T =>
          (key === "neverHide" ? true : fallback) as T,
        set: () => {},
      }),
    });
    host.emit({ file_loaded: true, pause: false });
    vi.advanceTimersByTime(60_000);
    expect(host.hiddenCalls).toEqual([]);
    host.runtime?.dispose();
  });

  it("dispose restores visibility and stops the timer", () => {
    const host = setup();
    host.emit({ file_loaded: true, pause: false });
    vi.advanceTimersByTime(3000);
    expect(host.hiddenCalls).toEqual([true]);
    host.runtime?.dispose();
    expect(host.hiddenCalls).toEqual([true, false]);
    vi.advanceTimersByTime(10_000);
    expect(host.hiddenCalls).toEqual([true, false]);
    // Listeners are gone — activity no longer affects anything.
    fireActivity();
    expect(host.hiddenCalls).toEqual([true, false]);
  });

  it("does not hide without a loaded file", () => {
    const host = setup();
    vi.advanceTimersByTime(60_000);
    expect(host.hiddenCalls).toEqual([]);
    host.runtime?.dispose();
  });
});
