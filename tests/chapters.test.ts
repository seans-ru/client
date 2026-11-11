import { describe, expect, it } from "vitest";
import {
  chapterLabel,
  chapterMarkers,
  normalizeChapters,
  parseChapterListJson,
  parseMpvTime,
  MAX_CHAPTERS,
  type ChapterEntry,
} from "../src/features/player/extensions/chaptersPolicy";

describe("parseMpvTime", () => {
  it("accepts plain seconds", () => {
    expect(parseMpvTime("12.5")).toBe(12.5);
    expect(parseMpvTime("0")).toBe(0);
    expect(parseMpvTime(" 90 ")).toBe(90);
  });

  it("accepts H:MM:SS(.ms) and MM:SS(.ms)", () => {
    expect(parseMpvTime("1:02:03")).toBe(3723);
    expect(parseMpvTime("0:01:30.5")).toBe(90.5);
    expect(parseMpvTime("2:05")).toBe(125);
    expect(parseMpvTime("0:00:07,25")).toBe(7.25);
  });

  it("rejects junk", () => {
    expect(parseMpvTime(null)).toBeNull();
    expect(parseMpvTime("")).toBeNull();
    expect(parseMpvTime("abc")).toBeNull();
    expect(parseMpvTime("-5")).toBeNull();
  });
});

describe("parseChapterListJson", () => {
  it("parses a JSON array of {title, time}", () => {
    const raw = JSON.stringify([
      { title: "Opening", time: 0 },
      { title: "Act 1", time: 125.5 },
    ]);
    const parsed = parseChapterListJson(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed![1]).toMatchObject({ title: "Act 1", timeSec: 125.5 });
  });

  it("skips malformed rows and caps the count", () => {
    const raw = JSON.stringify([
      { title: "ok", time: 1 },
      { title: "bad" },
      "junk",
      { time: "1:00" },
    ]);
    const parsed = parseChapterListJson(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed![0]).toMatchObject({ title: "ok", timeSec: 1 });
    expect(parsed![1]).toMatchObject({ title: "", timeSec: 60 });

    const many = JSON.stringify(
      Array.from({ length: MAX_CHAPTERS + 10 }, (_, i) => ({ title: `c${i}`, time: i })),
    );
    expect(parseChapterListJson(many)).toHaveLength(MAX_CHAPTERS);
  });

  it("returns null for non-JSON property strings (fall back path)", () => {
    expect(parseChapterListJson(null)).toBeNull();
    expect(parseChapterListJson("")).toBeNull();
    expect(parseChapterListJson("0:00:12")).toBeNull();
    expect(parseChapterListJson("[not json")).toBeNull();
    expect(parseChapterListJson('{"title":"x"}')).toBeNull();
    expect(parseChapterListJson("[]")).toEqual([]);
  });
});

describe("chapterLabel / normalizeChapters / chapterMarkers", () => {
  const entries: ChapterEntry[] = [
    { index: 0, title: "Intro", timeSec: 30 },
    { index: 1, title: "", timeSec: 0 },
  ];

  it("falls back to a numbered title for unnamed chapters", () => {
    expect(chapterLabel(entries[0])).toBe("Intro");
    expect(chapterLabel(entries[1])).toBe("Глава 2");
  });

  it("sorts by time and keeps the mpv index for labels", () => {
    const normalized = normalizeChapters(entries);
    expect(normalized.map((e) => e.timeSec)).toEqual([0, 30]);
    expect(normalized.map((e) => e.index)).toEqual([1, 0]);
    expect(normalized[1].title).toBe("Intro");
  });

  it("drops negative/non-finite times and caps", () => {
    const dirty: ChapterEntry[] = [
      { index: 0, title: "a", timeSec: -1 },
      { index: 1, title: "b", timeSec: Number.NaN },
      { index: 2, title: "c", timeSec: 5 },
    ];
    expect(normalizeChapters(dirty).map((e) => e.title)).toEqual(["c"]);
  });

  it("builds shared-format seek markers with a seek callback", () => {
    const seeks: number[] = [];
    const markers = chapterMarkers(normalizeChapters(entries), (e) =>
      seeks.push(e.timeSec),
    );
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      type: "chapter",
      startMs: 0,
      label: "Глава 2",
    });
    expect(markers[1]).toMatchObject({
      type: "chapter",
      startMs: 30000,
      label: "Intro",
    });
    markers[1].onSelect?.();
    expect(seeks).toEqual([30]);
  });
});
