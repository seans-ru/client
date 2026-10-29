/**
 * Sidecar player layout: clean video area + slim transport strip + context
 * rail (series episodes / room). The mpv child window is sized to the video
 * area rect only — the rail and transport stay uncovered HTML.
 *
 * The actual video pixels are drawn by libmpv into a Win32 child window (`wid`)
 * above the webview; this component measures the video area and owns all
 * chrome (transport, keyboard, sidecar, progressive toasts).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, ErrorState, Spinner } from "../../design/primitives";
import { CreditsPopup } from "../theintrodb/CreditsPopup";
import { SkipButtons } from "../theintrodb/SegmentChrome";
import { EMPTY_BUNDLE } from "../theintrodb/types";
import type { TheIntroDbBundle } from "../theintrodb/types";
import { useSegmentChrome } from "../theintrodb/useSegmentChrome";
import { EpisodePicker } from "./EpisodePicker";
import { PanelIcon, PlayerControls } from "./PlayerControls";
import { CanvasVideoRenderer, FrameStream } from "./frameSink";
import { playerFramesUrl } from "./playerApi";
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

/** localStorage key: sidecar rail visibility (`"0"` = collapsed). */
const SIDECAR_PREF_KEY = "seans.player.sidecar";

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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** DOM node of the overlay layer — portal target for the settings panel. */
  const [overlayEl, setOverlayEl] = useState<HTMLElement | null>(null);
  const fullscreen = snapshot.fullscreen;

  // The picker is a switcher: one playable item (a film) has nothing to
  // choose — keep the rail empty instead of listing the file itself.
  const episodeCount = (seasonGroups ?? []).reduce(
    (count, group) => count + (group.episodes?.length ?? 0),
    0,
  );
  const hasEpisodes = episodeCount > 1 && Boolean(onSelectEpisode);
  const sidecarAvailable = hasEpisodes || Boolean(sidecarExtra);
  const [sidecarOpen, setSidecarOpen] = useState(() => {
    try {
      return localStorage.getItem(SIDECAR_PREF_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggleSidecar = useCallback(() => {
    setSidecarOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem(SIDECAR_PREF_KEY, next ? "1" : "0");
      } catch {
        // storage may be unavailable — the toggle still works for this session
      }
      return next;
    });
  }, []);
  const showSidecar = sidecarAvailable && sidecarOpen;

  // Paint the offscreen mpv frames into the canvas (frame-stream player).
  // The canvas is plain DOM — popups overlay it with normal z-index.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new CanvasVideoRenderer(canvas);
    const stream = new FrameStream();
    let cancelled = false;
    void (async () => {
      try {
        const url = await playerFramesUrl();
        if (cancelled) return;
        await stream.connect(url, (frame) => {
          renderer.push(frame.width, frame.height, frame.pixels);
        });
      } catch (error) {
        if (!cancelled) console.warn("[player] frame stream:", error);
      }
    })();
    return () => {
      cancelled = true;
      stream.close();
      renderer.destroy();
    };
  }, []);

  // Size the offscreen render target to the DOM video area (physical px).
  // The canvas fills the same box, so frames map 1:1 onto it.
  useEffect(() => {
    const el = videoAreaRef.current;
    if (!el) return;
    const sync = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const dpr = window.devicePixelRatio || 1;
      void player.syncSize({
        x: 0,
        y: 0,
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
  }, [player.syncSize, fullscreen, showSidecar]);

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
          {/* Offscreen mpv frames land here; everything else is DOM above it. */}
          <canvas ref={canvasRef} className="player-video-canvas" aria-hidden="true" />
          {statusNode}
          {/* Popups live at the bottom of the video area — plain DOM over the
              canvas, no host window to occlude them. Clicks here must not
              toggle pause. */}
          <div
            className="player-overlay-layer"
            ref={setOverlayEl}
            onClick={(event) => event.stopPropagation()}
          >
            {statusNode ? null : (
              <>
                <ProgressiveStatus
                  mode={mode}
                  progress={progress ?? { percentDownloaded: 0, percentSeekable: 0 }}
                  limit={limit ?? { maxSeekableSec: null, seekableRatio: null, durationSec: null }}
                  waitingAtEdge={waitingAtEdge}
                  blockedToastToken={blockedToastToken}
                />

                <SkipButtons
                  skips={chrome.skips}
                  visible={chrome.skipVisible}
                  onSkip={seekMsPersonal}
                />

                {chrome.creditsPopupOpen && mediaId != null ? (
                  <CreditsPopup
                    mediaId={mediaId}
                    onSubmitted={chrome.onCreditsSubmitted}
                    onDismiss={chrome.onDismissCredits}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>

        {statusNode ? null : (
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
            settingsOverlayEl={overlayEl}
            sidecarAvailable={sidecarAvailable}
            sidecarOpen={sidecarOpen}
            onToggleSidecar={toggleSidecar}
          />
        )}
      </div>

      {showSidecar ? (
        <aside className="player-sidecar" aria-label="Серии и участники">
          <div className="player-sidecar-header">
            <h3 className="player-sidecar-title">
              {hasEpisodes ? "Серии" : "Панель"}
            </h3>
            <button
              type="button"
              className="player-icon-btn"
              onClick={toggleSidecar}
              aria-label="Скрыть боковую панель"
              title="Скрыть панель"
            >
              <PanelIcon />
            </button>
          </div>
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
