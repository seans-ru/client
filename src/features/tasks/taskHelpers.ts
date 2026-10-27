/**
 * Pure task helpers (M5). No React/DOM — unit-testable.
 *
 * Status vocabulary is the server's; we treat a small set as terminal and
 * everything else as active so unknown new statuses keep polling.
 */

import type {
  ApiId,
  TaskDetailResponse,
  TorrentReleaseResponse,
} from "../../api/types";

/** Poll cadence while at least one task is active (ms). */
export const TASK_POLL_ACTIVE_MS = 3000;

/** Statuses that never change again — polling stops when all tasks are in this set. */
const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "finished",
  "done",
  "success",
  "succeeded",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "idle",
]);

/** True when the task may still progress (poll / show cancel). */
export function isTaskActive(status: string): boolean {
  return !TERMINAL_TASK_STATUSES.has(String(status ?? "").trim().toLowerCase());
}

/**
 * Poll decision: the interval to use for the next refresh, or `null` when
 * nothing is active and polling should stop.
 */
export function taskPollInterval(
  tasks: ReadonlyArray<Pick<TaskDetailResponse, "status">>,
): number | null {
  return tasks.some((task) => isTaskActive(task.status))
    ? TASK_POLL_ACTIVE_MS
    : null;
}

/** JSON body for POST /api/tasks. */
export type TaskCreatePayload = {
  torrent_release_id: ApiId;
  file_paths: string[];
};

/**
 * Build a task-create body for a release.
 *
 * File selection:
 * - explicit `selectedPaths` wins (user picked files);
 * - else the release's own `file_paths` (all of them) when the API provided a list;
 * - else `file_paths: []`, which is the documented default full-torrent selection.
 *
 * Note: the current Seans backend accepts `file_paths` but does not filter the
 * torrent with it (workers get an empty list). Sending paths is forward-compatible;
 * today the server downloads the full torrent either way.
 */
export function buildTaskCreateBody(
  release: Pick<TorrentReleaseResponse, "id" | "file_paths">,
  selectedPaths?: readonly string[] | null,
): TaskCreatePayload {
  const paths =
    selectedPaths != null
      ? [...selectedPaths]
      : release.file_paths && release.file_paths.length > 0
        ? [...release.file_paths]
        : [];
  return { torrent_release_id: release.id, file_paths: paths };
}

/**
 * Merge a `GET /api/tasks?active=true` payload into the previously known list.
 * Keeps terminal tasks that the active filter no longer returns; upserts active ones.
 */
export function mergeActiveTasks(
  prev: readonly TaskDetailResponse[],
  active: readonly TaskDetailResponse[],
): TaskDetailResponse[] {
  const byId = new Map<string, TaskDetailResponse>();
  for (const task of prev) {
    byId.set(String(task.id), task);
  }
  for (const task of active) {
    byId.set(String(task.id), task);
  }
  return [...byId.values()];
}

/**
 * True when a task we still consider active is missing from the active payload
 * (it just reached a terminal state) — the caller should then reload the full list.
 */
export function hasLostActive(
  prev: readonly TaskDetailResponse[],
  active: readonly TaskDetailResponse[],
): boolean {
  const activeIds = new Set(active.map((task) => String(task.id)));
  return prev.some(
    (task) => isTaskActive(task.status) && !activeIds.has(String(task.id)),
  );
}

/** Russian label for a task status string. */
export function formatTaskStatus(status: string): string {
  switch (String(status ?? "").trim().toLowerCase()) {
    case "queued":
    case "pending":
    case "waiting":
      return "В очереди";
    case "running":
    case "downloading":
    case "active":
      return "Загрузка";
    case "processing":
    case "preparing":
    case "checking":
      return "Обработка";
    case "paused":
      return "Пауза";
    case "completed":
    case "finished":
    case "done":
    case "success":
    case "succeeded":
      return "Завершена";
    case "failed":
    case "error":
      return "Ошибка";
    case "cancelled":
    case "canceled":
      return "Отменена";
    case "idle":
      return "Ожидание";
    default:
      return status || "—";
  }
}
