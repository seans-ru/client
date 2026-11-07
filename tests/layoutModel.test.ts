import { describe, expect, it } from "vitest";
import {
  defaultChromeSchema,
  type ChromeSchema,
} from "../src/features/playerSettings/chromeSchema";
import {
  CHROME_ENTRIES,
  defaultPlacement,
  hideEntry,
  isEntryHidden,
  moveEntry,
  resolveLayout,
  resetLayout,
  showEntry,
  toggleEntryHidden,
} from "../src/features/playerSettings/layoutModel";

function ids(entries: { id: string }[]): string[] {
  return entries.map((entry) => entry.id);
}

describe("resolveLayout", () => {
  it("places every catalog entry exactly once", () => {
    const resolved = resolveLayout(defaultChromeSchema());
    const all = [
      ...ids(resolved.slots["controls.primary"]),
      ...ids(resolved.slots["controls.secondary"]),
      ...ids(resolved.slots["settings.menu"]),
      ...ids(resolved.hidden),
    ];
    expect(new Set(all).size).toBe(CHROME_ENTRIES.length);
    expect(all.sort()).toEqual(CHROME_ENTRIES.map((e) => e.id).sort());
  });

  it("fills empty/partial layouts from catalog defaults", () => {
    const schema: ChromeSchema = {
      ...defaultChromeSchema(),
      layout: { "controls.primary": ["btn.fullscreen"], "controls.secondary": [], "settings.menu": [] },
    };
    const resolved = resolveLayout(schema);
    expect(resolved.slots["controls.primary"][0].id).toBe("btn.fullscreen");
    // The rest of the primary cluster follows; volume stays in secondary.
    expect(ids(resolved.slots["controls.primary"])).toContain("btn.playPause");
    expect(ids(resolved.slots["controls.secondary"])).toContain("btn.volume");
  });

  it("drops unknown ids and duplicates, refilling defaults for missing ones", () => {
    const schema: ChromeSchema = {
      ...defaultChromeSchema(),
      layout: {
        "controls.primary": ["btn.time", "ghost", "btn.time"],
        "controls.secondary": [],
        "settings.menu": [],
      },
      hidden: ["ghost", "btn.volume"],
    };
    const resolved = resolveLayout(schema);
    // btn.playPause is absent from the stored layout — it falls back to its
    // default slot (controls.primary), after the explicitly placed entries.
    expect(ids(resolved.slots["controls.primary"])).toEqual(["btn.time", "btn.playPause"]);
    expect(ids(resolved.hidden)).toEqual(["btn.volume"]);
  });

  it("keeps hidden entries out of the slots", () => {
    const schema = hideEntry(defaultChromeSchema(), "btn.fullscreen");
    const resolved = resolveLayout(schema);
    expect(ids(resolved.slots["controls.secondary"])).not.toContain("btn.fullscreen");
    expect(ids(resolved.hidden)).toContain("btn.fullscreen");
    expect(isEntryHidden(schema, "btn.fullscreen")).toBe(true);
  });
});

describe("placement mutations", () => {
  it("moveEntry reorders inside a slot", () => {
    const schema = defaultChromeSchema();
    const moved = moveEntry(schema, "btn.volume", "controls.secondary", 0);
    expect(ids(resolveLayout(moved).slots["controls.secondary"])).toEqual([
      "btn.volume",
      "btn.settings",
      "btn.sidecar",
      "btn.fullscreen",
    ]);
  });

  it("moveEntry refuses slots the entry may not occupy", () => {
    const schema = defaultChromeSchema();
    // Function rows live in the settings menu only.
    expect(moveEntry(schema, "fn.eq", "controls.primary", 0)).toBe(schema);
  });

  it("moveEntry transfers across slots and un-hides", () => {
    const hidden = hideEntry(defaultChromeSchema(), "btn.fullscreen");
    const moved = moveEntry(hidden, "btn.fullscreen", "controls.primary", 0);
    const resolved = resolveLayout(moved);
    expect(ids(resolved.slots["controls.primary"])[0]).toBe("btn.fullscreen");
    expect(ids(resolved.hidden)).toEqual([]);
  });

  it("moveEntry clamps the target index", () => {
    const moved = moveEntry(defaultChromeSchema(), "btn.playPause", "controls.primary", 99);
    const primary = ids(resolveLayout(moved).slots["controls.primary"]);
    expect(primary[primary.length - 1]).toBe("btn.playPause");
  });

  it("hide/show round-trips", () => {
    const schema = defaultChromeSchema();
    const hidden = hideEntry(schema, "fn.eq");
    expect(isEntryHidden(hidden, "fn.eq")).toBe(true);
    const shown = showEntry(hidden, "fn.eq");
    expect(isEntryHidden(shown, "fn.eq")).toBe(false);
    expect(ids(resolveLayout(shown).slots["settings.menu"])).toContain("fn.eq");
  });

  it("toggleEntryHidden flips visibility", () => {
    const schema = defaultChromeSchema();
    expect(isEntryHidden(toggleEntryHidden(schema, "btn.time"), "btn.time")).toBe(true);
    expect(
      isEntryHidden(toggleEntryHidden(toggleEntryHidden(schema, "btn.time"), "btn.time"), "btn.time"),
    ).toBe(false);
  });

  it("resetLayout restores defaults and keeps other schema state", () => {
    let schema = moveEntry(defaultChromeSchema(), "btn.playPause", "settings.menu", 0);
    schema = { ...schema, features: { eq: { enabled: false } } };
    const reset = resetLayout(schema);
    expect(reset.features).toEqual({ eq: { enabled: false } });
    expect(reset).toEqual({ ...schema, ...defaultPlacement() });
    expect(ids(resolveLayout(reset).slots["controls.primary"])).toEqual([
      "btn.playPause",
      "btn.time",
    ]);
  });

  it("unknown entry ids are no-ops", () => {
    const schema = defaultChromeSchema();
    expect(moveEntry(schema, "ghost", "controls.primary", 0)).toBe(schema);
    expect(hideEntry(schema, "ghost")).toBe(schema);
  });
});
