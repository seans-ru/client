/**
 * Library list UI (M6). Russian UI strings.
 *
 * Grid of media cards (poster, title, year, status/ready, total size) with
 * expandable file rows. Ready files offer «Смотреть» (`#/player/{fileId}`)
 * and «Создать комнату» (POST /api/rooms → `#/room/{code}`).
 */

import { useState } from "react";
import { createRoom } from "../../api/endpoints";
import type { ApiId, LibraryFile, LibraryItem } from "../../api/types";
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
import {
  fileBaseName,
  filterReadyFiles,
  formatEpisodeLabel,
  formatLibraryStatus,
  canOfferPlay,
  isFileReady,
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

function LibraryItemCard({
  item,
  creatingRoomId,
  roomErrorFileId,
  roomError,
  onCreateRoom,
}: {
  item: LibraryItem;
  creatingRoomId: ApiId | null;
  roomErrorFileId: ApiId | null;
  roomError: string | null;
  onCreateRoom: (fileId: ApiId) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { media_item: media, library_item: entry, files, total_size, ready } = item;
  const readyCount = filterReadyFiles(files).length;

  return (
    <article className="library-item">
      <header className="library-item-header">
        <div className="library-item-poster">
          <PosterCard
            title={media.title}
            posterUrl={media.poster_url}
            subtitle={media.year > 0 ? String(media.year) : undefined}
          />
        </div>
        <div className="library-item-info">
          <h2 className="library-item-title" title={media.title}>
            {media.title}
          </h2>
          <p className="library-item-meta">
            {media.year > 0 ? <span>{media.year}</span> : null}
            {media.year > 0 ? <span aria-hidden="true"> · </span> : null}
            <span>{formatBytes(total_size)}</span>
          </p>
          <div className="library-item-badges">
            <Badge tone={ready ? "accent" : "neutral"}>
              {ready ? "Готово" : formatLibraryStatus(entry.status)}
            </Badge>
            <Badge>{`${files.length} файл(ов)`}</Badge>
          </div>
          <div className="library-item-actions">
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
          </div>
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
  loading,
  error,
  onRetry,
}: {
  items: LibraryItem[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  const [creatingRoomId, setCreatingRoomId] = useState<ApiId | null>(null);
  const [roomErrorFileId, setRoomErrorFileId] = useState<ApiId | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);

  const handleCreateRoom = (fileId: ApiId) => {
    setCreatingRoomId(fileId);
    setRoomErrorFileId(null);
    setRoomError(null);
    void (async () => {
      try {
        const room = await createRoom(fileId);
        // Host fallback when GET /api/rooms/{code} omits task_file_id.
        try {
          sessionStorage.setItem(`seans.room.file.${room.code}`, String(fileId));
        } catch {
          // ignore
        }
        navigate(ROUTES.room(room.code));
      } catch (cause) {
        setRoomErrorFileId(fileId);
        setRoomError(
          cause instanceof Error
            ? cause.message
            : "Не удалось создать комнату",
        );
      } finally {
        setCreatingRoomId(null);
      }
    })();
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
          creatingRoomId={creatingRoomId}
          roomErrorFileId={roomErrorFileId}
          roomError={roomError}
          onCreateRoom={handleCreateRoom}
        />
      ))}
    </div>
  );
}
