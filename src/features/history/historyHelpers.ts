/**
 * Pure history helpers (M9). No React/DOM — unit-testable.
 *
 * Resume + "continue watching" presentation rules live here so both
 * PlayerScreen and HistoryScreen share one source of truth.
 */

import type { HistoryListItem, HistoryResponse, LibraryItem } from "../../api/types";
import { isPlaybackCompleted } from "./historyThrottle";

/**
 * True when a history row counts as watched: either the server said so, or
 * the local near-end threshold is reached (see `isPlaybackCompleted`).
 */
export function isHistoryCompleted(entry: HistoryResponse): boolean {
  if (entry.completed) return true;
  return isPlaybackCompleted(entry.position_sec, entry.duration_sec);
}

/**
 * Resume target for a history entry, or null when playback should start over
 * (missing entry, completed, or no meaningful position).
 */
export function resumePositionFromHistory(
  entry: HistoryResponse | null | undefined,
): number | null {
  if (!entry) return null;
  if (isHistoryCompleted(entry)) return null;
  const position = entry.position_sec;
  return typeof position === "number" && Number.isFinite(position) && position > 0
    ? position
    : null;
}

/** Find the history row for a task file id (ids compare as strings). */
export function findHistoryForFile(
  list: readonly HistoryResponse[],
  taskFileId: string | number,
): HistoryResponse | null {
  const key = String(taskFileId);
  for (const entry of list) {
    if (String(entry.task_file_id) === key) return entry;
  }
  return null;
}

/**
 * Continue-watching list: newest first, incomplete rows before completed ones.
 * Completed rows are kept (marked in the UI), not dropped — the screen decides.
 */
export function sortHistoryForContinue<T extends HistoryResponse>(
  list: readonly T[],
): T[] {
  return [...list].sort((a, b) => {
    const doneA = isHistoryCompleted(a) ? 1 : 0;
    const doneB = isHistoryCompleted(b) ? 1 : 0;
    if (doneA !== doneB) return doneA - doneB;
    return String(b.updated_at).localeCompare(String(a.updated_at));
  });
}

/**
 * Display title from a history row's own `media` snippet
 * (`GET /api/history` nested payload). Null when absent.
 */
export function historyRowTitle(entry: HistoryListItem): string | null {
  const title = String(entry.media?.title ?? "").trim();
  return title.length > 0 ? title : null;
}

/** Watch progress 0–100 for the row progress bar. */
export function historyProgressPercent(entry: HistoryResponse): number {
  const d = entry.duration_sec;
  if (!(typeof d === "number" && Number.isFinite(d) && d > 0)) return 0;
  const p = entry.position_sec;
  const pos = typeof p === "number" && Number.isFinite(p) ? p : 0;
  return Math.min(100, Math.max(0, (pos / d) * 100));
}

/** Compact file label when no title can be resolved: `Файл #12`. */
export function historyFileFallback(taskFileId: string | number): string {
  return `Файл #${taskFileId}`;
}

/**
 * Map library file id → display title (`Сериал` / `Сериал · Сезон 1 · Серия 2`).
 * Used by HistoryScreen as a best-effort title lookup.
 */
export function buildFileTitleMap(
  items: readonly LibraryItem[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    const title = String(item.media_item?.title ?? "").trim();
    if (!title) continue;
    for (const file of item.files) {
      const season =
        typeof file.season === "number" && Number.isFinite(file.season) && file.season > 0
          ? Math.trunc(file.season)
          : null;
      const episode =
        typeof file.episode === "number" && Number.isFinite(file.episode) && file.episode > 0
          ? Math.trunc(file.episode)
          : null;
      const parts = [title];
      if (season != null && episode != null) {
        parts.push(`Сезон ${season} · Серия ${episode}`);
      } else if (episode != null) {
        parts.push(`Серия ${episode}`);
      } else if (season != null) {
        parts.push(`Сезон ${season}`);
      }
      map.set(String(file.id), parts.join(" · "));
    }
  }
  return map;
}

/**
 * Russian short timestamp for history rows: `05.03.2026, 21:14`.
 * Invalid / missing input renders as `—`.
 */
export function formatHistoryUpdatedAt(iso: string | null | undefined): string {
  const raw = String(iso ?? "").trim();
  if (!raw) return "—";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}, ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
