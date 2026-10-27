/**
 * TheIntroDB segment types (M8).
 *
 * Contract: GET https://api.theintrodb.org/v4/media?tmdb_id=&season=&episode=
 * Four segment kinds, each an array of `{start_ms, end_ms}` (nullable ends/starts).
 * Feature is silently off when `MediaDetail.tmdb_id` is null.
 */

export type TheIntroDbSegmentType = "intro" | "recap" | "credits" | "preview";

/** One normalized time range. `null` start = file start; `null` end = EOF. */
export type TheIntroDbSegment = {
  startMs: number | null;
  endMs: number | null;
};

/** Normalized bundle keyed by segment type. */
export type TheIntroDbBundle = {
  intro: TheIntroDbSegment[];
  recap: TheIntroDbSegment[];
  credits: TheIntroDbSegment[];
  preview: TheIntroDbSegment[];
};

/** Flat seek-bar / chapter row. `startMs` is resolved (null → 0). */
export type SegmentMarker = {
  type: TheIntroDbSegmentType;
  startMs: number;
  endMs: number | null;
  label: string;
};

/** A skip-button offer for intro/recap (personal, not broadcast). */
export type ActiveSkip = {
  type: TheIntroDbSegmentType;
  targetMs: number | null;
};

export const SEGMENT_TYPES: readonly TheIntroDbSegmentType[] = [
  "intro",
  "recap",
  "credits",
  "preview",
];

/** Seek bar strip colors (CSS class suffixes). */
export const SEGMENT_COLOR_CLASS: Record<TheIntroDbSegmentType, string> = {
  intro: "teal",
  recap: "blue",
  credits: "amber",
  preview: "gray",
};

export function emptyBundle(): TheIntroDbBundle {
  return { intro: [], recap: [], credits: [], preview: [] };
}

/** Stable empty bundle for render paths (avoids new identity each call). */
export const EMPTY_BUNDLE: TheIntroDbBundle = emptyBundle();

/** Russian label for a segment type (chapters menu, marker tooltip). */
export function segmentLabel(type: TheIntroDbSegmentType): string {
  switch (type) {
    case "intro":
      return "Интро";
    case "recap":
      return "Recap";
    case "credits":
      return "Титры";
    case "preview":
      return "Превью";
  }
}
