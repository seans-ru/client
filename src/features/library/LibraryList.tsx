/**
 * Library hub list (ui-ux-redesign). Russian UI strings.
 *
 * Cards show derived watch state and the hub actions: continue, next episode,
 * create room, re-download voiceover/quality (opens releases), delete, and
 * active download task status (replaces the old Tasks screen).
 */

import { useState } from "react";
import { createRoom, deleteLibraryItem } from "../../api/endpoints";
import type {
  ApiId,
  HistoryResponse,
  LibraryFile,
  LibraryItem,
  TaskDetailResponse,
} from "../../api/types";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  PosterCard,
  Spinner,
} from "../../design/primitives";
import { formatBytes } from "../../lib/format";
import { ROUTES } from "../../lib/routeResolver";
import { openPlayer } from "../player/playerNav";
import {
  fileBaseName,
  filterReadyFiles,
  formatEpisodeLabel,
  formatLibraryStatus,
  formatWatchState,
  canOfferPlay,
  isFileReady,
  continueFileForItem,
  nextEpisodeFile,
  resumePositionForFile,
  watchStateForItem,
} from "./libraryHelpers";

function navigate(hash: string): void {
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
}

function LibraryFileRow({
  file,
  creatingRoom,
  roomError,
  onCreateRoom,
}: {
  file: LibraryFile;
  creatingRoom: boolean;
  roomError: string | null;
  onCreateRoom: (fileId: ApiId) => void;
}) {
  const ready = isFileReady(file);
  const episode = formatEpisodeLabel(file.season, file.episode);
  const offerPlay = canOfferPlay(file);
  return (
    <li className="library-file">
      <div className="library-file-main">
        <div className="library-file-title" title={file.path}>
          {episode ? <span className="library-file-episode">{episode}</span> : null}
          <span className="library-file-name">{fileBaseName(file.path)}</span>
        </div>
        <div className="library-file-meta">
          <Badge tone={ready ? "accent" : "neutral"}>
            {formatLibraryStatus(file.status)}
          </Badge>
          <span>{formatBytes(file.size_bytes)}</span>
        </div>
      </div>
      {offerPlay ? (
        <div className="library-file-actions">
          {ready ? (
            <a className="btn btn-primary btn-sm" href={ROUTES.player(file.id)}>
              Смотреть
            </a>
          ) : (
            <a
              className="btn btn-primary btn-sm"
              href={ROUTES.player(file.id)}
              title="Можно смотреть уже сейчас — до конца файла"
            >
              Смотреть · загружается
            </a>
          )}
          {ready ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={creatingRoom}
              onClick={() => onCreateRoom(file.id)}
            >
              {creatingRoom ? "Создание…" : "Создать комнату"}
            </Button>
          ) : (
            <Button variant="secondary" size="sm" disabled title="Комната после полной загрузки">
              Создать комнату
            </Button>
          )}
        </div>
      ) : null}
      {roomError ? (
        <p className="task-error" role="alert">
          {roomError}
        </p>
      ) : null}
    </li>
  );
}

function ActiveTaskChip({
  task,
  onCancel,
}: {
  task: TaskDetailResponse;
  onCancel: (taskId: ApiId) => void;
}) {
  return (
    <div className="library-task">
      <Badge tone="neutral">{task.stage || task.status}</Badge>
      <span className="hint">
        {Math.round(task.progress_pct)}% · {formatBytes(task.speed_bps)}/s
      </span>
      <Button variant="ghost" size="sm" onClick={() => onCancel(task.id)}>
        Отменить
      </Button>
    </div>
  );
}

function LibraryItemCard({
  item,
  history,
  task,
  creatingRoomId,
  roomErrorFileId,
  roomError,
  deleteError,
  onCreateRoom,
  onDelete,
  deleting,
  onCancelTask,
}: {
  item: LibraryItem;
  history: readonly HistoryResponse[];
  task: TaskDetailResponse | null;
  creatingRoomId: ApiId | null;
  roomErrorFileId: ApiId | null;
  roomError: string | null;
  deleteError: string | null;
  onCreateRoom: (fileId: ApiId) => void;
  onDelete: (libraryItemId: ApiId) => void;
  deleting: boolean;
  onCancelTask: (taskId: ApiId) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { media_item: media, library_item: entry, files, total_size, ready } = item;
  const readyCount = filterReadyFiles(files).length;
  const watchState = watchStateForItem(item, history);
  const continueFile = continueFileForItem(item, history);
  const nextFile = nextEpisodeFile(item, history);
  const resumeAt = continueFile
    ? resumePositionForFile(continueFile, history)
    : null;

  return (
    <article className="library-item">
      <header className="library-item-header">
        <div className="library-item-poster">
          <PosterCard
            title={media.title}
            posterUrl={media.poster_url}
            subtitle={media.year != null && media.year > 0 ? String(media.year) : undefined}
          />
        </div>
        <div className="library-item-info">
          <h2 className="library-item-title" title={media.title}>
            {media.title}
          </h2>
          <p className="library-item-meta">
            {media.year != null && media.year > 0 ? <span>{media.year}</span> : null}
            {media.year != null && media.year > 0 ? <span aria-hidden="true"> · </span> : null}
            <span>{formatBytes(total_size)}</span>
          </p>
          <div className="library-item-badges">
            <Badge tone="accent">{formatWatchState(watchState)}</Badge>
            <Badge tone={ready ? "accent" : "neutral"}>
              {ready ? "Готово" : formatLibraryStatus(entry.status)}
            </Badge>
            <Badge>{`${files.length} файл(ов)`}</Badge>
          </div>

          <div className="library-item-actions">
            {continueFile ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() =>
                  openPlayer(continueFile.id, { startAt: resumeAt })
                }
              >
                {resumeAt != null ? "Продолжить просмотр" : "Смотреть"}
              </Button>
            ) : null}
            {nextFile ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openPlayer(nextFile.id, { startAt: null })}
              >
                К следующей серии
              </Button>
            ) : null}
            <a
              className="btn btn-ghost btn-sm"
              href={ROUTES.media(media.id)}
              title="Другая озвучка или качество — через список релизов"
            >
              Скачать другую озвучку
            </a>
            <a
              className="btn btn-ghost btn-sm"
              href={ROUTES.media(media.id)}
              title="Выбрать другой релит / качество"
            >
              Скачать другое качество
            </a>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded
                ? "Скрыть файлы"
                : `Файлы (${readyCount}/${files.length})`}
            </Button>
            {confirmDelete ? (
              <span className="library-delete-confirm">
                <Button
                  variant="danger"
                  size="sm"
                  disabled={deleting}
                  onClick={() => {
                    setConfirmDelete(false);
                    onDelete(entry.id);
                  }}
                >
                  {deleting ? "Удаление…" : "Точно удалить"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  Отмена
                </Button>
              </span>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
                Удалить
              </Button>
            )}
          </div>

          {task ? <ActiveTaskChip task={task} onCancel={onCancelTask} /> : null}
          {deleteError ? (
            <p className="library-card-error" role="alert">
              {deleteError}
            </p>
          ) : null}
        </div>
      </header>

      {expanded ? (
        files.length === 0 ? (
          <p className="hint">Файлы пока не подготовлены.</p>
        ) : (
          <ul className="library-files">
            {files.map((file) => (
              <LibraryFileRow
                key={String(file.id)}
                file={file}
                creatingRoom={
                  creatingRoomId != null &&
                  String(creatingRoomId) === String(file.id)
                }
                roomError={
                  roomErrorFileId != null &&
                  String(roomErrorFileId) === String(file.id)
                    ? roomError
                    : null
                }
                onCreateRoom={onCreateRoom}
              />
            ))}
          </ul>
        )
      ) : null}
    </article>
  );
}

export function LibraryList({
  items,
  history = [],
  tasks = [],
  loading,
  error,
  onRetry,
  onCancelTask,
}: {
  items: LibraryItem[];
  history?: readonly HistoryResponse[];
  tasks?: readonly TaskDetailResponse[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  onCancelTask?: (taskId: ApiId) => void;
}) {
  const [creatingRoomId, setCreatingRoomId] = useState<ApiId | null>(null);
  const [roomErrorFileId, setRoomErrorFileId] = useState<ApiId | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<ApiId | null>(null);
  const [deleteErrorId, setDeleteErrorId] = useState<ApiId | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleCreateRoom = (fileId: ApiId) => {
    setCreatingRoomId(fileId);
    setRoomErrorFileId(null);
    setRoomError(null);
    void (async () => {
      try {
        const room = await createRoom(fileId);
        try {
          sessionStorage.setItem(`seans.room.file.${room.code}`, String(fileId));
        } catch {
          // ignore
        }
        navigate(ROUTES.room(room.code));
      } catch (cause) {
        setRoomErrorFileId(fileId);
        setRoomError(
          cause instanceof Error ? cause.message : "Не удалось создать комнату",
        );
      } finally {
        setCreatingRoomId(null);
      }
    })();
  };

  const handleDelete = (libraryItemId: ApiId) => {
    setDeletingId(libraryItemId);
    setDeleteErrorId(null);
    setDeleteError(null);
    void (async () => {
      try {
        await deleteLibraryItem(libraryItemId, { deleteFiles: false });
        // Parent list refresh is owned by LibraryScreen after a successful delete.
        onRetry?.();
      } catch (cause) {
        setDeleteErrorId(libraryItemId);
        setDeleteError(
          cause instanceof Error ? cause.message : "Не удалось удалить",
        );
      } finally {
        setDeletingId(null);
      }
    })();
  };

  /**
   * Join tasks to library cards via optional `media_id` / `task_file_id`
   * (present when the API exposes them). Typed `TaskResponse` alone cannot
   * link a task to media — those chips only render when the join fields exist.
   */
  const taskForItem = (item: LibraryItem): TaskDetailResponse | null => {
    const mediaKey = String(item.media_item.id);
    const fileKeys = new Set(item.files.map((f) => String(f.id)));
    for (const task of tasks) {
      const bag = task as unknown as Record<string, unknown>;
      const taskMedia = bag.media_id ?? bag.media_item_id ?? bag.mediaId;
      const taskFile =
        bag.task_file_id ?? bag.file_id ?? bag.taskFileId ?? bag.fileId;
      if (taskMedia != null && String(taskMedia) === mediaKey) return task;
      if (taskFile != null && fileKeys.has(String(taskFile))) return task;
    }
    return null;
  };

  if (loading) {
    return <Spinner label="Загрузка библиотеки…" />;
  }
  if (error) {
    return (
      <ErrorState
        title="Не удалось загрузить библиотеку"
        description={error}
        onRetry={onRetry}
      />
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        title="Библиотека пуста"
        description="Добавьте фильмы в библиотеку, чтобы они появились здесь."
      />
    );
  }

  return (
    <div className="library-list">
      {items.map((item) => (
        <LibraryItemCard
          key={String(item.library_item.id)}
          item={item}
          history={history}
          task={taskForItem(item)}
          creatingRoomId={creatingRoomId}
          roomErrorFileId={roomErrorFileId}
          roomError={roomError}
          onCreateRoom={handleCreateRoom}
          deleteError={
            deleteErrorId != null &&
            String(deleteErrorId) === String(item.library_item.id)
              ? deleteError
              : null
          }
          onDelete={handleDelete}
          deleting={
            deletingId != null &&
            String(deletingId) === String(item.library_item.id)
          }
          onCancelTask={(taskId) => onCancelTask?.(taskId)}
        />
      ))}
    </div>
  );
}
