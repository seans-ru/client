/**
 * Overlay transport controls for the libmpv surface (M7 + progressive).
 * Russian labels; token-only styling via `player.css` classes.
 *
 * Seek rail zones (progressive):
 *   [accent] downloaded position fill
 *   [lighter] contiguous seekable prefix (`percent_seekable`)
 *   [grey] future / not yet downloaded
 * Seeks past the seekable prefix are not sent to the transport.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { Button } from "../../design/primitives";
import { ChaptersMenu, SeekMarkers } from "../theintrodb/SegmentChrome";
import type { SegmentMarker } from "../theintrodb/types";
import type { PlaybackAudioOption } from "./usePlayback";
import {
  formatTime,
  formatTrackId,
  formatTrackLabel,
  parseTrackId,
  positionPercent,
  ratioToPosition,
  SPEED_OPTIONS,
} from "./playerHelpers";
import type { PlayerSnapshot } from "./playerTypes";
import type { DownloadProgress, PlaybackMode, SeekLimit } from "./progressiveHelpers";
import {
  checkSeek,
  downloadedRailRatio,
  seekableRailRatio,
} from "./progressiveHelpers";

export type PlayerControlsProps = {
  snapshot: PlayerSnapshot;
  visible: boolean;
  onSeek: (seconds: number) => void;
  onTogglePause: () => void;
  onSetSpeed: (speed: number) => void;
  onSetVolume: (volume: number) => void;
  onToggleMute: () => void;
  onSetAudioTrack: (id: number) => void;
  onSetSubtitleTrack: (id: number | null) => void;
  onToggleFullscreen: () => void;
  /** TheIntroDB seek-bar markers (M8); empty when the feature is off. */
  markers?: SegmentMarker[];
  /** Chapter rows for the «Главы» menu. */
  chapters?: SegmentMarker[];
  onSeekChapter?: (seconds: number) => void;
  hwdecLabel: string;
  /** Embed diagnostic: `vo=… · WxH`. */
  voDebug?: string;
  /** Progressive mode (`waiting` / `progressive` / `vod`). */
  mode?: PlaybackMode;
  /** Dual progress for the rail zones. */
  progress?: DownloadProgress;
  /** Seek ceiling (progressive). */
  limit?: SeekLimit;
  /** Called when the user scrubs into the grey zone (toast). */
  onBlockedSeek?: () => void;
  /** Product audio labels (flags → «Русский дубляж», …). */
  audioOptions?: PlaybackAudioOption[];
  /** Selected playback audio track id (stringified). */
  selectedAudioId?: string | null;
  /** Playback-level audio change (persists preference). */
  onSelectPlaybackAudio?: (trackId: string | number) => void;
  /** Series episode `<select>` slot (rendered by PlayerSurface). */
  episodeSlot?: ReactNode;
};

function useDragSeek(
  duration: number,
  onSeek: (seconds: number) => void,
  options: {
    limit: SeekLimit | undefined;
    mode: PlaybackMode | undefined;
    onBlockedSeek?: () => void;
  },
): {
  railRef: RefObject<HTMLDivElement | null>;
  dragging: boolean;
  dragPercent: number;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
} {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragPercent, setDragPercent] = useState(0);

  const ratioFromEvent = useCallback((clientX: number): number => {
    const rail = railRef.current;
    if (!rail) return 0;
    const rect = rail.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const emitSeek = useCallback(
    (ratio: number) => {
      const target = ratioToPosition(ratio, duration);
      const limit = options.limit ?? {
        maxSeekableSec: null,
        seekableRatio: null,
        durationSec: duration > 0 ? duration : null,
      };
      const mode = options.mode ?? "vod";
      const decision = checkSeek(target, limit, { mode });
      if (!decision.ok) {
        if (decision.reason === "beyond_seekable") {
          options.onBlockedSeek?.();
        }
        // Do not send the transport request past max_seekable_bytes.
        return;
      }
      onSeek(decision.seconds);
    },
    [duration, onSeek, options],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const rail = railRef.current;
      if (!rail) return;
      rail.setPointerCapture(event.pointerId);
      setDragging(true);
      const ratio = ratioFromEvent(event.clientX);
      setDragPercent(ratio * 100);
      emitSeek(ratio);
    },
    [emitSeek, ratioFromEvent],
  );

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || !dragging) return;

    const onMove = (event: PointerEvent) => {
      const ratio = ratioFromEvent(event.clientX);
      setDragPercent(ratio * 100);
      emitSeek(ratio);
    };
    const onUp = (event: PointerEvent) => {
      const ratio = ratioFromEvent(event.clientX);
      setDragging(false);
      try {
        rail.releasePointerCapture(event.pointerId);
      } catch {
        // capture may already be gone
      }
      emitSeek(ratio);
    };

    rail.addEventListener("pointermove", onMove);
    rail.addEventListener("pointerup", onUp);
    rail.addEventListener("pointercancel", onUp);
    return () => {
      rail.removeEventListener("pointermove", onMove);
      rail.removeEventListener("pointerup", onUp);
      rail.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, emitSeek, ratioFromEvent]);

  return { railRef, dragging, dragPercent, onPointerDown };
}

export function PlayerControls({
  snapshot,
  visible,
  onSeek,
  onTogglePause,
  onSetSpeed,
  onSetVolume,
  onToggleMute,
  onSetAudioTrack,
  onSetSubtitleTrack,
  onToggleFullscreen,
  markers,
  chapters,
  onSeekChapter,
  hwdecLabel,
  voDebug,
  mode = "vod",
  progress,
  limit,
  onBlockedSeek,
  audioOptions,
  selectedAudioId,
  onSelectPlaybackAudio,
  episodeSlot,
}: PlayerControlsProps) {
  const duration = snapshot.duration;
  const percent = snapshot.file_loaded
    ? positionPercent(snapshot.position, duration)
    : 0;
  const { railRef, dragging, dragPercent, onPointerDown } = useDragSeek(
    duration,
    onSeek,
    { limit, mode, onBlockedSeek },
  );

  const audioTracks = snapshot.tracks.filter((t) => t.kind === "audio");
  const subTracks = snapshot.tracks.filter((t) => t.kind === "sub");
  const selectedAudio = audioTracks.find((t) => t.selected)?.id ?? 0;
  const selectedSub = subTracks.find((t) => t.selected)?.id ?? 0;

  const seekablePct =
    mode === "vod"
      ? 100
      : (limit ? seekableRailRatio(limit, mode) : (progress?.percentSeekable ?? 0) / 100) *
        100;
  const downloadedPct =
    mode === "vod"
      ? 100
      : progress
        ? downloadedRailRatio(progress) * 100
        : percent;

  // Product audio menu (flags → Russian labels) when playback is available.
  const productAudio = audioOptions && audioOptions.length > 0;
  const productSelected =
    selectedAudioId ?? String(audioOptions?.[0]?.track.id ?? "");

  return (
    <div
      className={`player-controls${visible ? " player-controls-visible" : ""}`}
      role="group"
      aria-label="Управление воспроизведением"
    >
      <div
        className={`player-seek${mode === "progressive" ? " player-seek-progressive" : ""}`}
        ref={railRef}
        onPointerDown={onPointerDown}
        role="slider"
        tabIndex={0}
        aria-label="Позиция воспроизведения"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, Math.round(duration))}
        aria-valuenow={Math.round(snapshot.position)}
        aria-valuetext={`${formatTime(snapshot.position)} / ${formatTime(duration)}`}
      >
        <div className="player-seek-track">
          {/* Grey future zone is the track background. */}
          <div
            className="player-seek-download"
            style={{ width: `${dragging ? dragPercent : downloadedPct}%` }}
          />
          <div className="player-seek-seekable" style={{ width: `${seekablePct}%` }} />
          <div
            className="player-seek-fill"
            style={{ width: `${dragging ? dragPercent : percent}%` }}
          />
          {markers && markers.length > 0 ? (
            <SeekMarkers markers={markers} duration={duration} />
          ) : null}
        </div>
      </div>

      <div className="player-controls-row">
        <div className="player-controls-left">
          <Button
            variant="ghost"
            size="sm"
            onClick={onTogglePause}
            aria-label={snapshot.pause ? "Воспроизвести" : "Пауза"}
            title={snapshot.pause ? "Воспроизвести (Пробел)" : "Пауза (Пробел)"}
          >
            {snapshot.pause ? "▶" : "❚❚"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleMute}
            aria-label={snapshot.mute ? "Включить звук" : "Выключить звук"}
            title="Звук (M)"
          >
            {snapshot.mute ? "🔇" : "🔊"}
          </Button>
          <input
            className="player-volume"
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(snapshot.mute ? 0 : snapshot.volume)}
            onChange={(event) => onSetVolume(Number(event.target.value))}
            aria-label="Громкость"
            title="Громкость (↑ / ↓)"
          />
          <span className="player-time">
            {formatTime(snapshot.position)} / {formatTime(duration)}
          </span>
        </div>

        <div className="player-controls-right">
          {episodeSlot}

          <label className="player-select-wrap">
            <span className="player-select-label">Скорость</span>
            <select
              className="player-select"
              value={String(snapshot.speed)}
              onChange={(event) => onSetSpeed(Number(event.target.value))}
              aria-label="Скорость воспроизведения"
            >
              {SPEED_OPTIONS.map((speed) => (
                <option key={speed} value={String(speed)}>
                  {speed}×
                </option>
              ))}
            </select>
          </label>

          <label className="player-select-wrap">
            <span className="player-select-label">Аудио</span>
            {productAudio ? (
              <select
                className="player-select"
                value={productSelected}
                onChange={(event) => {
                  onSelectPlaybackAudio?.(event.target.value);
                }}
                aria-label="Озвучка"
              >
                {audioOptions!.map((option) => (
                  <option
                    key={String(option.track.id)}
                    value={String(option.track.id)}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <select
                className="player-select"
                value={formatTrackId("audio", selectedAudio)}
                onChange={(event) => {
                  const { id } = parseTrackId(event.target.value);
                  onSetAudioTrack(id);
                }}
                aria-label="Аудиодорожка"
              >
                {audioTracks.length === 0 ? (
                  <option value="audio:0">—</option>
                ) : (
                  audioTracks.map((track) => (
                    <option
                      key={track.id}
                      value={formatTrackId("audio", track.id)}
                    >
                      {formatTrackLabel(track)}
                    </option>
                  ))
                )}
              </select>
            )}
          </label>

          <label className="player-select-wrap">
            <span className="player-select-label">Субтитры</span>
            <select
              className="player-select"
              value={formatTrackId("sub", selectedSub)}
              onChange={(event) => {
                const { id } = parseTrackId(event.target.value);
                onSetSubtitleTrack(id > 0 ? id : null);
              }}
              aria-label="Субтитры"
            >
              <option value="sub:0">Выкл</option>
              {subTracks.map((track) => (
                <option key={track.id} value={formatTrackId("sub", track.id)}>
                  {formatTrackLabel(track)}
                </option>
              ))}
            </select>
          </label>

          <ChaptersMenu
            markers={chapters ?? []}
            onSeekMs={(ms) => onSeekChapter?.(ms / 1000)}
            disabled={!onSeekChapter}
          />

          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleFullscreen}
            aria-label={snapshot.fullscreen ? "Выйти из полноэкранного режима" : "Полный экран"}
            title="Полный экран (F)"
          >
            {snapshot.fullscreen ? "⤡" : "⛶"}
          </Button>
        </div>
      </div>

      <div className="player-hwdec" title="Режим декодирования">
        {hwdecLabel}
        {voDebug ? <span> · {voDebug}</span> : null}
      </div>
    </div>
  );
}
