import { describe, expect, it } from "vitest";
import {
  ASPECT_PRESETS,
  clampCropRect,
  clampPan,
  clampZoomPercent,
  createGeometryController,
  createGeometrySettings,
  CROP_LABEL,
  cropFilter,
  GEOMETRY_DEFAULT,
  geometry,
  geometryCommands,
  geometryResetCommands,
  labelRef,
  loadGeometryState,
  normalizeRotate,
  parseCropRect,
  parseGeometryState,
  saveGeometryState,
  zoomPercentToVideoZoom,
  type GeometryCommand,
  type GeometryState,
} from "../src/features/player/extensions/geometry";
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

type MpvCall =
  | { kind: "set"; args: [string, string | number | boolean] }
  | { kind: "command"; args: string[] };

function makeMpv(): MpvBridge & { calls: MpvCall[] } {
  const calls: MpvCall[] = [];
  return {
    calls,
    getProperty: async () => "",
    setProperty: async (name, value) => {
      calls.push({ kind: "set", args: [name, value] });
    },
    command: async (args: string[]) => {
      calls.push({ kind: "command", args: [...args] });
      return null;
    },
  };
}

function setsBy(
  commands: readonly GeometryCommand[],
): Map<string, string | number | boolean> {
  const map = new Map<string, string | number | boolean>();
  for (const command of commands) {
    if (command.op === "set") map.set(command.name, command.value);
  }
  return map;
}

describe("clamp / parse helpers (issue #15)", () => {
  it("clamps zoom to 10–400 percent", () => {
    expect(clampZoomPercent(100)).toBe(100);
    expect(clampZoomPercent(110)).toBe(110);
    expect(clampZoomPercent(5)).toBe(10);
    expect(clampZoomPercent(900)).toBe(400);
    expect(clampZoomPercent("x")).toBe(100);
  });

  it("clamps pan to ±1 and normalizes rotation to the 90° grid", () => {
    expect(clampPan(0.05)).toBe(0.05);
    expect(clampPan(-2)).toBe(-1);
    expect(clampPan(2)).toBe(1);
    expect(clampPan(Number.NaN)).toBe(0);
    expect(normalizeRotate(0)).toBe(0);
    expect(normalizeRotate(90)).toBe(90);
    expect(normalizeRotate(359)).toBe(0);
    expect(normalizeRotate(450)).toBe(90);
    expect(normalizeRotate(-90)).toBe(270);
    // Rounds to the nearest 90° step (JS Math.round half-up at 45).
    expect(normalizeRotate(40)).toBe(0);
    expect(normalizeRotate(50)).toBe(90);
  });

  it("parses crop rectangles and rejects junk", () => {
    expect(parseCropRect({ w: 1920, h: 800, x: 0, y: 140 })).toEqual({
      w: 1920,
      h: 800,
      x: 0,
      y: 140,
    });
    expect(parseCropRect({ w: 0, h: 10, x: 0, y: 0 })).toBeNull();
    expect(parseCropRect({ w: 10, h: 10, x: -5, y: 0 })).toEqual({
      w: 10,
      h: 10,
      x: 0,
      y: 0,
    });
    expect(parseCropRect(null)).toBeNull();
    expect(parseCropRect({ w: "x", h: 1, x: 0, y: 0 })).toBeNull();
  });

  it("clamps crop to the decoded frame", () => {
    expect(clampCropRect({ w: 3000, h: 2000, x: 100, y: 100 }, 1920, 1080)).toEqual({
      w: 1920,
      h: 1080,
      x: 0,
      y: 0,
    });
    expect(clampCropRect({ w: 100, h: 100, x: 1900, y: 1000 }, 1920, 1080)).toEqual({
      w: 100,
      h: 100,
      x: 1820,
      y: 980,
    });
    // Unknown frame size: keeps the rect.
    expect(clampCropRect({ w: 10, h: 10, x: 1, y: 1 }, 0, 0)).toEqual({
      w: 10,
      h: 10,
      x: 1,
      y: 1,
    });
  });

  it("maps zoom percent to mpv log2 video-zoom", () => {
    expect(zoomPercentToVideoZoom(100)).toBe(0);
    expect(zoomPercentToVideoZoom(200)).toBe(1);
    expect(zoomPercentToVideoZoom(50)).toBe(-1);
    expect(zoomPercentToVideoZoom(110)).toBeCloseTo(Math.log2(1.1), 10);
    // Clamped before the log.
    expect(zoomPercentToVideoZoom(0)).toBe(zoomPercentToVideoZoom(10));
  });

  it("sanitizes persisted geometry state", () => {
    const state = parseGeometryState({
      aspect: "fill",
      zoomPercent: 150,
      rotate: 200,
      panX: -3,
      crop: { w: 100, h: 50, x: 0, y: 0 },
    });
    expect(state.aspect).toBe("fill");
    expect(state.zoomPercent).toBe(150);
    expect(state.rotate).toBe(180);
    expect(state.panX).toBe(-1);
    expect(state.crop).toEqual({ w: 100, h: 50, x: 0, y: 0 });
    expect(parseGeometryState("junk")).toEqual(GEOMETRY_DEFAULT);
  });
});

describe("geometryCommands (issue #15 mpv mapping)", () => {
  it("maps each aspect preset onto the documented properties", () => {
    const original = setsBy(geometryCommands({ ...GEOMETRY_DEFAULT, aspect: "original" }));
    expect(original.get("video-aspect-override")).toBe("no");
    expect(original.get("keepaspect")).toBe(true);
    expect(original.get("panscan")).toBe(0);

    const wide = setsBy(geometryCommands({ ...GEOMETRY_DEFAULT, aspect: "16:9" }));
    expect(wide.get("video-aspect-override")).toBe("16:9");

    const fourThree = setsBy(geometryCommands({ ...GEOMETRY_DEFAULT, aspect: "4:3" }));
    expect(fourThree.get("video-aspect-override")).toBe("4:3");

    const cinema = setsBy(geometryCommands({ ...GEOMETRY_DEFAULT, aspect: "2.39:1" }));
    expect(cinema.get("video-aspect-override")).toBe("2.39:1");

    // Растянуть: stretch-to-window via keepaspect=no (ignored in fullscreen).
    const stretch = setsBy(geometryCommands({ ...GEOMETRY_DEFAULT, aspect: "stretch" }));
    expect(stretch.get("keepaspect")).toBe(false);
    expect(stretch.get("panscan")).toBe(0);

    // Заполнить: crop-to-fill via panscan=1.
    const fill = setsBy(geometryCommands({ ...GEOMETRY_DEFAULT, aspect: "fill" }));
    expect(fill.get("panscan")).toBe(1);
    expect(fill.get("keepaspect")).toBe(true);
  });

  it("covers every preset in the exported list", () => {
    for (const preset of ASPECT_PRESETS) {
      const sets = setsBy(geometryCommands({ ...GEOMETRY_DEFAULT, aspect: preset }));
      expect(sets.has("video-aspect-override")).toBe(true);
      expect(sets.has("keepaspect")).toBe(true);
      expect(sets.has("panscan")).toBe(true);
    }
  });

  it("maps zoom / rotate / pan to mpv values", () => {
    const sets = setsBy(
      geometryCommands({
        aspect: "original",
        zoomPercent: 110,
        rotate: 90,
        panX: 0.1,
        panY: -0.05,
        crop: null,
      }),
    );
    expect(sets.get("video-zoom")).toBeCloseTo(Math.log2(1.1), 10);
    expect(sets.get("video-rotate")).toBe(90);
    expect(sets.get("video-pan-x")).toBe(0.1);
    expect(sets.get("video-pan-y")).toBe(-0.05);
  });

  it("adds and removes the named crop filter", () => {
    const withCrop = geometryCommands({
      ...GEOMETRY_DEFAULT,
      crop: { w: 1920, h: 800, x: 0, y: 140 },
    });
    const filter = withCrop.find((c) => c.op === "filter");
    expect(filter).toEqual({
      op: "filter",
      filterOp: "add",
      entry: cropFilter({ w: 1920, h: 800, x: 0, y: 140 }),
    });
    expect(cropFilter({ w: 1920, h: 800, x: 0, y: 140 })).toBe(
      `@${CROP_LABEL}:crop=1920:800:0:140`,
    );

    const withoutCrop = geometryCommands(GEOMETRY_DEFAULT);
    expect(withoutCrop.find((c) => c.op === "filter")).toEqual({
      op: "filter",
      filterOp: "remove",
      entry: labelRef(CROP_LABEL),
    });
  });

  it("reset commands return the original geometry and drop the crop", () => {
    const sets = setsBy(geometryResetCommands());
    expect(sets.get("video-aspect-override")).toBe("no");
    expect(sets.get("keepaspect")).toBe(true);
    expect(sets.get("panscan")).toBe(0);
    expect(sets.get("video-zoom")).toBe(0);
    expect(sets.get("video-rotate")).toBe(0);
    expect(sets.get("video-pan-x")).toBe(0);
    expect(sets.get("video-pan-y")).toBe(0);
    expect(
      geometryResetCommands().find((c) => c.op === "filter"),
    ).toEqual({ op: "filter", filterOp: "remove", entry: labelRef(CROP_LABEL) });
    // Distinct from the other extensions' filter labels.
    expect(CROP_LABEL).not.toBe("seans-sharpen");
    expect(CROP_LABEL).not.toBe("seans-denoise");
    expect(CROP_LABEL).not.toBe("seans-eq");
  });
});

describe("per-file + global memory (issue #15)", () => {
  const fileState: GeometryState = {
    aspect: "fill",
    zoomPercent: 120,
    rotate: 90,
    panX: 0.05,
    panY: 0,
    crop: { w: 100, h: 100, x: 0, y: 0 },
  };

  it("restores file state, then global default, then built-in default", () => {
    const storage = makeStorage({
      "file.k1": fileState,
      global: { ...GEOMETRY_DEFAULT, zoomPercent: 110 },
    });
    expect(loadGeometryState(storage, "k1")).toEqual(fileState);
    expect(loadGeometryState(storage, "k2").zoomPercent).toBe(110);
    expect(loadGeometryState(storage, null).zoomPercent).toBe(110);
    expect(loadGeometryState(makeStorage(), "k3")).toEqual(GEOMETRY_DEFAULT);
  });

  it("saves and clears per-file records", () => {
    const storage = makeStorage();
    saveGeometryState(storage, "k1", fileState);
    expect(loadGeometryState(storage, "k1")).toEqual(fileState);
    storage.set("file.k1", null);
    expect(loadGeometryState(storage, "k1")).toEqual(GEOMETRY_DEFAULT);
  });
});

describe("createGeometrySettings / controller", () => {
  it("getVideoSize keeps snapshot identity between changes", () => {
    const settings = createGeometrySettings(makeStorage());
    expect(settings.getVideoSize()).toBe(settings.getVideoSize());
    const before = settings.getVideoSize();
    settings.refreshVideoSize({ ...DEFAULT_SNAPSHOT, video_w: 1920, video_h: 1080 });
    const after = settings.getVideoSize();
    expect(after).not.toBe(before);
    expect(after).toEqual({ w: 1920, h: 1080 });
    expect(settings.getVideoSize()).toBe(after);
    settings.refreshVideoSize({ ...DEFAULT_SNAPSHOT, video_w: 1920, video_h: 1080 });
    expect(settings.getVideoSize()).toBe(after);
  });

  it("steps zoom by ±10 percent and rotates in 90° increments", () => {
    const settings = createGeometrySettings(makeStorage());
    settings.zoomBy(10);
    expect(settings.getState().zoomPercent).toBe(110);
    settings.zoomBy(-10);
    expect(settings.getState().zoomPercent).toBe(100);
    settings.zoomBy(-500);
    expect(settings.getState().zoomPercent).toBe(10);
    settings.rotateBy(90);
    settings.rotateBy(90);
    expect(settings.getState().rotate).toBe(180);
    settings.rotateBy(270);
    expect(settings.getState().rotate).toBe(90);
    settings.panBy(0.05, -0.05);
    expect(settings.getState().panX).toBeCloseTo(0.05, 10);
    expect(settings.getState().panY).toBeCloseTo(-0.05, 10);
  });

  it("resetFile restores the original look and drops the file record", () => {
    const storage = makeStorage({
      global: { ...GEOMETRY_DEFAULT, zoomPercent: 130 },
    });
    const settings = createGeometrySettings(storage);
    settings.loadForFile("k1");
    settings.patch({ aspect: "4:3", zoomPercent: 120 });
    expect(loadGeometryState(storage, "k1").zoomPercent).toBe(120);
    settings.resetFile();
    expect(settings.getState()).toEqual(GEOMETRY_DEFAULT);
    expect(loadGeometryState(storage, "k1").zoomPercent).toBe(130); // back to global
  });

  it("saveAsGlobalDefault remembers the current geometry globally", () => {
    const storage = makeStorage();
    const settings = createGeometrySettings(storage);
    settings.patch({ aspect: "16:9", zoomPercent: 110 });
    settings.saveAsGlobalDefault();
    expect(loadGeometryState(storage, "other-file").aspect).toBe("16:9");
    expect(loadGeometryState(storage, "other-file").zoomPercent).toBe(110);
  });

  it("controller applies instantly and resets on dispose", () => {
    const mpv = makeMpv();
    const controller = createGeometryController(mpv, makeStorage());
    mpv.calls.length = 0;
    controller.settings.patch({ aspect: "fill", zoomPercent: 110 });
    const sets = new Map(
      mpv.calls
        .filter((c): c is Extract<MpvCall, { kind: "set" }> => c.kind === "set")
        .map((c) => c.args),
    );
    expect(sets.get("panscan")).toBe(1);
    expect(sets.get("video-zoom")).toBeCloseTo(Math.log2(1.1), 10);

    mpv.calls.length = 0;
    controller.dispose();
    const resetSets = new Map(
      mpv.calls
        .filter((c): c is Extract<MpvCall, { kind: "set" }> => c.kind === "set")
        .map((c) => c.args),
    );
    expect(resetSets.get("panscan")).toBe(0);
    expect(resetSets.get("video-zoom")).toBe(0);
    expect(
      mpv.calls.some(
        (c) =>
          c.kind === "command" &&
          c.args[0] === "vf" &&
          c.args[1] === "remove" &&
          c.args[2] === labelRef(CROP_LABEL),
      ),
    ).toBe(true);

    // Changes after dispose no longer touch mpv.
    mpv.calls.length = 0;
    controller.settings.patch({ rotate: 90 });
    expect(mpv.calls).toEqual([]);
  });

  it("survives mpv rejects without throwing", () => {
    const mpv: MpvBridge = {
      getProperty: async () => "",
      setProperty: async () => {
        throw new Error("property is reserved");
      },
      command: async () => {
        throw new Error("vf is not available");
      },
    };
    const controller = createGeometryController(mpv, makeStorage());
    expect(() => controller.settings.patch({ crop: { w: 2, h: 2, x: 0, y: 0 } })).not.toThrow();
    expect(() => controller.reset()).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });
});

describe("geometry extension (registry scenarios)", () => {
  function setup() {
    const mpv = makeMpv();
    const storage = makeStorage({
      "file.cdn.example.com/b.mkv": {
        aspect: "4:3",
        zoomPercent: 110,
        rotate: 90,
        panX: 0,
        panY: 0,
        crop: { w: 100, h: 80, x: 0, y: 0 },
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
    const runtime = createExtensionRuntime([geometry], deps);
    return { mpv, runtime, storage };
  }

  it("restores per-file geometry on open", () => {
    const { mpv, runtime } = setup();
    mpv.calls.length = 0;
    runtime.notifyOpen({
      url: "https://cdn.example.com/b.mkv?sig=1",
      startAt: null,
      source: "vod",
    });
    const sets = new Map(
      mpv.calls
        .filter((c): c is Extract<MpvCall, { kind: "set" }> => c.kind === "set")
        .map((c) => c.args),
    );
    expect(sets.get("video-aspect-override")).toBe("4:3");
    expect(sets.get("video-rotate")).toBe(90);
    expect(
      mpv.calls.some(
        (c) =>
          c.kind === "command" &&
          c.args[0] === "vf" &&
          c.args[1] === "add" &&
          String(c.args[2]).startsWith(`@${CROP_LABEL}:crop=100:80`),
      ),
    ).toBe(true);
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(1);
    runtime.dispose();
  });

  it("reset on close and dispose returns the original geometry", () => {
    const { mpv, runtime } = setup();
    runtime.notifyOpen({
      url: "https://cdn.example.com/b.mkv?sig=1",
      startAt: null,
      source: "vod",
    });
    mpv.calls.length = 0;
    runtime.notifyClose();
    const closeSets = new Map(
      mpv.calls
        .filter((c): c is Extract<MpvCall, { kind: "set" }> => c.kind === "set")
        .map((c) => c.args),
    );
    expect(closeSets.get("video-rotate")).toBe(0);
    expect(closeSets.get("video-aspect-override")).toBe("no");

    mpv.calls.length = 0;
    runtime.dispose();
    expect(
      mpv.calls.some(
        (c) =>
          c.kind === "command" &&
          c.args[0] === "vf" &&
          c.args[1] === "remove" &&
          c.args[2] === labelRef(CROP_LABEL),
      ),
    ).toBe(true);
  });
});
