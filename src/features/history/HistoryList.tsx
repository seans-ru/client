/**
 * Continue-watching list UI (M9). Russian UI strings.
 *
 * Rows: resolved title (library lookup, file-id fallback), progress bar,
 * updated_at, «Продолжить» → `#/player/{fileId}` with startAt. Completed
 * rows are kept but marked «Просмотрено» and restart from the beginning.
 */

import { Badge, Button, EmptyState, ErrorState, ProgressBar, Spinner } from "../../design/primitives";
import type { ApiId, HistoryListItem } from "../../api/types";
import { openPlayer } from "../player";
import {
  formatHistoryUpdatedAt,
  historyFileFallback,
  historyProgressPercent,
  historyRowTitle,
  isHistoryCompleted,
  sortHistoryForContinue,
} from "./historyHelpers";

function HistoryRow({
  entry,
  title,
  onContinue,
}: {
  entry: HistoryListItem;
  title: string;
  onContinue: (fileId: ApiId, startAt: number | null) => void;
}) {
  const completed = isHistoryCompleted(entry);
  const percent = historyProgressPercent(entry);
  return (
    <li className="history-row">
      <div className="history-row-main">
        <div className="history-row-title" title={title}>
          <span className="history-row-name">{title}</span>
          {completed ? <Badge tone="accent">Просмотрено</Badge> : null}
        </div>
        <div className="history-row-meta">
          <span>{formatHistoryUpdatedAt(entry.updated_at)}</span>
        </div>
      </div>
      <ProgressBar
        value={percent}
        label={completed ? "Просмотрено" : `Прогресс ${Math.round(percent)}%`}
      />
      <div className="history-row-actions">
        <Button
          variant={completed ? "secondary" : "primary"}
          size="sm"
          onClick={() =>
            onContinue(
              entry.task_file_id,
              completed ? null : entry.position_sec,
            )
          }
        >
          {completed ? "Смотреть" : "Продолжить"}
        </Button>
      </div>
    </li>
  );
}

export function HistoryList({
  items,
  loading,
  error,
  titles,
  onRetry,
  onContinue,
}: {
  items: HistoryListItem[];
  loading: boolean;
  error: string | null;
  /** Optional file-id → display title map (library lookup). */
  titles?: ReadonlyMap<string, string> | null;
  onRetry?: () => void;
  onContinue?: (fileId: ApiId, startAt: number | null) => void;
}) {
  const handleContinue = onContinue ?? ((fileId, startAt) => openPlayer(fileId, { startAt }));
  const titleMap = titles ?? new Map<string, string>();

  if (loading) {
    return <Spinner label="Загрузка истории…" />;
  }
  if (error) {
    return (
      <ErrorState
        title="Не удалось загрузить историю"
        description={error}
        onRetry={onRetry}
      />
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        title="История пуста"
        description="Просмотренное появится здесь."
      />
    );
  }

  const sorted = sortHistoryForContinue(items);
  return (
    <ul className="history-list">
      {sorted.map((entry) => {
        const key = String(entry.task_file_id);
        const title =
          historyRowTitle(entry) ?? titleMap.get(key) ?? historyFileFallback(entry.task_file_id);
        return (
          <HistoryRow
            key={String(entry.id)}
            entry={entry}
            title={title}
            onContinue={handleContinue}
          />
        );
      })}
    </ul>
  );
}
