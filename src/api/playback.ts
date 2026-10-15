/**
 * `GET /api/media/{id}/playback` contract (progressive download + multi-audio).
 *
 * Field names mirror the JSON contract (snake_case). Numeric fields may arrive
 * as number or numeric string — `toNumber` normalizes them.
 *
 * The stream block is the source of truth for seek limits while the file is
 * still downloading: never seek past `max_seekable_bytes` even if more segments
 * become available before the next poll.
 */

import { toNumber } from "./parsing";
import type { ApiId } from "./types";

/** Container hint from the playback payload (`video.container`). */
export type PlaybackContainer = "mkv" | "mp4" | "webm" | "avi" | "mov" | string;

/** `video` block — primary video file for the current playable unit. */
export type PlaybackVideo = {
  size_bytes: number;
  container: PlaybackContainer;
  /** Optional full-file / progressive URL when the API exposes it. */
  url?: string;
  /** Known duration; when absent the demuxer must probe the container. */
  duration_ms?: number;
  /** True when a playable video track exists (episode gate). */
  primary?: boolean;
};

/**
 * Voiceover flags from `audio_tracks[].flags`. Order in the label helper is
 * priority, not this list order.
 */
export type PlaybackAudioFlag =
  | "dub"
  | "voice"
  | "studio_dub"
  | "one_voice"
  | "original"
  | "dual_audio"
  | (string & {});

export type PlaybackAudioTrack = {
  id: ApiId;
  /** BCP-47-ish language tag (`ru`, `en`, …). */
  language: string;
  flags: PlaybackAudioFlag[];
  /** `true` — track lives in the container; `false` — external file (ac3/m4a). */
  embedded: boolean;
  /** Optional studio / human title (`Лучезарный`, `Кириллица`, …). */
  title?: string;
  /** Direct URL for external (non-embedded) tracks. */
  url?: string;
  /** Container track index when `embedded` (used to switch inside mpv). */
  track_index?: number;
};

export type PlaybackSubtitleTrack = {
  id: ApiId;
  language: string;
  embedded: boolean;
  title?: string;
  url?: string;
  track_index?: number;
};

/** One downloadable byte slice of the virtual file (S3 object). */
export type PlaybackSegment = {
  index: number;
  start: number;
  end: number;
  url: string;
  available: boolean;
};

/**
 * `stream` block — progressive download state.
 * `max_seekable_bytes` is the contiguous seekable prefix (source of truth).
 * `percent_downloaded` can exceed `percent_seekable` on non-sequential download.
 */
export type PlaybackStream = {
  ready: boolean;
  complete: boolean;
  max_seekable_bytes: number;
  percent_downloaded: number;
  percent_seekable: number;
  segment_size: number;
  segments: PlaybackSegment[];
  /** Optional index.json URL for polling without the full playback payload. */
  index_url?: string;
};

/** Series episode row (`catalog.groups[].episodes[]` or flat `files[]`). */
export type PlaybackEpisode = {
  id: ApiId;
  season: number;
  episode: number;
  /** Multi-episode packs (`episode_end > episode`). 0 / missing = single. */
  episode_end?: number;
  title?: string;
  /** False while the primary video is not yet prepared — hide/disable Play. */
  has_primary_video: boolean;
  /** Per-episode audio override (falls back to top-level `audio_tracks`). */
  audio_tracks?: PlaybackAudioTrack[];
  /** Optional per-episode stream snapshot for the picker badges. */
  stream?: PlaybackStream;
};

export type PlaybackSeasonGroup = {
  season: number;
  episodes: PlaybackEpisode[];
};

/** Optional series catalog; movies omit this block. */
export type PlaybackCatalog = {
  kind: "movie" | "series";
  groups?: PlaybackSeasonGroup[];
  /** Flat episode list alternative to `groups`. */
  files?: PlaybackEpisode[];
};

/** Full `GET /api/media/{id}/playback` response. */
export type PlaybackResponse = {
  media_id: ApiId;
  /** Task / library file id of the current playable unit. */
  file_id: ApiId;
  video: PlaybackVideo;
  audio_tracks: PlaybackAudioTrack[];
  subtitle_tracks: PlaybackSubtitleTrack[];
  stream: PlaybackStream;
  catalog?: PlaybackCatalog;
};

/* --------------------------------------------------------------- raw parse */

type Raw = Record<string, unknown>;

function asRaw(value: unknown): Raw {
  return value !== null && typeof value === "object" ? (value as Raw) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function strOrNull(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number {
  return toNumber(value) ?? 0;
}

function optNum(value: unknown): number | undefined {
  const n = toNumber(value);
  return n === undefined || n === null ? undefined : n;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function id(value: unknown): ApiId {
  if (typeof value === "number" || typeof value === "string") return value;
  return 0;
}

function flagList(value: unknown): PlaybackAudioFlag[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => str(v).trim().toLowerCase())
    .filter((v) => v.length > 0) as PlaybackAudioFlag[];
}

export function normalizePlaybackAudioTrack(raw: unknown): PlaybackAudioTrack {
  const r = asRaw(raw);
  const track: PlaybackAudioTrack = {
    id: id(r.id),
    language: str(r.language).toLowerCase(),
    flags: flagList(r.flags),
    // Missing `embedded` is treated as in-container (the common case).
    embedded: r.embedded === undefined ? true : bool(r.embedded, true),
  };
  const title = strOrNull(r.title);
  if (title !== undefined) track.title = title;
  const url = strOrNull(r.url);
  if (url !== undefined) track.url = url;
  const idx = optNum(r.track_index ?? r.index);
  if (idx !== undefined) track.track_index = idx;
  return track;
}

export function normalizePlaybackSubtitleTrack(
  raw: unknown,
): PlaybackSubtitleTrack {
  const r = asRaw(raw);
  const track: PlaybackSubtitleTrack = {
    id: id(r.id),
    language: str(r.language).toLowerCase(),
    embedded: r.embedded === undefined ? true : bool(r.embedded, true),
  };
  const title = strOrNull(r.title);
  if (title !== undefined) track.title = title;
  const url = strOrNull(r.url);
  if (url !== undefined) track.url = url;
  const idx = optNum(r.track_index ?? r.index);
  if (idx !== undefined) track.track_index = idx;
  return track;
}

export function normalizePlaybackSegment(raw: unknown): PlaybackSegment {
  const r = asRaw(raw);
  return {
    index: num(r.index),
    start: num(r.start),
    end: num(r.end),
    url: str(r.url),
    available: bool(r.available, true),
  };
}

export function normalizePlaybackStream(raw: unknown): PlaybackStream {
  const r = asRaw(raw);
  const stream: PlaybackStream = {
    ready: bool(r.ready),
    complete: bool(r.complete),
    max_seekable_bytes: num(r.max_seekable_bytes),
    percent_downloaded: num(r.percent_downloaded),
    percent_seekable: num(r.percent_seekable),
    segment_size: num(r.segment_size),
    segments: Array.isArray(r.segments)
      ? r.segments.map(normalizePlaybackSegment)
      : [],
  };
  const indexUrl = strOrNull(r.index_url ?? r.indexUrl);
  if (indexUrl !== undefined) stream.index_url = indexUrl;
  return stream;
}

export function normalizePlaybackVideo(raw: unknown): PlaybackVideo {
  const r = asRaw(raw);
  const video: PlaybackVideo = {
    size_bytes: num(r.size_bytes),
    container: str(r.container).toLowerCase() || "mkv",
  };
  const url = strOrNull(r.url);
  if (url !== undefined) video.url = url;
  const durationMs = optNum(r.duration_ms ?? r.durationMs);
  if (durationMs !== undefined) video.duration_ms = durationMs;
  if (r.primary !== undefined) video.primary = bool(r.primary, true);
  return video;
}

export function normalizePlaybackEpisode(raw: unknown): PlaybackEpisode {
  const r = asRaw(raw);
  const episode: PlaybackEpisode = {
    id: id(r.id ?? r.task_file_id ?? r.file_id),
    season: num(r.season),
    episode: num(r.episode),
    has_primary_video:
      r.has_primary_video !== undefined
        ? bool(r.has_primary_video, true)
        : // Missing flag: treat as playable unless explicitly a placeholder.
          str(r.status).toLowerCase() !== "pending",
  };
  const episodeEnd = optNum(r.episode_end ?? r.episodeEnd);
  if (episodeEnd !== undefined) episode.episode_end = episodeEnd;
  const title = strOrNull(r.title);
  if (title !== undefined) episode.title = title;
  if (Array.isArray(r.audio_tracks)) {
    episode.audio_tracks = r.audio_tracks.map(normalizePlaybackAudioTrack);
  }
  if (r.stream !== undefined && r.stream !== null) {
    episode.stream = normalizePlaybackStream(r.stream);
  }
  return episode;
}

function normalizeSeasonGroup(raw: unknown): PlaybackSeasonGroup {
  const r = asRaw(raw);
  return {
    season: num(r.season),
    episodes: Array.isArray(r.episodes)
      ? r.episodes.map(normalizePlaybackEpisode)
      : [],
  };
}

export function normalizePlaybackCatalog(raw: unknown): PlaybackCatalog | undefined {
  if (raw === null || raw === undefined) return undefined;
  const r = asRaw(raw);
  const kindRaw = str(r.kind).toLowerCase();
  const groupsRaw = Array.isArray(r.groups) ? r.groups : null;
  const filesRaw = Array.isArray(r.files) ? r.files : null;
  if (!groupsRaw && !filesRaw && kindRaw !== "series" && kindRaw !== "movie") {
    return undefined;
  }
  const catalog: PlaybackCatalog = {
    kind: kindRaw === "series" || groupsRaw || filesRaw ? "series" : "movie",
  };
  if (groupsRaw) catalog.groups = groupsRaw.map(normalizeSeasonGroup);
  if (filesRaw) catalog.files = filesRaw.map(normalizePlaybackEpisode);
  return catalog;
}

/** Map a raw playback payload to `PlaybackResponse`. */
export function normalizePlayback(raw: unknown): PlaybackResponse {
  const r = asRaw(raw);
  const streamRaw = r.stream !== undefined && r.stream !== null ? r.stream : {};
  const response: PlaybackResponse = {
    media_id: id(r.media_id ?? r.mediaId ?? r.id),
    file_id: id(r.file_id ?? r.fileId ?? r.task_file_id),
    video: normalizePlaybackVideo(r.video),
    audio_tracks: Array.isArray(r.audio_tracks)
      ? r.audio_tracks.map(normalizePlaybackAudioTrack)
      : [],
    subtitle_tracks: Array.isArray(r.subtitle_tracks)
      ? r.subtitle_tracks.map(normalizePlaybackSubtitleTrack)
      : Array.isArray(r.subtitles)
        ? r.subtitles.map(normalizePlaybackSubtitleTrack)
        : [],
    stream: normalizePlaybackStream(streamRaw),
  };
  // Tolerate stream fields at the top level (flattened payloads).
  if (response.stream.max_seekable_bytes === 0 && r.max_seekable_bytes !== undefined) {
    response.stream = normalizePlaybackStream({ ...streamRaw, ...r });
  }
  const catalog = normalizePlaybackCatalog(r.catalog);
  if (catalog) response.catalog = catalog;
  return response;
}
