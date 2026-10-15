/**
 * Player event/state types shared by the Rust `player` commands (M7).
 * Field names mirror the serde structs in src-tauri/src/player/session.rs.
 */

export type PlayerTrack = {
  id: number;
  /** mpv track type: "audio" | "video" | "sub" */
  kind: string;
  title: string;
  lang: string;
  codec: string;
  selected: boolean;
  external: boolean;
};

export type PlayerSnapshot = {
  position: number;
  duration: number;
  pause: boolean;
  eof: boolean;
  error: string | null;
  tracks: PlayerTrack[];
  /** Active hwdec name ("no" when software decoding). */
  hwdec: string;
  /** Active mpv video output (`vo-current`) — embed diagnostics. */
  vo: string;
  /** Decoded frame width/height (0 when no video yet). */
  video_w: number;
  video_h: number;
  speed: number;
  volume: number;
  mute: boolean;
  fullscreen: boolean;
  idle: boolean;
  file_loaded: boolean;
  url: string;
};

/** Tauri event name carrying `PlayerSnapshot` payloads. */
export const PLAYER_STATE_EVENT = "player://state";

export const DEFAULT_SNAPSHOT: PlayerSnapshot = {
  position: 0,
  duration: 0,
  pause: true,
  eof: false,
  error: null,
  tracks: [],
  hwdec: "no",
  vo: "",
  video_w: 0,
  video_h: 0,
  speed: 1,
  volume: 100,
  mute: false,
  fullscreen: false,
  idle: true,
  file_loaded: false,
  url: "",
};

/** Normalize a possibly partial event payload into a full snapshot. */
export function normalizeSnapshot(raw: unknown): PlayerSnapshot {
  const r = (raw ?? {}) as Partial<PlayerSnapshot> & Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    position: num(r.position, DEFAULT_SNAPSHOT.position),
    duration: num(r.duration, DEFAULT_SNAPSHOT.duration),
    pause: typeof r.pause === "boolean" ? r.pause : DEFAULT_SNAPSHOT.pause,
    eof: typeof r.eof === "boolean" ? r.eof : DEFAULT_SNAPSHOT.eof,
    error: typeof r.error === "string" && r.error.length > 0 ? r.error : null,
    tracks: Array.isArray(r.tracks)
      ? r.tracks.map((t) => {
          const track = (t ?? {}) as Partial<PlayerTrack>;
          return {
            id: num(track.id, 0),
            kind: String(track.kind ?? "audio"),
            title: String(track.title ?? ""),
            lang: String(track.lang ?? ""),
            codec: String(track.codec ?? ""),
            selected: Boolean(track.selected),
            external: Boolean(track.external),
          };
        })
      : [],
    hwdec: typeof r.hwdec === "string" ? r.hwdec : DEFAULT_SNAPSHOT.hwdec,
    vo: typeof r.vo === "string" ? r.vo : DEFAULT_SNAPSHOT.vo,
    video_w: num(r.video_w, DEFAULT_SNAPSHOT.video_w),
    video_h: num(r.video_h, DEFAULT_SNAPSHOT.video_h),
    speed: num(r.speed, DEFAULT_SNAPSHOT.speed),
    volume: num(r.volume, DEFAULT_SNAPSHOT.volume),
    mute: typeof r.mute === "boolean" ? r.mute : DEFAULT_SNAPSHOT.mute,
    fullscreen:
      typeof r.fullscreen === "boolean" ? r.fullscreen : DEFAULT_SNAPSHOT.fullscreen,
    idle: typeof r.idle === "boolean" ? r.idle : DEFAULT_SNAPSHOT.idle,
    file_loaded:
      typeof r.file_loaded === "boolean" ? r.file_loaded : DEFAULT_SNAPSHOT.file_loaded,
    url: typeof r.url === "string" ? r.url : DEFAULT_SNAPSHOT.url,
  };
}

/** Player surface phase shown by `PlayerScreen`. */
export type PlayerPhase = "loading" | "ready" | "error";
