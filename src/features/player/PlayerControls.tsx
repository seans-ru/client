/**
 * Slim transport bar under the video (Sidecar layout).
 * Russian labels; token-only styling via `player.css`.
 *
 * Seek rail zones (progressive):
 *   [accent] playback position fill
 *   [teal]   contiguous downloaded / seekable prefix
 *   [grey]   future / not yet downloadable
 * Seeks past the seekable prefix are not sent to the transport.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { SeekMarkers } from "../theintrodb/SegmentChrome";
import type { SegmentMarker } from "../theintrodb/types";
import type { PlaybackAudioOption } from "./usePlayback";
import {
  formatTime,
  formatTrackLabel,
  positionPercent,
  ratioToPosition,
  SPEED_OPTIONS,
} from "./playerHelpers";
import type { PlayerSnapshot } from "./playerTypes";
import type { DownloadProgress, PlaybackMode, SeekLimit } from "./progressiveHelpers";
import {
  checkSeek,
  downloadedRailRatio,
  formatProgressLabels,
  formatSeekableUntil,
  seekableRailRatio,
} from "./progressiveHelpers";

export type PlayerControlsProps = {
  snapshot: PlayerSnapshot;
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

/* ----------------------------------------------------------------- icons */

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M5 3.5v11l10-5.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="4" y="3.5" width="3.5" height="11" rx="1" fill="currentColor" />
      <rect x="10.5" y="3.5" width="3.5" height="11" rx="1" fill="currentColor" />
    </svg>
  );
}

function VolumeIcon({ muted }: { muted: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M3 7h3l4-3v10l-4-3H3z" fill="currentColor" />
      {muted ? (
        <path d="M12 6.5l4 5m0-5l-4 5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      ) : (
        <path d="M12 6c1.2 1 1.2 5 0 6M14 4.5c2 1.8 2 7.2 0 9" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      )}
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="2.4" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path
        d="M9 2.2v2M9 13.8v2M2.2 9h2M13.8 9h2M4.2 4.2l1.4 1.4M12.4 12.4l1.4 1.4M13.8 4.2l-1.4 1.4M5.6 12.4l-1.4 1.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FullscreenIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      {active ? (
        <path
          d="M7 2.5H2.5V7M11 15.5h4.5V11M2.5 11v4.5H7M15.5 7V2.5H11"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M2.5 6.5v-4h4M11.5 2.5h4v4M15.5 11.5v4h-4M6.5 15.5h-4v-4"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

/* ---------------------------------------------------------- settings menu */

function SettingsMenu({
  snapshot,
  onSetSpeed,
  audioTracks,
  selectedAudio,
  onSetAudioTrack,
  subTracks,
  selectedSub,
  onSetSubtitleTrack,
  audioOptions,
  selectedAudioId,
  onSelectPlaybackAudio,
  chapters,
  onSeekChapter,
}: {
  snapshot: PlayerSnapshot;
  onSetSpeed: (speed: number) => void;
  audioTracks: PlayerSnapshot["tracks"];
  selectedAudio: number;
  onSetAudioTrack: (id: number) => void;
  subTracks: PlayerSnapshot["tracks"];
  selectedSub: number;
  onSetSubtitleTrack: (id: number | null) => void;
  audioOptions?: PlaybackAudioOption[];
  selectedAudioId?: string | null;
  onSelectPlaybackAudio?: (trackId: string | number) => void;
  chapters?: SegmentMarker[];
  onSeekChapter?: (seconds: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const productAudio = audioOptions && audioOptions.length > 0;
  const productSelected = selectedAudioId ?? String(audioOptions?.[0]?.track.id ?? "");

  return (
    <div className="player-menu" ref={rootRef}>
      <button
        type="button"
        className="player-icon-btn"
        aria-label="Настройки воспроизведения"
        aria-expanded={open}
        title="Настройки"
        onClick={() => setOpen((v) => !v)}
      >
        <GearIcon />
      </button>
      {open ? (
        <div className="player-menu-panel" role="menu">
          <section>
            <h4 className="player-menu-title">Скорость</h4>
            <div className="player-menu-row">
              {SPEED_OPTIONS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  role="menuitemradio"
                  aria-checked={speed === snapshot.speed}
                  className={`player-chip${speed === snapshot.speed ? " player-chip-active" : ""}`}
                  onClick={() => onSetSpeed(speed)}
                >
                  {speed}×
                </button>
              ))}
            </div>
          </section>

          <section>
            <h4 className="player-menu-title">
              {productAudio ? "Озвучка" : "Аудио"}
            </h4>
            <div className="player-menu-list">
              {productAudio ? (
                audioOptions!.map((option) => (
                  <button
                    key={String(option.track.id)}
                    type="button"
                    role="menuitemradio"
                    aria-checked={String(option.track.id) === productSelected}
                    className={`player-menu-item${String(option.track.id) === productSelected ? " player-menu-item-active" : ""}`}
                    onClick={() => onSelectPlaybackAudio?.(option.track.id)}
                  >
                    {option.label}
                  </button>
                ))
              ) : audioTracks.length === 0 ? (
                <p className="player-menu-empty">—</p>
              ) : (
                audioTracks.map((track) => (
                  <button
                    key={track.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={track.id === selectedAudio}
                    className={`player-menu-item${track.id === selectedAudio ? " player-menu-item-active" : ""}`}
                    onClick={() => onSetAudioTrack(track.id)}
                  >
                    {formatTrackLabel(track)}
                  </button>
                ))
              )}
            </div>
          </section>

          <section>
            <h4 className="player-menu-title">Субтитры</h4>
            <div className="player-menu-list">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selectedSub <= 0}
                className={`player-menu-item${selectedSub <= 0 ? " player-menu-item-active" : ""}`}
                onClick={() => onSetSubtitleTrack(null)}
              >
                Выкл
              </button>
              {subTracks.map((track) => (
                <button
                  key={track.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={track.id === selectedSub}
                  className={`player-menu-item${track.id === selectedSub ? " player-menu-item-active" : ""}`}
                  onClick={() => onSetSubtitleTrack(track.id)}
                >
                  {formatTrackLabel(track)}
                </button>
              ))}
            </div>
          </section>

          {chapters && chapters.length > 0 && onSeekChapter ? (
            <section>
              <h4 className="player-menu-title">Главы</h4>
              <div className="player-menu-list">
                {chapters.map((marker) => (
                  <button
                    key={`${marker.type}-${marker.startMs}`}
                    type="button"
                    role="menuitem"
                    className="player-menu-item"
                    onClick={() => {
                      onSeekChapter(marker.startMs / 1000);
                      setOpen(false);
                    }}
                  >
                    <span className="player-menu-item-label">{marker.label}</span>
                    <span className="player-menu-item-meta">
                      {formatTime(marker.startMs / 1000)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- transport */

export function PlayerControls({
  snapshot,
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
  mode = "vod",
  progress,
  limit,
  onBlockedSeek,
  audioOptions,
  selectedAudioId,
  onSelectPlaybackAudio,
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

  const progressLabels = mode === "vod" ? null : formatProgressLabels(progress ?? { percentDownloaded: 0, percentSeekable: 0 });
  const seekableUntil = mode === "vod" ? null : formatSeekableUntil(limit ?? { maxSeekableSec: null, seekableRatio: null, durationSec: null });

  return (
    <div className="player-transport" role="group" aria-label="Управление воспроизведением">
      {progressLabels ? (
        <div className="player-transport-hint" role="status">
          <span title="Объём, который уже на сервере">{progressLabels.downloaded}</span>
          <span className="player-transport-hint-seekable" title="Моменты, куда уже можно перематывать">
            {progressLabels.seekable}
            {seekableUntil ? ` · ${seekableUntil}` : ""}
          </span>
        </div>
      ) : null}

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

      <div className="player-transport-row">
        <button
          type="button"
          className="player-icon-btn player-icon-btn-primary"
          onClick={onTogglePause}
          aria-label={snapshot.pause ? "Воспроизвести" : "Пауза"}
          title={snapshot.pause ? "Воспроизвести (Пробел)" : "Пауза (Пробел)"}
        >
          {snapshot.pause ? <PlayIcon /> : <PauseIcon />}
        </button>

        <span className="player-time">
          {formatTime(snapshot.position)}
          <span className="player-time-muted"> / {formatTime(duration)}</span>
        </span>

        <div className="player-transport-spacer" />

        <button
          type="button"
          className="player-icon-btn"
          onClick={onToggleMute}
          aria-label={snapshot.mute ? "Включить звук" : "Выключить звук"}
          title="Звук (M)"
        >
          <VolumeIcon muted={snapshot.mute} />
        </button>
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

        <SettingsMenu
          snapshot={snapshot}
          onSetSpeed={onSetSpeed}
          audioTracks={audioTracks}
          selectedAudio={selectedAudio}
          onSetAudioTrack={onSetAudioTrack}
          subTracks={subTracks}
          selectedSub={selectedSub}
          onSetSubtitleTrack={onSetSubtitleTrack}
          audioOptions={audioOptions}
          selectedAudioId={selectedAudioId}
          onSelectPlaybackAudio={onSelectPlaybackAudio}
          chapters={chapters}
          onSeekChapter={onSeekChapter}
        />

        <button
          type="button"
          className="player-icon-btn"
          onClick={onToggleFullscreen}
          aria-label={snapshot.fullscreen ? "Выйти из полноэкранного режима" : "Полный экран"}
          title="Полный экран (F)"
        >
          <FullscreenIcon active={snapshot.fullscreen} />
        </button>
      </div>
    </div>
  );
}
