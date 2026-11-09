import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AMBIENT_MAX_FPS,
  AMBIENT_VAR_A,
  AMBIENT_VAR_B,
  AMBIENT_VAR_G,
  AMBIENT_VAR_R,
  averageFrameRgb,
  createAmbientEngine,
  cssWrites,
  DARK_LUMA,
  darkGate,
  DEFAULT_SETTINGS,
  luminance,
  parseSettings,
  soundIntensityFactor,
} from "../src/features/player/extensions/ambientLightPolicy";
import {
  ambientLight,
  createAmbientSettings,
  createRootVarWriter,
  GLOW_LAYER_CLASS,
  mountGlowLayer,
} from "../src/features/player/extensions/ambientLight";
import {
  createExtensionRuntime,
  type ExtensionRuntimeDeps,
} from "../src/features/player/extensions/registry";
import { frameHub } from "../src/features/player/extensions/frameHub";
import type {
  ExtensionStorage,
  FrameSample,
} from "../src/features/player/extensions/types";
import { DEFAULT_SNAPSHOT } from "../src/features/player/playerTypes";

function solidSample(
  r: number,
  g: number,
  b: number,
  width = 4,
  height = 4,
): FrameSample {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return { width, height, pts: 0, rgb };
}

function memoryStorage(
  seed: Record<string, unknown> = {},
): ExtensionStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(seed));
  return {
    data,
    get: <T,>(key: string, fallback: T): T =>
      (data.has(key) ? (data.get(key) as T) : fallback),
    set: (key, value) => {
      data.set(key, value);
    },
  };
}

/** Collects CSS writes instead of touching a real document. */
function recordingWriter() {
  const vars = new Map<string, string>();
  return {
    vars,
    writer: {
      setVar(name: string, value: string) {
        vars.set(name, value);
      },
    },
  };
}

/**
 * Minimal fake DOM for the node test env: style maps + a body child list
 * (the extension only uses `documentElement.style` and `body.appendChild`).
 */
function fakeDocument() {
  const styleProps = new Map<string, string>();
  const children: Array<{
    className: string;
    removed: boolean;
    attrs: Map<string, string>;
  }> = [];
  const root = {
    style: {
      setProperty(name: string, value: string) {
        styleProps.set(name, value);
      },
      removeProperty(name: string) {
        styleProps.delete(name);
      },
      getPropertyValue(name: string) {
        return styleProps.get(name) ?? "";
      },
    },
  };
  const doc = {
    documentElement: root,
    createElement() {
      const el = {
        className: "",
        removed: false,
        attrs: new Map<string, string>(),
        style: { cssText: "" },
        setAttribute(name: string, value: string) {
          el.attrs.set(name, value);
        },
        remove() {
          el.removed = true;
          const index = children.indexOf(el);
          if (index >= 0) children.splice(index, 1);
        },
      };
      return el;
    },
    body: {
      appendChild(el: (typeof children)[number]) {
        children.push(el);
      },
    },
  };
  return { doc, styleProps, children };
}

describe("averageFrameRgb / luminance", () => {
  it("averages a solid sample", () => {
    const avg = averageFrameRgb(solidSample(10, 20, 30));
    expect(avg.r).toBeCloseTo(10);
    expect(avg.g).toBeCloseTo(20);
    expect(avg.b).toBeCloseTo(30);
  });

  it("falls back to black on a corrupt sample", () => {
    const avg = averageFrameRgb({
      width: 0,
      height: 0,
      pts: 0,
      rgb: new Uint8Array(0),
    });
    expect(avg).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("computes Rec.709 luminance", () => {
    expect(luminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1);
    expect(luminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0);
  });
});

describe("darkGate (hysteresis)", () => {
  it("enters dark below the low edge and leaves above the high edge", () => {
    // Low edge is DARK_LUMA - DARK_HYSTERESIS (0.07).
    expect(darkGate(DARK_LUMA - 0.04, false)).toBe(true);
    expect(darkGate(DARK_LUMA - 0.01, false)).toBe(false);
    // Inside the band the previous state sticks — no flicker on scene edges.
    expect(darkGate(DARK_LUMA, false)).toBe(false);
    expect(darkGate(DARK_LUMA, true)).toBe(true);
    expect(darkGate(DARK_LUMA + 0.031, true)).toBe(false);
  });
});

describe("soundIntensityFactor", () => {
  const playing = { pause: false, mute: false, volume: 100 };

  it("mode «По кадру» ignores sound", () => {
    expect(soundIntensityFactor(playing, "frame")).toBe(1);
    expect(
      soundIntensityFactor({ pause: true, mute: true, volume: 0 }, "frame"),
    ).toBe(1);
  });

  it("mode «Кадр + звук» dims on pause, mute and silence", () => {
    expect(soundIntensityFactor({ ...playing, pause: true }, "frame-sound")).toBe(0.3);
    expect(soundIntensityFactor({ ...playing, mute: true }, "frame-sound")).toBe(0.45);
    expect(soundIntensityFactor({ ...playing, volume: 0 }, "frame-sound")).toBe(0.45);
  });

  it("scales with loudness", () => {
    expect(soundIntensityFactor(playing, "frame-sound")).toBe(1);
    expect(
      soundIntensityFactor({ ...playing, volume: 50 }, "frame-sound"),
    ).toBeCloseTo(0.775);
  });
});

describe("cssWrites", () => {
  it("emits all vars on first write and only changes afterwards", () => {
    const first = cssWrites(null, { r: 10, g: 20, b: 30, a: 0.5 });
    expect(first.map((w) => w.name)).toEqual([
      AMBIENT_VAR_R,
      AMBIENT_VAR_G,
      AMBIENT_VAR_B,
      AMBIENT_VAR_A,
    ]);
    const second = cssWrites(
      { r: 10, g: 20, b: 30, a: 0.5 },
      { r: 10, g: 20, b: 31, a: 0.5 },
    );
    expect(second).toEqual([{ name: AMBIENT_VAR_B, value: "31" }]);
  });
});

describe("createAmbientEngine", () => {
  it("EMA-smooths color instead of jumping per frame", () => {
    const { writer, vars } = recordingWriter();
    const engine = createAmbientEngine(writer);
    engine.handleFrame(solidSample(200, 0, 0));
    expect(vars.get(AMBIENT_VAR_R)).toBe("200");
    engine.handleFrame(solidSample(0, 0, 0));
    // One EMA step: 200 + (0-200)*0.18 = 164 — not an instant jump.
    expect(vars.get(AMBIENT_VAR_R)).toBe("164");
  });

  it("writes only changed values", () => {
    const { writer, vars } = recordingWriter();
    const engine = createAmbientEngine(writer);
    engine.handleFrame(solidSample(12, 34, 56));
    const sizeAfterFirst = vars.size;
    engine.handleFrame(solidSample(12, 34, 56));
    engine.handleFrame(solidSample(12, 34, 56));
    expect(vars.size).toBe(sizeAfterFirst);
  });

  it("dark scenes get zero alpha (darkSkip) and recover when bright", () => {
    const { writer, vars } = recordingWriter();
    const engine = createAmbientEngine(writer);
    engine.handleFrame(solidSample(5, 5, 5));
    expect(vars.get(AMBIENT_VAR_A)).toBe("0.00");
    for (let i = 0; i < 30; i++) engine.handleFrame(solidSample(255, 255, 255));
    expect(Number(vars.get(AMBIENT_VAR_A))).toBeGreaterThan(0);
  });

  it("darkSkip off keeps the glow on dark frames", () => {
    const { writer, vars } = recordingWriter();
    const engine = createAmbientEngine(writer, {
      ...DEFAULT_SETTINGS,
      darkSkip: false,
    });
    engine.handleFrame(solidSample(5, 5, 5));
    expect(Number(vars.get(AMBIENT_VAR_A))).toBeGreaterThan(0);
  });

  it("sound reactivity dims intensity in frame-sound mode", () => {
    const { writer, vars } = recordingWriter();
    const engine = createAmbientEngine(writer, {
      ...DEFAULT_SETTINGS,
      mode: "frame-sound",
    });
    engine.handleFrame(solidSample(200, 100, 50));
    const bright = Number(vars.get(AMBIENT_VAR_A));
    engine.handleSound({ pause: true, mute: false, volume: 100 });
    expect(Number(vars.get(AMBIENT_VAR_A))).toBeLessThan(bright);
    engine.handleSound({ pause: false, mute: false, volume: 100 });
    expect(Number(vars.get(AMBIENT_VAR_A))).toBe(bright);
  });

  it("disabled writes the default (zero) vars", () => {
    const { writer, vars } = recordingWriter();
    const engine = createAmbientEngine(writer);
    engine.handleFrame(solidSample(200, 100, 50));
    engine.setSettings({ ...DEFAULT_SETTINGS, enabled: false });
    expect(vars.get(AMBIENT_VAR_A)).toBe("0.00");
  });

  it("reset restores the default vars even after frames", () => {
    const { writer, vars } = recordingWriter();
    const engine = createAmbientEngine(writer);
    engine.handleFrame(solidSample(200, 100, 50));
    engine.reset();
    expect(vars.get(AMBIENT_VAR_R)).toBe("0");
    expect(vars.get(AMBIENT_VAR_G)).toBe("0");
    expect(vars.get(AMBIENT_VAR_B)).toBe("0");
    expect(vars.get(AMBIENT_VAR_A)).toBe("0.00");
  });
});

describe("parseSettings / createAmbientSettings", () => {
  it("clamps and falls back on bad values", () => {
    const s = parseSettings({
      enabled: "yes",
      intensity: 5,
      mode: "bogus",
      darkSkip: 1,
    });
    expect(s.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(s.intensity).toBe(1);
    expect(s.mode).toBe(DEFAULT_SETTINGS.mode);
    expect(s.darkSkip).toBe(DEFAULT_SETTINGS.darkSkip);
  });

  it("persists patches to storage", () => {
    const storage = memoryStorage();
    const store = createAmbientSettings(storage);
    store.set({ enabled: false, intensity: 0.35, mode: "frame" });
    expect(store.get()).toEqual({
      enabled: false,
      intensity: 0.35,
      mode: "frame",
      darkSkip: DEFAULT_SETTINGS.darkSkip,
    });
    expect(storage.data.get("enabled")).toBe(false);
    expect(storage.data.get("mode")).toBe("frame");
  });
});

describe("glow layer (DOM plumbing)", () => {
  it("mounts one layer and removes it on dispose", () => {
    const { doc, children } = fakeDocument();
    const remove = mountGlowLayer(doc as unknown as Document);
    expect(children).toHaveLength(1);
    expect(children[0].className).toBe(GLOW_LAYER_CLASS);
    remove();
    expect(children).toHaveLength(0);
  });

  it("createRootVarWriter writes through style.setProperty", () => {
    const { doc, styleProps } = fakeDocument();
    const writer = createRootVarWriter(doc.documentElement);
    writer.setVar(AMBIENT_VAR_R, "42");
    expect(styleProps.get(AMBIENT_VAR_R)).toBe("42");
  });
});

/** Fake extension host: frames flow through the session frameHub. */
function makeHost(
  overrides: Partial<ExtensionRuntimeDeps> = {},
  seed: Record<string, unknown> = {},
) {
  const fake = fakeDocument();
  vi.stubGlobal("document", fake.doc);
  const snapshot = { ...DEFAULT_SNAPSHOT };
  const storage = memoryStorage(seed);
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
    frames: {
      subscribe: (cb, opts) => frameHub.subscribe(cb, opts),
    },
    storageFor: () => storage,
    setChromeHidden: () => {},
    ...overrides,
  };
  const host = {
    fake,
    storage,
    snapshot,
    runtime: null as ReturnType<typeof createExtensionRuntime> | null,
    emit(next: Partial<typeof DEFAULT_SNAPSHOT>) {
      Object.assign(snapshot, next);
      host.runtime?.notifySnapshot(snapshot);
    },
    glowCount: () => fake.children.length,
    vars: () => fake.styleProps,
  };
  host.runtime = createExtensionRuntime([ambientLight], deps);
  return host;
}

function publish(color: [number, number, number]) {
  const [r, g, b] = color;
  const width = 2;
  const height = 2;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  frameHub.publishFrame({ width, height, pts: 0, pixels });
}

describe("ambientLight extension (registry scenarios)", () => {
  const hosts: Array<ReturnType<typeof makeHost>> = [];

  function setup(
    overrides: Partial<ExtensionRuntimeDeps> = {},
    seed: Record<string, unknown> = {},
  ) {
    const host = makeHost(overrides, seed);
    hosts.push(host);
    return host;
  }

  afterEach(() => {
    while (hosts.length > 0) {
      const host = hosts.pop();
      host?.runtime?.dispose();
    }
    frameHub.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("follows the frame color and restores defaults after dispose", () => {
    const host = setup();
    publish([200, 100, 50]);
    expect(host.vars().get(AMBIENT_VAR_R)).toBe("200");

    host.runtime?.dispose();
    expect(host.vars().get(AMBIENT_VAR_R)).toBe("0");
    expect(host.vars().get(AMBIENT_VAR_A)).toBe("0.00");
  });

  it("frameHub.reset() alone removes the effect", () => {
    const host = setup();
    publish([200, 100, 50]);
    expect(host.vars().get(AMBIENT_VAR_R)).toBe("200");
    frameHub.reset();
    expect(host.vars().get(AMBIENT_VAR_A)).toBe("0.00");
  });

  it("leaving the player (onClose) restores the default look", () => {
    const host = setup();
    publish([200, 100, 50]);
    host.runtime?.notifyClose();
    expect(host.vars().get(AMBIENT_VAR_A)).toBe("0.00");
  });

  it("mounts the glow layer and removes it on dispose", () => {
    const host = setup();
    expect(host.glowCount()).toBe(1);
    expect(host.fake.children[0].className).toBe(GLOW_LAYER_CLASS);
    host.runtime?.dispose();
    expect(host.glowCount()).toBe(0);
  });

  it("snapshot sound state dims the glow in frame-sound mode", () => {
    const host = setup();
    publish([200, 100, 50]);
    const bright = Number(host.vars().get(AMBIENT_VAR_A));
    expect(bright).toBeGreaterThan(0);
    host.emit({ pause: true });
    expect(Number(host.vars().get(AMBIENT_VAR_A))).toBeLessThan(bright);
    host.emit({ pause: false, mute: true });
    expect(Number(host.vars().get(AMBIENT_VAR_A))).toBeLessThan(bright);
  });

  it("respects a stored «off» setting — no glow at all", () => {
    const host = setup({}, { enabled: false });
    publish([200, 100, 50]);
    expect(Number(host.vars().get(AMBIENT_VAR_A) ?? 0)).toBe(0);
  });

  it("registers the settings menu row", () => {
    const host = setup();
    const rows = host.runtime?.getSlotEntries("settings.menu") ?? [];
    expect(rows.length).toBeGreaterThan(0);
    // Rendering the row must not throw (slot render error isolation would
    // turn it into null — assert a real element instead).
    const node = rows[0].render();
    expect(node).not.toBeNull();
  });

  it("caps the frame tap at ~10 fps", () => {
    const seen: Array<{ maxFps?: number } | undefined> = [];
    setup({
      frames: {
        subscribe: (cb, opts) => {
          seen.push(opts);
          return frameHub.subscribe(cb, opts);
        },
      },
    });
    expect(seen[0]?.maxFps).toBe(AMBIENT_MAX_FPS);
  });
});
