import { describe, expect, it } from "vitest";
import {
  normalizePlayback,
  normalizePlaybackAudioTrack,
  normalizePlaybackStream,
} from "../src/api/playback";

describe("normalizePlayback", () => {
  const raw = {
    media_id: "m-1",
    file_id: "f-9",
    video: {
      size_bytes: "2500000000",
      container: "MKV",
      duration_ms: 5400000,
    },
    audio_tracks: [
      { id: "a1", language: "RU", flags: ["dub"], embedded: true },
      {
        id: "a2",
        language: "en",
        flags: ["original", "dual_audio"],
        embedded: false,
        url: "https://cdn/ac3",
        title: "Original",
      },
    ],
    subtitle_tracks: [{ id: "s1", language: "ru", embedded: true }],
    stream: {
      ready: true,
      complete: false,
      max_seekable_bytes: 83886080,
      percent_downloaded: 4.8,
      percent_seekable: 3.2,
      segment_size: 8388608,
      segments: [
        { index: 0, start: 0, end: 8388608, url: "s0", available: true },
        { index: 1, start: 8388608, end: 16777216, url: "s1", available: false },
      ],
    },
    catalog: {
      kind: "series",
      groups: [
        {
          season: 1,
          episodes: [
            {
              id: "e1",
              season: 1,
              episode: 1,
              episode_end: 2,
              has_primary_video: true,
              title: "Пилот",
            },
            {
              id: "e2",
              season: 1,
              episode: 3,
              has_primary_video: false,
            },
          ],
        },
      ],
    },
  };

  it("parses the contract sample (string numerics + flags)", () => {
    const pb = normalizePlayback(raw);
    expect(pb.media_id).toBe("m-1");
    expect(pb.file_id).toBe("f-9");
    expect(pb.video.size_bytes).toBe(2500000000);
    expect(pb.video.container).toBe("mkv");
    expect(pb.video.duration_ms).toBe(5400000);
    expect(pb.audio_tracks).toHaveLength(2);
    expect(pb.audio_tracks[0]).toMatchObject({
      id: "a1",
      language: "ru",
      flags: ["dub"],
      embedded: true,
    });
    expect(pb.audio_tracks[1]).toMatchObject({
      id: "a2",
      embedded: false,
      url: "https://cdn/ac3",
      title: "Original",
    });
    expect(pb.stream.max_seekable_bytes).toBe(83886080);
    expect(pb.stream.percent_downloaded).toBe(4.8);
    expect(pb.stream.percent_seekable).toBe(3.2);
    expect(pb.stream.segments[1].available).toBe(false);
  });

  it("parses series catalog groups and multi-episode packs", () => {
    const pb = normalizePlayback(raw);
    expect(pb.catalog?.kind).toBe("series");
    const episodes = pb.catalog?.groups?.[0].episodes ?? [];
    expect(episodes[0].episode_end).toBe(2);
    expect(episodes[0].has_primary_video).toBe(true);
    expect(episodes[1].has_primary_video).toBe(false);
  });

  it("defaults embedded=true and empty collections", () => {
    const pb = normalizePlayback({ id: 3, stream: {} });
    expect(pb.media_id).toBe(3);
    expect(pb.audio_tracks).toEqual([]);
    expect(pb.stream.ready).toBe(false);
    expect(normalizePlaybackAudioTrack({ id: 1, flags: ["voice"] }).embedded).toBe(
      true,
    );
    expect(normalizePlaybackStream(null).segments).toEqual([]);
  });

  it("accepts flattened stream fields at the top level", () => {
    const pb = normalizePlayback({
      media_id: 1,
      file_id: 2,
      video: { size_bytes: 100 },
      ready: true,
      complete: true,
      max_seekable_bytes: 100,
      percent_downloaded: 100,
      percent_seekable: 100,
    });
    expect(pb.stream.complete).toBe(true);
    expect(pb.stream.max_seekable_bytes).toBe(100);
  });
});
