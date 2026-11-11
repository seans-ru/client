import { describe, expect, it } from "vitest";
import {
  addBookmark,
  bookmarkMarkers,
  bookmarksExport,
  bookmarkTitle,
  normalizePosition,
  parseBookmarks,
  removeBookmark,
  sortBookmarks,
  updateBookmarkNote,
  BOOKMARK_SOFT_LIMIT,
  type Bookmark,
} from "../src/features/player/extensions/bookmarksPolicy";

const T0 = "2026-01-01T10:00:00.000Z";

function bm(positionSec: number, over: Partial<Bookmark> = {}): Bookmark {
  return {
    id: over.id ?? `id-${positionSec}`,
    positionSec,
    note: over.note ?? "",
    createdAt: over.createdAt ?? T0,
  };
}

describe("normalizePosition", () => {
  it("keeps 0.1 s precision and clamps junk to 0", () => {
    expect(normalizePosition(83.36)).toBe(83.4);
    expect(normalizePosition(-3)).toBe(0);
    expect(normalizePosition(Number.NaN)).toBe(0);
  });
});

describe("addBookmark", () => {
  it("creates a one-tap bookmark (empty note) at the playhead", () => {
    const result = addBookmark([], { positionSec: 754.2, now: T0 });
    expect(result.added.positionSec).toBe(754.2);
    expect(result.added.note).toBe("");
    expect(result.added.createdAt).toBe(T0);
    expect(result.list).toEqual([result.added]);
    expect(result.limitReached).toBe(false);
  });

  it("trims the note and keeps the list sorted by timecode", () => {
    const first = addBookmark([], { positionSec: 100, now: T0 });
    const second = addBookmark(first.list, {
      positionSec: 20,
      note: "  ключевой диалог  ",
      now: T0,
    });
    expect(second.list.map((b) => b.positionSec)).toEqual([20, 100]);
    expect(second.list[0].note).toBe("ключевой диалог");
  });

  it("flags the soft limit but still adds", () => {
    const many = Array.from({ length: BOOKMARK_SOFT_LIMIT }, (_, i) => bm(i + 1));
    const result = addBookmark(many, { positionSec: 999, now: T0 });
    expect(result.limitReached).toBe(true);
    expect(result.list).toHaveLength(BOOKMARK_SOFT_LIMIT + 1);
  });
});

describe("removeBookmark / updateBookmarkNote", () => {
  it("removes by id", () => {
    const list = [bm(1), bm(2), bm(3)];
    expect(removeBookmark(list, "id-2").map((b) => b.positionSec)).toEqual([1, 3]);
  });

  it("updates and trims a note", () => {
    const list = [bm(1, { id: "a", note: "старое" })];
    const next = updateBookmarkNote(list, "a", "  новое  ");
    expect(next[0].note).toBe("новое");
    // Immutability: the source list is untouched.
    expect(list[0].note).toBe("старое");
  });
});

describe("sortBookmarks", () => {
  const list = [
    bm(30, { id: "c", createdAt: "2026-01-03T00:00:00.000Z" }),
    bm(10, { id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
    bm(20, { id: "b", createdAt: "2026-01-02T00:00:00.000Z" }),
  ];

  it("sorts by timecode", () => {
    expect(sortBookmarks(list, "time").map((b) => b.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts by creation date", () => {
    expect(sortBookmarks(list, "created").map((b) => b.id)).toEqual(["a", "b", "c"]);
  });
});

describe("bookmarkMarkers", () => {
  it("builds shared-format seek markers", () => {
    const seeks: number[] = [];
    const markers = bookmarkMarkers(
      [bm(5, { id: "x" }), bm(61.4, { note: "смех" })],
      (b) => seeks.push(b.positionSec),
    );
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      type: "bookmark",
      startMs: 5000,
      label: "Закладка",
    });
    expect(markers[1]).toMatchObject({
      type: "bookmark",
      startMs: 61400,
      label: "смех",
    });
    markers[1].onSelect?.();
    expect(seeks).toEqual([61.4]);
  });
});

describe("bookmarkTitle", () => {
  it("prefers the note, falls back to the timecode", () => {
    const fmt = (s: number) => `T${Math.floor(s)}`;
    expect(bookmarkTitle(bm(12, { note: "важно" }), fmt)).toBe("важно");
    expect(bookmarkTitle(bm(12), fmt)).toBe("T12");
  });
});

describe("bookmarksExport / parseBookmarks", () => {
  it("exports a stable JSON payload sorted by timecode", () => {
    const payload = bookmarksExport("file-7", [bm(2), bm(1)], T0);
    expect(payload).toEqual({
      kind: "seans.bookmarks",
      version: 1,
      exportedAt: T0,
      mediaKey: "file-7",
      bookmarks: [bm(1), bm(2)],
    });
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("round-trips through parseBookmarks and sorts by time", () => {
    const raw = [bm(20), bm(10, { id: "b" })];
    const parsed = parseBookmarks(raw);
    expect(parsed.map((b) => b.id)).toEqual(["b", "id-20"]);
  });

  it("drops malformed rows and repairs missing fields", () => {
    const parsed = parseBookmarks([
      { positionSec: 5 },
      { positionSec: "x" },
      null,
      { id: "", positionSec: 3, note: 7, createdAt: 1 },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBeTruthy();
    expect(parsed[1].note).toBe("");
    expect(parsed[1].createdAt).toBe(new Date(0).toISOString());
  });
});
