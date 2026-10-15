import { describe, expect, it } from "vitest";
import {
  normalizePlayback,
  normalizePlaybackAudioTrack,
  normalizePlaybackStream,
} from "../src/api/playback";

describe("normalizePlayback", () => {
  /** Real seans API shape (GET /api/media/{id}/playback). */
  const raw = {
    media_id: "m-1",
    episode_id: "ep-1",
    title: "Гарри Поттер",
    kind: "movie",
    season: 0,
    episode: 0,
    episode_end: null,
    duration_ms: null,
    video: {
      task_file_id: "f-9",
      file_path: "Garri.mkv",
      size_bytes: "2500000000",
      container: "MKV",
      s3_key: "users/t/stream/f0000",
      url: null,
    },
    audio_tracks: [
      {
        id: "a1",
        language: "RU",
        flags: ["dub"],
        label: "Русский дубляж",
        s3_key: null,
        embedded: true,
        task_file_id: "f-9",
        url: null,
      },
      {
        id: "a2",
        language: "en",
        flags: ["original", "dual_audio"],
        label: "Оригинал",
        embedded: false,
        url: "https://cdn/ac3",
        s3_key: "users/t/a2.ac3",
        task_file_id: "f-a2",
      },
    ],
    subtitle_tracks: [
      { id: "s1", language: "ru", label: "Русские", embedded: true, url: null },
    ],
    stream: {
      ready: true,
      complete: false,
      size_bytes: 2500000000,
      max_seekable_bytes: 83886080,
      percent_downloaded: 4.8,
      percent_seekable: 3.2,
      segment_size: 8388608,
      segments_uploaded: 8,
      segments_available: 10,
      segments: [
        { index: 0, start: 0, end: 8388608, available: true, url: "s0" },
        {
          index: 1,
          start: 8388608,
          end: 16777216,
          available: false,
          url: null,
        },
      ],
      index_url: "https://cdn/index.json",
    },
  };

  it("parses the live seans contract (string numerics + labels)", () => {
    const pb = normalizePlayback(raw);
    expect(pb.media_id).toBe("m-1");
    expect(pb.file_id).toBe("f-9");
    expect(pb.video.task_file_id).toBe("f-9");
    expect(pb.video.size_bytes).toBe(2500000000);
    expect(pb.video.container).toBe("mkv");
    // Incomplete files expose url: null — must not become a playable URL.
    expect(pb.video.url).toBeUndefined();
    expect(pb.kind).toBe("movie");
    expect(pb.stream).not.toBeNull();
    expect(pb.stream!.max_seekable_bytes).toBe(83886080);
    expect(pb.stream!.percent_downloaded).toBe(4.8);
    expect(pb.stream!.percent_seekable).toBe(3.2);
    expect(pb.stream!.segments[1].available).toBe(false);
  });

  it("keeps backend label and external audio url", () => {
    const pb = normalizePlayback(raw);
    expect(pb.audio_tracks[0].label).toBe("Русский дубляж");
    expect(pb.audio_tracks[0].embedded).toBe(true);
    expect(pb.audio_tracks[1]).toMatchObject({
      id: "a2",
      embedded: false,
      url: "https://cdn/ac3",
    });
  });

  it("treats stream: null as waiting (no heartbeat yet)", () => {
    const pb = normalizePlayback({
      ...raw,
      stream: null,
    });
    expect(pb.stream).toBeNull();
    expect(pb.file_id).toBe("f-9");
  });

  it("parses series fields for ?season=&episode= selection", () => {
    const pb = normalizePlayback({
      ...raw,
      kind: "series",
      season: 1,
      episode: 2,
      episode_end: 3,
    });
    expect(pb.kind).toBe("series");
    expect(pb.season).toBe(1);
    expect(pb.episode).toBe(2);
    expect(pb.episode_end).toBe(3);
  });

  it("defaults embedded=true and empty collections", () => {
    const pb = normalizePlayback({ id: 3, video: {}, stream: null });
    expect(pb.media_id).toBe(3);
    expect(pb.audio_tracks).toEqual([]);
    expect(pb.stream).toBeNull();
    expect(normalizePlaybackAudioTrack({ id: 1, flags: ["voice"] }).embedded).toBe(
      true,
    );
    expect(normalizePlaybackStream(null).segments).toEqual([]);
  });

  it("keeps legacy complete VOD (uploaded file, no worker heartbeat)", () => {
    // Synthesized by the API for rows downloaded before progressive streaming.
    const pb = normalizePlayback({
      media_id: "m-old",
      kind: "movie",
      video: {
        task_file_id: "f-old",
        size_bytes: 1000,
        container: "mkv",
        url: "https://cdn/old.mkv",
      },
      audio_tracks: [],
      subtitle_tracks: [],
      stream: {
        ready: true,
        complete: true,
        size_bytes: 1000,
        max_seekable_bytes: 1000,
        percent_downloaded: 100,
        percent_seekable: 100,
        segment_size: 8388608,
        segments: [],
      },
    });
    expect(pb.stream?.complete).toBe(true);
    expect(pb.video.url).toBe("https://cdn/old.mkv");
  });
});
