/**
 * Media lookup hook: resolve media id + season/episode for a task file id
 * via the library, with TheIntroDB context as fallback. `findLibraryFileForEpisode`
 * is shared with the episode picker.
 */

import { useEffect, useState } from "react";
import { fetchLibrary } from "../../api/endpoints";
import type { ApiId } from "../../api/types";

/** Fallback media context (TheIntroDB) when the library lookup misses. */
export type MediaLookupFallback = {
  mediaId: ApiId;
  season: number | null;
  episode: number | null;
};

export type MediaLookupStatus = "pending" | "found" | "missing";

export type MediaLookupState = {
  mediaId: ApiId | null;
  /** Season/episode for the playback API (`?season=&episode=`). */
  episodeCtx: { season: number | null; episode: number | null };
  status: MediaLookupStatus;
  /** Override season/episode (same-file episode switch). */
  setEpisodeCtx: (ctx: {
    season: number | null;
    episode: number | null;
  }) => void;
};

/** Resolve media id + season/episode for a task file id via the library. */
export async function resolveFileMedia(
  fileId: string,
): Promise<{
  mediaId: ApiId;
  season: number | null;
  episode: number | null;
  hasPrimaryVideo: boolean;
} | null> {
  const items = await fetchLibrary();
  for (const item of items) {
    for (const file of item.files) {
      if (String(file.id) === String(fileId)) {
        return {
          mediaId: item.media_item.id,
          season: file.season ?? null,
          episode: file.episode ?? null,
          // Library rows with a prepared file count as having primary video.
          hasPrimaryVideo: true,
        };
      }
    }
  }
  return null;
}

/**
 * Find a library file id for a media episode (S/E match).
 * Used when the episode picker was built from `GET /api/media/{id}/episodes`
 * and the picker id is an episode id, not a task_file_id.
 */
export async function findLibraryFileForEpisode(
  mediaId: ApiId,
  season: number | null | undefined,
  episode: number | null | undefined,
): Promise<string | null> {
  const items = await fetchLibrary();
  const mediaKey = String(mediaId);
  for (const item of items) {
    if (String(item.media_item.id) !== mediaKey) continue;
    for (const file of item.files) {
      const s = file.season ?? null;
      const e = file.episode ?? null;
      if (season != null && s != null && Number(s) !== Number(season)) continue;
      if (episode != null && e != null && Number(e) !== Number(episode)) continue;
      return String(file.id);
    }
  }
  return null;
}

/**
 * Resolve media id + season/episode for `fileId`. TheIntroDB context may
 * already have the media id; always resolve season/episode from the library
 * file row. Resolution order: library row → fallback context → missing.
 */
export function useMediaLookup(
  fileId: string,
  fallback: MediaLookupFallback | null,
): MediaLookupState {
  const [mediaId, setMediaId] = useState<ApiId | null>(null);
  /** Media id lookup gate — avoid error flashes while resolution is in flight. */
  const [mediaResolve, setMediaResolve] = useState<MediaLookupStatus>("pending");
  const [episodeCtx, setEpisodeCtx] = useState<{
    season: number | null;
    episode: number | null;
  }>({ season: null, episode: null });

  // Resolve media id + season/episode. TheIntroDB context may already have
  // the media id; always resolve season/episode from the library file row.
  useEffect(() => {
    let cancelled = false;
    setMediaId(null);
    setMediaResolve("pending");
    void (async () => {
      try {
        const ctx = await resolveFileMedia(fileId);
        if (cancelled) return;
        if (ctx) {
          setMediaId(ctx.mediaId);
          setEpisodeCtx({ season: ctx.season, episode: ctx.episode });
          setMediaResolve("found");
        } else if (fallback?.mediaId != null) {
          setMediaId(fallback.mediaId);
          setEpisodeCtx({
            season: fallback.season,
            episode: fallback.episode,
          });
          setMediaResolve("found");
        } else {
          setMediaResolve("missing");
        }
      } catch {
        if (cancelled) return;
        if (fallback?.mediaId != null) {
          setMediaId(fallback.mediaId);
          setMediaResolve("found");
        } else {
          setMediaResolve("missing");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId, fallback?.mediaId, fallback?.season, fallback?.episode]);

  return { mediaId, episodeCtx, status: mediaResolve, setEpisodeCtx };
}
