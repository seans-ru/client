import { describe, expect, it, vi } from "vitest";
import {
  clampTargetPeak,
  createHdrController,
  createHdrInfoStore,
  createHdrSettings,
  HDR_INFO_UNKNOWN,
  hdr,
  hdrCommands,
  hdrDisposeCommands,
  hdrStatusLine,
  isHdrTransfer,
  MPV_DEFAULT_HDR,
  parseHdrMode,
  parseNits,
  parseToneMapping,
  readHdrInfo,
  TARGET_PEAK_DEFAULT,
  TONE_MAPPINGS,
  toneMappingSummary,
  type HdrInfo,
  type HdrState,
} from "../src/features/player/extensions/hdr";
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
  sets: Array<[string, string | number | boolean]>;
  props: Record<string, string>;
} {
  const sets: Array<[string, string | number | boolean]> = [];
  const props: Record<string, string> = {};
  return {
    sets,
    props,
    getProperty: async (name: string) => {
      if (!(name in props)) throw new Error(`no property ${name}`);
      return props[name];
    },
    setProperty: async (name: string, value: string | number | boolean) => {
      sets.push([name, value]);
    },
    command: async () => null,
  };
}

const DEFAULT_STATE: HdrState = {
  mode: "auto",
  algorithm: "auto",
  targetPeak: TARGET_PEAK_DEFAULT,
};

describe("parseHdrMode", () => {
  it("keeps known modes and falls back to auto", () => {
    expect(parseHdrMode("auto")).toBe("auto");
    expect(parseHdrMode("algorithm")).toBe("algorithm");
    expect(parseHdrMode("manual")).toBe("manual");
    expect(parseHdrMode("")).toBe("auto");
    expect(parseHdrMode("custom")).toBe("auto");
    expect(parseHdrMode(null)).toBe("auto");
    expect(parseHdrMode(undefined)).toBe("auto");
  });
});

describe("parseToneMapping", () => {
  it("keeps the issue vocabulary and falls back to auto", () => {
    for (const value of TONE_MAPPINGS) {
      expect(parseToneMapping(value)).toBe(value);
    }
    expect(parseToneMapping("hable")).toBe("auto");
    expect(parseToneMapping("")).toBe("auto");
    expect(parseToneMapping(null)).toBe("auto");
  });
});

describe("clampTargetPeak", () => {
  it("clamps to the slider bounds and rounds", () => {
    expect(clampTargetPeak(203)).toBe(203);
    expect(clampTargetPeak(50)).toBe(100);
    expect(clampTargetPeak(5000)).toBe(1000);
    expect(clampTargetPeak(203.6)).toBe(204);
    expect(clampTargetPeak("350")).toBe(350);
  });

  it("falls back to the SDR reference white on garbage", () => {
    expect(clampTargetPeak(null)).toBe(TARGET_PEAK_DEFAULT);
    expect(clampTargetPeak("nits")).toBe(TARGET_PEAK_DEFAULT);
    expect(clampTargetPeak(Number.NaN)).toBe(TARGET_PEAK_DEFAULT);
    expect(clampTargetPeak(undefined)).toBe(TARGET_PEAK_DEFAULT);
  });
});

describe("hdrCommands", () => {
  it("auto mode turns peak detection on and leaves the rest to mpv", () => {
    expect(hdrCommands({ ...DEFAULT_STATE, mode: "auto" })).toEqual([
      { op: "set", name: "tone-mapping", value: "auto" },
      { op: "set", name: "hdr-compute-peak", value: "yes" },
      { op: "set", name: "target-peak", value: "auto" },
    ]);
  });

  it("algorithm mode pins the curve and keeps the auto peak", () => {
    expect(
      hdrCommands({
        mode: "algorithm",
        algorithm: "bt.2390",
        targetPeak: TARGET_PEAK_DEFAULT,
      }),
    ).toEqual([
      { op: "set", name: "tone-mapping", value: "bt.2390" },
      { op: "set", name: "hdr-compute-peak", value: "yes" },
      { op: "set", name: "target-peak", value: "auto" },
    ]);
  });

  it("manual mode pins the peak in nits and turns peak detection off", () => {
    expect(
      hdrCommands({
        mode: "manual",
        algorithm: "mobius",
        targetPeak: 350,
      }),
    ).toEqual([
      { op: "set", name: "tone-mapping", value: "auto" },
      { op: "set", name: "hdr-compute-peak", value: "no" },
      { op: "set", name: "target-peak", value: "350" },
    ]);
  });
});

describe("hdrDisposeCommands", () => {
  it("returns the three properties to the mpv defaults", () => {
    expect(hdrDisposeCommands()).toEqual([
      { op: "set", name: "tone-mapping", value: "auto" },
      { op: "set", name: "hdr-compute-peak", value: "auto" },
      { op: "set", name: "target-peak", value: "auto" },
    ]);
    expect(MPV_DEFAULT_HDR).toEqual({
      "tone-mapping": "auto",
      "hdr-compute-peak": "auto",
      "target-peak": "auto",
    });
  });
});

describe("createHdrSettings", () => {
  it("round-trips state through storage and notifies subscribers", () => {
    const storage = makeStorage();
    const settings = createHdrSettings(storage);
    const seen: Array<[string, string, number]> = [];
    settings.subscribe(() =>
      seen.push([
        settings.getMode(),
        settings.getAlgorithm(),
        settings.getTargetPeak(),
      ]),
    );

    settings.setMode("manual");
    settings.setTargetPeak(350);
    settings.setMode("algorithm");
    settings.setAlgorithm("reinhard");
    expect(seen).toEqual([
      ["manual", "auto", 203],
      ["manual", "auto", 350],
      ["algorithm", "auto", 350],
      ["algorithm", "reinhard", 350],
    ]);
    expect(storage.get("mode", "auto")).toBe("algorithm");
    expect(storage.get("algorithm", "auto")).toBe("reinhard");
    expect(storage.get("targetPeak", null)).toBe(350);
  });

  it("restores persisted state and sanitizes broken values", () => {
    const settings = createHdrSettings(
      makeStorage({
        mode: "manual",
        algorithm: "clip",
        targetPeak: 400,
      }),
    );
    expect(settings.getMode()).toBe("manual");
    expect(settings.getAlgorithm()).toBe("clip");
    expect(settings.getTargetPeak()).toBe(400);

    const broken = createHdrSettings(
      makeStorage({ mode: 7, algorithm: "hable", targetPeak: "bright" }),
    );
    expect(broken.getMode()).toBe("auto");
    expect(broken.getAlgorithm()).toBe("auto");
    expect(broken.getTargetPeak()).toBe(TARGET_PEAK_DEFAULT);
  });
});

describe("createHdrController", () => {
  it("applies on settings change and reverts the defaults on dispose", () => {
    const mpv = makeMpv();
    const controller = createHdrController(mpv, makeStorage());

    controller.settings.setMode("algorithm");
    controller.settings.setAlgorithm("mobius");
    expect(mpv.sets.slice(-3)).toEqual([
      ["tone-mapping", "mobius"],
      ["hdr-compute-peak", "yes"],
      ["target-peak", "auto"],
    ]);

    mpv.sets.length = 0;
    controller.settings.setMode("manual");
    controller.settings.setTargetPeak(250);
    expect(mpv.sets.slice(-3)).toEqual([
      ["tone-mapping", "auto"],
      ["hdr-compute-peak", "no"],
      ["target-peak", "250"],
    ]);

    mpv.sets.length = 0;
    controller.dispose();
    expect(mpv.sets).toEqual([
      ["tone-mapping", "auto"],
      ["hdr-compute-peak", "auto"],
      ["target-peak", "auto"],
    ]);

    // Settings changes after dispose no longer touch mpv.
    mpv.sets.length = 0;
    controller.settings.setMode("auto");
    expect(mpv.sets).toEqual([]);
  });

  it("survives mpv rejects without throwing", () => {
    const mpv: MpvBridge = {
      getProperty: async () => {
        throw new Error("not available");
      },
      setProperty: async () => {
        throw new Error("not writable");
      },
      command: async () => null,
    };
    const controller = createHdrController(mpv, makeStorage());
    expect(() => controller.settings.setMode("manual")).not.toThrow();
    expect(() => controller.apply()).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });
});

describe("readHdrInfo", () => {
  it("reads transfer, output transfer and the tagged peak", async () => {
    const mpv = makeMpv();
    mpv.props["video-params/gamma"] = "pq";
    mpv.props["video-out-params/gamma"] = "srgb";
    mpv.props["video-params/max-luma"] = "1000";
    await expect(readHdrInfo(mpv)).resolves.toEqual({
      transfer: "pq",
      outputTransfer: "srgb",
      peakNits: 1000,
    });
  });

  it("falls back to max-cll and tolerates missing properties", async () => {
    const mpv = makeMpv();
    mpv.props["video-params/gamma"] = "hlg";
    mpv.props["video-params/max-cll"] = "400";
    await expect(readHdrInfo(mpv)).resolves.toEqual({
      transfer: "hlg",
      outputTransfer: "",
      peakNits: 400,
    });

    const empty = makeMpv();
    await expect(readHdrInfo(empty)).resolves.toEqual(HDR_INFO_UNKNOWN);
  });
});

describe("hdrStatusLine", () => {
  const info: HdrInfo = {
    transfer: "pq",
    outputTransfer: "srgb",
    peakNits: 1000,
  };

  it("reports the HDR source, tagged peak and the active tone mapping", () => {
    const line = hdrStatusLine(info, {
      mode: "algorithm",
      algorithm: "bt.2390",
      targetPeak: 203,
    });
    expect(line).toContain("HDR (PQ)");
    expect(line).toContain("пик 1000 нит");
    expect(line).toContain("вывод: SDR");
    expect(line).toContain("тонмаппинг: bt.2390");
  });

  it("says SDR sources need no tone mapping", () => {
    const line = hdrStatusLine(
      { transfer: "srgb", outputTransfer: "srgb", peakNits: null },
      DEFAULT_STATE,
    );
    expect(line).toContain("SDR");
    expect(line).toContain("тонмаппинг: авто, подстройка пика");
    expect(line).not.toContain("нит");
  });

  it("summarizes the manual mode with the nits value", () => {
    expect(
      toneMappingSummary({
        mode: "manual",
        algorithm: "clip",
        targetPeak: 250,
      }),
    ).toBe("тонмаппинг: авто, яркость 250 нит");
  });

  it("classifies pq and hlg as HDR", () => {
    expect(isHdrTransfer("pq")).toBe(true);
    expect(isHdrTransfer("hlg")).toBe(true);
    expect(isHdrTransfer("srgb")).toBe(false);
    expect(isHdrTransfer("bt.1886")).toBe(false);
    expect(parseNits("1000")).toBe(1000);
    expect(parseNits("0")).toBeNull();
    expect(parseNits("")).toBeNull();
    expect(parseNits("n/a")).toBeNull();
  });
});

describe("createHdrInfoStore", () => {
  it("refreshes from the bridge and notifies subscribers", async () => {
    const mpv = makeMpv();
    mpv.props["video-params/gamma"] = "pq";
    const store = createHdrInfoStore(mpv);
    expect(store.get()).toEqual(HDR_INFO_UNKNOWN);
    const cb = vi.fn();
    store.subscribe(cb);
    await store.refresh();
    expect(store.get().transfer).toBe("pq");
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("hdr extension (registry scenarios)", () => {
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
    const runtime = createExtensionRuntime([hdr], deps);
    return { mpv, runtime };
  }

  it("re-applies the HDR settings after each file open", async () => {
    const { mpv, runtime } = setup(
      makeStorage({ mode: "manual", targetPeak: 300 }),
    );
    mpv.sets.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(mpv.sets).toEqual([
      ["tone-mapping", "auto"],
      ["hdr-compute-peak", "no"],
      ["target-peak", "300"],
    ]);

    mpv.sets.length = 0;
    runtime.notifyOpen({ url: "file:///b.mkv", startAt: null, source: "vod" });
    expect(mpv.sets).toEqual([
      ["tone-mapping", "auto"],
      ["hdr-compute-peak", "no"],
      ["target-peak", "300"],
    ]);
    runtime.dispose();
  });

  it("starts in auto mode and restores the mpv defaults on dispose", () => {
    const { mpv, runtime } = setup();
    mpv.sets.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(mpv.sets).toEqual([
      ["tone-mapping", "auto"],
      ["hdr-compute-peak", "yes"],
      ["target-peak", "auto"],
    ]);

    mpv.sets.length = 0;
    runtime.dispose();
    expect(mpv.sets).toEqual([
      ["tone-mapping", "auto"],
      ["hdr-compute-peak", "auto"],
      ["target-peak", "auto"],
    ]);
  });

  it("contributes the settings row to the settings.menu slot", () => {
    const { runtime } = setup();
    const entries = runtime.getSlotEntries("settings.menu");
    expect(entries).toHaveLength(1);
    expect(entries[0].extId).toBe("hdr");
    expect(typeof entries[0].render()).toBe("object");
    runtime.dispose();
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(0);
  });
});
