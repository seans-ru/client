import { describe, expect, it, vi } from "vitest";
import {
  clampGain,
  createEqController,
  createEqSettings,
  EQ_BANDS,
  EQ_BAND_COUNT,
  EQ_LABEL,
  EQ_MAX_GAIN,
  EQ_MIN_GAIN,
  EQ_PRESETS,
  eqFilter,
  eqFilterCommands,
  equalizer,
  initialEqState,
  labelRef,
  parseGains,
  parsePresetId,
} from "../src/features/player/extensions/eq";
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

describe("clampGain / parse helpers", () => {
  it("clamps gains to ±12 dB and non-finite to 0", () => {
    expect(clampGain(0)).toBe(0);
    expect(clampGain(5.5)).toBe(5.5);
    expect(clampGain(20)).toBe(EQ_MAX_GAIN);
    expect(clampGain(-20)).toBe(EQ_MIN_GAIN);
    expect(clampGain(Number.NaN)).toBe(0);
    expect(clampGain(Number.POSITIVE_INFINITY)).toBe(EQ_MAX_GAIN);
  });

  it("keeps known preset ids and falls back to flat", () => {
    expect(parsePresetId("cinema")).toBe("cinema");
    expect(parsePresetId("custom")).toBe("custom");
    expect(parsePresetId("flat")).toBe("flat");
    expect(parsePresetId("nope")).toBe("flat");
    expect(parsePresetId(null)).toBe("flat");
    expect(parsePresetId(undefined)).toBe("flat");
  });

  it("sanitizes stored gains to 10 clamped numbers", () => {
    expect(parseGains(null)).toEqual([...EQ_PRESETS.flat]);
    expect(parseGains("junk")).toEqual([...EQ_PRESETS.flat]);
    expect(parseGains([1, 2])).toHaveLength(EQ_BANDS.length);
    expect(parseGains([50, -50, 0])).toEqual([
      EQ_MAX_GAIN,
      EQ_MIN_GAIN,
      ...[...EQ_PRESETS.flat].slice(2),
    ]);
    expect(parseGains([1, "x", 3, 4, 5, 6, 7, 8, 9, 10, 11])).toEqual([
      1,
      0,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
    ]);
  });
});

describe("eqFilter", () => {
  it("builds a labeled firequalizer with 10 gain entries", () => {
    const filter = eqFilter([...EQ_PRESETS.music]);
    expect(filter.startsWith(`@${EQ_LABEL}:lavfi=[firequalizer=gain_entry='`)).toBe(
      true,
    );
    expect(filter.endsWith("']")).toBe(true);
    for (const freq of EQ_BANDS) {
      expect(filter).toContain(`entry(${freq},`);
    }
    // Ten entry(...) points.
    expect(filter.match(/entry\(/g)).toHaveLength(EQ_BANDS.length);
    // Distinct from the volume-processor labels (coexistence).
    expect(EQ_LABEL).not.toBe("seans-vp-loudnorm");
    expect(EQ_LABEL).not.toBe("seans-vp-night");
  });

  it("clamps out-of-range gains in the filter string", () => {
    expect(eqFilter([99, -99, ...[...EQ_PRESETS.flat].slice(2)])).toContain(
      `entry(31,${EQ_MAX_GAIN})`,
    );
    expect(eqFilter([99, -99, ...[...EQ_PRESETS.flat].slice(2)])).toContain(
      `entry(63,${EQ_MIN_GAIN})`,
    );
  });
});

describe("eqFilterCommands", () => {
  it("removes the filter when disabled", () => {
    expect(
      eqFilterCommands({
        enabled: false,
        preset: "flat",
        gains: [...EQ_PRESETS.flat],
      }),
    ).toEqual([{ op: "remove", entry: labelRef(EQ_LABEL) }]);
  });

  it("adds the labeled filter when enabled", () => {
    const gains = [...EQ_PRESETS.night];
    expect(
      eqFilterCommands({ enabled: true, preset: "night", gains }),
    ).toEqual([{ op: "add", entry: eqFilter(gains) }]);
  });
});

describe("initialEqState", () => {
  it("defaults to disabled flat curve", () => {
    expect(initialEqState(makeStorage())).toEqual({
      enabled: false,
      preset: "flat",
      gains: [...EQ_PRESETS.flat],
    });
  });

  it("restores a named preset from its curve, not stale gains", () => {
    const state = initialEqState(
      makeStorage({
        enabled: true,
        preset: "cinema",
        gains: [9, 9, 9, 9, 9, 9, 9, 9, 9, 9],
      }),
    );
    expect(state.enabled).toBe(true);
    expect(state.preset).toBe("cinema");
    expect(state.gains).toEqual([...EQ_PRESETS.cinema]);
  });

  it("restores custom gains when preset is custom", () => {
    const gains = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const state = initialEqState(
      makeStorage({ enabled: true, preset: "custom", gains }),
    );
    expect(state.preset).toBe("custom");
    expect(state.gains).toEqual(gains);
  });
});

describe("createEqSettings", () => {
  it("round-trips state through storage and notifies subscribers", () => {
    const storage = makeStorage();
    const settings = createEqSettings(storage);
    const seen: Array<[boolean, string]> = [];
    settings.subscribe(() =>
      seen.push([settings.getEnabled(), settings.getPreset()]),
    );

    settings.setEnabled(true);
    settings.setPreset("music");
    expect(seen).toEqual([
      [true, "flat"],
      [true, "music"],
    ]);
    expect(storage.get("enabled", false)).toBe(true);
    expect(storage.get("preset", "flat")).toBe("music");
    expect(storage.get("gains", null)).toEqual([...EQ_PRESETS.music]);
  });

  it("marks the curve custom when a band is moved", () => {
    const settings = createEqSettings(makeStorage());
    settings.setPreset("voice");
    settings.setBandGain(0, 7);
    expect(settings.getPreset()).toBe("custom");
    expect(settings.getGains()[0]).toBe(7);
    expect(settings.getGains()).toEqual([
      7,
      ...[...EQ_PRESETS.voice].slice(1),
    ]);
    // Clamps out-of-range band edits.
    settings.setBandGain(1, 100);
    expect(settings.getGains()[1]).toBe(EQ_MAX_GAIN);
    // Out-of-range index is ignored.
    settings.setBandGain(99, 3);
    expect(settings.getGains()).toHaveLength(EQ_BAND_COUNT);
  });

  it("ignores setPreset('custom') — custom is reached via band edits", () => {
    const settings = createEqSettings(makeStorage());
    settings.setPreset("cinema");
    const before = [...settings.getGains()];
    // Runtime type is EqNamedPreset; defensive path for a bad id.
    settings.setPreset("custom" as never);
    expect(settings.getPreset()).toBe("cinema");
    expect(settings.getGains()).toEqual(before);
  });

  it("restores persisted state", () => {
    const settings = createEqSettings(
      makeStorage({ enabled: true, preset: "night", gains: null }),
    );
    expect(settings.getEnabled()).toBe(true);
    expect(settings.getPreset()).toBe("night");
    expect(settings.getGains()).toEqual([...EQ_PRESETS.night]);
  });

  it("unsubscribes cleanly", () => {
    const settings = createEqSettings(makeStorage());
    const cb = vi.fn();
    const stop = settings.subscribe(cb);
    settings.setEnabled(true);
    stop();
    settings.setEnabled(false);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("createEqController", () => {
  it("applies filters on settings change and reverts on dispose", () => {
    const mpv = makeMpv();
    const controller = createEqController(mpv, makeStorage());

    controller.settings.setEnabled(true);
    expect(afCalls(mpv)).toEqual([
      ["add", eqFilter([...EQ_PRESETS.flat])],
    ]);

    mpv.calls.length = 0;
    controller.settings.setPreset("music");
    expect(afCalls(mpv)).toEqual([
      ["add", eqFilter([...EQ_PRESETS.music])],
    ]);

    mpv.calls.length = 0;
    controller.settings.setBandGain(0, -6);
    expect(afCalls(mpv)).toEqual([["add", eqFilter(controller.settings.getGains())]]);

    mpv.calls.length = 0;
    controller.settings.setEnabled(false);
    expect(afCalls(mpv)).toEqual([["remove", labelRef(EQ_LABEL)]]);

    mpv.calls.length = 0;
    controller.dispose();
    expect(afCalls(mpv)).toEqual([["remove", labelRef(EQ_LABEL)]]);

    // Settings changes after dispose no longer touch mpv.
    mpv.calls.length = 0;
    controller.settings.setEnabled(true);
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
    const controller = createEqController(mpv, makeStorage());
    expect(() => controller.settings.setEnabled(true)).not.toThrow();
    expect(() => controller.apply()).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });
});

describe("equalizer extension (registry scenarios)", () => {
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
    const runtime = createExtensionRuntime([equalizer], deps);
    return { mpv, runtime, storage };
  }

  it("re-applies the enabled filter after each file open", () => {
    const { mpv, runtime } = setup(
      makeStorage({ enabled: true, preset: "cinema" }),
    );
    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(afCalls(mpv)).toEqual([["add", eqFilter([...EQ_PRESETS.cinema])]]);

    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///b.mkv", startAt: null, source: "vod" });
    expect(afCalls(mpv)).toEqual([["add", eqFilter([...EQ_PRESETS.cinema])]]);
    runtime.dispose();
  });

  it("starts inert with default settings and restores sound on dispose", () => {
    const { mpv, runtime } = setup();
    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(afCalls(mpv)).toEqual([["remove", labelRef(EQ_LABEL)]]);

    mpv.calls.length = 0;
    runtime.dispose();
    expect(afCalls(mpv)).toEqual([["remove", labelRef(EQ_LABEL)]]);
  });

  it("contributes the settings section to the settings.menu slot", () => {
    const { runtime } = setup();
    const entries = runtime.getSlotEntries("settings.menu");
    expect(entries).toHaveLength(1);
    expect(entries[0].extId).toBe("eq");
    expect(typeof entries[0].render()).toBe("object");
    runtime.dispose();
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(0);
  });

  it("persists a custom preset across controller restarts", () => {
    const storage = makeStorage();
    const first = createEqController(makeMpv(), storage);
    first.settings.setEnabled(true);
    first.settings.setPreset("flat");
    first.settings.setBandGain(3, 8);
    first.dispose();

    const second = createEqController(makeMpv(), storage);
    expect(second.settings.getEnabled()).toBe(true);
    expect(second.settings.getPreset()).toBe("custom");
    expect(second.settings.getGains()[3]).toBe(8);
    second.dispose();
  });
});
