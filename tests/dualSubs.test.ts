import { describe, expect, it, vi } from "vitest";
import {
  clampSubPos,
  clampSubScale,
  createDualSubsController,
  createDualSubsSettings,
  DUAL_SUBS_DEFAULT,
  dualSubs,
  dualSubsCommands,
  dualSubsDisposeCommands,
  dualSubsTrackRows,
  loadDualSubsState,
  parseDualSubsState,
  parseSecondId,
  saveDualSubsState,
  subtitleTag,
  type DualSubsState,
} from "../src/features/player/extensions/dualSubs";
import {
  createExtensionRuntime,
  type ExtensionRuntimeDeps,
} from "../src/features/player/extensions/registry";
import type {
  ExtensionStorage,
  MpvBridge,
} from "../src/features/player/extensions/types";
import { DEFAULT_SNAPSHOT, type PlayerSnapshot } from "../src/features/player/playerTypes";

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
  calls: Array<{ kind: "set"; args: [string, string | number | boolean] }>;
} {
  const calls: Array<{
    kind: "set";
    args: [string, string | number | boolean];
  }> = [];
  return {
    calls,
    getProperty: async () => "",
    setProperty: async (name, value) => {
      calls.push({ kind: "set", args: [name, value] });
    },
    command: async () => null,
  };
}

function setCalls(mpv: ReturnType<typeof makeMpv>): Array<[string, string | number | boolean]> {
  return mpv.calls.map((c) => c.args);
}

describe("parse / clamp helpers", () => {
  it("clamps positions to 0–150 and scales to 0.1–10", () => {
    expect(clampSubPos(100)).toBe(100);
    expect(clampSubPos(-5)).toBe(0);
    expect(clampSubPos(200)).toBe(150);
    expect(clampSubPos("junk")).toBe(100);
    expect(clampSubScale(1)).toBe(1);
    expect(clampSubScale(0)).toBe(0.1);
    expect(clampSubScale(99)).toBe(10);
    expect(clampSubScale(Number.NaN)).toBe(1);
  });

  it("parses second track ids", () => {
    expect(parseSecondId(3)).toBe(3);
    expect(parseSecondId("5")).toBe(5);
    expect(parseSecondId(0)).toBeNull();
    expect(parseSecondId(-1)).toBeNull();
    expect(parseSecondId(null)).toBeNull();
    expect(parseSecondId("x")).toBeNull();
  });

  it("sanitizes persisted state", () => {
    const state = parseDualSubsState({
      enabled: true,
      secondId: "7",
      firstPos: 999,
      secondScale: -3,
      secondVisible: false,
    });
    expect(state.enabled).toBe(true);
    expect(state.secondId).toBe(7);
    expect(state.firstPos).toBe(150);
    expect(state.secondScale).toBe(0.1);
    expect(state.secondVisible).toBe(false);
    expect(state.firstVisible).toBe(true);
    expect(parseDualSubsState("junk")).toEqual(DUAL_SUBS_DEFAULT);
  });
});

describe("dualSubsCommands", () => {
  it("disables the secondary track with secondary-sid=no", () => {
    const calls = dualSubsCommands({ ...DUAL_SUBS_DEFAULT, enabled: false });
    expect(calls[0]).toEqual({ op: "set", name: "secondary-sid", value: "no" });
  });

  it("selects the configured track or falls back to auto", () => {
    expect(
      dualSubsCommands({ ...DUAL_SUBS_DEFAULT, enabled: true })[0],
    ).toEqual({ op: "set", name: "secondary-sid", value: "auto" });
    expect(
      dualSubsCommands({ ...DUAL_SUBS_DEFAULT, enabled: true, secondId: 4 })[0],
    ).toEqual({ op: "set", name: "secondary-sid", value: "4" });
  });

  it("writes independent position/size/visibility properties", () => {
    const state: DualSubsState = {
      enabled: true,
      secondId: 2,
      firstPos: 95,
      firstScale: 1.1,
      secondPos: 15,
      secondScale: 0.8,
      firstVisible: true,
      secondVisible: false,
    };
    const byName = new Map(
      dualSubsCommands(state).map((c) => [c.name, c.value]),
    );
    expect(byName.get("sub-pos")).toBe(95);
    expect(byName.get("sub-scale")).toBe(1.1);
    expect(byName.get("secondary-sub-pos")).toBe(15);
    expect(byName.get("secondary-sub-scale")).toBe(0.8);
    expect(byName.get("sub-visibility")).toBe(true);
    expect(byName.get("secondary-sub-visibility")).toBe(false);
  });

  it("dispose commands return the documented mpv defaults", () => {
    const calls = dualSubsDisposeCommands();
    expect(calls.find((c) => c.name === "secondary-sid")?.value).toBe("no");
    expect(calls.find((c) => c.name === "sub-pos")?.value).toBe(100);
    expect(calls.find((c) => c.name === "sub-scale")?.value).toBe(1);
    expect(calls.find((c) => c.name === "secondary-sub-pos")?.value).toBe(0);
    expect(calls.find((c) => c.name === "secondary-sub-scale")?.value).toBe(1);
    expect(calls.find((c) => c.name === "sub-visibility")?.value).toBe(true);
    expect(calls.find((c) => c.name === "secondary-sub-visibility")?.value).toBe(
      true,
    );
  });
});

describe("subtitleTag (issue #10 marks)", () => {
  it("marks same-language subs as original and others as translation", () => {
    expect(subtitleTag("ja", "ja")).toBe("[оригинал]");
    expect(subtitleTag("ru", "ja")).toBe("[перевод]");
    expect(subtitleTag("RU", "ru")).toBe("[оригинал]");
    expect(subtitleTag("", "ja")).toBe("");
    expect(subtitleTag("ru", "")).toBe("[перевод]");
    expect(subtitleTag(null, null)).toBe("");
  });
});

describe("dualSubsTrackRows", () => {
  const snapshot: PlayerSnapshot = {
    ...DEFAULT_SNAPSHOT,
    tracks: [
      { id: 1, kind: "audio", title: "", lang: "ja", codec: "aac", selected: true, external: false },
      { id: 1, kind: "sub", title: "RUS", lang: "ru", codec: "ass", selected: true, external: false },
      { id: 2, kind: "sub", title: "JPN", lang: "ja", codec: "ass", selected: false, external: false },
    ],
  };

  it("labels rows with the product label plus the language mark", () => {
    const rows = dualSubsTrackRows(snapshot);
    expect(rows).toHaveLength(2);
    expect(rows[0].tag).toBe("[перевод]");
    expect(rows[1].tag).toBe("[оригинал]");
    expect(rows[0].label).toContain("RUS");
    expect(rows[0].selected).toBe(true);
    expect(rows[1].selected).toBe(false);
  });
});

describe("per-media storage", () => {
  it("restores file state, then defaults, then built-in defaults", () => {
    const storage = makeStorage({
      "file.k1": { ...DUAL_SUBS_DEFAULT, enabled: true, secondId: 5 },
      defaults: { ...DUAL_SUBS_DEFAULT, secondPos: 25 },
    });
    expect(loadDualSubsState(storage, "k1").secondId).toBe(5);
    expect(loadDualSubsState(storage, "k1").enabled).toBe(true);
    expect(loadDualSubsState(storage, "k2").secondPos).toBe(25);
    expect(loadDualSubsState(storage, "k2").enabled).toBe(false);
    expect(loadDualSubsState(storage, null).secondPos).toBe(25);
    expect(loadDualSubsState(makeStorage(), "k3")).toEqual(DUAL_SUBS_DEFAULT);
  });

  it("saves under the file key", () => {
    const storage = makeStorage();
    saveDualSubsState(storage, "k1", {
      ...DUAL_SUBS_DEFAULT,
      enabled: true,
      secondId: 2,
    });
    expect(loadDualSubsState(storage, "k1").secondId).toBe(2);
  });
});

describe("createDualSubsSettings / controller", () => {
  it("loadForFile swaps the state and notifies", () => {
    const storage = makeStorage({
      "file.k1": { ...DUAL_SUBS_DEFAULT, enabled: true, secondId: 3 },
    });
    const settings = createDualSubsSettings(storage);
    const cb = vi.fn();
    const stop = settings.subscribe(cb);
    expect(settings.getState().enabled).toBe(false);
    settings.loadForFile("k1");
    expect(settings.getState().secondId).toBe(3);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
  });

  it("patch applies and persists per file", () => {
    const storage = makeStorage();
    const settings = createDualSubsSettings(storage);
    settings.loadForFile("k1");
    settings.patch({ enabled: true, secondId: 4, secondPos: 20 });
    expect(loadDualSubsState(storage, "k1").secondPos).toBe(20);
    // No file key — state stays in memory only.
    settings.loadForFile(null);
    settings.patch({ enabled: true });
    expect(loadDualSubsState(storage, "k1").enabled).toBe(true);
  });

  it("controller writes mpv properties on change and resets on dispose", () => {
    const mpv = makeMpv();
    const controller = createDualSubsController(mpv, makeStorage());
    mpv.calls.length = 0;
    controller.settings.patch({ enabled: true, secondId: 2, secondPos: 10 });
    const names = setCalls(mpv).map(([name]) => name);
    expect(names).toContain("secondary-sid");
    expect(setCalls(mpv).find(([n]) => n === "secondary-sid")?.[1]).toBe("2");
    expect(setCalls(mpv).find(([n]) => n === "secondary-sub-pos")?.[1]).toBe(10);

    mpv.calls.length = 0;
    controller.dispose();
    expect(setCalls(mpv).find(([n]) => n === "secondary-sid")?.[1]).toBe("no");
    // Changes after dispose no longer touch mpv.
    mpv.calls.length = 0;
    controller.settings.patch({ secondPos: 33 });
    expect(mpv.calls).toEqual([]);
  });

  it("survives mpv rejects without throwing", () => {
    const mpv: MpvBridge = {
      getProperty: async () => "",
      setProperty: async () => {
        throw new Error("property is reserved");
      },
      command: async () => null,
    };
    const controller = createDualSubsController(mpv, makeStorage());
    expect(() => controller.settings.patch({ enabled: true })).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });
});

describe("dualSubs extension (registry scenarios)", () => {
  function setup() {
    const mpv = makeMpv();
    const storage = makeStorage({
      "file.cdn.example.com/a.mkv": {
        ...DUAL_SUBS_DEFAULT,
        enabled: true,
        secondId: 2,
      },
    });
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
      getSnapshot: () => ({
        ...DEFAULT_SNAPSHOT,
        file_loaded: true,
        duration: 100,
        video_w: 1920,
        video_h: 1080,
      }),
      mpv,
      frames: { subscribe: () => () => {} },
      storageFor: () => storage,
      setChromeHidden: () => {},
    };
    const runtime = createExtensionRuntime([dualSubs], deps);
    return { mpv, runtime, storage };
  }

  it("restores per-file state on open and applies it to mpv", () => {
    const { mpv, runtime } = setup();
    mpv.calls.length = 0;
    runtime.notifyOpen({
      url: "https://cdn.example.com/a.mkv?sig=1",
      startAt: null,
      source: "vod",
    });
    expect(setCalls(mpv).find(([n]) => n === "secondary-sid")?.[1]).toBe("2");
    expect(
      setCalls(mpv).find(([n]) => n === "secondary-sub-pos")?.[1],
    ).toBe(0);
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(1);
    runtime.dispose();
  });

  it("dispose disables the secondary track", () => {
    const { mpv, runtime } = setup();
    runtime.notifyOpen({
      url: "https://cdn.example.com/a.mkv?sig=1",
      startAt: null,
      source: "vod",
    });
    mpv.calls.length = 0;
    runtime.dispose();
    expect(setCalls(mpv).find(([n]) => n === "secondary-sid")?.[1]).toBe("no");
  });
});
