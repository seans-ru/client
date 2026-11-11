/**
 * mpv chapter parsing (issue #19) — pure, no bridge calls. The extension
 * bridge surfaces properties as strings only (scalar results), so chapters
 * are read either as a JSON blob (`chapter-list`) or through the indexed
 * sub-properties mpv exposes for list properties (`chapter-list/count`,
 * `chapter-list/{i}/title`, `chapter-list/{i}/time`).
 */

import type { SegmentMarker } from "../../theintrodb/types";

export type ChapterEntry = {
  /** 0-based mpv chapter index. */
  index: number;
  title: string;
  /** Start position (seconds). */
  timeSec: number;
};

/** Safety cap — real files have tens of chapters, not thousands. */
export const MAX_CHAPTERS = 200;

/**
 * Parse an mpv time value. `chapter-list/{i}/time` prints as `H:MM:SS(.ms)`
 * or `MM:SS(.ms)`; some builds stringify the raw double instead. Returns
 * null when nothing parses.
 */
export function parseMpvTime(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const plain = Number(text);
  if (Number.isFinite(plain) && plain >= 0) return plain;
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)$/.exec(text);
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3].replace(",", "."));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/** Fallback row title for unnamed chapters. */
export function chapterLabel(entry: ChapterEntry): string {
  const title = entry.title.trim();
  return title ? title : `Глава ${entry.index + 1}`;
}

/**
 * Parse a raw `chapter-list` property string. Accepts a JSON array of
 * `{title, time}` objects (mpv node dump / IPC shape); anything else is
 * treated as «no chapters here» so the caller can fall back to indexed reads.
 */
export function parseChapterListJson(
  raw: string | null | undefined,
): ChapterEntry[] | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: ChapterEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const timeSec = parseMpvTime(
      typeof r.time === "number" ? String(r.time) : (r.time as string | undefined),
    );
    if (timeSec == null) continue;
    out.push({
      index: out.length,
      title: typeof r.title === "string" ? r.title : "",
      timeSec,
    });
    if (out.length >= MAX_CHAPTERS) break;
  }
  return out;
}

/** Sort + normalize raw entries (fills titles, clamps count). Original
 * `index` values (mpv chapter numbers) are preserved for fallback labels. */
export function normalizeChapters(entries: readonly ChapterEntry[]): ChapterEntry[] {
  return [...entries]
    .filter((e) => Number.isFinite(e.timeSec) && e.timeSec >= 0)
    .sort((a, b) => a.timeSec - b.timeSec)
    .slice(0, MAX_CHAPTERS)
    .map((entry, order) =>
      entry.index >= 0 ? { ...entry } : { ...entry, index: order },
    );
}

/** Seek-bar markers for a chapter list (shared `SegmentMarker` format). */
export function chapterMarkers(
  chapters: readonly ChapterEntry[],
  onSelect: (entry: ChapterEntry) => void,
): SegmentMarker[] {
  return chapters.map((entry) => ({
    type: "chapter" as const,
    startMs: Math.round(entry.timeSec * 1000),
    endMs: null,
    label: chapterLabel(entry),
    onSelect: () => onSelect(entry),
  }));
}
