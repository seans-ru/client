import { describe, expect, it } from "vitest";
import { DEFAULT_SUBTITLE_STYLE } from "../src/features/playerSettings/chromeSchema";
import {
  SUBTITLE_PRESETS,
  getPreset,
  matchPreset,
  subtitlePreviewCss,
  subtitleStyleProperties,
  toAssColor,
} from "../src/features/playerSettings/subtitleStyles";

describe("toAssColor", () => {
  it("converts hex + opacity to ASS &HAABBGGRR", () => {
    expect(toAssColor("#FF8000", 1)).toBe("&H000080FF");
    expect(toAssColor("#000000", 0)).toBe("&HFF000000");
    expect(toAssColor("#FFFFFF", 0.5)).toBe("&H80FFFFFF");
  });

  it("falls back to white for bad hex", () => {
    expect(toAssColor("red", 1)).toBe("&H00FFFFFF");
  });
});

describe("subtitleStyleProperties", () => {
  it("maps the classic style to mpv sub-* properties", () => {
    const props = subtitleStyleProperties(DEFAULT_SUBTITLE_STYLE);
    expect(props).toEqual({
      "sub-font": "Arial",
      "sub-font-size": 55,
      "sub-color": "&H00FFFFFF",
      "sub-border-color": "&H00000000",
      "sub-border-size": 3,
      "sub-shadow-offset": 0,
      "sub-back-color": "&HFF000000",
      "sub-pos": 100,
      "sub-ass-override": "force",
    });
  });

  it("disables ASS override when requested", () => {
    const props = subtitleStyleProperties({
      ...DEFAULT_SUBTITLE_STYLE,
      assOverride: false,
    });
    expect(props["sub-ass-override"]).toBe("no");
  });
});

describe("presets", () => {
  it("ships Классический / Контрастный / Крупный", () => {
    expect(SUBTITLE_PRESETS.map((p) => p.label)).toEqual([
      "Классический",
      "Контрастный",
      "Крупный",
    ]);
    expect(getPreset("contrast")?.style.backgroundOpacity).toBeGreaterThan(0);
    expect(getPreset("large")?.style.fontSize).toBeGreaterThan(DEFAULT_SUBTITLE_STYLE.fontSize);
    expect(getPreset("missing")).toBeUndefined();
  });

  it("matchPreset detects an exact preset and flags drift as custom", () => {
    expect(matchPreset({ ...DEFAULT_SUBTITLE_STYLE })).toBe("classic");
    expect(matchPreset({ ...getPreset("large")!.style })).toBe("large");
    expect(matchPreset({ ...DEFAULT_SUBTITLE_STYLE, fontSize: 60 })).toBe("custom");
    expect(
      matchPreset({ ...getPreset("contrast")!.style, presetId: "classic" }),
    ).toBe("contrast");
  });
});

describe("subtitlePreviewCss", () => {
  it("renders transparent background when opacity is 0", () => {
    const css = subtitlePreviewCss(DEFAULT_SUBTITLE_STYLE);
    expect(css.background).toBe("transparent");
    expect(css.color).toBe("rgba(255, 255, 255, 1)");
    expect(css.textShadow).toContain("1.5px 0 #000000");
  });

  it("adds the drop shadow and alpha background when set", () => {
    const css = subtitlePreviewCss({
      ...DEFAULT_SUBTITLE_STYLE,
      shadow: 2,
      backgroundColor: "#000000",
      backgroundOpacity: 0.5,
    });
    expect(css.background).toBe("rgba(0, 0, 0, 0.5)");
    expect(css.textShadow).toContain("2px 2px 2px rgba(0,0,0,0.85)");
    expect(css.padding).toBe("2px 10px");
  });
});
