/**
 * Series episode picker (SxxEyy, multi-episode packs, per-episode audio).
 * Russian UI. Play is hidden/disabled when `has_primary_video` is false.
 */

import type { PlaybackEpisode } from "../../api/playback";
import type { PlaybackSeasonGroup } from "../../api/playback";
import { Badge, Button } from "../../design/primitives";
import {
  formatEpisodePickerLabel,
  isEpisodePlayable,
} from "./episodeHelpers";

export type EpisodePickerProps = {
  groups: PlaybackSeasonGroup[];
  currentFileId: string | number | null;
  onSelect: (episode: PlaybackEpisode) => void;
  /** Compact mode: single select row (used in the player overlay). */
  compact?: boolean;
};

export function EpisodePicker({
  groups,
  currentFileId,
  onSelect,
  compact = false,
}: EpisodePickerProps) {
  if (groups.length === 0) return null;

  const currentKey = currentFileId == null ? null : String(currentFileId);

  return (
    <div
      className={`episode-picker${compact ? " episode-picker-compact" : ""}`}
      role="listbox"
      aria-label="Серии"
    >
      {groups.map((group) => (
        <section
          key={group.season}
          className="episode-picker-season"
          aria-label={`Сезон ${group.season}`}
        >
          <h4 className="episode-picker-season-title">Сезон {group.season}</h4>
          <ul className="episode-picker-list">
            {group.episodes.map((episode) => {
              const playable = isEpisodePlayable(episode);
              const selected = String(episode.id) === currentKey;
              return (
                <li key={String(episode.id)}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`episode-picker-item${selected ? " episode-picker-item-selected" : ""}`}
                    disabled={!playable}
                    title={
                      playable
                        ? formatEpisodePickerLabel(episode)
                        : "Загружается…"
                    }
                    onClick={() => {
                      if (playable) onSelect(episode);
                    }}
                  >
                    <span className="episode-picker-label">
                      {formatEpisodePickerLabel(episode)}
                    </span>
                    {playable ? null : (
                      <Badge tone="neutral">загружается</Badge>
                    )}
                    {selected ? (
                      <Badge tone="accent">смотрим</Badge>
                    ) : null}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Compact select-friendly list of playable episodes for dropdowns. */
export function episodeSelectOptions(
  groups: PlaybackSeasonGroup[],
): Array<{ value: string; label: string; playable: boolean }> {
  const out: Array<{ value: string; label: string; playable: boolean }> = [];
  for (const group of groups) {
    for (const episode of group.episodes) {
      out.push({
        value: String(episode.id),
        label: formatEpisodePickerLabel(episode),
        playable: isEpisodePlayable(episode),
      });
    }
  }
  return out;
}
