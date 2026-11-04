/**
 * Open/reopen orchestration: pick VOD vs progressive vs waiting source,
 * retry, and the complete → seamless VOD switch. Owns `openToken`,
 * `openedMode`, the opened-as-progressive flag, and resume consumption.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchFileUrl } from "../../api/endpoints";
import { ApiError } from "../../api/client";
import type { ApiId } from "../../api/types";
import type { PlaybackResponse } from "../../api/playback";
import { fetchResumePosition } from "../history";
import { isExternalAudioTrack } from "./audioTrackHelpers";
import {
  playerSetMaxSeekable,
  progressiveStart,
  progressiveStop,
} from "./progressiveApi";
import type { PlaybackMode, SeekLimit } from "./progressiveHelpers";
import { consumeStartAt } from "./playerNav";
import type { OpenInfo } from "./extensions/types";
import type { MediaLookupStatus } from "./useMediaLookup";
import type { UsePlayerState } from "./usePlayer";

export type UsePlayerOpenerOptions = {
  player: UsePlayerState;
  fileId: string;
  /** Resume position handed over by navigation (M9). */
  startAt?: number | null;
  /** Room playback (M10): classic presigned VOD URL only. */
  roomMode: boolean;
  mediaId: ApiId | null;
  /** Media id lookup gate from `useMediaLookup`. */
  mediaResolve: MediaLookupStatus;
  playback: PlaybackResponse | null;
  /** `usePlayback.status` — hold gate + legacy fallback branch. */
  playbackStatus: "loading" | "ready" | "error";
  /** `usePlayback.error` — message for the playback-API failure copy. */
  playbackError: string | null;
  canPlay: boolean;
  /** Stream-derived mode from `usePlayback` (complete → VOD switch trigger). */
  mode: PlaybackMode;
  limit: SeekLimit;
  /** Fired after each successful open (extension runtime fan-out, §S2.2). */
  onOpened?: (info: OpenInfo) => void;
};

export type UsePlayerOpenerResult = {
  /**
   * How the file was actually opened. `usePlayback.mode` derives from the
   * stream snapshot which can lag behind reality (complete file with a stale
   * heartbeat); this tracks what we really started.
   */
  openedMode: "vod" | "progressive" | null;
  /** Re-run the open effect (retry button / same-file episode switch). */
  retryOpen: () => void;
  /** Episode switch: stop the progressive source and clear resume state. */
  resetForEpisodeSwitch: () => void;
  /** True while the progressive range source is active (guard sync). */
  openedAsProgressiveRef: { current: boolean };
};

export function usePlayerOpener({
  player,
  fileId,
  startAt,
  roomMode,
  mediaId,
  mediaResolve,
  playback,
  playbackStatus,
  playbackError,
  canPlay,
  mode,
  limit,
  onOpened,
}: UsePlayerOpenerOptions): UsePlayerOpenerResult {
  const [openToken, setOpenToken] = useState(0);
  const lastFileRef = useRef<string | null>(null);
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  /**
   * How the file was actually opened. `usePlayback.mode` derives from the
   * stream snapshot which can lag behind reality (complete file with a stale
   * heartbeat); this tracks what we really started.
   */
  const [openedMode, setOpenedMode] = useState<"vod" | "progressive" | null>(
    null,
  );

  // Consume a resume position once per file id (clean M9 hook).
  const resumeAt = useRef<number | null>(null);
  if (lastFileRef.current !== fileId) {
    lastFileRef.current = fileId;
    resumeAt.current = startAt ?? consumeStartAt();
  }

  const openedAsProgressiveRef = useRef(false);

  const snapshotRef = useRef(player.snapshot);
  snapshotRef.current = player.snapshot;
  const limitRef = useRef(limit);
  limitRef.current = limit;
  const canPlayRef = useRef(canPlay);
  canPlayRef.current = canPlay;

  // complete → seamless VOD switch (keep position, no user scroll).
  useEffect(() => {
    if (roomMode) return;
    if (mode !== "vod" || !playback?.stream?.complete) return;
    if (!openedAsProgressiveRef.current) return;
    openedAsProgressiveRef.current = false;
    void progressiveStop().catch(() => {});
    void playerSetMaxSeekable(null).catch(() => {});
    const position = snapshotRef.current.position;
    setOpenToken((t) => t + 1);
    resumeAt.current = position;
  }, [mode, playback?.stream?.complete, roomMode, player]);

  // Open / reopen the media source (VOD URL or progressive range server).
  const streamReady = playback?.stream?.ready ?? false;
  const streamComplete = playback?.stream?.complete ?? false;
  const hasStream = playback?.stream != null;
  useEffect(() => {
    // Hold while the media id lookup or the playback poll is still in flight.
    // Failing here would flash an error on every entry before playback starts.
    if (!roomMode) {
      if (mediaId == null && mediaResolve === "pending") return;
      if (mediaId != null && playbackStatus === "loading") return;
    }

    setOpenedMode(null);
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const from = resumeAt.current;

        // Room mode still uses the classic presigned VOD URL (hosts share
        // fully prepared files).
        if (roomMode) {
          const [file, historyStart] = await Promise.all([
            fetchFileUrl(fileId, controller.signal),
            from != null
              ? Promise.resolve(null)
              : fetchResumePosition(fileId, controller.signal),
          ]);
          if (cancelled) return;
          await player.start(file.url, {
            startAt: from ?? historyStart,
          });
          setOpenedMode("vod");
          onOpenedRef.current?.({
            url: file.url,
            startAt: from ?? historyStart,
            source: "vod",
          });
          return;
        }

        // Incomplete downloads must NEVER fall back to fetchFileUrl — the
        // final object does not exist yet (library still has status=pending).
        if (mediaId == null) {
          player.fail(
            "Не найден media id для файла — обновите библиотеку и повторите",
          );
          return;
        }

        /** Classic VOD via the final object (`GET /api/files/{id}/url`). */
        const startVod = async (externalAudio: string[], url?: string) => {
          openedAsProgressiveRef.current = false;
          await progressiveStop().catch(() => {});
          const mediaUrl =
            url || (await fetchFileUrl(fileId, controller.signal)).url;
          if (cancelled) return;
          await player.start(mediaUrl, {
            startAt: from,
            externalAudioUrls: externalAudio,
            maxSeekableSec: null,
          });
          setOpenedMode("vod");
          onOpenedRef.current?.({ url: mediaUrl, startAt: from, source: "vod" });
        };

        // Playback API missing / 404 — legacy library rows, or media without
        // MediaEpisode. Fall back to the uploaded final object (VOD).
        if (!playback) {
          if (playbackStatus === "error") {
            try {
              await startVod([]);
              return;
            } catch (cause) {
              if (cancelled) return;
              // Not uploaded yet (404) is «файл ещё готовится», not an error.
              if (cause instanceof ApiError && cause.status === 404) {
                player.wait(
                  "Файл ещё готовится — состояние загрузки появится чуть позже",
                );
              } else {
                player.fail(
                  playbackError ??
                    "Не удалось получить состояние загрузки (playback API)",
                );
              }
              return;
            }
          }
          player.wait("Ожидаем данные playback…");
          return;
        }

        const externalAudio = (playback.audio_tracks ?? [])
          .filter((t) => isExternalAudioTrack(t) && t.url)
          .map((t) => t.url as string);

        // Complete VOD (includes legacy uploaded files synthesized by API).
        if (playback.stream?.complete || playback.video.url) {
          await startVod(externalAudio, playback.video.url);
          return;
        }

        // No heartbeat.stream yet. Incomplete files (`video.url == null`) must
        // not be opened as VOD — the missing final object used to 404 and flash
        // an error right before progressive playback began. Only legacy rows
        // whose final object already exists are worth one VOD probe.
        if (!playback.stream) {
          try {
            await startVod(externalAudio);
            return;
          } catch {
            if (cancelled) return;
            player.wait(
              "Готовим первые сегменты — воркер ещё не передал stream-прогресс",
            );
            return;
          }
        }

        if (!playback.stream.ready) {
          // Stream state can lag behind a finished upload — probe the final
          // object first; only if it is really missing show the waiting copy.
          try {
            await startVod(externalAudio);
            return;
          } catch {
            if (cancelled) return;
            const down = Math.round(playback.stream.percent_downloaded ?? 0);
            const seekable = Math.round(playback.stream.percent_seekable ?? 0);
            player.wait(
              `Загрузка ещё не началась — нет доступных сегментов (API: скачано ${down}%, доступно ${seekable}%)`,
            );
            return;
          }
        }

        if (!canPlayRef.current) {
          player.wait("Файл ещё загружается — основное видео недоступно");
          return;
        }

        // Progressive: local range source clipped to max_seekable_bytes.
        const sizeBytes = playback.stream.size_bytes || playback.video.size_bytes;
        const localUrl = await progressiveStart({
          sizeBytes,
          maxSeekableBytes: playback.stream.max_seekable_bytes,
          segments: playback.stream.segments,
        });
        if (cancelled) return;
        openedAsProgressiveRef.current = true;
        await player.start(localUrl, {
          startAt: from,
          externalAudioUrls: externalAudio,
          maxSeekableSec: limitRef.current.maxSeekableSec,
        });
        setOpenedMode("progressive");
        onOpenedRef.current?.({
          url: localUrl,
          startAt: from,
          source: "progressive",
        });
      } catch (cause) {
        if (cancelled) return;
        const message =
          cause instanceof Error && cause.message
            ? cause.message
            : "Не удалось открыть файл";
        player.fail(message);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // Re-open on retry / playback readiness transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    fileId,
    openToken,
    roomMode,
    mediaId,
    mediaResolve,
    playbackStatus,
    hasStream,
    streamReady,
    streamComplete,
  ]);

  const retryOpen = useCallback(() => {
    setOpenToken((token) => token + 1);
  }, []);

  const resetForEpisodeSwitch = useCallback(() => {
    void progressiveStop().catch(() => {});
    openedAsProgressiveRef.current = false;
    resumeAt.current = null;
  }, []);

  return {
    openedMode,
    retryOpen,
    resetForEpisodeSwitch,
    openedAsProgressiveRef,
  };
}
