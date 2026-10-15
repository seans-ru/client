import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchFileUrl, fetchLibrary } from "../api/endpoints";
import type { ApiId } from "../api/types";
import type { PlaybackEpisode } from "../api/playback";
import {
  consumeStartAt,
  PlayerSurface,
  usePlayer,
} from "../features/player";
import type { UsePlayerState } from "../features/player";
import {
  isExternalAudioTrack,
} from "../features/player/audioTrackHelpers";
import {
  playerSetMaxSeekable,
  progressiveStart,
  progressiveStop,
  progressiveUpdate,
} from "../features/player/progressiveApi";
import {
  shouldAutoResumeAfterGrowth,
  shouldPauseAtSeekEdge,
} from "../features/player/progressiveHelpers";
import { usePlayback } from "../features/player/usePlayback";
import { fetchResumePosition, useHistoryProgress } from "../features/history";
import { useTheIntroDb } from "../features/theintrodb";
import "../features/player/player.css";

/** Local transport action names shared with the room WS `state` frames. */
export type RoomTransportAction = "play" | "pause" | "seek";

/** Player access surface used by the room socket (heartbeats + guest apply). */
export type RoomTransport = {
  /** Current playback position in seconds. */
  getPosition: () => number;
  /** Apply a remote room command (guest). */
  apply: (
    action: RoomTransportAction,
    position: number,
    isPlaying?: boolean,
  ) => Promise<void>;
};

/** Resolve media id + season/episode for a task file id via the library. */
async function resolveFileMedia(
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
 * Player screen (M7 + M8 + M9 + progressive). Full-bleed via
 * `isFullBleedRoute` (no left nav).
 *
 * Flow:
 * 1. Resolve media id for `fileId`, then `GET /api/media/{id}/playback`.
 * 2. `stream.complete` → VOD (`fetchFileUrl` + libmpv).
 *    `stream.ready && !complete` → progressive (local range source).
 * 3. Seek is limited to `max_seekable_bytes` (UI + Rust transport clamp).
 * 4. Dual progress + grey zone from the playback poll (5–7 s).
 * 5. Audio tracks from `audio_tracks[]` (flags → Russian labels), preference
 *    saved per media/episode.
 * 6. Series: episode picker; Play hidden when `has_primary_video` is false.
 * 7. Resume (M9) + history progress; room mode skips both (host sync owns it).
 */
export function PlayerScreen({
  fileId,
  startAt,
  roomMode = false,
  onTransport,
  transportRef,
}: {
  fileId: string;
  startAt?: number | null;
  /** Room playback (M10): skip history resume + progress tracking. */
  roomMode?: boolean;
  /** Room (M10): local play/pause/seek — host broadcasts these over WS. */
  onTransport?: (action: RoomTransportAction, position: number) => void;
  /** Room (M10): player transport for heartbeats and guest remote apply. */
  transportRef?: { current: RoomTransport | null };
}) {
  const player = usePlayer();
  const [openToken, setOpenToken] = useState(0);
  const lastFileRef = useRef<string | null>(null);
  const intro = useTheIntroDb(fileId);
  const [mediaId, setMediaId] = useState<ApiId | null>(null);
  const [blockedToastToken, setBlockedToastToken] = useState(0);
  const [waitingAtEdge, setWaitingAtEdge] = useState(false);
  const waitingAtEdgeRef = useRef(false);
  const prevLimitRef = useRef<ReturnType<typeof usePlayback>["limit"] | null>(
    null,
  );

  // Consume a resume position once per file id (clean M9 hook).
  const resumeAt = useRef<number | null>(null);
  if (lastFileRef.current !== fileId) {
    lastFileRef.current = fileId;
    resumeAt.current = startAt ?? consumeStartAt();
  }

  // Season/episode for the playback API (`?season=&episode=`).
  const [episodeCtx, setEpisodeCtx] = useState<{
    season: number | null;
    episode: number | null;
  }>({ season: null, episode: null });

  // Resolve media id + season/episode. TheIntroDB context may already have
  // the media id; always resolve season/episode from the library file row.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ctx = await resolveFileMedia(fileId);
        if (cancelled) return;
        if (ctx) {
          setMediaId(ctx.mediaId);
          setEpisodeCtx({ season: ctx.season, episode: ctx.episode });
        } else if (intro.context?.mediaId != null) {
          setMediaId(intro.context.mediaId);
          setEpisodeCtx({
            season: intro.context.season,
            episode: intro.context.episode,
          });
        }
      } catch {
        if (!cancelled && intro.context?.mediaId != null) {
          setMediaId(intro.context.mediaId);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId, intro.context?.mediaId, intro.context?.season, intro.context?.episode]);

  const playbackState = usePlayback(mediaId, fileId, {
    enabled: !roomMode,
    season: episodeCtx.season,
    episode: episodeCtx.episode,
  });
  const {
    mode,
    limit,
    progress,
    playback,
    audioOptions,
    selectedAudio,
    selectedAudioId,
    seasonGroups,
    canPlay,
    selectAudio,
  } = playbackState;

  const historyProgress = useHistoryProgress({
    taskFileId: fileId,
    enabled: !roomMode,
  });

  // Force-save after a user seek (throttle would otherwise wait out the 15 s).
  const progressRef = useRef(historyProgress);
  progressRef.current = historyProgress;

  // Room (M10): report local transport and expose apply/getPosition.
  const onTransportRef = useRef(onTransport);
  onTransportRef.current = onTransport;
  const snapshotRef = useRef(player.snapshot);
  snapshotRef.current = player.snapshot;
  const playerRef = useRef(player);
  playerRef.current = player;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const limitRef = useRef(limit);
  limitRef.current = limit;

  useEffect(() => {
    if (!transportRef) return;
    const transport: RoomTransport = {
      getPosition: () => snapshotRef.current.position,
      apply: async (action, position, isPlaying) => {
        const p = playerRef.current;
        const snap = snapshotRef.current;
        // Always seek on explicit seek; otherwise only when we are out of range
        // so gentle play/pause frames do not cause visible jumps.
        const needsSeek =
          action === "seek" || Math.abs(snap.position - position) > 1.5;
        if (needsSeek) {
          await p.seek(position);
        }
        const playRequested =
          action === "play" || (action !== "pause" && isPlaying === true);
        const pauseRequested =
          action === "pause" || (action !== "play" && isPlaying === false);
        if (playRequested) await p.play();
        else if (pauseRequested) await p.pause();
      },
    };
    transportRef.current = transport;
    return () => {
      if (transportRef.current === transport) transportRef.current = null;
    };
  }, [transportRef]);

  const onBlockedSeek = useCallback(() => {
    setBlockedToastToken((t) => t + 1);
  }, []);

  /** Apply the preferred / selected playback audio track to mpv. */
  const applyAudioTrack = useCallback(
    (trackId?: string | number | null) => {
      const options = playbackState.audioOptions;
      if (!options || options.length === 0) return;
      const key = trackId == null ? null : String(trackId);
      const option =
        options.find((o) => String(o.track.id) === key) ??
        options.find((o) => String(o.track.id) === selectedAudioId) ??
        options[0];
      if (!option) return;
      const track = option.track;
      if (track.embedded !== false) {
        const index = track.track_index;
        void playerRef.current.setAudioTrack(
          typeof index === "number" && index > 0 ? index : 0,
        );
      }
      // External (ac3/m4a) tracks are attached at open time via audio-files.
    },
    [playbackState.audioOptions, selectedAudioId],
  );

  // Push seek ceiling to the Rust transport whenever it changes.
  useEffect(() => {
    if (roomMode) return;
    void playerSetMaxSeekable(
      mode === "vod" ? null : (limit.maxSeekableSec ?? null),
    ).catch(() => {});
  }, [mode, limit.maxSeekableSec, roomMode]);

  // Pause at the contiguous-prefix edge; auto-resume when the prefix grows.
  // Never scrolls the user backwards on its own.
  useEffect(() => {
    if (roomMode || mode !== "progressive") {
      setWaitingAtEdge(false);
      waitingAtEdgeRef.current = false;
      return;
    }
    const { position, pause, duration } = player.snapshot;
    const atEdge = shouldPauseAtSeekEdge(position, limit, mode);
    if (atEdge && !pause && duration > 0) {
      void player.pause();
      setWaitingAtEdge(true);
      waitingAtEdgeRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.snapshot.position, player.snapshot.pause, mode, limit, roomMode]);

  useEffect(() => {
    if (roomMode) return;
    const grew = shouldAutoResumeAfterGrowth(prevLimitRef.current, limit, {
      mode,
      waitingAtEdge: waitingAtEdgeRef.current,
    });
    prevLimitRef.current = limit;
    if (grew && waitingAtEdgeRef.current) {
      void player.play();
      setWaitingAtEdge(false);
      waitingAtEdgeRef.current = false;
    }
  }, [limit, mode, player, roomMode]);

  // complete → seamless VOD switch (keep position, no user scroll).
  const openedAsProgressiveRef = useRef(false);
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

  const playerWithHistory = useMemo<UsePlayerState>(() => {
    return {
      ...player,
      play: async () => {
        await player.play();
        onTransportRef.current?.("play", snapshotRef.current.position);
      },
      pause: async () => {
        await player.pause();
        onTransportRef.current?.("pause", snapshotRef.current.position);
      },
      togglePause: async () => {
        const wasPaused = player.snapshot.pause;
        await player.togglePause();
        onTransportRef.current?.(
          wasPaused ? "play" : "pause",
          snapshotRef.current.position,
        );
      },
      seek: async (seconds: number, opts?: { personal?: boolean }) => {
        const decisionLimit = limitRef.current;
        const modeNow = modeRef.current;
        // Transport guard: never send a seek past max_seekable_bytes.
        if (modeNow === "progressive" && decisionLimit.maxSeekableSec != null) {
          if (seconds > decisionLimit.maxSeekableSec + 1e-6) {
            setBlockedToastToken((t) => t + 1);
            return;
          }
        }
        await player.seek(seconds);
        progressRef.current.flush({
          positionSec: seconds,
          durationSec: player.snapshot.duration,
          paused: player.snapshot.pause,
        });
        // Personal skips (intro/recap) stay local — room protocol forbids
        // broadcasting them; host scrubs still send a normal `state`.
        if (!opts?.personal) {
          onTransportRef.current?.("seek", seconds);
        }
      },
    };
  }, [player]);

  // Throttled progress on every snapshot tick.
  const { position, duration, pause } = player.snapshot;
  useEffect(() => {
    historyProgress.track({
      positionSec: position,
      durationSec: duration,
      paused: pause,
    });
    // `track` is stable; snapshot fields drive the ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, duration, pause]);

  // Open / reopen the media source (VOD URL or progressive range server).
  const playbackStatus = playbackState.status;
  const canPlayRef = useRef(canPlay);
  canPlayRef.current = canPlay;
  const streamReady = playback?.stream?.ready ?? false;
  const streamComplete = playback?.stream?.complete ?? false;
  const hasStream = playback?.stream != null;
  useEffect(() => {
    // Wait until playback metadata is ready when we expect progressive.
    if (!roomMode && mediaId != null && playbackStatus === "loading") {
      return;
    }

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
        };

        // Playback API missing / 404 — legacy library rows, or media without
        // MediaEpisode. Fall back to the uploaded final object (VOD).
        if (!playback) {
          if (playbackStatus === "error") {
            try {
              await startVod([]);
              return;
            } catch {
              player.fail(
                playbackState.error ??
                  "Не удалось получить состояние загрузки (playback API)",
              );
              return;
            }
          }
          player.fail("Ожидаем данные playback…");
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

        // No heartbeat.stream — for already-uploaded files the final object
        // exists (`fetchFileUrl`); for in-progress ones wait for the worker.
        if (!playback.stream) {
          try {
            await startVod(externalAudio);
            return;
          } catch {
            player.fail(
              "Воркер ещё не передал stream-прогресс — сегменты появляются, ожидайте…",
            );
            return;
          }
        }

        if (!playback.stream.ready) {
          player.fail("Загрузка ещё не началась — нет доступных сегментов");
          return;
        }

        if (!canPlayRef.current) {
          player.fail("Файл ещё загружается — основное видео недоступно");
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
    playbackStatus,
    hasStream,
    streamReady,
    streamComplete,
  ]);

  // Keep the progressive source prefix in sync with each playback poll.
  useEffect(() => {
    if (roomMode || !openedAsProgressiveRef.current || !playback?.stream) return;
    void progressiveUpdate({
      maxSeekableBytes: playback.stream.max_seekable_bytes,
      segments: playback.stream.segments,
      sizeBytes: playback.stream.size_bytes || playback.video.size_bytes,
    }).catch(() => {});
    void playerSetMaxSeekable(limit.maxSeekableSec ?? null).catch(() => {});
  }, [roomMode, playback, limit.maxSeekableSec]);

  // Apply selected audio when it changes (and after tracks appear).
  useEffect(() => {
    if (mode === "waiting") return;
    applyAudioTrack(selectedAudioId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAudioId, player.snapshot.tracks.length, mode]);

  const handleSelectEpisode = useCallback(
    (episode: PlaybackEpisode) => {
      if (!episode.has_primary_video) return;
      void progressiveStop().catch(() => {});
      openedAsProgressiveRef.current = false;
      resumeAt.current = null;
      window.location.hash = `#/player/${episode.id}`;
    },
    [],
  );

  return (
    <section className="app-fullbleed player-screen">
      <PlayerSurface
        player={{
          ...playerWithHistory,
          retry: () => setOpenToken((token) => token + 1),
        }}
        segments={intro.segments}
        mediaId={intro.context?.mediaId ?? mediaId}
        alreadyReviewed={Boolean(intro.context?.alreadyReviewed)}
        mode={mode}
        progress={progress}
        limit={limit}
        blockedToastToken={blockedToastToken}
        onBlockedSeek={onBlockedSeek}
        audioOptions={audioOptions}
        selectedAudioId={selectedAudio?.id != null ? String(selectedAudio.id) : selectedAudioId}
        onSelectAudio={(trackId) => {
          selectAudio(trackId);
          applyAudioTrack(trackId);
        }}
        seasonGroups={
          seasonGroups.length > 0 ? seasonGroups : undefined
        }
        currentFileId={fileId}
        onSelectEpisode={handleSelectEpisode}
        waitingAtEdge={waitingAtEdge}
      />
    </section>
  );
}

export { openPlayer as openPlayerRoute } from "../features/player";
