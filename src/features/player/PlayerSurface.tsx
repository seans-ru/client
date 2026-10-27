/**
 * Sidecar player layout: clean video area + slim transport strip + context
 * rail (series episodes / room). The mpv child window is sized to the video
 * area rect only — the rail and transport stay uncovered HTML.
 *
 * The actual video pixels are drawn by libmpv into a Win32 child window (`wid`)
 * above the webview; this component measures the video area and owns all
 * chrome (transport, keyboard, sidecar, progressive toasts).
 */

import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Button, ErrorState, Spinner } from "../../design/primitives";
import { CreditsPopup } from "../theintrodb/CreditsPopup";
import { SkipButtons } from "../theintrodb/SegmentChrome";
import { EMPTY_BUNDLE } from "../theintrodb/types";
import type { TheIntroDbBundle } from "../theintrodb/types";
import { useSegmentChrome } from "../theintrodb/useSegmentChrome";
import { EpisodePicker } from "./EpisodePicker";
import { PlayerControls } from "./PlayerControls";
import { ProgressiveStatus } from "./ProgressiveStatus";
import {
  applySeekDelta,
  clampSpeed,
  formatHwdec,
  formatVoDebug,
  SEEK_STEP_SEC,
} from "./playerHelpers";
import {
  checkSeek,
  type DownloadProgress,
  type PlaybackMode,
  type SeekLimit,
} from "./progressiveHelpers";
import type { PlaybackAudioOption } from "./usePlayback";
import type { UsePlayerState } from "./usePlayer";
import type { PlaybackEpisode } from "../../api/playback";
import type { PlaybackSeasonGroup } from "../../api/playback";

export type PlayerSurfaceProps = {
  player: UsePlayerState;
  /** TheIntroDB segments; empty bundle = feature off. */
  segments?: TheIntroDbBundle;
  /** Media id for the credits review PUT. */
  mediaId?: string | number | null;
  /** Skip credits popup when the user already reviewed. */
  alreadyReviewed?: boolean;
  /** Progressive / VOD mode. */
  mode?: PlaybackMode;
  progress?: DownloadProgress;
  limit?: SeekLimit;
  /** Bumped when a grey-zone seek is blocked (toast). */
  blockedToastToken?: number;
  onBlockedSeek?: () => void;
  /** Product audio tracks (flags → Russian labels). */
  audioOptions?: PlaybackAudioOption[];
  selectedAudioId?: string | null;
  onSelectAudio?: (trackId: string | number) => void;
  /** Series catalog for the sidecar episode list. */
  seasonGroups?: PlaybackSeasonGroup[];
  currentFileId?: string | number | null;
  onSelectEpisode?: (episode: PlaybackEpisode) => void;
  /** True while playback is paused at the contiguous-prefix edge. */
  waitingAtEdge?: boolean;
  /** Extra sidecar content (room members / actions). */
  sidecarExtra?: ReactNode;
};

export function PlayerSurface({
  player,
  segments,
  mediaId = null,
  alreadyReviewed = false,
  mode = "vod",
  progress,
  limit,
  blockedToastToken = 0,
  onBlockedSeek,
  audioOptions,
  selectedAudioId,
  onSelectAudio,
  seasonGroups,
  currentFileId,
  onSelectEpisode,
  waitingAtEdge = false,
  sidecarExtra,
}: PlayerSurfaceProps) {
  const { phase, snapshot, error, waitMessage, retry } = player;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const videoAreaRef = useRef<HTMLDivElement | null>(null);
  const fullscreen = snapshot.fullscreen;

  const hasEpisodes = Boolean(seasonGroups && seasonGroups.length > 0 && onSelectEpisode);
  const showSidecar = hasEpisodes || Boolean(sidecarExtra);

  // Keep the mpv child window exactly on the DOM video area (physical px).
  // This is what leaves the transport strip and sidecar uncovered.
  // While a status screen is up the host is collapsed — it sits above the
  // webview and would otherwise paint over the waiting/error message.
  useEffect(() => {
    const el = videoAreaRef.current;
    if (!el) return;
    const sync = () => {
      if (phase !== "ready") {
        void player.syncSize({ x: 0, y: 0, width: 1, height: 1 });
        return;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const dpr = window.devicePixelRatio || 1;
      void player.syncSize({
        x: rect.left * dpr,
        y: rect.top * dpr,
        width: rect.width * dpr,
        height: rect.height * dpr,
      });
    };
    sync();
    // First paint after route enter — CSS height settles a tick late.
    const t = setTimeout(sync, 50);
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      clearTimeout(t);
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [player.syncSize, phase, fullscreen, showSidecar]);

  const togglePause = useCallback(() => {
    void player.togglePause();
  }, [player]);

  const seekTo = useCallback(
    (seconds: number) => {
      const seekLimit: SeekLimit = limit ?? {
        maxSeekableSec: null,
        seekableRatio: null,
        durationSec: snapshot.duration > 0 ? snapshot.duration : null,
      };
      const decision = checkSeek(seconds, seekLimit, { mode });
      if (!decision.ok) {
        if (decision.reason === "beyond_seekable") onBlockedSeek?.();
        return;
      }
      void player.seek(decision.seconds);
    },
    [player, limit, mode, snapshot.duration, onBlockedSeek],
  );

  const seekMs = useCallback(
    (ms: number) => {
      seekTo(ms / 1000);
    },
    [seekTo],
  );

  /** TheIntroDB skip is personal — never broadcast via room `state`. */
  const seekMsPersonal = useCallback(
    (ms: number) => {
      const seconds = ms / 1000;
      const seekLimit: SeekLimit = limit ?? {
        maxSeekableSec: null,
        seekableRatio: null,
        durationSec: snapshot.duration > 0 ? snapshot.duration : null,
      };
      const decision = checkSeek(seconds, seekLimit, { mode });
      if (!decision.ok) {
        if (decision.reason === "beyond_seekable") onBlockedSeek?.();
        return;
      }
      void player.seek(decision.seconds, { personal: true });
    },
    [player, limit, mode, snapshot.duration, onBlockedSeek],
  );

  const bundle = segments ?? EMPTY_BUNDLE;
  const positionMs = snapshot.position * 1000;
  const chrome = useSegmentChrome({
    bundle,
    positionMs,
    onSeekMs: seekMs,
    mediaId,
    alreadyReviewed,
  });

  // Keyboard: Space / ← / → / ↑ / ↓ / F / M.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      switch (event.key) {
        case " ":
        case "Spacebar":
          event.preventDefault();
          togglePause();
          break;
        case "ArrowLeft":
          event.preventDefault();
          seekTo(applySeekDelta(snapshot.position, -SEEK_STEP_SEC, snapshot.duration));
          break;
        case "ArrowRight":
          event.preventDefault();
          seekTo(applySeekDelta(snapshot.position, SEEK_STEP_SEC, snapshot.duration));
          break;
        case "ArrowUp":
          event.preventDefault();
          void player.setVolume(Math.min(100, snapshot.volume + 5));
          break;
        case "ArrowDown":
          event.preventDefault();
          void player.setVolume(Math.max(0, snapshot.volume - 5));
          break;
        case "f":
        case "F":
        case "а":
        case "А":
          event.preventDefault();
          void player.setFullscreen(!snapshot.fullscreen);
          break;
        case "m":
        case "M":
        case "ь":
        case "Ь":
          event.preventDefault();
          void player.setMute(!snapshot.mute);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player, snapshot, togglePause, seekTo]);

  let statusNode: ReactNode = null;
  if (phase === "loading") {
    statusNode = (
      <div className="player-surface-status">
        <Spinner label="Загрузка плеера…" />
      </div>
    );
  } else if (phase === "waiting") {
    statusNode = (
      <div className="player-surface-status">
        <Spinner label={waitMessage ?? "Готовим воспроизведение…"} />
        <Button variant="ghost" size="sm" onClick={retry}>
          Повторить
        </Button>
        <Button variant="ghost" size="sm" onClick={() => window.history.back()}>
          Назад
        </Button>
      </div>
    );
  } else if (phase === "error") {
    statusNode = (
      <div className="player-surface-status">
        <ErrorState
          title="Не удалось открыть файл"
          description={error ?? "Проверьте статус загрузки и попробуйте снова."}
          onRetry={retry}
        />
        <Button variant="ghost" size="sm" onClick={() => window.history.back()}>
          Назад
        </Button>
      </div>
    );
  }

  return (
    <div
      className={`player-surface${fullscreen ? " player-surface-fullscreen" : ""}`}
      ref={surfaceRef}
    >
      <div className="player-stage">
        <div
          className={`player-video-area${statusNode ? " player-video-area-status" : ""}`}
          ref={videoAreaRef}
          onClick={statusNode ? undefined : togglePause}
          title={statusNode ? undefined : "Пробел — пауза"}
        >
          {statusNode}
        </div>

        {statusNode ? null : (
          <>
            {chrome.creditsPopupOpen && mediaId != null ? (
              <CreditsPopup
                mediaId={mediaId}
                onSubmitted={chrome.onCreditsSubmitted}
                onDismiss={chrome.onDismissCredits}
              />
            ) : null}

            <SkipButtons
              skips={chrome.skips}
              visible={chrome.skipVisible}
              onSkip={seekMsPersonal}
            />

            <PlayerControls
              snapshot={snapshot}
              onSeek={seekTo}
              onTogglePause={togglePause}
              onSetSpeed={(speed) => {
                void player.setSpeed(clampSpeed(speed));
              }}
              onSetVolume={(volume) => {
                void player.setVolume(volume);
              }}
              onToggleMute={() => {
                void player.setMute(!snapshot.mute);
              }}
              onSetAudioTrack={(id) => {
                void player.setAudioTrack(id);
                void player.refreshTracks();
              }}
              onSetSubtitleTrack={(id) => {
                void player.setSubtitleTrack(id);
                void player.refreshTracks();
              }}
              onToggleFullscreen={() => {
                void player.setFullscreen(!snapshot.fullscreen);
              }}
              markers={chrome.markers}
              chapters={chrome.markers}
              onSeekChapter={seekTo}
              mode={mode}
              progress={progress}
              limit={limit}
              onBlockedSeek={onBlockedSeek}
              audioOptions={audioOptions}
              selectedAudioId={selectedAudioId}
              onSelectPlaybackAudio={(trackId) => {
                onSelectAudio?.(trackId);
              }}
            />
          </>
        )}

        {statusNode ? null : (
          <ProgressiveStatus
            mode={mode}
            progress={progress ?? { percentDownloaded: 0, percentSeekable: 0 }}
            limit={limit ?? { maxSeekableSec: null, seekableRatio: null, durationSec: null }}
            waitingAtEdge={waitingAtEdge}
            blockedToastToken={blockedToastToken}
          />
        )}
      </div>

      {showSidecar ? (
        <aside className="player-sidecar" aria-label="Серии и участники">
          {hasEpisodes ? (
            <EpisodePicker
              groups={seasonGroups!}
              currentFileId={currentFileId ?? null}
              onSelect={(episode) => onSelectEpisode?.(episode)}
            />
          ) : null}
          {sidecarExtra}
          {phase === "ready" ? (
            <p className="player-sidecar-meta" title="Режим декодирования">
              {formatHwdec(snapshot.hwdec)}
              {formatVoDebug(snapshot.vo, snapshot.video_w, snapshot.video_h)
                ? ` · ${formatVoDebug(snapshot.vo, snapshot.video_w, snapshot.video_h)}`
                : ""}
            </p>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}
