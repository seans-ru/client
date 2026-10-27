/**
 * Pure release helpers (M5). No React/DOM — unit-testable.
 */

import type { TorrentReleaseResponse } from "../../api/types";

export type ReleaseSortKey = "seeders" | "size" | "title" | "quality";
export type ReleaseSortDir = "asc" | "desc";

/** Default ordering: more seeders first. */
export const RELEASE_DEFAULT_SORT: {
  key: ReleaseSortKey;
  dir: ReleaseSortDir;
} = { key: "seeders", dir: "desc" };

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "ru");
}

/**
 * Sort a copy of the release list. Numeric keys (seeders, size) and
 * text keys (title, quality) are supported; direction is `desc` by default.
 */
export function sortReleases(
  releases: readonly TorrentReleaseResponse[],
  key: ReleaseSortKey = RELEASE_DEFAULT_SORT.key,
  dir: ReleaseSortDir = RELEASE_DEFAULT_SORT.dir,
): TorrentReleaseResponse[] {
  const mul = dir === "asc" ? 1 : -1;
  return [...releases].sort((a, b) => {
    let cmp: number;
    switch (key) {
      case "seeders":
        cmp = a.seeders - b.seeders;
        break;
      case "size":
        cmp = a.size_bytes - b.size_bytes;
        break;
      case "title":
        cmp = compareValues(a.title, b.title);
        break;
      case "quality":
        cmp = compareValues(a.quality ?? "", b.quality ?? "");
        break;
      default:
        cmp = 0;
    }
    // Stable fallback: keep tracker order for ties.
    return cmp !== 0 ? cmp * mul : compareValues(a.tracker, b.tracker) * mul;
  });
}

/**
 * Case-insensitive substring filter over tracker / title / quality / voiceover.
 * Empty or whitespace-only query returns every release.
 */
export function filterReleases(
  releases: readonly TorrentReleaseResponse[],
  query: string,
): TorrentReleaseResponse[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...releases];
  return releases.filter((release) =>
    [release.tracker, release.title, release.quality ?? "", release.voiceover ?? ""].some(
      (field) => field.toLowerCase().includes(q),
    ),
  );
}
