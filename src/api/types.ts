/**
 * Client-facing Seans API response shapes (M2).
 *
 * Field names mirror the JSON contract (snake_case). Worker/torrent-worker
 * endpoints are intentionally absent from this client.
 */

/** Ids arrive as number or string depending on the resource; keep as-is. */
export type ApiId = string | number;

export type UserResponse = {
  id: ApiId;
  email: string;
  display_name: string;
  can_invite: boolean;
  quota_bytes: number;
  /** Optional server-side usage; else client sums library total_size. */
  used_bytes?: number;
  created_at: string;
  /** Present on `GET /api/auth/me` (backend UserResponse). */
  is_admin?: boolean;
  /** Subscription plan code (`free` | `plus` | `pro`). */
  plan?: string;
  plan_expires_at?: string | null;
};

export type TokenResponse = {
  access_token: string;
  token_type: string;
  user: UserResponse;
};

export type MediaSearchResult = {
  id: ApiId;
  /** Kinopoisk id; null when unknown. */
  kp_id: number | null;
  title: string;
  /** Release year; null when unknown. */
  year: number | null;
  poster_url: string | null;
  kp_type: string;
  /** May arrive as number or numeric string. */
  rating_kp: number | null;
};

export type MediaDetail = MediaSearchResult & {
  original_title: string | null;
  overview: string | null;
  genres: string[];
  updated_at: string;
  /** May arrive as number or numeric string. */
  tmdb_id?: number;
  user_review?: ReviewResponse;
};

export type TorrentReleaseResponse = {
  id: ApiId;
  tracker: string;
  title: string;
  /** May arrive as number or numeric string. */
  size_bytes: number;
  seeders: number;
  leechers: number;
  quality: string | null;
  voiceover: string | null;
  magnet: string | null;
  /** Present when the API exposes release file lists for task creation. */
  file_paths?: string[];
};

export type TaskResponse = {
  id: ApiId;
  status: string;
  /** May arrive as number or numeric string. */
  reserved_bytes: number;
  /** May arrive as number or numeric string. */
  progress_pct: number;
  /** May arrive as number or numeric string. */
  speed_bps: number;
  stage: string | null;
  error?: string;
  created_at: string;
  /** Absent on `POST /api/tasks` create response (TaskResponse schema). */
  updated_at?: string;
};

/** `GET /api/tasks` / cancel — richer task with media/file join ids. */
export type TaskDetailResponse = TaskResponse & {
  media_id?: ApiId;
  task_file_id?: ApiId | null;
  updated_at?: string;
};

export type HistoryResponse = {
  id: ApiId;
  task_file_id: ApiId;
  /** May arrive as number or numeric string. */
  position_sec: number;
  /** May arrive as number or numeric string. */
  duration_sec: number;
  completed: boolean;
  updated_at: string;
};

/** Media snippet attached to a history row (`GET /api/history` nested payload). */
export type HistoryMediaSnippet = {
  id: ApiId;
  title: string;
  poster_url: string | null;
};

/** File snippet attached to a history row (`GET /api/history` nested payload). */
export type HistoryFileSnippet = {
  id: ApiId;
  path: string;
};

/**
 * `GET /api/history` item. The server returns a nested envelope
 * `{history, media, file, progress_pct}`; flat `HistoryResponse` rows are
 * also accepted. `PUT /api/history` still returns a plain `HistoryResponse`.
 */
export type HistoryListItem = HistoryResponse & {
  media?: HistoryMediaSnippet;
  file?: HistoryFileSnippet;
  /** Server-computed 0–100; falls back to position/duration when absent. */
  progress_pct?: number;
};

export type ReviewResponse = {
  id: ApiId;
  user_id: ApiId;
  media_item_id: ApiId;
  score: number;
  review: string | null;
  created_at: string;
  updated_at: string;
};

export type LibraryFile = {
  id: ApiId;
  path: string;
  /** May arrive as number or numeric string. */
  size_bytes: number;
  status: string;
  /** May arrive as number or numeric string. */
  season?: number;
  /** May arrive as number or numeric string. */
  episode?: number;
};

export type LibraryItem = {
  library_item: {
    id: ApiId;
    status: string;
    created_at: string;
  };
  media_item: {
    id: ApiId;
    title: string;
    poster_url: string | null;
    kp_type: string;
    year: number | null;
  };
  files: LibraryFile[];
  total_size: number;
  ready: boolean;
};

/** `GET /api/files/{task_file_id}/url` */
export type FileUrlResponse = {
  url: string;
  expires_in: number;
};

/** `POST /api/rooms` — created watch-party room (WS UI is M10). */
export type RoomCreateResponse = {
  id: ApiId;
  code: string;
  ws_url: string;
};

/** Room payload inside `GET /api/rooms/{code}` (`room` field). */
export type RoomInfo = {
  id: ApiId;
  code: string;
  ws_url: string;
  /** Library file played in the room; needed to open the player as guest. */
  task_file_id?: ApiId;
  /** Current host user id, when the API exposes it before the first WS frame. */
  host_id?: ApiId;
};

/** Member row from `GET /api/rooms/{code}` (`members` field). */
export type RoomMemberResponse = {
  user_id: ApiId;
  /** Display name; optional on the REST list (WS frames carry it). */
  name?: string;
};

/** `GET /api/rooms/{code}` — join payload for deep links / room screen. */
export type RoomDetailResponse = {
  room: RoomInfo;
  members: RoomMemberResponse[];
};
