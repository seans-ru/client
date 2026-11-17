/**
 * Cloud clips pure rules (docs/compose/spec/clips-cloud.md): short codes,
 * share URLs, spoiler gating against watch progress, and the «Лучшие
 * моменты» ordering. No React/DOM — unit-testable. localStorage access is
 * best-effort (plain vite / quota) and never throws.
 */

import type { CloudAssetRecord, LocalCloudAsset } from "./types";

/** Short code: 8 chars [a-z0-9] (server-generated; local pending uses this). */
export const SHORT_CODE_LENGTH = 8;
export const SHORT_CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Local pending codes avoid colliding with server codes (`~` prefix not
 * allowed by the contract) — we just use the alphabet and accept the tiny
 * collision risk for un-uploaded rows. */
export function generateShortCode(
  random: () => number = Math.random,
): string {
  let out = "";
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    const index = Math.floor(random() * SHORT_CODE_ALPHABET.length);
    out += SHORT_CODE_ALPHABET[Math.min(index, SHORT_CODE_ALPHABET.length - 1)];
  }
  return out;
}

export function isShortCode(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.length === SHORT_CODE_LENGTH &&
    /^[a-z0-9]+$/.test(raw)
  );
}

/** Public share page for a code (`https://seans.tedeshi.ru/c/<code>`). */
export function shareUrlForCode(code: string): string {
  return `https://seans.tedeshi.ru/c/${code}`;
}

/* ------------------------------------------------------------- watched */

const WATCH_PREFIX = "seans.watch.";

/** Mark a media as watched (post-movie / 95% rule). Best-effort. */
export function markMediaWatched(mediaId: string): void {
  const key = `${WATCH_PREFIX}${mediaId}`;
  try {
    globalThis.localStorage?.setItem(key, "1");
  } catch {
    // Private mode — spoiler gating falls back to "not watched".
  }
}

/** Has this media been watched on this device? */
export function isMediaWatched(mediaId: string): boolean {
  try {
    return globalThis.localStorage?.getItem(`${WATCH_PREFIX}${mediaId}`) === "1";
  } catch {
    return false;
  }
}

/** History-based watched flag (server progress rows). */
export function watchedFromProgress(
  positionSec: number | null | undefined,
  durationSec: number | null | undefined,
  completed?: boolean | null,
): boolean {
  if (completed === true) return true;
  const p =
    typeof positionSec === "number" && Number.isFinite(positionSec)
      ? positionSec
      : 0;
  const d =
    typeof durationSec === "number" && Number.isFinite(durationSec)
      ? durationSec
      : 0;
  if (d <= 0) return false;
  return p >= d || p / d >= 0.95;
}

/**
 * Spoiler gate: spoiler content is visible only to viewers who finished the
 * media (local flag or history progress).
 */
export function shouldRevealSpoiler(
  spoiler: boolean,
  watched: boolean | null | undefined,
): boolean {
  return !spoiler || watched === true;
}

/* ------------------------------------------------------- best moments */

export type MomentCandidate = {
  kind: string;
  mediaId: string;
  spoiler: boolean;
  startSec: number | null;
};

/**
 * «Лучшие моменты» selection: clips (never screenshots) of this media,
 * spoilers only for watchers, ordered by the clip start timecode so a finale
 * clip never plays before an intro clip. Clips without a start go last.
 */
export function selectBestMoments<T extends MomentCandidate>(
  assets: readonly T[],
  args: { mediaId: string; watched: boolean | null | undefined },
): T[] {
  const visible = assets.filter(
    (asset) =>
      asset.kind === "clip" &&
      asset.mediaId === args.mediaId &&
      shouldRevealSpoiler(asset.spoiler, args.watched),
  );
  return [...visible].sort((a, b) => {
    const sa = a.startSec;
    const sb = b.startSec;
    if (sa == null && sb == null) return 0;
    if (sa == null) return 1;
    if (sb == null) return -1;
    return sa - sb;
  });
}

/** Open clips for the movie card: `visibility=open`, spoiler-gated. */
export function openClipsForMedia<T extends { mediaId: string; spoiler: boolean }>(
  assets: readonly T[],
  args: { mediaId: string; watched: boolean | null | undefined },
): T[] {
  return assets.filter(
    (asset) =>
      asset.mediaId === args.mediaId &&
      shouldRevealSpoiler(asset.spoiler, args.watched),
  );
}

/* --------------------------------------------------------- display */

export function formatCloudStatus(
  status: LocalCloudAsset["status"],
  error?: string | null,
): string {
  switch (status) {
    case "pending":
      return "Ожидает загрузки";
    case "uploading":
      return "Загрузка…";
    case "uploaded":
      return "В облаке";
    case "failed":
      return error ? `Ошибка загрузки: ${error}` : "Ошибка загрузки";
    default:
      return "";
  }
}

/** Best-effort playback source: the local file while it exists, else the
 * cloud `fileUrl`. */
export function resolveMomentSource(
  asset: Pick<LocalCloudAsset, "localPath" | "fileUrl"> & { localExists?: boolean },
): string | null {
  if (asset.localPath && asset.localExists !== false) return asset.localPath;
  return asset.fileUrl ?? asset.localPath ?? null;
}

/** Merge a server record into a local registry entry (upload succeeded). */
export function assetFromRecord(
  base: LocalCloudAsset,
  record: CloudAssetRecord,
  at: Date = new Date(),
): LocalCloudAsset {
  return {
    ...base,
    status: "uploaded",
    error: null,
    id: record.id,
    code: record.code,
    url: record.url,
    fileUrl: record.fileUrl,
    visibility: record.visibility,
    spoiler: record.spoiler,
    updatedAt: at.toISOString(),
  };
}
