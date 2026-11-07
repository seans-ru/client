/**
 * Player chrome schema (issue #25): one versioned localStorage document that
 * holds feature flags, subtitle styles and the control layout. Single source
 * of truth for the settings section and for the player chrome.
 *
 * Storage key: `seans.player.chrome`. The document is versioned; older or
 * partial documents are upgraded by `migrateChromeSchema` (unknown fields are
 * dropped, missing fields fall back to defaults).
 */

export const CHROME_SCHEMA_KEY = "seans.player.chrome";
export const CHROME_SCHEMA_VERSION = 1;

export type SubtitlePresetId = "classic" | "contrast" | "large";

export type SubtitleStyle = {
  /** Preset the style came from; `"custom"` once any field diverges. */
  presetId: SubtitlePresetId | "custom";
  fontFamily: string;
  /** mpv `sub-font-size` (reference height, default 55). */
  fontSize: number;
  color: string;
  textOpacity: number;
  outlineColor: string;
  /** mpv `sub-border-size`. */
  outlineWidth: number;
  /** mpv `sub-shadow-offset`. */
  shadow: number;
  backgroundColor: string;
  backgroundOpacity: number;
  /** mpv `sub-pos` (0–100; 100 = bottom of the frame). */
  position: number;
  /** Force our style over ASS-embedded styles (mpv `sub-ass-override`). */
  assOverride: boolean;
};

/** Feature master switch: disabled features register nothing in the player. */
export type FeatureFlags = {
  enabled: boolean;
};

export type LayoutSlotId =
  | "controls.primary"
  | "controls.secondary"
  | "settings.menu";

export const LAYOUT_SLOTS: readonly LayoutSlotId[] = [
  "controls.primary",
  "controls.secondary",
  "settings.menu",
];

export type ChromeSchema = {
  version: number;
  features: Record<string, FeatureFlags>;
  subtitles: SubtitleStyle;
  /** Ordered visible entry ids per slot. */
  layout: Record<LayoutSlotId, string[]>;
  /** Entry ids hidden from the player chrome («глазик» выключен). */
  hidden: string[];
};

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  presetId: "classic",
  fontFamily: "Arial",
  fontSize: 55,
  color: "#FFFFFF",
  textOpacity: 1,
  outlineColor: "#000000",
  outlineWidth: 3,
  shadow: 0,
  backgroundColor: "#000000",
  backgroundOpacity: 0,
  position: 100,
  assOverride: true,
};

export function defaultChromeSchema(): ChromeSchema {
  return {
    version: CHROME_SCHEMA_VERSION,
    features: {},
    subtitles: { ...DEFAULT_SUBTITLE_STYLE },
    layout: { "controls.primary": [], "controls.secondary": [], "settings.menu": [] },
    hidden: [],
  };
}

/* ------------------------------------------------------------ normalization */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

/**
 * Font names travel into a CSS property and into mpv `sub-font` — keep them
 * to plain name characters so a crafted string cannot break out of the value.
 */
export function sanitizeFontName(value: unknown, fallback = "Arial"): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[^0-9a-zA-Z _\-А-Яа-яЁё]/g, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 64) : fallback;
}

export function normalizeSubtitles(raw: unknown): SubtitleStyle {
  const d = DEFAULT_SUBTITLE_STYLE;
  if (!isRecord(raw)) return { ...d };
  const presetId =
    raw.presetId === "classic" ||
    raw.presetId === "contrast" ||
    raw.presetId === "large" ||
    raw.presetId === "custom"
      ? raw.presetId
      : d.presetId;
  return {
    presetId,
    fontFamily: sanitizeFontName(raw.fontFamily, d.fontFamily),
    fontSize: Math.round(asNumber(raw.fontSize, d.fontSize, 10, 200)),
    color: isHexColor(raw.color) ? raw.color.toUpperCase() : d.color,
    textOpacity: asNumber(raw.textOpacity, d.textOpacity, 0, 1),
    outlineColor: isHexColor(raw.outlineColor) ? raw.outlineColor.toUpperCase() : d.outlineColor,
    outlineWidth: asNumber(raw.outlineWidth, d.outlineWidth, 0, 20),
    shadow: asNumber(raw.shadow, d.shadow, 0, 20),
    backgroundColor: isHexColor(raw.backgroundColor) ? raw.backgroundColor.toUpperCase() : d.backgroundColor,
    backgroundOpacity: asNumber(raw.backgroundOpacity, d.backgroundOpacity, 0, 1),
    position: Math.round(asNumber(raw.position, d.position, 0, 100)),
    assOverride: asBool(raw.assOverride, d.assOverride),
  };
}

function normalizeLayout(raw: unknown): Record<LayoutSlotId, string[]> {
  const out: Record<LayoutSlotId, string[]> = {
    "controls.primary": [],
    "controls.secondary": [],
    "settings.menu": [],
  };
  if (!isRecord(raw)) return out;
  for (const slot of LAYOUT_SLOTS) {
    const list = raw[slot];
    if (Array.isArray(list)) {
      out[slot] = list.filter((id): id is string => typeof id === "string" && id.length > 0);
    }
  }
  return out;
}

/**
 * Upgrade any stored document to the current version. Unknown versions lose
 * the fields we cannot read and keep the ones we understand; missing fields
 * fall back to defaults so old partial keys keep working.
 */
export function migrateChromeSchema(raw: unknown): ChromeSchema {
  const base = defaultChromeSchema();
  if (!isRecord(raw)) return base;

  const features: Record<string, FeatureFlags> = {};
  if (isRecord(raw.features)) {
    for (const [id, flags] of Object.entries(raw.features)) {
      if (isRecord(flags)) {
        features[id] = { enabled: asBool(flags.enabled, true) };
      }
    }
  }

  return {
    version: CHROME_SCHEMA_VERSION,
    features,
    subtitles: normalizeSubtitles(raw.subtitles),
    layout: normalizeLayout(raw.layout),
    hidden: Array.isArray(raw.hidden)
      ? raw.hidden.filter((id): id is string => typeof id === "string" && id.length > 0)
      : base.hidden,
  };
}

/* --------------------------------------------------------------- persistence */

export function loadChromeSchema(storage?: StorageLike): ChromeSchema {
  try {
    const store = storage ?? globalThis.localStorage;
    const raw = store?.getItem(CHROME_SCHEMA_KEY);
    if (raw == null) return defaultChromeSchema();
    return migrateChromeSchema(JSON.parse(raw) as unknown);
  } catch {
    return defaultChromeSchema();
  }
}

export function saveChromeSchema(schema: ChromeSchema, storage?: StorageLike): void {
  try {
    const store = storage ?? globalThis.localStorage;
    store?.setItem(CHROME_SCHEMA_KEY, JSON.stringify(schema));
  } catch (error) {
    // Quota / private mode — the session keeps working with in-memory state.
    console.warn("[player.chrome]", error);
  }
}
