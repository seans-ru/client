import { describe, expect, it } from "vitest";
import type { PlaybackCatalog, PlaybackEpisode } from "../src/api/playback";
import {
  catalogEpisodes,
  catalogSeasonGroups,
  findEpisodeById,
  formatEpisodeCode,
  formatEpisodePickerLabel,
  groupEpisodesBySeason,
  isEpisodePlayable,
  isSeriesCatalog,
  nextPlayableEpisode,
} from "../src/features/player/episodeHelpers";

function ep(partial: Partial<PlaybackEpisode> & { id: string }): PlaybackEpisode {
  return {
    id: partial.id,
    season: partial.season ?? 1,
    episode: partial.episode ?? 1,
    episode_end: partial.episode_end,
    title: partial.title,
    has_primary_video: partial.has_primary_video ?? true,
    audio_tracks: partial.audio_tracks,
    stream: partial.stream,
  };
}

describe("formatEpisodeCode", () => {
  it("renders SxxEyy and multi-episode packs", () => {
    expect(formatEpisodeCode(1, 3)).toBe("S01E03");
    expect(formatEpisodeCode(12, 1, 3)).toBe("S12E01–E03");
    expect(formatEpisodeCode(null, 5)).toBe("E05");
    expect(formatEpisodeCode(2, null)).toBe("S02");
    expect(formatEpisodeCode(null, null)).toBe("");
  });

  it("ignores non-positive / non-finite parts", () => {
    expect(formatEpisodeCode(0, 0)).toBe("");
    expect(formatEpisodeCode(Number.NaN, 2)).toBe("E02");
    expect(formatEpisodeCode(1, 2, 2)).toBe("S01E02");
    expect(formatEpisodeCode(1, 2, 1)).toBe("S01E02");
  });
});

describe("formatEpisodePickerLabel", () => {
  it("joins code and title", () => {
    expect(
      formatEpisodePickerLabel(
        ep({ id: "f1", season: 1, episode: 3, title: "Пилот" }),
      ),
    ).toBe("S01E03 · Пилот");
    expect(formatEpisodePickerLabel(ep({ id: "f2", season: 1, episode: 4 }))).toBe(
      "S01E04",
    );
  });
});

describe("playability and catalog flattening", () => {
  const catalog: PlaybackCatalog = {
    kind: "series",
    groups: [
      {
        season: 1,
        episodes: [
          ep({ id: "e1", season: 1, episode: 1 }),
          ep({ id: "e2", season: 1, episode: 2, has_primary_video: false }),
          ep({ id: "e3", season: 1, episode: 3, episode_end: 4 }),
        ],
      },
      {
        season: 2,
        episodes: [ep({ id: "e5", season: 2, episode: 1 })],
      },
    ],
    files: [ep({ id: "e1", season: 1, episode: 1 }), ep({ id: "e6", season: 2, episode: 2 })],
  };

  it("flattens groups + files with dedupe", () => {
    const list = catalogEpisodes(catalog);
    expect(list.map((e) => String(e.id))).toEqual(["e1", "e2", "e3", "e5", "e6"]);
  });

  it("hides Play for episodes without primary video", () => {
    expect(isEpisodePlayable(ep({ id: "a", has_primary_video: true }))).toBe(
      true,
    );
    expect(isEpisodePlayable(ep({ id: "b", has_primary_video: false }))).toBe(
      false,
    );
  });

  it("groups by season and orders episodes", () => {
    const groups = groupEpisodesBySeason([
      ep({ id: "b", season: 2, episode: 1 }),
      ep({ id: "a2", season: 1, episode: 2 }),
      ep({ id: "a1", season: 1, episode: 1 }),
    ]);
    expect(groups.map((g) => g.season)).toEqual([1, 2]);
    expect(groups[0].episodes.map((e) => String(e.id))).toEqual(["a1", "a2"]);
  });

  it("builds season groups from flat files when groups are absent", () => {
    const flat: PlaybackCatalog = {
      kind: "series",
      files: [ep({ id: "x2", season: 1, episode: 2 }), ep({ id: "x1", season: 1, episode: 1 })],
    };
    const groups = catalogSeasonGroups(flat);
    expect(groups).toHaveLength(1);
    expect(groups[0].episodes.map((e) => String(e.id))).toEqual(["x1", "x2"]);
  });

  it("finds current / next playable episodes", () => {
    expect(findEpisodeById(catalog, "e2")?.id).toBe("e2");
    expect(findEpisodeById(catalog, "missing")).toBeNull();
    // e2 is not playable; next after e1 should skip to e3.
    expect(nextPlayableEpisode(catalog, "e1")?.id).toBe("e3");
    expect(nextPlayableEpisode(catalog, "e5")?.id).toBe("e6");
    expect(nextPlayableEpisode(catalog, "e6")).toBeNull();
    expect(isSeriesCatalog(catalog)).toBe(true);
    expect(isSeriesCatalog({ kind: "movie" })).toBe(false);
  });
});
