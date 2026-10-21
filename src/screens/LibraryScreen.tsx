/**
 * Library hub (ui-ux-redesign): watch-state filters, continue-watching,
 * download status, and media actions. Tasks/History screens fold in here.
 */

import { useEffect, useMemo, useState } from "react";
import { cancelTask, fetchTasks } from "../api/endpoints";
import type { ApiId, TaskDetailResponse } from "../api/types";
import { Button } from "../design/primitives";
import { Screen } from "../design/slots";
import { useHistoryList } from "../features/history";
import { LibraryList, useLibrary } from "../features/library";
import {
  continueFileForItem,
  filterLibraryItems,
  formatLibraryFilter,
  resumePositionForFile,
  watchStateForItem,
  type LibraryFilter,
} from "../features/library/libraryHelpers";
import { openPlayer } from "../features/player/playerNav";

const FILTERS: readonly LibraryFilter[] = [
  "all",
  "watching",
  "watched",
  "planned",
];

export function LibraryScreen() {
  const { items, status, error, refresh } = useLibrary();
  const history = useHistoryList();
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [tasks, setTasks] = useState<TaskDetailResponse[]>([]);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchTasks({ active: true, signal: controller.signal });
        if (cancelled || controller.signal.aborted) return;
        setTasks(list);
      } catch {
        if (cancelled || controller.signal.aborted) return;
        setTasks([]);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [items, reloadToken]);

  const filtered = useMemo(
    () => filterLibraryItems(items, history.items, filter),
    [items, history.items, filter],
  );

  const continueItems = useMemo(
    () =>
      items
        .filter((item) => watchStateForItem(item, history.items) === "watching")
        .slice(0, 8),
    [items, history.items],
  );

  const handleCancelTask = (taskId: ApiId) => {
    void (async () => {
      try {
        await cancelTask(taskId);
        setTasks((prev) => prev.filter((t) => String(t.id) !== String(taskId)));
        setReloadToken((token) => token + 1);
        refresh();
      } catch {
        // Keep the row; user can retry.
      }
    })();
  };

  return (
    <Screen title="Библиотека">
      <p className="lede">
        Смотрите, продолжайте и собирайте медиа для вечера — включая совместный просмотр.
      </p>

      <div className="library-toolbar">
        <div className="library-filters" role="tablist" aria-label="Статус просмотра">
          {FILTERS.map((value) => {
            const selected = filter === value;
            return (
              <Button
                key={value}
                role="tab"
                aria-selected={selected}
                variant={selected ? "primary" : "ghost"}
                size="sm"
                onClick={() => setFilter(value)}
              >
                {formatLibraryFilter(value)}
              </Button>
            );
          })}
        </div>
        <Button variant="ghost" size="sm" onClick={() => {
          refresh();
          history.refresh();
        }}>
          Обновить
        </Button>
      </div>

      {tasks.length > 0 ? (
        <section className="library-tasks" aria-label="Активные загрузки">
          <h2>Активные загрузки</h2>
          <ul>
            {tasks.map((task) => (
              <li key={String(task.id)}>
                <span>{task.stage || task.status}</span>
                <span className="hint">{Math.round(task.progress_pct)}%</span>
                <Button variant="ghost" size="sm" onClick={() => handleCancelTask(task.id)}>
                  Отменить
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {continueItems.length > 0 ? (
        <section className="library-continue" aria-label="Продолжить просмотр">
          <h2>Продолжить просмотр</h2>
          <div className="library-continue-row">
            {continueItems.map((item) => {
              const file = continueFileForItem(item, history.items);
              const startAt = file
                ? resumePositionForFile(file, history.items)
                : null;
              return (
                <Button
                  key={String(item.library_item.id)}
                  variant="secondary"
                  size="sm"
                  disabled={!file}
                  onClick={() => {
                    if (file) openPlayer(file.id, { startAt });
                  }}
                >
                  {item.media_item.title}
                </Button>
              );
            })}
          </div>
        </section>
      ) : null}

      <LibraryList
        items={filtered}
        history={history.items}
        tasks={tasks}
        loading={status === "loading"}
        error={status === "error" ? error : null}
        onRetry={refresh}
        onCancelTask={handleCancelTask}
      />
    </Screen>
  );
}
