/**
 * Capture helpers (issue #14): screenshots and A→B clips.
 *
 * Pure logic only — no React / DOM / Tauri, so every rule is unit-testable.
 * The mpv command shapes follow the issue contract:
 * `ctx.mpv.command(["screenshot-to-file", path, "video" | "subtitles"])`.
 * Clip export itself runs in Rust (`capture.rs`, ffmpeg stream copy); here we
 * own naming, mark math and the UI copy around the fallback.
 */

import { formatTime } from "../playerHelpers";

/** mpv screenshot modes we expose (issue: «чистый кадр / с субтитрами»). */
export type ScreenshotMode = "video" | "subtitles";

export const SCREENSHOT_MODES: readonly ScreenshotMode[] = ["video", "subtitles"];

export const SCREENSHOT_MODE_LABELS: Record<ScreenshotMode, string> = {
  video: "Чистый кадр",
  subtitles: "С субтитрами",
};

/** File format of screenshots (mpv infers it from the extension). */
export type ScreenshotFormat = "png" | "jpeg";

export const SCREENSHOT_FORMATS: readonly ScreenshotFormat[] = ["png", "jpeg"];

export const SCREENSHOT_FORMAT_LABELS: Record<ScreenshotFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
};

export const SCREENSHOT_EXTENSION: Record<ScreenshotFormat, string> = {
  png: "png",
  jpeg: "jpg",
};

/** Clip containers offered on export (issue: «экспорт в MP4/MKV»). */
export type ClipContainer = "mp4" | "mkv";

export const CLIP_CONTAINERS: readonly ClipContainer[] = ["mp4", "mkv"];

export function parseScreenshotMode(raw: unknown): ScreenshotMode {
  return raw === "subtitles" ? "subtitles" : "video";
}

export function parseScreenshotFormat(raw: unknown): ScreenshotFormat {
  return raw === "jpeg" ? "jpeg" : "png";
}

/** Persisted folder: a non-empty string or "" (= «use the default folder»). */
export function parseSaveDir(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/** mpv command: write the current frame to `path` in the given mode. */
export function screenshotArgs(path: string, mode: ScreenshotMode): string[] {
  return ["screenshot-to-file", path, mode];
}

/** `20261107-193045` from a local-time Date. */
export function timestampStamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

export function screenshotFileName(
  format: ScreenshotFormat,
  at: Date,
): string {
  return `seans-shot-${timestampStamp(at)}.${SCREENSHOT_EXTENSION[format]}`;
}

export function clipFileName(at: Date, container: ClipContainer): string {
  return `seans-clip-${timestampStamp(at)}.${container}`;
}

/** One frame of the A→B fallback (`-a` / `-b` suffix). */
export function frameFileName(
  at: Date,
  mark: "a" | "b",
  format: ScreenshotFormat,
): string {
  return `seans-clip-${timestampStamp(at)}-${mark}.${SCREENSHOT_EXTENSION[format]}`;
}

/** Join a directory and a file name with the directory's own separator. */
export function joinCapturePath(dir: string, name: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  if (!trimmed) return name;
  const sep = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
  return `${trimmed}${sep}${name}`;
}

/* --------------------------------------------------------------- A→B marks */

export type ClipMarks = {
  a: number | null;
  b: number | null;
};

export const EMPTY_MARKS: ClipMarks = { a: null, b: null };

/** Non-finite / negative positions are treated as 0. */
function clampPosition(position: number): number {
  return Number.isFinite(position) && position > 0 ? position : 0;
}

/**
 * Mark the clip start. A stale end mark (now before the start) is dropped so
 * the range is always `a < b` or incomplete — never reversed.
 */
export function setMarkA(marks: ClipMarks, position: number): ClipMarks {
  const a = clampPosition(position);
  return { a, b: marks.b != null && marks.b > a ? marks.b : null };
}

/**
 * Mark the clip end. Clicking «Конец» before «Начало» swaps the marks (the
 * clicked point becomes the start) — no dead-end states while scrubbing.
 */
export function setMarkB(marks: ClipMarks, position: number): ClipMarks {
  const b = clampPosition(position);
  if (marks.a == null) return { a: null, b };
  if (b <= marks.a) return { a: b, b: marks.a };
  return { a: marks.a, b };
}

export function clearMarks(): ClipMarks {
  return { a: null, b: null };
}

/** Positive duration in seconds, or `null` when the range is incomplete. */
export function clipDuration(marks: ClipMarks): number | null {
  const { a, b } = marks;
  if (a == null || b == null || b <= a) return null;
  return b - a;
}

export function isExportable(marks: ClipMarks): boolean {
  return clipDuration(marks) != null;
}

/** `33.4 с` under a minute, `1:05` above. */
export function formatClipDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 с";
  if (seconds < 60) {
    const tenths = Math.round(seconds * 10) / 10;
    return `${tenths} с`;
  }
  return formatTime(seconds);
}

/** `A 0:12 → B 0:45 · 33.4 с` — the clip badge in the overlay. */
export function marksLabel(marks: ClipMarks): string | null {
  const { a, b } = marks;
  if (a == null && b == null) return null;
  const start = a != null ? formatTime(a) : "—";
  const end = b != null ? formatTime(b) : "—";
  const duration = clipDuration(marks);
  return duration != null
    ? `A ${start} → B ${end} · ${formatClipDuration(duration)}`
    : `A ${start} → B ${end}`;
}

/** Container chosen by the file extension the user saved to. */
export function containerFromPath(path: string): ClipContainer | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp4")) return "mp4";
  if (lower.endsWith(".mkv")) return "mkv";
  return null;
}

/** Append the fallback extension when the dialog name has none. */
export function ensureClipExtension(
  path: string,
  fallback: ClipContainer,
): string {
  return containerFromPath(path) ? path : `${path}.${fallback}`;
}

/* --------------------------------------------------------------- fallback */

export type FallbackFrame = {
  at: number;
  mark: "a" | "b";
};

/**
 * Frames the «вырезка недоступна» fallback saves via mpv (issue:
 * «сохранить кадры начала/конца»). Empty when the range is incomplete.
 */
export function fallbackFrames(marks: ClipMarks): FallbackFrame[] {
  const { a, b } = marks;
  if (a == null || b == null || b <= a) return [];
  return [
    { at: a, mark: "a" },
    { at: b, mark: "b" },
  ];
}

/** mpv `time-pos` is a decimal string; `no` / garbage → `null`. */
export function parseMpvTime(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Tolerance when waiting for a seeked frame before `screenshot-to-file`. */
export const FRAME_SEEK_EPSILON_SEC = 1;

export function isNearPosition(
  position: number,
  target: number,
  epsilon: number = FRAME_SEEK_EPSILON_SEC,
): boolean {
  return Math.abs(position - target) <= epsilon;
}

/** ffmpeg `out_time` progress → percent of the A→B range (0…100). */
export function exportProgressPercent(
  outTimeMs: number,
  rangeSec: number,
): number {
  if (!Number.isFinite(rangeSec) || rangeSec <= 0) return 0;
  const fraction = outTimeMs / 1000 / rangeSec;
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(100, Math.max(0, Math.round(fraction * 100)));
}

/** «Экспорт клипа… 45%» — the progress toast while ffmpeg runs. */
export function exportingLabel(percent: number): string {
  const clamped = Number.isFinite(percent)
    ? Math.min(100, Math.max(0, Math.round(percent)))
    : 0;
  return `Экспорт клипа… ${clamped}%`;
}

/* -------------------------------------------------------------------- copy */

export const CAPTURE_COPY = {
  section: "Захват",
  screenshot: "Скриншот",
  screenshotTitle: "Скриншот (S)",
  markA: "Начало клипа",
  markB: "Конец клипа",
  exportClip: "Экспорт",
  clearMarks: "Сброс",
  showInFolder: "Показать в папке",
  screenshotSaved: "Скриншот сохранён",
  screenshotFailed: "Не удалось сохранить скриншот",
  noMedia: "Нет открытого видео",
  exportDone: "Клип сохранён",
  exportFailed: "Экспорт клипа не удался",
  noRange: "Сначала укажите начало и конец клипа",
  ffmpegMissing:
    "Вырезка недоступна: ffmpeg не найден. Сохранить кадры начала и конца?",
  saveFrames: "Сохранить кадры",
  framesSaved: "Кадры начала и конца сохранены",
  framesFailed: "Не удалось сохранить кадры",
  folderLabel: "Папка сохранения",
  changeFolder: "Изменить…",
  openFolder: "Открыть папку",
  formatLabel: "Формат скриншота",
  modeLabel: "Кадр",
  defaultFolderHint: "Изображения/Seans",
} as const;
