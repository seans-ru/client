import { describe, expect, it } from "vitest";
import {
  CHROME_SCHEMA_KEY,
  DEFAULT_SUBTITLE_STYLE,
  defaultChromeSchema,
  loadChromeSchema,
  migrateChromeSchema,
  normalizeSubtitles,
  saveChromeSchema,
} from "../src/features/playerSettings/chromeSchema";
import type { StorageLike } from "../src/features/playerSettings/chromeSchema";
import {
  enabledExtensionIds,
  isFeatureEnabled,
  setFeatureEnabled,
} from "../src/features/playerSettings/featureCatalog";
import { createChromeStore } from "../src/features/playerSettings/chromeStore";

function makeStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("migrateChromeSchema", () => {
  it("returns defaults for garbage input", () => {
    expect(migrateChromeSchema(null)).toEqual(defaultChromeSchema());
    expect(migrateChromeSchema("oops")).toEqual(defaultChromeSchema());
    expect(migrateChromeSchema(42)).toEqual(defaultChromeSchema());
  });

  it("keeps understood fields of an older partial document", () => {
    const schema = migrateChromeSchema({
      version: 0,
      features: { eq: { enabled: false }, broken: "yes" },
      subtitles: { fontSize: 40, color: "#123456" },
      layout: { "controls.primary": ["btn.time"], junk: ["x"] },
      hidden: ["btn.volume", 7],
    });
    expect(schema.version).toBe(1);
    expect(schema.features).toEqual({ eq: { enabled: false } });
    expect(schema.subtitles.fontSize).toBe(40);
    expect(schema.subtitles.color).toBe("#123456");
    expect(schema.subtitles.presetId).toBe("classic");
    expect(schema.layout["controls.primary"]).toEqual(["btn.time"]);
    expect(schema.layout["controls.secondary"]).toEqual([]);
    expect(schema.hidden).toEqual(["btn.volume"]);
  });

  it("clamps out-of-range numbers and rejects bad colors", () => {
    const schema = migrateChromeSchema({
      subtitles: {
        fontSize: 5000,
        textOpacity: 3,
        position: -20,
        color: "red",
        outlineColor: "#AABBCC",
      },
    });
    expect(schema.subtitles.fontSize).toBe(200);
    expect(schema.subtitles.textOpacity).toBe(1);
    expect(schema.subtitles.position).toBe(0);
    expect(schema.subtitles.color).toBe(DEFAULT_SUBTITLE_STYLE.color);
    expect(schema.subtitles.outlineColor).toBe("#AABBCC");
  });

  it("keeps a newer document's readable fields", () => {
    const schema = migrateChromeSchema({
      version: 99,
      features: { stats: { enabled: true, extra: 1 } },
      subtitles: { presetId: "large" },
    });
    expect(schema.version).toBe(1);
    expect(schema.features).toEqual({ stats: { enabled: true } });
    expect(schema.subtitles.presetId).toBe("large");
  });
});

describe("normalizeSubtitles", () => {
  it("round-trips a default style", () => {
    expect(normalizeSubtitles(DEFAULT_SUBTITLE_STYLE)).toEqual(DEFAULT_SUBTITLE_STYLE);
  });

  it("preserves a valid preset id and rejects unknown ones", () => {
    expect(
      normalizeSubtitles({ ...DEFAULT_SUBTITLE_STYLE, presetId: "large" }).presetId,
    ).toBe("large");
    expect(
      normalizeSubtitles({ ...DEFAULT_SUBTITLE_STYLE, presetId: "mega" }).presetId,
    ).toBe("classic");
    expect(normalizeSubtitles({ fontSize: 60 }).presetId).toBe("classic");
    expect(normalizeSubtitles({ fontSize: 60 }).fontSize).toBe(60);
  });

  it("strips CSS/mpv metacharacters from font names", () => {
    expect(
      normalizeSubtitles({ fontFamily: 'Arial"; color:red; x="' }).fontFamily,
    ).toBe("Arial colorred x");
    expect(normalizeSubtitles({ fontFamily: "<script>" }).fontFamily).toBe("script");
    expect(normalizeSubtitles({ fontFamily: "   " }).fontFamily).toBe("Arial");
    expect(normalizeSubtitles({ fontFamily: 42 }).fontFamily).toBe("Arial");
    expect(normalizeSubtitles({ fontFamily: "PT Sans" }).fontFamily).toBe("PT Sans");
    expect(normalizeSubtitles({ fontFamily: "x".repeat(200) }).fontFamily).toHaveLength(64);
  });
});

describe("loadChromeSchema / saveChromeSchema", () => {
  it("round-trips through storage", () => {
    const storage = makeStorage();
    const schema = migrateChromeSchema({
      features: { eq: { enabled: false } },
      hidden: ["btn.time"],
    });
    saveChromeSchema(schema, storage);
    expect(storage.data.has(CHROME_SCHEMA_KEY)).toBe(true);
    expect(loadChromeSchema(storage)).toEqual(schema);
  });

  it("returns defaults when the key is missing or corrupt", () => {
    expect(loadChromeSchema(makeStorage())).toEqual(defaultChromeSchema());
    const corrupt = makeStorage({ [CHROME_SCHEMA_KEY]: "{not json" });
    expect(loadChromeSchema(corrupt)).toEqual(defaultChromeSchema());
  });

  it("does not throw when storage writes fail", () => {
    const broken: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => saveChromeSchema(defaultChromeSchema(), broken)).not.toThrow();
  });
});

describe("feature flags", () => {
  it("falls back to catalog defaults when the schema has no flags", () => {
    const schema = defaultChromeSchema();
    expect(isFeatureEnabled(schema, "eq")).toBe(true);
    expect(isFeatureEnabled(schema, "stats")).toBe(false);
    expect(isFeatureEnabled(schema, "markers")).toBe(true);
    expect(isFeatureEnabled(schema, "unknown")).toBe(true);
  });

  it("setFeatureEnabled writes a single flag", () => {
    const schema = setFeatureEnabled(defaultChromeSchema(), "stats", true);
    expect(schema.features).toEqual({ stats: { enabled: true } });
    expect(isFeatureEnabled(schema, "stats")).toBe(true);
    expect(isFeatureEnabled(schema, "eq")).toBe(true);
  });

  it("enabledExtensionIds lists only enabled extensions", () => {
    const off = setFeatureEnabled(defaultChromeSchema(), "eq", false);
    expect(enabledExtensionIds(off).has("eq")).toBe(false);
    expect(enabledExtensionIds(off).has("autohide")).toBe(true);
    expect(enabledExtensionIds(off).has("subtitle-style")).toBe(true);
    expect(enabledExtensionIds(off).has("stats-overlay")).toBe(false);
  });
});

describe("createChromeStore", () => {
  it("notifies subscribers and persists updates", () => {
    const storage = makeStorage();
    const store = createChromeStore(storage);
    const seen: boolean[] = [];
    const stop = store.subscribe(() => seen.push(store.get().features.eq?.enabled ?? true));

    store.setFeature("eq", false);
    expect(store.get().features.eq).toEqual({ enabled: false });
    expect(seen).toEqual([false]);

    const reloaded = createChromeStore(storage);
    expect(reloaded.get().features.eq).toEqual({ enabled: false });
    stop();
    store.setFeature("eq", true);
    expect(seen).toEqual([false]);
  });

  it("setSubtitles replaces the style", () => {
    const store = createChromeStore(makeStorage());
    store.setSubtitles({ ...DEFAULT_SUBTITLE_STYLE, fontSize: 70, presetId: "custom" });
    expect(store.get().subtitles.fontSize).toBe(70);
  });
});
