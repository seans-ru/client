import { describe, expect, it } from "vitest";
import type { PlaybackAudioTrack } from "../src/api/playback";
import {
  audioBadgeTone,
  audioPrefKey,
  formatAudioLanguage,
  formatPlaybackAudioLabel,
  isExternalAudioTrack,
  resolvePreferredAudioTrack,
} from "../src/features/player/audioTrackHelpers";

function track(
  partial: Partial<PlaybackAudioTrack> & { flags: PlaybackAudioTrack["flags"] },
): PlaybackAudioTrack {
  return {
    id: partial.id ?? "a1",
    language: partial.language ?? "ru",
    flags: partial.flags,
    embedded: partial.embedded ?? true,
    title: partial.title,
    url: partial.url,
    track_index: partial.track_index,
  };
}

describe("formatPlaybackAudioLabel", () => {
  it("maps flags to product copy", () => {
    expect(formatPlaybackAudioLabel(track({ flags: ["dub"] }))).toBe(
      "Русский дубляж",
    );
    expect(formatPlaybackAudioLabel(track({ flags: ["voice"] }))).toBe(
      "Многоголосый",
    );
    expect(
      formatPlaybackAudioLabel(
        track({ flags: ["studio_dub"], title: "Лучезарный" }),
      ),
    ).toBe("Лучезарный");
    expect(formatPlaybackAudioLabel(track({ flags: ["one_voice"] }))).toBe(
      "Одноголосый",
    );
    expect(formatPlaybackAudioLabel(track({ flags: ["original"] }))).toBe(
      "Оригинал · рус",
    );
    expect(formatPlaybackAudioLabel(track({ flags: ["dual_audio"] }))).toBe(
      "Dual/Multi",
    );
  });

  it("prefers original over other flags", () => {
    expect(
      formatPlaybackAudioLabel(
        track({ flags: ["dub", "original"], language: "en" }),
      ),
    ).toBe("Оригинал · англ");
  });

  it("keeps non-russian dub language tag", () => {
    expect(
      formatPlaybackAudioLabel(track({ flags: ["dub"], language: "en" })),
    ).toBe("Дубляж · англ");
  });

  it("falls back to title / language / id", () => {
    expect(
      formatPlaybackAudioLabel(track({ flags: [], title: "Кириллица" })),
    ).toBe("Кириллица");
    expect(formatPlaybackAudioLabel(track({ flags: [], language: "de" }))).toBe(
      "нем",
    );
    expect(
      formatPlaybackAudioLabel(track({ id: 7, flags: [], language: "" })),
    ).toBe("Аудио 7");
  });
});

describe("formatAudioLanguage", () => {
  it("normalizes common tags", () => {
    expect(formatAudioLanguage("RU")).toBe("рус");
    expect(formatAudioLanguage("eng")).toBe("англ");
    expect(formatAudioLanguage("")).toBe("");
    expect(formatAudioLanguage(null)).toBe("");
    expect(formatAudioLanguage("pt")).toBe("pt");
  });
});

describe("preference keys and selection", () => {
  it("scopes movie / episode / season preferences", () => {
    expect(audioPrefKey({ kind: "movie", mediaId: "m1" })).toBe(
      "seans.audio.media.m1",
    );
    expect(
      audioPrefKey({
        kind: "episode",
        mediaId: "m1",
        fileId: "f9",
        season: 1,
        episode: 3,
      }),
    ).toBe("seans.audio.episode.m1.f9");
    expect(
      audioPrefKey({ kind: "season", mediaId: "m1", season: 2 }),
    ).toBe("seans.audio.season.m1:2");
  });

  it("resolves preferred track: explicit → saved → original → first", () => {
    const tracks = [
      track({ id: "a1", flags: ["dub"] }),
      track({ id: "a2", flags: ["original"], language: "en" }),
      track({ id: "a3", flags: ["voice"] }),
    ];
    expect(resolvePreferredAudioTrack(tracks, { preferredId: "a3" })?.id).toBe(
      "a3",
    );
    expect(resolvePreferredAudioTrack(tracks, { savedId: "a3" })?.id).toBe("a3");
    expect(resolvePreferredAudioTrack(tracks, {})?.id).toBe("a2");
    expect(resolvePreferredAudioTrack([], {}) ).toBeNull();
    expect(
      resolvePreferredAudioTrack([track({ id: "x", flags: [] })], {})?.id,
    ).toBe("x");
  });

  it("detects external tracks and badge tones", () => {
    expect(
      isExternalAudioTrack(track({ flags: ["dub"], embedded: false })),
    ).toBe(true);
    expect(isExternalAudioTrack(track({ flags: ["dub"] }))).toBe(false);
    expect(audioBadgeTone(track({ flags: ["original"] }))).toBe("accent");
    expect(audioBadgeTone(track({ flags: ["dub"] }))).toBe("info");
    expect(audioBadgeTone(track({ flags: ["dual_audio"] }))).toBe("warning");
  });
});
