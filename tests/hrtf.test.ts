import { describe, expect, it, vi } from "vitest";
import {
  createHrtfController,
  createHrtfSettings,
  escapeSofaPath,
  HRTF_LABEL,
  HRTF_MIN_CHANNELS,
  HRTF_PROFILES,
  hrtf,
  hrtfFilter,
  hrtfFilterCommands,
  isMultichannel,
  labelRef,
  parseChannelCount,
  parseHrtfProfile,
  parseSofaPath,
  selectedAudioTrackId,
} from "../src/features/player/extensions/hrtf";
import {
  createExtensionRuntime,
  type ExtensionRuntimeDeps,
} from "../src/features/player/extensions/registry";
import type {
  ExtensionStorage,
  MpvBridge,
} from "../src/features/player/extensions/types";
import {
  DEFAULT_SNAPSHOT,
  type PlayerSnapshot,
} from "../src/features/player/playerTypes";

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

type MockMpv = MpvBridge & {
  calls: string[][];
  props: Array<[string, string | number | boolean]>;
  propsByKey: Map<string, string>;
};

function makeMpv(propsByKey: Record<string, string> = {}): MockMpv {
  const calls: string[][] = [];
  const props: Array<[string, string | number | boolean]> = [];
  const map = new Map(Object.entries(propsByKey));
  return {
    calls,
    props,
    propsByKey: map,
    getProperty: async (name: string) => {
      if (!map.has(name)) throw new Error(`no property: ${name}`);
      return map.get(name) as string;
    },
    setProperty: async (name, value) => {
      props.push([name, value]);
    },
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

/** Drain the microtask queue (fire-and-forget mpv promise chains). */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

function makeDeps(
  mpv: MpvBridge,
  storage: ExtensionStorage,
  snapshot: PlayerSnapshot = { ...DEFAULT_SNAPSHOT },
): ExtensionRuntimeDeps {
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
    getSnapshot: () => snapshot,
    mpv,
    frames: { subscribe: () => () => {} },
    storageFor: () => storage,
    setChromeHidden: () => {},
  };
}

describe("parseChannelCount / isMultichannel", () => {
  it("parses counts, layouts and names", () => {
    expect(parseChannelCount("6")).toBe(6);
    expect(parseChannelCount("2")).toBe(2);
    expect(parseChannelCount("5.1")).toBe(6);
    expect(parseChannelCount("5.1(side)")).toBe(6);
    expect(parseChannelCount("7.1")).toBe(8);
    expect(parseChannelCount("2.1")).toBe(3);
    expect(parseChannelCount("stereo")).toBe(2);
    expect(parseChannelCount("mono")).toBe(1);
    expect(parseChannelCount("quad")).toBe(4);
    expect(parseChannelCount("")).toBe(0);
    expect(parseChannelCount("unknown")).toBe(0);
    expect(parseChannelCount("junk")).toBe(0);
  });

  it("treats >2 channels as multichannel (5.1/7.1 only per issue)", () => {
    expect(isMultichannel(6)).toBe(true);
    expect(isMultichannel(8)).toBe(true);
    expect(isMultichannel(HRTF_MIN_CHANNELS)).toBe(true);
    expect(isMultichannel(2)).toBe(false);
    expect(isMultichannel(1)).toBe(false);
    expect(isMultichannel(0)).toBe(false);
    expect(isMultichannel(Number.NaN)).toBe(false);
  });
});

describe("hrtfFilter", () => {
  it("builds a labeled sofalizer lavfi filter per profile", () => {
    const headphones = hrtfFilter("headphones", "/data/hrtf.sofa");
    expect(headphones.startsWith(`@${HRTF_LABEL}:lavfi=[sofalizer=`)).toBe(true);
    expect(headphones).toContain("type=freq");
    expect(headphones).toContain("radius=1");
    expect(headphones).toContain("sofa='/data/hrtf.sofa'");

    const room = hrtfFilter("room", "/data/hrtf.sofa");
    expect(room).toContain("radius=2");
    expect(room).toContain("gain=3");
  });

  it("omits the sofa option when no dataset is configured", () => {
    const filter = hrtfFilter("headphones", "");
    expect(filter).toBe(`@${HRTF_LABEL}:lavfi=[sofalizer=type=freq:radius=1]`);
  });

  it("escapes Windows paths so the colon is not a filter separator", () => {
    expect(escapeSofaPath("C:\\hrtf\\x.sofa")).toBe("'C:/hrtf/x.sofa'");
    expect(escapeSofaPath("D:/a b/c.sofa")).toBe("'D:/a b/c.sofa'");
    const filter = hrtfFilter("headphones", "C:\\Users\\me\\x.sofa");
    expect(filter).toContain(`sofa='C:/Users/me/x.sofa'`);
  });

  it("keeps a label distinct from other audio extensions", () => {
    expect(HRTF_LABEL).not.toBe("seans-eq");
    expect(HRTF_LABEL).not.toBe("seans-scaletempo");
    expect(HRTF_LABEL).not.toBe("seans-vp-loudnorm");
  });
});

describe("hrtfFilterCommands", () => {
  const base = {
    profile: "headphones" as const,
    sofaPath: "/data/hrtf.sofa",
    channels: 6,
  };

  it("adds the filter for enabled multichannel with a dataset", () => {
    expect(hrtfFilterCommands({ ...base, enabled: true })).toEqual([
      { op: "add", entry: hrtfFilter("headphones", "/data/hrtf.sofa") },
    ]);
  });

  it("removes the filter when disabled, on stereo, or without a dataset", () => {
    const remove = [{ op: "remove", entry: labelRef(HRTF_LABEL) }];
    expect(hrtfFilterCommands({ ...base, enabled: false })).toEqual(remove);
    expect(
      hrtfFilterCommands({ ...base, enabled: true, channels: 2 }),
    ).toEqual(remove);
    expect(
      hrtfFilterCommands({ ...base, enabled: true, channels: 0 }),
    ).toEqual(remove);
    expect(
      hrtfFilterCommands({ ...base, enabled: true, sofaPath: "" }),
    ).toEqual(remove);
  });
});

describe("parse helpers", () => {
  it("normalizes profile and sofa path", () => {
    expect(parseHrtfProfile("room")).toBe("room");
    expect(parseHrtfProfile("headphones")).toBe("headphones");
    expect(parseHrtfProfile("nope")).toBe("headphones");
    expect(parseHrtfProfile(null)).toBe("headphones");
    expect(parseSofaPath("  /x/y.sofa  ")).toBe("/x/y.sofa");
    expect(parseSofaPath(42)).toBe("");
    expect(HRTF_PROFILES).toEqual(["headphones", "room"]);
  });

  it("finds the selected audio track id", () => {
    expect(selectedAudioTrackId([])).toBe(0);
    expect(
      selectedAudioTrackId([
        { id: 1, kind: "video", selected: true },
        { id: 2, kind: "audio", selected: false },
      ]),
    ).toBe(0);
    expect(
      selectedAudioTrackId([
        { id: 2, kind: "audio", selected: false },
        { id: 5, kind: "audio", selected: true },
      ]),
    ).toBe(5);
  });
});

describe("createHrtfSettings", () => {
  it("defaults to disabled headphones profile without a dataset", () => {
    const settings = createHrtfSettings(makeStorage());
    expect(settings.getEnabled()).toBe(false);
    expect(settings.getProfile()).toBe("headphones");
    expect(settings.getSofaPath()).toBe("");
  });

  it("round-trips state through storage and notifies", () => {
    const storage = makeStorage();
    const settings = createHrtfSettings(storage);
    const cb = vi.fn();
    settings.subscribe(cb);
    settings.setEnabled(true);
    settings.setProfile("room");
    settings.setSofaPath(" /data/x.sofa ");
    expect(cb).toHaveBeenCalledTimes(3);
    expect(storage.get("enabled", false)).toBe(true);
    expect(storage.get("profile", "headphones")).toBe("room");
    expect(storage.get("sofa", "")).toBe("/data/x.sofa");
    expect(settings.getSofaPath()).toBe("/data/x.sofa");
  });

  it("restores persisted state", () => {
    const settings = createHrtfSettings(
      makeStorage({ enabled: true, profile: "room", sofa: "/a.sofa" }),
    );
    expect(settings.getEnabled()).toBe(true);
    expect(settings.getProfile()).toBe("room");
    expect(settings.getSofaPath()).toBe("/a.sofa");
  });
});

describe("createHrtfController", () => {
  it("applies only on multichannel tracks with a dataset", async () => {
    const mpv = makeMpv({
      "current-tracks/audio/demux-channel-count": "6",
    });
    const controller = createHrtfController(
      mpv,
      makeStorage({ enabled: true, sofa: "/data/hrtf.sofa" }),
    );
    await controller.refreshChannels();
    expect(controller.getChannels()).toBe(6);
    expect(afCalls(mpv)).toEqual([
      ["add", hrtfFilter("headphones", "/data/hrtf.sofa")],
    ]);
    controller.dispose();
  });

  it("keeps the filter off on stereo and reports the hint", async () => {
    const mpv = makeMpv({
      "current-tracks/audio/demux-channel-count": "2",
    });
    const controller = createHrtfController(
      mpv,
      makeStorage({ enabled: true, sofa: "/data/hrtf.sofa" }),
    );
    await controller.refreshChannels();
    expect(afCalls(mpv)).toEqual([["remove", labelRef(HRTF_LABEL)]]);
    expect(controller.getStatus()).toBe("stereo");
    controller.dispose();
  });

  it("falls back to audio-params when the track property is missing", async () => {
    const mpv = makeMpv({ "audio-params/channel-count": "8" });
    const controller = createHrtfController(
      mpv,
      makeStorage({ enabled: true, sofa: "/data/hrtf.sofa" }),
    );
    await controller.refreshChannels();
    expect(controller.getChannels()).toBe(8);
    expect(afCalls(mpv)).toEqual([
      ["add", hrtfFilter("headphones", "/data/hrtf.sofa")],
    ]);
    controller.dispose();
  });

  it("reports needs-sofa when the multichannel track has no dataset", async () => {
    const mpv = makeMpv({
      "current-tracks/audio/demux-channel-count": "6",
    });
    const controller = createHrtfController(
      mpv,
      makeStorage({ enabled: true }),
    );
    await controller.refreshChannels();
    expect(afCalls(mpv)).toEqual([["remove", labelRef(HRTF_LABEL)]]);
    expect(controller.getStatus()).toBe("needs-sofa");
    controller.dispose();
  });

  it("switches the filter on the fly when settings change", async () => {
    const mpv = makeMpv({
      "current-tracks/audio/demux-channel-count": "6",
    });
    const controller = createHrtfController(
      mpv,
      makeStorage({ sofa: "/data/hrtf.sofa" }),
    );
    await controller.refreshChannels();
    expect(afCalls(mpv)).toEqual([["remove", labelRef(HRTF_LABEL)]]);

    mpv.calls.length = 0;
    controller.settings.setEnabled(true);
    expect(afCalls(mpv)).toEqual([
      ["add", hrtfFilter("headphones", "/data/hrtf.sofa")],
    ]);

    mpv.calls.length = 0;
    controller.settings.setProfile("room");
    expect(afCalls(mpv)).toEqual([
      ["add", hrtfFilter("room", "/data/hrtf.sofa")],
    ]);

    mpv.calls.length = 0;
    controller.settings.setEnabled(false);
    expect(afCalls(mpv)).toEqual([["remove", labelRef(HRTF_LABEL)]]);
    expect(controller.getStatus()).toBe("idle");
    controller.dispose();
  });

  it("dispose removes the filter and isolates the error", async () => {
    const mpv = makeMpv({
      "current-tracks/audio/demux-channel-count": "6",
    });
    const controller = createHrtfController(
      mpv,
      makeStorage({ enabled: true, sofa: "/data/hrtf.sofa" }),
    );
    await controller.refreshChannels();
    mpv.calls.length = 0;
    controller.dispose();
    expect(afCalls(mpv)).toEqual([["remove", labelRef(HRTF_LABEL)]]);
  });

  it("marks the effect failed on mpv rejects without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mpv = makeMpv({
      "current-tracks/audio/demux-channel-count": "6",
    });
    mpv.command = async (args: string[]) => {
      mpv.calls.push([...args]);
      if (args[1] === "add") throw new Error("sofalizer init failed");
      return null;
    };
    const controller = createHrtfController(
      mpv,
      makeStorage({ enabled: true, sofa: "/data/hrtf.sofa" }),
    );
    await expect(controller.refreshChannels()).resolves.toBeUndefined();
    // Give the fire-and-forget promise chain a tick to settle.
    await flush();
    await flush();
    expect(controller.getStatus()).toBe("error");
    expect(warn).toHaveBeenCalledWith(
      "[player.ext]",
      "hrtf",
      expect.any(Error),
    );
    // Failed add triggers a cleanup remove (never leaves a half filter).
    expect(afCalls(mpv)).toEqual([
      ["add", hrtfFilter("headphones", "/data/hrtf.sofa")],
      ["remove", labelRef(HRTF_LABEL)],
    ]);
    warn.mockRestore();
    controller.dispose();
  });

  it("reports idle when disabled regardless of the track", async () => {
    const mpv = makeMpv({
      "current-tracks/audio/demux-channel-count": "6",
    });
    const controller = createHrtfController(mpv, makeStorage());
    await controller.refreshChannels();
    expect(controller.getStatus()).toBe("idle");
    expect(afCalls(mpv)).toEqual([["remove", labelRef(HRTF_LABEL)]]);
    controller.dispose();
  });
});

describe("hrtf extension (registry scenarios)", () => {
  it("re-checks the channel count when the audio track changes", async () => {
    const mpv = makeMpv({
      "current-tracks/audio/demux-channel-count": "2",
    });
    const snapshot: PlayerSnapshot = {
      ...DEFAULT_SNAPSHOT,
      tracks: [{ id: 1, kind: "audio", title: "", lang: "", codec: "", selected: true, external: false }],
    };
    const runtime = createExtensionRuntime(
      [hrtf],
      makeDeps(mpv, makeStorage({ enabled: true, sofa: "/data/hrtf.sofa" }), snapshot),
    );
    // Initial refresh (stereo) → filter off.
    await flush();
    await flush();
    expect(afCalls(mpv)).toEqual([["remove", labelRef(HRTF_LABEL)]]);

    // Switch to a 5.1 track — the next snapshot triggers a re-check.
    mpv.propsByKey.set("current-tracks/audio/demux-channel-count", "6");
    snapshot.tracks = [
      { id: 1, kind: "audio", title: "", lang: "", codec: "", selected: false, external: false },
      { id: 2, kind: "audio", title: "", lang: "", codec: "", selected: true, external: false },
    ];
    mpv.calls.length = 0;
    runtime.notifySnapshot(snapshot);
    await flush();
    await flush();
    await flush();
    expect(afCalls(mpv)).toEqual([
      ["add", hrtfFilter("headphones", "/data/hrtf.sofa")],
    ]);
    runtime.dispose();
  });

  it("contributes the settings section to the settings.menu slot", () => {
    const runtime = createExtensionRuntime(
      [hrtf],
      makeDeps(makeMpv(), makeStorage()),
    );
    const entries = runtime.getSlotEntries("settings.menu");
    expect(entries).toHaveLength(1);
    expect(entries[0].extId).toBe("hrtf");
    expect(typeof entries[0].render()).toBe("object");
    runtime.dispose();
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(0);
  });

  it("dispose restores the original sound", async () => {
    const mpv = makeMpv({
      "current-tracks/audio/demux-channel-count": "6",
    });
    const runtime = createExtensionRuntime(
      [hrtf],
      makeDeps(mpv, makeStorage({ enabled: true, sofa: "/data/hrtf.sofa" })),
    );
    await flush();
    await flush();
    mpv.calls.length = 0;
    runtime.dispose();
    expect(afCalls(mpv)).toEqual([["remove", labelRef(HRTF_LABEL)]]);
  });
});
