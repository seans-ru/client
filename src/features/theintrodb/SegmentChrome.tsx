/**
 * TheIntroDB player chrome (M8): seek-bar markers, skip buttons, chapters menu.
 * Russian labels; token-only styling via `player.css` classes.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../../design/primitives";
import { formatTime, positionPercent } from "../player/playerHelpers";
import { markerTrack } from "../player/extensions/markerTrack";
import type { ActiveSkip, SegmentMarker } from "./types";
import { SEGMENT_COLOR_CLASS, segmentLabel } from "./types";

/** Skip-button linger after leaving a segment window (ms). */
export const SKIP_HIDE_DELAY_MS = 2000;

export type SeekMarkersProps = {
  markers: SegmentMarker[];
  duration: number;
};

/**
 * Thin colored strips on the seek rail at each segment start. Merges the
 * TheIntroDB props with the extension marker track (chapters #19, bookmarks
 * #21); markers with `onSelect` seek on click.
 */
export function SeekMarkers({ markers, duration }: SeekMarkersProps) {
  const extensionMarkers = useSyncExternalStore(
    markerTrack.subscribe,
    markerTrack.getMarkers,
    markerTrack.getMarkers,
  );
  const all =
    extensionMarkers.length === 0
      ? markers
      : [...markers, ...extensionMarkers].sort((a, b) => a.startMs - b.startMs);
  if (duration <= 0 || all.length === 0) return null;
  return (
    <div className="player-seek-markers">
      {all.map((marker, index) => {
        const left = positionPercent(marker.startMs / 1000, duration);
        return (
          <span
            key={`${marker.type}-${marker.startMs}-${index}`}
            className={`player-seek-marker player-seek-marker-${SEGMENT_COLOR_CLASS[marker.type]}`}
            style={{
              left: `${left}%`,
              cursor: marker.onSelect ? "pointer" : undefined,
            }}
            title={`${marker.label} · ${formatTime(marker.startMs / 1000)}`}
            onClick={
              marker.onSelect
                ? (event) => {
                    // Never let the click fall through to the seek rail scrub.
                    event.stopPropagation();
                    marker.onSelect?.();
                  }
                : undefined
            }
          />
        );
      })}
    </div>
  );
}

export type SkipButtonsProps = {
  /** Currently active skip targets (intro / recap). */
  skips: ActiveSkip[];
  onSkip: (targetMs: number) => void;
  visible: boolean;
};

/** Personal skip actions — not broadcast to a room. */
export function SkipButtons({ skips, onSkip, visible }: SkipButtonsProps) {
  if (!visible || skips.length === 0) return null;
  return (
    <div
      className="player-skip-row"
      role="group"
      aria-label="Пропуск сегментов"
    >
      {skips.map((item) => (
        <Button
          key={item.type}
          variant="secondary"
          size="sm"
          className="player-skip-btn"
          disabled={item.targetMs == null}
          onClick={() => {
            if (item.targetMs != null) onSkip(item.targetMs);
          }}
          title={
            item.targetMs == null
              ? "Конец сегмента неизвестен"
              : `К ${formatTime(item.targetMs / 1000)}`
          }
        >
          {item.type === "intro" ? "Пропустить интро" : "Пропустить recap"}
        </Button>
      ))}
    </div>
  );
}

export type ChaptersMenuProps = {
  markers: SegmentMarker[];
  onSeekMs: (ms: number) => void;
  disabled?: boolean;
};

/** Dropdown of all segments (type + timestamp); click seeks to start_ms. */
export function ChaptersMenu({
  markers,
  onSeekMs,
  disabled,
}: ChaptersMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="player-chapters" ref={rootRef}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || markers.length === 0}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Главы"
      >
        Главы
      </Button>
      {open ? (
        <ul className="player-chapters-menu" role="menu">
          {markers.map((marker, index) => (
            <li key={`${marker.type}-${marker.startMs}-${index}`} role="none">
              <button
                type="button"
                role="menuitem"
                className="player-chapters-item"
                onClick={() => {
                  setOpen(false);
                  onSeekMs(marker.startMs);
                }}
              >
                <span
                  className={`player-chapters-dot player-seek-marker-${SEGMENT_COLOR_CLASS[marker.type]}`}
                  aria-hidden="true"
                />
                <span className="player-chapters-label">
                  {segmentLabel(marker.type)}
                </span>
                <span className="player-chapters-time">
                  {formatTime(marker.startMs / 1000)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
