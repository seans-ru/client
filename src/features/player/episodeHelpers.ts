/**
 * Series episode helpers (picker labels, multi-episode packs, playability).
 * Pure — no React/DOM/Tauri.
 */

import type {
  PlaybackCatalog,
  PlaybackEpisode,
  PlaybackSeasonGroup,
} from "../../api/playback";

function intOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

/**
 * Compact episode code `S01E03` (or `S01E03–E05` for multi-episode packs).
 * Missing season/episode parts are omitted; empty string when both missing.
 */
export function formatEpisodeCode(
  season?: number | null,
  episode?: number | null,
  episodeEnd?: number | null,
): string {
  const s = intOrNull(season);
  const e = intOrNull(episode);
  const end = intOrNull(episodeEnd);
  const pad = (n: number) => String(n).padStart(2, "0");
  const parts: string[] = [];
  if (s != null) parts.push(`S${pad(s)}`);
  if (e != null) {
    if (end != null && end > e) {
      parts.push(`E${pad(e)}–E${pad(end)}`);
    } else {
      parts.push(`E${pad(e)}`);
    }
  }
  return parts.join("");
}

/** Russian picker label: `S01E03 · Название` / `S01E03–E05 · …`. */
export function formatEpisodePickerLabel(episode: PlaybackEpisode): string {
  const code = formatEpisodeCode(
    episode.season,
    episode.episode,
    episode.episode_end,
  );
  const title = String(episode.title ?? "").trim();
  if (code && title) return `${code} · ${title}`;
  return code || title || `Серия ${episode.episode || "—"}`;
}

/** True when Play may be offered (primary video prepared). */
export function isEpisodePlayable(episode: PlaybackEpisode): boolean {
  return episode.has_primary_video !== false;
}

/**
 * Flatten catalog episodes: `groups[]` first, then flat `files[]`.
 * Deduplicates by id, preserving order.
 */
export function catalogEpisodes(
  catalog: PlaybackCatalog | null | undefined,
): PlaybackEpisode[] {
  const out: PlaybackEpisode[] = [];
  const seen = new Set<string>();
  const push = (ep: PlaybackEpisode | null | undefined) => {
    if (!ep) return;
    const key = String(ep.id);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ep);
  };
  for (const group of catalog?.groups ?? []) {
    for (const ep of group.episodes ?? []) push(ep);
  }
  for (const ep of catalog?.files ?? []) push(ep);
  return out;
}

/** Group a flat episode list by season (stable order by episode number). */
export function groupEpisodesBySeason(
  episodes: readonly PlaybackEpisode[],
): PlaybackSeasonGroup[] {
  const map = new Map<number, PlaybackEpisode[]>();
  for (const ep of episodes) {
    const season = intOrNull(ep.season) ?? 0;
    const list = map.get(season);
    if (list) list.push(ep);
    else map.set(season, [ep]);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, list]) => ({
      season,
      episodes: [...list].sort((a, b) => {
        const ea = intOrNull(a.episode) ?? 0;
        const eb = intOrNull(b.episode) ?? 0;
        return ea - eb;
      }),
    }));
}

/** All season groups of a catalog (from groups, or derived from flat files). */
export function catalogSeasonGroups(
  catalog: PlaybackCatalog | null | undefined,
): PlaybackSeasonGroup[] {
  if (catalog?.groups && catalog.groups.length > 0) {
    return catalog.groups.map((g) => ({
      season: g.season,
      episodes: [...(g.episodes ?? [])],
    }));
  }
  return groupEpisodesBySeason(catalogEpisodes(catalog));
}

/** Find an episode by file/task id. */
export function findEpisodeById(
  catalog: PlaybackCatalog | null | undefined,
  fileId: string | number,
): PlaybackEpisode | null {
  const key = String(fileId);
  return catalogEpisodes(catalog).find((ep) => String(ep.id) === key) ?? null;
}

/** Next playable episode after `fileId` (catalog order). */
export function nextPlayableEpisode(
  catalog: PlaybackCatalog | null | undefined,
  fileId: string | number,
): PlaybackEpisode | null {
  const list = catalogEpisodes(catalog);
  const idx = list.findIndex((ep) => String(ep.id) === String(fileId));
  if (idx < 0) return null;
  for (let i = idx + 1; i < list.length; i += 1) {
    if (isEpisodePlayable(list[i])) return list[i];
  }
  return null;
}

/** True when the catalog represents a multi-episode / series pack. */
export function isSeriesCatalog(
  catalog: PlaybackCatalog | null | undefined,
): boolean {
  if (!catalog) return false;
  if (catalog.kind === "series") return true;
  return catalogEpisodes(catalog).length > 0;
}
