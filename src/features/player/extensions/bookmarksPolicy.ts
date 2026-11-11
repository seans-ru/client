/**
 * Bookmark model (issue #21) — pure, no DOM/storage. One bookmark = a
 * timecode + optional note + creation date, scoped per media file. The soft
 * limit warns but never blocks (issue: «мягкий лимит … с предупреждением»).
 */

import type { SegmentMarker } from "../../theintrodb/types";

export type Bookmark = {
  id: string;
  /** Playback position (seconds, fractional). */
  positionSec: number;
  /** Free-form note (empty = quick one-tap bookmark). */
  note: string;
  /** ISO timestamp. */
  createdAt: string;
};

export type BookmarkSort = "time" | "created";

/** Soft per-file limit (warn above, never reject). */
export const BOOKMARK_SOFT_LIMIT = 100;

export type AddResult = {
  list: Bookmark[];
  /** True when the add crossed the soft limit. */
  limitReached: boolean;
  added: Bookmark;
};

/** Deterministic-ish id: timestamp + random suffix (session-unique). */
export function bookmarkId(now = Date.now()): string {
  return `bm-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Round to whole seconds for stable sorting/dedup, keep 0.1 s precision. */
export function normalizePosition(positionSec: number): number {
  const t = Number.isFinite(positionSec) && positionSec > 0 ? positionSec : 0;
  return Math.round(t * 10) / 10;
}

/**
 * Append a bookmark (issue: quick bookmark = one tap, empty note). Returns
 * the new list plus a `limitReached` flag once the count passes the cap.
 */
export function addBookmark(
  list: readonly Bookmark[],
  input: { positionSec: number; note?: string; now?: Date | string },
  softLimit = BOOKMARK_SOFT_LIMIT,
): AddResult {
  const now =
    input.now instanceof Date
      ? input.now.toISOString()
      : typeof input.now === "string"
        ? input.now
        : new Date().toISOString();
  const added: Bookmark = {
    id: bookmarkId(typeof input.now === "string" ? Date.parse(input.now) : undefined),
    positionSec: normalizePosition(input.positionSec),
    note: (input.note ?? "").trim(),
    createdAt: now,
  };
  const next = [...list, added];
  return {
    list: sortBookmarks(next, "time"),
    limitReached: next.length > softLimit,
    added,
  };
}

export function removeBookmark(
  list: readonly Bookmark[],
  id: string,
): Bookmark[] {
  return list.filter((b) => b.id !== id);
}

export function updateBookmarkNote(
  list: readonly Bookmark[],
  id: string,
  note: string,
): Bookmark[] {
  return list.map((b) => (b.id === id ? { ...b, note: note.trim() } : b));
}

export function sortBookmarks(
  list: readonly Bookmark[],
  mode: BookmarkSort,
): Bookmark[] {
  const copy = [...list];
  if (mode === "created") {
    copy.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  } else {
    copy.sort((a, b) => a.positionSec - b.positionSec);
  }
  return copy;
}

/** Seek-bar markers (shared `SegmentMarker` format with chapters #19). */
export function bookmarkMarkers(
  list: readonly Bookmark[],
  onSelect: (bookmark: Bookmark) => void,
): SegmentMarker[] {
  return list.map((bookmark) => ({
    type: "bookmark" as const,
    startMs: Math.round(bookmark.positionSec * 1000),
    endMs: null,
    label: bookmark.note || "Закладка",
    onSelect: () => onSelect(bookmark),
  }));
}

/** Pretty timecode label for a bookmark row. */
export function bookmarkTitle(
  bookmark: Bookmark,
  formatTime: (seconds: number) => string,
): string {
  return bookmark.note || formatTime(bookmark.positionSec);
}

export type BookmarksExport = {
  kind: "seans.bookmarks";
  version: 1;
  exportedAt: string;
  mediaKey: string;
  bookmarks: Bookmark[];
};

/** JSON export payload (issue: экспорт списка закладок файла в JSON). */
export function bookmarksExport(
  mediaKey: string,
  list: readonly Bookmark[],
  now: Date | string = new Date(),
): BookmarksExport {
  return {
    kind: "seans.bookmarks",
    version: 1,
    exportedAt:
      now instanceof Date ? now.toISOString() : String(now),
    mediaKey,
    bookmarks: sortBookmarks(list, "time"),
  };
}

/** Parse a persisted per-file list; malformed payloads degrade to empty. */
export function parseBookmarks(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return [];
  const out: Bookmark[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const positionSec = typeof r.positionSec === "number" ? r.positionSec : NaN;
    if (!Number.isFinite(positionSec) || positionSec < 0) continue;
    out.push({
      id: typeof r.id === "string" && r.id ? r.id : bookmarkId(),
      positionSec: normalizePosition(positionSec),
      note: typeof r.note === "string" ? r.note : "",
      createdAt:
        typeof r.createdAt === "string" && r.createdAt
          ? r.createdAt
          : new Date(0).toISOString(),
    });
  }
  return sortBookmarks(out, "time");
}
