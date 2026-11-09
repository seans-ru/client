import { describe, expect, it } from "vitest";
import {
  debandDenoise,
  debandDenoiseCommands,
  debandDenoiseDisposeCommands,
  denoiseFilter,
  denoiseWarning,
  DENOISE_LABEL,
  DEBAND_PRESET_PARAMS,
  isSlowCpu,
  labelRef,
  MPV_DEFAULT_DEBAND,
  parseDebandPreset,
  parseDenoisePreset,
  resolveDenoisePreset,
  SLOW_CPU_MAX_CORES,
  createDebandDenoiseController,
  createDebandDenoiseSettings,
} from "../src/features/player/extensions/debandDenoise";
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

const FULL_STATE = {
  debandEnabled: true,
  debandPreset: "standard" as const,
  denoiseEnabled: true,
  denoisePreset: "standard" as const,
};

describe("parseDebandPreset / parseDenoisePreset", () => {
  it("keeps known presets and falls back to standard", () => {
    expect(parseDebandPreset("soft")).toBe("soft");
    expect(parseDebandPreset("strong")).toBe("strong");
    expect(parseDebandPreset("standard")).toBe("standard");
    expect(parseDebandPreset("heavy")).toBe("standard");
    expect(parseDebandPreset(null)).toBe("standard");

    expect(parseDenoisePreset("soft")).toBe("soft");
    expect(parseDenoisePreset("strong")).toBe("strong");
    expect(parseDenoisePreset(7)).toBe("standard");
    expect(parseDenoisePreset(undefined)).toBe("standard");
  });
});

describe("DEBAND_PRESET_PARAMS", () => {
  it("steps the strength around the mpv defaults", () => {
    expect(DEBAND_PRESET_PARAMS.standard).toEqual(MPV_DEFAULT_DEBAND);
    expect(DEBAND_PRESET_PARAMS.soft.threshold).toBeLessThan(
      DEBAND_PRESET_PARAMS.standard.threshold,
    );
    expect(DEBAND_PRESET_PARAMS.strong.threshold).toBeGreaterThan(
      DEBAND_PRESET_PARAMS.standard.threshold,
    );
    // More iterations, compensated radius (mpv manual).
    expect(DEBAND_PRESET_PARAMS.strong.iterations).toBeGreaterThan(
      DEBAND_PRESET_PARAMS.standard.iterations,
    );
    expect(DEBAND_PRESET_PARAMS.strong.range).toBeLessThan(
      DEBAND_PRESET_PARAMS.standard.range,
    );
  });

  it("uses the mpv option vocabulary from the issue", () => {
    for (const params of Object.values(DEBAND_PRESET_PARAMS)) {
      expect(Object.keys(params).sort()).toEqual([
        "grain",
        "iterations",
        "range",
        "threshold",
      ]);
    }
  });
});

describe("denoiseFilter", () => {
  it("steps the hqdn3d strength under one shared label", () => {
    expect(denoiseFilter("standard")).toBe(
      `@${DENOISE_LABEL}:lavfi=[hqdn3d=4:3:6:4.5]`,
    );
    expect(denoiseFilter("soft")).toContain("hqdn3d=2:1.5:3:2.25]");
    expect(denoiseFilter("strong")).toContain("hqdn3d=8:6:12:9]");
    for (const preset of ["soft", "standard", "strong"] as const) {
      expect(denoiseFilter(preset).startsWith(`@${DENOISE_LABEL}:`)).toBe(true);
    }
    expect(denoiseFilter("soft")).not.toBe(denoiseFilter("standard"));
    expect(denoiseFilter("standard")).not.toBe(denoiseFilter("strong"));
  });
});

describe("slow CPU guard", () => {
  it("flags machines at or below the core threshold", () => {
    expect(SLOW_CPU_MAX_CORES).toBe(2);
    expect(isSlowCpu(1)).toBe(true);
    expect(isSlowCpu(2)).toBe(true);
    expect(isSlowCpu(4)).toBe(false);
    expect(isSlowCpu(0)).toBe(false);
    expect(isSlowCpu(Number.NaN)).toBe(false);
  });

  it("caps the strong preset to standard on slow machines", () => {
    expect(resolveDenoisePreset("strong", 2)).toBe("standard");
    expect(resolveDenoisePreset("strong", 8)).toBe("strong");
    expect(resolveDenoisePreset("soft", 2)).toBe("soft");
    expect(resolveDenoisePreset("standard", 1)).toBe("standard");
  });

  it("warns only when the cap is active", () => {
    expect(denoiseWarning("strong", 2)).toContain("Слабый CPU");
    expect(denoiseWarning("strong", 8)).toBeNull();
    expect(denoiseWarning("standard", 1)).toBeNull();
    expect(denoiseWarning("soft", 1)).toBeNull();
  });
});

describe("debandDenoiseCommands", () => {
  it("sets the deband option family and the named filter", () => {
    expect(debandDenoiseCommands(FULL_STATE, 8)).toEqual([
      { op: "set", name: "deband", value: true },
      { op: "set", name: "deband-iterations", value: 1 },
      { op: "set", name: "deband-threshold", value: 48 },
      { op: "set", name: "deband-range", value: 16 },
      { op: "set", name: "deband-grain", value: 32 },
      {
        op: "filter",
        filterOp: "add",
        entry: denoiseFilter("standard"),
      },
    ]);
  });

  it("turns deband off with the mpv defaults and removes the filter", () => {
    expect(
      debandDenoiseCommands(
        {
          debandEnabled: false,
          debandPreset: "strong",
          denoiseEnabled: false,
          denoisePreset: "strong",
        },
        8,
      ),
    ).toEqual([
      { op: "set", name: "deband", value: false },
      { op: "set", name: "deband-iterations", value: 1 },
      { op: "set", name: "deband-threshold", value: 48 },
      { op: "set", name: "deband-range", value: 16 },
      { op: "set", name: "deband-grain", value: 32 },
      { op: "filter", filterOp: "remove", entry: labelRef(DENOISE_LABEL) },
    ]);
  });

  it("applies the strong deband preset parameters", () => {
    const commands = debandDenoiseCommands(
      {
        debandEnabled: true,
        debandPreset: "strong",
        denoiseEnabled: false,
        denoisePreset: "standard",
      },
      8,
    );
    expect(commands).toContainEqual({
      op: "set",
      name: "deband-iterations",
      value: 2,
    });
    expect(commands).toContainEqual({
      op: "set",
      name: "deband-threshold",
      value: 64,
    });
    expect(commands).toContainEqual({
      op: "set",
      name: "deband-grain",
      value: 48,
    });
  });

  it("caps the strong denoise preset on slow machines", () => {
    const commands = debandDenoiseCommands(
      {
        debandEnabled: false,
        debandPreset: "standard",
        denoiseEnabled: true,
        denoisePreset: "strong",
      },
      2,
    );
    expect(commands).toContainEqual({
      op: "filter",
      filterOp: "add",
      entry: denoiseFilter("standard"),
    });
    expect(commands).not.toContainEqual({
      op: "filter",
      filterOp: "add",
      entry: denoiseFilter("strong"),
    });
  });
});

describe("debandDenoiseDisposeCommands", () => {
  it("returns deband to the mpv defaults and drops the filter", () => {
    expect(debandDenoiseDisposeCommands()).toEqual([
      { op: "set", name: "deband", value: false },
      { op: "set", name: "deband-iterations", value: 1 },
      { op: "set", name: "deband-threshold", value: 48 },
      { op: "set", name: "deband-range", value: 16 },
      { op: "set", name: "deband-grain", value: 32 },
      { op: "filter", filterOp: "remove", entry: labelRef(DENOISE_LABEL) },
    ]);
  });
});

describe("createDebandDenoiseSettings", () => {
  it("round-trips state through storage and notifies subscribers", () => {
    const storage = makeStorage();
    const settings = createDebandDenoiseSettings(storage);
    const seen: Array<[boolean, string, boolean, string]> = [];
    settings.subscribe(() =>
      seen.push([
        settings.getDebandEnabled(),
        settings.getDebandPreset(),
        settings.getDenoiseEnabled(),
        settings.getDenoisePreset(),
      ]),
    );

    settings.setDebandEnabled(true);
    settings.setDebandPreset("soft");
    settings.setDenoiseEnabled(true);
    settings.setDenoisePreset("strong");
    expect(seen).toEqual([
      [true, "standard", false, "standard"],
      [true, "soft", false, "standard"],
      [true, "soft", true, "standard"],
      [true, "soft", true, "strong"],
    ]);
    expect(storage.get("debandEnabled", false)).toBe(true);
    expect(storage.get("debandPreset", "standard")).toBe("soft");
    expect(storage.get("denoiseEnabled", false)).toBe(true);
    expect(storage.get("denoisePreset", "standard")).toBe("strong");
  });

  it("restores persisted state and sanitizes broken values", () => {
    const settings = createDebandDenoiseSettings(
      makeStorage({
        debandEnabled: true,
        debandPreset: "strong",
        denoiseEnabled: true,
        denoisePreset: "soft",
      }),
    );
    expect(settings.getDebandEnabled()).toBe(true);
    expect(settings.getDebandPreset()).toBe("strong");
    expect(settings.getDenoiseEnabled()).toBe(true);
    expect(settings.getDenoisePreset()).toBe("soft");

    const broken = createDebandDenoiseSettings(
      makeStorage({ debandPreset: "heavy", denoisePreset: 3 }),
    );
    expect(broken.getDebandEnabled()).toBe(false);
    expect(broken.getDebandPreset()).toBe("standard");
    expect(broken.getDenoiseEnabled()).toBe(false);
    expect(broken.getDenoisePreset()).toBe("standard");
  });
});

describe("createDebandDenoiseController", () => {
  it("applies both blocks on change and reverts on dispose", () => {
    const mpv = makeMpv();
    const controller = createDebandDenoiseController(mpv, makeStorage(), 8);

    controller.settings.setDebandEnabled(true);
    expect(mpv.sets).toEqual([
      ["deband", true],
      ["deband-iterations", 1],
      ["deband-threshold", 48],
      ["deband-range", 16],
      ["deband-grain", 32],
    ]);
    expect(vfCalls(mpv)).toEqual([["remove", labelRef(DENOISE_LABEL)]]);

    mpv.sets.length = 0;
    mpv.calls.length = 0;
    controller.settings.setDenoiseEnabled(true);
    controller.settings.setDenoisePreset("soft");
    // Same label — the new filter replaces the old one in place.
    expect(vfCalls(mpv)).toEqual([
      ["add", denoiseFilter("standard")],
      ["add", denoiseFilter("soft")],
    ]);

    mpv.sets.length = 0;
    mpv.calls.length = 0;
    controller.dispose();
    expect(mpv.sets).toEqual([
      ["deband", false],
      ["deband-iterations", 1],
      ["deband-threshold", 48],
      ["deband-range", 16],
      ["deband-grain", 32],
    ]);
    expect(vfCalls(mpv)).toEqual([["remove", labelRef(DENOISE_LABEL)]]);

    // Settings changes after dispose no longer touch mpv.
    mpv.sets.length = 0;
    mpv.calls.length = 0;
    controller.settings.setDenoiseEnabled(true);
    expect(mpv.sets).toEqual([]);
    expect(mpv.calls).toEqual([]);
  });

  it("never applies the strong denoise filter on a slow machine", () => {
    const mpv = makeMpv();
    const controller = createDebandDenoiseController(mpv, makeStorage(), 2);
    controller.settings.setDenoiseEnabled(true);
    controller.settings.setDenoisePreset("strong");
    expect(vfCalls(mpv).at(-1)).toEqual(["add", denoiseFilter("standard")]);
    controller.dispose();
  });

  it("survives mpv rejects without throwing", () => {
    const mpv: MpvBridge = {
      getProperty: async () => "",
      setProperty: async () => {
        throw new Error("deband is not available");
      },
      command: async () => {
        throw new Error("vf is not available");
      },
    };
    const controller = createDebandDenoiseController(mpv, makeStorage(), 8);
    expect(() => controller.settings.setDebandEnabled(true)).not.toThrow();
    expect(() => controller.apply()).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });
});

describe("debandDenoise extension (registry scenarios)", () => {
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
    const runtime = createExtensionRuntime([debandDenoise], deps);
    return { mpv, runtime, storage };
  }

  it("re-applies the settings after each file open", () => {
    const { mpv, runtime } = setup(
      makeStorage({
        debandEnabled: true,
        debandPreset: "soft",
        denoiseEnabled: true,
        denoisePreset: "soft",
      }),
    );
    mpv.sets.length = 0;
    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(mpv.sets).toEqual([
      ["deband", true],
      ["deband-iterations", 1],
      ["deband-threshold", 32],
      ["deband-range", 16],
      ["deband-grain", 16],
    ]);
    expect(vfCalls(mpv)).toEqual([["add", denoiseFilter("soft")]]);

    mpv.sets.length = 0;
    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///b.mkv", startAt: null, source: "vod" });
    expect(vfCalls(mpv)).toEqual([["add", denoiseFilter("soft")]]);
    runtime.dispose();
  });

  it("starts disabled and restores the mpv defaults on dispose", () => {
    const { mpv, runtime } = setup();
    mpv.sets.length = 0;
    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(mpv.sets).toEqual([
      ["deband", false],
      ["deband-iterations", 1],
      ["deband-threshold", 48],
      ["deband-range", 16],
      ["deband-grain", 32],
    ]);
    expect(vfCalls(mpv)).toEqual([["remove", labelRef(DENOISE_LABEL)]]);

    mpv.sets.length = 0;
    mpv.calls.length = 0;
    runtime.dispose();
    expect(mpv.sets).toEqual([
      ["deband", false],
      ["deband-iterations", 1],
      ["deband-threshold", 48],
      ["deband-range", 16],
      ["deband-grain", 32],
    ]);
    expect(vfCalls(mpv)).toEqual([["remove", labelRef(DENOISE_LABEL)]]);
  });

  it("keeps the vf chain free of other extensions' filters", () => {
    const { mpv, runtime } = setup(
      makeStorage({ denoiseEnabled: true, denoisePreset: "standard" }),
    );
    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    for (const [op, entry] of vfCalls(mpv)) {
      if (op === "add") {
        expect(entry.startsWith(`@${DENOISE_LABEL}:`)).toBe(true);
        expect(entry).not.toContain("unsharp");
        expect(entry).not.toContain("firequalizer");
      } else {
        expect(entry).toBe(labelRef(DENOISE_LABEL));
      }
    }
    runtime.dispose();
  });

  it("contributes the settings row to the settings.menu slot", () => {
    const { runtime } = setup();
    const entries = runtime.getSlotEntries("settings.menu");
    expect(entries).toHaveLength(1);
    expect(entries[0].extId).toBe("deband-denoise");
    expect(typeof entries[0].render()).toBe("object");
    runtime.dispose();
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(0);
  });
});
