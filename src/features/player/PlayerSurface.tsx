/**
 * Full-bleed player surface (M7 + M8 + progressive): video host + overlay
 * controls, TheIntroDB chrome, progressive status / episode picker.
 *
 * The actual video pixels are drawn by libmpv into a Win32 child window
 * (`wid`) behind the webview; this component is the HTML chrome and input
 * layer (controls, keyboard, auto-hide).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, ErrorState, Spinner } from "../../design/primitives";
import { CreditsPopup } from "../theintrodb/CreditsPopup";
import { SkipButtons } from "../theintrodb/SegmentChrome";
import { EMPTY_BUNDLE } from "../theintrodb/types";
import type { TheIntroDbBundle } from "../theintrodb/types";
import { useSegmentChrome } from "../theintrodb/useSegmentChrome";
import { PlayerControls } from "./PlayerControls";
import { ProgressiveStatus } from "./ProgressiveStatus";
import {
  applySeekDelta,
  clampSpeed,
  formatHwdec,
  formatVoDebug,
  OVERLAY_IDLE_MS,
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
  /** Series catalog for the episode picker. */
  seasonGroups?: PlaybackSeasonGroup[];
  currentFileId?: string | number | null;
  onSelectEpisode?: (episode: PlaybackEpisode) => void;
  /** True while playback is paused at the contiguous-prefix edge. */
  waitingAtEdge?: boolean;
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
}: PlayerSurfaceProps) {
  const { phase, snapshot, error, retry } = player;
  const [controlsVisible, setControlsVisible] = useState(true);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const bumpIdle = useCallback(() => {
    setControlsVisible(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setControlsVisible(false), OVERLAY_IDLE_MS);
  }, []);

  // Hide once on first idle tick; re-show on any mouse move.
  useEffect(() => {
    bumpIdle();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [bumpIdle]);

  // Keep the mpv child window in sync with the Tauri window size.
  useEffect(() => {
    const onResize = () => {
      void player.syncSize();
    };
    window.addEventListener("resize", onResize);
    // First paint after route enter — CSS height settles a tick late.
    void player.syncSize();
    const t = setTimeout(() => void player.syncSize(), 50);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(t);
    };
  }, [player]);

  const togglePause = useCallback(() => {
    void player.togglePause();
    bumpIdle();
  }, [player, bumpIdle]);

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
      bumpIdle();
    },
    [player, bumpIdle, limit, mode, snapshot.duration, onBlockedSeek],
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
      bumpIdle();
    },
    [player, bumpIdle, limit, mode, snapshot.duration, onBlockedSeek],
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
          bumpIdle();
          break;
        case "ArrowDown":
          event.preventDefault();
          void player.setVolume(Math.max(0, snapshot.volume - 5));
          bumpIdle();
          break;
        case "f":
        case "F":
        case "а":
        case "А":
          event.preventDefault();
          void player.setFullscreen(!snapshot.fullscreen);
          bumpIdle();
          break;
        case "m":
        case "M":
        case "ь":
        case "Ь":
          event.preventDefault();
          void player.setMute(!snapshot.mute);
          bumpIdle();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player, snapshot, togglePause, seekTo, bumpIdle]);

  if (phase === "loading") {
    return (
      <div className="player-surface player-surface-status" ref={surfaceRef}>
        <Spinner label="Загрузка плеера…" />
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="player-surface player-surface-status" ref={surfaceRef}>
        <ErrorState
          title="Не удалось открыть файл"
          description={
            error ?? "Проверьте статус загрузки и попробуйте снова."
          }
          onRetry={retry}
        />
        <Button variant="ghost" size="sm" onClick={() => window.history.back()}>
          Назад
        </Button>
      </div>
    );
  }

  const episodeSlot =
    seasonGroups && seasonGroups.length > 0 && onSelectEpisode ? (
      <label className="player-select-wrap">
        <span className="player-select-label">Серия</span>
        <select
          className="player-select"
          value={currentFileId == null ? "" : String(currentFileId)}
          onChange={(event) => {
            const id = event.target.value;
            for (const group of seasonGroups) {
              for (const episode of group.episodes) {
                if (String(episode.id) === id && episode.has_primary_video) {
                  onSelectEpisode(episode);
                  return;
                }
              }
            }
          }}
          aria-label="Серия"
        >
          {seasonGroups.flatMap((group) =>
            group.episodes.map((episode) => (
              <option
                key={String(episode.id)}
                value={String(episode.id)}
                disabled={!episode.has_primary_video}
              >
                {`S${String(group.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}${
                  episode.episode_end && episode.episode_end > episode.episode
                    ? `–E${String(episode.episode_end).padStart(2, "0")}`
                    : ""
                }${episode.title ? ` · ${episode.title}` : ""}${
                  episode.has_primary_video ? "" : " · загружается"
                }`}
              </option>
            )),
          )}
        </select>
      </label>
    ) : null;

  return (
    <div
      className="player-surface"
      ref={surfaceRef}
      onMouseMove={bumpIdle}
      onClick={(event) => {
        // Clicks on empty surface toggle pause; controls stop propagation.
        if (event.target === surfaceRef.current) togglePause();
      }}
    >
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
        visible={controlsVisible}
        onSeek={seekTo}
        onTogglePause={togglePause}
        onSetSpeed={(speed) => {
          void player.setSpeed(clampSpeed(speed));
          bumpIdle();
        }}
        onSetVolume={(volume) => {
          void player.setVolume(volume);
          bumpIdle();
        }}
        onToggleMute={() => {
          void player.setMute(!snapshot.mute);
          bumpIdle();
        }}
        onSetAudioTrack={(id) => {
          void player.setAudioTrack(id);
          void player.refreshTracks();
          bumpIdle();
        }}
        onSetSubtitleTrack={(id) => {
          void player.setSubtitleTrack(id);
          void player.refreshTracks();
          bumpIdle();
        }}
        onToggleFullscreen={() => {
          void player.setFullscreen(!snapshot.fullscreen);
          bumpIdle();
        }}
        markers={chrome.markers}
        chapters={chrome.markers}
        onSeekChapter={seekTo}
        hwdecLabel={formatHwdec(snapshot.hwdec)}
        voDebug={formatVoDebug(snapshot.vo, snapshot.video_w, snapshot.video_h)}
        mode={mode}
        progress={progress}
        limit={limit}
        onBlockedSeek={onBlockedSeek}
        audioOptions={audioOptions}
        selectedAudioId={selectedAudioId}
        onSelectPlaybackAudio={(trackId) => {
          onSelectAudio?.(trackId);
          bumpIdle();
        }}
        episodeSlot={episodeSlot}
      />

      <ProgressiveStatus
        mode={mode}
        progress={progress ?? { percentDownloaded: 0, percentSeekable: 0 }}
        limit={limit ?? { maxSeekableSec: null, seekableRatio: null, durationSec: null }}
        waitingAtEdge={waitingAtEdge}
        blockedToastToken={blockedToastToken}
      />
    </div>
  );
}
