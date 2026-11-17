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
 * clicked point becomes the start) — no dead-end states while scrubbing. An
 * end equal to the start is rejected (kept as-is): `a === b` would be a
 * zero-length, unexportable range.
 */
export function setMarkB(marks: ClipMarks, position: number): ClipMarks {
  const b = clampPosition(position);
  if (marks.a == null) return { a: null, b };
  if (b === marks.a) return marks;
  if (b < marks.a) return { a: b, b: marks.a };
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

/**
 * True while a capture job owns the UI (export / screenshot in flight).
 * Guard against double-clicks: a second save dialog + a second ffmpeg run.
 */
export function isCaptureBusy(status: { kind: string }): boolean {
  return status.kind === "working" || status.kind === "progress";
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

/* ---------------------------------------------------- clip builder (drag) */

/** Shortest sensible clip: below this the range is treated as not grabbed. */
export const MIN_CLIP_SEC = 0.5;

/**
 * Clamp a range to `[0, duration]` keeping `a < b`. Incomplete marks stay
 * incomplete; `duration == null` (unknown) only clamps to ≥ 0.
 */
export function clampMarksToDuration(
  marks: ClipMarks,
  duration: number | null,
): ClipMarks {
  const max =
    duration != null && Number.isFinite(duration) && duration > 0
      ? duration
      : null;
  let a = marks.a != null ? clampPosition(marks.a) : null;
  let b = marks.b != null ? clampPosition(marks.b) : null;
  if (max != null) {
    if (a != null) a = Math.min(a, max);
    if (b != null) b = Math.min(b, max);
  }
  if (a != null && b != null && b <= a) return { a, b: null };
  return { a, b };
}

/**
 * Drag one handle to `position` (seconds). The other handle stays put when
 * possible; crossing swaps nothing — the dragged handle stops at
 * `other ± MIN_CLIP_SEC` so the segment can never collapse or reverse.
 */
export function moveHandle(
  marks: ClipMarks,
  which: "a" | "b",
  position: number,
  duration: number | null,
): ClipMarks {
  const target = clampPosition(position);
  const max =
    duration != null && Number.isFinite(duration) && duration > 0
      ? duration
      : null;
  if (which === "a") {
    const limit = marks.b != null ? marks.b - MIN_CLIP_SEC : max;
    const a =
      limit != null ? Math.min(target, Math.max(0, limit)) : target;
    return { a, b: marks.b != null && marks.b > a ? marks.b : null };
  }
  const limit = marks.a != null ? marks.a + MIN_CLIP_SEC : 0;
  const upper = max ?? Number.POSITIVE_INFINITY;
  const b = Math.min(upper, Math.max(target, limit));
  // End mark alone (no start yet) is a legal intermediate state.
  if (marks.a == null) return { a: null, b };
  return { a: marks.a, b };
}

/**
 * Drag the whole segment by `deltaSec`, keeping its length. Stops at the
 * file edges — the segment is never squashed, only pinned to 0 / duration.
 */
export function moveSegment(
  marks: ClipMarks,
  deltaSec: number,
  duration: number | null,
): ClipMarks {
  const { a, b } = marks;
  if (a == null || b == null || b <= a || !Number.isFinite(deltaSec)) {
    return marks;
  }
  const length = b - a;
  const max =
    duration != null && Number.isFinite(duration) && duration > 0
      ? duration
      : null;
  let nextA = clampPosition(a + deltaSec);
  if (max != null) nextA = Math.min(nextA, Math.max(0, max - length));
  return { a: nextA, b: nextA + length };
}

/**
 * Pointer x → seconds on the timeline. Positions outside the track clamp to
 * the edges; a zero-width track maps to 0.
 */
export function timelineSeconds(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  duration: number | null,
): number {
  const total =
    duration != null && Number.isFinite(duration) && duration > 0
      ? duration
      : 0;
  if (total <= 0 || !(rectWidth > 0)) return 0;
  const ratio = (clientX - rectLeft) / rectWidth;
  return Math.min(total, clampPosition(ratio * total));
}

/** Preview loop decision at `position` for the selected segment. */
export type PreviewAction = "stop" | "loop" | null;

export function previewActionAt(
  position: number,
  marks: ClipMarks,
  loop: boolean,
): PreviewAction {
  const { a, b } = marks;
  if (a == null || b == null || b <= a) return "stop";
  if (position < a) return loop ? "loop" : null;
  if (position >= b) return loop ? "loop" : "stop";
  return null;
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
  // Clip builder (issue: один билдер вместо кнопок A/B).
  clipBuilder: "Клип",
  clipBuilderTitle: "Создать клип",
  closeBuilder: "Закрыть",
  playSegment: "Играть фрагмент",
  stopSegment: "Стоп",
  loopSegment: "Повтор",
  builderHint: "Потяните метки A/B или весь сегмент",
  durationLabel: "Длительность",
  // Cloud (clips-cloud.md).
  cloudSection: "Облако",
  share: "Поделиться",
  upload: "Загрузить",
  uploading: "Загрузка…",
  uploadPending: "Ожидает загрузки",
  uploadFailed: "Ошибка загрузки",
  uploaded: "В облаке",
  copyLink: "Скопировать ссылку",
  linkCopied: "Ссылка скопирована",
  visibility: "Видимость",
  visibilityClosed: "Закрытый",
  visibilityByLink: "По ссылке",
  visibilityOpen: "Открытый",
  spoiler: "Спойлер",
  spoilerOn: "Спойлер: включён",
  spoilerOff: "Спойлер: выключен",
  cloudListEmpty: "Созданные клипы и скриншоты появятся здесь",
  mediaUnknown: "Фильм не определён — загрузка недоступна",
  // Best moments (phase 3).
  bestMoments: "Лучшие моменты",
  bestMomentsStart: "Смотреть",
  bestMomentsSkip: "Пропустить",
  bestMomentsExit: "Закрыть",
  bestMomentsEmpty: "Нет подходящих клипов",
} as const;

/** «Лучшие моменты через 5 с» — countdown line on the post-movie card. */
export function bestMomentsCountdownLabel(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${CAPTURE_COPY.bestMoments} через ${s} с`;
}
