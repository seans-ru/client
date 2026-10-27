/**
 * History feature barrel (M9). Pure helpers live in `historyThrottle` /
 * `historyHelpers` (unit-tested).
 */

export { HistoryList } from "./HistoryList";
export {
  buildFileTitleMap,
  findHistoryForFile,
  formatHistoryUpdatedAt,
  historyFileFallback,
  historyProgressPercent,
  historyRowTitle,
  isHistoryCompleted,
  resumePositionFromHistory,
  sortHistoryForContinue,
} from "./historyHelpers";
export { fetchResumePosition } from "./historyResume";
export {
  COMPLETED_RATIO,
  createHistoryThrottle,
  HISTORY_SAVE_INTERVAL_MS,
  isHistorySaveDue,
  isPlaybackCompleted,
} from "./historyThrottle";
export type { HistoryThrottle } from "./historyThrottle";
export { useHistoryList, HISTORY_LIST_LIMIT } from "./useHistoryList";
export type {
  HistoryListState,
  HistoryListStatus,
} from "./useHistoryList";
export { useHistoryProgress } from "./useHistoryProgress";
export type {
  HistoryProgressSnapshot,
  UseHistoryProgressOptions,
  UseHistoryProgressResult,
} from "./useHistoryProgress";
