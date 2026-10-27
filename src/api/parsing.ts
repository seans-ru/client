/**
 * Pure parsing/coercion helpers for API responses. No Tauri/DOM deps — unit-testable.
 *
 * Several numeric fields arrive as number OR numeric string from the API
 * (rating_kp, position_sec, duration_sec, size_bytes, speed_bps, reserved_bytes,
 * progress_pct, tmdb_id, season, episode); `toNumber` normalizes them.
 */

import type {
  FileUrlResponse,
  HistoryListItem,
  HistoryResponse,
  LibraryFile,
  LibraryItem,
  MediaDetail,
  MediaSearchResult,
  ReviewResponse,
  RoomCreateResponse,
  RoomDetailResponse,
  RoomInfo,
  RoomMemberResponse,
  TaskDetailResponse,
  TaskResponse,
  TokenResponse,
  TorrentReleaseResponse,
  UserResponse,
} from "./types";

export function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

type Raw = Record<string, unknown>;

function asRaw(value: unknown): Raw {
  return value !== null && typeof value === "object" ? (value as Raw) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  return toNumber(value) ?? 0;
}

function optNum(value: unknown): number | undefined {
  const n = toNumber(value);
  return n === null ? undefined : n;
}

function bool(value: unknown): boolean {
  return Boolean(value);
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => str(v)) : [];
}

function id(value: unknown): string | number {
  if (typeof value === "number" || typeof value === "string") return value;
  return 0;
}

export function normalizeUser(raw: unknown): UserResponse {
  const r = asRaw(raw);
  const used = toNumber(r.used_bytes);
  const user: UserResponse = {
    id: id(r.id),
    email: str(r.email),
    display_name: str(r.display_name),
    can_invite: bool(r.can_invite),
    quota_bytes: num(r.quota_bytes),
    ...(used === null ? {} : { used_bytes: used }),
    created_at: str(r.created_at),
  };
  if (typeof r.is_admin === "boolean") user.is_admin = r.is_admin;
  if (typeof r.plan === "string" && r.plan.length > 0) user.plan = r.plan;
  if (r.plan_expires_at !== undefined) {
    user.plan_expires_at =
      typeof r.plan_expires_at === "string" ? r.plan_expires_at : null;
  }
  return user;
}

export function normalizeToken(raw: unknown): TokenResponse {
  const r = asRaw(raw);
  return {
    access_token: str(r.access_token),
    token_type: str(r.token_type) || "bearer",
    user: normalizeUser(r.user),
  };
}

export function normalizeMediaSearchResult(raw: unknown): MediaSearchResult {
  const r = asRaw(raw);
  return {
    id: id(r.id),
    kp_id: toNumber(r.kp_id),
    title: str(r.title),
    year: toNumber(r.year),
    poster_url: strOrNull(r.poster_url),
    kp_type: str(r.kp_type),
    rating_kp: toNumber(r.rating_kp),
  };
}

/** Map a raw search payload (`GET /api/search`) to a typed list. */
export function normalizeSearchResults(raw: unknown): MediaSearchResult[] {
  return Array.isArray(raw) ? raw.map(normalizeMediaSearchResult) : [];
}

export function normalizeMediaDetail(raw: unknown): MediaDetail {
  const r = asRaw(raw);
  const base = normalizeMediaSearchResult(raw);
  const tmdbId = optNum(r.tmdb_id);
  const detail: MediaDetail = {
    ...base,
    original_title: strOrNull(r.original_title),
    overview: strOrNull(r.overview),
    genres: strList(r.genres),
    updated_at: str(r.updated_at),
  };
  if (tmdbId !== undefined) detail.tmdb_id = tmdbId;
  if (r.user_review !== undefined && r.user_review !== null) {
    detail.user_review = normalizeReview(r.user_review);
  }
  return detail;
}

export function normalizeTorrentRelease(
  raw: unknown,
): TorrentReleaseResponse {
  const r = asRaw(raw);
  const release: TorrentReleaseResponse = {
    id: id(r.id),
    tracker: str(r.tracker),
    title: str(r.title),
    size_bytes: num(r.size_bytes),
    seeders: num(r.seeders),
    leechers: num(r.leechers),
    quality: strOrNull(r.quality),
    voiceover: strOrNull(r.voiceover),
    magnet: strOrNull(r.magnet),
  };
  // Optional file list for task creation. Accept common field names and
  // both plain path strings and `{path}`-shaped entries.
  const rawPaths = Array.isArray(r.file_paths)
    ? r.file_paths
    : Array.isArray(r.file_list)
      ? r.file_list
      : Array.isArray(r.files)
        ? r.files
        : null;
  if (rawPaths) {
    release.file_paths = rawPaths.map((p) =>
      typeof p === "string" ? p : str(asRaw(p).path),
    );
  }
  return release;
}

export function normalizeTask(raw: unknown): TaskResponse {
  const r = asRaw(raw);
  const task: TaskResponse = {
    id: id(r.id),
    status: str(r.status),
    reserved_bytes: num(r.reserved_bytes),
    progress_pct: num(r.progress_pct),
    speed_bps: num(r.speed_bps),
    stage: strOrNull(r.stage),
    created_at: str(r.created_at),
  };
  const updatedAt = strOrNull(r.updated_at);
  if (updatedAt !== null && updatedAt.length > 0) task.updated_at = updatedAt;
  if (typeof r.error === "string") task.error = r.error;
  // TaskDetailResponse join fields (GET /api/tasks, cancel).
  const mediaId = r.media_id ?? r.media_item_id ?? r.mediaId;
  if (mediaId !== undefined && mediaId !== null) {
    (task as TaskDetailResponse).media_id = id(mediaId);
  }
  const taskFileId = r.task_file_id ?? r.file_id ?? r.taskFileId ?? r.fileId;
  if (taskFileId !== undefined && taskFileId !== null) {
    (task as TaskDetailResponse).task_file_id = id(taskFileId);
  }
  return task;
}

export function normalizeHistory(raw: unknown): HistoryResponse {
  const r = asRaw(raw);
  // Nested `GET /api/history` envelope: unwrap the `history` object.
  const source = r.history !== undefined && r.history !== null ? asRaw(r.history) : r;
  return {
    id: id(source.id),
    task_file_id: id(source.task_file_id),
    position_sec: num(source.position_sec),
    duration_sec: num(source.duration_sec),
    completed: bool(source.completed),
    updated_at: str(source.updated_at),
  };
}

/** `GET /api/history` row: flat `HistoryResponse` or nested `{history, media, file, progress_pct}`. */
export function normalizeHistoryListItem(raw: unknown): HistoryListItem {
  const r = asRaw(raw);
  const entry: HistoryListItem = normalizeHistory(raw);
  const mediaRaw = r.media;
  if (mediaRaw !== undefined && mediaRaw !== null && typeof mediaRaw === "object") {
    const m = asRaw(mediaRaw);
    entry.media = {
      id: id(m.id),
      title: str(m.title),
      poster_url: strOrNull(m.poster_url),
    };
  }
  const fileRaw = r.file;
  if (fileRaw !== undefined && fileRaw !== null && typeof fileRaw === "object") {
    const f = asRaw(fileRaw);
    entry.file = { id: id(f.id), path: str(f.path) };
  }
  const pct = optNum(r.progress_pct);
  if (pct !== undefined) entry.progress_pct = pct;
  return entry;
}

/** Map a raw history payload (`GET /api/history`) to a typed list. */
export function normalizeHistoryList(raw: unknown): HistoryListItem[] {
  return Array.isArray(raw) ? raw.map(normalizeHistoryListItem) : [];
}

export function normalizeReview(raw: unknown): ReviewResponse {
  const r = asRaw(raw);
  return {
    id: id(r.id),
    user_id: id(r.user_id),
    media_item_id: id(r.media_item_id),
    score: num(r.score),
    review: strOrNull(r.review),
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
  };
}

/** Map a raw reviews payload (`GET /api/media/{id}/reviews`) to a typed list. */
export function normalizeReviewList(raw: unknown): ReviewResponse[] {
  return Array.isArray(raw) ? raw.map(normalizeReview) : [];
}

/** Map a raw releases payload (`GET /api/media/{id}/releases`) to a typed list. */
export function normalizeTorrentReleaseList(
  raw: unknown,
): TorrentReleaseResponse[] {
  return Array.isArray(raw) ? raw.map(normalizeTorrentRelease) : [];
}

/** Map a raw tasks payload (`GET /api/tasks`) to a typed list. */
export function normalizeTaskList(raw: unknown): TaskResponse[] {
  return Array.isArray(raw) ? raw.map(normalizeTask) : [];
}

export function normalizeLibraryFile(raw: unknown): LibraryFile {
  const r = asRaw(raw);
  const file: LibraryFile = {
    id: id(r.id),
    path: str(r.path),
    size_bytes: num(r.size_bytes),
    status: str(r.status),
  };
  const season = optNum(r.season);
  const episode = optNum(r.episode);
  if (season !== undefined) file.season = season;
  if (episode !== undefined) file.episode = episode;
  return file;
}

export function normalizeLibraryItem(raw: unknown): LibraryItem {
  const r = asRaw(raw);
  const libraryItem = asRaw(r.library_item);
  const mediaItem = asRaw(r.media_item);
  return {
    library_item: {
      id: id(libraryItem.id),
      status: str(libraryItem.status),
      created_at: str(libraryItem.created_at),
    },
    media_item: {
      id: id(mediaItem.id),
      title: str(mediaItem.title),
      poster_url: strOrNull(mediaItem.poster_url),
      kp_type: str(mediaItem.kp_type),
      year: toNumber(mediaItem.year),
    },
    files: Array.isArray(r.files) ? r.files.map(normalizeLibraryFile) : [],
    total_size: num(r.total_size),
    ready: bool(r.ready),
  };
}

/** Map a raw library payload (`GET /api/library`) to a typed list. */
export function normalizeLibraryList(raw: unknown): LibraryItem[] {
  return Array.isArray(raw) ? raw.map(normalizeLibraryItem) : [];
}

export function normalizeRoomCreate(raw: unknown): RoomCreateResponse {
  const r = asRaw(raw);
  return {
    id: id(r.id),
    code: str(r.code),
    ws_url: str(r.ws_url),
  };
}

export function normalizeRoomMember(raw: unknown): RoomMemberResponse {
  const r = asRaw(raw);
  const member: RoomMemberResponse = { user_id: id(r.user_id) };
  const name = strOrNull(r.name);
  if (name !== null && name.length > 0) member.name = name;
  return member;
}

export function normalizeRoomInfo(raw: unknown): RoomInfo {
  const r = asRaw(raw);
  const info: RoomInfo = {
    id: id(r.id),
    code: str(r.code),
    ws_url: str(r.ws_url),
  };
  // Guest join needs the library file. Accept the contract name plus common
  // aliases and nested `{ task_file: { id } }` / `{ file: { id } }` shapes.
  const nested =
    r.task_file ?? r.file ?? r.taskFile ?? (r.library_file as unknown);
  const nestedId =
    nested != null && typeof nested === "object"
      ? asRaw(nested).id ?? asRaw(nested).task_file_id
      : undefined;
  const fileRaw =
    r.task_file_id ??
    r.file_id ??
    r.taskFileId ??
    r.fileId ??
    r.library_file_id ??
    nestedId;
  if (fileRaw !== undefined && fileRaw !== null && fileRaw !== "") {
    info.task_file_id = id(fileRaw);
  }
  const hostRaw = r.host_id ?? r.hostId ?? r.host_user_id ?? r.hostUserId;
  if (hostRaw !== undefined && hostRaw !== null) {
    info.host_id = id(hostRaw);
  }
  return info;
}

/** Map `GET /api/rooms/{code}` payload (`{room, members}`) to a typed shape. */
export function normalizeRoomDetail(raw: unknown): RoomDetailResponse {
  const r = asRaw(raw);
  // Tolerate a bare room object at the top level when `room` is absent.
  const roomRaw = r.room !== undefined && r.room !== null ? r.room : raw;
  const room = normalizeRoomInfo(roomRaw);
  // Some APIs put the file id on the envelope, not inside `room`.
  if (room.task_file_id == null) {
    const outer =
      r.task_file_id ?? r.file_id ?? r.taskFileId ?? r.fileId ?? r.library_file_id;
    if (outer !== undefined && outer !== null && outer !== "") {
      room.task_file_id = id(outer);
    }
  }
  return {
    room,
    members: Array.isArray(r.members) ? r.members.map(normalizeRoomMember) : [],
  };
}

export function normalizeFileUrl(raw: unknown): FileUrlResponse {
  const r = asRaw(raw);
  return {
    url: str(r.url),
    expires_in: num(r.expires_in),
  };
}
