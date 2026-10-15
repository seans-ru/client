/**
 * Pure player helpers (M7). No React/DOM / Tauri — unit-testable.
 *
 * Product ranges: speed 0.25–2.0, seek is absolute and clamped to duration.
 */

/** Minimum playback speed offered by the UI. */
export const MIN_SPEED = 0.25;
/** Maximum playback speed offered by the UI. */
export const MAX_SPEED = 2.0;

/** Speed steps in the player speed selector (Russian UI «Скорость»). */
export const SPEED_OPTIONS: readonly number[] = [0.25, 0.5, 1, 1.25, 1.5, 2];

/** Keyboard seek step in seconds (← / →). */
export const SEEK_STEP_SEC = 5;

/** Overlay auto-hide delay after mouse idle, milliseconds. */
export const OVERLAY_IDLE_MS = 3000;

/**
 * Format seconds as `mm:ss` (or `h:mm:ss` when >= 1 hour).
 * Non-finite / negative input is treated as 0. Fractional seconds truncate.
 */
export function formatTime(seconds: number | null | undefined): string {
  const n = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0;
  const total = Math.max(0, Math.floor(n));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Clamp playback speed into the product range 0.25–2.0.
 * Non-finite input becomes 1.0 (neutral).
 */
export function clampSpeed(speed: number | null | undefined): number {
  if (typeof speed !== "number" || !Number.isFinite(speed)) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

/**
 * Clamp an absolute seek target into [0, duration].
 * When duration is missing / non-positive there is no upper bound (only >= 0).
 * Non-finite seconds become 0.
 */
export function clampSeek(
  seconds: number | null | undefined,
  duration: number | null | undefined,
): number {
  const t = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0;
  const d = typeof duration === "number" && Number.isFinite(duration) ? duration : 0;
  const upper = d > 0 ? d : Number.POSITIVE_INFINITY;
  return Math.min(upper, Math.max(0, t));
}

/** Apply a relative ±delta seek from `position`, clamped to `duration`. */
export function applySeekDelta(
  position: number,
  delta: number,
  duration: number | null | undefined,
): number {
  return clampSeek(position + delta, duration);
}

/**
 * Format a track id for display / select values: `"audio:1"`, `"sub:3"`.
 * Non-positive or non-finite ids are normalized to 0 («off»).
 */
export function formatTrackId(kind: string, id: number | null | undefined): string {
  const k = String(kind ?? "").trim().toLowerCase() || "track";
  const n = typeof id === "number" && Number.isFinite(id) && id > 0 ? Math.trunc(id) : 0;
  return `${k}:${n}`;
}

/** Parse a `kind:id` select value back to `{kind, id}` (id 0 = off). */
export function parseTrackId(
  value: string,
): { kind: string; id: number } {
  const raw = String(value ?? "");
  const idx = raw.lastIndexOf(":");
  if (idx <= 0) return { kind: raw.trim().toLowerCase() || "track", id: 0 };
  const kind = raw.slice(0, idx).trim().toLowerCase();
  const n = Number(raw.slice(idx + 1));
  const id = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  return { kind: kind || "track", id };
}

/**
 * Russian label for a track row, e.g. `Аудио 2 · рус · AAC`.
 * `kind` is the mpv type string (`audio` | `video` | `sub`).
 */
export function formatTrackLabel(track: {
  kind?: string | null;
  id?: number | null;
  title?: string | null;
  lang?: string | null;
  codec?: string | null;
}): string {
  const kind = String(track?.kind ?? "").toLowerCase();
  const id = typeof track?.id === "number" && track.id > 0 ? track.id : 0;
  const head =
    kind === "audio" ? `Аудио ${id}` : kind === "sub" ? `Субтитры ${id}` : `Дорожка ${id}`;
  const title = String(track?.title ?? "").trim();
  const lang = String(track?.lang ?? "").trim();
  const codec = String(track?.codec ?? "").trim().toUpperCase();
  const parts = [head];
  if (lang) parts.push(lang);
  if (title) parts.push(title);
  else if (codec) parts.push(codec);
  return parts.join(" · ");
}

/** Human-readable hwdec value for the read-only Settings / overlay badge. */
export function formatHwdec(hwdec: string | null | undefined): string {
  const v = String(hwdec ?? "").trim();
  if (!v || v === "no" || v === "none") return "программное декодирование";
  return `ускорение: ${v}`;
}

/** Embed diagnostic: active `vo` + decoded frame size. */
export function formatVoDebug(
  vo: string | null | undefined,
  w: number | null | undefined,
  h: number | null | undefined,
): string {
  const name = String(vo ?? "").trim() || "—";
  const wn = typeof w === "number" && w > 0 ? Math.trunc(w) : 0;
  const hn = typeof h === "number" && h > 0 ? Math.trunc(h) : 0;
  return wn > 0 && hn > 0 ? `vo=${name} · ${wn}×${hn}` : `vo=${name}`;
}

/** Seek bar percentage 0–100 for the progress rail. */
export function positionPercent(
  position: number | null | undefined,
  duration: number | null | undefined,
): number {
  const p = typeof position === "number" && Number.isFinite(position) ? position : 0;
  const d = typeof duration === "number" && Number.isFinite(duration) ? duration : 0;
  if (d <= 0) return 0;
  return Math.min(100, Math.max(0, (p / d) * 100));
}

/**
 * Map a click / drag ratio (0–1) on the seek bar to an absolute position.
 * Ratio is clamped; duration <= 0 yields 0.
 */
export function ratioToPosition(
  ratio: number | null | undefined,
  duration: number | null | undefined,
): number {
  const r = typeof ratio === "number" && Number.isFinite(ratio) ? ratio : 0;
  return clampSeek(Math.min(1, Math.max(0, r)) * (duration ?? 0), duration);
}
