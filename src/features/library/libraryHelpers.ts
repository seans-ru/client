/**
 * Pure library helpers (M6 + ui-ux-redesign). No React/DOM — unit-testable.
 *
 * File status vocabulary is the server's; a small ready-like set unlocks
 * play / create-room actions. Unknown statuses stay non-ready.
 * Watch state (планирую / смотрю / смотрел) is derived from history progress.
 */

import type { HistoryResponse, LibraryFile, LibraryItem } from "../../api/types";
import {
  findHistoryForFile,
  isHistoryCompleted,
} from "../history/historyHelpers";

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

/* ------------------------------------------------------- Watch state (hub) */

export type WatchState = "planned" | "watching" | "watched";

/** Russian chip label for a derived watch state. */
export function formatWatchState(state: WatchState): string {
  switch (state) {
    case "watching":
      return "Смотрю";
    case "watched":
      return "Смотрел";
    default:
      return "Планирую";
  }
}

/**
 * Watch state for one library file from its history row.
 * Missing / zero progress → planned; completed (or near-end) → watched.
 */
export function watchStateFromFile(
  file: Pick<LibraryFile, "id">,
  history: readonly HistoryResponse[],
): WatchState {
  const entry = findHistoryForFile(history, file.id);
  if (!entry) return "planned";
  if (isHistoryCompleted(entry)) return "watched";
  const position = entry.position_sec;
  return typeof position === "number" && Number.isFinite(position) && position > 0
    ? "watching"
    : "planned";
}

/**
 * Aggregate watch state for a library item:
 * any watching wins over planned; watched only when every file with history
 * (or every file) is completed.
 */
export function watchStateForItem(
  item: Pick<LibraryItem, "files">,
  history: readonly HistoryResponse[],
): WatchState {
  const files = item.files ?? [];
  if (files.length === 0) return "planned";

  let sawWatching = false;
  let sawPlanned = false;
  for (const file of files) {
    const state = watchStateFromFile(file, history);
    if (state === "watching") sawWatching = true;
    else if (state === "planned") sawPlanned = true;
  }

  if (sawWatching) return "watching";
  if (sawPlanned) return "planned";
  return "watched";
}

/** File to resume (in-progress preferred), or null when nothing to continue. */
export function continueFileForItem(
  item: Pick<LibraryItem, "files">,
  history: readonly HistoryResponse[],
): LibraryFile | null {
  const files = item.files ?? [];
  let fallback: LibraryFile | null = null;
  for (const file of files) {
    if (!canOfferPlay(file)) continue;
    const state = watchStateFromFile(file, history);
    if (state === "watching") return file;
    if (state === "planned" && !fallback && isFileReady(file)) fallback = file;
  }
  return fallback;
}

/**
 * Next episode after the furthest started/completed one («К следующей серии»).
 * Movies (no episode numbers) return null. The currently watching episode is
 * handled by «Продолжить просмотр», not by this helper.
 */
export function nextEpisodeFile(
  item: Pick<LibraryItem, "files">,
  history: readonly HistoryResponse[],
): LibraryFile | null {
  const episodes = (item.files ?? [])
    .filter((file) => canOfferPlay(file))
    .filter((file) => {
      const e = file.episode;
      return typeof e === "number" && Number.isFinite(e) && e > 0;
    })
    .sort((a, b) => {
      const sa = Number(a.season ?? 0);
      const sb = Number(b.season ?? 0);
      if (sa !== sb) return sa - sb;
      return Number(a.episode ?? 0) - Number(b.episode ?? 0);
    });

  if (episodes.length === 0) return null;

  let lastStarted = -1;
  episodes.forEach((file, index) => {
    const state = watchStateFromFile(file, history);
    if (state === "watching" || state === "watched") lastStarted = index;
  });

  for (let i = lastStarted + 1; i < episodes.length; i += 1) {
    if (watchStateFromFile(episodes[i], history) !== "watched") {
      return episodes[i];
    }
  }
  return null;
}

/** Resume position (seconds) for a file, or null to start over. */
export function resumePositionForFile(
  file: Pick<LibraryFile, "id">,
  history: readonly HistoryResponse[],
): number | null {
  const entry = findHistoryForFile(history, file.id);
  if (!entry || isHistoryCompleted(entry)) return null;
  const position = entry.position_sec;
  return typeof position === "number" && Number.isFinite(position) && position > 0
    ? position
    : null;
}

/** Filter chips for the Library hub. */
export type LibraryFilter = "all" | WatchState;

export function formatLibraryFilter(filter: LibraryFilter): string {
  switch (filter) {
    case "watching":
      return "Смотрю";
    case "watched":
      return "Смотрел";
    case "planned":
      return "Планирую";
    default:
      return "Все";
  }
}

export function filterLibraryItems(
  items: readonly LibraryItem[],
  history: readonly HistoryResponse[],
  filter: LibraryFilter,
): LibraryItem[] {
  if (filter === "all") return [...items];
  return items.filter((item) => watchStateForItem(item, history) === filter);
}
