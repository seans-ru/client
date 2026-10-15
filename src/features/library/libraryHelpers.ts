/**
 * Pure library helpers (M6). No React/DOM — unit-testable.
 *
 * File status vocabulary is the server's; a small ready-like set unlocks
 * play / create-room actions. Unknown statuses stay non-ready.
 */

import type { LibraryFile } from "../../api/types";

/** Statuses that mean a file can be played or shared into a room. */
const READY_FILE_STATUSES = new Set([
  "ready",
  "available",
  "completed",
  "finished",
  "done",
  "ok",
  "uploaded",
  "stored",
]);

/** True when a library file is prepared enough for «Смотреть» / «Создать комнату». */
export function isFileReady(file: Pick<LibraryFile, "status">): boolean {
  return READY_FILE_STATUSES.has(String(file?.status ?? "").trim().toLowerCase());
}

/**
 * True when Play may be offered. Progressive mode allows «Смотреть» while the
 * file is still downloading (the player gates on `stream.ready` / primary
 * video). Failed / unknown-empty statuses stay locked.
 */
export function canOfferPlay(file: Pick<LibraryFile, "status">): boolean {
  const status = String(file?.status ?? "").trim().toLowerCase();
  if (status === "failed" || status === "error") return false;
  if (READY_FILE_STATUSES.has(status)) return true;
  // Any non-empty non-failed status means a live download / processing job.
  return status.length > 0;
}

/** Keep only ready files. */
export function filterReadyFiles(
  files: readonly LibraryFile[],
): LibraryFile[] {
  return files.filter(isFileReady);
}

/**
 * Russian season/episode label, e.g. `Сезон 1 · Серия 3`.
 * Short forms when only one part is known; `""` when neither is.
 * Non-positive / non-finite values are treated as missing.
 */
export function formatEpisodeLabel(
  season?: number | null,
  episode?: number | null,
): string {
  const s =
    typeof season === "number" && Number.isFinite(season) && season > 0
      ? Math.trunc(season)
      : null;
  const e =
    typeof episode === "number" && Number.isFinite(episode) && episode > 0
      ? Math.trunc(episode)
      : null;
  if (s != null && e != null) return `Сезон ${s} · Серия ${e}`;
  if (s != null) return `Сезон ${s}`;
  if (e != null) return `Серия ${e}`;
  return "";
}

/** Russian label for a library / file status string. */
export function formatLibraryStatus(status: string): string {
  switch (String(status ?? "").trim().toLowerCase()) {
    case "ready":
    case "available":
    case "completed":
    case "finished":
    case "done":
    case "uploaded":
    case "stored":
      return "Готово";
    case "downloading":
    case "loading":
    case "running":
      return "Загрузка";
    case "processing":
    case "preparing":
    case "checking":
      return "Обработка";
    case "queued":
    case "pending":
    case "waiting":
      return "В очереди";
    case "paused":
      return "Пауза";
    case "failed":
    case "error":
      return "Ошибка";
    default:
      return status || "—";
  }
}

/** Basename of a file path for compact file rows (`a/b/c.mkv` → `c.mkv`). */
export function fileBaseName(path: string): string {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
}
