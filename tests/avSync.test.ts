import { describe, expect, it, vi } from "vitest";
import {
  AV_SYNC_LIMIT_MS,
  AV_SYNC_STEP_COARSE,
  AV_SYNC_STEP_FINE,
  avSync,
  avSyncPropertyCommands,
  clampDelayMs,
  createAvSyncController,
  createAvSyncSettings,
  formatDelayMs,
  parseDelays,
  parseFileDelays,
} from "../src/features/player/extensions/avSync";
import {
  createExtensionRuntime,
  type ExtensionRuntimeDeps,
} from "../src/features/player/extensions/registry";
import type {
  ExtensionStorage,
  MpvBridge,
} from "../src/features/player/extensions/types";
import { DEFAULT_SNAPSHOT } from "../src/features/player/playerTypes";

function makeStorage(initial: Record<string, unknown> = {}): ExtensionStorage {
  const store = new Map(Object.entries(initial));
  return {
    get: <T,>(key: string, fallback: T): T =>
      store.has(key) ? (store.get(key) as T) : fallback,
    set: (key, value) => {
      store.set(key, value);
    },
  };
}

function makeMpv(): MpvBridge & {
  calls: string[][];
  props: Array<[string, string | number | boolean]>;
} {
  const calls: string[][] = [];
  const props: Array<[string, string | number | boolean]> = [];
  return {
    calls,
    props,
    getProperty: async () => "",
    setProperty: async (name, value) => {
      props.push([name, value]);
    },
    command: async (args: string[]) => {
      calls.push([...args]);
      return null;
    },
  };
}

function makeDeps(mpv: MpvBridge, storage: ExtensionStorage): ExtensionRuntimeDeps {
  return {
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
    getSnapshot: () => ({ ...DEFAULT_SNAPSHOT }),
    mpv,
    frames: { subscribe: () => () => {} },
    storageFor: () => storage,
    setChromeHidden: () => {},
  };
}

describe("clampDelayMs / formatDelayMs", () => {
  it("clamps to the ±limit and rounds to whole ms", () => {
    expect(clampDelayMs(0)).toBe(0);
    expect(clampDelayMs(150)).toBe(150);
    expect(clampDelayMs(-150)).toBe(-150);
    expect(clampDelayMs(99_999)).toBe(AV_SYNC_LIMIT_MS);
    expect(clampDelayMs(-99_999)).toBe(-AV_SYNC_LIMIT_MS);
    expect(clampDelayMs(12.6)).toBe(13);
    expect(clampDelayMs(Number.NaN)).toBe(0);
  });

  it("formats signed values", () => {
    expect(formatDelayMs(150)).toBe("+150");
    expect(formatDelayMs(-50)).toBe("-50");
    expect(formatDelayMs(0)).toBe("0");
  });
});

describe("parse helpers", () => {
  it("sanitizes stored delays", () => {
    expect(parseDelays(null)).toEqual({ audioMs: 0, subMs: 0 });
    expect(parseDelays("junk")).toEqual({ audioMs: 0, subMs: 0 });
    expect(parseDelays({ audioMs: 120, subMs: -40 })).toEqual({
      audioMs: 120,
      subMs: -40,
    });
    expect(parseDelays({ audioMs: "x", subMs: 1e9 })).toEqual({
      audioMs: 0,
      subMs: AV_SYNC_LIMIT_MS,
    });
  });

  it("keeps only valid per-file entries", () => {
    expect(parseFileDelays(null)).toEqual({});
    expect(parseFileDelays([1, 2])).toEqual({});
    expect(parseFileDelays({ "file:///a.mkv": { audioMs: 5, subMs: 6 } })).toEqual({
      "file:///a.mkv": { audioMs: 5, subMs: 6 },
    });
  });
});

describe("avSyncPropertyCommands", () => {
  it("converts ms to mpv seconds", () => {
    expect(
      avSyncPropertyCommands({ audioMs: 150, subMs: -80 }),
    ).toEqual([
      { name: "audio-delay", value: 0.15 },
      { name: "sub-delay", value: -0.08 },
    ]);
    expect(avSyncPropertyCommands({ audioMs: 0, subMs: 0 })).toEqual([
      { name: "audio-delay", value: 0 },
      { name: "sub-delay", value: 0 },
    ]);
  });

  it("clamps inside the command values", () => {
    const [{ value }] = avSyncPropertyCommands({
      audioMs: 1e9,
      subMs: 0,
    });
    expect(value).toBe(AV_SYNC_LIMIT_MS / 1000);
  });
});

describe("createAvSyncSettings", () => {
  it("adjusts with coarse and fine steps and resets to 0", () => {
    const settings = createAvSyncSettings(makeStorage());
    settings.adjustAudio(AV_SYNC_STEP_COARSE);
    settings.adjustSub(AV_SYNC_STEP_FINE);
    settings.adjustSub(-AV_SYNC_STEP_FINE);
    expect(settings.getAudioMs()).toBe(50);
    expect(settings.getSubMs()).toBe(0);
    settings.adjustAudio(-AV_SYNC_STEP_COARSE);
    settings.adjustSub(AV_SYNC_STEP_COARSE);
    expect(settings.getAudioMs()).toBe(0);
    expect(settings.getSubMs()).toBe(50);
    settings.reset();
    expect(settings.getAudioMs()).toBe(0);
    expect(settings.getSubMs()).toBe(0);
  });

  it("resets a single track without touching the other", () => {
    const settings = createAvSyncSettings(makeStorage());
    settings.adjustAudio(100);
    settings.adjustSub(-100);
    settings.resetAudio();
    expect(settings.getAudioMs()).toBe(0);
    expect(settings.getSubMs()).toBe(-100);
    settings.resetSub();
    expect(settings.getSubMs()).toBe(0);
  });

  it("restores the per-file shift on reopen; per-file wins over the default", () => {
    const storage = makeStorage();
    const settings = createAvSyncSettings(storage);
    settings.saveAsDefault();
    settings.openFile("file:///a.mkv");
    settings.adjustAudio(200);
    settings.adjustSub(-60);
    // Reopen another file first — falls back to the global default.
    settings.openFile("file:///b.mkv");
    expect(settings.getAudioMs()).toBe(0);
    expect(settings.getSubMs()).toBe(0);
    // Reopen the tuned file — its saved shift is back.
    settings.openFile("file:///a.mkv");
    expect(settings.getAudioMs()).toBe(200);
    expect(settings.getSubMs()).toBe(-60);
  });

  it("per-file memory survives a settings restart", () => {
    const storage = makeStorage();
    const first = createAvSyncSettings(storage);
    first.openFile("file:///a.mkv");
    first.adjustAudio(120);
    const second = createAvSyncSettings(storage);
    second.openFile("file:///a.mkv");
    expect(second.getAudioMs()).toBe(120);
    expect(second.getSubMs()).toBe(0);
  });

  it("saveAsDefault stores the current shift for new files", () => {
    const settings = createAvSyncSettings(makeStorage());
    settings.openFile("file:///a.mkv");
    settings.adjustAudio(-300);
    settings.adjustSub(40);
    settings.saveAsDefault();
    expect(settings.getDefaultAudioMs()).toBe(-300);
    expect(settings.getDefaultSubMs()).toBe(40);
    settings.openFile("file:///fresh.mkv");
    expect(settings.getAudioMs()).toBe(-300);
    expect(settings.getSubMs()).toBe(40);
  });

  it("notifies subscribers and unsubscribes cleanly", () => {
    const settings = createAvSyncSettings(makeStorage());
    const cb = vi.fn();
    const stop = settings.subscribe(cb);
    settings.adjustAudio(AV_SYNC_STEP_FINE);
    stop();
    settings.adjustAudio(AV_SYNC_STEP_FINE);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("createAvSyncController", () => {
  it("applies delays to mpv instantly on change and open", () => {
    const mpv = makeMpv();
    const controller = createAvSyncController(mpv, makeStorage());

    controller.openFile("file:///a.mkv");
    mpv.props.length = 0;
    controller.settings.adjustAudio(150);
    expect(mpv.props).toEqual([
      ["audio-delay", 0.15],
      ["sub-delay", 0],
    ]);

    // Reopening the file restores its per-file shift.
    mpv.props.length = 0;
    controller.openFile("file:///a.mkv");
    expect(mpv.props).toEqual([
      ["audio-delay", 0.15],
      ["sub-delay", 0],
    ]);
    controller.dispose();
  });

  it("dispose restores zero delays", () => {
    const mpv = makeMpv();
    const controller = createAvSyncController(mpv, makeStorage());
    controller.settings.adjustSub(-80);
    mpv.props.length = 0;
    controller.dispose();
    expect(mpv.props).toEqual([
      ["audio-delay", 0],
      ["sub-delay", 0],
    ]);
    // Settings changes after dispose no longer touch mpv.
    mpv.props.length = 0;
    controller.settings.adjustAudio(50);
    expect(mpv.props).toEqual([]);
  });

  it("survives mpv rejects without throwing", () => {
    const mpv: MpvBridge = {
      getProperty: async () => "",
      setProperty: async () => {
        throw new Error("property is not available");
      },
      command: async () => null,
    };
    const controller = createAvSyncController(mpv, makeStorage());
    expect(() => controller.settings.adjustAudio(50)).not.toThrow();
    expect(() => controller.apply()).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });
});

describe("avSync extension (registry scenarios)", () => {
  it("applies the per-file shift on open and falls back to the default", () => {
    const mpv = makeMpv();
    const storage = makeStorage({
      defaults: { audioMs: 10, subMs: 0 },
      files: { "file:///a.mkv": { audioMs: 150, subMs: -80 } },
    });
    const runtime = createExtensionRuntime([avSync], makeDeps(mpv, storage));

    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(mpv.props).toEqual([
      ["audio-delay", 0.15],
      ["sub-delay", -0.08],
    ]);

    // Another file without an override gets the global default (per-file wins).
    mpv.props.length = 0;
    runtime.notifyOpen({ url: "file:///b.mkv", startAt: null, source: "vod" });
    expect(mpv.props).toEqual([
      ["audio-delay", 0.01],
      ["sub-delay", 0],
    ]);

    // Reopening the tuned file restores its own shift again.
    mpv.props.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(mpv.props).toEqual([
      ["audio-delay", 0.15],
      ["sub-delay", -0.08],
    ]);
    runtime.dispose();
  });

  it("contributes the settings section to the settings.menu slot", () => {
    const runtime = createExtensionRuntime(
      [avSync],
      makeDeps(makeMpv(), makeStorage()),
    );
    const entries = runtime.getSlotEntries("settings.menu");
    expect(entries).toHaveLength(1);
    expect(entries[0].extId).toBe("av-sync");
    expect(typeof entries[0].render()).toBe("object");
    runtime.dispose();
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(0);
  });

  it("dispose restores zero delays for the player", () => {
    const mpv = makeMpv();
    const runtime = createExtensionRuntime(
      [avSync],
      makeDeps(mpv, makeStorage()),
    );
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    mpv.props.length = 0;
    runtime.dispose();
    expect(mpv.props).toEqual([
      ["audio-delay", 0],
      ["sub-delay", 0],
    ]);
  });
});
