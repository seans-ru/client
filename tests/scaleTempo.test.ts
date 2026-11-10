import { describe, expect, it, vi } from "vitest";
import {
  clampSpeed,
  createScaleTempoController,
  createScaleTempoSettings,
  createSpeedStore,
  formatSpeed,
  labelRef,
  parseSpeed,
  SCALE_TEMPO_FILTER,
  SCALE_TEMPO_LABEL,
  scaleTempo,
  scaleTempoCommands,
  SPEED_FINE_STEP,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_PRESETS,
  stepSpeed,
} from "../src/features/player/extensions/scaleTempo";
import {
  createExtensionRuntime,
  type ExtensionRuntimeDeps,
} from "../src/features/player/extensions/registry";
import type {
  ExtensionStorage,
  ExtensionTransport,
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

function afCalls(mpv: { calls: string[][] }): Array<[string, string]> {
  return mpv.calls.map((args) => {
    expect(args[0]).toBe("af");
    return [args[1], args[2]];
  });
}

function makeTransport(): ExtensionTransport & { speeds: number[] } {
  const speeds: number[] = [];
  return {
    speeds,
    play: async () => {},
    pause: async () => {},
    togglePause: async () => {},
    seek: async () => {},
    setSpeed: async (speed) => {
      speeds.push(speed);
    },
    setVolume: async () => {},
    setMute: async () => {},
    setFullscreen: async () => {},
  };
}

function makeDeps(
  mpv: MpvBridge,
  storage: ExtensionStorage,
  transport: ExtensionTransport = makeTransport(),
): ExtensionRuntimeDeps {
  return {
    transport,
    getSnapshot: () => ({ ...DEFAULT_SNAPSHOT }),
    mpv,
    frames: { subscribe: () => () => {} },
    storageFor: () => storage,
    setChromeHidden: () => {},
  };
}

describe("clampSpeed / stepSpeed / parseSpeed", () => {
  it("covers the issue speed presets 0.75–2×", () => {
    expect([...SPEED_PRESETS]).toEqual([0.75, 1, 1.25, 1.5, 1.75, 2]);
    for (const preset of SPEED_PRESETS) {
      expect(clampSpeed(preset)).toBe(preset);
    }
  });

  it("clamps to the allowed range and rounds to 0.05-ish precision", () => {
    expect(clampSpeed(1)).toBe(1);
    expect(clampSpeed(1.25)).toBe(1.25);
    expect(clampSpeed(0.01)).toBe(SPEED_MIN);
    expect(clampSpeed(100)).toBe(SPEED_MAX);
    expect(clampSpeed(Number.NaN)).toBe(1);
  });

  it("steps by ±0.05 from a base speed", () => {
    expect(stepSpeed(1, 1)).toBeCloseTo(1.05);
    expect(stepSpeed(1, -1)).toBeCloseTo(0.95);
    expect(stepSpeed(SPEED_MAX, 1)).toBe(SPEED_MAX);
    expect(stepSpeed(SPEED_MIN, -1)).toBe(SPEED_MIN);
    expect(SPEED_FINE_STEP).toBe(0.05);
  });

  it("parses persisted speeds and falls back to 1", () => {
    expect(parseSpeed(1.5)).toBe(1.5);
    expect(parseSpeed("1.5")).toBe(1);
    expect(parseSpeed(null)).toBe(1);
  });

  it("formats speed labels", () => {
    expect(formatSpeed(1.25)).toBe("1.25×");
    expect(formatSpeed(1)).toBe("1×");
  });
});

describe("scaleTempoCommands", () => {
  it("adds the named filter when pitch preservation is on", () => {
    expect(scaleTempoCommands(true)).toEqual([
      { op: "add", entry: SCALE_TEMPO_FILTER },
    ]);
    expect(SCALE_TEMPO_FILTER).toBe(`@${SCALE_TEMPO_LABEL}:scaletempo`);
    // Coexists with other extensions' labels (issue: named filters).
    expect(SCALE_TEMPO_LABEL).not.toBe("seans-eq");
    expect(SCALE_TEMPO_LABEL).not.toBe("seans-vp-loudnorm");
  });

  it("removes by label when off", () => {
    expect(scaleTempoCommands(false)).toEqual([
      { op: "remove", entry: labelRef(SCALE_TEMPO_LABEL) },
    ]);
  });
});

describe("createScaleTempoSettings", () => {
  it("defaults to pitch preservation on and speed 1", () => {
    const settings = createScaleTempoSettings(makeStorage());
    expect(settings.getPitchEnabled()).toBe(true);
    expect(settings.getLastSpeed()).toBe(1);
  });

  it("only an explicit stored false disables pitch preservation", () => {
    expect(
      createScaleTempoSettings(makeStorage({ pitch: false })).getPitchEnabled(),
    ).toBe(false);
    expect(
      createScaleTempoSettings(makeStorage({ pitch: true })).getPitchEnabled(),
    ).toBe(true);
  });

  it("round-trips state through storage and notifies subscribers", () => {
    const storage = makeStorage();
    const settings = createScaleTempoSettings(storage);
    const seen: Array<[boolean, number]> = [];
    settings.subscribe(() =>
      seen.push([settings.getPitchEnabled(), settings.getLastSpeed()]),
    );
    settings.setPitchEnabled(false);
    settings.setLastSpeed(1.5);
    expect(seen).toEqual([
      [false, 1],
      [false, 1.5],
    ]);
    expect(storage.get("pitch", true)).toBe(false);
    expect(storage.get("speed", 1)).toBe(1.5);
  });

  it("clamps stored speed values", () => {
    const settings = createScaleTempoSettings(makeStorage());
    settings.setLastSpeed(99);
    expect(settings.getLastSpeed()).toBe(SPEED_MAX);
    settings.setLastSpeed(-1);
    expect(settings.getLastSpeed()).toBe(SPEED_MIN);
  });
});

describe("createScaleTempoController", () => {
  it("adds the filter and mirrors the toggle onto audio-pitch-correction", () => {
    const mpv = makeMpv();
    const controller = createScaleTempoController(mpv, makeStorage());

    controller.apply();
    expect(afCalls(mpv)).toEqual([["add", SCALE_TEMPO_FILTER]]);
    expect(mpv.props).toEqual([["audio-pitch-correction", true]]);

    mpv.calls.length = 0;
    mpv.props.length = 0;
    controller.settings.setPitchEnabled(false);
    expect(afCalls(mpv)).toEqual([["remove", labelRef(SCALE_TEMPO_LABEL)]]);
    // Without this the toggle would be inaudible (mpv would keep the pitch).
    expect(mpv.props).toEqual([["audio-pitch-correction", false]]);

    mpv.calls.length = 0;
    mpv.props.length = 0;
    controller.settings.setPitchEnabled(true);
    expect(afCalls(mpv)).toEqual([["add", SCALE_TEMPO_FILTER]]);
    expect(mpv.props).toEqual([["audio-pitch-correction", true]]);
    controller.dispose();
  });

  it("dispose removes the filter and restores mpv default pitch correction", () => {
    const mpv = makeMpv();
    const controller = createScaleTempoController(mpv, makeStorage());
    controller.settings.setPitchEnabled(false);
    mpv.calls.length = 0;
    mpv.props.length = 0;
    controller.dispose();
    expect(afCalls(mpv)).toEqual([["remove", labelRef(SCALE_TEMPO_LABEL)]]);
    expect(mpv.props).toEqual([["audio-pitch-correction", true]]);
    // Settings changes after dispose no longer touch mpv.
    mpv.calls.length = 0;
    mpv.props.length = 0;
    controller.settings.setPitchEnabled(true);
    expect(mpv.calls).toEqual([]);
    expect(mpv.props).toEqual([]);
  });

  it("survives mpv rejects without throwing", () => {
    const mpv: MpvBridge = {
      getProperty: async () => "",
      setProperty: async () => {
        throw new Error("reserved");
      },
      command: async () => {
        throw new Error("af is not available");
      },
    };
    const controller = createScaleTempoController(mpv, makeStorage());
    expect(() => controller.apply()).not.toThrow();
    expect(() => controller.settings.setPitchEnabled(false)).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });
});

describe("createSpeedStore", () => {
  it("prefills from storage and never auto-applies to the transport", () => {
    const storage = makeStorage({ speed: 1.5 });
    const transport = makeTransport();
    const store = createSpeedStore(storage, transport);
    expect(store.getSpeed()).toBe(1.5);
    expect(transport.speeds).toEqual([]);
  });

  it("applies presets via the transport and persists the last speed", () => {
    const storage = makeStorage();
    const transport = makeTransport();
    const store = createSpeedStore(storage, transport);
    store.setSpeed(1.75);
    expect(transport.speeds).toEqual([1.75]);
    expect(storage.get("speed", 1)).toBe(1.75);
    expect(store.getSpeed()).toBe(1.75);
  });

  it("nudges by ±0.05 from the live speed", () => {
    const transport = makeTransport();
    const store = createSpeedStore(makeStorage(), transport);
    store.syncFromSnapshot(1.25);
    store.nudge(1);
    expect(store.getSpeed()).toBeCloseTo(1.3);
    store.nudge(-1);
    expect(store.getSpeed()).toBeCloseTo(1.25);
    expect(transport.speeds).toEqual([1.3, 1.25]);
  });

  it("follows external speed changes from the snapshot", () => {
    const transport = makeTransport();
    const store = createSpeedStore(makeStorage(), transport);
    const cb = vi.fn();
    store.subscribe(cb);
    store.syncFromSnapshot(2);
    expect(store.getSpeed()).toBe(2);
    // No change — no notification, no transport calls.
    store.syncFromSnapshot(2);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(transport.speeds).toEqual([]);
  });
});

describe("scaleTempo extension (registry scenarios)", () => {
  it("keeps the named filter in the chain across file opens", () => {
    const mpv = makeMpv();
    const runtime = createExtensionRuntime(
      [scaleTempo],
      makeDeps(mpv, makeStorage()),
    );
    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(afCalls(mpv)).toEqual([["add", SCALE_TEMPO_FILTER]]);

    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///b.mkv", startAt: null, source: "vod" });
    expect(afCalls(mpv)).toEqual([["add", SCALE_TEMPO_FILTER]]);
    runtime.dispose();
  });

  it("starts with pitch preservation on and reverts sound on dispose", () => {
    const mpv = makeMpv();
    const runtime = createExtensionRuntime(
      [scaleTempo],
      makeDeps(mpv, makeStorage()),
    );
    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(afCalls(mpv)).toEqual([["add", SCALE_TEMPO_FILTER]]);

    mpv.calls.length = 0;
    runtime.dispose();
    expect(afCalls(mpv)).toEqual([["remove", labelRef(SCALE_TEMPO_LABEL)]]);
    expect(mpv.props.at(-1)).toEqual(["audio-pitch-correction", true]);
  });

  it("contributes the settings section to the settings.menu slot", () => {
    const runtime = createExtensionRuntime(
      [scaleTempo],
      makeDeps(makeMpv(), makeStorage()),
    );
    const entries = runtime.getSlotEntries("settings.menu");
    expect(entries).toHaveLength(1);
    expect(entries[0].extId).toBe("scale-tempo");
    expect(typeof entries[0].render()).toBe("object");
    runtime.dispose();
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(0);
  });

  it("pitch toggle persisted off is respected from the first apply", () => {
    const mpv = makeMpv();
    const runtime = createExtensionRuntime(
      [scaleTempo],
      makeDeps(mpv, makeStorage({ pitch: false })),
    );
    mpv.calls.length = 0;
    mpv.props.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(afCalls(mpv)).toEqual([["remove", labelRef(SCALE_TEMPO_LABEL)]]);
    expect(mpv.props).toEqual([["audio-pitch-correction", false]]);
    runtime.dispose();
  });
});
