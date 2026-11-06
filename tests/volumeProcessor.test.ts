import { describe, expect, it, vi } from "vitest";
import {
  createVolumeController,
  createVolumeSettings,
  labelRef,
  LOUDNORM_FILTER,
  LOUDNORM_LABEL,
  NIGHT_LABEL,
  nightFilter,
  parseNightMode,
  volumeFilterCommands,
  volumeProcessor,
} from "../src/features/player/extensions/volumeProcessor";
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
      (store.has(key) ? (store.get(key) as T) : fallback),
    set: (key, value) => {
      store.set(key, value);
    },
  };
}

function makeMpv(): MpvBridge & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    getProperty: async () => "",
    setProperty: async () => {},
    command: async (args: string[]) => {
      calls.push([...args]);
      return null;
    },
  };
}

function afCalls(mpv: { calls: string[][] }): Array<[string, string]> {
  return mpv.calls.map((args) => {
    expect(args[0]).toBe("af");
    return [args[1], args[2]];
  });
}

describe("parseNightMode", () => {
  it("keeps known modes and falls back to off", () => {
    expect(parseNightMode("soft")).toBe("soft");
    expect(parseNightMode("strong")).toBe("strong");
    expect(parseNightMode("off")).toBe("off");
    expect(parseNightMode("")).toBe("off");
    expect(parseNightMode("loud")).toBe("off");
    expect(parseNightMode(null)).toBe("off");
    expect(parseNightMode(undefined)).toBe("off");
  });
});

describe("volumeFilterCommands", () => {
  it("removes both filters when everything is off", () => {
    expect(
      volumeFilterCommands({ normalization: false, nightMode: "off" }),
    ).toEqual([
      { op: "remove", entry: labelRef(LOUDNORM_LABEL) },
      { op: "remove", entry: labelRef(NIGHT_LABEL) },
    ]);
  });

  it("adds loudnorm with EBU R128 cinema targets and removes night", () => {
    expect(
      volumeFilterCommands({ normalization: true, nightMode: "off" }),
    ).toEqual([
      { op: "add", entry: LOUDNORM_FILTER },
      { op: "remove", entry: labelRef(NIGHT_LABEL) },
    ]);
    expect(LOUDNORM_FILTER).toBe(
      `@${LOUDNORM_LABEL}:lavfi=[loudnorm=I=-16:TP=-1.5:LRA=11]`,
    );
  });

  it("runs both modes at once with distinct labels", () => {
    const commands = volumeFilterCommands({
      normalization: true,
      nightMode: "strong",
    });
    expect(commands).toEqual([
      { op: "add", entry: LOUDNORM_FILTER },
      { op: "add", entry: nightFilter("strong") },
    ]);
    expect(LOUDNORM_LABEL).not.toBe(NIGHT_LABEL);
    expect(nightFilter("soft")).toContain(`@${NIGHT_LABEL}:lavfi=[acompressor=`);
    expect(nightFilter("strong")).toContain(`@${NIGHT_LABEL}:lavfi=[acompressor=`);
    // Presets differ by threshold/ratio (issue: «пресеты мягкий/сильный»).
    expect(nightFilter("soft")).toContain("ratio=2");
    expect(nightFilter("strong")).toContain("ratio=8");
    expect(nightFilter("soft")).not.toBe(nightFilter("strong"));
  });

  it("keeps the same night label across presets so switching replaces", () => {
    expect(nightFilter("soft").startsWith(`@${NIGHT_LABEL}:`)).toBe(true);
    expect(nightFilter("strong").startsWith(`@${NIGHT_LABEL}:`)).toBe(true);
  });
});

describe("createVolumeSettings", () => {
  it("round-trips state through storage and notifies subscribers", () => {
    const storage = makeStorage();
    const settings = createVolumeSettings(storage);
    const seen: Array<[boolean, string]> = [];
    settings.subscribe(() =>
      seen.push([settings.getNormalization(), settings.getNightMode()]),
    );

    settings.setNormalization(true);
    settings.setNightMode("soft");
    expect(seen).toEqual([
      [true, "off"],
      [true, "soft"],
    ]);
    expect(storage.get("normalization", false)).toBe(true);
    expect(storage.get("nightMode", "off")).toBe("soft");
  });

  it("restores persisted state and sanitizes the night mode", () => {
    const settings = createVolumeSettings(
      makeStorage({ normalization: true, nightMode: "strong" }),
    );
    expect(settings.getNormalization()).toBe(true);
    expect(settings.getNightMode()).toBe("strong");

    const broken = createVolumeSettings(
      makeStorage({ normalization: 1, nightMode: "nonsense" }),
    );
    expect(broken.getNormalization()).toBe(true);
    expect(broken.getNightMode()).toBe("off");
  });

  it("unsubscribes cleanly", () => {
    const settings = createVolumeSettings(makeStorage());
    const cb = vi.fn();
    const stop = settings.subscribe(cb);
    settings.setNormalization(true);
    stop();
    settings.setNormalization(false);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("createVolumeController", () => {
  it("applies filters on settings change and reverts on dispose", () => {
    const mpv = makeMpv();
    const controller = createVolumeController(mpv, makeStorage());

    controller.settings.setNormalization(true);
    expect(afCalls(mpv)).toEqual([
      ["add", LOUDNORM_FILTER],
      ["remove", labelRef(NIGHT_LABEL)],
    ]);

    mpv.calls.length = 0;
    controller.settings.setNightMode("soft");
    expect(afCalls(mpv)).toEqual([
      ["add", LOUDNORM_FILTER],
      ["add", nightFilter("soft")],
    ]);

    mpv.calls.length = 0;
    controller.settings.setNightMode("strong");
    expect(afCalls(mpv)).toEqual([
      ["add", LOUDNORM_FILTER],
      ["add", nightFilter("strong")],
    ]);

    mpv.calls.length = 0;
    controller.dispose();
    expect(afCalls(mpv)).toEqual([
      ["remove", labelRef(LOUDNORM_LABEL)],
      ["remove", labelRef(NIGHT_LABEL)],
    ]);

    // Settings changes after dispose no longer touch mpv.
    mpv.calls.length = 0;
    controller.settings.setNormalization(false);
    expect(mpv.calls).toEqual([]);
  });

  it("survives mpv rejects without throwing", () => {
    const mpv: MpvBridge = {
      getProperty: async () => "",
      setProperty: async () => {},
      command: async () => {
        throw new Error("af is not available");
      },
    };
    const controller = createVolumeController(mpv, makeStorage());
    expect(() => controller.settings.setNormalization(true)).not.toThrow();
    expect(() => controller.apply()).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });
});

describe("volumeProcessor extension (registry scenarios)", () => {
  function setup(storage: ExtensionStorage = makeStorage()) {
    const mpv = makeMpv();
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
      getSnapshot: () => ({ ...DEFAULT_SNAPSHOT }),
      mpv,
      frames: { subscribe: () => () => {} },
      storageFor: () => storage,
      setChromeHidden: () => {},
    };
    const runtime = createExtensionRuntime([volumeProcessor], deps);
    return { mpv, runtime, storage };
  }

  it("re-applies enabled filters after each file open", () => {
    const { mpv, runtime } = setup(
      makeStorage({ normalization: true, nightMode: "strong" }),
    );
    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(afCalls(mpv)).toEqual([
      ["add", LOUDNORM_FILTER],
      ["add", nightFilter("strong")],
    ]);

    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///b.mkv", startAt: null, source: "vod" });
    expect(afCalls(mpv)).toEqual([
      ["add", LOUDNORM_FILTER],
      ["add", nightFilter("strong")],
    ]);
    runtime.dispose();
  });

  it("starts inert with default settings and restores sound on dispose", () => {
    const { mpv, runtime } = setup();
    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(afCalls(mpv)).toEqual([
      ["remove", labelRef(LOUDNORM_LABEL)],
      ["remove", labelRef(NIGHT_LABEL)],
    ]);

    mpv.calls.length = 0;
    runtime.dispose();
    expect(afCalls(mpv)).toEqual([
      ["remove", labelRef(LOUDNORM_LABEL)],
      ["remove", labelRef(NIGHT_LABEL)],
    ]);
  });

  it("contributes the settings row to the settings.menu slot", () => {
    const { runtime } = setup();
    const entries = runtime.getSlotEntries("settings.menu");
    expect(entries).toHaveLength(1);
    expect(entries[0].extId).toBe("volume-processor");
    expect(typeof entries[0].render()).toBe("object");
    runtime.dispose();
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(0);
  });
});
