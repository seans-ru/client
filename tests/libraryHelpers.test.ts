import { describe, expect, it } from "vitest";
import type { LibraryFile } from "../src/api/types";
import {
  fileBaseName,
  filterReadyFiles,
  formatEpisodeLabel,
  formatLibraryStatus,
  canOfferPlay,
  isFileReady,
} from "../src/features/library/libraryHelpers";

function makeFile(overrides: Partial<LibraryFile> = {}): LibraryFile {
  return {
    id: 1,
    path: "s1/e1.mkv",
    size_bytes: 100,
    status: "ready",
    season: 1,
    episode: 1,
    ...overrides,
  };
}

describe("formatEpisodeLabel", () => {
  it("renders season and episode as «Сезон 1 · Серия 3»", () => {
    expect(formatEpisodeLabel(1, 3)).toBe("Сезон 1 · Серия 3");
  });

  it("renders short forms when only one part is known", () => {
    expect(formatEpisodeLabel(2, null)).toBe("Сезон 2");
    expect(formatEpisodeLabel(undefined, 5)).toBe("Серия 5");
  });

  it("returns empty string when neither is known", () => {
    expect(formatEpisodeLabel(undefined, undefined)).toBe("");
    expect(formatEpisodeLabel(null, null)).toBe("");
  });

  it("treats non-positive / non-finite values as missing", () => {
    expect(formatEpisodeLabel(0, 3)).toBe("Серия 3");
    expect(formatEpisodeLabel(1, 0)).toBe("Сезон 1");
    expect(formatEpisodeLabel(Number.NaN, 3)).toBe("Серия 3");
    expect(formatEpisodeLabel(1.7, 3.2)).toBe("Сезон 1 · Серия 3");
  });
});

describe("isFileReady / filterReadyFiles", () => {
  it("accepts ready-like statuses case-insensitively", () => {
    for (const status of [
      "ready",
      "Ready",
      "available",
      "completed",
      "done",
      "ok",
      "uploaded",
      "Uploaded",
      "stored",
    ]) {
      expect(isFileReady({ status })).toBe(true);
    }
  });

  it("rejects in-flight / unknown / empty statuses", () => {
    for (const status of ["downloading", "queued", "failed", "processing", "", "  "]) {
      expect(isFileReady({ status })).toBe(false);
    }
    expect(isFileReady({ status: undefined as unknown as string })).toBe(false);
    expect(isFileReady({ status: null as unknown as string })).toBe(false);
  });

  it("filters only ready files", () => {
    const files = [
      makeFile({ id: 1, status: "ready" }),
      makeFile({ id: 2, status: "downloading" }),
      makeFile({ id: 3, status: "completed" }),
    ];
    expect(filterReadyFiles(files).map((f) => f.id)).toEqual([1, 3]);
  });
});

describe("formatLibraryStatus", () => {
  it("maps known statuses to Russian labels", () => {
    expect(formatLibraryStatus("ready")).toBe("Готово");
    expect(formatLibraryStatus("uploaded")).toBe("Готово");
    expect(formatLibraryStatus("stored")).toBe("Готово");
    expect(formatLibraryStatus("downloading")).toBe("Загрузка");
    expect(formatLibraryStatus("processing")).toBe("Обработка");
    expect(formatLibraryStatus("queued")).toBe("В очереди");
    expect(formatLibraryStatus("failed")).toBe("Ошибка");
    expect(formatLibraryStatus("paused")).toBe("Пауза");
  });

  it("falls back to the raw status or an em dash", () => {
    expect(formatLibraryStatus("weird")).toBe("weird");
    expect(formatLibraryStatus("")).toBe("—");
  });
});

describe("fileBaseName", () => {
  it("extracts the last path segment for / and \\ separators", () => {
    expect(fileBaseName("s1/e1.mkv")).toBe("e1.mkv");
    expect(fileBaseName("s1\\e1.mkv")).toBe("e1.mkv");
    expect(fileBaseName("movie.mkv")).toBe("movie.mkv");
    expect(fileBaseName("")).toBe("");
  });
});

describe("canOfferPlay", () => {
  it("offers Play for ready and in-progress downloads", () => {
    expect(canOfferPlay(makeFile({ status: "ready" }))).toBe(true);
    expect(canOfferPlay(makeFile({ status: "downloading" }))).toBe(true);
    expect(canOfferPlay(makeFile({ status: "processing" }))).toBe(true);
  });

  it("locks Play for failed / empty statuses", () => {
    expect(canOfferPlay(makeFile({ status: "failed" }))).toBe(false);
    expect(canOfferPlay(makeFile({ status: "error" }))).toBe(false);
    expect(canOfferPlay(makeFile({ status: "" }))).toBe(false);
  });
});
