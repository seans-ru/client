/**
 * Subtitle style presets and the style → mpv property mapping (issue #25,
 * «Субтитры»). The editor writes a `SubtitleStyle`; the player applies it via
 * the mpv bridge (`sub-*` properties) and the preview renders the same values.
 */

import type { SubtitlePresetId, SubtitleStyle } from "./chromeSchema";
import { DEFAULT_SUBTITLE_STYLE } from "./chromeSchema";

export type SubtitlePreset = {
  id: SubtitlePresetId;
  label: string;
  style: SubtitleStyle;
};

export const SUBTITLE_PRESETS: readonly SubtitlePreset[] = [
  {
    id: "classic",
    label: "Классический",
    style: { ...DEFAULT_SUBTITLE_STYLE },
  },
  {
    id: "contrast",
    label: "Контрастный",
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      presetId: "contrast",
      color: "#FFE860",
      outlineWidth: 4,
      backgroundColor: "#000000",
      backgroundOpacity: 0.55,
    },
  },
  {
    id: "large",
    label: "Крупный",
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      presetId: "large",
      fontSize: 72,
      outlineWidth: 4,
      shadow: 2,
      position: 95,
    },
  },
];

export function getPreset(id: string): SubtitlePreset | undefined {
  return SUBTITLE_PRESETS.find((preset) => preset.id === id);
}

/**
 * Preset whose style matches exactly, or `"custom"`. The editor stamps this
 * on every change so the preset chips reflect the actual values.
 */
export function matchPreset(style: SubtitleStyle): SubtitlePresetId | "custom" {
  for (const preset of SUBTITLE_PRESETS) {
    if (stylesEqual(preset.style, style)) return preset.id;
  }
  return "custom";
}

function stylesEqual(a: SubtitleStyle, b: SubtitleStyle): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.color === b.color &&
    a.textOpacity === b.textOpacity &&
    a.outlineColor === b.outlineColor &&
    a.outlineWidth === b.outlineWidth &&
    a.shadow === b.shadow &&
    a.backgroundColor === b.backgroundColor &&
    a.backgroundOpacity === b.backgroundOpacity &&
    a.position === b.position &&
    a.assOverride === b.assOverride
  );
}

/** `#RRGGBB` + opacity → ASS color `&HAABBGGRR` (AA: 00 = opaque). */
export function toAssColor(hex: string, opacity: number): string {
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  const rr = match ? match[1] : "FF";
  const gg = match ? match[2] : "FF";
  const bb = match ? match[3] : "FF";
  const alpha = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255)
    .toString(16)
    .padStart(2, "0");
  return `&H${alpha}${bb}${gg}${rr}`.toUpperCase();
}

/**
 * mpv properties applied to the current file. `sub-ass-override` decides
 * whether our style wins over styles embedded in ASS subtitles.
 */
export function subtitleStyleProperties(
  style: SubtitleStyle,
): Record<string, string | number | boolean> {
  return {
    "sub-font": style.fontFamily,
    "sub-font-size": style.fontSize,
    "sub-color": toAssColor(style.color, style.textOpacity),
    "sub-border-color": toAssColor(style.outlineColor, style.textOpacity),
    "sub-border-size": style.outlineWidth,
    "sub-shadow-offset": style.shadow,
    "sub-back-color": toAssColor(style.backgroundColor, style.backgroundOpacity),
    "sub-pos": style.position,
    "sub-ass-override": style.assOverride ? "force" : "no",
  };
}

/** CSS preview of the style (settings preview mockup). */
export function subtitlePreviewCss(style: SubtitleStyle): {
  fontFamily: string;
  fontSize: string;
  color: string;
  textShadow: string;
  background: string;
  padding: string;
} {
  const textShadowParts = [
    `${style.outlineWidth / 2}px 0 ${style.outlineColor}`,
    `-${style.outlineWidth / 2}px 0 ${style.outlineColor}`,
    `0 ${style.outlineWidth / 2}px ${style.outlineColor}`,
    `0 -${style.outlineWidth / 2}px ${style.outlineColor}`,
  ];
  if (style.shadow > 0) {
    textShadowParts.push(`${style.shadow}px ${style.shadow}px 2px rgba(0,0,0,0.85)`);
  }
  return {
    fontFamily: `"${style.fontFamily}", sans-serif`,
    fontSize: `${Math.max(11, Math.round(style.fontSize * 0.32))}px`,
    color: withAlpha(style.color, style.textOpacity),
    textShadow: textShadowParts.join(", "),
    background:
      style.backgroundOpacity > 0
        ? withAlpha(style.backgroundColor, style.backgroundOpacity)
        : "transparent",
    padding: style.backgroundOpacity > 0 ? "2px 10px" : "0",
  };
}

function withAlpha(hex: string, opacity: number): string {
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!match) return hex;
  const r = parseInt(match[1], 16);
  const g = parseInt(match[2], 16);
  const b = parseInt(match[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, opacity))})`;
}
