/**
 * Torrent releases table + create-task flow (M5). Russian UI strings.
 */

import { useMemo, useState } from "react";
import { createTask } from "../../api/endpoints";
import type {
  TaskDetailResponse,
  TorrentReleaseResponse,
} from "../../api/types";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  JacredAttribution,
  Modal,
  Spinner,
} from "../../design/primitives";
import { formatBytes } from "../../lib/format";
import { buildTaskCreateBody } from "../tasks/taskHelpers";
import {
  filterReleases,
  RELEASE_DEFAULT_SORT,
  sortReleases,
  type ReleaseSortDir,
  type ReleaseSortKey,
} from "./releaseHelpers";

function seedersLabel(release: TorrentReleaseResponse): string {
  return `${release.seeders} / ${release.leechers}`;
}

type ReleaseRowProps = {
  release: TorrentReleaseResponse;
  selected: boolean;
  onSelect: (release: TorrentReleaseResponse) => void;
  onDownload: (release: TorrentReleaseResponse) => void;
  creating: boolean;
};

function ReleaseRow({
  release,
  selected,
  onSelect,
  onDownload,
  creating,
}: ReleaseRowProps) {
  return (
    <tr
      className={selected ? "release-row release-row-selected" : "release-row"}
      onClick={() => onSelect(release)}
    >
      <td>
        <Badge>{release.tracker || "—"}</Badge>
      </td>
      <td className="release-title" title={release.title}>
        {release.title}
      </td>
      <td>{formatBytes(release.size_bytes)}</td>
      <td>{seedersLabel(release)}</td>
      <td>{release.quality || "—"}</td>
      <td>{release.voiceover || "—"}</td>
      <td>
        <Button
          size="sm"
          variant={selected ? "primary" : "secondary"}
          disabled={creating}
          onClick={(event) => {
            event.stopPropagation();
            onDownload(release);
          }}
        >
          Скачать
        </Button>
      </td>
    </tr>
  );
}

export type ReleaseListProps = {
  releases: TorrentReleaseResponse[];
  loading: boolean;
  error: string | null;
  refreshing?: boolean;
  onRetry?: () => void;
  onRefresh?: () => void;
  /** Called after a task was created successfully. */
  onTaskCreated?: (task: TaskDetailResponse) => void;
};

/**
 * Releases table with sort + filter, selection and «Скачать» action.
 * File selection: when the release payload includes `file_paths`, those paths
 * are sent as-is (full selection of the listed files). When it does not, the
 * task is created with `file_paths: []` — the API's default full-torrent
 * selection (see `buildTaskCreateBody`).
 */
export function ReleaseList({
  releases,
  loading,
  error,
  refreshing = false,
  onRetry,
  onRefresh,
  onTaskCreated,
}: ReleaseListProps) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<ReleaseSortKey>(RELEASE_DEFAULT_SORT.key);
  const [sortDir, setSortDir] = useState<ReleaseSortDir>(RELEASE_DEFAULT_SORT.dir);
  const [selected, setSelected] = useState<TorrentReleaseResponse | null>(null);
  const [pendingRelease, setPendingRelease] =
    useState<TorrentReleaseResponse | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdTask, setCreatedTask] = useState<TaskDetailResponse | null>(null);

  const visible = useMemo(
    () => sortReleases(filterReleases(releases, query), sortKey, sortDir),
    [releases, query, sortKey, sortDir],
  );

  const handleDownload = (release: TorrentReleaseResponse) => {
    setSelected(release);
    setCreateError(null);
    setPendingRelease(release);
  };

  const confirmCreate = () => {
    if (!pendingRelease) return;
    const release = pendingRelease;
    void (async () => {
      setCreating(true);
      try {
        // Full-file selection: listed paths when present, else empty array.
        const body = buildTaskCreateBody(release);
        const task = await createTask(body);
        setCreatedTask(task);
        onTaskCreated?.(task);
        setPendingRelease(null);
      } catch (cause) {
        setCreateError(
          cause instanceof Error ? cause.message : "Не удалось создать задачу",
        );
      } finally {
        setCreating(false);
      }
    })();
  };

  if (loading) {
    return <Spinner label="Загрузка релизов…" />;
  }

  if (error) {
    return (
      <ErrorState
        title="Не удалось загрузить релизы"
        description={error}
        onRetry={onRetry}
      />
    );
  }

  if (releases.length === 0) {
    return (
      <EmptyState
        title="Релизы не найдены"
        description="Для этого фильма пока нет доступных раздач."
        action={
          onRefresh ? (
            <Button variant="secondary" onClick={onRefresh} disabled={refreshing}>
              {refreshing ? "Обновление…" : "Обновить список"}
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <div className="release-list">
      <div className="release-toolbar">
        <div className="release-filter-wrap">
          <span className="input-label">Фильтр</span>
          <div className="search-input-row">
            <input
              className="input release-filter"
              type="search"
              placeholder="Фильтр по названию, трекеру…"
              aria-label="Фильтр релизов"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <JacredAttribution />
          </div>
        </div>
        <label className="release-sort">
          <span className="input-label">Сортировка</span>
          <select
            className="input"
            value={`${sortKey}:${sortDir}`}
            onChange={(event) => {
              const [key, dir] = event.target.value.split(":") as [
                ReleaseSortKey,
                ReleaseSortDir,
              ];
              setSortKey(key);
              setSortDir(dir);
            }}
          >
            <option value="seeders:desc">Сиды ↓</option>
            <option value="seeders:asc">Сиды ↑</option>
            <option value="size:desc">Размер ↓</option>
            <option value="size:asc">Размер ↑</option>
            <option value="title:asc">Название ↑</option>
            <option value="title:desc">Название ↓</option>
            <option value="quality:asc">Качество ↑</option>
            <option value="quality:desc">Качество ↓</option>
          </select>
        </label>
        {onRefresh ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? "Обновление…" : "Обновить с трекеров"}
          </Button>
        ) : null}
      </div>

      {createdTask ? (
        <p className="release-feedback" role="status">
          Задача создана (#{String(createdTask.id)}). Отслеживайте прогресс на
          экране «Задачи».
        </p>
      ) : null}
      {createError ? (
        <p className="release-feedback release-feedback-error" role="alert">
          {createError}
        </p>
      ) : null}

      <div className="release-table-wrap">
        <table className="release-table">
          <thead>
            <tr>
              <th>Трекер</th>
              <th>Название</th>
              <th>Размер</th>
              <th>Сиды / Личи</th>
              <th>Качество</th>
              <th>Озвучка</th>
              <th aria-label="Действие" />
            </tr>
          </thead>
          <tbody>
            {visible.map((release) => (
              <ReleaseRow
                key={String(release.id)}
                release={release}
                selected={selected !== null && String(selected.id) === String(release.id)}
                onSelect={setSelected}
                onDownload={handleDownload}
                creating={creating}
              />
            ))}
          </tbody>
        </table>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="Ничего не найдено"
          description="Измените фильтр, чтобы увидеть другие релизы."
        />
      ) : null}

      {selected ? (
        <p className="hint">
          Выбран релиз: {selected.title}
          {selected.file_paths && selected.file_paths.length > 0
            ? ` · файлов: ${selected.file_paths.length}`
            : " · будет загружен весь торрент"}
        </p>
      ) : null}

      <Modal
        open={pendingRelease !== null}
        title="Создать задачу"
        onClose={() => {
          if (!creating) setPendingRelease(null);
        }}
      >
        {pendingRelease ? (
          <div className="release-confirm">
            <p>
              <strong>{pendingRelease.title}</strong>
            </p>
            <p className="hint">
              {pendingRelease.tracker || "—"} · {formatBytes(pendingRelease.size_bytes)} ·{" "}
              {pendingRelease.quality || "—"} · {pendingRelease.voiceover || "—"}
            </p>
            <p>
              {pendingRelease.file_paths && pendingRelease.file_paths.length > 0
                ? `Заявлено файлов: ${pendingRelease.file_paths.length}. Пока сервер не фильтрует выбор — будет загружен весь торрент.`
                : "Будет загружен весь торрент."}
            </p>
            {createError ? (
              <p className="release-feedback release-feedback-error" role="alert">
                {createError}
              </p>
            ) : null}
            <div className="release-confirm-actions">
              <Button variant="primary" disabled={creating} onClick={confirmCreate}>
                {creating ? "Создание…" : "Создать задачу"}
              </Button>
              <Button
                variant="ghost"
                disabled={creating}
                onClick={() => setPendingRelease(null)}
              >
                Отмена
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
