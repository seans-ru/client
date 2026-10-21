import { describe, expect, it } from "vitest";
import type { HistoryResponse, LibraryItem } from "../src/api/types";
import {
  continueFileForItem,
  filterLibraryItems,
  formatWatchState,
  nextEpisodeFile,
  resumePositionForFile,
  watchStateForItem,
  watchStateFromFile,
} from "../src/features/library/libraryHelpers";
import type { LibraryFile } from "../src/api/types";

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

function makeHistory(overrides: Partial<HistoryResponse> = {}): HistoryResponse {
  return {
    id: 1,
    task_file_id: 1,
    position_sec: 0,
    duration_sec: 100,
    completed: false,
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeItem(files: LibraryFile[]): LibraryItem {
  return {
    library_item: { id: 1, status: "ready", created_at: "2026-01-01T00:00:00Z" },
    media_item: {
      id: 1,
      title: "Test",
      poster_url: null,
      kp_type: "FILM",
      year: 2020,
    },
    files,
    total_size: 300,
    ready: true,
  };
}

describe("formatWatchState", () => {
  it("renders Russian chips", () => {
    expect(formatWatchState("planned")).toBe("Планирую");
    expect(formatWatchState("watching")).toBe("Смотрю");
    expect(formatWatchState("watched")).toBe("Смотрел");
  });
});

describe("watch state from history", () => {
  it("maps missing history to planned", () => {
    expect(watchStateFromFile(makeFile(), [])).toBe("planned");
  });

  it("maps in-progress history to watching", () => {
    const history = [
      makeHistory({ task_file_id: 1, position_sec: 10, duration_sec: 100 }),
    ];
    expect(watchStateFromFile(makeFile(), history)).toBe("watching");
  });

  it("maps completed history to watched", () => {
    const history = [makeHistory({ task_file_id: 1, completed: true })];
    expect(watchStateFromFile(makeFile(), history)).toBe("watched");
  });

  it("aggregates item state: watching wins", () => {
    const item = makeItem([makeFile({ id: 1 }), makeFile({ id: 2, episode: 2 })]);
    const history = [
      makeHistory({ task_file_id: 1, position_sec: 5, duration_sec: 100 }),
    ];
    expect(watchStateForItem(item, history)).toBe("watching");
  });

  it("returns watched when every file is completed", () => {
    const item = makeItem([makeFile({ id: 1 }), makeFile({ id: 2, episode: 2 })]);
    const history = [
      makeHistory({ task_file_id: 1, completed: true }),
      makeHistory({ task_file_id: 2, completed: true }),
    ];
    expect(watchStateForItem(item, history)).toBe("watched");
  });
});

describe("continue / next episode", () => {
  it("resumes the watching file", () => {
    const item = makeItem([makeFile({ id: 1 }), makeFile({ id: 2, episode: 2 })]);
    const history = [
      makeHistory({ task_file_id: 2, position_sec: 12, duration_sec: 100 }),
    ];
    expect(continueFileForItem(item, history)?.id).toBe(2);
    expect(resumePositionForFile({ id: 2 }, history)).toBe(12);
  });

  it("picks the next episode after started ones", () => {
    const item = makeItem([
      makeFile({ id: 1, episode: 1 }),
      makeFile({ id: 2, episode: 2 }),
      makeFile({ id: 3, episode: 3 }),
    ]);
    const history = [
      makeHistory({ task_file_id: 1, completed: true }),
      makeHistory({ task_file_id: 2, position_sec: 1, duration_sec: 10 }),
    ];
    expect(nextEpisodeFile(item, history)?.id).toBe(3);
  });

  it("returns null for movies without episode numbers", () => {
    expect(nextEpisodeFile(makeItem([makeFile({ episode: undefined })]), [])).toBeNull();
  });
});

describe("filterLibraryItems", () => {
  it("filters by derived watch state", () => {
    const watching = makeItem([makeFile({ id: 1 })]);
    const planned = makeItem([makeFile({ id: 9 })]);
    const history = [
      makeHistory({ task_file_id: 1, position_sec: 3, duration_sec: 10 }),
    ];
    expect(
      filterLibraryItems([watching, planned], history, "watching"),
    ).toHaveLength(1);
    expect(
      filterLibraryItems([watching, planned], history, "planned"),
    ).toHaveLength(1);
    expect(filterLibraryItems([watching, planned], history, "all")).toHaveLength(
      2,
    );
  });
});
