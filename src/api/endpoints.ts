/**
 * Client-facing Seans API endpoints (M2 + M4 + M5 + M6).
 *
 * Contract-backed wrappers over `request<T>()`:
 *   GET  /api/auth/me
 *   POST /api/auth/invite-keys
 *   GET  /api/files/{task_file_id}/url
 *   GET  /api/search?q=
 *   GET  /api/catalog/chart?type=&limit=
 *   GET  /api/media/{id}
 *   GET  /api/media/{id}/releases?refresh=
 *   PUT  /api/media/{id}/review
 *   GET  /api/media/{id}/reviews
 *   GET  /api/library
 *   PUT  /api/history
 *   GET  /api/history?limit=   (nested {history,media,file,progress_pct})
 *   POST /api/tasks
 *   GET  /api/tasks?active=
 *   POST /api/tasks/{id}/cancel
 *   POST /api/rooms
 *   GET  /api/rooms/{code}
 *   GET  /api/media/{id}/playback
 *   GET  /api/media/{id}/episodes
 * Worker / torrent-worker endpoints are out of scope.
 */

import { normalizePlayback } from "./playback";
import type { PlaybackResponse } from "./playback";
import { request } from "./client";
import {
  normalizeFileUrl,
  normalizeHistory,
  normalizeHistoryList,
  normalizeLibraryList,
  normalizeMediaDetail,
  normalizeReview,
  normalizeReviewList,
  normalizeRoomCreate,
  normalizeRoomDetail,
  normalizeSearchResults,
  normalizeTask,
  normalizeTaskList,
  normalizeTorrentReleaseList,
  normalizeUser,
  toNumber,
} from "./parsing";
import type {
  ApiId,
  FileUrlResponse,
  HistoryListItem,
  HistoryResponse,
  LibraryItem,
  MediaDetail,
  MediaSearchResult,
  ReviewResponse,
  RoomCreateResponse,
  RoomDetailResponse,
  TaskDetailResponse,
  TorrentReleaseResponse,
  UserResponse,
} from "./types";

/** GET /api/auth/me — hydrate the current user after login / on startup. */
export async function fetchMe(signal?: AbortSignal): Promise<UserResponse> {
  return normalizeUser(await request<unknown>("/api/auth/me", { signal }));
}

/** `POST /api/auth/invite-keys` — create an invite key (requires `can_invite`). */
export type InviteKeyResponse = {
  key: string;
  created_at: string;
};

export async function createInviteKey(
  signal?: AbortSignal,
): Promise<InviteKeyResponse> {
  const raw = await request<unknown>("/api/auth/invite-keys", {
    method: "POST",
    signal,
  });
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    key: typeof r.key === "string" ? r.key : "",
    created_at: typeof r.created_at === "string" ? r.created_at : "",
  };
}

/** GET /api/files/{task_file_id}/url — signed streaming URL. */
export async function fetchFileUrl(
  taskFileId: string | number,
  signal?: AbortSignal,
): Promise<FileUrlResponse> {
  const id = encodeURIComponent(String(taskFileId));
  return normalizeFileUrl(
    await request<unknown>(`/api/files/${id}/url`, { signal }),
  );
}

/** GET /api/search?q= — catalog search by title. */
export async function searchMedia(
  query: string,
  signal?: AbortSignal,
): Promise<MediaSearchResult[]> {
  return normalizeSearchResults(
    await request<unknown>("/api/search", { query: { q: query }, signal }),
  );
}

/**
 * GET /api/catalog/chart — chart shelf for the Home hero.
 * The Seans backend proxies Kinopoisk collections (e.g. POPULAR_SERIES).
 * Missing/empty payload is normal (no posters); callers must not block search.
 */
export async function fetchChart(
  options: {
    type?: "popular_series" | "popular_films" | string;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<MediaSearchResult[]> {
  const limit = toNumber(options.limit);
  const clamped =
    limit === null ? 20 : Math.min(50, Math.max(1, Math.trunc(limit)));
  return normalizeSearchResults(
    await request<unknown>("/api/catalog/chart", {
      query: {
        type: options.type ?? "popular_series",
        limit: clamped,
      },
      signal: options.signal,
    }),
  );
}

/**
 * DELETE /api/library/{library_item_id} — remove a library entry.
 * `deleteFiles` also drops stored file bytes when the backend supports it.
 */
export async function deleteLibraryItem(
  libraryItemId: ApiId,
  options: { deleteFiles?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const id = encodeURIComponent(String(libraryItemId));
  await request<unknown>(`/api/library/${id}`, {
    method: "DELETE",
    query:
      options.deleteFiles === undefined
        ? undefined
        : { delete_files: options.deleteFiles ? "true" : "false" },
    signal: options.signal,
  });
}

/** GET /api/media/{id} — full media detail (includes optional user_review). */
export async function fetchMedia(
  mediaId: string | number,
  signal?: AbortSignal,
): Promise<MediaDetail> {
  const id = encodeURIComponent(String(mediaId));
  return normalizeMediaDetail(
    await request<unknown>(`/api/media/${id}`, { signal }),
  );
}

/** Payload for PUT /api/media/{id}/review. */
export type ReviewWriteBody = {
  score: number;
  review?: string;
};

/**
 * PUT /api/media/{id}/review — create or update the caller's review.
 * Score must be an integer in 1..10 (validated by callers; the API enforces it too).
 */
export async function submitMediaReview(
  mediaId: string | number,
  body: ReviewWriteBody,
  signal?: AbortSignal,
): Promise<ReviewResponse> {
  const id = encodeURIComponent(String(mediaId));
  return normalizeReview(
    await request<unknown>(`/api/media/${id}/review`, {
      method: "PUT",
      body,
      signal,
    }),
  );
}

/** GET /api/media/{id}/reviews — all reviews for a media item. */
export async function fetchMediaReviews(
  mediaId: string | number,
  signal?: AbortSignal,
): Promise<ReviewResponse[]> {
  const id = encodeURIComponent(String(mediaId));
  return normalizeReviewList(
    await request<unknown>(`/api/media/${id}/reviews`, { signal }),
  );
}

/**
 * GET /api/media/{id}/releases?refresh= — torrent releases for a media item.
 * Pass `refresh: true` to force a tracker re-scan on the server.
 */
export async function fetchMediaReleases(
  mediaId: string | number,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<TorrentReleaseResponse[]> {
  const id = encodeURIComponent(String(mediaId));
  return normalizeTorrentReleaseList(
    await request<unknown>(`/api/media/${id}/releases`, {
      query: options.refresh ? { refresh: true } : undefined,
      signal: options.signal,
    }),
  );
}

/** Payload for POST /api/tasks. */
export type TaskCreateBody = {
  torrent_release_id: ApiId;
  /** Paths of files to download; empty array = full-torrent selection. */
  file_paths: string[];
};

/**
 * POST /api/tasks — create a download/preparation task from a release.
 * `file_paths` empty array requests the full torrent (see taskHelpers).
 */
export async function createTask(
  body: TaskCreateBody,
  signal?: AbortSignal,
): Promise<TaskDetailResponse> {
  return normalizeTask(
    await request<unknown>("/api/tasks", { method: "POST", body, signal }),
  );
}

/**
 * GET /api/tasks?active= — list tasks.
 * `active: true` returns only non-terminal tasks (for polling).
 */
export async function fetchTasks(
  options: { active?: boolean; signal?: AbortSignal } = {},
): Promise<TaskDetailResponse[]> {
  return normalizeTaskList(
    await request<unknown>("/api/tasks", {
      query: options.active === undefined ? undefined : { active: options.active },
      signal: options.signal,
    }),
  );
}

/** POST /api/tasks/{id}/cancel — abort an in-flight task. */
export async function cancelTask(
  taskId: ApiId,
  signal?: AbortSignal,
): Promise<TaskDetailResponse> {
  const id = encodeURIComponent(String(taskId));
  return normalizeTask(
    await request<unknown>(`/api/tasks/${id}/cancel`, {
      method: "POST",
      signal,
    }),
  );
}

/**
 * GET /api/media/{id}/playback — progressive stream state + audio tracks.
 *
 * Series episode selection uses `?season=&episode=` (the seans API contract).
 * `stream` may be `null` before the first worker heartbeat — treat as waiting.
 *
 * Poll every 5–10 s while the file is incomplete (`usePlayback`).
 */
export async function fetchPlayback(
  mediaId: string | number,
  options: {
    season?: number | null;
    episode?: number | null;
    signal?: AbortSignal;
  } = {},
): Promise<PlaybackResponse> {
  const id = encodeURIComponent(String(mediaId));
  const query: Record<string, string | number> = {};
  if (options.season != null && Number.isFinite(options.season)) {
    query.season = Math.trunc(options.season);
  }
  if (options.episode != null && Number.isFinite(options.episode)) {
    query.episode = Math.trunc(options.episode);
  }
  return normalizePlayback(
    await request<unknown>(`/api/media/${id}/playback`, {
      query: Object.keys(query).length > 0 ? query : undefined,
      signal: options.signal,
    }),
  );
}

/** `GET /api/media/{id}/episodes` — series (or movie) episode list. */
export async function fetchMediaEpisodes(
  mediaId: string | number,
  options: { season?: number | null; signal?: AbortSignal } = {},
): Promise<{
  media_id: ApiId;
  title: string;
  kind: string;
  episodes: Array<{
    episode_id: string;
    season: number;
    episode: number;
    episode_end?: number | null;
    title?: string | null;
    audio_tracks?: unknown[];
    subtitle_tracks?: unknown[];
  }>;
}> {
  const id = encodeURIComponent(String(mediaId));
  const query =
    options.season != null && Number.isFinite(options.season)
      ? { season: Math.trunc(options.season) }
      : undefined;
  return request<never>(`/api/media/${id}/episodes`, {
    query,
    signal: options.signal,
  }) as Promise<{
    media_id: ApiId;
    title: string;
    kind: string;
    episodes: Array<{
      episode_id: string;
      season: number;
      episode: number;
      episode_end?: number | null;
      title?: string | null;
      audio_tracks?: unknown[];
      subtitle_tracks?: unknown[];
    }>;
  }>;
}

/** GET /api/library — saved media items with their prepared files. */
export async function fetchLibrary(
  signal?: AbortSignal,
): Promise<LibraryItem[]> {
  return normalizeLibraryList(
    await request<unknown>("/api/library", { signal }),
  );
}

/** Payload for PUT /api/history (camelCase call shape; sent as snake_case). */
export type HistoryWritePayload = {
  taskFileId: ApiId;
  positionSec: number;
  durationSec: number;
};

/**
 * PUT /api/history — upsert watch progress for a library file.
 * The server derives `completed` from the position/duration pair.
 */
export async function putHistory(
  payload: HistoryWritePayload,
  signal?: AbortSignal,
): Promise<HistoryResponse> {
  return normalizeHistory(
    await request<unknown>("/api/history", {
      method: "PUT",
      body: {
        task_file_id: payload.taskFileId,
        position_sec: payload.positionSec,
        duration_sec: payload.durationSec,
      },
      signal,
    }),
  );
}

/**
 * GET /api/history?limit= — recent watch history (continue-watching).
 * The server returns nested rows `{history, media, file, progress_pct}`;
 * `normalizeHistoryList` also accepts flat `HistoryResponse` objects.
 */
export async function fetchHistory(
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<HistoryListItem[]> {
  const limit = toNumber(options.limit);
  const clamped =
    limit === null ? undefined : Math.min(200, Math.max(1, Math.trunc(limit)));
  return normalizeHistoryList(
    await request<unknown>("/api/history", {
      query: clamped === undefined ? undefined : { limit: clamped },
      signal: options.signal,
    }),
  );
}

/**
 * POST /api/rooms — create a watch-party room for a ready library file.
 * `task_file_id` is the library file id. Rooms WS UI is M10; callers can
 * already navigate to `#/room/{code}` with the returned code.
 */
export async function createRoom(
  taskFileId: ApiId,
  signal?: AbortSignal,
): Promise<RoomCreateResponse> {
  return normalizeRoomCreate(
    await request<unknown>("/api/rooms", {
      method: "POST",
      body: { task_file_id: taskFileId },
      signal,
    }),
  );
}

/**
 * GET /api/rooms/{code} — room payload for join (deep link / room screen).
 * Returns `{room, members}`; `room.task_file_id` identifies the played file.
 */
export async function fetchRoom(
  code: string,
  signal?: AbortSignal,
): Promise<RoomDetailResponse> {
  const id = encodeURIComponent(code);
  return normalizeRoomDetail(
    await request<unknown>(`/api/rooms/${id}`, { signal }),
  );
}
