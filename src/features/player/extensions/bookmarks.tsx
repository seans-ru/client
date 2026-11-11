/**
 * Bookmarks extension (issue #21, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * One-tap bookmarks with notes at timecodes, for re-watching / study /
 * discussion:
 *
 * - «Закладка» in `controls.primary` — instant bookmark at the playhead;
 *   the note is edited afterwards from the menu or the sidecar list.
 * - Lists in `settings.menu` («Закладки») and `sidecar`: jump / edit note /
 *   delete / sort by timecode or creation date / export the file's list to
 *   JSON (clipboard + download).
 * - Seek-rail markers in the shared `SegmentMarker` format (same track as
 *   chapters #19 and TheIntroDB segments).
 * - Persistence: `localStorage` per media (`seans.player.ext.bookmarks.*`,
 *   convention from the issue), soft limit 100/file with a warning.
 */

import { useState, useSyncExternalStore, type ReactElement } from "react";
import { formatTime } from "../playerHelpers";
import type {
  ExtensionStorage,
  PlayerExtension,
  Unsubscribe,
} from "./types";
import { currentMediaKey } from "./fileKey";
import { markerTrack } from "./markerTrack";
import {
  addBookmark,
  bookmarkMarkers,
  bookmarksExport,
  parseBookmarks,
  removeBookmark,
  sortBookmarks,
  updateBookmarkNote,
  BOOKMARK_SOFT_LIMIT,
  type Bookmark,
  type BookmarkSort,
} from "./bookmarksPolicy";
import "./bookmarks.css";
import "./markers.css";

const SORT_KEY = "sort";
const MARKER_SOURCE = "bookmarks";
const MESSAGE_TTL_MS = 4000;

type BookmarksState = {
  mediaKey: string;
  list: Bookmark[];
  sort: BookmarkSort;
  message: string | null;
};

type BookmarksStore = {
  subscribe(cb: () => void): Unsubscribe;
  get(): BookmarksState;
  /** Bind the transport seek (called once from `setup`). */
  bindSeek(seek: (seconds: number) => void): void;
  /** Point the store at a file (loads/persists under `file.<mediaKey>`). */
  openFile(mediaKey: string): void;
  addQuick(positionSec: number): void;
  jump(id: string): void;
  remove(id: string): void;
  setNote(id: string, note: string): void;
  setSort(sort: BookmarkSort): void;
  exportJson(): void;
  close(): void;
};

function createBookmarksStore(storage: ExtensionStorage): BookmarksStore {
  let state: BookmarksState = {
    mediaKey: "unknown",
    list: [],
    sort: storage.get<unknown>(SORT_KEY, "time") === "created" ? "created" : "time",
    message: null,
  };
  const listeners = new Set<() => void>();
  let messageTimer: ReturnType<typeof setTimeout> | null = null;
  let seek: (seconds: number) => void = () => {};

  const storageKey = (mediaKey: string) => `file.${mediaKey}`;

  const set = (patch: Partial<BookmarksState>): void => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const persist = (): void => {
    try {
      storage.set(storageKey(state.mediaKey), state.list);
    } catch {
      // Quota — session-only bookmarks survive until close.
    }
  };

  const flash = (message: string): void => {
    if (messageTimer) clearTimeout(messageTimer);
    set({ message });
    messageTimer = setTimeout(() => set({ message: null }), MESSAGE_TTL_MS);
  };

  const publishMarkers = (): void => {
    markerTrack.setMarkers(
      MARKER_SOURCE,
      bookmarkMarkers(state.list, (bookmark) => {
        seek(bookmark.positionSec);
      }),
    );
  };

  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get: () => state,
    bindSeek(next) {
      seek = next;
    },
    openFile(mediaKey) {
      if (state.mediaKey === mediaKey) return;
      persist();
      const list = parseBookmarks(storage.get(storageKey(mediaKey), []));
      set({ mediaKey, list, message: null });
      publishMarkers();
    },
    addQuick(positionSec) {
      const result = addBookmark(state.list, { positionSec });
      set({ list: result.list });
      persist();
      publishMarkers();
      flash(
        result.limitReached
          ? `Закладка добавлена · достигнут мягкий лимит ${BOOKMARK_SOFT_LIMIT} на файл`
          : `Закладка ${formatTime(result.added.positionSec)}`,
      );
    },
    jump(id) {
      const bookmark = state.list.find((b) => b.id === id);
      if (bookmark) seek(bookmark.positionSec);
    },
    remove(id) {
      set({ list: removeBookmark(state.list, id) });
      persist();
      publishMarkers();
    },
    setNote(id, note) {
      set({ list: updateBookmarkNote(state.list, id, note) });
      persist();
      publishMarkers();
    },
    setSort(sort) {
      storage.set(SORT_KEY, sort);
      set({ sort, list: sortBookmarks(state.list, sort) });
    },
    exportJson() {
      const payload = bookmarksExport(state.mediaKey, state.list);
      const text = JSON.stringify(payload, null, 2);
      let copied = false;
      try {
        void navigator.clipboard?.writeText(text);
        copied = true;
      } catch {
        copied = false;
      }
      try {
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `seans-bookmarks-${state.mediaKey}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch {
        // Download may be blocked in the webview — clipboard still works.
      }
      flash(copied ? "JSON скопирован в буфер обмена" : "JSON выгружен файлом");
    },
    close() {
      persist();
      markerTrack.clearSource(MARKER_SOURCE);
    },
  };
}

/* -------------------------------------------------------------------- list */

function BookmarkRow({
  bookmark,
  store,
}: {
  bookmark: Bookmark;
  store: BookmarksStore;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(bookmark.note);
  return (
    <li className="player-bookmark-row">
      {editing ? (
        <input
          className="player-bookmark-note-input"
          value={draft}
          autoFocus
          placeholder="Заметка…"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            store.setNote(bookmark.id, draft);
            setEditing(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              store.setNote(bookmark.id, draft);
              setEditing(false);
            }
            if (event.key === "Escape") {
              setDraft(bookmark.note);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="player-bookmark-jump"
          onClick={() => store.jump(bookmark.id)}
          title="Перейти к закладке"
        >
          <span className="player-bookmark-time">
            {formatTime(bookmark.positionSec)}
          </span>
          <span className="player-bookmark-note">{bookmark.note || "—"}</span>
        </button>
      )}
      <button
        type="button"
        className="player-bookmark-action"
        title="Изменить заметку"
        onClick={() => {
          setDraft(bookmark.note);
          setEditing(true);
        }}
      >
        ✎
      </button>
      <button
        type="button"
        className="player-bookmark-action"
        title="Удалить закладку"
        onClick={() => store.remove(bookmark.id)}
      >
        ×
      </button>
    </li>
  );
}

function BookmarkList({ store }: { store: BookmarksStore }): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (state.list.length === 0) {
    return <p className="player-menu-empty">Пока пусто.</p>;
  }
  return (
    <ul className="player-bookmark-list">
      {state.list.map((bookmark) => (
        <BookmarkRow key={bookmark.id} bookmark={bookmark} store={store} />
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------------- panels */

function BookmarksMenuRow({ store }: { store: BookmarksStore }): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  return (
    <section>
      <h4 className="player-menu-title">Закладки</h4>
      <div className="player-menu-row" role="group" aria-label="Сортировка закладок">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={state.sort === "time"}
          className={`player-chip${state.sort === "time" ? " player-chip-active" : ""}`}
          onClick={() => store.setSort("time")}
        >
          По таймкоду
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={state.sort === "created"}
          className={`player-chip${state.sort === "created" ? " player-chip-active" : ""}`}
          onClick={() => store.setSort("created")}
        >
          По дате
        </button>
      </div>
      <BookmarkList store={store} />
      <div className="player-menu-row">
        <button
          type="button"
          role="menuitem"
          className="player-chip"
          onClick={() => store.exportJson()}
          disabled={state.list.length === 0}
          title="Скопировать закладки файла в JSON"
        >
          Экспорт JSON
        </button>
      </div>
      {state.message ? (
        <p className="player-bookmark-message" role="status">
          {state.message}
        </p>
      ) : null}
      {state.list.length >= BOOKMARK_SOFT_LIMIT ? (
        <p className="player-bookmark-warning">
          Мягкий лимит — {BOOKMARK_SOFT_LIMIT} закладок на файл.
        </p>
      ) : null}
    </section>
  );
}

function BookmarkQuickButton({
  position,
  store,
}: {
  position: () => number;
  store: BookmarksStore;
}): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  return (
    <button
      type="button"
      className="player-icon-btn player-bookmark-quick"
      title="Добавить закладку на текущем таймкоде"
      aria-label="Закладка"
      onClick={() => store.addQuick(position())}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path
          d="M5 2.5h8a1 1 0 0 1 1 1V16l-5-3-5 3V3.5a1 1 0 0 1 1-1z"
          fill="currentColor"
        />
      </svg>
      {state.message ? (
        <span className="player-bookmark-quick-flash" role="status">
          ✓
        </span>
      ) : null}
    </button>
  );
}

/* -------------------------------------------------------------- extension */

export const bookmarks: PlayerExtension = {
  id: "bookmarks",
  name: "Закладки",
  setup(ctx): Unsubscribe {
    const store = createBookmarksStore(ctx.storage);
    store.bindSeek((seconds) => void ctx.transport.seek(seconds));
    store.openFile(currentMediaKey(ctx.getSnapshot().url));

    const stopOpen = ctx.onOpen((info) => {
      store.openFile(currentMediaKey(info.url));
    });
    const stopClose = ctx.onClose(() => store.close());
    const stopQuick = ctx.ui.add("controls.primary", () => (
      <BookmarkQuickButton
        position={() => ctx.getSnapshot().position}
        store={store}
      />
    ));
    const stopMenu = ctx.ui.add("settings.menu", () => (
      <BookmarksMenuRow store={store} />
    ));
    const stopSidecar = ctx.ui.add("sidecar", () => (
      <section>
        <h4 className="player-menu-title">Закладки</h4>
        <BookmarkList store={store} />
      </section>
    ));

    return () => {
      stopSidecar();
      stopMenu();
      stopQuick();
      stopClose();
      stopOpen();
      store.close();
    };
  },
};
