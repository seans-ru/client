/**
 * Chapters extension (issue #19, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * Real file chapters from mpv (`chapter-list`) on the seek rail and in the
 * player settings menu («Главы»), in the shared `SegmentMarker` format —
 * together with TheIntroDB segments (core) and bookmark markers (#21) they
 * form one marker track. Click a marker or a chapter row to seek. Files
 * without chapters keep the rail empty (no placeholder junk).
 *
 * The extension bridge only returns scalar property strings, so chapters are
 * read either as a JSON dump of `chapter-list` or through mpv's indexed
 * sub-properties (`chapter-list/count`, `chapter-list/{i}/title|time`) —
 * see chaptersPolicy.ts for the pure parsers.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import { formatTime } from "../playerHelpers";
import type {
  MpvBridge,
  PlayerExtension,
  PlayerExtensionContext,
  Unsubscribe,
} from "./types";
import { markerTrack } from "./markerTrack";
import {
  chapterLabel,
  chapterMarkers,
  normalizeChapters,
  parseChapterListJson,
  parseMpvTime,
  MAX_CHAPTERS,
  type ChapterEntry,
} from "./chaptersPolicy";
import "./markers.css";

const MARKER_SOURCE = "chapters";

/**
 * Read the chapter list from mpv. Tries the JSON form first (one call), then
 * falls back to indexed sub-properties. Rejects only when every path errors
 * (file not loaded yet) — an empty list is a valid «no chapters» answer.
 */
export async function fetchChapters(mpv: MpvBridge): Promise<ChapterEntry[]> {
  const fromJson = parseChapterListJson(
    await mpv.getProperty("chapter-list").catch(() => null),
  );
  if (fromJson && fromJson.length > 0) return normalizeChapters(fromJson);

  const countRaw = await mpv.getProperty("chapter-list/count");
  const count = Math.min(MAX_CHAPTERS, Math.max(0, Math.floor(Number(countRaw))));
  if (!Number.isFinite(count) || count <= 0) return fromJson ? normalizeChapters(fromJson) : [];

  const entries: ChapterEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const [titleRaw, timeRaw] = await Promise.all([
      mpv.getProperty(`chapter-list/${i}/title`).catch(() => ""),
      mpv.getProperty(`chapter-list/${i}/time`).catch(() => null),
    ]);
    const timeSec = parseMpvTime(timeRaw);
    if (timeSec == null) continue;
    entries.push({
      index: i,
      title: typeof titleRaw === "string" ? titleRaw : "",
      timeSec,
    });
  }
  return normalizeChapters(entries);
}

type ChapterStore = {
  subscribe(cb: () => void): Unsubscribe;
  get(): readonly ChapterEntry[];
  set(list: readonly ChapterEntry[]): void;
};

function createStore(): ChapterStore {
  let list: readonly ChapterEntry[] = [];
  const listeners = new Set<() => void>();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get: () => list,
    set(next) {
      list = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function ChaptersRow({
  ctx,
  store,
}: {
  ctx: PlayerExtensionContext;
  store: ChapterStore;
}): ReactElement | null {
  const chapters = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (chapters.length === 0) return null;
  return (
    <section>
      <h4 className="player-menu-title">Главы</h4>
      <div className="player-menu-list">
        {chapters.map((entry) => (
          <button
            key={`${entry.index}-${entry.timeSec}`}
            type="button"
            role="menuitem"
            className="player-menu-item"
            onClick={() => void ctx.transport.seek(entry.timeSec)}
            title={`Перейти к ${formatTime(entry.timeSec)}`}
          >
            <span className="player-menu-item-label">{chapterLabel(entry)}</span>
            <span className="player-menu-item-meta">
              {formatTime(entry.timeSec)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

export const chapters: PlayerExtension = {
  id: "chapters",
  name: "Главы",
  setup(ctx): Unsubscribe {
    const store = createStore();
    let disposed = false;
    let loadedForKey: string | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const publish = (list: readonly ChapterEntry[]): void => {
      store.set(list);
      markerTrack.setMarkers(
        MARKER_SOURCE,
        chapterMarkers(list, (entry) => {
          void ctx.transport.seek(entry.timeSec);
        }),
      );
    };

    const load = async (attempt: number): Promise<void> => {
      if (disposed) return;
      try {
        const list = await fetchChapters(ctx.mpv);
        if (disposed) return;
        publish(list);
      } catch {
        // Property unavailable (file not loaded yet) — retry a few times.
        if (disposed || attempt >= 3) return;
        retryTimer = setTimeout(() => {
          void load(attempt + 1);
        }, 700 * (attempt + 1));
      }
    };

    const maybeLoad = (): void => {
      if (disposed) return;
      const snapshot = ctx.getSnapshot();
      if (!snapshot.file_loaded) return;
      const key = snapshot.url || "current";
      if (loadedForKey === key) return;
      loadedForKey = key;
      void load(1);
    };

    const stopSnap = ctx.onSnapshot(() => maybeLoad());
    const stopOpen = ctx.onOpen(() => {
      loadedForKey = null;
      publish([]);
      maybeLoad();
    });
    const stopClose = ctx.onClose(() => {
      loadedForKey = null;
      publish([]);
    });
    const stopRow = ctx.ui.add("settings.menu", () => (
      <ChaptersRow ctx={ctx} store={store} />
    ));

    // A file may already be playing when the extension mounts.
    maybeLoad();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      markerTrack.clearSource(MARKER_SOURCE);
      stopRow();
      stopClose();
      stopOpen();
      stopSnap();
    };
  },
};
