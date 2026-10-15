/**
 * Playback poller (progressive + VOD). Fetches `GET /api/media/{id}/playback`
 * every 5–10 s while the file is incomplete, exposes seek limits, dual
 * progress, audio tracks, and series catalog. No DOM / mpv — pure state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchPlayback } from "../../api/endpoints";
import type {
  PlaybackAudioTrack,
  PlaybackEpisode,
  PlaybackResponse,
  PlaybackSubtitleTrack,
} from "../../api/playback";
import type { ApiId } from "../../api/types";
import {
  audioPrefKey,
  formatPlaybackAudioLabel,
  loadAudioPreference,
  resolvePreferredAudioTrack,
  saveAudioPreference,
} from "./audioTrackHelpers";
import {
  catalogEpisodes,
  catalogSeasonGroups,
  findEpisodeById,
  isEpisodePlayable,
  isSeriesCatalog,
} from "./episodeHelpers";
import {
  resolveDownloadProgress,
  resolvePlaybackMode,
  seekLimitFromPlayback,
  type DownloadProgress,
  type PlaybackMode,
  type SeekLimit,
} from "./progressiveHelpers";

/** Poll cadence while `stream.complete` is false (contract: 5–10 s). */
export const PLAYBACK_POLL_MS = 7000;

export type PlaybackAudioOption = {
  track: PlaybackAudioTrack;
  label: string;
  embedded: boolean;
};

export type UsePlaybackState = {
  status: "loading" | "ready" | "error";
  error: string | null;
  playback: PlaybackResponse | null;
  mode: PlaybackMode;
  limit: SeekLimit;
  progress: DownloadProgress;
  audioOptions: PlaybackAudioOption[];
  selectedAudio: PlaybackAudioTrack | null;
  selectedAudioId: string | null;
  subtitleTracks: PlaybackSubtitleTrack[];
  episodes: PlaybackEpisode[];
  seasonGroups: ReturnType<typeof catalogSeasonGroups>;
  currentEpisode: PlaybackEpisode | null;
  isSeries: boolean;
  /** False when the current unit has no primary video yet. */
  canPlay: boolean;
  /** Set audio track id and persist it on the media item / episode. */
  selectAudio: (trackId: string | number) => void;
  /** Force a playback refetch (retry / after episode change). */
  reload: () => void;
};

/**
 * Load + poll playback for a media item (optionally a specific series episode).
 *
 * The seans API selects the episode with `?season=&episode=` — not by file id.
 * `fileId` is still used for the audio preference key and history.
 */
export function usePlayback(
  mediaId: string | number | null,
  fileId: string | number | null,
  options: {
    enabled?: boolean;
    season?: number | null;
    episode?: number | null;
  } = {},
): UsePlaybackState {
  const enabled = options.enabled !== false && mediaId != null;
  const season = options.season ?? null;
  const episode = options.episode ?? null;
  const [playback, setPlayback] = useState<PlaybackResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);
  const playbackRef = useRef<PlaybackResponse | null>(null);
  playbackRef.current = playback;

  const mediaKey = mediaId == null ? "" : String(mediaId);
  const fileKey = fileId == null ? "" : String(fileId);

  // Load saved preference when the playable unit changes.
  useEffect(() => {
    if (!mediaKey || !fileKey) {
      setSelectedAudioId(null);
      return;
    }
    const key = audioPrefKey({
      kind: "episode",
      mediaId: mediaKey,
      fileId: fileKey,
    });
    const saved =
      loadAudioPreference(key) ??
      loadAudioPreference(audioPrefKey({ kind: "movie", mediaId: mediaKey }));
    setSelectedAudioId(saved);
  }, [mediaKey, fileKey]);

  const fetchOnce = useCallback(
    async (signal: AbortSignal) => {
      if (!enabled) return;
      try {
        const next = await fetchPlayback(mediaId as ApiId, {
          season,
          episode,
          signal,
        });
        if (signal.aborted) return;
        setPlayback(next);
        setStatus("ready");
        setError(null);
      } catch (cause) {
        if (signal.aborted) return;
        const message =
          cause instanceof Error && cause.message
            ? cause.message
            : "Не удалось загрузить состояние загрузки";
        // Keep the last good snapshot on transient poll errors.
        if (playbackRef.current) {
          return;
        }
        setError(message);
        setStatus("error");
      }
    },
    [enabled, mediaId, season, episode],
  );

  // Initial load + reload token.
  useEffect(() => {
    if (!enabled) {
      setPlayback(null);
      setStatus("loading");
      return;
    }
    const controller = new AbortController();
    setStatus((s) => (s === "ready" ? s : "loading"));
    void fetchOnce(controller.signal);
    return () => controller.abort();
  }, [enabled, mediaKey, fileKey, season, episode, reloadToken, fetchOnce]);

  // Poll while incomplete (5–10 s cadence). `stream: null` also polls.
  useEffect(() => {
    if (!enabled || !playback) return;
    if (playback.stream?.complete) return;
    let cancelled = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      if (cancelled) return;
      controller?.abort();
      controller = new AbortController();
      void fetchOnce(controller.signal).finally(() => {
        if (cancelled) return;
        timer = setTimeout(tick, PLAYBACK_POLL_MS);
      });
    };

    timer = setTimeout(tick, PLAYBACK_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [enabled, playback, fetchOnce]);

  const mode = useMemo(
    () => resolvePlaybackMode(playback?.stream ?? null),
    [playback],
  );

  const limit = useMemo(
    () =>
      seekLimitFromPlayback(playback?.stream ?? null, playback?.video ?? null),
    [playback],
  );

  const progress = useMemo(
    () => resolveDownloadProgress(playback?.stream ?? null),
    [playback],
  );

  const audioTracks = useMemo(() => {
    const ep = playback
      ? findEpisodeById(playback.catalog, playback.file_id)
      : null;
    return ep?.audio_tracks?.length
      ? ep.audio_tracks
      : (playback?.audio_tracks ?? []);
  }, [playback]);

  const audioOptions = useMemo<PlaybackAudioOption[]>(
    () =>
      audioTracks.map((track) => ({
        track,
        label: formatPlaybackAudioLabel(track),
        embedded: track.embedded !== false,
      })),
    [audioTracks],
  );

  const selectedAudio = useMemo(() => {
    return resolvePreferredAudioTrack(audioTracks, {
      savedId: selectedAudioId,
    });
  }, [audioTracks, selectedAudioId]);

  const selectAudio = useCallback(
    (trackId: string | number) => {
      setSelectedAudioId(String(trackId));
      if (!mediaKey || !fileKey) return;
      // Default product scope: per-episode (movie shares the same key shape).
      saveAudioPreference(
        audioPrefKey({
          kind: "episode",
          mediaId: mediaKey,
          fileId: fileKey,
        }),
        trackId,
      );
      saveAudioPreference(
        audioPrefKey({ kind: "movie", mediaId: mediaKey }),
        trackId,
      );
    },
    [mediaKey, fileKey],
  );

  const episodes = useMemo(
    () => catalogEpisodes(playback?.catalog ?? null),
    [playback],
  );
  const seasonGroups = useMemo(
    () => catalogSeasonGroups(playback?.catalog ?? null),
    [playback],
  );
  const currentEpisode = useMemo(
    () => (playback ? findEpisodeById(playback.catalog, playback.file_id) : null),
    [playback],
  );

  const canPlay = useMemo(() => {
    if (!playback) return false;
    // Catalog episode gate (series picker).
    if (currentEpisode && !isEpisodePlayable(currentEpisode)) return false;
    if (playback.video.primary === false) return false;
    // Complete VOD (also legacy uploaded files with a synthesized stream).
    if (playback.stream?.complete || playback.video.url) return true;
    // Progressive starts as soon as the worker reports stream_ready.
    if (playback.stream?.ready) return true;
    // No stream snapshot: try the final object (legacy VOD); PlayerScreen
    // falls back to fetchFileUrl and only waits if that 404s.
    return playback.stream == null;
  }, [playback, currentEpisode]);

  return {
    status,
    error,
    playback,
    mode,
    limit,
    progress,
    audioOptions,
    selectedAudio,
    selectedAudioId: selectedAudio?.id != null ? String(selectedAudio.id) : null,
    subtitleTracks: playback?.subtitle_tracks ?? [],
    episodes,
    seasonGroups,
    currentEpisode,
    isSeries: isSeriesCatalog(playback?.catalog ?? null),
    canPlay,
    selectAudio,
    reload: () => setReloadToken((t) => t + 1),
  };
}
