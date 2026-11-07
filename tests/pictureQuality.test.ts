import { describe, expect, it, vi } from "vitest";
import {
  createPictureController,
  createPictureSettings,
  disposeCommands,
  labelRef,
  MPV_DEFAULT_SCALERS,
  parseScalePreset,
  parseSharpenLevel,
  pictureCommands,
  pictureQuality,
  SCALE_PRESETS,
  SCALE_PRESET_SCALERS,
  sharpenFilter,
  SHARPEN_LABEL,
} from "../src/features/player/extensions/pictureQuality";
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

function makeMpv(): MpvBridge & {
  calls: string[][];
  sets: Array<[string, string | number | boolean]>;
} {
  const calls: string[][] = [];
  const sets: Array<[string, string | number | boolean]> = [];
  return {
    calls,
    sets,
    getProperty: async () => "",
    setProperty: async (name: string, value: string | number | boolean) => {
      sets.push([name, value]);
    },
    command: async (args: string[]) => {
      calls.push([...args]);
      return null;
    },
  };
}

function vfCalls(mpv: { calls: string[][] }): Array<[string, string]> {
  return mpv.calls.map((args) => {
    expect(args[0]).toBe("vf");
    return [args[1], args[2]];
  });
}

describe("parseScalePreset", () => {
  it("keeps known presets and falls back to quality", () => {
    expect(parseScalePreset("fast")).toBe("fast");
    expect(parseScalePreset("quality")).toBe("quality");
    expect(parseScalePreset("max")).toBe("max");
    expect(parseScalePreset("")).toBe("quality");
    expect(parseScalePreset("ultra")).toBe("quality");
    expect(parseScalePreset(null)).toBe("quality");
    expect(parseScalePreset(undefined)).toBe("quality");
  });
});

describe("parseSharpenLevel", () => {
  it("keeps known levels and falls back to off", () => {
    expect(parseSharpenLevel("weak")).toBe("weak");
    expect(parseSharpenLevel("medium")).toBe("medium");
    expect(parseSharpenLevel("strong")).toBe("strong");
    expect(parseSharpenLevel("off")).toBe("off");
    expect(parseSharpenLevel("")).toBe("off");
    expect(parseSharpenLevel("insane")).toBe("off");
    expect(parseSharpenLevel(null)).toBe("off");
    expect(parseSharpenLevel(undefined)).toBe("off");
  });
});

describe("SCALE_PRESET_SCALERS", () => {
  it("steps the load: bilinear -> lanczos/spline36 -> ewa_lanczos", () => {
    expect(SCALE_PRESET_SCALERS.fast).toEqual({
      scale: "bilinear",
      cscale: "bilinear",
      dscale: "bilinear",
    });
    expect(SCALE_PRESET_SCALERS.quality.scale).toBe("lanczos");
    expect(SCALE_PRESET_SCALERS.quality.dscale).toBe("spline36");
    expect(SCALE_PRESET_SCALERS.max).toEqual({
      scale: "ewa_lanczos",
      cscale: "ewa_lanczos",
      dscale: "ewa_lanczos",
    });
  });

  it("uses the scaler vocabulary from the issue across presets", () => {
    const values = SCALE_PRESETS.flatMap((preset) =>
      Object.values(SCALE_PRESET_SCALERS[preset]),
    );
    expect(values).toContain("bilinear");
    expect(values).toContain("lanczos");
    expect(values).toContain("spline36");
    expect(values).toContain("ewa_lanczos");
  });

  it("never touches the render properties (issue: только scale/cscale/dscale)", () => {
    for (const preset of SCALE_PRESETS) {
      expect(Object.keys(SCALE_PRESET_SCALERS[preset]).sort()).toEqual([
        "cscale",
        "dscale",
        "scale",
      ]);
    }
  });
});

describe("sharpenFilter", () => {
  it("steps the unsharp amount under one shared label", () => {
    expect(sharpenFilter("weak")).toBe(
      `@${SHARPEN_LABEL}:lavfi=[unsharp=luma_msize_x=5:luma_msize_y=5:` +
        `luma_amount=0.5]`,
    );
    expect(sharpenFilter("medium")).toContain("luma_amount=1]");
    expect(sharpenFilter("strong")).toContain("luma_amount=2]");
    expect(sharpenFilter("weak")).not.toBe(sharpenFilter("medium"));
    expect(sharpenFilter("medium")).not.toBe(sharpenFilter("strong"));
    for (const level of ["weak", "medium", "strong"] as const) {
      expect(sharpenFilter(level).startsWith(`@${SHARPEN_LABEL}:`)).toBe(true);
      expect(sharpenFilter(level)).toContain("lavfi=[unsharp=");
    }
    // Chroma stays untouched (filter default chroma_amount=0).
    expect(sharpenFilter("strong")).not.toContain("chroma");
  });
});

describe("pictureCommands", () => {
  it("sets quality scalers and drops the filter at default state", () => {
    expect(pictureCommands({ scalePreset: "quality", sharpen: "off" })).toEqual([
      { op: "set", name: "scale", value: "lanczos" },
      { op: "set", name: "cscale", value: "lanczos" },
      { op: "set", name: "dscale", value: "spline36" },
      { op: "filter", filterOp: "remove", entry: labelRef(SHARPEN_LABEL) },
    ]);
  });

  it("combines the max preset with a strong unsharp filter", () => {
    expect(pictureCommands({ scalePreset: "max", sharpen: "strong" })).toEqual([
      { op: "set", name: "scale", value: "ewa_lanczos" },
      { op: "set", name: "cscale", value: "ewa_lanczos" },
      { op: "set", name: "dscale", value: "ewa_lanczos" },
      { op: "filter", filterOp: "add", entry: sharpenFilter("strong") },
    ]);
  });
});

describe("disposeCommands", () => {
  it("returns scalers to the mpv defaults and drops the filter", () => {
    expect(disposeCommands()).toEqual([
      { op: "set", name: "scale", value: "lanczos" },
      { op: "set", name: "cscale", value: "lanczos" },
      { op: "set", name: "dscale", value: "lanczos" },
      { op: "filter", filterOp: "remove", entry: labelRef(SHARPEN_LABEL) },
    ]);
    expect(MPV_DEFAULT_SCALERS).toEqual({
      scale: "lanczos",
      cscale: "lanczos",
      dscale: "lanczos",
    });
  });
});

describe("createPictureSettings", () => {
  it("round-trips state through storage and notifies subscribers", () => {
    const storage = makeStorage();
    const settings = createPictureSettings(storage);
    const seen: Array<[string, string]> = [];
    settings.subscribe(() =>
      seen.push([settings.getScalePreset(), settings.getSharpen()]),
    );

    settings.setScalePreset("max");
    settings.setSharpen("medium");
    expect(seen).toEqual([
      ["max", "off"],
      ["max", "medium"],
    ]);
    expect(storage.get("scalePreset", "quality")).toBe("max");
    expect(storage.get("sharpen", "off")).toBe("medium");
  });

  it("restores persisted state and sanitizes broken values", () => {
    const settings = createPictureSettings(
      makeStorage({ scalePreset: "fast", sharpen: "strong" }),
    );
    expect(settings.getScalePreset()).toBe("fast");
    expect(settings.getSharpen()).toBe("strong");

    const broken = createPictureSettings(
      makeStorage({ scalePreset: "nonsense", sharpen: 7 }),
    );
    expect(broken.getScalePreset()).toBe("quality");
    expect(broken.getSharpen()).toBe("off");
  });

  it("unsubscribes cleanly", () => {
    const settings = createPictureSettings(makeStorage());
    const cb = vi.fn();
    const stop = settings.subscribe(cb);
    settings.setSharpen("weak");
    stop();
    settings.setSharpen("off");
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("createPictureController", () => {
  it("applies scalers and the filter on settings change and reverts on dispose", () => {
    const mpv = makeMpv();
    const controller = createPictureController(mpv, makeStorage());

    controller.settings.setScalePreset("max");
    expect(mpv.sets).toEqual([
      ["scale", "ewa_lanczos"],
      ["cscale", "ewa_lanczos"],
      ["dscale", "ewa_lanczos"],
    ]);
    expect(vfCalls(mpv)).toEqual([["remove", labelRef(SHARPEN_LABEL)]]);

    mpv.sets.length = 0;
    mpv.calls.length = 0;
    controller.settings.setSharpen("strong");
    expect(mpv.sets).toEqual([
      ["scale", "ewa_lanczos"],
      ["cscale", "ewa_lanczos"],
      ["dscale", "ewa_lanczos"],
    ]);
    expect(vfCalls(mpv)).toEqual([["add", sharpenFilter("strong")]]);

    mpv.sets.length = 0;
    mpv.calls.length = 0;
    controller.settings.setSharpen("weak");
    // Same label — the weaker filter replaces the stronger one in place.
    expect(vfCalls(mpv)).toEqual([["add", sharpenFilter("weak")]]);

    mpv.sets.length = 0;
    mpv.calls.length = 0;
    controller.dispose();
    expect(mpv.sets).toEqual([
      ["scale", "lanczos"],
      ["cscale", "lanczos"],
      ["dscale", "lanczos"],
    ]);
    expect(vfCalls(mpv)).toEqual([["remove", labelRef(SHARPEN_LABEL)]]);

    // Settings changes after dispose no longer touch mpv.
    mpv.sets.length = 0;
    mpv.calls.length = 0;
    controller.settings.setSharpen("strong");
    expect(mpv.sets).toEqual([]);
    expect(mpv.calls).toEqual([]);
  });

  it("survives mpv rejects without throwing", () => {
    const mpv: MpvBridge = {
      getProperty: async () => "",
      setProperty: async () => {
        throw new Error("scale is not available");
      },
      command: async () => {
        throw new Error("vf is not available");
      },
    };
    const controller = createPictureController(mpv, makeStorage());
    expect(() => controller.settings.setScalePreset("fast")).not.toThrow();
    expect(() => controller.apply()).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });
});

describe("pictureQuality extension (registry scenarios)", () => {
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
    const runtime = createExtensionRuntime([pictureQuality], deps);
    return { mpv, runtime, storage };
  }

  it("re-applies the picture settings after each file open", () => {
    const { mpv, runtime } = setup(
      makeStorage({ scalePreset: "max", sharpen: "medium" }),
    );
    mpv.sets.length = 0;
    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(mpv.sets).toEqual([
      ["scale", "ewa_lanczos"],
      ["cscale", "ewa_lanczos"],
      ["dscale", "ewa_lanczos"],
    ]);
    expect(vfCalls(mpv)).toEqual([["add", sharpenFilter("medium")]]);

    mpv.sets.length = 0;
    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///b.mkv", startAt: null, source: "vod" });
    expect(mpv.sets).toEqual([
      ["scale", "ewa_lanczos"],
      ["cscale", "ewa_lanczos"],
      ["dscale", "ewa_lanczos"],
    ]);
    expect(vfCalls(mpv)).toEqual([["add", sharpenFilter("medium")]]);
    runtime.dispose();
  });

  it("starts with the default picture and restores mpv defaults on dispose", () => {
    const { mpv, runtime } = setup();
    mpv.sets.length = 0;
    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(mpv.sets).toEqual([
      ["scale", "lanczos"],
      ["cscale", "lanczos"],
      ["dscale", "spline36"],
    ]);
    expect(vfCalls(mpv)).toEqual([["remove", labelRef(SHARPEN_LABEL)]]);

    mpv.sets.length = 0;
    mpv.calls.length = 0;
    runtime.dispose();
    expect(mpv.sets).toEqual([
      ["scale", "lanczos"],
      ["cscale", "lanczos"],
      ["dscale", "lanczos"],
    ]);
    expect(vfCalls(mpv)).toEqual([["remove", labelRef(SHARPEN_LABEL)]]);
  });

  it("contributes the settings row to the settings.menu slot", () => {
    const { runtime } = setup();
    const entries = runtime.getSlotEntries("settings.menu");
    expect(entries).toHaveLength(1);
    expect(entries[0].extId).toBe("picture-quality");
    expect(typeof entries[0].render()).toBe("object");
    runtime.dispose();
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(0);
  });
});
